import { describe, expect, it } from "vitest";

import { translateMoss } from "~/localization";
import type { MossLocaleCode } from "~/uiLocale";
import {
  mossAccountSettingsErrorMessage,
  normalizeMainlandPhoneInput,
  type PhoneAuthStep,
  phoneAuthErrorMessageKey,
  validateMainlandPhone,
  validatePhoneCode,
} from "./mossPhoneAuth.logic";

const phoneAuthErrorMessage = (
  error: unknown,
  step: PhoneAuthStep,
  locale: MossLocaleCode = "zh-CN",
) => translateMoss(locale, phoneAuthErrorMessageKey(error, step));

// What the backend sends for MemFire's 403 on /verify (wrong, replaced, or expired code).
const MEMFIRE_REJECTED_CODE = new Error("验证码无效或已过期，请重新获取。");
const transportError = (code: string) =>
  Object.assign(new Error(`WebSocket RPC failed (${code})`), { code });

describe("Moss phone auth validation", () => {
  it.each([
    ["13800138000", "13800138000"],
    ["+86 138 0013 8000", "13800138000"],
    ["86-138-0013-8000", "13800138000"],
  ])("normalizes a mainland number: %s", (input, expected) => {
    expect(normalizeMainlandPhoneInput(input)).toBe(expected);
    expect(validateMainlandPhone(input)).toBeNull();
  });

  it.each(["", "12800138000", "+12025550123", "1380013800"])(
    "rejects a non-mainland mobile number: %s",
    (input) => expect(validateMainlandPhone(input)).not.toBeNull(),
  );

  it("accepts exactly six OTP digits", () => {
    expect(validatePhoneCode(" 123456 ")).toBeNull();
    expect(validatePhoneCode("12345")).not.toBeNull();
    expect(validatePhoneCode("12345a")).not.toBeNull();
  });

  it("maps only known account failures and never exposes unknown backend details", () => {
    expect(
      phoneAuthErrorMessage({ code: "sms_rate_limited", message: "private detail" }, "send"),
    ).toBe("验证码请求过于频繁，请稍后再试。");
    expect(phoneAuthErrorMessage(new Error("验证码已过期，请重新获取。"), "verify")).toBe(
      "验证码已过期，请重新获取。",
    );
    expect(phoneAuthErrorMessage({ code: "toString" }, "verify")).toBe(
      "手机号登录失败，请稍后重试。",
    );

    const raw = "postgres private_schema.accounts failed at /private/server.ts:42";
    const message = phoneAuthErrorMessage(new Error(raw), "verify");
    expect(message).toBe("手机号登录失败，请稍后重试。");
    expect(message).not.toContain(raw);
  });

  it("tells people to use the newest text when MemFire rejects a code", () => {
    expect(phoneAuthErrorMessage(MEMFIRE_REJECTED_CODE, "verify")).toBe(
      "验证码不对或已失效，请输入最新一条短信里的验证码，或重新获取。",
    );
    expect(phoneAuthErrorMessage(MEMFIRE_REJECTED_CODE, "verify", "en")).toBe(
      "That code is wrong or no longer valid. Enter the code from the newest text, or request a new one.",
    );
    expect(phoneAuthErrorMessage({ code: "invalid_verification_code" }, "verify")).toBe(
      phoneAuthErrorMessage(MEMFIRE_REJECTED_CODE, "verify"),
    );
  });

  it("keeps rate limits, timeouts, and an unreachable service apart", () => {
    const rateLimited = new Error("验证码请求过于频繁，请稍后再试。");
    const sendTimedOut = phoneAuthErrorMessage(transportError("WS_REQUEST_TIMEOUT"), "send");
    const messages = [
      phoneAuthErrorMessage(MEMFIRE_REJECTED_CODE, "verify"),
      phoneAuthErrorMessage(rateLimited, "send"),
      sendTimedOut,
      phoneAuthErrorMessage(transportError("WS_REQUEST_TIMEOUT"), "verify"),
      phoneAuthErrorMessage(transportError("WS_REQUEST_NOT_SENT"), "send"),
      phoneAuthErrorMessage(new Error("验证码发送失败，请稍后再试。"), "send"),
    ];
    expect(new Set(messages).size).toBe(messages.length);

    expect(phoneAuthErrorMessage(rateLimited, "send", "en")).toBe(
      "Too many code requests. Wait a moment and try again.",
    );
    // A timed-out send may still deliver a text: say so and ask for a pause, not a resend.
    expect(sendTimedOut).toBe(
      "请求超时，但短信可能仍会送达。请等 1 分钟再重新获取，之后只使用最新一条短信里的验证码。",
    );
    expect(phoneAuthErrorMessage(transportError("WS_REQUEST_RECONNECTED"), "send")).toBe(
      sendTimedOut,
    );
    expect(phoneAuthErrorMessage(transportError("WS_REQUEST_TIMEOUT"), "send", "en")).toBe(
      "The request timed out, but the text may still arrive. Wait a minute before requesting a new code, then use only the code in the newest text.",
    );
    expect(phoneAuthErrorMessage(transportError("WS_REQUEST_TIMEOUT"), "verify")).toBe(
      "登录请求超时，请检查网络后再试。",
    );
    expect(phoneAuthErrorMessage(transportError("WS_REQUEST_NOT_SENT"), "send")).toBe(
      "手机号登录服务暂时不可用，请稍后再试。",
    );
  });

  it("has English and Chinese copy for every phone sign-in message, none promising a lifetime", () => {
    const errors: ReadonlyArray<readonly [unknown, PhoneAuthStep]> = [
      ...[
        "invalid_phone_number",
        "sms_send_failed",
        "sms_rate_limited",
        "challenge_not_found",
        "challenge_expired",
        "challenge_consumed",
        "challenge_attempts_exceeded",
        "invalid_verification_code",
        "authentication_service_unavailable",
        "invalid_authentication_response",
        "session_expired",
        "authentication_required",
        "persistence_failed",
      ].map((code) => [{ code }, "verify"] as const),
      [transportError("WS_REQUEST_TIMEOUT"), "send"],
      [transportError("WS_REQUEST_TIMEOUT"), "verify"],
      [new Error("unknown"), "send"],
    ];
    const keys = [
      ...errors.map(([error, step]) => phoneAuthErrorMessageKey(error, step)),
      "mossPhoneLogin.codeSent" as const,
      "mossPhoneLogin.codeResent" as const,
    ];
    for (const key of keys) {
      const english = translateMoss("en", key);
      const chinese = translateMoss("zh-CN", key);
      expect(english).not.toBe(key);
      expect(chinese).not.toBe(english);
      expect(english).not.toMatch(/valid until|expires at|expires in/iu);
      expect(chinese).not.toMatch(/有效期|分钟内有效/u);
    }
  });

  it("keeps account-settings mutation failures on a finite safe message set", () => {
    expect(
      mossAccountSettingsErrorMessage(
        { code: "api_user_not_found", message: "private database detail" },
        "apiUser",
      ),
    ).toBe("The selected API user is no longer available. Refresh and try again.");
    expect(
      mossAccountSettingsErrorMessage(
        { code: "authentication_required", message: "private session detail" },
        "apiKey",
      ),
    ).toBe("Your Moss session has expired. Sign in again.");

    const raw = "sqlite /private/account.db constraint failed with secret row";
    const userMessage = mossAccountSettingsErrorMessage(new Error(raw), "apiUser");
    const keyMessage = mossAccountSettingsErrorMessage(new Error(raw), "apiKey");
    expect(userMessage).toBe("Could not update API users. Try again.");
    expect(keyMessage).toBe("Could not update API keys. Try again.");
    expect(`${userMessage} ${keyMessage}`).not.toContain(raw);
  });
});
