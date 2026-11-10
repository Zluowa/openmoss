import type { TranslationKey } from "~/localization";

export function normalizeMainlandPhoneInput(value: string): string {
  const compact = value.trim().replace(/[\s().-]/gu, "");
  if (compact.startsWith("+86")) return compact.slice(3);
  if (compact.startsWith("86") && compact.length === 13) return compact.slice(2);
  return compact;
}

export function validateMainlandPhone(value: string): string | null {
  return /^1[3-9]\d{9}$/u.test(normalizeMainlandPhoneInput(value))
    ? null
    : "请输入有效的中国大陆手机号";
}

export function validatePhoneCode(value: string): string | null {
  return /^\d{6}$/u.test(value.trim()) ? null : "请输入 6 位短信验证码";
}

const PHONE_AUTH_MESSAGE_KEYS_BY_CODE = {
  invalid_phone_number: "mossPhoneLogin.error.invalidPhone",
  sms_send_failed: "mossPhoneLogin.error.sendFailed",
  sms_rate_limited: "mossPhoneLogin.error.rateLimited",
  challenge_not_found: "mossPhoneLogin.error.challengeNotFound",
  challenge_expired: "mossPhoneLogin.error.challengeExpired",
  challenge_consumed: "mossPhoneLogin.error.challengeConsumed",
  challenge_attempts_exceeded: "mossPhoneLogin.error.attemptsExceeded",
  // MemFire answers 403 both for a wrong code and for one that a newer
  // request replaced or that outlived the Auth console's OTP lifetime.
  invalid_verification_code: "mossPhoneLogin.error.invalidCode",
  authentication_service_unavailable: "mossPhoneLogin.error.serviceUnavailable",
  invalid_authentication_response: "mossPhoneLogin.error.invalidResponse",
  session_expired: "mossPhoneLogin.error.sessionExpired",
  authentication_required: "mossPhoneLogin.error.authenticationRequired",
  persistence_failed: "mossPhoneLogin.error.persistenceFailed",
} as const satisfies Readonly<Record<string, TranslationKey>>;

type PhoneAuthErrorCode = keyof typeof PHONE_AUTH_MESSAGE_KEYS_BY_CODE;

// The backend reports account failures by their zh-CN message only, so these
// exact strings are the wire contract (MossPhoneAccountService.mapAuthError).
const PHONE_AUTH_CODE_BY_EXACT_MESSAGE: Readonly<Record<string, PhoneAuthErrorCode>> = {
  "请输入有效的中国大陆手机号。": "invalid_phone_number",
  "Invalid phone number.": "invalid_phone_number",
  "验证码发送失败，请稍后再试。": "sms_send_failed",
  "验证码请求过于频繁，请稍后再试。": "sms_rate_limited",
  "Too many verification code requests. Try again later.": "sms_rate_limited",
  "验证码请求不存在，请重新获取验证码。": "challenge_not_found",
  "Verification challenge was not found.": "challenge_not_found",
  "验证码已过期，请重新获取。": "challenge_expired",
  "Verification code has expired.": "challenge_expired",
  "Verification challenge has already been used.": "challenge_consumed",
  "Too many incorrect verification code attempts.": "challenge_attempts_exceeded",
  "请输入 6 位短信验证码。": "invalid_verification_code",
  "验证码无效或已过期，请重新获取。": "invalid_verification_code",
  "Verification code is incorrect.": "invalid_verification_code",
  "手机号登录服务暂时不可用，请稍后再试。": "authentication_service_unavailable",
  "手机号登录服务暂时不可用，无法刷新访问令牌。": "authentication_service_unavailable",
  "手机号登录服务尚未配置。": "authentication_service_unavailable",
  "手机号登录响应异常，请重新获取验证码后再试。": "invalid_authentication_response",
  "登录状态已过期，请重新登录。": "session_expired",
  "Moss account login is required.": "authentication_required",
  "This Moss account has been revoked.": "authentication_required",
  "无法安全保存手机号登录状态。": "persistence_failed",
  "无法配置 Moss 模型服务。": "persistence_failed",
  "Moss account persistence failed.": "persistence_failed",
};

/** Which step failed: asking for a code, or signing in with one. */
export type PhoneAuthStep = "send" | "verify";

function safeErrorRecord(error: unknown): Readonly<Record<string, unknown>> | null {
  return typeof error === "object" && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : null;
}

function knownPhoneAuthErrorCode(error: unknown): PhoneAuthErrorCode | null {
  const record = safeErrorRecord(error);
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  if (Object.hasOwn(PHONE_AUTH_MESSAGE_KEYS_BY_CODE, code)) return code as PhoneAuthErrorCode;
  const message = error instanceof Error ? error.message.trim() : "";
  return PHONE_AUTH_CODE_BY_EXACT_MESSAGE[message] ?? null;
}

function transportErrorCode(error: unknown): string {
  const code = safeErrorRecord(error)?.code;
  return typeof code === "string" ? code : "";
}

/**
 * Picks the sign-in message for a failed send or verify. A send that timed out
 * or lost its connection may still have reached the SMS provider, so it gets
 * its own message that asks the person to wait instead of resending at once.
 */
export function phoneAuthErrorMessageKey(error: unknown, step: PhoneAuthStep): TranslationKey {
  const known = knownPhoneAuthErrorCode(error);
  if (known) return PHONE_AUTH_MESSAGE_KEYS_BY_CODE[known];
  const transport = transportErrorCode(error);
  if (transport === "WS_REQUEST_TIMEOUT" || transport === "WS_REQUEST_RECONNECTED") {
    return step === "send"
      ? "mossPhoneLogin.error.sendTimedOut"
      : "mossPhoneLogin.error.verifyTimedOut";
  }
  if (transport === "WS_REQUEST_NOT_SENT") return "mossPhoneLogin.error.serviceUnavailable";
  return "mossPhoneLogin.error.generic";
}

export type MossAccountSettingsErrorContext = "apiUser" | "apiKey";

export function mossAccountSettingsErrorMessage(
  error: unknown,
  context: MossAccountSettingsErrorContext,
): string {
  const record = safeErrorRecord(error);
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  const message = error instanceof Error ? error.message.trim() : "";

  if (
    code === "authentication_required" ||
    code === "session_expired" ||
    message === "Moss account login is required." ||
    message === "This Moss account has been revoked."
  ) {
    return "Your Moss session has expired. Sign in again.";
  }
  if (
    code === "api_user_not_found" ||
    message === "API user was not found." ||
    message === "Active API user was not found."
  ) {
    return "The selected API user is no longer available. Refresh and try again.";
  }
  if (code === "api_key_not_found" || message === "API key was not found.") {
    return "The selected API key is no longer available. Refresh and try again.";
  }
  return context === "apiUser"
    ? "Could not update API users. Try again."
    : "Could not update API keys. Try again.";
}
