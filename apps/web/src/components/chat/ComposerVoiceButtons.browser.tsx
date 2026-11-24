// Walk 2026-11-24 (V-1): hovering the composer's voice button showed no label. Both voice
// buttons name themselves in a Moss tooltip, also while they are disabled (signed out).

import "../../index.css";

import { page } from "vitest/browser";
import { afterEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { ComposerRealtimeVoiceButton } from "./ComposerRealtimeVoiceButton";
import { ComposerVoiceButton } from "./ComposerVoiceButton";

const screens: Awaited<ReturnType<typeof render>>[] = [];
afterEach(async () => {
  for (const screen of screens.splice(0)) await screen.unmount();
});

function shownTooltips(): string[] {
  return Array.from(document.querySelectorAll<HTMLElement>("[data-slot='tooltip-popup']"))
    .filter((popup) => {
      const rect = popup.getBoundingClientRect();
      return (
        rect.width > 0 && popup.checkVisibility({ opacityProperty: true, visibilityProperty: true })
      );
    })
    .map((popup) => popup.textContent ?? "");
}

it("names the disabled voice-chat and dictation buttons on hover", async () => {
  screens.push(
    await render(
      <MossLocaleScope locale="en">
        <div style={{ display: "flex", gap: 40, padding: 80 }}>
          <ComposerRealtimeVoiceButton disabled busy={false} onClick={() => {}} />
          <ComposerVoiceButton
            appearance="circle"
            disabled
            isRecording={false}
            isTranscribing={false}
            durationLabel="0:00"
            onClick={() => {}}
          />
        </div>
      </MossLocaleScope>,
    ),
  );
  const voiceChat = page.getByRole("button", { name: "Start voice chat" });
  await expect.element(voiceChat).toBeDisabled();
  await page.elementLocator(voiceChat.element().parentElement!).hover();
  await expect.poll(shownTooltips).toEqual(["Start voice chat"]);

  const dictate = page.getByRole("button", { name: "Dictate" });
  await expect.element(dictate).toBeDisabled();
  await page.elementLocator(dictate.element().parentElement!).hover();
  await expect.poll(shownTooltips).toEqual(["Dictate"]);
});
