// FILE: threadErrorPresentation.ts
// Purpose: Converts persisted provider failures into safe user-facing text.
// Layer: Chat status presentation
// Exports: resolveThreadErrorPresentation, ThreadErrorPresentation

import { isProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";

import type { MossLocaleCode } from "~/appSettings";
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
  /** The request never reached the provider, so sending it again is safe. */
  readonly retryable?: boolean;
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
// Provider startup wraps these product-owned errors in an Effect/adapter prefix.
// Keep the line-end anchor so arbitrary trailing diagnostics cannot be exposed.
const WORKING_DIRECTORY_NOT_FOUND_PATTERN =
  /(?:Working directory not found: |Project working directory (?:no longer exists|is not a directory): )([^\r\n]{1,1024})$/mu;
const CODEX_WORKING_DIRECTORY_RELOCATE_SUFFIX = /\.\s+Relocate or reconnect the project in Moss\.$/;
const MAX_SAFE_ACTIONABLE_ERROR_LENGTH = 240;
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

function providerStartTimeoutError(locale: MossLocaleCode): string {
  return locale === "zh-CN"
    ? "服务商启动超时，对话没能开始。请重试；如果一直这样，可以在服务商设置里检查，或换一个服务商。"
    : "The provider took too long to start, so the chat didn't begin. Try again; if it keeps happening, check the provider in settings or switch providers.";
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
  let safeText: string;
  let recoveryAction: ThreadErrorPresentation["recoveryAction"];
  let retryable = false;

  if (missingWorkingDirectory) {
    safeText = missingWorkingDirectory;
  } else if (isProviderDeliveryBlockDetail(raw)) {
    safeText = deliveryBlockError(locale);
  } else if (PROVIDER_START_TIMEOUT_PATTERN.test(raw)) {
    safeText = providerStartTimeoutError(locale);
    recoveryAction = "manage-providers";
    retryable = true;
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
  };
}
