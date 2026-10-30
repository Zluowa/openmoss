// FILE: RealtimeVoiceSettingsPanel.browser.tsx
// Purpose: Lock the source-faithful voice picker, preview, microphone, and hotkey states.
// Layer: Browser UI test

import "../../index.css";

import type { RealtimeVoiceDescriptor } from "@synara/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  enumerateDevices: vi.fn(),
  getUserMedia: vi.fn(),
  listVoices: vi.fn(),
  setGlobalShortcut: vi.fn(),
  stopTrack: vi.fn(),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({
    realtimeVoice: {
      listVoices: harness.listVoices,
    },
  }),
}));

import { REALTIME_VOICE_CATALOG } from "~/lib/realtimeVoicePreferences";

import { RealtimeVoiceSettingsPanel } from "./RealtimeVoiceSettingsPanel";

const originalMediaDevicesDescriptor = Object.getOwnPropertyDescriptor(navigator, "mediaDevices");

function mediaDevice(kind: MediaDeviceKind, deviceId: string, label: string): MediaDeviceInfo {
  return {
    deviceId,
    groupId: "group",
    kind,
    label,
    toJSON: () => ({ deviceId, groupId: "group", kind, label }),
  } as MediaDeviceInfo;
}

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value,
  });
}

function setMediaDevices(): void {
  Object.defineProperty(navigator, "mediaDevices", {
    configurable: true,
    value: {
      addEventListener: vi.fn(),
      enumerateDevices: harness.enumerateDevices,
      getUserMedia: harness.getUserMedia,
      removeEventListener: vi.fn(),
    },
  });
}

function voiceResult(voices: readonly RealtimeVoiceDescriptor[] = REALTIME_VOICE_CATALOG) {
  return { defaultVoice: "maple" as const, preferredTransport: "webrtc" as const, voices };
}

beforeEach(() => {
  localStorage.clear();
  harness.enumerateDevices
    .mockReset()
    .mockResolvedValue([
      mediaDevice("audioinput", "default", "Default duplicate"),
      mediaDevice("audioinput", "", "Empty identifier"),
      mediaDevice("videoinput", "camera-1", "Camera"),
      mediaDevice("audioinput", "mic-built-in", "MacBook Microphone"),
      mediaDevice("audioinput", "mic-usb", "USB Microphone"),
    ]);
  harness.getUserMedia.mockReset().mockResolvedValue({
    getTracks: () => [{ stop: harness.stopTrack }],
  });
  harness.listVoices.mockReset().mockResolvedValue(voiceResult());
  harness.setGlobalShortcut.mockReset().mockResolvedValue({
    reason: null,
    registered: true,
    shortcut: null,
  });
  harness.stopTrack.mockReset();
  setMediaDevices();
  setDesktopBridge({
    appSnap: {
      requestPermissions: vi.fn(),
      setEnabled: vi.fn(),
    },
    realtimeVoice: {
      setGlobalShortcut: harness.setGlobalShortcut,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          voices: Object.fromEntries(REALTIME_VOICE_CATALOG.map((voice) => [voice.id, null])),
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    ),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  setDesktopBridge(undefined);
  if (originalMediaDevicesDescriptor) {
    Object.defineProperty(navigator, "mediaDevices", originalMediaDevicesDescriptor);
  } else {
    Reflect.deleteProperty(navigator, "mediaDevices");
  }
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RealtimeVoiceSettingsPanel", () => {
  it("uses the backend-owned default when this device has no saved voice", async () => {
    harness.listVoices.mockResolvedValueOnce({
      defaultVoice: "arbor",
      preferredTransport: "webrtc",
      voices: REALTIME_VOICE_CATALOG,
    });
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await expect.element(page.getByRole("button", { exact: true, name: "Arbor" })).toBeVisible();
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps selection draft-only until Done and exposes all nine exact voices", async () => {
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await expect
        .element(page.getByText("Choose the voice Moss uses for new voice chats"))
        .toBeVisible();
      const voiceButton = page.getByRole("button", { exact: true, name: "Maple" });
      await expect.element(voiceButton).toBeVisible();
      await voiceButton.click();

      await expect.element(page.getByRole("heading", { name: "Choose a voice" })).toBeVisible();
      for (const voice of REALTIME_VOICE_CATALOG) {
        await expect
          .element(
            page.getByRole("radio", {
              name: `${voice.displayName}: ${voice.description}`,
            }),
          )
          .toBeInTheDocument();
      }
      for (const radio of document.querySelectorAll<HTMLElement>('[role="radio"]')) {
        const visual = getComputedStyle(radio);
        expect(radio).toHaveAttribute("data-realtime-voice-radio-dot");
        expect(visual.width).toBe("10px");
        expect(visual.height).toBe("10px");
      }
      await expect
        .element(page.getByRole("button", { name: "Maple preview unavailable" }))
        .toBeDisabled();
      expect(document.querySelectorAll("audio")).toHaveLength(1);

      const audio = document.querySelector("audio");
      expect(audio).not.toBeNull();
      if (!audio) return;
      let currentTime = 7.25;
      Object.defineProperty(audio, "currentTime", {
        configurable: true,
        get: () => currentTime,
        set: (value: number) => {
          currentTime = value;
        },
      });
      const pause = vi.spyOn(audio, "pause").mockImplementation(() => undefined);

      await page.getByRole("button", { name: "Next voice" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Sol: Savvy and relaxed" }))
        .toHaveAttribute("aria-checked", "true");
      expect(pause).toHaveBeenCalled();
      expect(audio.currentTime).toBe(0);
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBeNull();

      await page.getByRole("button", { name: "Cancel" }).click();
      await expect.element(page.getByRole("button", { exact: true, name: "Maple" })).toBeVisible();

      await page.getByRole("button", { exact: true, name: "Maple" }).click();
      await page.getByRole("button", { name: "Next voice" }).click();
      await page.getByRole("button", { name: "Done" }).click();
      await vi.waitFor(() => {
        expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBe("sol");
      });
      await expect.element(page.getByRole("button", { exact: true, name: "Sol" })).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("offers Retry after load failure and keeps the dialog open when saving fails", async () => {
    harness.listVoices.mockReset().mockRejectedValueOnce(new Error("offline"));
    harness.listVoices.mockResolvedValue(voiceResult());
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await expect.element(page.getByText("Unable to load voice settings")).toBeVisible();
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.element(page.getByRole("button", { exact: true, name: "Maple" })).toBeVisible();

      await page.getByRole("button", { exact: true, name: "Maple" }).click();
      await page.getByRole("button", { name: "Next voice" }).click();
      const setItem = vi.spyOn(Storage.prototype, "setItem").mockImplementation(() => {
        throw new Error("storage unavailable");
      });
      await page.getByRole("button", { name: "Done" }).click();

      await expect.element(page.getByText("Unable to save voice")).toBeVisible();
      await expect.element(page.getByRole("heading", { name: "Choose a voice" })).toBeVisible();
      setItem.mockRestore();
    } finally {
      await mounted.unmount();
    }
  });

  it("requests microphone access on menu open and preserves Off after a hotkey error", async () => {
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await expect.element(page.getByRole("button", { exact: true, name: "Maple" })).toBeVisible();
      await page.getByRole("combobox", { name: "Microphone" }).click();
      await vi.waitFor(() => {
        expect(harness.getUserMedia).toHaveBeenCalledWith({ audio: true });
        expect(harness.stopTrack).toHaveBeenCalledOnce();
        expect(harness.enumerateDevices.mock.calls.length).toBeGreaterThanOrEqual(2);
      });
      await expect.element(page.getByRole("option", { name: "System default" })).toBeVisible();
      await expect.element(page.getByText("MacBook Microphone", { exact: true })).toBeVisible();
      await expect.element(page.getByText("USB Microphone", { exact: true })).toBeVisible();
      await expect
        .element(page.getByText("Default duplicate", { exact: true }))
        .not.toBeInTheDocument();
      await expect
        .element(page.getByText("Empty identifier", { exact: true }))
        .not.toBeInTheDocument();
      await expect.element(page.getByText("Camera", { exact: true })).not.toBeInTheDocument();
      await page.getByRole("option", { name: "System default" }).click();

      harness.setGlobalShortcut.mockResolvedValueOnce({
        reason: null,
        registered: false,
        shortcut: null,
      });
      const hotkeyButton = page.getByRole("button", { name: "Voice chat hotkey capture" });
      await expect.element(hotkeyButton).toHaveTextContent("Off");
      await hotkeyButton.click();
      window.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          ctrlKey: true,
          key: "k",
        }),
      );

      await expect.element(page.getByText("Failed to update voice chat hotkey")).toBeVisible();
      await expect.element(hotkeyButton).toHaveTextContent("Off");
    } finally {
      await mounted.unmount();
    }
  });

  it("distinguishes blocked microphone permission from an empty device inventory", async () => {
    harness.enumerateDevices.mockReset().mockResolvedValue([]);
    harness.getUserMedia
      .mockReset()
      .mockRejectedValue(new DOMException("permission denied", "NotAllowedError"));
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await expect
        .element(page.getByText("Allow microphone access to discover available inputs."))
        .toBeVisible();
      await page.getByRole("button", { name: "Check microphone access" }).click();
      await expect
        .element(
          page.getByText(
            "Microphone access is blocked. Enable Moss in macOS Privacy & Security > Microphone, then retry.",
          ),
        )
        .toBeVisible();
      await expect
        .element(page.getByRole("button", { name: "Retry microphone access" }))
        .toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("reports missing microphone hardware without telling the user to change permissions", async () => {
    harness.enumerateDevices.mockReset().mockResolvedValue([]);
    harness.getUserMedia
      .mockReset()
      .mockRejectedValue(new DOMException("no device", "NotFoundError"));
    const mounted = await render(<RealtimeVoiceSettingsPanel />);

    try {
      await page.getByRole("button", { name: "Check microphone access" }).click();
      await expect
        .element(page.getByText("No microphone is connected. Connect one, then retry."))
        .toBeVisible();
      await expect.element(page.getByRole("button", { name: "Refresh microphones" })).toBeVisible();
      await expect.element(page.getByText(/Privacy & Security/u)).not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });
});
