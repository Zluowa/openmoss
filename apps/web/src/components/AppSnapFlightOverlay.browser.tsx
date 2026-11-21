// FILE: AppSnapFlightOverlay.browser.tsx
// Purpose: Browser-level verification of the GPU-composited AppSnap fly-to-composer
//          motion, layout stability, settle handoff, and prefers-reduced-motion behavior.
// Layer: Browser UI test

import "../index.css";

import { afterEach, describe, expect, it, vi } from "vitest";
import { commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { ComposerImageAttachment } from "../composerDraftStore";
import {
  APP_SNAP_SETTLE_DURATION_MS,
  completeAppSnapFlight,
  launchAppSnapFlight,
  markAppSnapCaptureArrived,
  resetAppSnapArrivalStateForTests,
} from "../lib/appSnapArrival";
import { AppSnapFlightOverlay } from "./AppSnapFlightOverlay";
import { ComposerImageAttachmentChip } from "./chat/ComposerImageAttachmentChip";

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

// 1x1 crisp blue PNG data URL so Chromium decodes real image pixels deterministically.
const TEST_PNG_DATA_URL =
  "data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";

function makeAppSnapImage(captureId: string): ComposerImageAttachment {
  return {
    type: "image",
    id: `img-${captureId}`,
    name: `AppSnap-${captureId}.png`,
    mimeType: "image/png",
    sizeBytes: 68,
    previewUrl: TEST_PNG_DATA_URL,
    file: new File([new Uint8Array([0x89, 0x50, 0x4e, 0x47])], `AppSnap-${captureId}.png`, {
      type: "image/png",
    }),
    source: {
      kind: "appsnap",
      captureId,
      capturedAt: "2026-11-21T16:00:00.000Z",
      appName: "Chrome",
      bundleIdentifier: "chrome.exe",
      appIconDataUrl: null,
      windowTitle: "Moss Design Docs",
    },
  };
}

afterEach(async () => {
  resetAppSnapArrivalStateForTests();
  await motionCommands.emulateReducedMotion("no-preference");
  vi.restoreAllMocks();
});

describe("AppSnapFlightOverlay + ComposerImageAttachmentChip browser motion", () => {
  it("flies a GPU-composited preview into the reserved composer slot and hands off cleanly to settle", async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    const captureId = "live-win-flight-1";
    const image = makeAppSnapImage(captureId);

    markAppSnapCaptureArrived(captureId, undefined, { withReturnVeil: true });
    expect(
      launchAppSnapFlight({
        captureId,
        previewUrl: image.previewUrl,
        appName: "Chrome",
        windowTitle: "Moss Design Docs",
        appIconDataUrl: null,
        sourceWindowBounds: { x: 100, y: 80, width: 1200, height: 800 },
        withReturnVeil: true,
      }),
    ).toBe(true);

    const screen = await render(
      <div className="flex min-h-[640px] w-[900px] flex-col justify-end p-8">
        <AppSnapFlightOverlay />
        <div className="flex gap-2">
          <ComposerImageAttachmentChip
            image={image}
            images={[image]}
            nonPersisted={false}
            onRemoveImage={() => {}}
          />
        </div>
      </div>,
    );

    const targetChip = screen.container.querySelector<HTMLElement>(
      `[data-appsnap-capture-id="${captureId}"]`,
    );
    expect(targetChip).not.toBeNull();
    const initialBox = targetChip!.getBoundingClientRect();
    expect(initialBox.width).toBeGreaterThan(180);
    expect(initialBox.height).toBeGreaterThan(100);

    // Target slot holds exact layout size at opacity 0 while the flight card is in air.
    expect(targetChip!.getAttribute("data-appsnap-motion")).toBe("flying");
    expect(getComputedStyle(targetChip!).opacity).toBe("0");

    // Wait for visible-frame + image-decode + target measurement to mount the flight card.
    await vi.waitFor(() => {
      const flightCard = screen.container.querySelector<HTMLElement>(
        '[data-testid="appsnap-flight-card"]',
      );
      expect(flightCard).not.toBeNull();
      const flightStyle = getComputedStyle(flightCard!);
      expect(flightStyle.animationName).toBe("appsnap-fly-to-composer");
      expect(flightStyle.pointerEvents).toBe("none");
      const durationMs = Number.parseFloat(flightStyle.animationDuration) * 1000;
      expect(durationMs).toBeGreaterThanOrEqual(180);
      expect(durationMs).toBeLessThanOrEqual(280);
      const flightVeil = screen.container.querySelector<HTMLElement>(
        '[data-testid="appsnap-flight-veil"]',
      );
      expect(flightVeil).not.toBeNull();
    });

    // Complete flight -> overlay unmounts, chip becomes visible with settle micro-motion,
    // and layout box does not shift by even 1px.
    completeAppSnapFlight(captureId);
    await vi.waitFor(() => {
      expect(screen.container.querySelector('[data-testid="appsnap-flight-card"]')).toBeNull();
      expect(targetChip!.getAttribute("data-appsnap-motion")).toBe("settling");
      expect(getComputedStyle(targetChip!).opacity).toBe("1");
      expect(getComputedStyle(targetChip!).animationName).toBe("appsnap-chip-settle");
    });

    const settledBox = targetChip!.getBoundingClientRect();
    expect(Math.abs(settledBox.left - initialBox.left)).toBeLessThanOrEqual(2);
    expect(Math.abs(settledBox.top - initialBox.top)).toBeLessThanOrEqual(2);

    // Wait for settle window to clear cleanly back to idle.
    await new Promise((resolve) => setTimeout(resolve, APP_SNAP_SETTLE_DURATION_MS + 90));
    await vi.waitFor(() => {
      expect(targetChip!.getAttribute("data-appsnap-motion")).toBeNull();
      expect(targetChip!.getAttribute("data-appsnap-entering")).toBeNull();
    });
  });

  it("suppresses flight and chip animations under prefers-reduced-motion: reduce", async () => {
    await motionCommands.emulateReducedMotion("reduce");

    const captureId = "reduced-motion-1";
    const image = makeAppSnapImage(captureId);
    markAppSnapCaptureArrived(captureId, undefined, { withReturnVeil: true });
    expect(
      launchAppSnapFlight({
        captureId,
        previewUrl: image.previewUrl,
        appName: "Chrome",
        windowTitle: "Docs",
        appIconDataUrl: null,
        sourceWindowBounds: null,
        withReturnVeil: true,
      }),
    ).toBe(false);

    const screen = await render(
      <div className="p-8">
        <AppSnapFlightOverlay />
        <ComposerImageAttachmentChip
          image={image}
          images={[image]}
          nonPersisted={false}
          onRemoveImage={() => {}}
        />
      </div>,
    );

    const chip = screen.container.querySelector<HTMLElement>(
      `[data-appsnap-capture-id="${captureId}"]`,
    );
    expect(chip).not.toBeNull();
    expect(screen.container.querySelector('[data-testid="appsnap-flight-card"]')).toBeNull();
    expect(chip!.getAttribute("data-appsnap-motion")).toBeNull();
    expect(getComputedStyle(chip!).opacity).toBe("1");
    expect(getComputedStyle(chip!).animationName).toBe("none");
  });

  it("renders hydrated drafts silently without flight or entrance motion", async () => {
    const captureId = "hydrated-reload-1";
    const image = makeAppSnapImage(captureId);

    const screen = await render(
      <div className="p-8">
        <AppSnapFlightOverlay />
        <ComposerImageAttachmentChip
          image={image}
          images={[image]}
          nonPersisted={false}
          onRemoveImage={() => {}}
        />
      </div>,
    );

    const chip = screen.container.querySelector<HTMLElement>(
      `[data-appsnap-capture-id="${captureId}"]`,
    );
    expect(chip).not.toBeNull();
    expect(screen.container.querySelector('[data-testid="appsnap-flight-card"]')).toBeNull();
    expect(chip!.getAttribute("data-appsnap-entering")).toBeNull();
    expect(getComputedStyle(chip!).opacity).toBe("1");
    expect(getComputedStyle(chip!).animationName).toBe("none");
  });
});
