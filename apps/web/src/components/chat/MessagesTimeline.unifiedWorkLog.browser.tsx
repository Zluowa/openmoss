// FILE: MessagesTimeline.unifiedWorkLog.browser.tsx
// Purpose: The owner's 2026-11-21 report: a Codex turn listed every reasoning
//          heading in bold with one raw command row between each. A turn that
//          thinks between its calls must read the same for Codex and Claude:
//          one folded line ("运行了 3 条命令…") that opens onto quiet reasoning
//          lines and short command rows in one icon column, with the whole
//          command in the row's details.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, TurnId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { page } from "vitest/browser";

// The product's own language: assert and photograph the Chinese copy.
vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "zh-CN" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("zh-CN", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("zh-CN", key, values),
    }),
  };
});

import { MessagesTimeline } from "./MessagesTimeline";
import {
  buildThemeCssVariables,
  DEFAULT_THEME_STATE,
  resolveThemePack,
} from "../../theme/theme.logic";
import type { TimelineEntry } from "../../session-logic";
import {
  WORK_RUN_TURN_ID,
  type WorkRunProvider,
  type WorkRunStep,
  workRunActivities,
  workRunEntries,
} from "../../test/fixtures/providerWorkRun.fixture";

// Codex on Windows persists the PowerShell launcher line, POSIX-quoted with its
// backslashes doubled (codexOwnerImageTurn.fixture.ts); Claude runs Bash.
const POWERSHELL_EXE = '"C:\\\\WINDOWS\\\\System32\\\\WindowsPowerShell\\\\v1.0\\\\powershell.exe"';
const PROXY_SETUP =
  "$env:NO_PROXY='127.0.0.1,localhost'; Remove-Item Env:HTTP_PROXY,Env:HTTPS_PROXY,Env:ALL_PROXY -ErrorAction SilentlyContinue";

function shellLine(provider: WorkRunProvider, command: string): string {
  return provider === "codex"
    ? `${POWERSHELL_EXE} -Command "${PROXY_SETUP}; ${command}"`
    : `export NO_PROXY=127.0.0.1,localhost && ${command}`;
}

// The screenshot's turn, trimmed: a heading before every step.
function ownerShapedTurn(provider: WorkRunProvider): WorkRunStep[] {
  return [
    { kind: "think", text: "**Preparing static client assets**" },
    { kind: "command", command: shellLine(provider, "bun run build") },
    { kind: "think", text: "**Running source wsRpc tests**" },
    { kind: "command", command: shellLine(provider, "bun run test apps/server/src/wsRpc.test.ts") },
    { kind: "think", text: "**Reading wsRpc test patterns**\n\nThe suite builds its own layer." },
    { kind: "search", pattern: "serverGetSettings", path: "apps/server/src" },
    { kind: "think", text: "**Closing CDP with NO_PROXY**" },
    { kind: "command", command: shellLine(provider, "node scripts/close-cdp.mjs") },
    { kind: "think", text: "**Checking theme update flow**" },
    { kind: "read", path: "apps/web/src/theme.ts" },
    { kind: "think", text: "**Adding snapshot race test**" },
    { kind: "edit", path: "apps/server/src/wsRpc.test.ts" },
  ];
}

const CREATED_AT = "2026-11-20T16:00:00.000Z";

function timelineEntries(provider: WorkRunProvider): TimelineEntry[] {
  const work = workRunEntries(workRunActivities(provider, ownerShapedTurn(provider)));
  const turnId = TurnId.makeUnsafe(WORK_RUN_TURN_ID);
  return [
    {
      id: "entry-ask",
      kind: "message",
      createdAt: "2026-11-20T15:59:58.000Z",
      message: {
        id: MessageId.makeUnsafe(`ask-${provider}`),
        role: "user",
        text: "设置订阅偶尔拿不到最新值，修一下并补测试。",
        turnId,
        createdAt: "2026-11-20T15:59:58.000Z",
        streaming: false,
      },
    },
    ...work.map(
      (entry): TimelineEntry => ({
        id: `entry-${entry.id}`,
        kind: "work",
        createdAt: entry.createdAt,
        entry,
      }),
    ),
    {
      id: "entry-answer",
      kind: "message",
      createdAt: "2026-11-20T16:01:00.000Z",
      message: {
        id: MessageId.makeUnsafe(`answer-${provider}`),
        role: "assistant",
        text: "设置订阅已修好，测试通过。",
        turnId,
        createdAt: "2026-11-20T16:01:00.000Z",
        completedAt: "2026-11-20T16:01:00.000Z",
        streaming: false,
      },
    },
  ];
}

const themedVariables = new Set<string>();

// The app's own theme pack, so the photos show what a person sees.
function applyTheme(theme: "light" | "dark") {
  const root = document.documentElement;
  root.classList.toggle("dark", theme === "dark");
  const build = buildThemeCssVariables(resolveThemePack(DEFAULT_THEME_STATE, theme), theme, {
    electron: false,
    isMac: false,
  });
  for (const [name, value] of Object.entries(build.variables)) {
    root.style.setProperty(name, value);
    themedVariables.add(name);
  }
}

async function renderTurn(provider: WorkRunProvider, theme: "light" | "dark") {
  await page.viewport(760, 720);
  const host = document.createElement("div");
  host.className = "bg-background text-foreground";
  host.style.cssText =
    "display:flex;flex-direction:column;width:720px;height:680px;overflow:hidden;padding:12px;";
  document.body.append(host);
  return render(
    <MessagesTimeline
      hasMessages
      isWorking={false}
      activeTurnInProgress={false}
      activeTurnStartedAt={null}
      timelineEntries={timelineEntries(provider)}
      turnDiffSummaryByAssistantMessageId={new Map()}
      nowIso={CREATED_AT}
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
      onOpenAgentActivity={() => {}}
    />,
    { container: host },
  ).then((screen) => {
    // After mount: the app's theme hook applies the saved (light) theme first.
    applyTheme(theme);
    return { screen, host };
  });
}

function settledTurnFold(): HTMLButtonElement | null {
  return (
    [...document.querySelectorAll<HTMLButtonElement>("button[aria-expanded]")].find(
      (button) =>
        button.closest("[data-tool-group-disclosure]") === null &&
        /已工作|之前的/u.test(button.textContent ?? ""),
    ) ?? null
  );
}

async function openSettledTurn(): Promise<void> {
  const fold = settledTurnFold;
  await expect.poll(() => fold() !== null).toBe(true);
  fold()!.click();
  await expect.poll(() => fold()!.getAttribute("aria-expanded")).toBe("true");
}

function summaryTrigger(): HTMLButtonElement | null {
  return document.querySelector<HTMLButtonElement>(
    "[data-tool-group-disclosure] button[aria-expanded]",
  );
}

function rowWithText(text: string): HTMLElement | null {
  return (
    [...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]")].find((element) =>
      (element.textContent ?? "").includes(text),
    ) ?? null
  );
}

// Disclosures animate open (220 ms) and the list then remeasures the row.
async function settle(): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, 700));
}

function iconLeftOf(text: string): number | null {
  const label = [...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]")].find(
    (element) => (element.textContent ?? "").includes(text),
  );
  let node: HTMLElement | null = label ?? null;
  while (node && !node.querySelector("[data-work-entry-icon]")) node = node.parentElement;
  const icon = node?.querySelector<HTMLElement>("[data-work-entry-icon]");
  return icon ? Math.round(icon.getBoundingClientRect().left) : null;
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  for (const name of themedVariables) document.documentElement.style.removeProperty(name);
  themedVariables.clear();
  document.body.innerHTML = "";
});

describe("one work log for Codex and Claude turns", () => {
  for (const provider of ["codex", "claudeAgent"] as const) {
    for (const theme of ["light", "dark"] as const) {
      it(`${provider} (${theme}): folds the turn into one line that opens onto quiet rows`, async () => {
        const { screen, host } = await renderTurn(provider, theme);
        try {
          // A settled turn folds behind its 已工作 line first (Moss's turn header).
          await openSettledTurn();
          await expect.poll(() => summaryTrigger() !== null).toBe(true);
          const trigger = summaryTrigger()!;
          // One line for the whole turn; nothing of it is listed yet.
          expect(document.querySelectorAll("[data-tool-group-disclosure]")).toHaveLength(1);
          expect(trigger.getAttribute("aria-expanded")).toBe("false");
          expect(trigger.textContent).toMatch(/^运行了 3 条命令、搜索了 1 次代码/u);
          expect(document.body.textContent).not.toContain("Running source wsRpc tests");
          expect(document.body.textContent).not.toContain("$env:");
          await settle();
          await page.elementLocator(host).screenshot({
            path: `__screenshots__/unified-work-log/${provider}-${theme}-folded.png`,
          });

          trigger.click();
          await expect.poll(() => trigger.getAttribute("aria-expanded")).toBe("true");
          await expect.poll(() => rowWithText("Running source wsRpc tests") !== null).toBe(true);

          // Reasoning reads as a quiet line, not a bold heading.
          const thought = [
            ...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]"),
          ].find((element) => element.textContent === "Running source wsRpc tests")!;
          expect(Number(getComputedStyle(thought).fontWeight)).toBeLessThan(600);
          expect(thought.closest("strong, h1, h2, h3")).toBeNull();
          expect(document.querySelector("[data-work-entry-prose]")).toBeNull();

          // The command row names what ran, without the proxy setup before it.
          const command = [
            ...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]"),
          ].find((element) => (element.textContent ?? "").includes("wsRpc.test.ts"))!;
          expect(command.textContent).toContain("bun run test apps/server/src/wsRpc.test.ts");
          expect(command.textContent).not.toContain("NO_PROXY");

          // Search and read rows read the same whichever agent made them.
          for (const sentence of ["已搜索 serverGetSettings（server/src）", "已读取 theme.ts"]) {
            expect(rowWithText(sentence)?.textContent?.replace(/\s+/gu, " ").trim()).toBe(sentence);
          }

          // Every row, thought or call, keeps its glyph in the same column.
          const lefts = [
            "Preparing static client assets",
            "bun run build",
            "Reading wsRpc test patterns",
            "Checking theme update flow",
          ].map(iconLeftOf);
          expect(lefts.every((left) => left !== null)).toBe(true);
          expect(new Set(lefts).size).toBe(1);
          // ...and every row is the same height: one even rhythm down the list.
          const tops = [
            ...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]"),
          ].map((label) => Math.round(label.getBoundingClientRect().top));
          const steps = tops.slice(1).map((top, index) => top - tops[index]!);
          expect(new Set(steps).size, steps.join(",")).toBe(1);
          await settle();
          await page
            .elementLocator(host)
            .screenshot({ path: `__screenshots__/unified-work-log/${provider}-${theme}-open.png` });
        } finally {
          await screen.unmount();
          host.remove();
        }
      });
    }
  }

  it("keeps the whole command, setup included, in the row's details", async () => {
    const { screen, host } = await renderTurn("codex", "light");
    try {
      await openSettledTurn();
      await expect.poll(() => summaryTrigger() !== null).toBe(true);
      summaryTrigger()!.click();
      await expect.poll(() => rowWithText("bun run build") !== null).toBe(true);
      const label = [
        ...document.querySelectorAll<HTMLElement>("[data-work-entry-display-text]"),
      ].find((element) => (element.textContent ?? "").includes("bun run build"))!;
      label.click();
      await expect
        .poll(() => document.body.textContent ?? "")
        .toContain("$env:NO_PROXY='127.0.0.1,localhost'");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
