// FILE: realtimeVoiceShortcut.ts
// Purpose: Validate and own the single Electron global shortcut used to toggle Realtime Voice.
// Layer: Electron main process

export interface RealtimeVoiceShortcutRegistry {
  register(accelerator: string, callback: () => void): boolean;
  unregister(accelerator: string): void;
}

export interface RealtimeVoiceShortcutResult {
  readonly registered: boolean;
  readonly shortcut: string | null;
  readonly reason: string | null;
}

const ALLOWED_KEYS = new Set([
  ..."abcdefghijklmnopqrstuvwxyz0123456789".split(""),
  ...Array.from({ length: 12 }, (_, index) => `f${index + 1}`),
  "space",
  "enter",
]);

export function realtimeVoiceShortcutAccelerator(
  shortcut: string,
  platform: NodeJS.Platform,
): string | null {
  if (!shortcut || shortcut.length > 80) return null;
  const parts = shortcut.toLowerCase().split("+");
  const key = parts.at(-1);
  const modifiers = parts.slice(0, -1);
  if (!key || !ALLOWED_KEYS.has(key) || modifiers.length === 0) return null;
  if (new Set(parts).size !== parts.length) return null;
  if (modifiers.some((modifier) => !["meta", "ctrl", "alt", "shift"].includes(modifier))) {
    return null;
  }
  const acceleratorModifiers = modifiers.map((modifier) => {
    if (modifier === "meta") return platform === "darwin" ? "Command" : "Super";
    if (modifier === "ctrl") return "Control";
    if (modifier === "alt") return "Alt";
    return "Shift";
  });
  const acceleratorKey = key === "space" ? "Space" : key === "enter" ? "Enter" : key.toUpperCase();
  return [...acceleratorModifiers, acceleratorKey].join("+");
}

export class DesktopRealtimeVoiceShortcutManager {
  readonly #registry: RealtimeVoiceShortcutRegistry;
  readonly #platform: NodeJS.Platform;
  readonly #onToggle: () => void;
  #shortcut: string | null = null;
  #accelerator: string | null = null;

  constructor(input: {
    readonly registry: RealtimeVoiceShortcutRegistry;
    readonly platform: NodeJS.Platform;
    readonly onToggle: () => void;
  }) {
    this.#registry = input.registry;
    this.#platform = input.platform;
    this.#onToggle = input.onToggle;
  }

  setShortcut(value: unknown): RealtimeVoiceShortcutResult {
    if (value === null) {
      this.#release();
      this.#shortcut = null;
      return { registered: true, shortcut: null, reason: null };
    }
    if (typeof value !== "string") {
      return { registered: false, shortcut: this.#shortcut, reason: "Invalid shortcut." };
    }
    const accelerator = realtimeVoiceShortcutAccelerator(value, this.#platform);
    if (!accelerator) {
      return {
        registered: false,
        shortcut: this.#shortcut,
        reason: "Choose a supported key with at least one modifier.",
      };
    }
    if (value === this.#shortcut && accelerator === this.#accelerator) {
      return { registered: true, shortcut: value, reason: null };
    }

    const previousShortcut = this.#shortcut;
    const previousAccelerator = this.#accelerator;
    this.#release();
    try {
      if (!this.#registry.register(accelerator, this.#onToggle)) {
        this.#restore(previousShortcut, previousAccelerator);
        return {
          registered: false,
          shortcut: previousShortcut,
          reason: "The operating system or another app is already using this shortcut.",
        };
      }
    } catch {
      this.#restore(previousShortcut, previousAccelerator);
      return {
        registered: false,
        shortcut: previousShortcut,
        reason: "The operating system could not register this shortcut.",
      };
    }
    this.#shortcut = value;
    this.#accelerator = accelerator;
    return { registered: true, shortcut: value, reason: null };
  }

  dispose(): void {
    this.#release();
    this.#shortcut = null;
  }

  #release(): void {
    const accelerator = this.#accelerator;
    this.#accelerator = null;
    if (!accelerator) return;
    try {
      this.#registry.unregister(accelerator);
    } catch {
      // Electron may have already released all shortcuts during shutdown.
    }
  }

  #restore(shortcut: string | null, accelerator: string | null): void {
    this.#shortcut = null;
    this.#accelerator = null;
    if (!shortcut || !accelerator) return;
    try {
      if (this.#registry.register(accelerator, this.#onToggle)) {
        this.#shortcut = shortcut;
        this.#accelerator = accelerator;
      }
    } catch {
      // A failed restore leaves the shortcut explicitly unregistered.
    }
  }
}
