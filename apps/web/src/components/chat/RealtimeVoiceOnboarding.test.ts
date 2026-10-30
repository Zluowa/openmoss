import type { RealtimeVoiceDescriptor } from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import { REALTIME_VOICE_CATALOG } from "~/lib/realtimeVoicePreferences";

import {
  hasCompletedRealtimeVoiceOnboarding,
  persistRealtimeVoiceOnboardingCompletion,
  REALTIME_VOICE_ONBOARDING_COMPLETION_KEY,
  REALTIME_VOICE_ONBOARDING_COMPLETION_VALUE,
  resolveRealtimeVoiceOnboardingCatalog,
} from "./RealtimeVoiceOnboarding";

describe("Realtime Voice onboarding persistence", () => {
  it("recognizes only the current versioned completion marker", () => {
    const values = new Map<string, string>();
    const storage = {
      getItem: (key: string) => values.get(key) ?? null,
      setItem: (key: string, value: string) => values.set(key, value),
    };

    expect(hasCompletedRealtimeVoiceOnboarding(storage)).toBe(false);
    values.set(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY, "legacy");
    expect(hasCompletedRealtimeVoiceOnboarding(storage)).toBe(false);
    expect(persistRealtimeVoiceOnboardingCompletion(storage)).toBe(true);
    expect(values.get(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBe(
      REALTIME_VOICE_ONBOARDING_COMPLETION_VALUE,
    );
    expect(hasCompletedRealtimeVoiceOnboarding(storage)).toBe(true);
  });

  it("fails closed when local storage is unreadable or unwritable", () => {
    const getItem = vi.fn(() => {
      throw new Error("blocked");
    });
    const setItem = vi.fn(() => {
      throw new Error("blocked");
    });
    expect(hasCompletedRealtimeVoiceOnboarding({ getItem, setItem })).toBe(false);
    expect(persistRealtimeVoiceOnboardingCompletion({ getItem, setItem })).toBe(false);
  });
});

describe("Realtime Voice onboarding catalog", () => {
  it("uses server availability, Moss presentation order, and the persisted voice", () => {
    const serverVoices = [
      REALTIME_VOICE_CATALOG[6],
      REALTIME_VOICE_CATALOG[0],
      { id: "maple", displayName: "Server Maple", description: "Server copy" },
    ] satisfies readonly RealtimeVoiceDescriptor[];
    const resolved = resolveRealtimeVoiceOnboardingCatalog({
      availableVoices: serverVoices,
      defaultVoice: "arbor",
      persistedVoice: "sol",
    });

    expect(resolved.voices.map((voice) => voice.id)).toEqual(["arbor", "maple", "sol"]);
    expect(resolved.voices.find((voice) => voice.id === "maple")?.displayName).toBe("Maple");
    expect(resolved.selectedVoiceId).toBe("sol");
  });

  it("falls back from an unavailable preference to the server default, then the first voice", () => {
    const availableVoices = [REALTIME_VOICE_CATALOG[0], REALTIME_VOICE_CATALOG[5]];
    expect(
      resolveRealtimeVoiceOnboardingCatalog({
        availableVoices,
        defaultVoice: "arbor",
        persistedVoice: "sol",
      }).selectedVoiceId,
    ).toBe("arbor");
    expect(
      resolveRealtimeVoiceOnboardingCatalog({
        availableVoices,
        defaultVoice: "vale",
        persistedVoice: null,
      }).selectedVoiceId,
    ).toBe("arbor");
  });
});
