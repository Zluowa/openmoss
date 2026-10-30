import { describe, expect, it } from "vitest";

import { resolveSafeVoiceTranscriptionFailure } from "./voiceTranscriptionFailure";

describe("resolveSafeVoiceTranscriptionFailure", () => {
  it("returns actionable Chinese copy for an expired Moss account session", () => {
    expect(
      resolveSafeVoiceTranscriptionFailure({
        code: "MOSS_VOICE_LOGIN_REQUIRED",
        locale: "zh-CN",
        status: 403,
      }),
    ).toEqual({
      code: "MOSS_VOICE_LOGIN_REQUIRED",
      message: "Moss 登录状态已过期，请重新登录后再试。",
      retryable: true,
      status: 403,
    });
  });

  it("distinguishes Moss quota from OpenRouter BYOK credits", () => {
    expect(
      resolveSafeVoiceTranscriptionFailure({
        code: "MOSS_VOICE_QUOTA_EXHAUSTED",
        locale: "zh-CN",
      }),
    ).toMatchObject({
      message: "当前 Moss 语音额度不可用，请检查套餐或稍后重试。",
      retryable: false,
      status: 402,
    });
    expect(
      resolveSafeVoiceTranscriptionFailure({
        code: "OPENROUTER_STT_CREDITS_EXHAUSTED",
        locale: "en-US",
      }),
    ).toMatchObject({
      message: "OpenRouter voice transcription credits are unavailable.",
      retryable: false,
      status: 402,
    });
  });

  it("rejects unknown codes instead of forwarding untrusted messages", () => {
    expect(
      resolveSafeVoiceTranscriptionFailure({
        code: "PRIVATE_PROVIDER_SENTINEL",
        locale: "zh-CN",
      }),
    ).toBeNull();
  });
});
