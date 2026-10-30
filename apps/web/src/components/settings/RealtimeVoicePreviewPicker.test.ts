import { describe, expect, it, vi } from "vitest";

import {
  realtimeVoicePreviewOrbAudioLevel,
  resetRealtimeVoicePreviewElement,
} from "./RealtimeVoicePreviewPicker";

describe("Realtime Voice preview playback", () => {
  it("pauses and rewinds the shared audio element before a voice switch", () => {
    const pause = vi.fn();
    const audio = { currentTime: 7.25, pause } as unknown as HTMLAudioElement;

    resetRealtimeVoicePreviewElement(audio);

    expect(pause).toHaveBeenCalledOnce();
    expect(audio.currentTime).toBe(0);
  });

  it("uses the captured fixed synthetic orb levels for playing and idle previews", () => {
    expect(realtimeVoicePreviewOrbAudioLevel("playing")).toBe(0.48);
    expect(realtimeVoicePreviewOrbAudioLevel("idle")).toBe(0.08);
    expect(realtimeVoicePreviewOrbAudioLevel("ended")).toBe(0.08);
    expect(realtimeVoicePreviewOrbAudioLevel("error")).toBe(0.08);
  });
});
