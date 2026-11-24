// FILE: longToolTurn.browser.tsx
// Purpose: A long turn with many tool rows, as a person sees it (L-013), light and dark, Chinese
//          and English: the settled run folds to one summary line (one line, at most 28 px) that says how many ran and
//          how many failed, opens by mouse or keyboard, and its rows share one height; nothing
//          floats over a row on hover (no native tooltip anywhere in the turn).
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { MessageId } from "@moss/contracts";
import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "~/appSettings";
import { MossLocaleScope } from "~/localization";
import type { TimelineEntry } from "../../session-logic";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { MessagesTimeline } from "./MessagesTimeline";

const CASES = (["light", "dark"] as const).flatMap((theme) =>
  (["zh-CN", "en"] as const).map((locale) => ({ theme, locale })),
);
const COMMAND_COUNT = 40;
const CREATED_AT = "2026-11-24T02:00:00.000Z";

function commandEntry(index: number, failed: boolean): TimelineEntry {
  return {
    id: `entry-cmd-${index}`,
    kind: "work",
    createdAt: CREATED_AT,
    entry: {
      id: `cmd-${index}`,
      createdAt: CREATED_AT,
      label: "Ran command",
      tone: "tool",
      itemType: "command_execution",
      toolStatus: failed ? "failed" : "completed",
      command: `node scripts/step-${index}.mjs`,
    },
  };
}

function assistantEntry(id: string, text: string): TimelineEntry {
  return {
    id: `entry-${id}`,
    kind: "message",
    createdAt: CREATED_AT,
    message: {
      id: MessageId.makeUnsafe(id),
      role: "assistant",
      text,
      createdAt: CREATED_AT,
      streaming: false,
    },
  };
}

const ENTRIES: TimelineEntry[] = [
  assistantEntry("before", "Checking every step."),
  ...Array.from({ length: COMMAND_COUNT }, (_, index) =>
    commandEntry(index, index === COMMAND_COUNT - 1),
  ),
  assistantEntry("after", "All steps ran; one failed."),
];

function summaryTrigger(): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("button[aria-expanded]")].find((element) =>
      (element.textContent ?? "").includes(String(COMMAND_COUNT)),
    ) ?? null
  );
}

describe.each(CASES)("a long turn of tool rows ($theme, $locale)", ({ theme, locale }) => {
  let restoreTheme: () => void = () => {};
  let host: HTMLDivElement;
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(900, 900);
    host = document.createElement("div");
    host.style.cssText =
      "display:flex;flex-direction:column;width:700px;height:800px;overflow:hidden;";
    document.body.append(host);
  });
  afterEach(() => {
    restoreTheme();
    host.remove();
  });

  it("folds the run to one line with its counts, opens by keyboard, and rows share one height", async () => {
    await render(
      <BrowserThemeFixture>
        <MossLocaleScope locale={locale}>
          <MessagesTimeline
            hasMessages
            isWorking={false}
            activeTurnInProgress
            activeTurnStartedAt="2026-11-24T01:59:00.000Z"
            timelineEntries={ENTRIES}
            turnDiffSummaryByAssistantMessageId={new Map()}
            nowIso="2026-11-24T02:00:30.000Z"
            expandedWorkGroups={{}}
            onToggleWorkGroup={() => {}}
            onOpenTurnDiff={() => {}}
            revertTurnCountByUserMessageId={new Map()}
            onRevertUserMessage={() => {}}
            isRevertingCheckpoint={false}
            onImageExpand={() => {}}
            markdownCwd={undefined}
            resolvedTheme={theme}
            timestampFormat="locale"
            workspaceRoot={undefined}
          />
        </MossLocaleScope>
      </BrowserThemeFixture>,
      { container: host },
    );

    await expect.poll(() => summaryTrigger() !== null).toBe(true);
    const trigger = summaryTrigger()!;
    expect(trigger.tagName).toBe("BUTTON");
    expect(trigger.getAttribute("aria-expanded")).toBe("false");
    // One line: never taller than a small control, whatever the count says.
    expect(trigger.getBoundingClientRect().height).toBeGreaterThanOrEqual(24);
    expect(trigger.getBoundingClientRect().height).toBeLessThanOrEqual(28);
    expect(trigger.textContent).toContain(locale === "zh-CN" ? "1 个失败" : "1 failed");
    // Nothing floats over any row on hover.
    expect(host.querySelector("[title]")).toBeNull();
    await userEvent.hover(page.elementLocator(trigger));
    await new Promise((resolve) => window.setTimeout(resolve, 350));
    expect(document.querySelector('[data-slot="tooltip-popup"]')).toBeNull();

    trigger.focus();
    await userEvent.keyboard("{Enter}");
    await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
    await expect
      .poll(() => host.querySelectorAll("[data-work-entry-display-text='true']").length)
      .toBeGreaterThan(5);
    const rows = [...host.querySelectorAll<HTMLElement>("[data-work-entry-display-text='true']")]
      .map((text) => text.closest("p"))
      .filter((row): row is HTMLParagraphElement => row !== null);
    const heights = new Set(rows.map((row) => Math.round(row.getBoundingClientRect().height)));
    expect(heights.size).toBe(1);
    expect(host.querySelector("[title]")).toBeNull();
  });
});
