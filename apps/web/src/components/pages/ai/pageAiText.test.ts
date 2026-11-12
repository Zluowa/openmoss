import { describe, expect, it } from "vitest";

import { MOSS_MANAGED_SESSION_RENEWED_MESSAGE } from "@moss/shared/mossManagedSession";

import { pageAiErrorText, pageAiText } from "./pageAiText";

const zh = pageAiText("zh-CN");
const en = pageAiText("en");

describe("pageAiErrorText", () => {
  it("turns a provider's technical error into a plain next step", () => {
    const raw =
      "Error: Provider adapter validation failed (codex) in thread.turn.start: Provider instance 'Moss' is disabled in Settings > Providers.";
    expect(pageAiErrorText(raw, zh)).toBe(zh.failedAgentOff);
    expect(pageAiErrorText(raw, en)).toBe(en.failedAgentOff);
    expect(pageAiErrorText("provider session start exceeded its deadline", zh)).toBe(zh.failedSlow);
    expect(pageAiErrorText("Error: something broke", zh)).toBe(zh.failedOther);
    expect(pageAiErrorText(undefined, en)).toBe(en.failedOther);
  });

  it("keeps Moss's own messages", () => {
    expect(pageAiErrorText(zh.saveFirst, zh)).toBe(zh.saveFirst);
    expect(pageAiErrorText(en.saveFirst, en)).toBe(en.saveFirst);
  });

  it("tells a signed-in person to try again after a Moss lane 401, and only a signed-out one to sign in", () => {
    const raw =
      "Failed to authenticate. API Error: 401 The Moss account session is invalid or expired.";
    expect(pageAiErrorText(raw, zh)).toBe(zh.failedMossSession);
    expect(pageAiErrorText(raw, zh, { signedOut: false })).toBe(zh.failedMossSession);
    expect(pageAiErrorText(raw, zh, { signedOut: true })).toBe(zh.failedSignIn);
    expect(pageAiErrorText(MOSS_MANAGED_SESSION_RENEWED_MESSAGE, en)).toBe(en.failedMossSession);
  });
});
