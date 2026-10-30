import { createHash } from "node:crypto";
import { isAbsolute, join, relative, sep } from "node:path";
import { lstat, mkdir, realpath } from "node:fs/promises";
import { hashRegularFileNoFollow, readRegularFileNoFollow } from "./workspaceImport/safeFile";
import { writeFileStringAtomically } from "./atomicWrite";
import { Effect } from "effect";
import { mediaImageEditInputError } from "./mediaImageEditInput";
import { createLogger } from "./logger";
import { discoveryFailureCode } from "./discoveryFailureCode";

import {
  HoolaCanvasBridgeBroker,
  hoolaCanvasModelKind,
  hoolaCanvasRequestIdentity,
  type HoolaCanvasAuthorityCredential,
  type HoolaCanvasBridgeOptions,
  type HoolaCanvasJobSnapshot,
  type HoolaCanvasDurableJob,
} from "./hoolaCanvasBridge";
import { MossMediaAssetStore, validMossMediaAsset } from "./mossMediaAssets";
import { MossMediaHistory, type MediaHistoryPageInput } from "./mossMediaHistory";
import type { MossCanvasWorkspace } from "./mossCanvasWorkspace";

type MediaFetch = NonNullable<HoolaCanvasBridgeOptions["fetchImpl"]>;
const log = createLogger("media-catalog");

export interface MossMediaAccount {
  readonly id: string;
  readonly realm: HoolaCanvasAuthorityCredential["realm"];
}

export interface MossMediaCredential extends HoolaCanvasAuthorityCredential {
  readonly account: MossMediaAccount;
  readonly installedModelIds?: readonly string[];
}

export type MossMediaIdentity = Pick<MossMediaCredential, "account" | "realm" | "gatewayBaseUrl">;

export interface MossMediaModel {
  readonly id: string;
  readonly label: string;
  readonly kind: "image" | "video";
  readonly installed: boolean;
  readonly available: boolean;
  readonly unavailableReason?: string;
  readonly priceLabel?: string;
  readonly supportsReferences?: boolean;
  readonly supportsReferenceImages?: boolean;
  readonly supportsReferenceVideos?: boolean;
  readonly supportsMaskEdits?: boolean;
  readonly supportsTransparentBackground?: boolean;
}

export interface MossMediaWallet {
  readonly walletKind: "media_cost_v1";
  readonly currency: "CNY";
  readonly pointsPerCny: 100;
  readonly availableNanoCny: string;
  readonly heldNanoCny: string;
  readonly reviewRequired?: boolean;
}

function validMediaWallet(value: unknown): value is MossMediaWallet {
  return (
    record(value) &&
    value.walletKind === "media_cost_v1" &&
    value.currency === "CNY" &&
    value.pointsPerCny === 100 &&
    (value.reviewRequired === undefined || typeof value.reviewRequired === "boolean") &&
    [value.availableNanoCny, value.heldNanoCny].every(
      (amount) =>
        typeof amount === "string" &&
        /^(0|[1-9][0-9]{0,18})$/u.test(amount) &&
        BigInt(amount) <= 9_223_372_036_854_775_807n,
    )
  );
}

export class MossMediaJobsError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 400,
    readonly upstreamStatus?: number,
  ) {
    super(code);
    this.name = "MossMediaJobsError";
  }
}

export interface MossMediaJobsServiceOptions {
  readonly stateDirectory: string;
  readonly fetchImpl?: MediaFetch;
  readonly brokerOptions?: ConstructorParameters<typeof HoolaCanvasBridgeBroker>[0];
  readonly isModelInstalled?: (account: MossMediaAccount, modelId: string) => Promise<boolean>;
  readonly assetDownload?: ConstructorParameters<typeof MossMediaAssetStore>[1];
}

/** Server-granted conversation identity, separate from the supplier request digest. */
export interface MossMediaConversationOrigin {
  readonly threadId: string;
  readonly turnId: string;
}

export interface MossConversationImageObservation {
  readonly origin: MossMediaConversationOrigin;
  readonly accountScope: string;
  readonly snapshot: HoolaCanvasJobSnapshot;
  readonly outputs: readonly { readonly index: number; readonly path: string }[];
  readonly projectionFailed: boolean;
}

interface BoundCanvasWorkspace extends MossCanvasWorkspace {
  readonly imageOrigin?: MossMediaConversationOrigin;
}

function record(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function mediaAccountScope(credential: MossMediaIdentity): string {
  if (!credential.account.id || credential.account.realm !== credential.realm) {
    throw new MossMediaJobsError("account_recovery_required", 401);
  }
  return createHash("sha256")
    .update(
      JSON.stringify([
        credential.realm,
        credential.account.id,
        credential.gatewayBaseUrl.replace(/\/+$/u, ""),
      ]),
    )
    .digest("hex");
}

/** Owns account-scoped history; cloud gateway remains the billing authority. */
export class MossMediaJobsService {
  readonly #brokers = new Map<string, HoolaCanvasBridgeBroker>();
  readonly #fetch: MediaFetch;
  readonly #assets: MossMediaAssetStore;
  readonly #history: MossMediaHistory;
  readonly #initialized = new Map<string, Promise<void>>();
  readonly #bindingWrites = new Map<string, Promise<void>>();
  #canvasWorkspace: ((threadId: string) => Promise<MossCanvasWorkspace>) | null = null;
  #conversationImageObserver:
    | ((observation: MossConversationImageObservation) => Promise<void>)
    | null = null;
  setCanvasWorkspaceResolver(resolve: (threadId: string) => Promise<MossCanvasWorkspace>) {
    this.#canvasWorkspace = resolve;
  }
  setConversationImageObserver(
    observe: (observation: MossConversationImageObservation) => Promise<void>,
  ) {
    this.#conversationImageObserver = observe;
  }
  constructor(readonly options: MossMediaJobsServiceOptions) {
    this.#fetch = options.fetchImpl ?? fetch;
    this.#assets = new MossMediaAssetStore(options.stateDirectory, options.assetDownload);
    this.#history = new MossMediaHistory(options.stateDirectory);
  }

  #broker(credential: MossMediaIdentity): HoolaCanvasBridgeBroker {
    const scope = mediaAccountScope(credential);
    let broker = this.#brokers.get(scope);
    if (!broker) {
      broker = new HoolaCanvasBridgeBroker({
        ...this.options.brokerOptions,
        fetchImpl: this.#fetch,
        statePath: join(this.options.stateDirectory, "media-jobs", `${scope}.json`),
        cacheOutputs: (jobId, urls, kind) => this.#assets.cache(scope, jobId, urls, kind),
        persistHistory: async (job) => {
          await this.#history.save(scope, job);
          try {
            await this.#projectConversation(job, credential);
          } catch {
            // Before dispatch, fail closed if the conversation cannot be saved.
            // After dispatch, a local projection failure must not reinterpret
            // supplier task/billing status or cause another generation POST.
            if (job.snapshot.status === "queued")
              throw new MossMediaJobsError("canvas_workspace_save_failed", 503);
            log.warn("conversation canvas save pending", {
              jobId: job.snapshot.jobId,
              errorCode: "canvas_workspace_save_failed",
            });
          }
        },
      });
      this.#brokers.set(scope, broker);
    }
    return broker;
  }

  async #projectConversation(job: HoolaCanvasDurableJob, credential: MossMediaIdentity) {
    const thread = /^thread:([A-Za-z0-9_-]{1,128})$/u.exec(job.snapshot.projectId);
    if (!thread) return;
    const workspace = await this.#readCanvasBinding(
      mediaAccountScope(credential),
      job.snapshot.jobId,
      thread[1]!,
    );
    if (!workspace) return;
    const observe = this.#conversationImageObserver;
    const origin = workspace.imageOrigin;
    let outputs: readonly { readonly index: number; readonly path: string }[] = [];
    let projectionFailed = false;
    let projectionError: unknown;
    try {
      outputs = await this.#writeCanvasProjection(
        job.snapshot,
        job.revision,
        credential,
        workspace,
        undefined,
        Boolean(observe && origin && job.snapshot.operation !== "video"),
      );
    } catch (error) {
      projectionFailed = true;
      projectionError = error;
    }
    if (observe && origin && job.snapshot.operation !== "video") {
      try {
        // Accepted work may finish after the caller turn ends. Its durable origin
        // and account-scoped binding remain authoritative; a later poll cannot
        // move the result into a different turn or account.
        await observe({
          origin,
          accountScope: mediaAccountScope(credential),
          snapshot: job.snapshot,
          outputs,
          projectionFailed,
        });
      } catch {
        // A UI projection failure never changes a supplier outcome or causes a
        // second generation. The next local history/check replay can redeliver it.
        log.warn("conversation image activity save pending", {
          jobId: job.snapshot.jobId,
          errorCode: "media_activity_save_failed",
        });
      }
    }
    if (projectionFailed) throw projectionError;
  }

  async #writeCanvasProjection(
    snapshot: HoolaCanvasJobSnapshot,
    revision: number,
    credential: MossMediaIdentity,
    workspace: MossCanvasWorkspace,
    authorize?: () => Promise<void>,
    collectLocalPaths = false,
  ) {
    await authorize?.();
    const { mossCanvasStorageFor } = await import("./mossCanvasStorage");
    const store = await mossCanvasStorageFor(this.options.stateDirectory, credential, workspace);
    const outputs: string[] = [];
    const importedImages: { index: number; name: string; byteLength: number; assetId: string }[] =
      [];
    for (const asset of snapshot.assets ?? []) {
      if (!validMossMediaAsset(asset, snapshot.jobId))
        throw new MossMediaJobsError("asset_not_found", 404);
      const bytes = await this.#assets.read(mediaAccountScope(credential), asset);
      const imported = (await store.request("workspace.importAssetBytes", {
        bytesBase64: Buffer.from(bytes).toString("base64"),
        mimeType: asset.contentType,
        fileName: `${snapshot.jobId}-${asset.index}`,
      })) as { url: string };
      outputs.push(imported.url);
      if (collectLocalPaths && asset.kind === "image") {
        const match = /^moss-canvas-asset:([a-f0-9]{64}\.(?:png|jpg|webp|avif))$/u.exec(
          imported.url,
        );
        if (!match || !match[1]!.startsWith(`${asset.assetId}.`))
          throw new MossMediaJobsError("canvas_asset_invalid", 503);
        importedImages.push({
          index: asset.index,
          name: match[1]!,
          byteLength: asset.byteLength,
          assetId: asset.assetId,
        });
      }
    }
    await authorize?.();
    await store.request("host.syncConversationJob", {
      job: {
        jobId: snapshot.jobId,
        revision,
        modelId: snapshot.modelId,
        kind: snapshot.operation === "video" ? "video" : "image",
        prompt: snapshot.prompt,
        status: snapshot.status,
        outputs,
        billingStatus: snapshot.billingStatus,
        persistenceStatus: snapshot.persistenceStatus,
        createdAt: snapshot.createdAt,
      },
    });
    if (!importedImages.length) return [];
    // Reuse the actual Canvas file. Never publish a remote supplier URL or a
    // guessed path, and never duplicate the output into a second workspace.
    const info = await store.request("workspace.info");
    if (!record(info) || typeof info.assetsRoot !== "string")
      throw new MossMediaJobsError("canvas_asset_invalid", 503);
    const assetsRoot = await realpath(info.assetsRoot);
    const inside = relative(workspace.cwd, assetsRoot);
    if (
      assetsRoot !== info.assetsRoot ||
      inside === "" ||
      inside === ".." ||
      inside.startsWith(`..${sep}`) ||
      isAbsolute(inside)
    )
      throw new MossMediaJobsError("canvas_asset_invalid", 503);
    return Promise.all(
      importedImages.map(async (asset) => {
        const path = join(assetsRoot, asset.name);
        if (
          (await realpath(path)) !== path ||
          (await hashRegularFileNoFollow(path, asset.byteLength)) !== asset.assetId
        )
          throw new MossMediaJobsError("canvas_asset_invalid", 503);
        return { index: asset.index, path };
      }),
    );
  }

  /** Local history only: opening Canvas must never reconcile or submit a supplier operation. */
  async readOwnedJob(
    jobId: string,
    credential: MossMediaIdentity,
  ): Promise<HoolaCanvasJobSnapshot> {
    if (!/^moss_[A-Za-z0-9_-]{1,128}$/u.test(jobId))
      throw new MossMediaJobsError("job_not_found", 404);
    const scope = mediaAccountScope(credential);
    const stored = await this.#history.get(scope, jobId);
    const snapshot = this.#brokers.get(scope)?.get(jobId) ?? stored?.snapshot;
    if (!snapshot) throw new MossMediaJobsError("job_not_found", 404);
    return snapshot;
  }

  /** Resolve durable ownership and origin without initializing or polling the broker. */
  async readOwnedCanvasOrigin(
    jobId: string,
    credential: MossMediaIdentity,
  ): Promise<MossCanvasWorkspace | null> {
    if (!/^moss_[A-Za-z0-9_-]{1,128}$/u.test(jobId))
      throw new MossMediaJobsError("job_not_found", 404);
    const scope = mediaAccountScope(credential);
    if (!(await this.#history.get(scope, jobId)))
      throw new MossMediaJobsError("job_not_found", 404);
    return this.#readCanvasBinding(scope, jobId);
  }

  /** Import an existing owned output into the chosen conversation without changing its job or bill. */
  async importCanvasJob(
    jobId: string,
    credential: MossMediaIdentity,
    workspace: MossCanvasWorkspace,
    authorize?: () => Promise<void>,
  ) {
    const snapshot = await this.readOwnedJob(jobId, credential);
    if (
      snapshot.operation === "video" ||
      snapshot.status !== "succeeded" ||
      snapshot.persistenceStatus !== "ready" ||
      !snapshot.assets?.some((asset) => asset.kind === "image")
    )
      throw new MossMediaJobsError("image_output_not_ready", 409);
    await this.#writeCanvasProjection(
      snapshot,
      snapshot.revision ?? 0,
      credential,
      workspace,
      authorize,
    );
    await authorize?.();
    return { jobId: snapshot.jobId, imported: true, supplierRequests: 0 };
  }

  #canvasBindingPath(scope: string, jobId: string) {
    return join(this.options.stateDirectory, "media-job-workspaces", scope, `${jobId}.json`);
  }
  async #readCanvasBinding(
    scope: string,
    jobId: string,
    expectedThreadId?: string,
  ): Promise<BoundCanvasWorkspace | null> {
    const path = this.#canvasBindingPath(scope, jobId);
    try {
      for (const directory of [
        join(this.options.stateDirectory, "media-job-workspaces"),
        join(this.options.stateDirectory, "media-job-workspaces", scope),
      ]) {
        const info = await lstat(directory);
        if (!info.isDirectory() || info.isSymbolicLink())
          throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
      }
      await lstat(path);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
    }
    try {
      const bytes = await readRegularFileNoFollow(path, 8192);
      const value: unknown = JSON.parse(bytes.toString("utf8"));
      if (
        !record(value) ||
        value.version !== 1 ||
        typeof value.threadId !== "string" ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(value.threadId) ||
        (expectedThreadId !== undefined && value.threadId !== expectedThreadId) ||
        typeof value.cwd !== "string" ||
        typeof value.title !== "string" ||
        (await realpath(value.cwd)) !== value.cwd ||
        !(await lstat(value.cwd)).isDirectory()
      )
        throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
      let imageOrigin: MossMediaConversationOrigin | undefined;
      if (value.imageOrigin !== undefined) {
        if (
          !record(value.imageOrigin) ||
          value.imageOrigin.threadId !== value.threadId ||
          typeof value.imageOrigin.turnId !== "string" ||
          !/^[A-Za-z0-9_-]{1,128}$/u.test(value.imageOrigin.turnId)
        )
          throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
        imageOrigin = { threadId: value.threadId, turnId: value.imageOrigin.turnId };
      }
      return {
        threadId: value.threadId,
        cwd: value.cwd,
        title: value.title,
        ...(imageOrigin ? { imageOrigin } : {}),
      };
    } catch {
      // A binding that existed must never become a legacy/unbound fallback.
      throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
    }
  }
  async #bindCanvasWorkspace(
    scope: string,
    jobId: string,
    workspace: MossCanvasWorkspace,
    imageOrigin?: MossMediaConversationOrigin,
  ) {
    const key = `${scope}:${jobId}`;
    const previous = this.#bindingWrites.get(key) ?? Promise.resolve();
    const write = previous
      .catch(() => undefined)
      .then(() => this.#writeCanvasBinding(scope, jobId, workspace, imageOrigin));
    this.#bindingWrites.set(key, write);
    try {
      await write;
    } finally {
      if (this.#bindingWrites.get(key) === write) this.#bindingWrites.delete(key);
    }
  }
  async #writeCanvasBinding(
    scope: string,
    jobId: string,
    workspace: MossCanvasWorkspace,
    imageOrigin?: MossMediaConversationOrigin,
  ) {
    const existing = await this.#readCanvasBinding(scope, jobId, workspace.threadId);
    if (existing) {
      if (existing.cwd !== workspace.cwd) throw new MossMediaJobsError("idempotency_conflict", 409);
      return;
    }
    const directory = join(this.options.stateDirectory, "media-job-workspaces");
    for (const path of [directory, join(directory, scope)]) {
      await mkdir(path, { mode: 0o700 }).catch((error: unknown) => {
        if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
      });
      const info = await lstat(path);
      if (!info.isDirectory() || info.isSymbolicLink())
        throw new MossMediaJobsError("canvas_workspace_binding_invalid", 409);
    }
    await Effect.runPromise(
      writeFileStringAtomically({
        filePath: this.#canvasBindingPath(scope, jobId),
        contents: JSON.stringify({
          version: 1,
          ...workspace,
          ...(imageOrigin ? { imageOrigin } : {}),
        }),
      }),
    );
  }

  async #ready(credential: MossMediaIdentity) {
    const scope = mediaAccountScope(credential);
    const broker = this.#broker(credential);
    let initialized = this.#initialized.get(scope);
    if (!initialized) {
      initialized = (async () => {
        // Bounded, idempotent import of the old active checkpoint. No provider I/O.
        for (const job of broker.durableJobs()) {
          const stored = await this.#history.get(scope, job.snapshot.jobId);
          if (stored && stored.revision > job.revision) broker.restoreDurable(stored);
          await broker.saveHistory(job.snapshot.jobId);
        }
      })();
      this.#initialized.set(scope, initialized);
      void initialized.catch(() => {
        if (this.#initialized.get(scope) === initialized) this.#initialized.delete(scope);
      });
    }
    await initialized;
    return broker;
  }

  async history(credential: MossMediaIdentity, input: MediaHistoryPageInput = {}) {
    await this.#ready(credential);
    return {
      account: credential.account,
      ...(await this.#history.page(mediaAccountScope(credential), input)),
    };
  }

  async conversation(
    conversationId: string,
    credential: MossMediaIdentity,
    input: MediaHistoryPageInput = {},
  ) {
    await this.#ready(credential);
    const scope = mediaAccountScope(credential);
    const kind = await this.#history.conversationKind(scope, conversationId);
    if (!kind) throw new MossMediaJobsError("conversation_not_found", 404);
    if (input.kind !== undefined && input.kind !== kind)
      throw new MossMediaJobsError("invalid_conversation", 409);
    return {
      account: credential.account,
      conversationId,
      kind,
      ...(await this.#history.page(scope, { ...input, kind, conversationId })),
    };
  }

  async #loadCatalog(credential: MossMediaCredential): Promise<{
    models: readonly MossMediaModel[];
    creditBalance?: number;
    mediaWallet?: MossMediaWallet;
  }> {
    const root = credential.gatewayBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    const response = await this.#fetch(`${root}/v1/canvas/media/catalog`, {
      headers: { authorization: `Bearer ${credential.accessToken}` },
      redirect: "error",
      signal: AbortSignal.timeout(15_000),
    });
    if (!response.ok)
      throw new MossMediaJobsError(
        "media_catalog_unavailable",
        response.status === 401 ? 401 : 503,
        response.status,
      );
    const raw = await response.text();
    if (raw.length > 512 * 1024) throw new MossMediaJobsError("media_catalog_invalid", 502);
    let payload: unknown;
    try {
      payload = JSON.parse(raw);
    } catch {
      throw new MossMediaJobsError("media_catalog_invalid", 502);
    }
    if (!record(payload) || !Array.isArray(payload.models))
      throw new MossMediaJobsError("media_catalog_invalid", 502);
    const models: MossMediaModel[] = [];
    for (const model of payload.models.slice(0, 100)) {
      if (
        !record(model) ||
        typeof model.id !== "string" ||
        !/^[A-Za-z0-9][A-Za-z0-9._:-]{1,127}$/u.test(model.id) ||
        typeof model.label !== "string" ||
        (model.kind !== "image" && model.kind !== "video")
      )
        continue;
      const installed = this.options.isModelInstalled
        ? await this.options.isModelInstalled(credential.account, model.id)
        : credential.installedModelIds?.includes(model.id) === true;
      models.push({
        id: model.id,
        label: model.label.slice(0, 120),
        kind: model.kind,
        installed,
        available: model.available === true,
        ...(typeof model.unavailableReason === "string"
          ? { unavailableReason: model.unavailableReason.slice(0, 200) }
          : {}),
        ...(typeof model.priceLabel === "string"
          ? { priceLabel: model.priceLabel.slice(0, 200) }
          : {}),
        supportsReferences:
          model.supportsReferences === true || model.supportsReferenceImages === true,
        supportsReferenceImages: model.supportsReferenceImages === true,
        supportsReferenceVideos: model.supportsReferenceVideos === true,
        supportsMaskEdits: model.supportsMaskEdits === true,
        supportsTransparentBackground: model.supportsTransparentBackground === true,
      });
    }
    const account = record(payload.account) ? payload.account : null;
    if (account && (account.id !== credential.account.id || account.realm !== credential.realm)) {
      throw new MossMediaJobsError("media_catalog_account_mismatch", 502);
    }
    if (payload.mediaWallet !== undefined && (!account || !validMediaWallet(payload.mediaWallet)))
      throw new MossMediaJobsError("media_catalog_invalid", 502);
    log.info("catalog observation", {
      upstreamStatus: response.status,
      errorCode: null,
      hasAccount: account !== null,
      modelsCount: models.length,
      installedModelsCount: models.filter((model) => model.installed).length,
      hasMediaWallet: validMediaWallet(payload.mediaWallet),
    });
    return {
      models,
      ...(validMediaWallet(payload.mediaWallet) ? { mediaWallet: payload.mediaWallet } : {}),
      ...(account &&
      typeof account.creditBalance === "number" &&
      Number.isSafeInteger(account.creditBalance) &&
      account.creditBalance >= 0
        ? { creditBalance: account.creditBalance }
        : {}),
    };
  }

  async catalog(credential: MossMediaCredential): Promise<readonly MossMediaModel[]> {
    return (await this.#loadCatalog(credential)).models;
  }

  async list(credential: MossMediaCredential): Promise<{
    account: MossMediaAccount & { creditBalance?: number };
    models: readonly MossMediaModel[];
    jobs: readonly HoolaCanvasJobSnapshot[];
    nextCursor?: string | null;
    mediaWallet?: MossMediaWallet;
    errorCode?: string;
  }> {
    await this.#ready(credential);
    const page = await this.#history.page(mediaAccountScope(credential));
    try {
      const catalog = await this.#loadCatalog(credential);
      return {
        account: {
          ...credential.account,
          ...(catalog.creditBalance !== undefined ? { creditBalance: catalog.creditBalance } : {}),
        },
        models: catalog.models,
        ...(catalog.mediaWallet ? { mediaWallet: catalog.mediaWallet } : {}),
        ...page,
      };
    } catch (error) {
      // An unavailable model catalog must not hide already completed artifacts.
      log.warn("catalog observation", {
        errorCode: error instanceof MossMediaJobsError ? error.code : "media_catalog_unavailable",
        upstreamStatus: error instanceof MossMediaJobsError ? error.upstreamStatus : undefined,
        failureCode: discoveryFailureCode(error),
        hasAccount: true,
        modelsCount: 0,
        hasMediaWallet: false,
      });
      return {
        account: credential.account,
        models: [],
        ...page,
        errorCode: error instanceof MossMediaJobsError ? error.code : "media_catalog_unavailable",
      };
    }
  }

  async create(
    raw: unknown,
    credential: MossMediaCredential,
    authorize?: () => Promise<void>,
    expectedWorkspaceRoot?: string,
    imageOrigin?: MossMediaConversationOrigin,
  ) {
    if (!record(raw)) throw new MossMediaJobsError("invalid_request");
    if (
      imageOrigin &&
      (raw.projectId !== `thread:${imageOrigin.threadId}` ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(imageOrigin.threadId) ||
        !/^[A-Za-z0-9_-]{1,128}$/u.test(imageOrigin.turnId))
    )
      throw new MossMediaJobsError("invalid_request");
    if (
      raw.expectedAccount !== undefined &&
      (!record(raw.expectedAccount) ||
        raw.expectedAccount.id !== credential.account.id ||
        raw.expectedAccount.realm !== credential.realm)
    ) {
      throw new MossMediaJobsError("media_account_changed", 409);
    }
    const editError = mediaImageEditInputError({ ...raw, modelId: raw.modelId });
    if (editError)
      throw new MossMediaJobsError(editError, editError === "request_too_large" ? 413 : 400);
    const kind = hoolaCanvasModelKind(raw.modelId);
    if (!kind) throw new MossMediaJobsError("unsupported_model");
    const normalized: Record<string, unknown> = {
      ...raw,
      projectId: typeof raw.projectId === "string" ? raw.projectId : "images-workspace",
      operation:
        kind === "video"
          ? "video"
          : Array.isArray(raw.referenceImages) && raw.referenceImages.length
            ? "image_to_image"
            : "text_to_image",
    };
    const identity = hoolaCanvasRequestIdentity(normalized);
    const broker = await this.#ready(credential);
    const scope = mediaAccountScope(credential);
    const prior = await this.#history.find(
      scope,
      identity.idempotencyIdentity,
      identity.requestDigest,
    );
    if (prior) {
      await authorize?.();
      await this.#projectConversation(prior, credential).catch(() => undefined);
      return broker.get(prior.snapshot.jobId) ?? prior.snapshot;
    }
    if (typeof normalized.parentJobId === "string") {
      const parent = await this.#history.get(scope, normalized.parentJobId);
      const snapshot = parent?.snapshot;
      if (
        !snapshot ||
        snapshot.conversationId !== normalized.conversationId ||
        snapshot.status !== "succeeded" ||
        (snapshot.operation === "video" ? "video" : "image") !== kind ||
        (kind === "video" ? snapshot.videoUrls : snapshot.imageUrls).length === 0
      )
        throw new MossMediaJobsError("invalid_conversation", 409);
    }
    const models = await this.catalog(credential);
    const model = models.find((item) => item.id === raw.modelId);
    if (!model) throw new MossMediaJobsError("unsupported_model");
    if (!model.installed) throw new MossMediaJobsError("media_skill_not_installed", 403);
    if (!model.available)
      throw new MossMediaJobsError(model.unavailableReason ?? "media_model_unavailable", 503);
    if (
      Array.isArray(raw.referenceImages) &&
      raw.referenceImages.length &&
      model.supportsReferences !== true
    ) {
      throw new MossMediaJobsError("reference_images_not_supported");
    }
    const hasWanFrame =
      typeof raw.startFrameUrl === "string" || typeof raw.endFrameUrl === "string";
    if (hasWanFrame && model.supportsReferenceImages !== true) {
      throw new MossMediaJobsError("reference_images_not_supported");
    }
    if (raw.maskImage !== undefined && model.supportsMaskEdits !== true)
      throw new MossMediaJobsError("mask_edits_not_supported");
    if (raw.background === "transparent" && model.supportsTransparentBackground !== true)
      throw new MossMediaJobsError("transparent_background_not_supported");
    // A crash may leave only a durable pending record and an unindexed cache file.
    // Keep those files even when the bounded active checkpoint could not be read.
    const protectedHistory = await this.#history.hasProtectedJobs(scope);
    await this.#assets.collectUnreferenced(
      mediaAccountScope(credential),
      () => {
        const retained = broker.list();
        return protectedHistory ||
          retained.some(
            (item) =>
              ["queued", "running", "reconciliation_required"].includes(item.status) ||
              ["pending", "unknown"].includes(item.billingStatus) ||
              (item.status === "succeeded" && item.persistenceStatus !== "ready"),
          )
          ? null
          : new Set(retained.flatMap((item) => (item.assets ?? []).map((asset) => asset.assetId)));
      },
      (assetId) => this.#history.hasAsset(scope, assetId),
    );
    // Catalog and cache housekeeping can await. Recheck the account/turn lease
    // after both, immediately before the synchronous create-and-submit boundary.
    await authorize?.();
    const canvasThread = /^thread:([A-Za-z0-9_-]{1,128})$/u.exec(String(normalized.projectId));
    const canvasWorkspace =
      canvasThread && this.#canvasWorkspace ? await this.#canvasWorkspace(canvasThread[1]!) : null;
    if (
      expectedWorkspaceRoot &&
      canvasWorkspace &&
      (await realpath(expectedWorkspaceRoot)) !== canvasWorkspace.cwd
    )
      throw new MossMediaJobsError("canvas_workspace_changed", 409);
    await authorize?.();
    const job = broker.create(normalized);
    if (canvasWorkspace)
      await this.#bindCanvasWorkspace(scope, job.jobId, canvasWorkspace, imageOrigin);
    await broker.saveHistory(job.jobId);
    await authorize?.();
    // run() persists a reservation before its first upstream request. The HTTP
    // response is short; polling observes the task without re-submitting it.
    void broker.run(job.jobId, credential).catch(() => undefined);
    return broker.get(job.jobId) ?? job;
  }

  async open(projectId: string, credential: MossMediaIdentity) {
    if (!/^(?:thread:)?[A-Za-z0-9_-]{1,256}$/u.test(projectId))
      throw new MossMediaJobsError("invalid_request");
    const broker = await this.#ready(credential);
    return { jobs: broker.open(projectId) };
  }

  get(jobId: string, credential: MossMediaCredential, expectedProjectId?: string) {
    const broker = this.#broker(credential);
    const job = broker.get(jobId);
    if (!job || (expectedProjectId !== undefined && job.projectId !== expectedProjectId)) {
      throw new MossMediaJobsError("job_not_found", 404);
    }
    if (
      job.status === "queued" ||
      job.status === "running" ||
      job.status === "reconciliation_required"
    ) {
      void broker.run(jobId, credential).catch(() => undefined);
    }
    return broker.get(jobId) ?? job;
  }

  async readAsset(jobId: string, index: number, credential: MossMediaIdentity) {
    // Import legacy local checkpoints without running/reconciling a supplier job.
    await this.#ready(credential);
    const job = await this.readOwnedJob(jobId, credential);
    const asset = job?.assets?.find((item) => item.index === index);
    if (!asset || !validMossMediaAsset(asset, jobId))
      throw new MossMediaJobsError("asset_not_found", 404);
    try {
      return { asset, bytes: await this.#assets.read(mediaAccountScope(credential), asset) };
    } catch {
      throw new MossMediaJobsError("asset_not_found", 404);
    }
  }

  async check(jobId: string, credential: MossMediaCredential, expectedProjectId?: string) {
    const broker = await this.#ready(credential);
    const projection = this.#canvasWorkspace
      ? await this.#history.get(mediaAccountScope(credential), jobId)
      : null;
    if (
      projection &&
      (expectedProjectId === undefined || projection.snapshot.projectId === expectedProjectId)
    ) {
      try {
        await this.#projectConversation(projection, credential);
      } catch {
        log.warn("conversation canvas save pending", {
          jobId,
          errorCode: "canvas_workspace_save_failed",
        });
      }
    }
    if (!broker.get(jobId)) {
      const stored = await this.#history.get(mediaAccountScope(credential), jobId);
      if (
        !stored ||
        (expectedProjectId !== undefined && stored.snapshot.projectId !== expectedProjectId)
      )
        throw new MossMediaJobsError("job_not_found", 404);
      if (
        (stored.snapshot.status === "succeeded" || stored.snapshot.status === "failed_terminal") &&
        !["pending", "unknown"].includes(stored.snapshot.billingStatus)
      )
        return stored.snapshot;
      broker.restoreDurable(stored);
    }
    const reconciling = broker.get(jobId)?.status === "reconciliation_required";
    const job = this.get(jobId, credential, expectedProjectId);
    if (reconciling) return broker.run(jobId, credential);
    if (
      (job.status === "succeeded" || job.status === "failed_terminal") &&
      (job.billingStatus === "unknown" || job.billingStatus === "pending")
    )
      return broker.refreshBilling(jobId, credential);
    return job;
  }
}
