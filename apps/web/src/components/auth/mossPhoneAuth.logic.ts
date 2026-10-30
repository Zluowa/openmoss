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

const PHONE_AUTH_MESSAGES_BY_CODE = {
  invalid_phone_number: "请输入有效的中国大陆手机号。",
  sms_send_failed: "验证码发送失败，请稍后再试。",
  sms_rate_limited: "验证码请求过于频繁，请稍后再试。",
  challenge_not_found: "验证码请求无效，请重新获取。",
  challenge_expired: "验证码已过期，请重新获取。",
  challenge_consumed: "验证码已使用，请重新获取。",
  challenge_attempts_exceeded: "验证码错误次数过多，请重新获取。",
  invalid_verification_code: "验证码无效或已过期，请重新获取。",
  authentication_service_unavailable: "手机号登录服务暂时不可用，请稍后再试。",
  invalid_authentication_response: "手机号登录响应异常，请重新获取验证码后再试。",
  session_expired: "登录状态已过期，请重新登录。",
  authentication_required: "登录状态已失效，请重新登录。",
  persistence_failed: "无法安全保存手机号登录状态，请稍后重试。",
} as const;

type PhoneAuthErrorCode = keyof typeof PHONE_AUTH_MESSAGES_BY_CODE;

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

function safeErrorRecord(error: unknown): Readonly<Record<string, unknown>> | null {
  return typeof error === "object" && error !== null
    ? (error as Readonly<Record<string, unknown>>)
    : null;
}

function knownPhoneAuthErrorCode(error: unknown): PhoneAuthErrorCode | null {
  const record = safeErrorRecord(error);
  const code = typeof record?.code === "string" ? record.code.trim() : "";
  if (code in PHONE_AUTH_MESSAGES_BY_CODE) return code as PhoneAuthErrorCode;
  const message = error instanceof Error ? error.message.trim() : "";
  return PHONE_AUTH_CODE_BY_EXACT_MESSAGE[message] ?? null;
}

export function phoneAuthErrorMessage(error: unknown): string {
  const code = knownPhoneAuthErrorCode(error);
  return code ? PHONE_AUTH_MESSAGES_BY_CODE[code] : "手机号登录失败，请稍后重试。";
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
