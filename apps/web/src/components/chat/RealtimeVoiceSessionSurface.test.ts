import { describe, expect, it } from "vitest";

import {
  canSubmitRealtimeVoiceSessionText,
  isRealtimeVoiceSessionInteractive,
} from "./RealtimeVoiceSessionSurface";

describe("RealtimeVoiceSessionSurface interaction gating", () => {
  it("allows composer interaction only for an active, enabled session", () => {
    expect(isRealtimeVoiceSessionInteractive("active")).toBe(true);
    expect(isRealtimeVoiceSessionInteractive("active", true)).toBe(false);

    for (const phase of [
      "inactive",
      "reserving",
      "presenting",
      "starting",
      "stopping",
      "failed",
    ] as const) {
      expect(isRealtimeVoiceSessionInteractive(phase)).toBe(false);
    }
  });

  it("submits non-empty controlled text without trimming its payload", () => {
    expect(
      canSubmitRealtimeVoiceSessionText({ phase: "active", text: "  coordinate agents  " }),
    ).toBe(true);
    expect(canSubmitRealtimeVoiceSessionText({ phase: "active", text: " \n\t " })).toBe(false);
    expect(canSubmitRealtimeVoiceSessionText({ phase: "starting", text: "queued" })).toBe(false);
    expect(
      canSubmitRealtimeVoiceSessionText({ phase: "active", text: "queued", disabled: true }),
    ).toBe(false);
  });
});
