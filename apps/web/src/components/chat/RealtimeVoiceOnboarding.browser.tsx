// FILE: RealtimeVoiceOnboarding.browser.tsx
// Purpose: Exercise the first-launch Voice setup in a real Chromium renderer.
// Layer: Browser UI test

import "../../index.css";

import type { DesktopAppSnapState, RealtimeVoiceDescriptor } from "@synara/contracts";
import axe from "axe-core";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  listVoices: vi.fn(),
  requestPermissions: vi.fn(),
  setEnabled: vi.fn(),
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({ realtimeVoice: { listVoices: harness.listVoices } }),
}));

import { REALTIME_VOICE_CATALOG } from "~/lib/realtimeVoicePreferences";

import {
  RealtimeVoiceOnboarding,
  REALTIME_VOICE_ONBOARDING_COMPLETION_KEY,
} from "./RealtimeVoiceOnboarding";

function appSnapState(overrides: Partial<DesktopAppSnapState> = {}): DesktopAppSnapState {
  return {
    appDisplayName: "Moss",
    enabled: true,
    inputMonitoringPermission: "granted",
    message: null,
    platform: "macos",
    screenRecordingPermission: "granted",
    shortcut: { kind: "both-option-keys" },
    status: "ready",
    supported: true,
    ...overrides,
  };
}

function voiceResult(voices: readonly RealtimeVoiceDescriptor[] = REALTIME_VOICE_CATALOG) {
  return { defaultVoice: "maple" as const, preferredTransport: "webrtc" as const, voices };
}

function setDesktopBridge(value: unknown): void {
  Object.defineProperty(window, "desktopBridge", { configurable: true, value });
}

beforeEach(async () => {
  await page.viewport(1_280, 800);
  localStorage.clear();
  harness.listVoices.mockReset().mockResolvedValue(voiceResult());
  harness.setEnabled.mockReset().mockImplementation(async (enabled: boolean) =>
    enabled
      ? appSnapState({
          inputMonitoringPermission: "not-determined",
          message: "Allow AppSnap permissions.",
          screenRecordingPermission: "not-determined",
          status: "permission-required",
        })
      : appSnapState({ enabled: false, status: "disabled" }),
  );
  harness.requestPermissions.mockReset().mockResolvedValue(appSnapState());
  setDesktopBridge({
    appSnap: {
      requestPermissions: harness.requestPermissions,
      setEnabled: harness.setEnabled,
    },
  });
  vi.stubGlobal(
    "fetch",
    vi.fn().mockResolvedValue(
      new Response(
        JSON.stringify({
          version: 1,
          voices: Object.fromEntries(
            REALTIME_VOICE_CATALOG.map((voice) => [
              voice.id,
              `/realtime-voice-previews/${voice.id}.wav`,
            ]),
          ),
        }),
        { headers: { "content-type": "application/json" }, status: 200 },
      ),
    ),
  );
});

afterEach(() => {
  document.body.replaceChildren();
  setDesktopBridge(undefined);
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RealtimeVoiceOnboarding", () => {
  it("runs the macOS three-step flow in voice-first order and persists only when Start voice chat completes setup", async () => {
    const onClose = vi.fn();
    const onCompleteStart = vi.fn();
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="MacIntel"
        onClose={onClose}
        onCompleteStart={onCompleteStart}
      />,
    );

    try {
      await expect.element(page.getByRole("heading", { name: "Set up voice chat" })).toBeVisible();
      await expect.element(page.getByRole("heading", { name: "Meet Moss Voice" })).toBeVisible();
      for (const copy of [
        "Work across projects",
        "Work across your desktop",
        "Explore, plan, and learn",
      ]) {
        await expect.element(page.getByRole("heading", { name: copy })).toBeVisible();
      }
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      await page.getByRole("button", { name: "Next voice" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Sol: Savvy and relaxed" }))
        .toHaveAttribute("aria-checked", "true");
      expect(harness.setEnabled).not.toHaveBeenCalled();
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBeNull();

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Bring your screen into the conversation" }))
        .toBeVisible();
      await vi.waitFor(() => {
        expect(harness.setEnabled).toHaveBeenCalledWith(true);
        expect(harness.requestPermissions).toHaveBeenCalledOnce();
      });
      await expect.element(page.getByRole("switch", { name: "Use Appshots" })).toBeChecked();
      expect(localStorage.getItem("moss.realtimeVoice.screenContext.v1")).toBe("enabled");
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();

      await page.getByRole("button", { name: "Back" }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      expect(harness.setEnabled).toHaveBeenCalledOnce();
      expect(harness.requestPermissions).toHaveBeenCalledOnce();

      await expect
        .element(page.getByRole("heading", { name: "Bring your screen into the conversation" }))
        .toBeVisible();

      await page.getByRole("button", { name: "Start voice chat" }).click();
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBe("sol");
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(onCompleteStart).toHaveBeenCalledOnce();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps setup incomplete when closed and skips Appshots outside macOS", async () => {
    const onClose = vi.fn();
    const first = await render(
      <RealtimeVoiceOnboarding
        open
        platform="MacIntel"
        onClose={onClose}
        onCompleteStart={vi.fn()}
      />,
    );
    try {
      await page.getByRole("button", { name: "Close voice chat setup" }).click();
      expect(onClose).toHaveBeenCalledOnce();
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();
    } finally {
      await first.unmount();
    }

    const second = await render(
      <RealtimeVoiceOnboarding
        open
        platform="Linux x86_64"
        onClose={vi.fn()}
        onCompleteStart={vi.fn()}
      />,
    );
    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      expect(harness.setEnabled).not.toHaveBeenCalled();
      await page.getByRole("button", { name: "Back" }).click();
      await expect.element(page.getByRole("heading", { name: "Meet Moss Voice" })).toBeVisible();
    } finally {
      await second.unmount();
    }
  });

  it("matches the build 6119 picker geometry and keeps selection temporary until Start", async () => {
    const onClose = vi.fn();
    const onCompleteStart = vi.fn();
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="MacIntel"
        onClose={onClose}
        onCompleteStart={onCompleteStart}
      />,
    );

    try {
      // The frozen Codex flow records one Next action before the voice picker
      // and one before the Appshots step.
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();

      const dialog = document.querySelector<HTMLElement>("[data-moss-realtime-voice-onboarding]");
      const canvas = dialog?.querySelector<HTMLCanvasElement>("canvas");
      const previous = dialog?.querySelector<HTMLButtonElement>(
        'button[aria-label="Previous voice"]',
      );
      const next = dialog?.querySelector<HTMLButtonElement>('button[aria-label="Next voice"]');
      const nextAction = page.getByRole("button", { name: "Next", exact: true }).element();
      const close = page.getByRole("button", { name: "Close voice chat setup" }).element();
      if (!dialog || !canvas || !previous || !next || !nextAction) {
        throw new Error("Build 6119 voice picker geometry is incomplete");
      }

      const measured = {
        canvas: [canvas.getBoundingClientRect().width, canvas.getBoundingClientRect().height],
        close: [close.getBoundingClientRect().width, close.getBoundingClientRect().height],
        dialog: [dialog.getBoundingClientRect().width, dialog.getBoundingClientRect().height],
        next: [next.getBoundingClientRect().width, next.getBoundingClientRect().height],
        previous: [previous.getBoundingClientRect().width, previous.getBoundingClientRect().height],
        nextAction: [
          nextAction.getBoundingClientRect().width,
          nextAction.getBoundingClientRect().height,
        ],
      };
      expect(measured).toEqual({
        canvas: [184, 184],
        close: [24, 24],
        dialog: [480, 520],
        next: [34, 34],
        previous: [34, 34],
        nextAction: [118, 32],
      });
      const dialogRect = dialog.getBoundingClientRect();
      const closeRect = close.getBoundingClientRect();
      expect(closeRect.top - dialogRect.top).toBe(16);
      expect(dialogRect.right - closeRect.right).toBe(16);
      expect(getComputedStyle(canvas).filter).toBe("none");

      document.documentElement.classList.add("dark");
      try {
        const backdrop = document.querySelector<HTMLElement>('[data-slot="dialog-backdrop"]');
        if (!backdrop) throw new Error("Build 6119 voice setup backdrop is missing");
        expect(getComputedStyle(dialog).backgroundColor).toMatch(
          /^(?:rgba\(38, 38, 38, 0\.9\)|oklab\(0\.268617 .* \/ 0\.9\))$/,
        );
        expect(getComputedStyle(dialog).backdropFilter).toContain("blur(24px)");
        expect(getComputedStyle(backdrop).backgroundColor).toMatch(
          /^(?:rgba\(0, 0, 0, 0\.133\)|oklab\(0 0 0 \/ 0\.133\))$/,
        );
      } finally {
        document.documentElement.classList.remove("dark");
      }

      // Select the first voice explicitly, then prove both controls wrap and
      // that no preference is written before Start.
      await page.getByRole("radio", { name: "Arbor: Easygoing and versatile" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Arbor: Easygoing and versatile" }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Previous voice" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Vale: Bright and inquisitive" }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Next voice" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Arbor: Easygoing and versatile" }))
        .toHaveAttribute("aria-checked", "true");
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBeNull();

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Bring your screen into the conversation" }))
        .toBeVisible();
      await page.getByRole("button", { name: "Start voice chat" }).click();
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBe("arbor");
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();
      expect(onClose).toHaveBeenCalledOnce();
      expect(onCompleteStart).toHaveBeenCalledOnce();
      await expect.element(page.getByRole("button", { name: "Start voice chat" })).toBeDisabled();
      await expect
        .element(page.getByRole("button", { name: "Close voice chat setup" }))
        .not.toBeInTheDocument();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps the final-step selection temporary when Close dismisses setup", async () => {
    const onClose = vi.fn();
    const onCompleteStart = vi.fn();
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="Linux x86_64"
        onClose={onClose}
        onCompleteStart={onCompleteStart}
      />,
    );

    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      await page.getByRole("button", { name: "Next voice" }).click();
      await expect
        .element(page.getByRole("radio", { name: "Sol: Savvy and relaxed" }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("button", { name: "Close voice chat setup" }).click();

      expect(onClose).toHaveBeenCalledOnce();
      expect(onCompleteStart).not.toHaveBeenCalled();
      expect(localStorage.getItem("moss.realtimeVoice.voice.v1")).toBeNull();
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps catalog failure inside setup and makes both Back and Retry operational", async () => {
    harness.listVoices
      .mockReset()
      .mockRejectedValueOnce(new Error("voice catalog unavailable"))
      .mockResolvedValueOnce(voiceResult());
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="Linux x86_64"
        onClose={vi.fn()}
        onCompleteStart={vi.fn()}
      />,
    );

    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("Unable to load voice settings");
      await expect.element(page.getByRole("button", { name: "Retry" })).toBeEnabled();

      await page.getByRole("button", { name: "Back" }).click();
      await expect.element(page.getByRole("heading", { name: "Meet Moss Voice" })).toBeVisible();
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await page.getByRole("button", { name: "Retry" }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      await expect
        .element(page.getByRole("radio", { name: "Maple: Cheerful and candid" }))
        .toHaveAttribute("aria-checked", "true");
      expect(harness.listVoices).toHaveBeenCalledTimes(2);
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps Appshots failures visible without marking onboarding complete", async () => {
    harness.setEnabled.mockRejectedValueOnce(new Error("Screen Recording permission was denied."));
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="MacIntel"
        onClose={vi.fn()}
        onCompleteStart={vi.fn()}
      />,
    );
    try {
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect
        .element(page.getByRole("heading", { name: "Bring your screen into the conversation" }))
        .toBeVisible();
      await expect
        .element(page.getByRole("alert"))
        .toHaveTextContent("Appshots couldn’t be updated");
      await expect.element(page.getByText("Screen Recording permission was denied.")).toBeVisible();
      expect(localStorage.getItem(REALTIME_VOICE_ONBOARDING_COMPLETION_KEY)).toBeNull();
      await page.getByRole("button", { name: "Back" }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("stays within a 320px viewport, exposes keyboard dialog semantics, and has no serious axe findings", async () => {
    await page.viewport(320, 640);
    const mounted = await render(
      <RealtimeVoiceOnboarding
        open
        platform="Linux x86_64"
        onClose={vi.fn()}
        onCompleteStart={vi.fn()}
      />,
    );
    try {
      const dialog = document.querySelector<HTMLElement>("[data-moss-realtime-voice-onboarding]");
      if (!dialog) throw new Error("Voice onboarding dialog missing");
      const rect = dialog.getBoundingClientRect();
      expect(rect.width).toBeLessThanOrEqual(480);
      expect(rect.width).toBeLessThanOrEqual(window.innerWidth * 0.92 + 1);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(dialog.className).toContain("motion-reduce:transition-none");
      const results = await axe.run(dialog, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        resultTypes: ["violations"],
      });
      expect(
        results.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        ),
      ).toEqual([]);

      await page.getByRole("button", { name: "Next", exact: true }).click();
      await expect.element(page.getByRole("heading", { name: "Choose your voice" })).toBeVisible();
      const previousVoice = document.querySelector<HTMLElement>(
        'button[aria-label="Previous voice"]',
      );
      const nextVoice = document.querySelector<HTMLElement>('button[aria-label="Next voice"]');
      if (!previousVoice || !nextVoice) throw new Error("Compact voice controls missing");
      const compactDialogRect = dialog.getBoundingClientRect();
      expect(previousVoice.getBoundingClientRect().left).toBeGreaterThanOrEqual(
        compactDialogRect.left,
      );
      expect(nextVoice.getBoundingClientRect().right).toBeLessThanOrEqual(compactDialogRect.right);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
    } finally {
      await mounted.unmount();
    }
  });
});
