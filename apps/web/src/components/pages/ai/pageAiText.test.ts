import { describe, expect, it } from "vitest";

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
});
