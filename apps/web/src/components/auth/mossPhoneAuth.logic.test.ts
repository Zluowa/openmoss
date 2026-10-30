import { describe, expect, it } from "vitest";

import {
  mossAccountSettingsErrorMessage,
  normalizeMainlandPhoneInput,
  phoneAuthErrorMessage,
  validateMainlandPhone,
  validatePhoneCode,
} from "./mossPhoneAuth.logic";

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
    expect(phoneAuthErrorMessage({ code: "sms_rate_limited", message: "private detail" })).toBe(
      "验证码请求过于频繁，请稍后再试。",
    );
    expect(phoneAuthErrorMessage(new Error("验证码已过期，请重新获取。"))).toBe(
      "验证码已过期，请重新获取。",
    );

    const raw = "postgres private_schema.accounts failed at /private/server.ts:42";
    const message = phoneAuthErrorMessage(new Error(raw));
    expect(message).toBe("手机号登录失败，请稍后重试。");
    expect(message).not.toContain(raw);
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
