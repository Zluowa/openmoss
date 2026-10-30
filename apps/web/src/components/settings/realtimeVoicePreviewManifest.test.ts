import { describe, expect, it } from "vitest";

import { parseRealtimeVoicePreviewManifest } from "./realtimeVoicePreviewManifest";

describe("Realtime Voice preview manifest", () => {
  it("accepts only voice-matched preview assets from the controlled public directory", () => {
    expect(
      parseRealtimeVoicePreviewManifest({
        voices: {
          arbor: "/realtime-voice-previews/arbor.wav",
          breeze: "https://example.com/breeze.wav",
          cove: "/realtime-voice-previews/../private.wav",
          maple: "/realtime-voice-previews/maple.v2.m4a",
          unknown: "/realtime-voice-previews/unknown.wav",
          vale: null,
        },
      }),
    ).toEqual({
      arbor: "/realtime-voice-previews/arbor.wav",
      maple: "/realtime-voice-previews/maple.v2.m4a",
    });
  });

  it("treats a missing or malformed manifest as having no preview assets", () => {
    expect(parseRealtimeVoicePreviewManifest(null)).toEqual({});
    expect(parseRealtimeVoicePreviewManifest({ voices: [] })).toEqual({});
    expect(parseRealtimeVoicePreviewManifest({ version: 1 })).toEqual({});
  });
});
