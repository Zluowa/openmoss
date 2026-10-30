import { describe, expect, it } from "vitest";

import { resolveRealtimeVoiceMicrophoneHealth } from "./realtimeVoiceMicrophoneHealth";

describe("resolveRealtimeVoiceMicrophoneHealth", () => {
  it("turns an empty denied inventory into an actionable system-permission state", () => {
    expect(
      resolveRealtimeVoiceMicrophoneHealth({
        audioInputCount: 0,
        captureErrorName: "NotAllowedError",
        enumerationAvailable: true,
        enumerationFailed: false,
      }),
    ).toEqual({
      status: "permission-denied",
      message:
        "Microphone access is blocked. Enable Moss in macOS Privacy & Security > Microphone, then retry.",
      actionLabel: "Retry microphone access",
    });
  });

  it("reports confirmed hardware absence separately from system permission", () => {
    expect(
      resolveRealtimeVoiceMicrophoneHealth({
        audioInputCount: 0,
        captureErrorName: "NotFoundError",
        enumerationAvailable: true,
        enumerationFailed: false,
      }),
    ).toEqual({
      status: "no-device",
      message: "No microphone is connected. Connect one, then retry.",
      actionLabel: "Refresh microphones",
    });
  });

  it("does not claim permission denial before access has been checked", () => {
    expect(
      resolveRealtimeVoiceMicrophoneHealth({
        audioInputCount: 0,
        captureErrorName: null,
        enumerationAvailable: true,
        enumerationFailed: false,
      }),
    ).toEqual({
      status: "permission-unchecked",
      message: "Allow microphone access to discover available inputs.",
      actionLabel: "Check microphone access",
    });
  });

  it("is healthy when at least one input is visible", () => {
    expect(
      resolveRealtimeVoiceMicrophoneHealth({
        audioInputCount: 1,
        captureErrorName: "NotAllowedError",
        enumerationAvailable: true,
        enumerationFailed: false,
      }),
    ).toEqual({ status: "ready", message: null, actionLabel: null });
  });
});
