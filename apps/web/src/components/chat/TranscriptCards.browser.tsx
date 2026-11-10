// FILE: TranscriptCards.browser.tsx
// Purpose: Draws the classic transcript rows through the card registry in the real
//   timeline (model change, compaction, task list, plan, turn error, worktree setup),
//   checks each row carries its card, and shows a failed card's fallback. Saves
//   screenshots to .tmp/ui-parity/claude-transcript/.
import "../../index.css";

import { MessageId, OrchestrationProposedPlanId, TurnId } from "@moss/contracts";
import { afterEach, beforeEach, expect, it } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import type { TimelineEntry } from "../../workLog";
import { MossLocaleScope } from "../../localization";
import { installZhCnUiLocalization, uninstallZhCnUiLocalization } from "../../localization/zhCN";
import { MessagesTimeline } from "./MessagesTimeline";
import { TurnHeaderLine } from "./TurnHeaderLine";
import { TranscriptCardBoundary } from "./transcript/cards/transcriptCards";
import { RewindMarker } from "./transcript/RewindMarker";
import { TranscriptReplyBox } from "./transcript/TranscriptReplyBox";
import { WrapUpLiveBox } from "./transcript/WrapUpBox";

// Shimmering lines are captured at rest, not mid-sweep.
const motion = commands as unknown as {
  emulateReducedMotion: (value: "reduce" | "no-preference") => Promise<void>;
};
let restoreTheme: (() => void) | undefined;
let activeTheme: "light" | "dark";
async function shot(name: string) {
  await expect.poll(() => document.documentElement.dataset.themeVariant).toBe(activeTheme);
  expect(document.documentElement.classList.contains("dark")).toBe(activeTheme === "dark");
  await document.fonts.ready;
  await new Promise<void>((resolve) =>
    requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
  );
  const style = getComputedStyle(document.body);
  // Resolve CSS colors through the browser rather than assuming their serialization.
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = 1;
  const context = canvas.getContext("2d")!;
  const brightness = (color: string) => {
    context.clearRect(0, 0, 1, 1);
    context.fillStyle = color;
    context.fillRect(0, 0, 1, 1);
    const [r, g, b, alpha] = context.getImageData(0, 0, 1, 1).data;
    expect(alpha).toBe(255);
    return (r! + g! + b!) / (3 * 255);
  };
  const background = brightness(style.backgroundColor);
  const foreground = brightness(style.color);
  if (activeTheme === "dark") {
    expect(background).toBeLessThan(0.4);
    expect(foreground).toBeGreaterThan(0.6);
  } else {
    expect(background).toBeGreaterThan(0.7);
    expect(foreground).toBeLessThan(0.4);
  }
  expect(document.fonts.status).toBe("loaded");
  expect(parseFloat(style.fontSize)).toBeGreaterThan(0);
  expect(style.fontFamily.length).toBeGreaterThan(0);
  await page.screenshot({
    path: `../../../../../.tmp/ui-parity/claude-transcript/moss-${name}.png`,
  });
}

const at = (minute: number) => new Date(Date.UTC(2026, 10, 4, 9, minute)).toISOString();
const USER_ID = MessageId.makeUnsafe("cards-user");
const variants = [
  { locale: "en", theme: "light" },
  { locale: "zh-CN", theme: "light" },
  { locale: "zh-CN", theme: "dark" },
] as const;

function applyVariant(locale: "en" | "zh-CN", theme: "light" | "dark") {
  activeTheme = theme;
  restoreTheme = installBrowserFixtureTheme(theme);
  document.documentElement.lang = locale;
  document.documentElement.dataset.mossLocale = locale;
  if (locale === "zh-CN") installZhCnUiLocalization();
}

function variantSuffix(locale: "en" | "zh-CN", theme: "light" | "dark") {
  return locale === "en" ? "" : `-${locale}-${theme}`;
}

function classicEntries(): TimelineEntry[] {
  return [
    {
      id: "cards-user",
      kind: "message",
      createdAt: at(0),
      message: {
        id: USER_ID,
        role: "user",
        text: "整理一下 parser，并把计划写出来。",
        createdAt: at(0),
        streaming: false,
      },
    },
    {
      id: "cards-model-changed",
      kind: "model-changed",
      createdAt: at(0),
      messageId: USER_ID,
      fromModel: "gpt-5.5",
      toModel: "claude-opus-5-5",
      fromModelDisplayName: "GPT-5.5",
      toModelDisplayName: "Opus 5.5",
    },
    {
      id: "cards-compaction",
      kind: "context-compaction",
      createdAt: at(1),
      entry: {
        id: "cards-compaction-entry",
        createdAt: at(1),
        label: "Context compacted",
        tone: "info",
        compactionMode: "automatic",
      },
    },
    {
      id: "cards-todo",
      kind: "todo-plan",
      createdAt: at(2),
      tasks: [
        { task: "Read the header once", status: "completed" },
        { task: "Keep offsets stable", status: "inProgress" },
        { task: "Run the parser tests", status: "pending" },
      ],
    },
    {
      id: "cards-plan",
      kind: "proposed-plan",
      createdAt: at(3),
      proposedPlan: {
        id: OrchestrationProposedPlanId.makeUnsafe("cards-plan"),
        turnId: TurnId.makeUnsafe("cards-turn"),
        planMarkdown:
          "# Parser cleanup\n\n1. Read the header once.\n2. Keep offsets stable across retries.\n3. Run the parser tests.",
        implementedAt: null,
        implementationThreadId: null,
        createdAt: at(3),
        updatedAt: at(3),
      },
    },
    {
      id: "cards-assistant",
      kind: "message",
      createdAt: at(4),
      message: {
        id: MessageId.makeUnsafe("cards-assistant"),
        role: "assistant",
        text: "计划写好了：先只读一次文件头，再让偏移量在重试时保持不变。",
        createdAt: at(4),
        streaming: false,
      },
    },
    {
      id: "cards-turn-error",
      kind: "turn-error",
      createdAt: at(5),
      messageId: USER_ID,
      message: "The provider stopped this turn: rate limited. Try again in a moment.",
    },
  ];
}

function ClassicCardsFixture({ theme }: { theme: "light" | "dark" }) {
  return (
    <div className="flex flex-col overflow-hidden" style={{ width: 860, height: 1060 }}>
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={classicEntries()}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso={at(6)}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme={theme}
        timestampFormat="locale"
        workspaceRoot={undefined}
        worktreeSetup={{
          steps: [
            { id: "create-branch", label: "Create branch", status: "done" },
            { id: "create-worktree", label: "Create worktree", status: "active" },
            { id: "start-session", label: "Start session", status: "pending" },
          ],
        }}
      />
    </div>
  );
}

let previousRootStyle: string | null;
let previousRootClass: string;
let previousLang: string;
let previousLocale: string | undefined;
let previousThemeAttributes: Array<[string, string | null]>;
beforeEach(async () => {
  previousRootStyle = document.documentElement.getAttribute("style");
  previousRootClass = document.documentElement.className;
  previousLang = document.documentElement.lang;
  previousLocale = document.documentElement.dataset.mossLocale;
  previousThemeAttributes = [
    "data-theme-variant",
    "data-theme-mode",
    "data-code-theme-id",
    "data-window-material",
    "data-window-translucency",
  ].map((name) => [name, document.documentElement.getAttribute(name)]);
  await page.viewport(900, 1100);
  await motion.emulateReducedMotion("reduce");
});
afterEach(async () => {
  uninstallZhCnUiLocalization();
  restoreTheme?.();
  restoreTheme = undefined;
  await motion.emulateReducedMotion("no-preference");
  document.documentElement.className = previousRootClass;
  document.documentElement.lang = previousLang;
  if (previousLocale === undefined) delete document.documentElement.dataset.mossLocale;
  else document.documentElement.dataset.mossLocale = previousLocale;
  if (previousRootStyle === null) document.documentElement.removeAttribute("style");
  else document.documentElement.setAttribute("style", previousRootStyle);
  for (const [name, value] of previousThemeAttributes) {
    if (value === null) document.documentElement.removeAttribute(name);
    else document.documentElement.setAttribute(name, value);
  }
});

it.each(variants)(
  "draws visible classic cards in $locale / $theme",
  async ({ locale, theme }) => {
    applyVariant(locale, theme);
    const screen = await render(
      <BrowserThemeFixture>
        <MossLocaleScope locale={locale}>
          <ClassicCardsFixture theme={theme} />
        </MossLocaleScope>
      </BrowserThemeFixture>,
    );
    try {
      await expect.poll(() => document.body.textContent).toContain("Parser cleanup");
      const kinds = [...document.querySelectorAll<HTMLElement>("[data-timeline-row-kind]")].map(
        (row) => row.dataset.timelineRowKind,
      );
      // A settled turn keeps its checklist out of the transcript, so no todo-plan row here.
      for (const kind of ["model-changed", "context-compaction", "proposed-plan", "turn-error"]) {
        expect(kinds).toContain(kind);
      }
      expect(document.querySelector('[data-model-change-status="durable"]')).not.toBeNull();
      expect(document.querySelector('[data-turn-error="true"]')?.textContent).toContain(
        "rate limited",
      );
      expect(document.querySelector("[data-transcript-card-fallback]")).toBeNull();
      if (locale === "zh-CN") {
        await expect.element(page.getByText("已压缩会话", { exact: true })).toBeVisible();
        await expect
          .element(page.getByRole("button", { name: /^之前的 \d+ 条消息$/ }))
          .toBeVisible();
        expect(
          document.querySelector('[data-model-change-status="durable"]')?.textContent,
        ).toContain("模型已从 GPT-5.5 更改为 Opus 5.5。");
      }
      await expect.element(page.getByText("Parser cleanup", { exact: true })).toBeVisible();
      await expect
        .poll(() => {
          const row = document.querySelector<HTMLElement>(
            '[data-timeline-row-kind="proposed-plan"]',
          );
          if (!row) return false;
          const rect = row.getBoundingClientRect();
          // LegendList keeps measurable rows at opacity: 0 until bootstrap completes.
          // Geometry and locator visibility alone do not prove a painted transcript.
          for (let element: HTMLElement | null = row; element; element = element.parentElement) {
            const style = getComputedStyle(element);
            if (Number(style.opacity) < 1 || style.visibility !== "visible") return false;
          }
          return (
            rect.width > 0 && rect.height > 0 && rect.top >= 0 && rect.bottom <= window.innerHeight
          );
        })
        .toBe(true);
      await shot(`classic-cards${variantSuffix(locale, theme)}`);
    } finally {
      await screen.unmount();
    }
  },
  10_000,
);

it.each(["light", "dark"] as const)(
  "keeps zh-CN reply and rewind copy visible in %s",
  async (theme) => {
    applyVariant("zh-CN", theme);
    const screen = await render(
      <BrowserThemeFixture>
        <MossLocaleScope locale="zh-CN">
          <div style={{ width: 736, padding: 24 }} className="flex flex-col gap-4">
            <WrapUpLiveBox
              box={{
                recap: "The parser reads the header once. Nothing is committed yet.",
                ask: "Keep the parser changes?",
                actions: ["Keep parser changes", "Review parser changes"],
              }}
              onAnswer={async () => false}
            />
            <RewindMarker />
            <TurnHeaderLine
              kind="settled"
              header={{
                elapsed: null,
                endedAt: null,
                outcome: "completed",
                reason: null,
                modelChange: null,
                resumedBy: null,
              }}
              fontSize="inherit"
            />
          </div>
        </MossLocaleScope>
      </BrowserThemeFixture>,
    );
    try {
      await expect.element(page.getByText("已回退到这里", { exact: true })).toBeVisible();
      await expect.element(page.getByText("详情", { exact: true })).toBeVisible();
      await page.getByRole("button", { name: "Keep parser changes" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("回复暂未发送，请重试。");
      expect(document.body.textContent).toContain("The parser reads the header once.");
      await shot(`wrap-up-zh-CN-${theme}`);
      await screen.rerender(
        <BrowserThemeFixture>
          <MossLocaleScope locale="zh-CN">
            <TranscriptReplyBox
              quote="Keep the offsets stable across retries."
              range={null}
              onSend={async () => false}
              onClose={() => {}}
            />
          </MossLocaleScope>
        </BrowserThemeFixture>,
      );
      const input = page.getByRole("textbox", { name: "回复", exact: true });
      await expect.element(input).toBeVisible();
      expect(input.element().getAttribute("placeholder")).toBe("回复智能体");
      await input.fill("请保留我输入的回复。");
      await page.getByRole("button", { name: "发送回复" }).click();
      await expect.element(page.getByRole("alert")).toHaveTextContent("回复暂未发送，请重试。");
      await expect.element(input).toHaveValue("请保留我输入的回复。");
      expect(document.querySelector("[data-reply-quote]")?.textContent).toBe(
        "Keep the offsets stable across retries.",
      );
      const rect = page
        .getByRole("dialog", { name: "回复", exact: true })
        .element()
        .getBoundingClientRect();
      expect(rect.width).toBeGreaterThan(0);
      expect(rect.left).toBeGreaterThanOrEqual(0);
      expect(rect.right).toBeLessThanOrEqual(window.innerWidth);
      expect(rect.bottom).toBeLessThanOrEqual(window.innerHeight);
      await shot(`reply-box-zh-CN-${theme}`);
    } finally {
      await screen.unmount();
    }
  },
  10_000,
);

it.each(variants)(
  "isolates failed cards in $locale / $theme",
  async ({ locale, theme }) => {
    applyVariant(locale, theme);
    function BrokenRow(): never {
      throw new Error("a malformed row");
    }
    const original = console.error;
    console.error = () => {};
    const screen = await render(
      <BrowserThemeFixture>
        <MossLocaleScope locale={locale}>
          <div style={{ width: 736, padding: 24 }} className="flex flex-col gap-3 text-size-chat">
            <p>上一条消息照常显示。</p>
            <TranscriptCardBoundary cardId="moss.tool">
              <BrokenRow />
            </TranscriptCardBoundary>
            <p>下一条消息也照常显示。</p>
          </div>
        </MossLocaleScope>
      </BrowserThemeFixture>,
    );
    try {
      await expect
        .element(page.getByRole("button", { name: locale === "zh-CN" ? "重试" : "Retry" }))
        .toBeVisible();
      expect(
        document.querySelector('[data-transcript-card-fallback="moss.tool"]')?.textContent,
      ).toContain(locale === "zh-CN" ? "这部分无法显示。" : "Couldn’t show this section.");
      await shot(`card-fallback${variantSuffix(locale, theme)}`);
    } finally {
      console.error = original;
      await screen.unmount();
    }
  },
  10_000,
);
