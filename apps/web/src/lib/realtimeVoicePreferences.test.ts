import { describe, expect, it } from "vitest";

import {
  formatRealtimeVoiceShortcut,
  isRealtimeVoiceId,
  keyboardEventMatchesRealtimeVoiceShortcut,
  REALTIME_VOICE_CATALOG,
  realtimeVoiceShortcutFromKeyboardEvent,
} from "./realtimeVoicePreferences";

function keyboardEvent(input: Partial<KeyboardEvent>): KeyboardEvent {
  return {
    key: "v",
    metaKey: false,
    ctrlKey: false,
    altKey: false,
    shiftKey: false,
    ...input,
  } as KeyboardEvent;
}

describe("Realtime Voice preferences", () => {
  it("accepts only the nine public Moss voice ids", () => {
    expect(isRealtimeVoiceId("maple")).toBe(true);
    expect(isRealtimeVoiceId("gpt-live-1-codex")).toBe(false);
  });

  it("keeps the public voice names and descriptions source-faithful", () => {
    expect(REALTIME_VOICE_CATALOG).toEqual([
      { id: "arbor", displayName: "Arbor", description: "Easygoing and versatile" },
      { id: "breeze", displayName: "Breeze", description: "Animated and earnest" },
      { id: "cove", displayName: "Cove", description: "Composed and direct" },
      { id: "ember", displayName: "Ember", description: "Confident and optimistic" },
      { id: "juniper", displayName: "Juniper", description: "Open and upbeat" },
      { id: "maple", displayName: "Maple", description: "Cheerful and candid" },
      { id: "sol", displayName: "Sol", description: "Savvy and relaxed" },
      { id: "spruce", displayName: "Spruce", description: "Calm and affirming" },
      { id: "vale", displayName: "Vale", description: "Bright and inquisitive" },
    ]);
  });

  it("canonicalizes and matches a modified key chord", () => {
    const event = keyboardEvent({ metaKey: true, shiftKey: true, key: "V" });
    expect(realtimeVoiceShortcutFromKeyboardEvent(event)).toBe("meta+shift+v");
    expect(keyboardEventMatchesRealtimeVoiceShortcut(event, "meta+shift+v")).toBe(true);
  });

  it("rejects bare keys and modifier-only events", () => {
    expect(realtimeVoiceShortcutFromKeyboardEvent(keyboardEvent({ key: "v" }))).toBeNull();
    expect(
      realtimeVoiceShortcutFromKeyboardEvent(keyboardEvent({ key: "Shift", shiftKey: true })),
    ).toBeNull();
  });

  it("labels a disabled voice chat hotkey as Off", () => {
    expect(formatRealtimeVoiceShortcut(null)).toBe("Off");
  });
});
