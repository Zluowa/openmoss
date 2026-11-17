// FILE: MessagesTimeline.ownerCodexTurn.browser.tsx
// Purpose: Renders the owner's real Codex turn of 2026-11-17 (Windows, PowerShell
//          commands, reasoning items, a generated image, Moss MCP tools ending in
//          moss_wrap_up) and checks what a person sees: the turn folds and unfolds
//          the way Synara does, command rows name the real command, reasoning reads
//          as text and opens nothing, rows never overlap, a picture that cannot load
//          says so and loads on reload, and the wrap-up box draws.
// Layer: Vitest browser tests

import "../../index.css";

import { MessageId, type TurnId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "../../appSettings";
import { buildThemeCssVariables, DEFAULT_CHROME_THEME_BY_VARIANT } from "../../theme/theme.logic";
import {
  codexOwnerTimelineEntries,
  codexOwnerTurnId,
} from "../../test/fixtures/codexOwnerImageTurn.timeline";
import { codexOwnerImageTurn } from "../../test/fixtures/codexOwnerImageTurn.fixture";
import { MessagesTimeline } from "./MessagesTimeline";
import type { TurnTiming } from "./MessagesTimeline.logic";

const testState = vi.hoisted(() => ({
  locale: "zh-CN" as MossLocaleCode,
  // The server cannot serve the owner's picture yet (moss-agent-runtime's order);
  // the first load fails, a person's reload succeeds.
  imageServed: false,
}));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: testState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(testState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(testState.locale, key, values),
    }),
  };
});

vi.mock("~/lib/localImageUrls", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/lib/localImageUrls")>();
  const picture = `data:image/svg+xml;charset=utf-8,${encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="1024" height="1536" viewBox="0 0 1024 1536"><rect width="100%" height="100%" fill="#8b7fd6"/></svg>',
  )}`;
  return {
    ...actual,
    buildLocalImageUrl: (input: Parameters<typeof actual.buildLocalImageUrl>[0]) =>
      input.src.endsWith(".png")
        ? testState.imageServed
          ? picture
          : `/__moss_missing_image__/${encodeURIComponent(String(input.cacheKey ?? "first"))}.png`
        : actual.buildLocalImageUrl(input),
  };
});

const SHOTS = "../../../../../.tmp/chat-ui-rows-shots";
const VIEWPORT = { width: 900, height: 1000 };

const turnTiming = new Map<TurnId, TurnTiming>([
  [
    codexOwnerTurnId,
    {
      startedAt: codexOwnerImageTurn.started_at,
      completedAt: codexOwnerImageTurn.completed_at,
      interrupted: false,
    },
  ],
]);

let theme: "light" | "dark" = "light";
const openedActivities: string[] = [];
const host = () => document.querySelector<HTMLElement>("[data-owner-codex-host]")!;

let themeGuard: MutationObserver | null = null;

function applyTheme(variant: "light" | "dark") {
  const { variables } = buildThemeCssVariables(
    { codeThemeId: "codex", theme: DEFAULT_CHROME_THEME_BY_VARIANT[variant] },
    variant,
  );
  const root = document.documentElement;
  const write = () => {
    themeGuard?.disconnect();
    for (const [name, value] of Object.entries(variables)) root.style.setProperty(name, value);
    root.classList.toggle("dark", variant === "dark");
    themeGuard?.observe(root, { attributes: true, attributeFilter: ["class", "style"] });
  };
  // The app's theme hook rewrites <html> on mount and on some updates; keep the variant.
  themeGuard?.disconnect();
  themeGuard = new MutationObserver(() => {
    const drifted = Object.entries(variables).some(
      ([name, value]) => root.style.getPropertyValue(name) !== value,
    );
    if (drifted || root.classList.contains("dark") !== (variant === "dark")) write();
  });
  write();
}

async function mount() {
  applyTheme(theme);
  const screen = await render(
    <div
      data-owner-codex-host=""
      style={{ height: VIEWPORT.height, width: VIEWPORT.width }}
      className="bg-background text-foreground"
    >
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={codexOwnerTimelineEntries()}
        turnDiffSummaryByAssistantMessageId={new Map()}
        turnTimingByTurnId={turnTiming}
        nowIso={codexOwnerImageTurn.completed_at}
        onOpenTurnDiff={() => {}}
        onOpenAgentActivity={(id) => openedActivities.push(id)}
        onSendPromptTurn={async () => true}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd="C:/Users/person/Documents/Moss/2026-11-17/moss"
        threadId="f22bee60-357a-4e0e-bd8a-89306a4bec1b"
        resolvedTheme={theme}
        timestampFormat="locale"
        workspaceRoot={undefined}
      />
    </div>,
  );
  // The app's theme hook resets <html> on mount; put the variant back.
  await settle(4);
  applyTheme(theme);
  return screen;
}

// Resolves after the frame has painted: the list's own corrections (ResizeObserver,
// before paint) have run, so what is measured is what a person saw.
function nextFrame() {
  return new Promise<void>((resolve) => requestAnimationFrame(() => setTimeout(resolve, 0)));
}

async function settle(frames = 24) {
  for (let index = 0; index < frames; index += 1) await nextFrame();
}

function visibleText(): string {
  return host().innerText;
}

function shot(name: string) {
  return page.screenshot({ path: `${SHOTS}/${theme}-${name}.png` });
}

// Every box a person reads as one row: timeline rows, and inside an open turn
// each work row, prose block, group line and image. None may intersect another.
function deepestOverlap(): { px: number; pair: string } {
  const selectors = [
    "[data-timeline-row-kind]",
    "[data-work-entry-prose]",
    "[data-tool-detail-disclosure]",
    "[data-tool-group-disclosure]",
    "[data-testid='generated-image-preview']",
  ];
  let px = 0;
  let pair = "";
  for (const selector of selectors) {
    const boxes = [...host().querySelectorAll<HTMLElement>(selector)]
      .filter((element) => element.closest("[inert]") === null)
      .map((element) => ({ element, rect: element.getBoundingClientRect() }))
      .filter(({ rect }) => rect.height > 0 && rect.width > 0)
      .toSorted((left, right) => left.rect.top - right.rect.top);
    for (let index = 1; index < boxes.length; index += 1) {
      const previous = boxes[index - 1]!;
      const current = boxes[index]!;
      if (previous.element.contains(current.element)) continue;
      const intrusion = previous.rect.bottom - current.rect.top;
      if (intrusion > px) {
        px = intrusion;
        pair = `${selector}: "${previous.element.innerText.slice(0, 40)}" over "${current.element.innerText.slice(0, 40)}"`;
      }
    }
  }
  return { px, pair };
}

async function expectNoOverlapAcrossFrames(frames = 30) {
  let worst = { px: 0, pair: "" };
  let streak = 0;
  for (let index = 0; index < frames; index += 1) {
    await nextFrame();
    const overlap = deepestOverlap();
    streak = overlap.px > 2 ? streak + 1 : 0;
    if (overlap.px > worst.px) worst = overlap;
    // A stale measurement corrected on the next layout pass is invisible; an
    // overlap that persists is what the owner saw.
    expect(streak, `rows overlap: ${worst.pair} (${worst.px.toFixed(1)}px)`).toBeLessThan(4);
  }
  expect(deepestOverlap().px, `rows overlap at rest: ${deepestOverlap().pair}`).toBeLessThanOrEqual(
    2,
  );
}

function turnHeaderTrigger(): HTMLElement {
  const trigger = [
    ...host().querySelectorAll<HTMLElement>("[data-slot='collapsible-trigger']"),
  ].find((element) => element.innerText.includes("已工作"));
  if (!trigger) throw new Error("No 已工作 header");
  return trigger;
}

function commandRowTrigger(text: string): HTMLElement {
  const header = [...host().querySelectorAll<HTMLElement>("[data-tool-detail-header]")].find(
    (element) => element.innerText.includes(text),
  );
  const trigger = header?.querySelector<HTMLElement>("[data-tool-detail-trigger]");
  if (!trigger) throw new Error(`No command row reading "${text}"`);
  return trigger;
}

// The transcript scrolls inside its own list, not the page.
async function scrollToElement(element: HTMLElement, offsetPx = 160) {
  let scroller = element.parentElement;
  while (scroller && !/(auto|scroll)/u.test(getComputedStyle(scroller).overflowY)) {
    scroller = scroller.parentElement;
  }
  if (scroller) {
    scroller.scrollTop +=
      element.getBoundingClientRect().top - scroller.getBoundingClientRect().top - offsetPx;
  }
  await settle(8);
}

async function scrollTurnIntoView(text: string) {
  const target = [...host().querySelectorAll<HTMLElement>("[data-tool-detail-header]")].find(
    (element) => element.innerText.includes(text),
  );
  if (target) await scrollToElement(target);
}

afterEach(() => {
  document.body.innerHTML = "";
  document.documentElement.classList.remove("dark");
  document.documentElement.removeAttribute("style");
  themeGuard?.disconnect();
  themeGuard = null;
  openedActivities.length = 0;
  testState.imageServed = false;
});

describe.each(["light", "dark"] as const)("the owner's Codex turn (%s)", (mode) => {
  it("folds, unfolds and reads like Synara, without overlap", async () => {
    theme = mode;
    await page.viewport(VIEWPORT.width, VIEWPORT.height);
    await mount();
    await expect.poll(() => visibleText()).toContain("已工作 14 分钟 32 秒");
    await settle();

    // Folded: one header line, the final answer, the wrap-up box.
    expect(host().querySelector("[data-tool-detail-header]")).toBeNull();
    expect(visibleText()).toContain("现在的角色位置和大小合适吗？");
    expect(visibleText()).toContain("保持这样");
    expect(visibleText()).toContain("调整位置");
    await shot("1-folded-with-wrap-up-box");

    // Unfolded: every row one line, nothing opened by itself.
    turnHeaderTrigger().click();
    await expect
      .poll(() => host().querySelectorAll("[data-tool-detail-header]").length)
      .toBeGreaterThan(5);
    await settle();
    expect(host().querySelector("[data-command-shell]")).toBeNull();
    expect(host().querySelector("[data-tool-failure-excerpt]")).toBeNull();
    const text = visibleText();
    expect(text).not.toContain("powershell.exe");
    expect(text).not.toContain("WindowsPowerShell");
    expect(text).toContain("已读取 imagegen/SKILL.md");
    expect(text).toContain("Get-ChildItem -Force outputs | Select-Object Name,Length");
    expect(text).toContain("失败 · 退出码 1");
    // Reasoning is prose, not a clickable row.
    const prose = [...host().querySelectorAll<HTMLElement>("[data-work-entry-prose]")];
    expect(prose.map((element) => element.innerText.trim())).toEqual(
      expect.arrayContaining(["Preparing original character prompt", "Reading imagegen skill"]),
    );
    await expectNoOverlapAcrossFrames();
    await shot("2-unfolded");

    // Clicking a reasoning line keeps the chat on screen.
    const reasoning = prose.find((element) =>
      element.innerText.includes("Preparing original character prompt"),
    )!;
    await scrollToElement(reasoning, 300);
    reasoning.click();
    await settle(4);
    expect(openedActivities).toEqual([]);
    expect(reasoning.closest("button, [role='button']")).toBeNull();
    expect(visibleText()).not.toContain("返回");
    await shot("4-reasoning-clicked");

    // One command opened: command, output, exit code; the row text is unchanged.
    await scrollTurnIntoView("Get-Content -Raw");
    const failedRead = [...host().querySelectorAll<HTMLElement>("[data-tool-detail-header]")].find(
      (element) => element.innerText.includes("失败 · 退出码 1"),
    )!;
    const headerBefore = failedRead.innerText;
    failedRead.querySelector<HTMLElement>("[data-tool-detail-trigger]")!.click();
    await expect.poll(() => host().querySelector("[data-command-shell]")).not.toBeNull();
    await settle();
    const shell = host().querySelector<HTMLElement>("[data-command-shell]")!;
    expect(shell.innerText).toContain(
      "Get-Content -Raw 'C:/Users/person/.agents/skills/imagegen/SKILL.md'",
    );
    expect(shell.innerText).not.toContain("powershell.exe");
    expect(failedRead.innerText).toBe(headerBefore);
    // The full launcher line stays reachable: clicking the command shows it.
    shell.querySelector<HTMLElement>("[data-shell-command]")!.click();
    await expect
      .poll(() => shell.querySelector("[data-shell-launcher]")?.textContent ?? "")
      .toContain("powershell.exe");
    expect(shell.querySelector("[data-shell-launcher]")!.textContent).toContain("启动方式：");
    await expectNoOverlapAcrossFrames();
    await shot("3-one-command-open");

    // Open and close several rows in a row, then fold and unfold the turn.
    for (const label of ["已读取 imagegen/SKILL.md", "Get-ChildItem -Force outputs"]) {
      await scrollTurnIntoView(label);
      commandRowTrigger(label).click();
      await expectNoOverlapAcrossFrames(12);
    }
    for (const label of ["已读取 imagegen/SKILL.md", "Get-ChildItem -Force outputs"]) {
      await scrollTurnIntoView(label);
      commandRowTrigger(label).click();
      await expectNoOverlapAcrossFrames(12);
    }
    await scrollToElement(turnHeaderTrigger(), 40);
    turnHeaderTrigger().click();
    await expectNoOverlapAcrossFrames();
    turnHeaderTrigger().click();
    await expectNoOverlapAcrossFrames();
  });

  it("says when the generated picture cannot load, and loads it on reload", async () => {
    theme = mode;
    await page.viewport(VIEWPORT.width, VIEWPORT.height);
    await mount();
    await expect.poll(() => visibleText()).toContain("已工作 14 分钟 32 秒");
    // The picture sits under the final answer, where a folded turn shows it.
    await expect
      .poll(() => host().querySelector("[data-testid='generated-image-load-failed']"), {
        timeout: 5_000,
      })
      .not.toBeNull();
    const failed = host().querySelector<HTMLElement>(
      "[data-testid='generated-image-load-failed']",
    )!;
    await scrollToElement(failed, 120);
    expect(failed.innerText).toContain("图片无法显示");
    expect(failed.innerText).toContain("exec-98c98b54-7665-4fdc-b6e9-fe02edc92b99.png");
    const box = failed.getBoundingClientRect();
    expect(box.width).toBeGreaterThan(100);
    expect(box.height).toBeGreaterThan(80);
    await expectNoOverlapAcrossFrames(12);
    await shot("5-image-failed");

    testState.imageServed = true;
    failed.querySelector<HTMLElement>("[data-testid='generated-image-reload']")!.click();
    await expect
      .poll(() => host().querySelector("[data-testid='generated-image-load-failed']"))
      .toBeNull();
    const image = host().querySelector<HTMLImageElement>(
      "[data-testid='generated-image-preview'] img",
    )!;
    await expect.poll(() => image.naturalWidth).toBeGreaterThan(0);
    expect(getComputedStyle(image).visibility).toBe("visible");
    await settle();
    await expectNoOverlapAcrossFrames(12);
    await shot("6-image-reloaded");
  });
});

// Earlier turns above and later turns below, so the list recycles rows while the
// person scrolls away from an open turn and back.
function fillerTurns(prefix: string, count: number) {
  return Array.from({ length: count }, (_, index) =>
    (["user", "assistant"] as const).map((role) => {
      const id = `${prefix}-${role}-${index}`;
      return {
        id,
        kind: "message" as const,
        createdAt: "2026-11-17T05:00:00.000Z",
        message: {
          id: MessageId.makeUnsafe(id),
          role,
          text: `${prefix} ${role} ${index}. ${"A sentence that wraps across the column. ".repeat(role === "user" ? 1 : 8)}`,
          createdAt: "2026-11-17T05:00:00.000Z",
          streaming: false,
        },
      };
    }),
  ).flat();
}

describe("the owner's Codex turn between other turns", () => {
  it("keeps rows apart while it unfolds, opens rows, scrolls away and back, and folds", async () => {
    theme = "light";
    applyTheme(theme);
    await page.viewport(VIEWPORT.width, 700);
    render(
      <div data-owner-codex-host="" style={{ height: 700, width: VIEWPORT.width }}>
        <MessagesTimeline
          hasMessages
          isWorking={false}
          activeTurnInProgress={false}
          activeTurnStartedAt={null}
          timelineEntries={[
            ...fillerTurns("before", 8),
            ...codexOwnerTimelineEntries(),
            ...fillerTurns("after", 12),
          ]}
          turnDiffSummaryByAssistantMessageId={new Map()}
          turnTimingByTurnId={turnTiming}
          onOpenTurnDiff={() => {}}
          revertTurnCountByUserMessageId={new Map()}
          onRevertUserMessage={() => {}}
          isRevertingCheckpoint={false}
          onImageExpand={() => {}}
          markdownCwd={undefined}
          resolvedTheme="light"
          timestampFormat="locale"
          workspaceRoot={undefined}
        />
      </div>,
    );
    await settle(20);
    const scroller = (() => {
      let element = host().querySelector<HTMLElement>("[data-timeline-row-kind]")!.parentElement;
      while (element && !/(auto|scroll)/u.test(getComputedStyle(element).overflowY)) {
        element = element.parentElement;
      }
      return element!;
    })();
    const header = async () => {
      // Walk the list from the top until the turn's row is rendered.
      scroller.scrollTop = 0;
      await settle(3);
      for (let step = 0; step < 80; step += 1) {
        const trigger = [
          ...host().querySelectorAll<HTMLElement>("[data-slot='collapsible-trigger']"),
        ].find((element) => element.innerText.includes("已工作"));
        if (trigger) return trigger;
        scroller.scrollTop += 400;
        await settle(3);
      }
      throw new Error("No 已工作 header");
    };
    await scrollToElement(await header(), 40);
    (await header()).click();
    await expectNoOverlapAcrossFrames();
    for (const trigger of [
      ...host().querySelectorAll<HTMLElement>("[data-tool-detail-trigger]"),
    ].slice(0, 4)) {
      trigger.click();
      await expectNoOverlapAcrossFrames(12);
    }
    scroller.scrollTop = scroller.scrollHeight;
    await expectNoOverlapAcrossFrames(12);
    for (let step = 0; step < 40; step += 1) {
      scroller.scrollTop -= 250;
      await expectNoOverlapAcrossFrames(3);
    }
    await scrollToElement(await header(), 40);
    (await header()).click();
    await expectNoOverlapAcrossFrames();
  });
});
