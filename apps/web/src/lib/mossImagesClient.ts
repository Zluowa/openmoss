// Account-bound media jobs. The desktop server owns credentials, billing and persistence.
import { resolveWsHttpUrl } from "./wsHttpUrl";
import { isMediaNanoAmount } from "./mossMediaMoney";

export interface MossImageModel {
  readonly id: string;
  readonly label: string;
  readonly kind: "image" | "video";
  readonly installed: boolean;
  readonly available: boolean;
  readonly supportsReferences?: boolean;
  readonly supportsMaskEdits?: boolean;
  readonly supportsTransparentBackground?: boolean;
  readonly unavailableReason?: string;
  readonly priceLabel?: string;
}

export interface MossImageAsset {
  readonly assetId: string;
  readonly index: number;
  readonly kind: "image" | "video";
  readonly contentType: string;
  readonly byteLength: number;
  readonly downloadPath: string;
}

export interface MossImageJob {
  readonly jobId: string;
  readonly revision?: number;
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
  readonly modelId: string;
  readonly imageUrls: readonly string[];
  readonly operation?: "text_to_image" | "image_to_image" | "image_edit" | "video";
  readonly videoUrls?: readonly string[];
  readonly billingStatus: "pending" | "captured" | "released" | "exempt" | "unknown";
  readonly persistenceStatus?: "pending" | "ready" | "failed";
  readonly assets?: readonly MossImageAsset[];
  readonly errorCode?: string;
  readonly errorMessage?: string;
  readonly billing?: {
    readonly walletKind?: "package_cost_v1" | "media_cost_v1" | "legacy_credit_v2";
    readonly reservedNanoCny?: string;
    readonly chargedNanoCny?: string;
    readonly fxVersion?: string;
    readonly creditsReserved?: number;
    readonly creditsCharged?: number;
    readonly priceVersion?: string;
    readonly actualCostNano?: number;
    readonly currency?: "USD" | "CNY";
    readonly nanoPerCredit?: number;
    readonly roundingNano?: number;
  };
}

export interface MossImagesCatalog {
  readonly mediaWallet?: {
    readonly walletKind: "media_cost_v1";
    readonly currency: "CNY";
    readonly pointsPerCny: 100;
    readonly availableNanoCny: string;
    readonly heldNanoCny: string;
    readonly reviewRequired?: boolean;
  };
  readonly account: {
    readonly id: string;
    readonly realm: string;
    readonly creditBalance?: number;
  } | null;
  readonly models: readonly MossImageModel[];
  readonly jobs: readonly MossImageJob[];
  /** Present on servers with durable, paginated image history. */
  readonly nextCursor?: string | null;
  readonly errorCode?: string;
}

export interface MossImagesGenerateRequest {
  readonly prompt: string;
  readonly modelId: string;
  readonly referenceImages?: readonly string[];
  readonly maskImage?: string;
  readonly background?: "auto" | "opaque" | "transparent";
  readonly outputFormat?: "png" | "jpeg" | "webp";
  readonly aspectRatio?: string;
  readonly idempotencyKey: string;
  readonly conversationId?: string;
  readonly parentJobId?: string;
  readonly expectedAccount?: { readonly id: string; readonly realm: string };
  readonly workspace?: MossImagesWorkspaceBinding;
}

export interface MossImagesWorkspaceBinding {
  readonly threadId: string;
  readonly fingerprint: string;
}

/** Only the account-scoped server binding identifies a historical image's Canvas. */
export async function loadMossImagesCanvasOrigin(
  jobId: string,
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<{ account: { id: string; realm: string }; threadId: string | null }> {
  if (!/^moss_[A-Za-z0-9_-]{1,128}$/u.test(jobId))
    throw new MossImagesError("图像记录无效，请重新打开。", "invalid_canvas_origin_request");
  const value = await readJson(
    `/api/moss/media/jobs/${encodeURIComponent(jobId)}/canvas-origin`,
    { method: "GET", ...(signal ? { signal } : {}) },
    fetchImpl,
  );
  signal?.throwIfAborted();
  if (
    !isRecord(value) ||
    !isRecord(value.account) ||
    typeof value.account.id !== "string" ||
    !value.account.id ||
    value.account.id.length > 256 ||
    typeof value.account.realm !== "string" ||
    !value.account.realm ||
    value.account.realm.length > 128 ||
    !(
      value.threadId === null ||
      (typeof value.threadId === "string" && /^[A-Za-z0-9_-]{1,128}$/u.test(value.threadId))
    )
  )
    throw new MossImagesError(
      "无法确认图像原会话，请刷新后重试。",
      "invalid_canvas_origin_response",
    );
  return {
    account: { id: value.account.id, realm: value.account.realm },
    threadId: value.threadId,
  };
}

/** Resolve the selected conversation folder at the trusted server; never accept a renderer path. */
export async function loadMossImagesWorkspaceBinding(
  threadId: string,
  expectedAccount: { readonly id: string; readonly realm: string },
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImagesWorkspaceBinding> {
  if (!/^[A-Za-z0-9_-]{1,128}$/u.test(threadId))
    throw new MossImagesError("会话的工作文件夹尚未就绪。", "invalid_canvas_thread");
  const body = await readJson(
    `/api/moss/media/canvas/account?canvasThread=${encodeURIComponent(threadId)}`,
    { method: "GET", ...(signal ? { signal } : {}) },
    fetchImpl,
  );
  if (
    !isRecord(body) ||
    body.authenticated !== true ||
    !isRecord(body.user) ||
    body.user.id !== expectedAccount.id ||
    body.realm !== expectedAccount.realm
  )
    throw new MossImagesError("账号已变化，请刷新图像页面。", "media_account_changed");
  const workspace = body.workspace;
  if (
    !isRecord(workspace) ||
    workspace.threadId !== threadId ||
    typeof workspace.fingerprint !== "string" ||
    !/^[a-f0-9]{64}$/u.test(workspace.fingerprint)
  )
    throw new MossImagesError("会话的工作文件夹尚未就绪。", "canvas_workspace_unavailable");
  return { threadId, fingerprint: workspace.fingerprint };
}

export class MossImagesError extends Error {
  constructor(
    message: string,
    readonly code: string,
    readonly status = 0,
  ) {
    super(message);
    this.name = "MossImagesError";
  }
}

type ImagesFetch = (input: string, init: RequestInit) => Promise<Response>;
const JOBS_PATH = "/api/moss/media/jobs";
const MAX_WAIT_MS = 35 * 60_000;
export const MAX_IMAGE_REFERENCE_BYTES = 4 * 1024 * 1024;
export const MAX_IMAGE_REFERENCES = 4;
export const MAX_TOTAL_REFERENCE_BYTES = 5 * 1024 * 1024;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function isMossImageOutputUrl(value: unknown): value is string {
  if (typeof value !== "string") return false;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && !url.username && !url.password;
  } catch {
    return false;
  }
}

function isMossImageAsset(value: unknown, jobId: string): value is MossImageAsset {
  if (!isRecord(value)) return false;
  return (
    typeof value.assetId === "string" &&
    /^[a-f0-9]{64}$/u.test(value.assetId) &&
    typeof value.index === "number" &&
    Number.isInteger(value.index) &&
    value.index >= 0 &&
    value.index < 32 &&
    (value.kind === "image" || value.kind === "video") &&
    typeof value.contentType === "string" &&
    ["image/png", "image/jpeg", "image/webp", "image/avif", "video/mp4", "video/webm"].includes(
      value.contentType,
    ) &&
    value.contentType.startsWith(`${value.kind}/`) &&
    typeof value.byteLength === "number" &&
    Number.isSafeInteger(value.byteLength) &&
    value.byteLength > 0 &&
    value.byteLength <= (value.kind === "image" ? 32 : 128) * 1024 * 1024 &&
    value.downloadPath === `/api/moss/media/assets/${jobId}/${value.index}`
  );
}

export function mossImagePreviewSource(job: MossImageJob, index: number): string {
  const asset = job.assets?.find((item) => item.kind === "image" && item.index === index);
  return asset ? resolveWsHttpUrl(asset.downloadPath) : (job.imageUrls[index] ?? "");
}

export function isMossImageJob(value: unknown): value is MossImageJob {
  if (!isRecord(value)) return false;
  return (
    typeof value.jobId === "string" &&
    /^moss_[A-Za-z0-9_-]+$/.test(value.jobId) &&
    (value.revision === undefined ||
      (typeof value.revision === "number" &&
        Number.isSafeInteger(value.revision) &&
        value.revision >= 0)) &&
    (value.conversationId === undefined || isConversationId(value.conversationId)) &&
    (value.parentJobId === undefined ||
      value.parentJobId === null ||
      (typeof value.parentJobId === "string" &&
        /^moss_[A-Za-z0-9_-]{1,160}$/.test(value.parentJobId) &&
        value.parentJobId !== value.jobId)) &&
    (value.parentJobId === undefined || value.conversationId !== undefined) &&
    ["queued", "running", "succeeded", "failed_terminal", "reconciliation_required"].includes(
      String(value.status),
    ) &&
    typeof value.prompt === "string" &&
    typeof value.modelId === "string" &&
    typeof value.createdAt === "string" &&
    Number.isFinite(Date.parse(value.createdAt)) &&
    ["pending", "captured", "released", "exempt", "unknown"].includes(
      String(value.billingStatus),
    ) &&
    Array.isArray(value.imageUrls) &&
    value.imageUrls.every(isMossImageOutputUrl) &&
    (value.assets === undefined ||
      (Array.isArray(value.assets) &&
        value.assets.every((asset) => isMossImageAsset(asset, value.jobId as string)))) &&
    (value.persistenceStatus === undefined ||
      ["pending", "ready", "failed"].includes(String(value.persistenceStatus))) &&
    (value.videoUrls === undefined ||
      (Array.isArray(value.videoUrls) && value.videoUrls.every(isMossImageOutputUrl))) &&
    (value.operation === undefined ||
      ["text_to_image", "image_to_image", "image_edit", "video"].includes(
        String(value.operation),
      )) &&
    (value.status !== "succeeded" ||
      (value.operation === "video"
        ? Array.isArray(value.videoUrls) && value.videoUrls.length > 0
        : value.imageUrls.length > 0)) &&
    (value.billing === undefined ||
      (isRecord(value.billing) &&
        [
          "creditsReserved",
          "creditsCharged",
          "actualCostNano",
          "nanoPerCredit",
          "roundingNano",
        ].every(
          (key) =>
            value.billing &&
            isRecord(value.billing) &&
            (value.billing[key] === undefined ||
              (typeof value.billing[key] === "number" &&
                Number.isFinite(value.billing[key]) &&
                value.billing[key] >= 0)),
        ) &&
        (value.billing.walletKind === undefined ||
          value.billing.walletKind === "package_cost_v1" ||
          value.billing.walletKind === "media_cost_v1" ||
          value.billing.walletKind === "legacy_credit_v2") &&
        ["reservedNanoCny", "chargedNanoCny"].every(
          (key) =>
            value.billing &&
            isRecord(value.billing) &&
            (value.billing[key] === undefined || isMediaNanoAmount(value.billing[key])),
        ) &&
        (value.billing.fxVersion === undefined || typeof value.billing.fxVersion === "string") &&
        (value.billing.currency === undefined ||
          value.billing.currency === "USD" ||
          value.billing.currency === "CNY"))) &&
    (value.errorCode === undefined || typeof value.errorCode === "string") &&
    (value.errorMessage === undefined || typeof value.errorMessage === "string")
  );
}

function parseJob(value: unknown): MossImageJob {
  if (!isMossImageJob(value)) {
    throw new MossImagesError("服务返回的图像任务无效，请刷新后重试。", "invalid_job_response");
  }
  return value;
}

function isConversationId(value: unknown): value is string {
  return typeof value === "string" && /^mossconv_[a-f0-9]{32}$/.test(value);
}

function isHistoryCursor(value: unknown): value is string | null {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 4096);
}

export interface MossImagesHistoryPage {
  readonly account: { readonly id: string; readonly realm: string };
  readonly jobs: readonly MossImageJob[];
  readonly nextCursor: string | null;
  readonly conversationId?: string;
}

function parseMossImagesHistory(
  value: unknown,
  input: {
    readonly expectedAccount?: { readonly id: string; readonly realm: string };
    readonly conversationId?: string;
    readonly cursor?: string;
  },
): MossImagesHistoryPage {
  if (
    !isRecord(value) ||
    !isRecord(value.account) ||
    typeof value.account.id !== "string" ||
    !value.account.id ||
    value.account.id.length > 256 ||
    typeof value.account.realm !== "string" ||
    !value.account.realm ||
    value.account.realm.length > 128 ||
    (input.expectedAccount &&
      (value.account.id !== input.expectedAccount.id ||
        value.account.realm !== input.expectedAccount.realm))
  ) {
    throw new MossImagesError(
      "账号已切换，请刷新生成记录。",
      input.expectedAccount ? "media_account_changed" : "invalid_history_response",
    );
  }
  if (
    !Array.isArray(value.jobs) ||
    value.jobs.length > (input.conversationId ? 50 : 24) ||
    !value.jobs.every(
      (job) =>
        isMossImageJob(job) &&
        job.operation !== "video" &&
        isConversationId(job.conversationId) &&
        job.parentJobId !== undefined &&
        (!input.conversationId || job.conversationId === input.conversationId),
    ) ||
    new Set(value.jobs.map((job) => job.jobId)).size !== value.jobs.length ||
    !isHistoryCursor(value.nextCursor) ||
    (input.cursor !== undefined && value.nextCursor === input.cursor) ||
    (input.conversationId !== undefined &&
      (value.conversationId !== input.conversationId || value.kind !== "image"))
  ) {
    throw new MossImagesError("无法读取完整生成记录，请重试。", "invalid_history_response");
  }
  return value as unknown as MossImagesHistoryPage;
}

/** The CLI entry needs local image history, never the supplier model catalog. */
export async function loadMossImagesHome(
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImagesCatalog> {
  try {
    const value = await readJson(
      "/api/moss/media/history?limit=24&kind=image",
      { method: "GET", ...(signal ? { signal } : {}) },
      fetchImpl,
    );
    signal?.throwIfAborted();
    const page = parseMossImagesHistory(value, {});
    return { account: page.account, models: [], jobs: page.jobs, nextCursor: page.nextCursor };
  } catch (error) {
    signal?.throwIfAborted();
    if (
      error instanceof MossImagesError &&
      (error.status === 401 || error.code === "authentication_required")
    )
      return { account: null, models: [], jobs: [], nextCursor: null };
    throw error;
  }
}

/** Reading history never reconciles, retries or creates a supplier task. */
export async function loadMossImagesHistory(
  input: {
    readonly expectedAccount: { readonly id: string; readonly realm: string };
    readonly conversationId?: string;
    readonly cursor?: string;
  },
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImagesHistoryPage> {
  if (
    !input.expectedAccount?.id ||
    !input.expectedAccount.realm ||
    (input.conversationId !== undefined && !isConversationId(input.conversationId)) ||
    (input.cursor !== undefined &&
      (typeof input.cursor !== "string" || !isHistoryCursor(input.cursor)))
  ) {
    throw new MossImagesError("生成记录的地址无效，请重新打开。", "invalid_history_request");
  }
  const query = new URLSearchParams({ limit: input.conversationId ? "50" : "24" });
  if (!input.conversationId) query.set("kind", "image");
  if (input.cursor !== undefined) query.set("cursor", input.cursor);
  const endpoint = input.conversationId
    ? `/api/moss/media/conversations/${encodeURIComponent(input.conversationId)}`
    : "/api/moss/media/history";
  const value = await readJson(
    `${endpoint}?${query}`,
    { method: "GET", ...(signal ? { signal } : {}) },
    fetchImpl,
  );
  signal?.throwIfAborted();
  return parseMossImagesHistory(value, input);
}

function isImageModel(value: unknown): value is MossImageModel {
  return (
    isRecord(value) &&
    typeof value.id === "string" &&
    typeof value.label === "string" &&
    (value.kind === "image" || value.kind === "video") &&
    typeof value.installed === "boolean" &&
    typeof value.available === "boolean" &&
    (value.supportsReferences === undefined || typeof value.supportsReferences === "boolean") &&
    (value.supportsMaskEdits === undefined || typeof value.supportsMaskEdits === "boolean") &&
    (value.supportsTransparentBackground === undefined ||
      typeof value.supportsTransparentBackground === "boolean") &&
    (value.unavailableReason === undefined || typeof value.unavailableReason === "string") &&
    (value.priceLabel === undefined || typeof value.priceLabel === "string")
  );
}

export function describeMossImagesError(error: unknown): string {
  if (error instanceof MossImagesError) {
    if (
      error.code === "canvas_origin_unavailable" ||
      error.code === "canvas_workspace_binding_invalid"
    )
      return "图像原会话或工作文件夹已不可用，请恢复后重新打开。";
    if (error.status === 401 || error.code === "authentication_required")
      return "请先登录 Moss 账号，再生成图像。";
    if (error.code === "media_account_changed")
      return "账号已切换，已刷新图像工作区。请确认账号后重新提交。";
    if (error.code === "media_skill_not_installed")
      return "请在插件市场安装并启用所选模型的官方 Skill。";
    if (["MEDIA_ADMISSION_MAINTENANCE", "PROXY_CAPACITY_EXCEEDED"].includes(error.code))
      return "图像生成暂时不可用。本次尚未提交生成，也未产生费用。";
    if (error.code === "reference_images_not_supported")
      return "所选模型不支持参考图，请更换模型。";
    if (
      error.code === "mask_edits_not_supported" ||
      error.code === "transparent_background_not_supported"
    )
      return "所选模型不支持这项编辑，请选择支持该功能的模型。";
    if (error.code === "invalid_mask_image")
      return "擦除蒙版必须是与原图同尺寸、含透明通道且小于 4 MB 的 PNG。";
    if (error.code === "provider_reference_upload_failed")
      return "参考图上传未完成，尚未提交生成任务。请检查图像后重试。";
    if (error.code === "request_too_large") return "参考图文件过大，请缩小图片后重试。";
    if (error.code === "invalid_history_cursor") return "生成记录的分页已失效，请刷新后重新打开。";
    if (error.code === "conversation_not_found") return "未找到此账号的图像会话，请刷新生成记录。";
    if (error.code === "media_history_unavailable")
      return "此设备的生成记录暂时无法读取，请稍后重试。";
    if (error.code === "invalid_conversation")
      return "原图与当前会话不匹配，请重新打开原图再编辑。";
    if (
      [
        "insufficient_credits",
        "insufficient_media_balance",
        "service_cost_budget_exhausted",
      ].includes(error.code)
    )
      return "套餐额度已用完。";
    if (error.code === "entitlement_required") return "请先开通 Moss 套餐。";
    if (
      ["cost_budget_not_configured", "package_fx_unavailable", "media_fx_unavailable"].includes(
        error.code,
      )
    )
      return "套餐用量暂时无法核对，请稍后再试。";
    if (error.code === "media_generation_not_configured" || error.code === "paid_media_unavailable")
      return "当前账号的图像计费服务尚未开通。";
    return error.message;
  }
  if (error instanceof Error && error.name === "AbortError")
    return "已停止等待。后台任务可能继续运行，可刷新查看结果。";
  return "暂时无法连接图像服务，请刷新任务状态。请勿重复提交尚未确认的任务。";
}

export async function readMossImagesJson(
  path: string,
  init: RequestInit,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<unknown> {
  const response = await fetchImpl(resolveWsHttpUrl(path), {
    ...init,
    credentials: "include",
    signal: init.signal
      ? AbortSignal.any([init.signal, AbortSignal.timeout(30_000)])
      : AbortSignal.timeout(30_000),
    headers: { "content-type": "application/json", ...init.headers },
  });
  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new MossImagesError(
      "图像服务暂时不可用，请稍后刷新。",
      "invalid_response",
      response.status,
    );
  }
  if (!response.ok) {
    const record = isRecord(body) ? body : {};
    const nested = isRecord(record.error) ? record.error : record;
    const serverCode = String(nested.code ?? nested.errorCode ?? `http_${response.status}`);
    const code = serverCode === "account_changed" ? "media_account_changed" : serverCode;
    // Only a server-authored bounded string is surfaced; never render response HTML.
    const message = typeof nested.message === "string" ? nested.message : nested.errorMessage;
    throw new MossImagesError(
      typeof message === "string" ? message.slice(0, 500) : "图像请求未完成，请刷新任务状态。",
      code,
      response.status,
    );
  }
  return body;
}

const readJson = readMossImagesJson;

export async function loadMossImagesCatalog(
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImagesCatalog> {
  const body = await readJson(
    JOBS_PATH,
    { method: "GET", ...(signal ? { signal } : {}) },
    fetchImpl,
  );
  if (
    !isRecord(body) ||
    !Array.isArray(body.models) ||
    !body.models.every(isImageModel) ||
    !Array.isArray(body.jobs) ||
    !body.jobs.every(isMossImageJob) ||
    (body.nextCursor !== undefined && !isHistoryCursor(body.nextCursor)) ||
    !(
      body.mediaWallet === undefined ||
      (isRecord(body.mediaWallet) &&
        body.mediaWallet.walletKind === "media_cost_v1" &&
        body.mediaWallet.currency === "CNY" &&
        body.mediaWallet.pointsPerCny === 100 &&
        isMediaNanoAmount(body.mediaWallet.availableNanoCny) &&
        isMediaNanoAmount(body.mediaWallet.heldNanoCny) &&
        (body.mediaWallet.reviewRequired === undefined ||
          typeof body.mediaWallet.reviewRequired === "boolean"))
    ) ||
    !(
      body.account === null ||
      (isRecord(body.account) &&
        typeof body.account.id === "string" &&
        typeof body.account.realm === "string")
    )
  ) {
    throw new MossImagesError("无法读取当前账号的图像工作区，请刷新。", "invalid_catalog_response");
  }
  const catalog = body as unknown as MossImagesCatalog;
  return { ...catalog, jobs: catalog.jobs.filter((job) => job.operation !== "video") };
}

export async function requestMossImagesGenerate(
  input: MossImagesGenerateRequest,
  signal?: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImageJob> {
  const prompt = input.prompt.trim();
  if (!prompt || prompt.length > 8_000 || !input.modelId || !input.idempotencyKey) {
    throw new MossImagesError("请输入不超过 8,000 字符的图像描述并选择模型。", "invalid_request");
  }
  if (
    (input.conversationId === undefined) !== (input.parentJobId === undefined) ||
    (input.conversationId !== undefined && !isConversationId(input.conversationId)) ||
    (input.parentJobId !== undefined && !/^moss_[A-Za-z0-9_-]{1,160}$/.test(input.parentJobId))
  ) {
    throw new MossImagesError("图像会话已变化，请重新打开原图。", "invalid_conversation_request");
  }
  // Deliberately no automatic POST retry: an interrupted submission may already be billed.
  const { workspace, ...payload } = input;
  if (
    workspace &&
    (!/^[A-Za-z0-9_-]{1,128}$/u.test(workspace.threadId) ||
      !/^[a-f0-9]{64}$/u.test(workspace.fingerprint))
  )
    throw new MossImagesError("会话的工作文件夹已变化，请重新打开。", "canvas_workspace_changed");
  return parseJob(
    await readJson(
      workspace ? `${JOBS_PATH}?canvasThread=${encodeURIComponent(workspace.threadId)}` : JOBS_PATH,
      {
        method: "POST",
        body: JSON.stringify({
          ...payload,
          prompt,
          ...(workspace
            ? { projectId: `thread:${workspace.threadId}`, expectedWorkspace: workspace }
            : {}),
        }),
        ...(signal ? { signal } : {}),
      },
      fetchImpl,
    ),
  );
}

/** Reconcile the original operation without ever re-submitting a paid generation. */
export async function loadMossImageJob(
  jobId: string,
  signal: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<MossImageJob> {
  signal.throwIfAborted();
  const job = parseJob(
    await readJson(
      `${JOBS_PATH}/${encodeURIComponent(jobId)}`,
      { method: "GET", signal },
      fetchImpl,
    ),
  );
  signal.throwIfAborted();
  if (job.jobId !== jobId)
    throw new MossImagesError("图像任务身份发生变化，请刷新。", "job_identity_mismatch");
  return job;
}

function waitForPoll(milliseconds: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const abort = () => {
      clearTimeout(timer);
      reject(new DOMException("Aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", abort);
      resolve();
    }, milliseconds);
    signal.addEventListener("abort", abort, { once: true });
  });
}

export async function waitForMossImageJob(input: {
  readonly job: MossImageJob;
  readonly signal: AbortSignal;
  readonly onUpdate: (job: MossImageJob) => void;
  readonly fetchImpl?: ImagesFetch;
  readonly pollMs?: number;
  readonly timeoutMs?: number;
}): Promise<MossImageJob> {
  let job = input.job;
  const startedAt = Date.now();
  while (job.status === "queued" || job.status === "running") {
    input.signal.throwIfAborted();
    if (Date.now() - startedAt >= (input.timeoutMs ?? MAX_WAIT_MS)) {
      throw new MossImagesError(
        "等待时间较长。任务可能仍在后台运行，请刷新查看，不要重复生成。",
        "observation_timeout",
      );
    }
    await waitForPoll(input.pollMs ?? 5_000, input.signal);
    try {
      const next = await loadMossImageJob(
        job.jobId,
        input.signal,
        input.fetchImpl ?? globalThis.fetch,
      );
      job = next;
      input.onUpdate(job);
    } catch (error) {
      if (error instanceof MossImagesError && (error.status === 429 || error.status >= 500))
        continue;
      throw error;
    }
  }
  return job;
}

export async function readMossImageReference(file: File): Promise<string> {
  if (!["image/png", "image/jpeg", "image/webp"].includes(file.type)) {
    throw new MossImagesError("参考图仅支持 PNG、JPEG 和 WebP。", "invalid_reference_type");
  }
  if (!file.size || file.size > MAX_IMAGE_REFERENCE_BYTES) {
    throw new MossImagesError("单张参考图不能超过 4 MB。", "reference_too_large");
  }
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.addEventListener(
      "load",
      () => {
        if (typeof reader.result === "string") resolve(reader.result);
        else reject(new MossImagesError("无法读取参考图。", "invalid_reference"));
      },
      { once: true },
    );
    reader.addEventListener(
      "error",
      () => reject(new MossImagesError("无法读取参考图。", "invalid_reference")),
      { once: true },
    );
    reader.readAsDataURL(file);
  });
}

/** Edit from the durable account-scoped copy, never a possibly expired supplier URL. */
export async function readMossImageAssetReference(
  asset: MossImageAsset,
  signal: AbortSignal,
  fetchImpl: ImagesFetch = globalThis.fetch,
): Promise<string> {
  if (
    !/^\/api\/moss\/media\/assets\/moss_[A-Za-z0-9_-]+\/[0-9]{1,2}$/u.test(asset.downloadPath) ||
    asset.kind !== "image" ||
    !["image/png", "image/jpeg", "image/webp"].includes(asset.contentType)
  ) {
    throw new MossImagesError(
      "当前图像格式暂不支持继续编辑，请上传 PNG、JPEG 或 WebP。",
      "invalid_reference_type",
    );
  }
  if (asset.byteLength > MAX_IMAGE_REFERENCE_BYTES) {
    throw new MossImagesError("当前原图超过 4 MB，请缩小后作为参考图上传。", "reference_too_large");
  }
  const response = await fetchImpl(resolveWsHttpUrl(asset.downloadPath), {
    method: "GET",
    credentials: "include",
    signal: AbortSignal.any([signal, AbortSignal.timeout(30_000)]),
  });
  if (!response.ok)
    throw new MossImagesError(
      "无法读取已保存的原图，请刷新后重试。",
      "asset_unavailable",
      response.status,
    );
  const contentType = response.headers.get("content-type")?.split(";")[0]?.trim().toLowerCase();
  const length = Number(response.headers.get("content-length") ?? "0");
  if (contentType !== asset.contentType || length > MAX_IMAGE_REFERENCE_BYTES) {
    throw new MossImagesError("保存的图像格式或大小不符合参考图要求。", "invalid_reference");
  }
  const blob = await response.blob();
  signal.throwIfAborted();
  return readMossImageReference(new File([blob], "reference-image", { type: asset.contentType }));
}
