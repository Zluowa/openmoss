// FILE: TimelineSubagentActivityGroup.browser.tsx
// Purpose: Verify routed subagent chip interaction, geometry, motion, and accessibility in a
//          real browser surface.
// Layer: Vitest browser tests

import "../../index.css";

import type { MossLocaleCode } from "../../appSettings";
import { ThreadId } from "@synara/contracts";
import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { installRuntimeDiagnostics } from "../../browserTestDiagnostics";
import { commands, page, userEvent } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { WorkLogSubagent } from "../../workLog";
import { TimelineSubagentActivityGroup } from "./TimelineSubagentActivityGroup";

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

function subagent(overrides: Partial<WorkLogSubagent> = {}): WorkLogSubagent {
  return {
    threadId: "thread-default",
    ...overrides,
  };
}

function createHost(width = 390): HTMLDivElement {
  const host = document.createElement("div");
  host.style.cssText = `box-sizing:border-box;width:${width}px;max-width:${width}px;min-height:120px;padding:24px;overflow:hidden;background:var(--background);`;
  document.body.append(host);
  return host;
}

async function blockingAxeViolations() {
  const result = await axe.run(document.body);
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

function hoverRuleLocations() {
  const locations: Array<{ insideHoverMedia: boolean; selector: string }> = [];

  const visitRules = (rules: CSSRuleList, insideHoverMedia: boolean) => {
    for (const rule of Array.from(rules)) {
      if (rule instanceof CSSMediaRule) {
        visitRules(rule.cssRules, insideHoverMedia || rule.conditionText === "(hover: hover)");
      } else if (rule instanceof CSSStyleRule) {
        if (rule.selectorText.includes(".timeline-subagent-chip-interactive:hover")) {
          locations.push({ insideHoverMedia, selector: rule.selectorText });
        }
      }
    }
  };

  for (const stylesheet of Array.from(document.styleSheets)) {
    try {
      visitRules(stylesheet.cssRules, false);
    } catch (error) {
      const href = stylesheet.href;
      const sameOrigin =
        href === null || new URL(href, document.baseURI).origin === window.location.origin;
      if (sameOrigin) {
        throw error;
      }
    }
  }

  return locations;
}

describe("TimelineSubagentActivityGroup browser parity", () => {
  afterEach(async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    localizationTestState.locale = "en";
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    document.documentElement.lang = "en";
    document.body.innerHTML = "";
    vi.restoreAllMocks();
  });

  it("keeps initial chips still, animates one new source once, and opens its resolved id", async () => {
    await page.viewport(720, 360);
    await motionCommands.emulateReducedMotion("no-preference");
    document.documentElement.classList.remove("dark");
    const diagnostics = installRuntimeDiagnostics();
    const host = createHost(720);
    const onOpenThread = vi.fn<(threadId: ThreadId) => void>();
    const screen = await render(
      <TimelineSubagentActivityGroup
        groupId="group-browser"
        subagents={[
          subagent({
            threadId: "provider-scout",
            resolvedThreadId: "resolved-scout",
            nickname: "Scout",
            role: "explorer",
            isActive: true,
            latestUpdate: "Inspecting files",
          }),
          subagent({ threadId: "reviewer", nickname: "Reviewer", rawStatus: "completed" }),
        ]}
        onOpenThread={onOpenThread}
      />,
      { container: host },
    );

    try {
      const group = page.getByTestId("subagent-activity-inline-group");
      await expect
        .poll(() => group.element().querySelectorAll<HTMLElement>(".timeline-subagent-chip").length)
        .toBe(2);

      const initialChips = [
        ...group.element().querySelectorAll<HTMLElement>(".timeline-subagent-chip"),
      ];
      expect(initialChips.every((chip) => !chip.hasAttribute("data-animate-entrance"))).toBe(true);
      expect(initialChips.every((chip) => getComputedStyle(chip).animationName === "none")).toBe(
        true,
      );

      const firstChip = page.getByRole("button", { name: "Open Scout subagent" });
      await firstChip.click();
      expect(onOpenThread).toHaveBeenCalledWith("resolved-scout");
      firstChip.element().focus();
      await userEvent.keyboard("{Enter}");
      expect(onOpenThread).toHaveBeenCalledTimes(2);

      await screen.rerender(
        <TimelineSubagentActivityGroup
          groupId="group-browser"
          subagents={[
            subagent({
              threadId: "provider-scout",
              resolvedThreadId: "resolved-scout",
              nickname: "Scout",
              role: "explorer",
            }),
            subagent({
              threadId: "provider-builder",
              resolvedThreadId: "resolved-builder",
              nickname: "Builder",
              rawStatus: "running",
            }),
          ]}
          onOpenThread={onOpenThread}
        />,
      );

      const newChip = group
        .element()
        .querySelector<HTMLElement>('[data-avatar-seed="provider-builder"]')?.parentElement;
      if (!newChip) throw new Error("new subagent chip missing");
      expect(newChip).toHaveAttribute("data-animate-entrance", "");
      expect(getComputedStyle(newChip).animationName).toContain("timeline-subagent-chip-enter");
      expect(getComputedStyle(newChip).animationDuration).toBe("0.28s");
      expect(getComputedStyle(newChip).animationTimingFunction).toBe(
        "cubic-bezier(0.23, 1, 0.32, 1)",
      );
      expect(getComputedStyle(newChip).transformOrigin).toBe("0px 14px");
      expect(getComputedStyle(newChip).height).toBe("28px");
      expect(getComputedStyle(newChip).fontSize).toBe("14px");
      expect(getComputedStyle(newChip).gap).toBe("6px");
      expect(getComputedStyle(newChip).paddingInlineStart).toBe("6px");
      expect(getComputedStyle(newChip).paddingInlineEnd).toBe("8px");
      expect(getComputedStyle(newChip).marginInlineEnd).toBe("6px");
      expect(newChip.querySelector<HTMLElement>("[data-avatar-seed]")?.offsetWidth).toBe(16);
      expect(newChip.querySelector<HTMLElement>("[data-avatar-seed]")?.offsetHeight).toBe(16);

      newChip.dispatchEvent(
        new AnimationEvent("animationend", {
          bubbles: true,
          animationName: "timeline-subagent-chip-enter",
        }),
      );
      await expect.poll(() => newChip.hasAttribute("data-animate-entrance")).toBe(false);

      await screen.rerender(
        <TimelineSubagentActivityGroup
          groupId="group-browser"
          subagents={[
            subagent({
              threadId: "provider-builder",
              resolvedThreadId: "resolved-builder-2",
              title: "Builder final",
              rawStatus: "completed",
            }),
            subagent({
              threadId: "provider-scout",
              resolvedThreadId: "resolved-scout",
              nickname: "Scout",
              role: "explorer",
              rawStatus: "completed",
            }),
          ]}
          onOpenThread={onOpenThread}
        />,
      );
      const hoverRules = hoverRuleLocations();
      expect(hoverRules).toHaveLength(1);
      expect(hoverRules[0]?.insideHoverMedia).toBe(true);
      const reorderedBuilder = group
        .element()
        .querySelector<HTMLElement>('[data-avatar-seed="provider-builder"]')?.parentElement;
      if (!reorderedBuilder) throw new Error("reordered builder chip missing");
      expect(reorderedBuilder).not.toHaveAttribute("data-animate-entrance");
      expect(reorderedBuilder).toHaveAttribute("data-subagent-thread-id", "resolved-builder-2");
      expect(group.element().textContent).toContain("Builder final");
      expect(group.element().textContent).toContain("finished");
      for (const element of group
        .element()
        .querySelectorAll<HTMLElement>(".timeline-subagent-chip")) {
        element.blur();
      }
      expect(group.element().querySelector(":focus")).toBeNull();
      expect(group.element().querySelector(":focus-visible")).toBeNull();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(720);
      diagnostics.assertHealthy();
      expect(await blockingAxeViolations()).toEqual([]);
      const screenshotPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-subagent-timeline/light.png",
      });
      expect(screenshotPath).toContain("light.png");
    } finally {
      diagnostics.dispose();
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps unresolved rows non-interactive, caps visible rows, and supports dark focus/hover", async () => {
    await page.viewport(720, 360);
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    const diagnostics = installRuntimeDiagnostics();
    const host = createHost(720);
    const onOpenThread = vi.fn<(threadId: ThreadId) => void>();
    const screen = await render(
      <TimelineSubagentActivityGroup
        groupId="group-dark"
        subagents={[
          subagent({ threadId: "one", nickname: "One", rawStatus: "completed" }),
          subagent({ threadId: "two", nickname: "Two", rawStatus: "completed" }),
          subagent({ threadId: "three", nickname: "Three", rawStatus: "stopped" }),
          subagent({ threadId: "four", nickname: "Four", rawStatus: "vendor_warmup" }),
          subagent({ threadId: "unresolved", nickname: "Unresolved" }),
        ]}
        onOpenThread={onOpenThread}
      />,
      { container: host },
    );

    try {
      const group = page.getByTestId("subagent-activity-inline-group");
      await expect
        .poll(() => group.element().querySelectorAll<HTMLElement>(".timeline-subagent-chip").length)
        .toBe(3);
      expect(group.element().querySelectorAll("button")).toHaveLength(0);
      expect(group.element().textContent).toContain("and 2 other subagents");
      expect(group.element().textContent).toContain("were interrupted");
      expect(group.element().textContent).not.toContain("Unresolved");
      for (const chip of group.element().querySelectorAll<HTMLElement>(".timeline-subagent-chip")) {
        expect(chip.offsetHeight).toBe(28);
      }
      expect(
        group.element().querySelector("[data-avatar-seed='one']")?.parentElement,
      ).toBeInstanceOf(HTMLSpanElement);

      await screen.rerender(
        <TimelineSubagentActivityGroup
          groupId="group-dark"
          subagents={[
            subagent({
              threadId: "one",
              nickname: "One",
              resolvedThreadId: "resolved-one",
              rawStatus: "completed",
            }),
            subagent({ threadId: "two", nickname: "Two", rawStatus: "completed" }),
            subagent({ threadId: "three", nickname: "Three", rawStatus: "stopped" }),
            subagent({ threadId: "four", nickname: "Four", rawStatus: "vendor_warmup" }),
          ]}
          onOpenThread={onOpenThread}
        />,
      );
      const firstChip = page.getByRole("button", { name: "Open One subagent" });
      await firstChip.hover();
      firstChip.element().focus();
      expect(firstChip.element().matches(":focus-visible")).toBe(true);
      expect(getComputedStyle(firstChip.element()).outlineWidth).toBe("2px");
      expect(getComputedStyle(firstChip.element()).outlineOffset).toBe("0px");
      await firstChip.click();
      expect(onOpenThread).toHaveBeenCalledWith("resolved-one");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(720);
      diagnostics.assertHealthy();
      expect(await blockingAxeViolations()).toEqual([]);
      const screenshotPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-subagent-timeline/dark-hover-focus.png",
      });
      expect(screenshotPath).toContain("dark-hover-focus.png");
    } finally {
      diagnostics.dispose();
      await screen.unmount();
      host.remove();
    }
  });

  it("disables new-chip animation under reduced motion and preserves Chinese compact flow", async () => {
    await page.viewport(390, 320);
    await motionCommands.emulateReducedMotion("reduce");
    localizationTestState.locale = "zh-CN";
    document.documentElement.classList.remove("dark");
    const diagnostics = installRuntimeDiagnostics();
    const host = createHost(390);
    const screen = await render(
      <TimelineSubagentActivityGroup
        groupId="group-browser-zh"
        subagents={[
          subagent({ threadId: "one", nickname: "一个", statusLabel: "Connecting" }),
          subagent({ threadId: "two", nickname: "两个", isActive: true, latestUpdate: "已更新" }),
        ]}
      />,
      { container: host },
    );

    try {
      const group = page.getByTestId("subagent-activity-inline-group");
      await expect.poll(() => group.element().textContent ?? "").toContain("已更新");
      await screen.rerender(
        <TimelineSubagentActivityGroup
          groupId="group-browser-zh"
          subagents={[
            subagent({ threadId: "one", nickname: "一个", statusLabel: "Connecting" }),
            subagent({ threadId: "two", nickname: "两个", isActive: true, latestUpdate: "已更新" }),
            subagent({ threadId: "three", nickname: "三个", rawStatus: "completed" }),
          ]}
        />,
      );
      const newChip = group
        .element()
        .querySelector<HTMLElement>('[data-avatar-seed="three"]')?.parentElement;
      if (!newChip) throw new Error("reduced-motion chip missing");
      expect(newChip).toHaveAttribute("data-animate-entrance", "");
      expect(getComputedStyle(newChip).animationName).toBe("none");

      await screen.rerender(
        <TimelineSubagentActivityGroup
          groupId="group-browser-zh"
          subagents={[
            subagent({ threadId: "one", nickname: "一个", statusLabel: "Connecting" }),
            subagent({ threadId: "two", nickname: "两个", isActive: true, latestUpdate: "已更新" }),
            subagent({ threadId: "three", nickname: "三个", rawStatus: "completed" }),
            subagent({ threadId: "four", nickname: "四个", rawStatus: "vendor_warmup" }),
          ]}
        />,
      );
      expect(group.element().textContent).toContain("及其他 1 个子智能体");
      expect(group.element().textContent).toContain("已更新");
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(host.scrollWidth).toBeLessThanOrEqual(390);
      diagnostics.assertHealthy();
      expect(await blockingAxeViolations()).toEqual([]);
      const screenshotPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-subagent-timeline/compact-390.png",
      });
      expect(screenshotPath).toContain("compact-390.png");
    } finally {
      diagnostics.dispose();
      await screen.unmount();
      host.remove();
    }
  });
});
