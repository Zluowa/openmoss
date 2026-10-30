import { Cause, Effect, FileSystem } from "effect";
import { timingSafeEqual } from "node:crypto";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";
import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { MossPhoneAccountService } from "./account/Services/MossPhoneAccountService";
import type { MossCloudAccountService } from "./account/Services/MossCloudAccountService";
import type { MossEnterpriseKeyAccount } from "./account/Services/MossEnterpriseKeyAccount";
import { MossPayService } from "./account/Services/MossPayService";
import { ServerConfig } from "./config";
import { isLoopbackHost } from "./startupAccess";
import { MossMediaJobsError, type MossMediaCredential } from "./mossMediaJobsService";
import { MediaHistoryError, type MediaHistoryPageInput } from "./mossMediaHistory";
import {
  cacheMossCanvasRemoteAsset,
  mossCanvasStorageFor,
  promoteMossCanvasAsset,
} from "./mossCanvasStorage";
import {
  HoolaCanvasSegmentsBridgeBroker,
  HoolaCanvasSegmentsBridgeError,
} from "./hoolaCanvasSegmentsBridge";
import { join } from "node:path";
import { mossCanvasTextModels, relayMossCanvasText } from "./mossCanvasText";
import { mossCanvasWorkspaceFingerprint, resolveMossCanvasWorkspace } from "./mossCanvasWorkspace";
import { createLogger } from "./logger";
import type { MossLocalAccountAuthority } from "./account/mossLocalAccountAuthority";
import { promoteMossCanvasOwnedMediaAsset } from "./mossCanvasMediaPromotion";
import {
  mossMediaJobsServiceFor,
  resolveMossMediaCredential,
  resolveMossMediaIdentity,
  installedMossMediaModels,
} from "./mossMediaAuthority";
import {
  isTrustedAppOrigin,
  normalizeCorsOrigin,
  shouldRejectAuthMutationOrigin,
  shouldRejectUntrustedRequestOrigin,
} from "./trustedOrigins";

const PREFIX = "/api/moss/media/jobs";
const canvasLog = createLogger("canvas-local");
const segmentBrokers = new Map<string, HoolaCanvasSegmentsBridgeBroker>();
function canvasSegmentsFor(stateDirectory: string) {
  let broker = segmentBrokers.get(stateDirectory);
  if (!broker) {
    broker = new HoolaCanvasSegmentsBridgeBroker({
      statePath: join(stateDirectory, "hoola-canvas-segments.json"),
    });
    segmentBrokers.set(stateDirectory, broker);
  }
  return broker;
}

function historyInput(url: URL): MediaHistoryPageInput {
  for (const key of url.searchParams.keys()) {
    if (
      !["kind", "limit", "cursor", "token"].includes(key) ||
      url.searchParams.getAll(key).length !== 1
    )
      throw new MediaHistoryError("invalid_history_cursor");
  }
  const kind = url.searchParams.get("kind");
  const limit = url.searchParams.get("limit");
  const cursor = url.searchParams.get("cursor");
  if (
    (kind !== null && kind !== "image" && kind !== "video") ||
    (limit !== null && !/^[1-9][0-9]?$/u.test(limit))
  )
    throw new MediaHistoryError("invalid_history_cursor");
  return {
    ...(kind ? { kind: kind as "image" | "video" } : {}),
    ...(limit ? { limit: Number(limit) } : {}),
    ...(cursor !== null ? { cursor } : {}),
  };
}

export const mossMediaJobsEffectRouteLayer = HttpRouter.add(
  "*",
  "/api/moss/media/*",
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    const config = yield* ServerConfig;
    if (!url)
      return HttpServerResponse.jsonUnsafe({ error: { code: "invalid_request" } }, { status: 400 });
    const origin = normalizeCorsOrigin(request.headers.origin);
    const trustedOrigin =
      origin && isTrustedAppOrigin({ origin, requestOrigin: url.origin, config });
    const headers: Record<string, string> = {
      "Cache-Control": "no-store",
      "X-Content-Type-Options": "nosniff",
      ...(trustedOrigin
        ? {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Credentials": "true",
            Vary: "Origin",
          }
        : {}),
    };
    const json = (status: number, body: unknown) =>
      HttpServerResponse.jsonUnsafe(body, { status, headers });
    if (request.method === "OPTIONS")
      return trustedOrigin
        ? HttpServerResponse.empty({
            status: 204,
            headers: {
              ...headers,
              "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
              "Access-Control-Allow-Headers": "authorization, content-type",
            },
          })
        : json(403, { error: { code: "trusted_origin_required" } });
    const auth = yield* ServerAuth;
    // Hosted Canvas keeps the same startup secret in memory and sends it as
    // a bearer header. Legacy desktop asset URLs still carry the query token.
    // Media never inherits the legacy no-token development access branch.
    const startupBearer = request.headers.authorization?.startsWith("Bearer ")
      ? request.headers.authorization.slice("Bearer ".length)
      : null;
    const supplied = Buffer.from(url.searchParams.get("token") ?? startupBearer ?? "");
    const configured = Buffer.from(config.authToken ?? "");
    const desktopTokenAuthorized =
      isLoopbackHost(config.host) &&
      !config.publicUrl &&
      configured.length > 0 &&
      supplied.length === configured.length &&
      timingSafeEqual(supplied, configured);
    const authenticated = desktopTokenAuthorized
      ? null
      : yield* Effect.result(auth.authenticateHttpRequest(makeEffectAuthRequest(request)));
    // Keep this route's CORS headers on auth failures: a trusted cross-origin
    // renderer must read the 401 (signed-out Images) instead of a network error.
    if (authenticated !== null && authenticated._tag === "Failure")
      return authErrorResponse(authenticated.failure, headers);
    const session = authenticated === null ? null : authenticated.success;
    // Account balances, history and paid generation share the existing owner
    // boundary of Moss account/payment RPCs. Paired client access to a thread
    // does not grant direct payment API access or global media history.
    if (session !== null && session.role !== "owner") {
      return json(403, {
        error: {
          code: "owner_authorization_required",
          message: "图像账户与生成任务需要主机所有者权限。",
        },
      });
    }
    const credentialSource = session?.credentialSource ?? "bearer";
    if (
      shouldRejectUntrustedRequestOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
      })
    ) {
      return json(403, { error: { code: "trusted_origin_required" } });
    }
    if (
      request.method !== "GET" &&
      shouldRejectAuthMutationOrigin({
        rawOrigin: request.headers.origin,
        requestOrigin: url.origin,
        config,
        credentialSource,
      })
    )
      return json(403, { error: { code: "trusted_origin_required" } });
    const localCanvasRequest =
      (request.method === "GET" &&
        (url.pathname === PREFIX ||
          url.pathname === "/api/moss/media/history" ||
          /^\/api\/moss\/media\/conversations\/mossconv_[a-f0-9]{32}$/u.test(url.pathname) ||
          /^\/api\/moss\/media\/projects\/((?:thread(?::|%3[Aa]))?[A-Za-z0-9_-]{1,256})\/jobs\/open$/u.test(
            url.pathname,
          ) ||
          /^\/api\/moss\/media\/jobs\/moss_[A-Za-z0-9_-]{1,128}\/canvas-origin$/u.test(
            url.pathname,
          ) ||
          /^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]{1,128}\/[0-9]{1,2}$/u.test(
            url.pathname,
          ) ||
          url.pathname === "/api/moss/media/canvas/account" ||
          /^\/api\/moss\/media\/canvas\/(?:assets\/[a-f0-9]{64}\.(?:png|jpg|webp|gif|avif|mp4|webm|mp3|wav|ogg)|knowledge\/.+)$/u.test(
            url.pathname,
          ))) ||
      (request.method === "POST" &&
        ["/api/moss/media/canvas/storage", "/api/moss/media/canvas/import-job"].includes(
          url.pathname,
        ));
    const cloudResult = localCanvasRequest
      ? null
      : yield* Effect.result(resolveMossMediaCredential);
    const result = cloudResult ?? (yield* Effect.result(resolveMossMediaIdentity));
    if (result._tag === "Failure") {
      if (localCanvasRequest)
        canvasLog.warn("local identity unavailable", {
          httpStatus:
            request.method === "GET" &&
            (url.pathname === "/api/moss/media/canvas/account" || url.pathname === PREFIX)
              ? 200
              : 401,
          authorityStatus: 401,
          errorCode:
            result.failure instanceof MossMediaJobsError
              ? result.failure.code
              : "account_recovery_required",
        });
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/account")
        return json(200, { authenticated: false, user: null, authority: "moss-desktop-database" });
      if (request.method === "GET" && url.pathname === PREFIX) {
        return json(200, {
          account: null,
          models: [],
          jobs: [],
          nextCursor: null,
          errorCode: "authentication_required",
        });
      }
      return json(401, {
        error: { code: "authentication_required", message: "请先登录 Moss 账号。" },
      });
    }
    const installed =
      url.pathname === PREFIX ? yield* Effect.result(installedMossMediaModels) : null;
    const credential = {
      ...result.success,
      ...(installed?._tag === "Success" ? { installedModelIds: installed.success } : {}),
    };
    const cloudCredential =
      cloudResult?._tag === "Success"
        ? {
            ...cloudResult.success,
            ...(installed?._tag === "Success" ? { installedModelIds: installed.success } : {}),
          }
        : null;
    const requireCloudCredential = () =>
      cloudCredential
        ? Effect.succeed(cloudCredential)
        : Effect.gen(function* () {
            const current = yield* resolveMossMediaCredential;
            if (
              current.account.id !== credential.account.id ||
              current.realm !== credential.realm ||
              current.gatewayBaseUrl !== credential.gatewayBaseUrl
            )
              return yield* Effect.fail(new MossMediaJobsError("account_changed", 409));
            return {
              ...current,
              ...(installed?._tag === "Success" ? { installedModelIds: installed.success } : {}),
            };
          });
    const service = mossMediaJobsServiceFor(config.stateDir);
    return yield* Effect.gen(function* () {
      const workspaceThread =
        url.pathname.startsWith("/api/moss/media/canvas/") ||
        (url.pathname === PREFIX && request.method === "POST")
          ? url.searchParams.get("canvasThread")
          : null;
      if (workspaceThread !== null && url.searchParams.getAll("canvasThread").length !== 1)
        return json(400, { error: { code: "invalid_canvas_thread" } });
      const canvasWorkspace =
        workspaceThread !== null ? yield* resolveMossCanvasWorkspace(workspaceThread) : null;
      const canvasWorkspaceFingerprint = canvasWorkspace
        ? mossCanvasWorkspaceFingerprint(canvasWorkspace)
        : null;
      const matchesWorkspace = (input: Record<string, unknown>) => {
        if (!canvasWorkspace) return true;
        const expected = input.expectedWorkspace;
        return (
          !!expected &&
          typeof expected === "object" &&
          "threadId" in expected &&
          "fingerprint" in expected &&
          expected.threadId === canvasWorkspace.threadId &&
          expected.fingerprint === canvasWorkspaceFingerprint
        );
      };
      const currentAccount = () =>
        Effect.gen(function* () {
          const current: MossLocalAccountAuthority = yield* localCanvasRequest
            ? resolveMossMediaIdentity
            : resolveMossMediaCredential;
          if (
            current.account.id !== credential.account.id ||
            current.realm !== credential.realm ||
            current.gatewayBaseUrl !== credential.gatewayBaseUrl
          )
            return yield* Effect.fail(new MossMediaJobsError("account_changed", 409));
          if (canvasWorkspace) {
            const currentWorkspace = yield* resolveMossCanvasWorkspace(canvasWorkspace.threadId);
            if (mossCanvasWorkspaceFingerprint(currentWorkspace) !== canvasWorkspaceFingerprint)
              return yield* Effect.fail(new MossMediaJobsError("canvas_workspace_changed", 409));
          }
          return current;
        });
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/text/models") {
        const credential = yield* requireCloudCredential();
        const models = yield* Effect.tryPromise({
          try: () => mossCanvasTextModels(credential),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(200, { models });
      }
      if (request.method === "POST" && url.pathname === "/api/moss/media/canvas/text/completions") {
        const credential = yield* requireCloudCredential();
        const raw: unknown = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(1024 * 1024)),
          Effect.mapError(() => new MossMediaJobsError("canvas_text_request_invalid", 400)),
        );
        if (!raw || typeof raw !== "object" || Array.isArray(raw))
          return json(400, { error: { code: "canvas_text_request_invalid" } });
        const input = raw as Record<string, unknown>;
        if (!matchesWorkspace(input))
          return json(409, { error: { code: "canvas_workspace_changed" } });
        const expected = input.expectedAccount;
        if (
          !expected ||
          typeof expected !== "object" ||
          !("id" in expected) ||
          !("realm" in expected) ||
          expected.id !== credential.account.id ||
          expected.realm !== credential.realm
        )
          return json(409, { error: { code: "account_changed" } });
        const models = yield* Effect.tryPromise({
          try: () => mossCanvasTextModels(credential),
          catch: (error) => error,
        });
        yield* currentAccount();
        const response = yield* Effect.tryPromise({
          try: () => relayMossCanvasText(input, credential, models),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(response.status, response.body);
      }
      const canvasAssetMatch = url.pathname.match(
        /^\/api\/moss\/media\/canvas\/assets\/([a-f0-9]{64}\.(?:png|jpg|webp|gif|avif|mp4|webm|mp3|wav|ogg))$/u,
      );
      if (url.pathname === "/api/moss/media/canvas/import-job" && request.method === "POST") {
        const body = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(8192)),
          Effect.mapError(() => new MossMediaJobsError("invalid_request")),
        );
        if (
          !canvasWorkspace ||
          !body ||
          typeof body !== "object" ||
          Array.isArray(body) ||
          !matchesWorkspace(body as Record<string, unknown>)
        )
          return json(409, { error: { code: "canvas_workspace_changed" } });
        const input = body as Record<string, unknown>;
        const expected = input.expectedAccount;
        if (
          !expected ||
          typeof expected !== "object" ||
          !("id" in expected) ||
          !("realm" in expected) ||
          expected.id !== credential.account.id ||
          expected.realm !== credential.realm
        )
          return json(409, { error: { code: "account_changed" } });
        if (typeof input.jobId !== "string" || !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(input.jobId))
          return json(400, { error: { code: "invalid_request" } });
        const services = yield* Effect.services<
          MossPhoneAccountService | MossCloudAccountService | MossEnterpriseKeyAccount
        >();
        const authorize = () =>
          Effect.runPromise(Effect.provideServices(currentAccount().pipe(Effect.asVoid), services));
        const output = yield* Effect.tryPromise({
          try: () =>
            service.importCanvasJob(input.jobId as string, credential, canvasWorkspace, authorize),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(200, output);
      }
      const canvasKnowledgeMatch = url.pathname.match(
        /^\/api\/moss\/media\/canvas\/knowledge\/(.+)$/u,
      );
      const canvasRpc =
        url.pathname === "/api/moss/media/canvas/storage" && request.method === "POST";
      if (canvasRpc || ((canvasAssetMatch || canvasKnowledgeMatch) && request.method === "GET")) {
        if (canvasAssetMatch || canvasKnowledgeMatch) {
          if (
            canvasWorkspace &&
            url.searchParams.get("canvasWorkspace") !== canvasWorkspaceFingerprint
          )
            return json(409, { error: { code: "canvas_workspace_changed" } });
          if (
            url.searchParams.get("canvasAccount") !== credential.account.id ||
            url.searchParams.get("canvasRealm") !== credential.realm
          )
            return json(409, { error: { code: "account_changed" } });
          const store = yield* Effect.tryPromise({
            try: () => mossCanvasStorageFor(config.stateDir, credential, canvasWorkspace),
            catch: (error) => error,
          });
          const asset = yield* Effect.tryPromise({
            try: () =>
              canvasAssetMatch
                ? store.readAsset(canvasAssetMatch[1]!)
                : store.readKnowledgeAsset(decodeURIComponent(canvasKnowledgeMatch![1]!)),
            catch: () => new MossMediaJobsError("canvas_asset_not_found", 404),
          });
          yield* currentAccount();
          return HttpServerResponse.uint8Array(asset.bytes, {
            status: 200,
            contentType: asset.contentType,
            headers,
          });
        }
        const body: unknown = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(192 * 1024 * 1024)),
          Effect.mapError(() => new MossMediaJobsError("canvas_request_invalid")),
        );
        if (!body || typeof body !== "object" || Array.isArray(body))
          return json(400, { error: { code: "canvas_request_invalid" } });
        const input = body as Record<string, unknown>;
        if (typeof input.method === "string" && input.method.startsWith("host.sync"))
          return json(403, { error: { code: "canvas_host_operation_required" } });
        const expectedWorkspace = input.expectedWorkspace;
        if (
          canvasWorkspace &&
          (!expectedWorkspace ||
            typeof expectedWorkspace !== "object" ||
            !("threadId" in expectedWorkspace) ||
            !("fingerprint" in expectedWorkspace) ||
            expectedWorkspace.threadId !== canvasWorkspace.threadId ||
            expectedWorkspace.fingerprint !== canvasWorkspaceFingerprint)
        )
          return json(409, { error: { code: "canvas_workspace_changed" } });
        const expected = input.expectedAccount;
        if (
          !expected ||
          typeof expected !== "object" ||
          !("id" in expected) ||
          !("realm" in expected) ||
          expected.id !== credential.account.id ||
          expected.realm !== credential.realm
        )
          return json(409, { error: { code: "account_changed" } });
        if (
          typeof input.method !== "string" ||
          (input.input !== undefined &&
            (!input.input || typeof input.input !== "object" || Array.isArray(input.input)))
        )
          return json(400, { error: { code: "canvas_request_invalid" } });
        yield* currentAccount();
        const args = (input.input ?? {}) as Record<string, unknown>;
        if (input.method === "host.providers" || input.method === "host.providerTest") {
          const credential = yield* requireCloudCredential();
          const installedIds = yield* installedMossMediaModels;
          const models = yield* Effect.tryPromise({
            try: () => service.catalog({ ...credential, installedModelIds: installedIds }),
            catch: (error) => error,
          });
          yield* currentAccount();
          return json(200, {
            result:
              input.method === "host.providerTest"
                ? {
                    ok: true,
                    providerId: "moss",
                    status: "available",
                    apiReachable: true,
                    authenticated: true,
                    modelCount: models.filter((model) => model.available).length,
                  }
                : {
                    version: 1,
                    updatedAt: new Date().toISOString(),
                    activeProviderId: "moss",
                    providersPath: "",
                    credentialStore: "moss-account",
                    providers: [
                      {
                        id: "moss",
                        name: "Moss",
                        kind: "moss",
                        enabled: true,
                        baseUrl: "",
                        credentialRef: "",
                        hasCredential: true,
                        modelIds: models
                          .filter((model) => model.available && model.installed)
                          .map((model) => model.id),
                        capabilities: ["image", "video"],
                      },
                    ],
                    models,
                  },
          });
        }
        const store = yield* Effect.tryPromise({
          try: () => mossCanvasStorageFor(config.stateDir, credential, canvasWorkspace),
          catch: (error) => error,
        });
        yield* currentAccount();
        const output = yield* Effect.tryPromise({
          try: () =>
            input.method === "workspace.cacheRemoteAsset"
              ? cacheMossCanvasRemoteAsset(store, args, (jobId, index) =>
                  service.readAsset(jobId, index, credential),
                )
              : store.request(input.method as string, args),
          catch: (error) =>
            new MossMediaJobsError(
              error &&
                typeof error === "object" &&
                "code" in error &&
                typeof error.code === "string"
                ? error.code
                : "canvas_storage_failed",
              error &&
                typeof error === "object" &&
                "statusCode" in error &&
                error.statusCode === 409
                ? 409
                : error &&
                    typeof error === "object" &&
                    "code" in error &&
                    error.code === "canvas_method_unavailable"
                  ? 404
                  : 400,
            ),
        });
        yield* currentAccount();
        return json(200, { result: output });
      }
      const segmentJob = url.pathname.match(
        /^\/api\/moss\/media\/canvas\/segments\/jobs\/(seg_[A-Za-z0-9_-]{16,96})$/u,
      );
      const segmentMask = url.pathname.match(
        /^\/api\/moss\/media\/canvas\/segments\/masks\/([A-Za-z0-9_-]{1,128})$/u,
      );
      const canvasMutation =
        [
          "/api/moss/media/canvas/assets/promote",
          "/api/moss/media/canvas/segments",
          "/api/moss/media/canvas/media-generation/authorize",
        ].includes(url.pathname) && request.method === "POST";
      if (canvasMutation || ((segmentJob || segmentMask) && request.method === "GET")) {
        const credential = yield* requireCloudCredential();
        let raw: Record<string, unknown> = {};
        if (canvasMutation) {
          const body: unknown = yield* request.json.pipe(
            Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(8 * 1024 * 1024)),
            Effect.mapError(() => new MossMediaJobsError("canvas_request_invalid")),
          );
          if (!body || typeof body !== "object" || Array.isArray(body))
            return json(400, { error: { code: "canvas_request_invalid" } });
          raw = body as Record<string, unknown>;
          const expected = raw.expectedAccount;
          if (
            !expected ||
            typeof expected !== "object" ||
            !("id" in expected) ||
            !("realm" in expected) ||
            expected.id !== credential.account.id ||
            expected.realm !== credential.realm
          )
            return json(409, { error: { code: "account_changed" } });
        }
        yield* currentAccount();
        if (url.pathname.endsWith("/assets/promote")) {
          if ("assetName" in raw && (!canvasWorkspace || !matchesWorkspace(raw)))
            return json(409, { error: { code: "canvas_workspace_changed" } });
          const store =
            "assetName" in raw && canvasWorkspace
              ? yield* Effect.tryPromise({
                  try: () => mossCanvasStorageFor(config.stateDir, credential, canvasWorkspace),
                  catch: (error) => error,
                })
              : null;
          yield* currentAccount();
          const response = yield* Effect.tryPromise({
            try: () =>
              store && canvasWorkspace && canvasWorkspaceFingerprint
                ? promoteMossCanvasOwnedMediaAsset(
                    raw,
                    credential,
                    {
                      threadId: canvasWorkspace.threadId,
                      fingerprint: canvasWorkspaceFingerprint,
                    },
                    (name) => store.readAsset(name),
                  )
                : promoteMossCanvasAsset(raw, credential),
            catch: (error) =>
              error instanceof MossMediaJobsError
                ? error
                : new MossMediaJobsError("canvas_asset_upload_transport_failed", 503),
          });
          const body = yield* Effect.tryPromise({
            try: () => response.json(),
            catch: () => new MossMediaJobsError("canvas_asset_upload_invalid_response", 502),
          });
          yield* currentAccount();
          return json(response.status, body);
        }
        const broker = canvasSegmentsFor(config.stateDir);
        const result = yield* Effect.tryPromise({
          try: async () => {
            if (url.pathname.endsWith("/media-generation/authorize"))
              return { status: 200, body: broker.authorize(raw, credential) };
            if (segmentJob)
              return {
                status: 200,
                body: await broker.status(
                  segmentJob[1]!,
                  Object.fromEntries(url.searchParams),
                  credential,
                ),
              };
            if (segmentMask)
              return {
                status: 200,
                body: broker.mask(
                  segmentMask[1]!,
                  url.searchParams.get("jobId") ?? "",
                  Object.fromEntries(url.searchParams),
                  credential,
                ),
              };
            return raw.cachedOnly === true
              ? { status: 200, body: broker.cacheOnly(raw, credential) }
              : broker.create(raw, credential);
          },
          catch: (error) =>
            error instanceof HoolaCanvasSegmentsBridgeError
              ? new MossMediaJobsError(error.code, error.status)
              : new MossMediaJobsError("canvas_segment_request_failed", 503),
        });
        yield* currentAccount();
        return json(result.status, result.body);
      }
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/quota") {
        const pay = yield* MossPayService;
        const quota = yield* pay.getQuota();
        yield* currentAccount();
        return json(200, quota);
      }
      if (request.method === "GET" && url.pathname === "/api/moss/media/canvas/account") {
        // Local Canvas identity and storage must remain available independently
        // of the cloud billing API. Quota is authoritative only at /quota.
        const identity = yield* currentAccount();
        return json(200, {
          authenticated: true,
          ...(canvasWorkspace
            ? {
                workspace: {
                  threadId: canvasWorkspace.threadId,
                  title: canvasWorkspace.title,
                  fingerprint: canvasWorkspaceFingerprint,
                },
              }
            : {}),
          authority: "moss-desktop-database",
          realm: identity.realm,
          user: {
            id: identity.account.id,
            name: identity.displayName ?? "Moss 用户",
            phone: identity.phoneNumber ?? "",
          },
        });
      }
      const openProjectMatch = url.pathname.match(
        /^\/api\/moss\/media\/projects\/((?:thread(?::|%3[Aa]))?[A-Za-z0-9_-]{1,256})\/jobs\/open$/u,
      );
      if (request.method === "GET" && openProjectMatch) {
        const listing = yield* Effect.tryPromise({
          try: () => service.open(decodeURIComponent(openProjectMatch[1]!), credential),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(200, listing);
      }
      const conversationMatch = url.pathname.match(
        /^\/api\/moss\/media\/conversations\/(mossconv_[a-f0-9]{32})$/u,
      );
      if (
        request.method === "GET" &&
        (url.pathname === "/api/moss/media/history" || conversationMatch)
      ) {
        const listing = yield* Effect.tryPromise({
          try: () =>
            conversationMatch
              ? service.conversation(conversationMatch[1]!, credential, historyInput(url))
              : service.history(credential, historyInput(url)),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(200, listing);
      }
      if (url.pathname === PREFIX && request.method === "GET") {
        const authority = yield* Effect.result(requireCloudCredential());
        if (authority._tag === "Failure") {
          const listing = yield* Effect.tryPromise({
            try: () => service.history(credential),
            catch: (error) => error,
          });
          yield* currentAccount();
          return json(200, {
            ...listing,
            models: [],
            errorCode: "authentication_service_unavailable",
          });
        }
        const paidCredential = authority.success;
        const listing = yield* Effect.tryPromise({
          try: async () =>
            installed?._tag === "Failure"
              ? {
                  ...(await service.history(credential)),
                  models: [],
                  errorCode: "media_plugin_discovery_unavailable",
                }
              : service.list(paidCredential),
          catch: (error) => error,
        });
        yield* currentAccount();
        return json(200, listing);
      }
      if (url.pathname === PREFIX && request.method === "POST") {
        const credential = yield* requireCloudCredential();
        if (installed?._tag === "Failure")
          return json(503, { error: { code: "media_plugin_discovery_unavailable" } });
        const body = yield* request.json.pipe(
          Effect.provideService(HttpServerRequest.MaxBodySize, FileSystem.Size(8 * 1024 * 1024)),
          Effect.mapError(
            (error) =>
              new MossMediaJobsError(
                Cause.isExceededCapacityError(error) ? "request_too_large" : "invalid_request",
                Cause.isExceededCapacityError(error) ? 413 : 400,
              ),
          ),
        );
        if (
          canvasWorkspace &&
          (!body ||
            typeof body !== "object" ||
            Array.isArray(body) ||
            !matchesWorkspace(body as Record<string, unknown>) ||
            (body as Record<string, unknown>).projectId !== `thread:${canvasWorkspace.threadId}`)
        )
          return json(409, { error: { code: "canvas_workspace_changed" } });
        const services = yield* Effect.services<
          MossPhoneAccountService | MossCloudAccountService | MossEnterpriseKeyAccount
        >();
        const authorize = async () => {
          await Effect.runPromise(Effect.provideServices(currentAccount(), services));
        };
        return json(
          202,
          yield* Effect.tryPromise({
            try: () => service.create(body, credential, authorize, canvasWorkspace?.cwd),
            catch: (error) => error,
          }),
        );
      }
      const originMatch = url.pathname.match(
        /^\/api\/moss\/media\/jobs\/(moss_[A-Za-z0-9_-]{1,128})\/canvas-origin$/u,
      );
      if (originMatch && request.method === "GET") {
        const origin = yield* Effect.tryPromise({
          try: () => service.readOwnedCanvasOrigin(originMatch[1]!, credential),
          catch: (error) =>
            error instanceof MossMediaJobsError && error.code === "canvas_workspace_binding_invalid"
              ? new MossMediaJobsError("canvas_origin_unavailable", 409)
              : error,
        });
        const currentOrigin = () =>
          Effect.gen(function* () {
            if (!origin) return;
            const current = yield* resolveMossCanvasWorkspace(origin.threadId);
            if (mossCanvasWorkspaceFingerprint(current) !== mossCanvasWorkspaceFingerprint(origin))
              return yield* Effect.fail(new MossMediaJobsError("canvas_workspace_changed", 409));
          }).pipe(Effect.mapError(() => new MossMediaJobsError("canvas_origin_unavailable", 409)));
        yield* currentOrigin();
        yield* currentAccount();
        yield* currentOrigin();
        yield* currentAccount();
        return json(200, {
          account: { id: credential.account.id, realm: credential.account.realm },
          threadId: origin?.threadId ?? null,
        });
      }
      const match = url.pathname.match(/^\/api\/moss\/media\/jobs\/(moss_[A-Za-z0-9_-]{1,128})$/u);
      if (match && request.method === "GET") {
        const credential = yield* requireCloudCredential();
        const job = yield* Effect.tryPromise({
          try: () => service.check(match[1]!, credential),
          catch: (error) => error,
        });
        const current = yield* resolveMossMediaCredential;
        if (
          current.account.id !== credential.account.id ||
          current.realm !== credential.realm ||
          current.gatewayBaseUrl !== credential.gatewayBaseUrl
        )
          return json(409, { error: { code: "account_changed" } });
        return json(200, job);
      }
      const assetMatch = url.pathname.match(
        /^\/api\/moss\/media\/assets\/(moss_[A-Za-z0-9_-]{1,128})\/([0-9]{1,2})$/u,
      );
      if (assetMatch && request.method === "GET") {
        const result = yield* Effect.tryPromise({
          try: () => service.readAsset(assetMatch[1]!, Number(assetMatch[2]), credential),
          catch: (error) => error,
        });
        yield* currentAccount();
        return HttpServerResponse.uint8Array(result.bytes, {
          status: 200,
          contentType: result.asset.contentType,
          headers: {
            ...headers,
            "Content-Disposition": `attachment; filename="${result.asset.assetId}.${result.asset.contentType.split("/")[1]}"`,
          },
        });
      }
      return json(404, { error: { code: "route_not_found" } });
    }).pipe(
      Effect.catch((error) => {
        const code =
          error instanceof MossMediaJobsError || error instanceof MediaHistoryError
            ? error.code
            : error instanceof Error &&
                [
                  "idempotency_conflict",
                  "unsupported_model",
                  "invalid_request",
                  "invalid_conversation",
                  "job_capacity_exceeded",
                ].includes(error.message)
              ? error.message
              : "media_request_failed";
        const status =
          error instanceof MossMediaJobsError || error instanceof MediaHistoryError
            ? error.status
            : code === "idempotency_conflict"
              ? 409
              : code === "job_capacity_exceeded"
                ? 429
                : code === "invalid_request" ||
                    code === "unsupported_model" ||
                    code === "invalid_conversation"
                  ? 400
                  : 503;
        if (localCanvasRequest)
          canvasLog.warn("local request failed", {
            operation:
              url.pathname === "/api/moss/media/canvas/storage"
                ? "storage"
                : url.pathname.endsWith("/import-job")
                  ? "import-job"
                  : url.pathname.endsWith("/canvas/account")
                    ? "identity"
                    : "history-or-asset",
            httpStatus: status,
            errorCode: code,
            realm: credential.realm,
          });
        return Effect.succeed(
          json(status, { error: { code, message: "图像请求未完成，请查看账号或稍后重试。" } }),
        );
      }),
    );
  }),
);
