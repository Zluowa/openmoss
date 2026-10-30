// FILE: hoolaCanvasBridge.ts
// Purpose: Adapt Hoola's generation-job contract to the account-bound Moss canvas gateway.
// Provider credentials remain in the gateway; this broker only receives one live Moss account authority.

import type { MossManagedGatewayAuthority } from "./provider/mossManagedGatewayTrust";
import { createHash, randomUUID } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname } from "node:path";
import {
  canvasVideoInputError,
  normalizeCanvasVideoInput,
  type CanvasVideoMode,
} from "../../../supabase/functions/moss-model-gateway/canvasVideoInput.ts";
import { mediaImageEditInputError } from "./mediaImageEditInput";
import { validMossMediaAsset, type MossMediaAsset } from "./mossMediaAssets";

const IMAGE_MODELS = new Set([
  "gpt-image-2-official",
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "grok-imagine-image-2.0",
  "gemini-flash-image",
  "nano-banana-pro",
  "wan2.7-image-pro",
  "seedream-5-0",
]);

const VIDEO_MODELS = new Set([
  "kling-v3-omni",
  "wan3.0-video",
  "wan3.0-video-prime",
  "happyhorse",
  "happyhorse-video-edit",
  "doubao-seedance-2.0",
  "doubao-seedance-2.0-fast",
  "doubao-seedance-2.5",
  "MiniMax-H3",
  "MiniMax-H3-Max",
]);

const MAX_JOBS = 256;
const MAX_STATE_BYTES = 16 * 1024 * 1024;
const MAX_BODY_STRING_CHARS = 32_000;
// Provider video tasks commonly take minutes. Fifteen-second polling keeps one
// signed-in desktop well below the domestic gateway's per-IP production rate
// limit while still surfacing terminal state promptly.
const DEFAULT_POLL_MS = 15_000;
const DEFAULT_TIMEOUT_MS = 35 * 60_000;

export interface HoolaCanvasAuthorityCredential {
  readonly realm: MossManagedGatewayAuthority;
  readonly accessToken: string;
  readonly gatewayBaseUrl: string;
}

export interface HoolaCanvasJobSnapshot {
  readonly revision?: number;
  readonly success: boolean;
  readonly jobId: string;
  readonly projectId: string;
  readonly conversationId?: string;
  readonly parentJobId?: string | null;
  readonly status:
    | "queued"
    | "running"
    | "succeeded"
    | "failed_terminal"
    | "reconciliation_required";
  readonly prompt: string;
  readonly createdAt: string;
  readonly imageUrls: readonly string[];
  readonly videoUrls: readonly string[];
  readonly retryCount: number;
  readonly persistenceStatus: "pending" | "ready" | "failed";
  readonly billingStatus: "pending" | "captured" | "released" | "exempt" | "unknown";
  readonly billing?: HoolaCanvasBillingDetails;
  readonly assets?: readonly MossMediaAsset[];
  readonly errorCategory:
    | "none"
    | "provider_retryable"
    | "provider_terminal"
    | "user_input_invalid"
    | "auth_required";
  readonly modelId: string;
  readonly operation: "text_to_image" | "image_to_image" | "image_edit" | "video";
  readonly outputAssetId?: string;
  readonly outputAssetUrl?: string;
  readonly assetRef?: {
    readonly assetId: string;
    readonly kind: "generated_output";
    readonly url: string;
    readonly status: "ready";
  };
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

export interface HoolaCanvasBillingDetails {
  readonly creditsReserved?: number;
  readonly creditsCharged?: number;
  readonly priceVersion?: string;
  readonly actualCostNano?: number;
  readonly currency?: "USD" | "CNY";
  readonly nanoPerCredit?: number;
  readonly roundingNano?: number;
  readonly walletKind?: "package_cost_v1" | "media_cost_v1" | "legacy_credit_v2";
  readonly reservedNanoCny?: string;
  readonly chargedNanoCny?: string;
  readonly availableNanoCny?: string;
  readonly heldNanoCny?: string;
  readonly fxVersion?: string;
  readonly fxNumerator?: string;
  readonly fxDenominator?: string;
  readonly fxAsof?: string | null;
  readonly fxSource?: string;
}

interface HoolaCanvasJobInput {
  readonly projectId: string;
  readonly conversationId?: string;
  readonly parentJobId?: string;
  readonly targetCardId?: string;
  readonly operation: "text_to_image" | "image_to_image" | "image_edit" | "video";
  readonly modelId: string;
  readonly prompt: string;
  readonly referenceImages: readonly string[];
  readonly startFrameUrl?: string;
  readonly endFrameUrl?: string;
  readonly generationMode?: CanvasVideoMode;
  readonly referenceVideos?: readonly string[];
  readonly referenceVideoDurations?: readonly number[];
  readonly referenceAudios?: readonly string[];
  readonly referenceAudioDurations?: readonly number[];
  readonly sourceVideoUrl?: string;
  readonly sourceVideoDuration?: number;
  readonly maskImage?: string;
  readonly background?: "auto" | "opaque" | "transparent";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  readonly aspectRatio?: string;
  readonly resolution?: string;
  readonly duration?: number;
  readonly generateAudio?: boolean;
  readonly promptExtend?: boolean;
  readonly idempotencyKey: string;
  readonly metadata?: Readonly<Record<string, unknown>>;
}

interface HoolaCanvasJobRecord {
  readonly jobId: string;
  readonly input: HoolaCanvasJobInput;
  readonly requestDigest?: string;
  status: HoolaCanvasJobSnapshot["status"];
  taskToken?: string;
  provider?: string;
  billingExempt?: boolean;
  errorCode?: string;
  outputAssetUrl?: string;
  outputUrls?: string[];
  billingStatus?: HoolaCanvasJobSnapshot["billingStatus"];
  billing?: HoolaCanvasBillingDetails;
  assets?: readonly MossMediaAsset[];
  outputPersistenceStatus?: "ready" | "failed";
  createdAt: number;
  updatedAt: number;
  revision?: number;
  running: Promise<HoolaCanvasJobSnapshot> | undefined;
}

function strippedMediaInput(input: HoolaCanvasJobInput): HoolaCanvasJobInput {
  const {
    maskImage: _mask,
    startFrameUrl: _first,
    endFrameUrl: _last,
    sourceVideoUrl: _source,
    ...rest
  } = input;
  return { ...rest, referenceImages: [], referenceVideos: [], referenceAudios: [] };
}

export interface HoolaCanvasBridgeOptions {
  readonly fetchImpl?: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly now?: () => number;
  readonly sleep?: (milliseconds: number) => Promise<void>;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
  readonly statePath?: string;
  /** Must commit before a completed job can leave the bounded running set. */
  readonly persistHistory?: (job: HoolaCanvasDurableJob) => Promise<void>;
  readonly cacheOutputs?: (
    jobId: string,
    urls: readonly string[],
    kind: "image" | "video",
  ) => Promise<readonly MossMediaAsset[]>;
}

export interface HoolaCanvasDurableJob {
  readonly snapshot: HoolaCanvasJobSnapshot & {
    readonly conversationId: string;
    readonly parentJobId: string | null;
  };
  readonly checkpoint: Omit<HoolaCanvasJobRecord, "running">;
  readonly idempotencyIdentity: string;
  readonly requestDigest: string;
  readonly revision: number;
}

export function hoolaCanvasRequestIdentity(raw: unknown) {
  const input = normalizeInput(raw);
  return {
    idempotencyIdentity: stableId(`${input.projectId}\0${input.idempotencyKey}`),
    requestDigest: createHash("sha256").update(JSON.stringify(input)).digest("hex"),
  };
}
export function hoolaCanvasModelKind(modelId: unknown): "image" | "video" | null {
  return typeof modelId === "string" && IMAGE_MODELS.has(modelId)
    ? "image"
    : typeof modelId === "string" && VIDEO_MODELS.has(modelId)
      ? "video"
      : null;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function boundedString(value: unknown, maximum = MAX_BODY_STRING_CHARS): string {
  const normalized = String(value ?? "").trim();
  return normalized.length <= maximum ? normalized : "";
}

function stableId(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 32);
}

function normalizedReferenceImages(value: unknown): readonly string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((candidate): candidate is string => typeof candidate === "string")
    .map((candidate) => candidate.trim())
    .filter((candidate) => /^https:\/\//iu.test(candidate) || /^data:image\//iu.test(candidate))
    .slice(0, 16);
}

function normalizeInput(value: unknown, validateVideoOptions = true): HoolaCanvasJobInput {
  if (!isRecord(value)) throw new Error("invalid_request");
  const modelId = boundedString(value.modelId ?? value.model_id, 128);
  const operation = boundedString(value.operation, 32);
  const prompt = boundedString(value.prompt, 8_000);
  const projectId = boundedString(value.projectId ?? value.project_id, 256);
  const idempotencyKey = boundedString(value.idempotencyKey ?? value.idempotency_key, 512);
  const isImage = IMAGE_MODELS.has(modelId);
  const isVideo = VIDEO_MODELS.has(modelId);
  if (isVideo && validateVideoOptions) {
    const error = canvasVideoInputError(value, { modelId });
    // Both existing HTTP adapters recognize this safe validation code as 400.
    if (error) throw new Error("invalid_request", { cause: error });
  }
  if (
    (value.conversationId !== undefined || value.parentJobId !== undefined) &&
    (typeof value.conversationId !== "string" ||
      !/^mossconv_[a-f0-9]{32}$/u.test(value.conversationId) ||
      typeof value.parentJobId !== "string" ||
      !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(value.parentJobId))
  )
    throw new Error("invalid_conversation");
  if (!isImage && !isVideo) throw new Error("unsupported_model");
  const { maskImage, background, outputFormat } = value;
  // Recovery checkpoints intentionally omit source bytes after submission. They
  // must never reconstruct a fresh request, so only live input is canonicalized.
  const videoInput =
    isVideo && validateVideoOptions ? normalizeCanvasVideoInput(value, modelId) : undefined;
  const references =
    videoInput?.referenceImages ??
    normalizedReferenceImages(value.referenceImages ?? value.reference_images);
  const editError = mediaImageEditInputError({ ...value, modelId, referenceImages: references });
  if (editError) throw new Error(editError);
  if (
    !projectId ||
    !prompt ||
    !idempotencyKey ||
    !["text_to_image", "image_to_image", "image_edit", "video"].includes(operation) ||
    (operation === "video") !== isVideo
  ) {
    throw new Error("invalid_request");
  }
  return {
    projectId,
    ...(typeof value.conversationId === "string" ? { conversationId: value.conversationId } : {}),
    ...(typeof value.parentJobId === "string" ? { parentJobId: value.parentJobId } : {}),
    ...(boundedString(value.targetCardId ?? value.target_card_id, 256)
      ? {
          targetCardId: boundedString(value.targetCardId ?? value.target_card_id, 256),
        }
      : {}),
    operation: operation as HoolaCanvasJobInput["operation"],
    modelId,
    prompt,
    referenceImages: references,
    ...(videoInput
      ? {
          generationMode: videoInput.generationMode,
          ...(videoInput.startFrameUrl ? { startFrameUrl: videoInput.startFrameUrl } : {}),
          ...(videoInput.endFrameUrl ? { endFrameUrl: videoInput.endFrameUrl } : {}),
          referenceVideos: videoInput.referenceVideos,
          referenceVideoDurations: videoInput.referenceVideoDurations,
          referenceAudios: videoInput.referenceAudios,
          referenceAudioDurations: videoInput.referenceAudioDurations,
          ...(videoInput.sourceVideoUrl
            ? {
                sourceVideoUrl: videoInput.sourceVideoUrl,
                sourceVideoDuration: videoInput.sourceVideoDuration!,
              }
            : {}),
        }
      : {}),
    ...(typeof maskImage === "string" ? { maskImage } : {}),
    ...(background !== undefined
      ? { background: background as NonNullable<HoolaCanvasJobInput["background"]> }
      : {}),
    ...(outputFormat !== undefined
      ? { outputFormat: outputFormat as NonNullable<HoolaCanvasJobInput["outputFormat"]> }
      : {}),
    ...(boundedString(value.aspectRatio ?? value.aspect_ratio, 32)
      ? {
          aspectRatio: boundedString(value.aspectRatio ?? value.aspect_ratio, 32),
        }
      : {}),
    ...(boundedString(value.resolution, 16)
      ? { resolution: boundedString(value.resolution, 16) }
      : {}),
    ...(Number.isInteger(value.duration) ? { duration: Number(value.duration) } : {}),
    ...(typeof value.generateAudio === "boolean" ? { generateAudio: value.generateAudio } : {}),
    ...(typeof value.promptExtend === "boolean" ? { promptExtend: value.promptExtend } : {}),
    idempotencyKey,
    ...(isRecord(value.metadata) ? { metadata: value.metadata } : {}),
  };
}

function safeGatewayErrorCode(value: unknown, fallback: string): string {
  if (!isRecord(value)) return fallback;
  const nested = isRecord(value.error) ? value.error : value;
  const candidate = boundedString(nested.code, 120);
  return /^[A-Za-z0-9._:-]+$/u.test(candidate) ? candidate : fallback;
}

function isBillingStatus(value: unknown): value is HoolaCanvasJobSnapshot["billingStatus"] {
  return (
    typeof value === "string" &&
    ["pending", "captured", "released", "exempt", "unknown"].includes(value)
  );
}

function safeBillingDetails(value: unknown): HoolaCanvasBillingDetails {
  if (!isRecord(value)) return {};
  const details: Record<string, string | number | null> = {};
  for (const key of [
    "creditsReserved",
    "creditsCharged",
    "actualCostNano",
    "nanoPerCredit",
    "roundingNano",
  ] as const) {
    const number = value[key];
    if (typeof number === "number" && Number.isSafeInteger(number) && number >= 0)
      details[key] = number;
  }
  if (value.currency === "USD" || value.currency === "CNY") details.currency = value.currency;
  if (typeof value.priceVersion === "string" && value.priceVersion.length <= 200)
    details.priceVersion = value.priceVersion;
  if (
    value.walletKind === "package_cost_v1" ||
    value.walletKind === "media_cost_v1" ||
    value.walletKind === "legacy_credit_v2"
  )
    details.walletKind = value.walletKind;
  for (const key of [
    "reservedNanoCny",
    "chargedNanoCny",
    "availableNanoCny",
    "heldNanoCny",
    "fxNumerator",
    "fxDenominator",
  ] as const) {
    const amount = value[key];
    if (
      typeof amount === "string" &&
      /^(0|[1-9][0-9]{0,18})$/u.test(amount) &&
      BigInt(amount) <= 9_223_372_036_854_775_807n
    )
      details[key] = amount;
  }
  if (
    typeof value.fxVersion === "string" &&
    /^[A-Za-z0-9][A-Za-z0-9._:-]{1,191}$/u.test(value.fxVersion)
  )
    details.fxVersion = value.fxVersion;
  if (
    value.fxAsof === null ||
    (typeof value.fxAsof === "string" && /^\d{4}-\d{2}-\d{2}$/u.test(value.fxAsof))
  )
    details.fxAsof = value.fxAsof;
  if (
    typeof value.fxSource === "string" &&
    value.fxSource.length <= 512 &&
    (value.fxSource === "identity:CNY" || value.fxSource.startsWith("https://"))
  )
    details.fxSource = value.fxSource;
  return details;
}

function safeOutputUrls(values: readonly unknown[]): string[] {
  return [
    ...new Set(
      values.filter((value): value is string => {
        if (typeof value !== "string" || value.length > 16_384) return false;
        try {
          const url = new URL(value);
          return url.protocol === "https:" && !url.username && !url.password;
        } catch {
          return false;
        }
      }),
    ),
  ].slice(0, 32);
}

function snapshot(record: HoolaCanvasJobRecord): HoolaCanvasDurableJob["snapshot"] {
  const succeeded = record.status === "succeeded" && Boolean(record.outputAssetUrl);
  const failed = record.status === "failed_terminal";
  const outputAssetId = succeeded ? `moss_${stableId(record.outputAssetUrl!)}` : undefined;
  return {
    success: !failed,
    revision: record.revision ?? 0,
    jobId: record.jobId,
    projectId: record.input.projectId,
    conversationId: record.input.conversationId ?? `mossconv_${stableId(record.jobId)}`,
    parentJobId: record.input.parentJobId ?? null,
    status: record.status,
    prompt: record.input.prompt,
    createdAt: new Date(record.createdAt).toISOString(),
    imageUrls:
      record.input.operation === "video"
        ? []
        : (record.outputUrls ?? (record.outputAssetUrl ? [record.outputAssetUrl] : [])),
    videoUrls:
      record.input.operation === "video"
        ? (record.outputUrls ?? (record.outputAssetUrl ? [record.outputAssetUrl] : []))
        : [],
    retryCount: 0,
    persistenceStatus: succeeded
      ? (record.outputPersistenceStatus ?? "ready")
      : failed
        ? "failed"
        : "pending",
    billingStatus: record.billingExempt === true ? "exempt" : (record.billingStatus ?? "unknown"),
    ...(record.billing ? { billing: record.billing } : {}),
    ...(record.assets ? { assets: record.assets } : {}),
    errorCategory: failed
      ? record.errorCode === "authentication_required"
        ? "auth_required"
        : "provider_terminal"
      : "none",
    modelId: record.input.modelId,
    operation: record.input.operation,
    ...(outputAssetId ? { outputAssetId } : {}),
    ...(record.outputAssetUrl ? { outputAssetUrl: record.outputAssetUrl } : {}),
    ...(outputAssetId && record.outputAssetUrl
      ? {
          assetRef: {
            assetId: outputAssetId,
            kind: "generated_output",
            url: record.outputAssetUrl,
            status: "ready",
          },
        }
      : {}),
    ...(record.errorCode
      ? {
          errorCode: record.errorCode,
          errorMessage: "Moss canvas media request failed.",
        }
      : {}),
    metadata: {
      sourceSurface: "hoola-canvas-bridge",
      ...(record.provider ? { provider: record.provider } : {}),
      ...(record.billingExempt !== undefined ? { billingExempt: record.billingExempt } : {}),
    },
  };
}

export class HoolaCanvasBridgeBroker {
  readonly #fetch: (input: string | URL | Request, init?: RequestInit) => Promise<Response>;
  readonly #now: () => number;
  readonly #sleep: (milliseconds: number) => Promise<void>;
  readonly #pollMs: number;
  readonly #timeoutMs: number;
  readonly #statePath: string | undefined;
  readonly #cacheOutputs: HoolaCanvasBridgeOptions["cacheOutputs"];
  readonly #persistHistory: HoolaCanvasBridgeOptions["persistHistory"];
  readonly #archived = new Map<string, number>();
  readonly #jobs = new Map<string, HoolaCanvasJobRecord>();
  readonly #idempotency = new Map<string, string>();
  readonly #billingRefreshes = new WeakSet<Promise<HoolaCanvasJobSnapshot>>();

  constructor(options: HoolaCanvasBridgeOptions = {}) {
    this.#fetch = options.fetchImpl ?? globalThis.fetch;
    this.#now = options.now ?? Date.now;
    this.#sleep =
      options.sleep ??
      ((milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds)));
    this.#pollMs = options.pollMs ?? DEFAULT_POLL_MS;
    this.#timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.#statePath = options.statePath;
    this.#cacheOutputs = options.cacheOutputs;
    this.#persistHistory = options.persistHistory;
    this.#restore();
  }

  #restore(): void {
    if (!this.#statePath) return;
    try {
      const info = statSync(this.#statePath);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_STATE_BYTES) return;
      const parsed = JSON.parse(readFileSync(this.#statePath, "utf8"));
      if (!parsed || parsed.version !== 1 || !Array.isArray(parsed.jobs)) return;
      for (const raw of parsed.jobs.slice(-MAX_JOBS)) {
        if (!isRecord(raw)) continue;
        // Existing records remain readable/queryable, including legacy metadata.
        // New creation paths validate before their input can be normalized away.
        const input = normalizeInput(raw.input, false);
        const jobId = boundedString(raw.jobId, 128);
        const status = boundedString(raw.status, 32);
        if (
          !/^moss_[A-Za-z0-9_-]+$/u.test(jobId) ||
          ![
            "queued",
            "running",
            "succeeded",
            "failed_terminal",
            "reconciliation_required",
          ].includes(status)
        )
          continue;
        const record: HoolaCanvasJobRecord = {
          jobId,
          input,
          ...(typeof raw.requestDigest === "string" && /^[a-f0-9]{64}$/u.test(raw.requestDigest)
            ? { requestDigest: raw.requestDigest }
            : {}),
          status: status as HoolaCanvasJobRecord["status"],
          createdAt: Number(raw.createdAt) || this.#now(),
          updatedAt: Number(raw.updatedAt) || this.#now(),
          revision:
            typeof raw.revision === "number" &&
            Number.isSafeInteger(raw.revision) &&
            raw.revision >= 0
              ? raw.revision
              : 0,
          running: undefined,
        };
        const taskToken = boundedString(raw.taskToken, 32_000);
        const provider = boundedString(raw.provider, 120);
        const outputAssetUrl = boundedString(raw.outputAssetUrl, 4_096);
        const errorCode = boundedString(raw.errorCode, 120);
        if (taskToken) record.taskToken = taskToken;
        // A legacy queued video may still contain intent the old normalizer
        // discarded. Reconcile its operation instead of creating a text video.
        if (
          (record.status === "running" && !taskToken) ||
          (record.status === "queued" &&
            (this.#persistHistory ||
              (input.operation === "video" &&
                isRecord(raw.input) &&
                canvasVideoInputError(raw.input))))
        ) {
          record.status = "reconciliation_required";
          record.errorCode = "submission_outcome_unknown";
          record.revision = (record.revision ?? 0) + 1;
        }
        if (provider) record.provider = provider;
        if (outputAssetUrl && /^https:\/\//iu.test(outputAssetUrl))
          record.outputAssetUrl = outputAssetUrl;
        if (Array.isArray(raw.outputUrls)) record.outputUrls = safeOutputUrls(raw.outputUrls);
        if (isBillingStatus(raw.billingStatus)) record.billingStatus = raw.billingStatus;
        if (isRecord(raw.billing)) record.billing = safeBillingDetails(raw.billing);
        if (Array.isArray(raw.assets))
          record.assets = raw.assets.filter((asset) => validMossMediaAsset(asset, jobId));
        if (raw.outputPersistenceStatus === "ready" || raw.outputPersistenceStatus === "failed")
          record.outputPersistenceStatus = raw.outputPersistenceStatus;
        else if (this.#cacheOutputs && record.status === "succeeded")
          record.outputPersistenceStatus = "failed";
        if (errorCode && /^[A-Za-z0-9._:-]+$/u.test(errorCode)) record.errorCode = errorCode;
        if (typeof raw.billingExempt === "boolean") record.billingExempt = raw.billingExempt;
        this.#jobs.set(record.jobId, record);
        this.#idempotency.set(
          stableId(`${input.projectId}\0${input.idempotencyKey}`),
          record.jobId,
        );
      }
    } catch {
      // A missing or corrupt cache never creates a fresh provider request by
      // itself; the next explicit create still goes through idempotency.
    }
  }

  #persist(): void {
    if (!this.#statePath) return;
    const temporaryPath = `${this.#statePath}.${process.pid}.tmp`;
    // Once submission starts, restart recovery needs only the opaque task and
    // input digest. Large reference image bytes are not retained in history.
    const jobs = [...this.#jobs.values()].map(({ running: _running, ...record }) => ({
      ...record,
      input: record.status === "queued" ? record.input : strippedMediaInput(record.input),
    }));
    try {
      mkdirSync(dirname(this.#statePath), { recursive: true, mode: 0o700 });
      try {
        unlinkSync(temporaryPath);
      } catch {
        // No stale temporary file.
      }
      const serialized = `${JSON.stringify({ version: 1, jobs })}\n`;
      if (Buffer.byteLength(serialized) > MAX_STATE_BYTES)
        throw new Error("checkpoint_capacity_exceeded");
      writeFileSync(temporaryPath, serialized, {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      });
      chmodSync(temporaryPath, 0o600);
      renameSync(temporaryPath, this.#statePath);
    } catch {
      try {
        unlinkSync(temporaryPath);
      } catch {
        // Preserve the original checkpoint failure.
      }
      // A durable reservation must exist before billable provider work starts.
      throw new Error("checkpoint_unavailable");
    }
  }

  create(raw: unknown): HoolaCanvasJobSnapshot {
    const input = normalizeInput(raw);
    const requestDigest = createHash("sha256").update(JSON.stringify(input)).digest("hex");
    const idempotencyIdentity = stableId(`${input.projectId}\0${input.idempotencyKey}`);
    const existingId = this.#idempotency.get(idempotencyIdentity);
    const existing = existingId ? this.#jobs.get(existingId) : undefined;
    if (existing) {
      const existingDigest =
        existing.requestDigest ??
        createHash("sha256").update(JSON.stringify(existing.input)).digest("hex");
      if (existingDigest !== requestDigest) throw new Error("idempotency_conflict");
      return snapshot(existing);
    }

    if (this.#jobs.size >= MAX_JOBS) {
      const oldest = [...this.#jobs.values()]
        .filter((job) => this.#canEvict(job))
        .sort((left, right) => left.updatedAt - right.updatedAt)[0];
      if (oldest && !oldest.running) {
        this.#jobs.delete(oldest.jobId);
        this.#archived.delete(oldest.jobId);
        this.#idempotency.delete(
          stableId(`${oldest.input.projectId}\0${oldest.input.idempotencyKey}`),
        );
      }
      if (this.#jobs.size >= MAX_JOBS) throw new Error("job_capacity_exceeded");
    }
    const now = this.#now();
    const job: HoolaCanvasJobRecord = {
      jobId: `moss_${randomUUID().replaceAll("-", "")}`,
      input,
      requestDigest,
      status: "queued",
      createdAt: now,
      updatedAt: now,
      revision: 1,
      running: undefined,
    };
    this.#jobs.set(job.jobId, job);
    this.#idempotency.set(idempotencyIdentity, job.jobId);
    this.#persist();
    return snapshot(job);
  }

  get(jobId: string): HoolaCanvasJobSnapshot | null {
    const record = this.#jobs.get(jobId);
    return record ? snapshot(record) : null;
  }

  list(): readonly HoolaCanvasJobSnapshot[] {
    return [...this.#jobs.values()]
      .sort((left, right) => right.createdAt - left.createdAt)
      .map(snapshot);
  }

  #canEvict(record: HoolaCanvasJobRecord): boolean {
    if (record.running) return false;
    if (!this.#persistHistory)
      return record.status === "succeeded" || record.status === "failed_terminal";
    const job = snapshot(record);
    return (
      this.#archived.get(record.jobId) === (record.revision ?? 0) &&
      (job.billingStatus === "captured" ||
        job.billingStatus === "released" ||
        job.billingStatus === "exempt") &&
      (job.status === "failed_terminal" ||
        (job.status === "succeeded" && job.persistenceStatus === "ready"))
    );
  }

  durableJobs(): readonly HoolaCanvasDurableJob[] {
    return [...this.#jobs.values()].map((record) => this.#durable(record));
  }

  #durable(record: HoolaCanvasJobRecord): HoolaCanvasDurableJob {
    const { running: _running, ...checkpoint } = record;
    return {
      snapshot: snapshot(record),
      checkpoint: { ...checkpoint, input: strippedMediaInput(record.input) },
      idempotencyIdentity: stableId(`${record.input.projectId}\0${record.input.idempotencyKey}`),
      requestDigest:
        record.requestDigest ??
        createHash("sha256").update(JSON.stringify(record.input)).digest("hex"),
      revision: record.revision ?? 0,
    };
  }

  async saveHistory(jobId: string): Promise<void> {
    const record = this.#jobs.get(jobId);
    if (!record || !this.#persistHistory) return;
    const durable = this.#durable(record);
    await this.#persistHistory(durable);
    this.#archived.set(jobId, Math.max(this.#archived.get(jobId) ?? -1, durable.revision));
  }

  /** Used only with a validated, account-scoped durable record, never HTTP input. */
  restoreDurable(job: HoolaCanvasDurableJob): void {
    if (!this.#jobs.has(job.snapshot.jobId) && this.#jobs.size >= MAX_JOBS) {
      const evictable = [...this.#jobs.values()].find((record) => this.#canEvict(record));
      if (!evictable) throw new Error("job_capacity_exceeded");
      this.#jobs.delete(evictable.jobId);
      this.#archived.delete(evictable.jobId);
      this.#idempotency.delete(
        stableId(`${evictable.input.projectId}\0${evictable.input.idempotencyKey}`),
      );
    }
    const record: HoolaCanvasJobRecord = { ...job.checkpoint, running: undefined };
    // A historical queued/running checkpoint cannot prove no upstream acceptance.
    // Recovery may query its operation ID, but must never resubmit it.
    if (record.status === "queued" || (record.status === "running" && !record.taskToken)) {
      record.status = "reconciliation_required";
      record.errorCode = "submission_outcome_unknown";
      record.revision = job.revision + 1;
    }
    this.#jobs.set(record.jobId, record);
    this.#idempotency.set(job.idempotencyIdentity, record.jobId);
    this.#archived.set(record.jobId, job.revision);
  }

  async #checkpoint(record: HoolaCanvasJobRecord): Promise<void> {
    record.revision = (record.revision ?? 0) + 1;
    this.#persist();
    await this.saveHistory(record.jobId);
  }

  open(projectId: string): readonly HoolaCanvasJobSnapshot[] {
    return [...this.#jobs.values()]
      .filter(
        (record) =>
          record.input.projectId === projectId &&
          record.status !== "succeeded" &&
          record.status !== "failed_terminal",
      )
      .map(snapshot);
  }

  async run(
    jobId: string,
    credential: HoolaCanvasAuthorityCredential,
  ): Promise<HoolaCanvasJobSnapshot> {
    const record = this.#jobs.get(jobId);
    if (!record) throw new Error("job_not_found");
    if (record.running) return record.running;
    if (record.status === "succeeded" || record.status === "failed_terminal")
      return snapshot(record);
    // An uncertain submit may already be billable. Recover it only through the
    // account-bound ledger query; never send a second generation request.
    const recoverOnly =
      (record.status === "reconciliation_required" || record.status === "running") &&
      !record.taskToken;
    const running = this.#run(record, credential, recoverOnly).finally(() => {
      if (record.running === running) record.running = undefined;
    });
    record.running = running;
    return running;
  }

  async refreshBilling(
    jobId: string,
    credential: HoolaCanvasAuthorityCredential,
  ): Promise<HoolaCanvasJobSnapshot> {
    const record = this.#jobs.get(jobId);
    if (!record) throw new Error("job_not_found");
    const previous = record.running;
    if (previous && this.#billingRefreshes.has(previous)) return previous;
    const needsRefresh = () =>
      (record.status === "succeeded" || record.status === "failed_terminal") &&
      record.billingExempt !== true &&
      (record.billingStatus === undefined ||
        record.billingStatus === "unknown" ||
        record.billingStatus === "pending");
    if (!needsRefresh()) return previous ?? snapshot(record);
    // The visible completion can precede its final durable checkpoint. Join
    // that generation first, then perform this explicit billing query once.
    const running = (async () => {
      if (previous) await previous;
      return needsRefresh() ? this.#refreshBilling(record, credential) : snapshot(record);
    })().finally(() => {
      this.#billingRefreshes.delete(running);
      if (record.running === running) record.running = undefined;
    });
    this.#billingRefreshes.add(running);
    record.running = running;
    return running;
  }

  async #refreshBilling(
    record: HoolaCanvasJobRecord,
    credential: HoolaCanvasAuthorityCredential,
  ): Promise<HoolaCanvasJobSnapshot> {
    const operationId = `hoola-canvas:${stableId(`${record.input.projectId}\0${record.input.idempotencyKey}`)}`;
    // Completion is durable. A late bill check cannot resubmit, erase assets,
    // downgrade the visual result, or release a hold on a transport failure.
    const queried = await this.#post(credential, "/v1/canvas/media/query", {
      ...(record.taskToken ? { taskToken: record.taskToken } : {}),
      operationId,
    });
    const data = isRecord(queried.data) ? queried.data : {};
    const expectedStatus = record.status === "failed_terminal" ? "failed" : "completed";
    if (!queried.response.ok || data.status !== expectedStatus || data.pending !== false)
      throw new Error("billing_query_failed");
    const refreshedToken = boundedString(data.taskToken, 32_000);
    if (refreshedToken) record.taskToken = refreshedToken;
    if (isBillingStatus(data.billingStatus)) record.billingStatus = data.billingStatus;
    if (typeof data.billingExempt === "boolean") record.billingExempt = data.billingExempt;
    record.billing = { ...record.billing, ...safeBillingDetails(data) };
    record.updatedAt = this.#now();
    await this.#checkpoint(record);
    return snapshot(record);
  }

  async #post(
    credential: HoolaCanvasAuthorityCredential,
    path: string,
    body: Readonly<Record<string, unknown>>,
    operationId?: string,
  ): Promise<{ readonly response: Response; readonly data: unknown }> {
    const gatewayRoot = credential.gatewayBaseUrl.replace(/\/+$/u, "").replace(/\/v1$/u, "");
    const response = await this.#fetch(`${gatewayRoot}${path}`, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": "application/json",
        ...(operationId ? { "x-moss-operation-id": operationId } : {}),
      },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(130_000),
      redirect: "error",
    });
    const raw = await response.text();
    let data: unknown = {};
    try {
      data = raw ? JSON.parse(raw) : {};
    } catch {
      data = {};
    }
    return { response, data };
  }

  async #run(
    record: HoolaCanvasJobRecord,
    credential: HoolaCanvasAuthorityCredential,
    recoverOnly = false,
  ): Promise<HoolaCanvasJobSnapshot> {
    record.status = "running";
    record.updatedAt = this.#now();
    await this.#checkpoint(record);
    const operationId = `hoola-canvas:${stableId(`${record.input.projectId}\0${record.input.idempotencyKey}`)}`;
    try {
      if (!record.taskToken && !recoverOnly) {
        const isVideo = record.input.operation === "video";
        const created = await this.#post(
          credential,
          isVideo ? "/v1/canvas/videos/generations" : "/v1/canvas/images/generations",
          {
            modelId: record.input.modelId,
            prompt: record.input.prompt,
            ...(record.input.referenceImages.length > 0
              ? { referenceImages: record.input.referenceImages }
              : {}),
            ...(record.input.startFrameUrl ? { startFrameUrl: record.input.startFrameUrl } : {}),
            ...(record.input.endFrameUrl ? { endFrameUrl: record.input.endFrameUrl } : {}),
            ...(record.input.generationMode ? { generationMode: record.input.generationMode } : {}),
            ...(record.input.referenceVideos?.length
              ? {
                  referenceVideos: record.input.referenceVideos,
                  referenceVideoDurations: record.input.referenceVideoDurations,
                }
              : {}),
            ...(record.input.referenceAudios?.length
              ? {
                  referenceAudios: record.input.referenceAudios,
                  referenceAudioDurations: record.input.referenceAudioDurations,
                }
              : {}),
            ...(record.input.sourceVideoUrl
              ? {
                  sourceVideoUrl: record.input.sourceVideoUrl,
                  sourceVideoDuration: record.input.sourceVideoDuration,
                }
              : {}),
            ...(record.input.maskImage ? { maskImage: record.input.maskImage } : {}),
            ...(record.input.background ? { background: record.input.background } : {}),
            ...(record.input.outputFormat ? { outputFormat: record.input.outputFormat } : {}),
            ...(record.input.aspectRatio ? { aspectRatio: record.input.aspectRatio } : {}),
            ...(record.input.resolution ? { resolution: record.input.resolution } : {}),
            ...(record.input.duration !== undefined ? { duration: record.input.duration } : {}),
            ...(record.input.generateAudio !== undefined
              ? { generateAudio: record.input.generateAudio }
              : {}),
            ...(record.input.promptExtend !== undefined
              ? { promptExtend: record.input.promptExtend }
              : {}),
          },
          operationId,
        );
        const createdData = isRecord(created.data) ? created.data : {};
        if (isBillingStatus(createdData.billingStatus))
          record.billingStatus = createdData.billingStatus;
        record.billing = { ...record.billing, ...safeBillingDetails(createdData) };
        if (
          !created.response.ok ||
          typeof createdData.taskToken !== "string" ||
          !createdData.taskToken
        ) {
          record.errorCode = safeGatewayErrorCode(
            created.data,
            `submit_http_${created.response.status}`,
          );
          // These admission errors are authored before the proxy forwards the
          // request. Other 5xx responses still have an uncertain billable outcome.
          const rejectedBeforeForwarding =
            created.response.status === 503 &&
            !createdData.taskToken &&
            createdData.billingStatus === undefined &&
            ["MEDIA_ADMISSION_MAINTENANCE", "PROXY_CAPACITY_EXCEEDED"].includes(record.errorCode);
          if (rejectedBeforeForwarding) {
            record.status = "failed_terminal";
            record.billingStatus = "released";
            record.billing = { actualCostNano: 0 };
            record.updatedAt = this.#now();
            await this.#checkpoint(record);
            return snapshot(record);
          }
          record.status =
            created.response.status >= 500 ||
            created.response.status === 409 ||
            created.response.status === 408 ||
            created.response.ok
              ? "reconciliation_required"
              : "failed_terminal";
          record.updatedAt = this.#now();
          await this.#checkpoint(record);
          return snapshot(record);
        }
        record.taskToken = createdData.taskToken;
        const provider = boundedString(createdData.provider, 120);
        if (provider) record.provider = provider;
        record.billingExempt = createdData.billingExempt === true;
        record.updatedAt = this.#now();
        await this.#checkpoint(record);
      }

      const deadline = this.#now() + this.#timeoutMs;
      while (this.#now() < deadline) {
        const queried = await this.#post(credential, "/v1/canvas/media/query", {
          ...(record.taskToken ? { taskToken: record.taskToken } : {}),
          operationId,
        });
        const queriedData = isRecord(queried.data) ? queried.data : {};
        const refreshedToken = boundedString(queriedData.taskToken, 32_000);
        if (refreshedToken && refreshedToken !== record.taskToken) {
          record.taskToken = refreshedToken;
          record.updatedAt = this.#now();
          await this.#checkpoint(record);
        }
        if (isBillingStatus(queriedData.billingStatus))
          record.billingStatus = queriedData.billingStatus;
        record.billing = { ...record.billing, ...safeBillingDetails(queriedData) };
        if (typeof queriedData.billingExempt === "boolean")
          record.billingExempt = queriedData.billingExempt;
        if (queriedData.status === "failed" || queriedData.terminal === true) {
          record.errorCode = safeGatewayErrorCode(queried.data, "provider_generation_failed");
          record.status = "failed_terminal";
          record.updatedAt = this.#now();
          await this.#checkpoint(record);
          return snapshot(record);
        }
        if (!queried.response.ok) {
          if (queried.response.status === 429 || queried.response.status >= 500) {
            record.updatedAt = this.#now();
            await this.#checkpoint(record);
            await this.#sleep(this.#pollMs);
            continue;
          }
          record.errorCode = safeGatewayErrorCode(
            queried.data,
            `query_http_${queried.response.status}`,
          );
          record.status = "reconciliation_required";
          record.updatedAt = this.#now();
          await this.#checkpoint(record);
          return snapshot(record);
        }
        if (queriedData.pending === false) {
          const urls = safeOutputUrls([
            ...(Array.isArray(queriedData.imageUrls) ? queriedData.imageUrls : []),
            ...(Array.isArray(queriedData.videoUrls) ? queriedData.videoUrls : []),
            queriedData.imageUrl,
            queriedData.videoUrl,
          ]);
          if (urls.length === 0) {
            record.errorCode = safeGatewayErrorCode(queried.data, "asset_url_missing");
            record.status = "reconciliation_required";
          } else {
            record.outputAssetUrl = urls[0]!;
            record.outputUrls = urls;
            if (this.#cacheOutputs) {
              // The returned output and bill survive a crash during download.
              // They also receive their own public revision before this await.
              record.updatedAt = this.#now();
              await this.#checkpoint(record);
              try {
                record.assets = await this.#cacheOutputs(
                  record.jobId,
                  urls,
                  record.input.operation === "video" ? "video" : "image",
                );
                record.outputPersistenceStatus =
                  record.assets.length === urls.length ? "ready" : "failed";
              } catch {
                record.outputPersistenceStatus = "failed";
              }
            }
            record.status = "succeeded";
            delete record.errorCode;
          }
          record.updatedAt = this.#now();
          await this.#checkpoint(record);
          return snapshot(record);
        }
        record.updatedAt = this.#now();
        await this.#checkpoint(record);
        await this.#sleep(this.#pollMs);
      }
      record.errorCode = "gateway_timeout";
      record.status = "reconciliation_required";
      record.updatedAt = this.#now();
      await this.#checkpoint(record);
      return snapshot(record);
    } catch (error) {
      record.errorCode =
        error instanceof Error && error.name === "TimeoutError"
          ? "gateway_timeout"
          : "gateway_transport_failed";
      record.status = "reconciliation_required";
      record.updatedAt = this.#now();
      await this.#checkpoint(record);
      return snapshot(record);
    }
  }
}
