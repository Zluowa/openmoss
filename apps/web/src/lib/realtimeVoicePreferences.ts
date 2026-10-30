import type { RealtimeVoiceDescriptor, RealtimeVoiceId } from "@synara/contracts";

const VOICE_KEY = "moss.realtimeVoice.voice.v1";
const INPUT_DEVICE_KEY = "moss.realtimeVoice.inputDevice.v1";
const SHORTCUT_KEY = "moss.realtimeVoice.shortcut.v1";
const SCREEN_CONTEXT_KEY = "moss.realtimeVoice.screenContext.v1";

export const DEFAULT_REALTIME_VOICE: RealtimeVoiceId = "maple";

/**
 * Moss-owned display metadata for the nine public Realtime API voices. The
 * runtime response remains the availability source; keeping presentation copy
 * here prevents an older backend description from changing Settings copy.
 */
export const REALTIME_VOICE_CATALOG = [
  { id: "arbor", displayName: "Arbor", description: "Easygoing and versatile" },
  { id: "breeze", displayName: "Breeze", description: "Animated and earnest" },
  { id: "cove", displayName: "Cove", description: "Composed and direct" },
  { id: "ember", displayName: "Ember", description: "Confident and optimistic" },
  { id: "juniper", displayName: "Juniper", description: "Open and upbeat" },
  { id: "maple", displayName: "Maple", description: "Cheerful and candid" },
  { id: "sol", displayName: "Sol", description: "Savvy and relaxed" },
  { id: "spruce", displayName: "Spruce", description: "Calm and affirming" },
  { id: "vale", displayName: "Vale", description: "Bright and inquisitive" },
] as const satisfies readonly RealtimeVoiceDescriptor[];

export function isRealtimeVoiceId(value: string | null): value is RealtimeVoiceId {
  return (
    value === "arbor" ||
    value === "breeze" ||
    value === "cove" ||
    value === "ember" ||
    value === "juniper" ||
    value === "maple" ||
    value === "sol" ||
    value === "spruce" ||
    value === "vale"
  );
}

function read(key: string): string | null {
  try {
    const value = window.localStorage.getItem(key);
    return value && value.length <= 200 ? value : null;
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): boolean {
  try {
    if (value === null) window.localStorage.removeItem(key);
    else window.localStorage.setItem(key, value);
    window.dispatchEvent(new CustomEvent("moss:realtime-voice-preferences-changed"));
    return true;
  } catch {
    // Local preferences are optional and must never block voice startup.
    return false;
  }
}

export function readRealtimeVoicePreference(): RealtimeVoiceId {
  return readPersistedRealtimeVoicePreference() ?? DEFAULT_REALTIME_VOICE;
}

/**
 * Distinguishes an explicit device preference from the server-owned product
 * default returned by `thread.realtime.listVoices`.
 */
export function readPersistedRealtimeVoicePreference(): RealtimeVoiceId | null {
  const value = read(VOICE_KEY);
  return isRealtimeVoiceId(value) ? value : null;
}

export function writeRealtimeVoicePreference(voice: RealtimeVoiceId): boolean {
  return write(VOICE_KEY, voice);
}

export function readRealtimeVoiceInputDevicePreference(): string | null {
  return read(INPUT_DEVICE_KEY);
}

export function writeRealtimeVoiceInputDevicePreference(deviceId: string | null): void {
  write(INPUT_DEVICE_KEY, deviceId);
}

export function readRealtimeVoiceShortcutPreference(): string | null {
  return read(SHORTCUT_KEY);
}

export function writeRealtimeVoiceShortcutPreference(shortcut: string | null): void {
  write(SHORTCUT_KEY, shortcut);
}

export function readRealtimeVoiceScreenContextPreference(): boolean {
  return read(SCREEN_CONTEXT_KEY) === "enabled";
}

export function writeRealtimeVoiceScreenContextPreference(enabled: boolean): void {
  write(SCREEN_CONTEXT_KEY, enabled ? "enabled" : null);
}

export function realtimeVoiceShortcutFromKeyboardEvent(event: KeyboardEvent): string | null {
  const key = event.key.toLowerCase();
  if (["meta", "control", "alt", "shift"].includes(key)) return null;
  const modifiers = [
    event.metaKey ? "meta" : null,
    event.ctrlKey ? "ctrl" : null,
    event.altKey ? "alt" : null,
    event.shiftKey ? "shift" : null,
  ].filter((value): value is string => value !== null);
  if (modifiers.length === 0 || key.length === 0 || key.length > 24) return null;
  return [...modifiers, key].join("+");
}

export function formatRealtimeVoiceShortcut(shortcut: string | null): string {
  if (!shortcut) return "Off";
  return shortcut
    .split("+")
    .map((part) => {
      if (part === "meta") return navigator.platform.includes("Mac") ? "⌘" : "Meta";
      if (part === "ctrl") return "Ctrl";
      if (part === "alt") return navigator.platform.includes("Mac") ? "⌥" : "Alt";
      if (part === "shift") return "⇧";
      return part.length === 1 ? part.toUpperCase() : part;
    })
    .join(navigator.platform.includes("Mac") ? "" : "+");
}

export function keyboardEventMatchesRealtimeVoiceShortcut(
  event: KeyboardEvent,
  shortcut: string | null,
): boolean {
  return shortcut !== null && realtimeVoiceShortcutFromKeyboardEvent(event) === shortcut;
}
