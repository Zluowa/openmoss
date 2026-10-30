// FILE: voiceTranscriptionFailure.ts
// Purpose: Maps stable voice failure codes to safe locale-aware user guidance.
// Layer: Shared server/desktop/web runtime

interface VoiceTranscriptionFailureCopy {
  readonly en: string;
  readonly zhCN: string;
  readonly retryable: boolean;
  readonly status: number;
}

const SAFE_VOICE_TRANSCRIPTION_FAILURES = {
  VOICE_ACCOUNT_STARTUP_NOT_READY: {
    en: "Moss is still restoring your account session. Try again in a moment.",
    zhCN: "Moss 正在恢复账号会话，请稍后重试。",
    retryable: true,
    status: 503,
  },
  VOICE_ACCOUNT_AUTHENTICATION_REQUIRED: {
    en: "Sign in to your Moss account to use voice transcription.",
    zhCN: "请先登录 Moss 账号，再使用语音转文字。",
    retryable: false,
    status: 401,
  },
  VOICE_ACCOUNT_RECOVERY_REQUIRED: {
    en: "Moss voice is unavailable until account recovery completes.",
    zhCN: "Moss 账号恢复尚未完成，请刷新账号状态后重试。",
    retryable: true,
    status: 503,
  },
  VOICE_PROVIDER_INSTANCE_UNAVAILABLE: {
    en: "The selected voice transcription provider is unavailable.",
    zhCN: "所选语音服务商不可用，请在“模型账号”中检查连接。",
    retryable: false,
    status: 400,
  },
  VOICE_PROVIDER_INSTANCE_DISABLED: {
    en: "The selected voice transcription provider is disabled.",
    zhCN: "所选语音服务商已禁用，请在“模型账号”中重新启用。",
    retryable: false,
    status: 400,
  },
  VOICE_RESERVED_PROVIDER_INSTANCE_INVALID: {
    en: "The selected voice transcription provider is unavailable.",
    zhCN: "所选 Moss 语音服务配置无效，请刷新账号状态后重试。",
    retryable: false,
    status: 400,
  },
  VOICE_PROVIDER_TRANSCRIPTION_UNAVAILABLE: {
    en: "Voice transcription is unavailable for the selected provider.",
    zhCN: "所选服务商不支持语音转文字，请切换服务商。",
    retryable: false,
    status: 400,
  },
  VOICE_TRANSCRIPTION_UNAVAILABLE: {
    en: "Voice transcription is temporarily unavailable. Try again shortly.",
    zhCN: "语音转文字服务暂时不可用，请稍后重试。",
    retryable: true,
    status: 502,
  },
  MOSS_VOICE_LOGIN_REQUIRED: {
    en: "Your Moss account session has expired. Sign in again.",
    zhCN: "Moss 登录状态已过期，请重新登录后再试。",
    retryable: true,
    status: 401,
  },
  MOSS_VOICE_QUOTA_EXHAUSTED: {
    en: "Your Moss voice quota is unavailable. Review your plan or try again later.",
    zhCN: "当前 Moss 语音额度不可用，请检查套餐或稍后重试。",
    retryable: false,
    status: 402,
  },
  MOSS_VOICE_AUDIO_TOO_LARGE: {
    en: "The voice recording is too large to transcribe.",
    zhCN: "录音文件过大，请缩短录音后重试。",
    retryable: false,
    status: 413,
  },
  MOSS_VOICE_RATE_LIMITED: {
    en: "Moss voice is receiving too many requests. Try again shortly.",
    zhCN: "Moss 语音请求过于频繁，请稍后重试。",
    retryable: true,
    status: 429,
  },
  MOSS_VOICE_GATEWAY_UNAVAILABLE: {
    en: "Moss voice transcription is temporarily unavailable. Try again shortly.",
    zhCN: "Moss 语音转文字服务暂时不可用，请稍后重试。",
    retryable: true,
    status: 502,
  },
  MOSS_VOICE_INVALID_RESPONSE: {
    en: "Moss voice transcription returned an invalid response. Try again shortly.",
    zhCN: "Moss 语音转文字返回了无效结果，请稍后重试。",
    retryable: true,
    status: 502,
  },
  MOSS_VOICE_REJECTED: {
    en: "Moss could not transcribe this voice recording.",
    zhCN: "Moss 无法识别这段录音，请重新录制后再试。",
    retryable: false,
    status: 400,
  },
  MOSS_VOICE_GATEWAY_INVALID: {
    en: "The Moss voice gateway is not configured correctly.",
    zhCN: "Moss 语音网关配置无效，请更新应用或联系支持。",
    retryable: false,
    status: 503,
  },
  OPENROUTER_STT_CONFIGURATION_INVALID: {
    en: "OpenRouter voice transcription is not configured correctly.",
    zhCN: "OpenRouter 语音服务配置无效，请重新配置后再试。",
    retryable: false,
    status: 503,
  },
  OPENROUTER_STT_CREDENTIALS_MISSING: {
    en: "OpenRouter voice transcription credentials are unavailable.",
    zhCN: "未找到 OpenRouter 语音凭据，请先完成配置。",
    retryable: false,
    status: 503,
  },
  OPENROUTER_STT_CREDENTIALS_REJECTED: {
    en: "OpenRouter voice transcription credentials were rejected.",
    zhCN: "OpenRouter 语音凭据无效，请重新配置后再试。",
    retryable: false,
    status: 401,
  },
  OPENROUTER_STT_CREDITS_EXHAUSTED: {
    en: "OpenRouter voice transcription credits are unavailable.",
    zhCN: "OpenRouter 语音额度不可用，请充值或更换凭据。",
    retryable: false,
    status: 402,
  },
  OPENROUTER_STT_AUDIO_TOO_LARGE: {
    en: "The voice recording is too large to transcribe.",
    zhCN: "录音文件过大，请缩短录音后重试。",
    retryable: false,
    status: 413,
  },
  OPENROUTER_STT_AUDIO_INVALID: {
    en: "The voice recording is not a supported WAV upload.",
    zhCN: "录音格式无效，请重新录制后再试。",
    retryable: false,
    status: 400,
  },
  OPENROUTER_STT_UNAVAILABLE: {
    en: "Voice transcription is temporarily unavailable. Try again shortly.",
    zhCN: "OpenRouter 语音转文字服务暂时不可用，请稍后重试。",
    retryable: true,
    status: 502,
  },
  OPENROUTER_STT_REJECTED: {
    en: "OpenRouter could not transcribe this voice recording.",
    zhCN: "OpenRouter 无法识别这段录音，请重新录制后再试。",
    retryable: false,
    status: 400,
  },
  OPENROUTER_STT_INVALID_RESPONSE: {
    en: "OpenRouter returned an invalid transcription response.",
    zhCN: "OpenRouter 返回了无效结果，请稍后重试。",
    retryable: true,
    status: 502,
  },
} as const satisfies Readonly<Record<string, VoiceTranscriptionFailureCopy>>;

export interface SafeVoiceTranscriptionFailure {
  readonly code: string;
  readonly message: string;
  readonly retryable: boolean;
  readonly status: number;
}

export function resolveSafeVoiceTranscriptionFailure(input: {
  readonly code: unknown;
  readonly locale?: string | undefined;
  readonly status?: number | null | undefined;
}): SafeVoiceTranscriptionFailure | null {
  if (typeof input.code !== "string") return null;
  const copy = (
    SAFE_VOICE_TRANSCRIPTION_FAILURES as Readonly<
      Record<string, VoiceTranscriptionFailureCopy | undefined>
    >
  )[input.code];
  if (!copy) return null;
  const status =
    typeof input.status === "number" &&
    Number.isInteger(input.status) &&
    input.status >= 400 &&
    input.status <= 599
      ? input.status
      : copy.status;
  return {
    code: input.code,
    message: /^zh(?:-|$)/iu.test(input.locale?.trim() ?? "") ? copy.zhCN : copy.en,
    retryable: copy.retryable,
    status,
  };
}
