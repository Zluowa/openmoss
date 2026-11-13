// FILE: threadErrorPresentation.ts
// Purpose: Converts persisted provider failures into safe user-facing text.
// Layer: Chat status presentation
// Exports: resolveThreadErrorPresentation, ThreadErrorPresentation

import {
  MOSS_GATEWAY_SESSION_REJECTED_MESSAGE,
  MOSS_MANAGED_SESSION_RENEWED_MESSAGE,
} from "@moss/shared/mossManagedSession";
import {
  isProviderDeliveryBlockDetail,
  isUnconfirmedTurnStartDetail,
} from "@moss/shared/providerDeliveryBlock";

import type { MossLocaleCode } from "~/appSettings";
import { HERMES_COMPATIBILITY_STATUS } from "~/localization/zhCNProviderStatus";
import { localizeAntigravityRuntimeMessage } from "~/lib/antigravityRuntimeMessages";
import {
  localizeProviderRuntimeMessage,
  normalizeProviderRuntimeMessage,
  PERSONAL_CODEX_USAGE_LIMIT_MESSAGE,
} from "~/lib/providerRuntimeMessages";

export interface ThreadErrorPresentation {
  readonly title: string;
  readonly copyText: string;
  readonly recoveryAction?: "manage-providers";
  /** Historical provider-start failures already have an inline transcript row. */
  readonly surface?: "toast" | "history";
  /**
   * Moss will not send the request again by itself, so offer it: either it never reached
   * the provider, or Moss stopped waiting for a start it could not confirm.
   */
  readonly retryable?: boolean;
  /**
   * Continuing on the same model fails the same way; another model is the next
   * step, so the card offers it first.
   */
  readonly changeModelFirst?: boolean;
}

const RAW_RATE_LIMIT_PATTERN = /(?:\b429\b|too many requests|exceeded retry limit)/iu;
const PACKAGE_COST_QUOTA_PATTERN =
  /(?:\bservice_cost_budget_exhausted\b|\bYour Moss package usage allowance is exhausted\.)/iu;
const RAW_PERIOD_QUOTA_PATTERN =
  /(?:\b(?:request|token)_quota_exhausted\b|\bservice_cost_(?:budget|window)_exhausted\b|\bmoss\s+account\s+(?:five-hour|weekly)\s+usage\s+allowance\s+is\s+exhausted\b|\bquota\s+for\s+this\s+period\s+is\s+exhausted\b|\binsufficient_quota\b|\bexceeded\s+your\s+current\s+quota\b)/iu;
const SAFE_HUMANIZED_PERIOD_QUOTA_PATTERN =
  /^Moss account quota is exhausted for this period\. Top up your plan(?: or wait for the quota to reset|, or try again in about [^.\r\n]+)\.$/iu;
// Codex words its own variant "Timed out waiting for thread/start"; a start can
// also run out of time on the `codex --version` probe before the app-server.
const PROVIDER_START_TIMEOUT_PATTERN =
  /(?:\bprovider\b[^\r\n]*\bdid not finish starting within\s+\d+ms\b|\bprovider turn start failed\b[\s\S]*\btimeout\b|\b(?:thread|turn)\/start\b[\s\S]*\btimeout\b|\btimed out waiting for (?:thread\/(?:start|resume|fork)|turn\/start)\b|\bCodex CLI version check timed out\b)/iu;
// The start deadline names what Codex was still doing when the start had to stop:
// reading its own data folder, the usual sign of a busy or slow disk under it.
const CODEX_DATA_FOLDER_SLOW_PATTERN =
  /\bCodex was still (?:loading|opening the conversation in) its data folder(?: \(([^()\r\n]{1,260})\))? after \d+ s\./u;
// Provider startup wraps these product-owned errors in an Effect/adapter prefix.
// Keep the line-end anchor so arbitrary trailing diagnostics cannot be exposed.
const WORKING_DIRECTORY_NOT_FOUND_PATTERN =
  /(?:Working directory not found: |Project working directory (?:no longer exists|is not a directory): )([^\r\n]{1,1024})$/mu;
const CODEX_WORKING_DIRECTORY_RELOCATE_SUFFIX = /\.\s+Relocate or reconnect the project in Moss\.$/;
const MAX_SAFE_ACTIONABLE_ERROR_LENGTH = 240;
// A gateway older than #319 refuses a byte-identical paid request for 15 minutes, with a status
// object instead of an error. OpenCode shows that object, Pi and Hermes only its status code.
const MOSS_GATEWAY_REPEAT_REFUSED_PATTERN =
  /\bmoss\.operation_status\b|\b409 status code \(no body\)|\bmodel request failed \(HTTP 409\)/iu;
// A current gateway refuses only while the first request runs, and says so in the same object.
const MOSS_GATEWAY_IDENTICAL_REQUEST_RUNNING =
  "An identical request is still running. Retry when it finishes.";
// A stream that dropped partway, in Codex's and MiniMax's own transport words.
const STREAM_DROPPED_PATTERN =
  /\bstream disconnected before completion\b|\bupstream error: terminated\b/iu;
const STREAM_DROPPED_MESSAGE = "The connection to the model service dropped. Try again.";
// An agent process that exited or was killed mid-turn, in each adapter's own words: Claude
// Code (the SDK's text), the Codex app-server, Gemini ACP, OpenCode-style servers, Pi,
// Antigravity, and every ACP agent (Kimi, MiniMax, ZCode and others), whose pending prompt
// fails with the SDK's connection-closed error. Raw exit codes such as 4294967295 mean nothing
// to a person; the copyable details keep them.
const AGENT_PROCESS_EXIT_PATTERN = new RegExp(
  [
    String.raw`\bClaude Code process (?:exited with code -?\d+|terminated by signal \w+)`,
    String.raw`\bcodex app-server exited \(code=`,
    String.raw`\bGemini ACP session exited\b`,
    String.raw`\bserver exited unexpectedly \(`,
    String.raw`\bPi exited \(`,
    String.raw`\bAntigravity CLI exited (?:with code|without a complete result)`,
    String.raw`\b(?:ACP|agent) connection closed\b`,
  ].join("|"),
  "iu",
);
// Codex refuses a Moss-owned account that arrives without the runtime Moss issues
// at sign-in, or whose runtime a Moss sign-out has since revoked. These are
// internal invariant sentences; signing in to Moss again issues a fresh runtime.
const MOSS_MANAGED_RUNTIME_MISSING_PATTERN =
  /\bReserved Codex account '[^'\r\n]*' requires a server-issued runtime generation\b|\bCodex account runtime generation was revoked\b/u;
const MOSS_MANAGED_RUNTIME_MISSING_MESSAGE =
  "Moss's models aren't ready for this chat. Sign in to Moss again, or switch to another provider, then retry.";
// Sentences Moss itself wrote that already say what happened and what to do. Each CLI wraps
// the gateway's differently: Codex in "unexpected status 502 ...: <sentence>, url: ...", Pi in
// "502: {json}", OpenCode bare. Agent startup failures arrive behind adapter and stack text.
const KNOWN_FAILURE_SENTENCES = [
  ...Object.keys(HERMES_COMPATIBILITY_STATUS),
  "The ZCode CLI could not be started. Install the ZCode desktop app (it bundles the CLI) or set ZCODE_BIN to the zcode CLI path, then retry.",
  "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.",
  "Kimi Code is not signed in. Run `kimi login` in a terminal (with the same KIMI_CODE_HOME, if set) and retry.",
  "MiniMax Code is not signed in. Run `mcode login` in a terminal (add --region cn or --region global if needed) and retry.",
  "No ZCode credentials found. Sign in to the ZCode desktop app, or run `zcode-acp setup --provider bigmodel` (or `--provider zai`) to save a GLM Coding Plan key, then retry.",
  "The model service is temporarily unavailable.",
  "The model service timed out.",
  "The model service returned an empty response; the request was not replayed.",
  "The model service credential is temporarily unavailable.",
  "The upstream model service rejected the request.",
  "The upstream provider rejected this request under its access policy.",
  "The upstream provider rejected this request.",
  "The selected model is not available from this region or provider account.",
  "This model is not available for this Moss sign-in method.",
  "The model cannot represent these tool definitions or tool choices.",
  "The model response could not be safely accounted for.",
  "Account quota verification is temporarily unavailable.",
  "Account verification is temporarily unavailable.",
  MOSS_GATEWAY_SESSION_REJECTED_MESSAGE,
  MOSS_MANAGED_SESSION_RENEWED_MESSAGE,
  "A valid Moss account session is required.",
  "This request id is already in use.",
  MOSS_GATEWAY_IDENTICAL_REQUEST_RUNNING,
] as const;
// PiAdapter's sentence for a model whose provider this Pi account has no sign-in for.
const PI_MODEL_SIGN_IN_MISSING_PATTERN =
  /This Pi account has no sign-in for ([^\r\n]{1,120}?)\. Switch to Moss or another model to continue\./u;
// Failures tied to the model itself: the same request on the same model fails again.
const MODEL_BOUND_FAILURE_SENTENCES: ReadonlySet<string> = new Set([
  "The model cannot represent these tool definitions or tool choices.",
  "The selected model is not available from this region or provider account.",
  "This model is not available for this Moss sign-in method.",
]);
const PROVIDER_ADAPTER_REQUEST_FAILED_PREFIX =
  /^Provider adapter request failed \([^)]+\) for [^:]+:\s*/u;
const TASK_INTERRUPTED_PROVIDER_ERROR_PREFIX =
  /^The task was interrupted by a provider error\. Work remains incomplete\.\s*/u;
// A Codex ChatGPT sign-in the service no longer accepts: Codex reports it as
// "workspace routing discovery unauthorized (401)" or the token-refresh verdict.
// Retrying cannot fix it, so the card says what will: signing in again. Other
// CLIs keep their own 401 wording (Grok's names the credential it rejected).
const PROVIDER_SIGN_IN_EXPIRED_PATTERN =
  /(?:\bworkspace routing discovery unauthorized\b|\baccess token could not be refreshed\b|\bprovided authentication token is expired\b|\bplease log out and sign in again\b)/iu;
// Grok-specific wording only: other CLIs report "not signed in" too, and they
// must keep their own message instead of being told to run grok login.
const GROK_LOGIN_REQUIRED_PATTERN =
  /(?:\brun\s+`?grok login`?|\bgrok is not authenticated for headless ACP\b)/iu;
const RAW_DIAGNOSTIC_PATTERN =
  /(?:\bHTTP(?:\/[0-9.]+)?\s+[1-5][0-9]{2}\b|\b(?:last\s+)?status\s*[:=]\s*[1-5][0-9]{2}\b|request[\s_-]*id|trace[\s_-]*id|correlation[\s_-]*id|https?:\/\/|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]|(?:^|[\s("'=])\/(?:Users|home|tmp|private|var|opt|etc|usr|Volumes|workspace|repo|mnt)\/|(?:^|[\s("'=])\.{1,2}\/[^\s]+|[A-Za-z]:\\|\b(?:ECONN[A-Z_]*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|ERR_(?:NETWORK|SOCKET)[A-Z_]*|UND_ERR_[A-Z_]+)\b|\b(?:stderr|stdout|response\s+body|body|payload|stack(?:\s+trace)?)\s*:|\bat\s+(?:new\s+)?[\w.$<>]+\s*\([^\r\n)]+:\d+:\d+\)|[\r\n])/iu;
// HTTP status codes stay showable so auth cards keep their actionable text, but
// socket and DNS error codes are transport noise and still fall back to the
// generic message.
const REMAINING_UNSAFE_DIAGNOSTIC_PATTERN =
  /(?:request[\s_-]*id|trace[\s_-]*id|correlation[\s_-]*id|\bBearer\s+|\bsk-[A-Za-z0-9_-]{8,}|\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]|(?:^|[\s("'=])\/(?:Users|home|tmp|private|var|opt|etc|usr|Volumes|workspace|repo|mnt)\/|(?:^|[\s("'=])\.{1,2}\/[^\s]+|[A-Za-z]:\\|\b(?:ECONN[A-Z_]*|ETIMEDOUT|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|EPIPE|ERR_(?:NETWORK|SOCKET)[A-Z_]*|UND_ERR_[A-Z_]+)\b|\b(?:stderr|stdout|response\s+body|body|payload|stack(?:\s+trace)?)\s*:|\bat\s+(?:new\s+)?[\w.$<>]+\s*\([^\r\n)]+:\d+:\d+\))/iu;

function genericProviderError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "服务商暂时无法完成此请求，请稍后重试。"
    : "The provider could not complete this request. Try again shortly.";
}

/** True when the failure card replaces this raw text with Moss's own explanation. */
export function isExplainedProviderFailure(error: string): boolean {
  return (
    MOSS_GATEWAY_REPEAT_REFUSED_PATTERN.test(error) ||
    STREAM_DROPPED_PATTERN.test(error) ||
    MOSS_MANAGED_RUNTIME_MISSING_PATTERN.test(error) ||
    PI_MODEL_SIGN_IN_MISSING_PATTERN.test(error) ||
    KNOWN_FAILURE_SENTENCES.some((sentence) => error.includes(sentence))
  );
}

/** A Moss lane's turn ended on a bearer the Moss gateway no longer accepts. */
export function isMossManagedSessionRejected(error: string): boolean {
  return (
    error.includes(MOSS_MANAGED_SESSION_RENEWED_MESSAGE) ||
    error.includes(MOSS_GATEWAY_SESSION_REJECTED_MESSAGE)
  );
}

export function isProviderSignInExpiredError(error: string): boolean {
  return PROVIDER_SIGN_IN_EXPIRED_PATTERN.test(error);
}

function providerSignInExpiredError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "这个账号的登录已失效。请在服务商设置中重新登录，或改用 Moss 服务。"
    : "This account's sign-in has expired. Sign in again in provider settings, or switch to Moss.";
}

function grokLoginRequiredError(locale: MossLocaleCode): string {
  return locale === "zh-CN" ? "请运行 grok login" : "Please run grok login";
}

function peelKnownProductWrapper(text: string): string {
  const withoutInterrupt = text.replace(TASK_INTERRUPTED_PROVIDER_ERROR_PREFIX, "").trim();
  const peeled = withoutInterrupt.replace(PROVIDER_ADAPTER_REQUEST_FAILED_PREFIX, "").trim();
  return peeled.length > 0 ? peeled : text;
}

/** Grok 401 appends a model list after a blank line. Keep only the first paragraph. */
function firstErrorParagraph(text: string): string {
  const peeled = peelKnownProductWrapper(text.trim());
  const first = peeled.split(/\n\s*\n/u)[0] ?? peeled;
  return first.trim();
}

function stripUnsafeDiagnosticFragments(text: string): string {
  return firstErrorParagraph(text)
    .replace(/\bfrom\s+https?:\/\/[^\s)\]>'"]+/giu, "")
    .replace(/https?:\/\/[^\s)\]>'"]+/giu, "")
    .replace(/\bBearer\s+\S+/giu, "")
    .replace(/\bsk-[A-Za-z0-9_-]{8,}/gu, "")
    .replace(/\b(?:api[_-]?key|access[_-]?token|password)\s*[:=]\s*\S+/giu, "")
    .replace(/[\r\n]+/gu, " ")
    .replace(/\s{2,}/gu, " ")
    .replace(/\s+([,.;:])/gu, "$1")
    .replace(/^[,.;:\s]+/u, "")
    .trim();
}

function rateLimitError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "Moss 当前请求较多，请稍后再试。"
    : "Moss is receiving too many requests right now. Try again shortly.";
}

function periodQuotaFallbackError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "本周期的 Moss 使用额度已用完，请升级套餐或等待额度重置。"
    : "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.";
}

function periodQuotaError(raw: string, locale: MossLocaleCode): string {
  // The server humanizer may attach a safe, bounded retry hint. Preserve that
  // product-owned copy, but never pass through an arbitrary gateway body.
  if (SAFE_HUMANIZED_PERIOD_QUOTA_PATTERN.test(raw)) {
    return localizeProviderRuntimeMessage(raw, locale);
  }
  return periodQuotaFallbackError(locale);
}

// The provider may or may not have received the last message, so Moss holds
// the chat rather than risk running it twice. Say that, and what to press.
function deliveryBlockError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "Moss 没能确认上一条消息是否已发给服务商。为避免重复执行，这个对话先暂停了；点“解除阻止”即可继续。"
    : "Moss couldn't confirm the last message reached the provider, so this chat is paused to avoid running it twice. Choose Unblock thread to continue.";
}

function agentProcessExitError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "智能体进程意外退出，这一轮没有完成。可以继续任务。"
    : "The agent process quit unexpectedly, so this turn didn't finish. You can continue the task.";
}

function unconfirmedTurnStartError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "Moss 没能确认服务商是否处理了这条消息，已停止等待，也没有重复发送。可以重试。"
    : "Moss couldn't confirm what the provider did with this message, so it stopped waiting and didn't send it again. You can try again.";
}

function repeatRequestRefusedError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "刚刚已经发送过完全相同的请求，Moss 不会重复发送，以免重复计费。请改一下消息内容，或等大约 15 分钟后再试。"
    : "An identical request went out moments ago, and Moss won't send it twice because that would charge you twice. Change the message, or wait about 15 minutes, then try again.";
}

function providerStartTimeoutError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "服务商启动超时，对话没能开始。请重试；如果一直这样，可以在服务商设置里检查，或换一个服务商。"
    : "The provider took too long to start, so the chat didn't begin. Try again; if it keeps happening, check the provider in settings or switch providers.";
}

function codexDataFolderSlowError(raw: string, locale: MossLocaleCode): string | null {
  const match = CODEX_DATA_FOLDER_SLOW_PATTERN.exec(raw);
  if (!match) return null;
  const folder = match[1]?.trim();
  if (locale === "zh-CN") {
    return `Codex 读取它的数据文件夹${folder ? `（${folder}）` : ""}太慢，对话没能开始。通常是这个文件夹所在的磁盘正忙或很慢，比如正在大范围搜索文件、杀毒扫描，或者另一个 Codex 应用在大量读写。等磁盘空闲后再试；如果经常这样，可以把 Codex 的数据文件夹放到更快的磁盘上。`;
  }
  return `Codex took too long to read its data folder${folder ? ` (${folder})` : ""}, so the chat didn't begin. The disk holding it is usually busy or slow, for example with a large file search, a virus scan, or another Codex app reading and writing a lot. Try again when the disk is quieter; if it keeps happening, move Codex's data folder to a faster disk.`;
}

function workingDirectoryNotFoundError(raw: string, locale: MossLocaleCode): string | null {
  const captured = WORKING_DIRECTORY_NOT_FOUND_PATTERN.exec(raw)?.[1];
  const cwd = captured?.replace(CODEX_WORKING_DIRECTORY_RELOCATE_SUFFIX, "").trim();
  if (!cwd) return null;
  return locale === "zh-CN" ? `工作目录不存在：${cwd}` : `Working directory not found: ${cwd}`;
}

/**
 * Returns whether an authoritative quota surface may own this persisted error.
 * Delivery-block details stay actionable and must continue to expose their
 * unblock control even when a quota surface is visible.
 */
export function isQuotaOwnedThreadError(error: string): boolean {
  const raw = error.trim();
  if (raw.length === 0 || isProviderDeliveryBlockDetail(raw)) return false;
  return PACKAGE_COST_QUOTA_PATTERN.test(raw) || RAW_PERIOD_QUOTA_PATTERN.test(raw);
}

export function resolveQuotaOwnedThreadError(
  error: string | null | undefined,
  quotaSurfaceVisible: boolean,
): string | null {
  return quotaSurfaceVisible && error && isQuotaOwnedThreadError(error) ? error : null;
}

/**
 * Converts a persisted/raw thread error into the only text allowed to reach a
 * user-facing error, title, accessibility, or clipboard surface. Recovery
 * logic still receives the raw error so provider-delivery quarantine detection
 * remains exact.
 */
export function resolveThreadErrorPresentation(
  error: string,
  locale: MossLocaleCode,
  context: "thread" | "provider-start-failure" = "thread",
): ThreadErrorPresentation {
  const raw = error.trim();
  const missingWorkingDirectory = workingDirectoryNotFoundError(raw, locale);
  const knownFailureSentence = KNOWN_FAILURE_SENTENCES.find((sentence) => raw.includes(sentence));
  let safeText: string;
  let recoveryAction: ThreadErrorPresentation["recoveryAction"];
  let retryable = false;
  let changeModelFirst = false;
  const piModelSignInMissing = PI_MODEL_SIGN_IN_MISSING_PATTERN.exec(raw);

  if (missingWorkingDirectory) {
    safeText = missingWorkingDirectory;
  } else if (isProviderDeliveryBlockDetail(raw)) {
    safeText = deliveryBlockError(locale);
  } else if (isUnconfirmedTurnStartDetail(raw)) {
    // Moss stopped waiting and sent nothing again; sending again is the person's choice.
    safeText = unconfirmedTurnStartError(locale);
    retryable = true;
  } else if (isMossManagedSessionRejected(raw)) {
    // A Moss lane whose bearer lapsed mid-task. Moss renews it on its own and the next send
    // starts on the renewed one, so the fix is to send again, never to sign in to the CLI.
    safeText = localizeProviderRuntimeMessage(MOSS_MANAGED_SESSION_RENEWED_MESSAGE, locale);
    retryable = true;
  } else if (PROVIDER_START_TIMEOUT_PATTERN.test(raw)) {
    safeText = codexDataFolderSlowError(raw, locale) ?? providerStartTimeoutError(locale);
    recoveryAction = "manage-providers";
    retryable = true;
  } else if (raw.includes(MOSS_GATEWAY_IDENTICAL_REQUEST_RUNNING)) {
    safeText = localizeProviderRuntimeMessage(MOSS_GATEWAY_IDENTICAL_REQUEST_RUNNING, locale);
  } else if (MOSS_GATEWAY_REPEAT_REFUSED_PATTERN.test(raw)) {
    safeText = repeatRequestRefusedError(locale);
  } else if (STREAM_DROPPED_PATTERN.test(raw)) {
    safeText = localizeProviderRuntimeMessage(STREAM_DROPPED_MESSAGE, locale);
  } else if (AGENT_PROCESS_EXIT_PATTERN.test(raw)) {
    safeText = agentProcessExitError(locale);
  } else if (MOSS_MANAGED_RUNTIME_MISSING_PATTERN.test(raw)) {
    safeText = localizeProviderRuntimeMessage(MOSS_MANAGED_RUNTIME_MISSING_MESSAGE, locale);
  } else if (normalizeProviderRuntimeMessage(raw) === PERSONAL_CODEX_USAGE_LIMIT_MESSAGE) {
    // Codex app-server includes an account URL and an English reset timestamp in
    // this verdict. Recognize the stable product phrase before diagnostic
    // sanitization, but expose only bounded Moss-owned copy so URLs, locale-
    // ambiguous times, and account details never reach the toast or clipboard.
    safeText = localizeProviderRuntimeMessage(PERSONAL_CODEX_USAGE_LIMIT_MESSAGE, locale);
  } else if (PACKAGE_COST_QUOTA_PATTERN.test(raw)) {
    safeText = localizeProviderRuntimeMessage(
      "Your Moss package usage allowance is exhausted.",
      locale,
    );
  } else if (RAW_PERIOD_QUOTA_PATTERN.test(raw)) {
    // Quota exhaustion is also transported as HTTP 429. Check its stable reason
    // before the generic status mapping so a spent period is not presented as a
    // transient traffic spike. Never expose the gateway body or retry metadata.
    safeText = periodQuotaError(raw, locale);
  } else if (RAW_RATE_LIMIT_PATTERN.test(raw)) {
    safeText = rateLimitError(locale);
  } else if (GROK_LOGIN_REQUIRED_PATTERN.test(raw)) {
    safeText = grokLoginRequiredError(locale);
  } else if (PROVIDER_SIGN_IN_EXPIRED_PATTERN.test(raw)) {
    safeText = providerSignInExpiredError(locale);
    recoveryAction = "manage-providers";
  } else if (knownFailureSentence) {
    safeText =
      (locale === "zh-CN" ? HERMES_COMPATIBILITY_STATUS[knownFailureSentence] : undefined) ??
      localizeProviderRuntimeMessage(knownFailureSentence, locale);
    changeModelFirst = MODEL_BOUND_FAILURE_SENTENCES.has(knownFailureSentence);
  } else if (piModelSignInMissing) {
    safeText = localizeProviderRuntimeMessage(piModelSignInMissing[0], locale);
    changeModelFirst = true;
  } else if (context === "provider-start-failure") {
    // A historical provider-start failure is a persisted transport record, not
    // author-written copy. Even a short unknown value may contain an adapter or
    // account identifier, so only recognized categories may reach the row.
    safeText = genericProviderError(locale);
  } else {
    const localized = localizeProviderRuntimeMessage(
      localizeAntigravityRuntimeMessage(raw, locale),
      locale,
    );
    const recognizedInChinese =
      localizeProviderRuntimeMessage(localizeAntigravityRuntimeMessage(raw, "zh-CN"), "zh-CN") !==
      raw;
    const stripped = stripUnsafeDiagnosticFragments(localized);
    const remainingUnsafe =
      stripped.length === 0 ||
      stripped.length > MAX_SAFE_ACTIONABLE_ERROR_LENGTH ||
      REMAINING_UNSAFE_DIAGNOSTIC_PATTERN.test(stripped);
    const containsRawDiagnostic =
      raw.length > MAX_SAFE_ACTIONABLE_ERROR_LENGTH ||
      RAW_DIAGNOSTIC_PATTERN.test(raw) ||
      RAW_DIAGNOSTIC_PATTERN.test(localized);

    if (raw.length === 0) {
      safeText = genericProviderError(locale);
    } else if (recognizedInChinese && !containsRawDiagnostic) {
      safeText = localized;
    } else if (containsRawDiagnostic && !remainingUnsafe) {
      safeText = stripped;
    } else if (containsRawDiagnostic) {
      safeText = genericProviderError(locale);
    } else {
      safeText = localized;
    }
  }

  return {
    title: safeText,
    copyText: safeText,
    ...(recoveryAction ? { recoveryAction, surface: "history" as const } : {}),
    ...(retryable ? { retryable } : {}),
    ...(changeModelFirst ? { changeModelFirst } : {}),
  };
}
