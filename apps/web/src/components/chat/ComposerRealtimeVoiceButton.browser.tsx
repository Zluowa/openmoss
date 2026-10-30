// FILE: ComposerRealtimeVoiceButton.browser.tsx
// Purpose: Lock the current Codex five-bar Realtime Voice composer affordance.
// Layer: Browser UI test

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { ComposerRealtimeVoiceButton } from "./ComposerRealtimeVoiceButton";

afterEach(() => {
  document.body.replaceChildren();
});

describe("ComposerRealtimeVoiceButton", () => {
  it("uses the five-bar Codex voice glyph for start and return modes", async () => {
    for (const mode of ["start", "return"] as const) {
      const mounted = await render(
        <ComposerRealtimeVoiceButton busy={false} disabled={false} mode={mode} onClick={vi.fn()} />,
      );
      try {
        const button = page.getByRole("button", {
          name: mode === "start" ? "Start voice chat" : "Open voice chat",
        });
        await expect.element(button).toBeVisible();
        const icon = document.querySelector<HTMLElement>(
          '[data-moss-realtime-voice-bars-icon="true"]',
        );
        if (!icon) throw new Error("Realtime Voice bars icon missing");
        expect(icon.children).toHaveLength(5);
        expect(Array.from(icon.children).map((bar) => (bar as HTMLElement).style.height)).toEqual([
          "4.15px",
          "12.17px",
          "6.83px",
          "9.5px",
          "4.15px",
        ]);
      } finally {
        await mounted.unmount();
      }
    }
  });
});
