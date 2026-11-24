// FILE: MessagesTimeline.modelRerouted.browser.tsx
// Purpose: The model-rerouted notice as a person sees it: one line with the reason and, on
//          the person's own Codex sign-in, one 申请复核 link. No icon, no tooltip, no button.

import "../../index.css";

import { MessageId, ProviderInstanceId, TurnId } from "@moss/contracts";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "../../appSettings";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { makeActivity } from "../../storeTestFixtures";
import { MessagesTimeline } from "./MessagesTimeline";
import {
  MODEL_REROUTED_REVIEW_URL,
  ModelReroutedTimelineRow,
  modelReroutedReviewLinkShown,
} from "./transcript/cards/noticeCards";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as MossLocaleCode }));
const externalLinks = vi.hoisted(() => ({ opened: [] as string[] }));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localizationTestState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localizationTestState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation(localizationTestState.locale, key, values),
    }),
  };
});
vi.mock("~/lib/linkChips", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/linkChips")>()),
  openExternalLink: (url: string) => {
    externalLinks.opened.push(url);
  },
}));

const TURN_ID = TurnId.makeUnsafe("turn-model-rerouted");
const CREATED_AT = "2026-08-28T00:00:02.000Z";
const LINE = {
  en: {
    text: "To reduce cyber-abuse risk, this request was routed to GPT-5.4.",
    link: "Request a review",
  },
  "zh-CN": { text: "为降低网络滥用风险，这次请求已改用 GPT-5.4。", link: "申请复核" },
} as const;

function message(id: string, role: "user" | "assistant", text: string): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    createdAt: CREATED_AT,
    streaming: false,
    ...(role === "assistant" ? { turnId: TURN_ID } : {}),
  };
}

const REROUTED_TIMELINE_ENTRIES = deriveTimelineEntries(
  [
    message("model-rerouted-user", "user", "Inspect the adapter."),
    message("model-rerouted-assistant", "assistant", "The adapter is healthy."),
  ],
  [],
  deriveWorkLogEntries(
    [
      makeActivity({
        id: "model-rerouted-browser",
        createdAt: CREATED_AT,
        kind: "model.rerouted",
        summary: "Model switched",
        tone: "info",
        turnId: String(TURN_ID),
        sequence: 7,
        payload: { fromModel: "gpt-5.5", toModel: "gpt-5.4", reason: "highRiskCyberActivity" },
      }),
    ],
    TURN_ID,
  ),
);

function setTheme(dark: boolean) {
  document.documentElement.classList.toggle("dark", dark);
  document.body.classList.toggle("dark", dark);
}

afterEach(() => {
  localizationTestState.locale = "en";
  externalLinks.opened = [];
  setTheme(false);
});

describe("model-rerouted notice", () => {
  it("offers 申请复核 only on the person's own Codex sign-in", () => {
    expect(modelReroutedReviewLinkShown(ProviderInstanceId.makeUnsafe("codex"))).toBe(true);
    expect(modelReroutedReviewLinkShown(ProviderInstanceId.makeUnsafe("codex_moss"))).toBe(false);
    expect(modelReroutedReviewLinkShown(ProviderInstanceId.makeUnsafe("codex_byok"))).toBe(false);
    expect(modelReroutedReviewLinkShown(undefined)).toBe(false);
  });

  for (const width of [720, 390]) {
    for (const dark of [false, true]) {
      for (const locale of ["en", "zh-CN"] as const) {
        it(`is one line with one reachable link at ${width}px, ${dark ? "dark" : "light"}, ${locale}`, async () => {
          await page.viewport(width, 300);
          setTheme(dark);
          localizationTestState.locale = locale;
          const screen = await render(
            <div style={{ width, padding: "0 16px", boxSizing: "border-box" }}>
              <ModelReroutedTimelineRow
                toModel="gpt-5.4"
                customModelLabel="Custom"
                fontSizePx={13}
                reviewLink
              />
            </div>,
          );
          try {
            const row = document.querySelector<HTMLElement>("[data-model-rerouted-reason]")!;
            const sentence = row.querySelector<HTMLElement>("[data-model-rerouted-center] > span")!;
            // The line's full text (it may truncate on screen, never in the document).
            expect(sentence.textContent).toBe(LINE[locale].text);
            const links = row.querySelectorAll<HTMLAnchorElement>("a");
            expect(links).toHaveLength(1);
            const link = links[0]!;
            expect(link.textContent).toBe(LINE[locale].link);
            expect(link.dataset.slot).toBe("text-link");
            expect(
              row.querySelectorAll("button, svg, [role='tooltip'], [data-slot='tooltip-trigger']"),
            ).toHaveLength(0);
            expect(row.textContent).not.toMatch(/chatgpt|openai|\/feedback/iu);

            // Not cut off: the whole link is inside the row and shows its whole label.
            const rowBox = row.getBoundingClientRect();
            const linkBox = link.getBoundingClientRect();
            expect(linkBox.width).toBeGreaterThan(0);
            expect(linkBox.left).toBeGreaterThanOrEqual(rowBox.left - 0.5);
            expect(linkBox.right).toBeLessThanOrEqual(rowBox.right + 0.5);
            expect(link.scrollWidth).toBeLessThanOrEqual(Math.ceil(linkBox.width));
            // One line: the link sits on the sentence's line.
            expect(Math.abs(linkBox.top - sentence.getBoundingClientRect().top)).toBeLessThan(6);

            // Pointer: the link is what a click at its centre reaches, and it opens outside.
            const hit = document.elementFromPoint(
              linkBox.left + linkBox.width / 2,
              linkBox.top + linkBox.height / 2,
            );
            expect(link.contains(hit)).toBe(true);
            await userEvent.click(link);
            expect(externalLinks.opened).toEqual([MODEL_REROUTED_REVIEW_URL]);

            // Keyboard: Tab reaches it, Enter opens it.
            document.body.tabIndex = -1;
            document.body.focus();
            await userEvent.tab();
            expect(document.activeElement).toBe(link);
            await userEvent.keyboard("{Enter}");
            expect(externalLinks.opened).toEqual([
              MODEL_REROUTED_REVIEW_URL,
              MODEL_REROUTED_REVIEW_URL,
            ]);
          } finally {
            document.body.removeAttribute("tabindex");
            await screen.unmount();
          }
        });
      }
    }
  }

  it("shows the line in the transcript, without the link where the chat's lane is unknown", async () => {
    await page.viewport(720, 520);
    const screen = await render(
      <MessagesTimeline
        hasMessages
        isWorking={false}
        activeTurnInProgress={false}
        activeTurnStartedAt={null}
        timelineEntries={REROUTED_TIMELINE_ENTRIES}
        turnDiffSummaryByAssistantMessageId={new Map()}
        nowIso="2026-08-28T00:00:05.000Z"
        expandedWorkGroups={{}}
        onToggleWorkGroup={() => {}}
        onOpenTurnDiff={() => {}}
        revertTurnCountByUserMessageId={new Map()}
        onRevertUserMessage={() => {}}
        isRevertingCheckpoint={false}
        onImageExpand={() => {}}
        markdownCwd={undefined}
        resolvedTheme="light"
        timestampFormat="locale"
        workspaceRoot={undefined}
      />,
    );
    try {
      await expect
        .poll(() => document.querySelector('[data-timeline-row-kind="model-rerouted"]'))
        .not.toBeNull();
      const row = document.querySelector<HTMLElement>('[data-timeline-row-kind="model-rerouted"]')!;
      expect(row.textContent).toContain(LINE.en.text);
      expect(row.querySelectorAll("a, button")).toHaveLength(0);
    } finally {
      await screen.unmount();
    }
  });
});
