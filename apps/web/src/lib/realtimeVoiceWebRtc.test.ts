import { describe, expect, it } from "vitest";

import { isRealtimeVoiceSessionInitializationEvent } from "./realtimeVoiceWebRtc";

describe("isRealtimeVoiceSessionInitializationEvent", () => {
  it.each(["session.created", "session.updated", "session.started"])(
    "accepts the %s activation event",
    (type) => {
      expect(isRealtimeVoiceSessionInitializationEvent({ type })).toBe(true);
    },
  );

  it("does not treat data-channel open or unrelated provider events as an initialized session", () => {
    expect(isRealtimeVoiceSessionInitializationEvent({ type: "response.created" })).toBe(false);
    expect(
      isRealtimeVoiceSessionInitializationEvent({ type: "session.created", __proto__: [] }),
    ).toBe(true);
    expect(isRealtimeVoiceSessionInitializationEvent(null)).toBe(false);
  });
});
