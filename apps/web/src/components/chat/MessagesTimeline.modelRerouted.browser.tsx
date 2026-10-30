// FILE: MessagesTimeline.modelRerouted.browser.tsx
// Purpose: Browser proof for the typed high-risk model-rerouted transcript primitive.

import "../../index.css";

import { MessageId, TurnId } from "@synara/contracts";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { commands, page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "../../appSettings";
import { deriveTimelineEntries, deriveWorkLogEntries } from "../../session-logic";
import type { ChatMessage } from "../../types";
import { makeActivity } from "../../storeTestFixtures";
import { MessagesTimeline } from "./MessagesTimeline";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as MossLocaleCode }));

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

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

const TURN_ID = TurnId.makeUnsafe("turn-model-rerouted");
const CREATED_AT = "2026-08-28T00:00:02.000Z";
const RECEIPT_DIR = "../../../.tmp/ui-parity/HEL-46-model-rerouted";
const FROZEN_INFO_ICON_PATHS = [
  "M9.8 10.2a.7.7 0 0 1 1.4 0v3.4a.7.7 0 0 1-1.4 0Z",
  "M10.5 6.2a.95.95 0 1 1 0 1.9a.95.95 0 0 1 0-1.9Z",
  "M10.5 3a7.5 7.5 0 1 1 0 15a7.5 7.5 0 0 1 0-15Zm0 1.4a6.1 6.1 0 1 0 0 12.2a6.1 6.1 0 0 0 0-12.2Z",
] as const;

function message(
  id: string,
  role: "user" | "assistant",
  text: string,
  streaming = false,
): ChatMessage {
  return {
    id: MessageId.makeUnsafe(id),
    role,
    text,
    createdAt: CREATED_AT,
    streaming,
    ...(role === "assistant" ? { turnId: TURN_ID } : {}),
  };
}

function reroutedTimelineEntries() {
  const rerouted = makeActivity({
    id: "model-rerouted-browser",
    createdAt: CREATED_AT,
    kind: "model.rerouted",
    summary: "Model switched",
    tone: "info",
    turnId: String(TURN_ID),
    sequence: 7,
    payload: {
      fromModel: "gpt-5.5",
      toModel: "gpt-5.4",
      reason: "highRiskCyberActivity",
    },
  });
  const tool = makeActivity({
    id: "model-rerouted-tool-browser",
    createdAt: CREATED_AT,
    kind: "tool.completed",
    summary: "Read adapter",
    tone: "tool",
    turnId: String(TURN_ID),
    sequence: 8,
    payload: {
      itemType: "command_execution",
      title: "Read adapter",
      detail: "adapter status",
    },
  });
  return deriveTimelineEntries(
    [
      message("model-rerouted-user", "user", "Inspect the adapter."),
      message("model-rerouted-assistant", "assistant", "The adapter is healthy.", true),
    ],
    [],
    deriveWorkLogEntries([rerouted, tool], TURN_ID),
  );
}

const REROUTED_TIMELINE_ENTRIES = reroutedTimelineEntries();

function createHost(width: number, height = 520): HTMLDivElement {
  const dark = document.documentElement.classList.contains("dark");
  const host = document.createElement("div");
  host.style.cssText = [
    "box-sizing:border-box",
    "width:" + width + "px",
    "max-width:" + width + "px",
    "height:" + height + "px",
    "overflow:hidden",
    "background:" + (dark ? "#0e0e0e" : "#f6f6f6"),
    "--background:" + (dark ? "#0e0e0e" : "#f6f6f6"),
    "--foreground:" + (dark ? "#f5f5f5" : "#202020"),
    "--muted-foreground:" + (dark ? "#c3c3c3" : "#616161"),
    "--color-border:" + (dark ? "#353535" : "#d0d0d0"),
    "--color-text-foreground-secondary:" + (dark ? "#b9b9b9" : "#616161"),
  ].join(";");
  document.body.append(host);
  return host;
}

function blockingAxeViolations() {
  return axe
    .run(document.body)
    .then((result) =>
      result.violations.filter(
        (violation) => violation.impact === "serious" || violation.impact === "critical",
      ),
    );
}

function ReroutedTimeline() {
  return (
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
      resolvedTheme={document.documentElement.classList.contains("dark") ? "dark" : "light"}
      timestampFormat="locale"
      workspaceRoot={undefined}
    />
  );
}

describe("MessagesTimeline model-rerouted browser parity", () => {
  afterEach(() => {
    localizationTestState.locale = "en";
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    document.body.innerHTML = "";
    vi.unstubAllGlobals();
  });

  it("renders the typed divider, exact tooltip link, and frozen chronology", async () => {
    await page.viewport(720, 520);
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    const host = createHost(720);
    const screen = await render(<ReroutedTimeline />, { container: host });

    try {
      await expect
        .poll(() => document.querySelector('[data-timeline-row-kind="model-rerouted"]'))
        .not.toBeNull();
      const reroutedRow = document.querySelector<HTMLElement>(
        '[data-timeline-row-kind="model-rerouted"]',
      );
      const userRow = document.querySelector<HTMLElement>('[data-message-role="user"]');
      const assistantRow = document.querySelector<HTMLElement>('[data-message-role="assistant"]');
      const trigger = reroutedRow?.querySelector<HTMLButtonElement>(
        '[data-model-rerouted-tooltip-trigger="true"]',
      );
      if (!reroutedRow || !userRow || !assistantRow || !trigger) {
        throw new Error("model-rerouted browser controls are missing");
      }
      expect(reroutedRow.textContent).toContain("Your request was routed to GPT-5.4.");
      expect(reroutedRow.querySelector("[data-model-rerouted-icon]")).toBeNull();
      expect(reroutedRow.querySelector(".tabler-icon-cube")).toBeNull();
      expect(reroutedRow.querySelector('[data-model-rerouted-divider="leading"]')).not.toBeNull();
      expect(reroutedRow.querySelector('[data-model-rerouted-divider="trailing"]')).not.toBeNull();
      expect(trigger.querySelector(".icon-2xs")).not.toBeNull();
      const icon = trigger.querySelector<SVGSVGElement>("svg");
      if (!icon) throw new Error("model-rerouted info icon is missing");
      expect(icon.getAttribute("width")).toBe("21");
      expect(icon.getAttribute("height")).toBe("21");
      expect(icon.getAttribute("viewBox")).toBe("0 0 21 21");
      expect(icon.getAttribute("fill")).toBe("none");
      expect(icon.getAttribute("xmlns")).toBe("http://www.w3.org/2000/svg");
      expect(icon.getAttribute("class")).toContain("icon-2xs");
      expect(icon.classList.contains("tabler-icon")).toBe(false);
      expect(icon.classList.contains("tabler-icon-info-circle")).toBe(false);
      expect(icon.getAttribute("stroke")).toBeNull();
      expect(icon.getAttribute("stroke-width")).toBeNull();
      const iconPaths = [...icon.querySelectorAll("path")];
      expect(iconPaths).toHaveLength(3);
      expect(iconPaths.map((path) => path.getAttribute("d"))).toEqual(FROZEN_INFO_ICON_PATHS);
      expect(iconPaths.map((path) => path.getAttribute("fill"))).toEqual([
        "currentColor",
        "currentColor",
        "currentColor",
      ]);
      expect(icon.querySelector("[stroke], [stroke-width]")).toBeNull();
      expect(trigger.className).toContain("focus-visible:ring-2");
      expect(
        Boolean(userRow.compareDocumentPosition(reroutedRow) & Node.DOCUMENT_POSITION_FOLLOWING),
      ).toBe(true);
      expect(
        (assistantRow.textContent?.indexOf("Read adapter") ?? -1) <
          (assistantRow.textContent?.indexOf("The adapter is healthy.") ?? -1),
      ).toBe(true);

      trigger.focus();
      expect(document.activeElement).toBe(trigger);
      await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
      const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      const link = popup?.querySelector<HTMLAnchorElement>('a[href="https://chatgpt.com/cyber"]');
      if (!popup || !link) throw new Error("model-rerouted tooltip link is missing");
      expect(popup.querySelector('[data-model-rerouted-tooltip-line="1"]')?.textContent).toBe(
        "Heads up, your request was re-routed to reduce cyber-abuse risk.",
      );
      expect(popup.querySelector('[data-model-rerouted-tooltip-line="2"]')?.textContent).toBe(
        "Think this is a mistake? Request a review at chatgpt.com/cyber or report via /feedback",
      );
      expect(trigger.getAttribute("aria-label")).toBe(
        "Heads up, your request was re-routed to reduce cyber-abuse risk. Think this is a mistake? Request a review at chatgpt.com/cyber or report via /feedback",
      );
      expect(trigger.getAttribute("aria-label")).not.toMatch(/\s{2,}/u);
      expect(popup.querySelector('[data-model-rerouted-tooltip-line="2"]')?.className).toContain(
        "mt-2",
      );
      expect(link.target).toBe("_blank");
      expect(link.rel).toBe("noreferrer");
      expect(link.className).toContain("text-info");
      expect(link.className).toContain("hover:underline");
      // Audit settled prose, matching the conversation motion visibility contract.
      await expect
        .poll(() =>
          Array.from(
            assistantRow.querySelectorAll<HTMLElement>("span[data-stream-text-start]"),
            (segment) => ({
              start: segment.getAttribute("data-stream-text-start"),
              opacity: getComputedStyle(segment).opacity,
            }),
          ),
        )
        .toEqual([
          { start: "0", opacity: "1" },
          { start: "4", opacity: "1" },
          { start: "12", opacity: "1" },
          { start: "15", opacity: "1" },
        ]);
      expect(await blockingAxeViolations()).toEqual([]);
      const screenshotPath = await page.screenshot({
        path: RECEIPT_DIR + "/light-chronology.png",
      });
      expect(screenshotPath).toContain("light-chronology.png");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("localizes the compact dark row and disables tooltip motion under reduced motion", async () => {
    await page.viewport(390, 420);
    await motionCommands.emulateReducedMotion("reduce");
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    localizationTestState.locale = "zh-CN";
    const host = createHost(390, 420);
    const screen = await render(<ReroutedTimeline />, { container: host });

    try {
      await expect
        .poll(() => document.querySelector('[data-timeline-row-kind="model-rerouted"]'))
        .not.toBeNull();
      const reroutedRow = document.querySelector<HTMLElement>(
        '[data-timeline-row-kind="model-rerouted"]',
      );
      const trigger = reroutedRow?.querySelector<HTMLButtonElement>(
        '[data-model-rerouted-tooltip-trigger="true"]',
      );
      if (!reroutedRow || !trigger) throw new Error("compact model-rerouted row is missing");
      expect(reroutedRow.textContent).toContain("你的请求已路由到 GPT-5.4。");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      trigger.focus();
      await expect.poll(() => document.querySelector('[data-slot="tooltip-popup"]')).not.toBeNull();
      const popup = document.querySelector<HTMLElement>('[data-slot="tooltip-popup"]');
      const positioner = document.querySelector<HTMLElement>('[data-slot="tooltip-positioner"]');
      if (!popup || !positioner) throw new Error("compact tooltip controls are missing");
      expect(popup.querySelector('[data-model-rerouted-tooltip-line="1"]')?.textContent).toBe(
        "请注意：为减少网络滥用风险，你的请求已被重新路由。",
      );
      expect(popup.querySelector('[data-model-rerouted-tooltip-line="2"]')?.textContent).toBe(
        "认为这是误判？请在 chatgpt.com/cyber 申请复核，或通过 /feedback 举报",
      );
      expect(popup.querySelector("a")?.getAttribute("href")).toBe("https://chatgpt.com/cyber");
      expect(getComputedStyle(trigger).transitionProperty).toBe("none");
      expect(getComputedStyle(popup).transitionProperty).toBe("none");
      expect(getComputedStyle(popup).transitionDuration).toBe("0s");
      expect(getComputedStyle(positioner).transitionProperty).toBe("none");
      expect(getComputedStyle(positioner).transitionDuration).toBe("0s");
      expect(await blockingAxeViolations()).toEqual([]);
      const compactPath = await page.screenshot({
        path: RECEIPT_DIR + "/dark-compact-390-zh.png",
      });
      expect(compactPath).toContain("dark-compact-390-zh.png");
      const reducedPath = await page.screenshot({
        path: RECEIPT_DIR + "/reduced-motion.png",
      });
      expect(reducedPath).toContain("reduced-motion.png");
    } finally {
      await screen.unmount();
      host.remove();
      await motionCommands.emulateReducedMotion("no-preference");
    }
  });
});
