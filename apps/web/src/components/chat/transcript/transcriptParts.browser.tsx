// FILE: transcriptParts.browser.tsx
// Purpose: The 对话 screen's small transcript parts on the shared set (WO-24 §2), light and dark,
//          Chinese and English: a chapter heading in medium weight (only page and dialog titles
//          are semibold), the ask-first box of an outside image with no operating-system tooltip,
//          a long message from another chat whose 显示更多 is the shared button, and the peer line's
//          caret, the redacted-secret toggle and the thread chip as real keyboard buttons.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../../index.css";

import { MessageId, ThreadId } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "~/appSettings";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../../test/browserThemeFixture";
import { ChapterHeading } from "./ChapterHeading";
import { ExternalImage } from "./ExternalImage";
import { PEER_MESSAGE_CLAMP_CHARS, PeerMessageCard } from "./PeerMessageCard";

const CASES = (["light", "dark"] as const).flatMap((theme) =>
  (["zh-CN", "en"] as const).map((locale) => ({ theme, locale })),
);
const px = (value: string) => Number.parseFloat(value);

function Stage(props: { locale: MossLocaleCode; children: React.ReactNode }) {
  return (
    <BrowserThemeFixture>
      <MossLocaleScope locale={props.locale}>
        <div className="w-[640px] bg-background p-6 text-foreground">{props.children}</div>
      </MossLocaleScope>
    </BrowserThemeFixture>
  );
}

describe.each(CASES)("transcript parts ($theme, $locale)", ({ theme, locale }) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(900, 900);
  });
  afterEach(() => restoreTheme());

  it("draws a chapter heading in medium weight", async () => {
    await render(
      <Stage locale={locale}>
        <ChapterHeading messageId="m-1" title="整理发布清单" />
      </Stage>,
    );
    const heading = document.querySelector<HTMLElement>("[data-chapter-heading]")!;
    expect(Number(getComputedStyle(heading).fontWeight)).toBeLessThan(500);
  });

  it("asks before loading an outside image, in a card-radius box with no native tooltip", async () => {
    await render(
      <Stage locale={locale}>
        <ExternalImage src="https://example.com/chart.png" alt="chart" />
      </Stage>,
    );
    const box = document.querySelector<HTMLElement>("[data-external-image]")!;
    expect(box.tagName).toBe("BUTTON");
    expect(box.hasAttribute("title")).toBe(false);
    expect(px(getComputedStyle(box).borderTopLeftRadius)).toBe(12);
    box.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => document.querySelector('[role="alertdialog"]')).not.toBeNull();
    expect(document.querySelector('[role="alertdialog"]')!.textContent).toContain(
      "https://example.com/chart.png",
    );
  });

  it("shows more of a long message from another chat with the shared button", async () => {
    const text = "长".repeat(PEER_MESSAGE_CLAMP_CHARS + 40);
    await render(
      <Stage locale={locale}>
        <PeerMessageCard
          messageId={MessageId.makeUnsafe(`peer-${theme}-${locale}`)}
          sourceThreadId={ThreadId.makeUnsafe("sender")}
          textLength={text.length}
        >
          <p>{text}</p>
        </PeerMessageCard>
      </Stage>,
    );
    // The caret that opens the message is a real button, reachable by keyboard.
    const caret = document.querySelector<HTMLElement>("[data-transcript-disclosure-toggle]")!;
    expect(caret.tagName).toBe("BUTTON");
    caret.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => caret.getAttribute("aria-expanded")).toBe("true");
    const more = [...document.querySelectorAll<HTMLElement>("button[aria-expanded]")].find(
      (button) => button !== caret,
    )!;
    expect(more.getAttribute("data-slot")).toBe("button");
    expect(px(getComputedStyle(more).fontSize)).toBe(13);
    expect(more.getBoundingClientRect().height).toBeLessThanOrEqual(24);
    await userEvent.click(page.elementLocator(more));
    expect(more.getAttribute("aria-expanded")).toBe("true");
  });
});
