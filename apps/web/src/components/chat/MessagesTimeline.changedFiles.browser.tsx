// FILE: MessagesTimeline.changedFiles.browser.tsx
// Purpose: Browser regressions for the changed-files row cap and expansion.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { TimelineEntry } from "../../session-logic";
import { MessagesTimeline } from "./MessagesTimeline";

const ASSISTANT_MESSAGE_ID = MessageId.makeUnsafe("changed-files-assistant");
const VISIBLE_FILE_PATHS = Array.from(
  { length: 5 },
  (_, index) => `apps/web/src/visible-${index + 1}.tsx`,
);
const OVERFLOW_FILE_PATHS = Array.from(
  { length: 3 },
  (_, index) => `apps/web/src/overflow-${index + 1}.tsx`,
);

const TIMELINE_ENTRIES: TimelineEntry[] = [
  {
    id: "changed-files-entry",
    kind: "message",
    createdAt: "2026-03-17T19:12:29.000Z",
    message: {
      id: ASSISTANT_MESSAGE_ID,
      role: "assistant",
      text: "done",
      createdAt: "2026-03-17T19:12:29.000Z",
      completedAt: "2026-03-17T19:12:30.000Z",
      streaming: false,
    },
  },
];

function ChangedFilesTimeline({
  overflowFilePaths = OVERFLOW_FILE_PATHS,
}: {
  overflowFilePaths?: readonly string[];
}) {
  const files = [...VISIBLE_FILE_PATHS, ...overflowFilePaths].map((path) => ({
    path,
    additions: 1,
    deletions: 0,
  }));

  return (
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={TIMELINE_ENTRIES}
      turnDiffSummaryByAssistantMessageId={
        new Map([
          [
            ASSISTANT_MESSAGE_ID,
            {
              turnId: TurnId.makeUnsafe("changed-files-turn"),
              completedAt: "2026-03-17T19:12:30.000Z",
              assistantMessageId: ASSISTANT_MESSAGE_ID,
              files,
            },
          ],
        ])
      }
      nowIso="2026-03-17T19:12:30.000Z"
      expandedWorkGroups={{}}
      onToggleWorkGroup={() => {}}
      onOpenTurnDiff={() => {}}
      revertTurnCountByUserMessageId={new Map()}
      onRevertUserMessage={() => {}}
      isRevertingCheckpoint={false}
      onImageExpand={() => {}}
      markdownCwd={undefined}
      resolvedTheme="dark"
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

function createTimelineHost(): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText =
    "display:flex;flex-direction:column;width:700px;height:520px;overflow:hidden;";
  document.body.append(host);
  return host;
}

describe("MessagesTimeline changed files", () => {
  afterEach(() => {
    document.body.innerHTML = "";
  });

  it("does not mount overflow rows until the user expands them", async () => {
    const host = createTimelineHost();
    const screen = await render(<ChangedFilesTimeline />, { container: host });

    try {
      await expect
        .poll(() => document.querySelectorAll('[data-edited-file-row="true"]').length)
        .toBe(VISIBLE_FILE_PATHS.length);
      for (const path of OVERFLOW_FILE_PATHS) {
        expect(document.querySelector(`button[aria-label="Review changes to ${path}"]`)).toBeNull();
      }

      const expandButton = [...document.querySelectorAll<HTMLButtonElement>("button")].find(
        (button) => (button.textContent ?? "").includes("Show 3 more files"),
      );
      expect(expandButton).toBeDefined();
      expect(expandButton?.getAttribute("aria-expanded")).toBe("false");
      expandButton?.click();

      await expect
        .poll(() => document.querySelectorAll('[data-edited-file-row="true"]').length)
        .toBe(VISIBLE_FILE_PATHS.length + OVERFLOW_FILE_PATHS.length);
      for (const path of OVERFLOW_FILE_PATHS) {
        expect(
          document.querySelector(`button[aria-label="Review changes to ${path}"]`),
        ).not.toBeNull();
      }
      await expect.poll(() => expandButton?.getAttribute("aria-expanded")).toBe("true");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps two overflow rows mounted without a trivial expansion", async () => {
    const host = createTimelineHost();
    const overflowFilePaths = OVERFLOW_FILE_PATHS.slice(0, 2);
    const screen = await render(<ChangedFilesTimeline overflowFilePaths={overflowFilePaths} />, {
      container: host,
    });

    try {
      await expect
        .poll(() => document.querySelectorAll('[data-edited-file-row="true"]').length)
        .toBe(VISIBLE_FILE_PATHS.length + overflowFilePaths.length);
      for (const path of overflowFilePaths) {
        expect(
          document.querySelector(`button[aria-label="Review changes to ${path}"]`),
        ).not.toBeNull();
      }
      expect(
        [...document.querySelectorAll<HTMLButtonElement>("button")].find((button) =>
          (button.textContent ?? "").includes("more files"),
        ),
      ).toBeUndefined();
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("renders the redesigned edited-files card with Moss icons and clean file paths in light and dark themes", async () => {
    await page.viewport(760, 560);
    const externalScript = "C:\\DevTemp\\moss-runs\\ui-showcase\\sample-colors.ps1";
    for (const theme of ["light", "dark"] as const) {
      document.documentElement.classList.toggle("dark", theme === "dark");
      const host = createTimelineHost();
      const screen = await render(
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={TIMELINE_ENTRIES}
          turnDiffSummaryByAssistantMessageId={
            new Map([
              [
                ASSISTANT_MESSAGE_ID,
                {
                  turnId: TurnId.makeUnsafe(`single-file-turn-${theme}`),
                  completedAt: "2026-03-17T19:12:30.000Z",
                  assistantMessageId: ASSISTANT_MESSAGE_ID,
                  files: [{ path: externalScript, additions: 4, deletions: 2 }],
                },
              ],
            ])
          }
          nowIso="2026-03-17T19:12:30.000Z"
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
        />,
        { container: host },
      );

      try {
        await expect
          .poll(() => document.querySelector('[data-testid="edited-files-card"]'))
          .not.toBeNull();
        const card = document.querySelector<HTMLElement>('[data-testid="edited-files-card"]')!;
        const cardBox = card.getBoundingClientRect();
        expect(cardBox.width).toBeGreaterThan(200);
        expect(cardBox.height).toBeGreaterThan(60);

        const icons = [...card.querySelectorAll<HTMLElement>('[data-slot="central-icon"]')].map(
          (icon) => icon.getAttribute("style") ?? "",
        );
        // Header uses file-edit; script row uses console (never Mac cmd); actions use
        // external-link + ellipsis instead of a foreign app logo or second chevron.
        expect(icons.some((style) => style.includes("/file-edit.svg"))).toBe(true);
        expect(icons.some((style) => style.includes("/console.svg"))).toBe(true);
        expect(icons.some((style) => style.includes("/cmd.svg"))).toBe(false);
        expect(icons.some((style) => style.includes("/square-arrow-top-right.svg"))).toBe(true);
        expect(icons.some((style) => style.includes("/dot-grid-1x3-horizontal.svg"))).toBe(true);
        // Only the card header has a disclosure chevron, not the file rows.
        expect(icons.filter((style) => style.includes("/chevron-down-medium.svg"))).toHaveLength(0);
        expect(icons.filter((style) => style.includes("/chevron-right-medium.svg"))).toHaveLength(
          1,
        );
        expect(card.querySelectorAll("svg, img")).toHaveLength(0);

        // Clean basename + immediate folder; no raw C:\DevTemp\... path clutter in visible text.
        expect(card.querySelector("[data-edited-file-name]")?.textContent).toBe(
          "sample-colors.ps1",
        );
        expect(card.querySelector("[data-edited-file-dir]")?.textContent).toBe("ui-showcase");
        expect(card.textContent).not.toContain("C:\\DevTemp");
      } finally {
        await screen.unmount();
        host.remove();
        document.documentElement.classList.remove("dark");
      }
    }
  });
});
