// Only the account/workspace-selected store supplies source bytes. The frame
// cannot select an upload destination, raw path, Storage key or bearer token.
import { createHash } from "node:crypto";
import { MossMediaJobsError, type MossMediaCredential } from "./mossMediaJobsService";

interface PromotionScope {
  readonly threadId: string;
  readonly fingerprint: string;
}

type ReadAsset = (name: string) => Promise<{ bytes: Uint8Array; contentType: string }>;
export type PromotionFetch = (
  input: string | URL | Request,
  init?: RequestInit,
) => Promise<Response>;

const MODELS = new Set([
  "wan3.0-video",
  "wan3.0-video-prime",
  "doubao-seedance-2.5",
  "MiniMax-H3",
  "MiniMax-H3-Max",
  "happyhorse-video-edit",
]);
const INPUT_KEYS = new Set([
  "assetName",
  "modelId",
  "projectId",
  "pageId",
  "idempotencyKey",
  "expectedAccount",
  "expectedWorkspace",
]);
const UPSTREAM_ERRORS = new Set([
  "authentication_required",
  "auth_service_unavailable",
  "account_realm_mismatch",
  "media_storage_not_configured",
  "media_storage_private_bucket_required",
  "media_storage_unavailable",
  "media_storage_invalid_response",
  "media_storage_transport_uncertain",
  "media_storage_busy",
  "media_promotion_read_timeout",
  "media_promotion_invalid",
  "media_promotion_type_unsupported",
  "media_promotion_too_large",
  "media_promotion_size_mismatch",
  "media_promotion_checksum_mismatch",
  "media_promotion_content_invalid",
]);

function record(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

async function readResponse(response: Response): Promise<Record<string, unknown>> {
  const reader = response.body?.getReader();
  if (!reader) throw new MossMediaJobsError("canvas_asset_upload_invalid_response", 502);
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > 32 * 1024) throw new Error("response_too_large");
      chunks.push(value);
    }
    const bytes = Buffer.concat(chunks);
    const parsed: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes));
    if (!record(parsed)) throw new Error("invalid_response");
    return parsed;
  } catch {
    throw new MossMediaJobsError("canvas_asset_upload_invalid_response", 502);
  } finally {
    await reader.cancel().catch(() => undefined);
    reader.releaseLock();
  }
}

export async function promoteMossCanvasOwnedMediaAsset(
  input: Record<string, unknown>,
  credential: MossMediaCredential,
  scope: PromotionScope,
  readAsset: ReadAsset,
  options: {
    readonly fetchImpl?: PromotionFetch;
    readonly now?: () => number;
    readonly expectedStorageOrigin?: string;
  } = {},
): Promise<Response> {
  const account = input.expectedAccount;
  if (
    !record(account) ||
    account.id !== credential.account.id ||
    account.realm !== credential.realm ||
    credential.account.realm !== credential.realm
  )
    throw new MossMediaJobsError("account_changed", 409);
  const workspace = input.expectedWorkspace;
  if (
    !record(workspace) ||
    workspace.threadId !== scope.threadId ||
    workspace.fingerprint !== scope.fingerprint ||
    !/^[A-Za-z0-9_-]{1,128}$/u.test(scope.threadId) ||
    !/^[0-9a-f]{64}$/u.test(scope.fingerprint)
  )
    throw new MossMediaJobsError("canvas_workspace_changed", 409);
  const assetName = input.assetName;
  const modelId = input.modelId;
  const projectId = input.projectId;
  const pageId = input.pageId;
  const operationId = input.idempotencyKey;
  if (
    Object.keys(input).some((key) => !INPUT_KEYS.has(key)) ||
    typeof assetName !== "string" ||
    !/^[0-9a-f]{64}\.(?:mp4|mp3|wav)$/u.test(assetName) ||
    typeof modelId !== "string" ||
    !MODELS.has(modelId) ||
    typeof projectId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(projectId) ||
    typeof pageId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{0,255}$/u.test(pageId) ||
    typeof operationId !== "string" ||
    !/^[A-Za-z0-9][A-Za-z0-9._:-]{7,191}$/u.test(operationId)
  )
    throw new MossMediaJobsError("canvas_asset_invalid", 400);
  let endpoint: URL;
  try {
    const root = new URL(credential.gatewayBaseUrl);
    if (
      root.protocol !== "https:" ||
      root.username ||
      root.password ||
      root.search ||
      root.hash ||
      !credential.accessToken ||
      /\s/u.test(credential.accessToken)
    )
      throw new Error("invalid_gateway");
    endpoint = new URL(
      `${root.href.replace(/\/+$/u, "").replace(/\/v1$/u, "")}/v1/canvas/assets/promote-media`,
    );
  } catch {
    throw new MossMediaJobsError("media_gateway_unavailable", 503);
  }
  // This callback is supplied by the host only after resolving the current
  // account and real workspace. It must never read an arbitrary renderer path.
  const asset = await readAsset(assetName);
  const expectedMime = assetName.endsWith(".mp4")
    ? "video/mp4"
    : assetName.endsWith(".wav")
      ? "audio/wav"
      : "audio/mpeg";
  if (
    asset.contentType !== expectedMime ||
    (modelId === "happyhorse-video-edit" && expectedMime !== "video/mp4") ||
    !asset.bytes.length
  )
    throw new MossMediaJobsError("canvas_asset_invalid", 400);
  if (asset.bytes.length > (expectedMime === "video/mp4" ? 50_000_000 : 15_000_000))
    throw new MossMediaJobsError("canvas_asset_too_large", 413);
  const sha256 = createHash("sha256").update(asset.bytes).digest("hex");
  if (sha256 !== assetName.split(".")[0]) throw new MossMediaJobsError("canvas_asset_corrupt", 422);
  const promotion = Buffer.from(
    JSON.stringify({
      modelId,
      projectId,
      pageId,
      operationId,
      workspaceThreadId: scope.threadId,
      workspaceFingerprint: scope.fingerprint,
      sha256,
      sizeBytes: asset.bytes.length,
    }),
  ).toString("base64url");
  let upstream: Response;
  try {
    upstream = await (options.fetchImpl ?? fetch)(endpoint, {
      method: "POST",
      headers: {
        authorization: `Bearer ${credential.accessToken}`,
        "content-type": expectedMime,
        "x-moss-media-promotion": promotion,
      },
      body: Uint8Array.from(asset.bytes),
      redirect: "error",
      signal: AbortSignal.timeout(90_000),
    });
  } catch {
    throw new MossMediaJobsError("canvas_asset_upload_transport_uncertain", 503);
  }
  const body = await readResponse(upstream);
  if (!upstream.ok) {
    const code =
      typeof body.code === "string" && UPSTREAM_ERRORS.has(body.code)
        ? body.code
        : "canvas_asset_upload_rejected";
    return Response.json(
      { success: false, code, error: { code } },
      {
        status: upstream.status >= 400 && upstream.status <= 599 ? upstream.status : 502,
        headers: { "cache-control": "no-store" },
      },
    );
  }
  let url: URL;
  let storageOrigin: URL;
  try {
    url = new URL(String(body.url));
    storageOrigin = new URL(String(body.storageOrigin));
  } catch {
    throw new MossMediaJobsError("canvas_asset_upload_invalid_response", 502);
  }
  const expiry = typeof body.expiresAt === "string" ? Date.parse(body.expiresAt) : NaN;
  const now = options.now?.() ?? Date.now();
  const objectPath = url.pathname.match(
    /^\/storage\/v1\/object\/sign\/[a-z0-9][a-z0-9._-]{2,62}\/moss-canvas\/v1\/(memfire-phone|supabase-google)\/[0-9a-f]{64}\/([0-9a-f]{64})\.(mp4|mp3|wav)$/u,
  );
  const signedToken = url.searchParams.get("token");
  if (
    body.success !== true ||
    body.status !== "ready" ||
    typeof body.assetId !== "string" ||
    !/^moss_media_[0-9a-f]{64}$/u.test(body.assetId) ||
    body.modelId !== modelId ||
    body.contentType !== expectedMime ||
    body.sizeBytes !== asset.bytes.length ||
    body.checksumSha256 !== sha256 ||
    body.kind !== (expectedMime === "video/mp4" ? "video" : "audio") ||
    body.persistenceStatus !== "temporary" ||
    body.billingStatus !== "exempt" ||
    body.authority !== "moss-desktop-database" ||
    body.metadataVerification !== "bytes-only" ||
    body.objectRetention !== "operator-managed" ||
    body.signedUrlTtlSeconds !== 7_200 ||
    storageOrigin.protocol !== "https:" ||
    storageOrigin.href !== `${storageOrigin.origin}/` ||
    body.storageOrigin !== storageOrigin.origin ||
    url.origin !== storageOrigin.origin ||
    (options.expectedStorageOrigin !== undefined &&
      storageOrigin.origin !== options.expectedStorageOrigin) ||
    url.protocol !== "https:" ||
    url.username ||
    url.password ||
    url.hash ||
    !objectPath ||
    objectPath[1] !== credential.realm ||
    objectPath[2] !== body.assetId.slice("moss_media_".length) ||
    objectPath[3] !== assetName.split(".")[1] ||
    !signedToken ||
    !/^[A-Za-z0-9._-]{16,8192}$/u.test(signedToken) ||
    signedToken.includes(credential.accessToken) ||
    url.searchParams.getAll("token").length !== 1 ||
    [...url.searchParams.keys()].some((key) => key !== "token") ||
    url.href.includes(credential.accessToken) ||
    body.assetUrl !== url.href ||
    !Number.isFinite(expiry) ||
    expiry <= now ||
    expiry > now + 7_500_000
  )
    throw new MossMediaJobsError("canvas_asset_upload_invalid_response", 502);
  // Whitelist the response: no upstream debug field, key, token-bearing header
  // or caller-declared metadata becomes part of the account asset record.
  return Response.json(
    {
      success: true,
      status: "ready",
      assetId: body.assetId,
      url: url.href,
      assetUrl: url.href,
      modelId,
      kind: body.kind,
      contentType: expectedMime,
      sizeBytes: asset.bytes.length,
      checksumSha256: sha256,
      expiresAt: body.expiresAt,
      persistenceStatus: "temporary",
      billingStatus: "exempt",
      authority: "moss-desktop-database",
      metadataVerification: "bytes-only",
      storageOrigin: storageOrigin.origin,
      signedUrlTtlSeconds: 7_200,
      objectRetention: "operator-managed",
    },
    { headers: { "cache-control": "no-store", "x-content-type-options": "nosniff" } },
  );
}
