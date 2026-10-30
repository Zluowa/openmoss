// FILE: MessagesTimeline.reasoning.browser.tsx
// Purpose: Verify reasoning primitive lifecycle, disclosure semantics, motion,
//          geometry, keyboard interaction, and reduced-motion behavior.
// Layer: Vitest browser tests

import "../../index.css";

import axe from "axe-core";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page, userEvent, commands } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { WorkLogEntry } from "../../workLog";
import { TimelineReasoningRow } from "./TimelineReasoningRow";
import type { MossLocaleCode } from "../../appSettings";

const localizationTestState = vi.hoisted(() => ({ locale: "en" as MossLocaleCode }));

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

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

function reasoningEntry(
  detail = "**Planning the change**\n\nInspecting the adapter.",
): WorkLogEntry {
  return {
    id: "reasoning-browser",
    createdAt: "2026-08-28T00:00:00.000Z",
    label: "Reasoning trace",
    toolTitle: "Reasoning trace",
    detail,
    tone: "tool",
  };
}

function createHost(width = 720, height = 420): HTMLDivElement {
  const host = document.createElement("div");
  const dark = document.documentElement.classList.contains("dark");
  host.style.cssText = [
    "box-sizing:border-box",
    `width:${width}px`,
    `max-width:${width}px`,
    `height:${height}px`,
    `padding:24px`,
    "overflow:hidden",
    `background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--background:${dark ? "#0e0e0e" : "#f6f6f6"}`,
    `--foreground:${dark ? "#f5f5f5" : "#202020"}`,
    `--muted-foreground:${dark ? "#c3c3c3" : "#616161"}`,
    `--color-border:${dark ? "#353535" : "#d0d0d0"}`,
    `--color-text-foreground-secondary:${dark ? "#b9b9b9" : "#616161"}`,
    `--color-text-tertiary:${dark ? "#c2c2c2" : "#616161"}`,
  ].join(";");
  document.body.append(host);
  return host;
}

function setDarkBrowserTheme(): void {
  const values = {
    "--background": "#0e0e0e",
    "--foreground": "#f5f5f5",
    "--muted-foreground": "#9a9a9a",
    "--muted": "#242424",
    "--color-background-elevated-secondary": "#202020",
    "--color-border": "#3d3f41",
    "--color-border-heavy": "#626262",
    "--color-text-foreground": "#f5f5f5",
    "--color-text-foreground-secondary": "#c2c2c2",
    "--color-text-tertiary": "#c2c2c2",
    "--surface-border": "#3d3f41",
    "--ring": "#767676",
  } as const;
  for (const [name, value] of Object.entries(values)) {
    document.documentElement.style.setProperty(name, value);
  }
}

async function blockingAxeViolations() {
  const result = await axe.run(document.body);
  return result.violations.filter(
    (violation) => violation.impact === "serious" || violation.impact === "critical",
  );
}

function ReasoningHarness(props: { active: boolean; detail?: string }) {
  return (
    <TimelineReasoningRow
      entry={reasoningEntry(props.detail)}
      active={props.active}
      chatMetaFontSizePx={14}
      textFontSizePx={14}
      markdownCwd={undefined}
      onImageExpand={() => {}}
    />
  );
}

describe("TimelineReasoningRow browser parity", () => {
  afterEach(async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    document.documentElement.classList.remove("dark");
    document.body.classList.remove("dark");
    document.documentElement.removeAttribute("style");
    document.body.innerHTML = "";
    localizationTestState.locale = "en";
  });

  it("auto-expands active reasoning, scrolls only its body, and preserves elapsed on settle", async () => {
    await page.viewport(720, 420);
    document.documentElement.classList.remove("dark");
    const host = createHost();
    const screen = await render(
      <ReasoningHarness
        active
        detail={`**Planning the change**\n\n${"A reasoning line that stays inside the body.\n\n".repeat(16)}`}
      />,
      { container: host },
    );

    try {
      const row = document.querySelector<HTMLElement>('[data-reasoning-row="true"]');
      if (!row) throw new Error("reasoning row missing");
      await expect.element(page.getByText("Thinking", { exact: true })).toBeInTheDocument();
      const activeHeader = document.querySelector<HTMLElement>('[data-reasoning-header="true"]');
      if (!activeHeader) throw new Error("active reasoning header missing");
      expect(activeHeader.className).toContain("codex-text-shimmer");
      expect(getComputedStyle(activeHeader).animationName).toBe("none");
      expect(getComputedStyle(activeHeader).backgroundImage).toBe("none");
      expect(getComputedStyle(activeHeader).display).toBe("inline-block");
      const sweep = activeHeader.querySelector<HTMLElement>(".codex-text-shimmer-sweep");
      if (!sweep) throw new Error("reasoning shimmer sweep missing");
      expect(sweep.getAttribute("aria-hidden")).toBe("true");
      expect(sweep.hasAttribute("inert")).toBe(true);
      await expect
        .poll(() => getComputedStyle(sweep).animationName)
        .toBe("codex-text-shimmer-sweep");
      expect(getComputedStyle(sweep).animationDuration).toBe("1s");
      expect(getComputedStyle(sweep).animationTimingFunction).toContain("steps(48");
      expect(getComputedStyle(sweep).maskImage).toContain("20%");
      const body = document.querySelector<HTMLElement>('[data-reasoning-body="true"]');
      if (!body) throw new Error("active reasoning body missing");
      expect(body.getAttribute("data-reasoning-active")).toBe("true");
      const disclosure = body.closest<HTMLElement>('[data-reasoning-disclosure="true"]');
      if (!disclosure) throw new Error("reasoning disclosure shell missing");
      expect(getComputedStyle(disclosure).transitionProperty).toBe("height, opacity");
      expect(getComputedStyle(disclosure).transitionDuration).toBe("0.3s");
      expect(getComputedStyle(disclosure).transitionTimingFunction).toBe(
        "cubic-bezier(0.19, 1, 0.22, 1)",
      );
      expect(getComputedStyle(body).maxHeight).toBe("140px");
      expect(body.className).toContain("scroll-fade-y");
      expect(getComputedStyle(body).getPropertyValue("--scroll-fade-size").trim()).toBe("1rem");
      expect(body.scrollHeight).toBeGreaterThan(body.clientHeight);
      expect(getComputedStyle(body).maskImage).toContain("linear-gradient");
      expect(body.scrollTop).toBeGreaterThanOrEqual(0);
      expect(document.querySelector('[data-reasoning-trigger="true"]')).toBeNull();
      expect(await blockingAxeViolations()).toEqual([]);

      const lightPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-reasoning/light-active.png",
      });
      expect(lightPath).toContain("light-active.png");

      await new Promise((resolve) => window.setTimeout(resolve, 25));
      await screen.rerender(<ReasoningHarness active={false} />);
      await expect.poll(() => document.body.textContent ?? "").toContain("Thought for");
      const trigger = page.getByRole("button", { name: /Thought for/u });
      expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("cold settled reasoning starts collapsed and opens with mouse and keyboard", async () => {
    await page.viewport(720, 420);
    document.documentElement.classList.add("dark");
    document.body.classList.add("dark");
    setDarkBrowserTheme();
    const host = createHost();
    const screen = await render(<ReasoningHarness active={false} />, { container: host });

    try {
      const trigger = page.getByRole("button", { name: "Thought" });
      await expect.element(trigger).toBeVisible();
      expect(trigger.element().getAttribute("aria-expanded")).toBe("false");
      expect(trigger.element().getAttribute("aria-controls")).toMatch(/^reasoning-body-/u);
      expect(trigger.element().className).toContain("text-text/30");
      expect(document.querySelector('[data-reasoning-body="true"]')).toBeNull();
      const chevron = trigger.element().querySelector<HTMLElement>('[data-slot="central-icon"]');
      if (!chevron) throw new Error("settled reasoning chevron missing");
      expect(chevron.getAttribute("class")).toContain("icon-2xs");
      expect(chevron.getAttribute("class")).toContain("size-3.5");
      expect(getComputedStyle(chevron).width).toBe("14px");
      expect(getComputedStyle(chevron).height).toBe("14px");
      // Pointer position survives earlier browser interactions. Establish the
      // resting state before checking the hover-only chevron's hidden style.
      await userEvent.unhover(trigger);
      expect(trigger.element().matches(":hover")).toBe(false);
      expect(getComputedStyle(chevron).opacity).toBe("0");
      expect(getComputedStyle(chevron).transitionProperty).toContain("transform");
      expect(getComputedStyle(chevron).transitionDuration).toBe("0.3s");
      expect(getComputedStyle(trigger.element()).padding).toBe("0px");

      await trigger.hover();
      await expect.poll(() => getComputedStyle(chevron).opacity).toBe("1");

      trigger.element().focus();
      await userEvent.keyboard("{Enter}");
      await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("true");
      expect(getComputedStyle(chevron).opacity).toBe("1");
      expect(chevron.getAttribute("class")).toContain("rotate-90");
      await expect.poll(() => getComputedStyle(chevron).rotate).toBe("90deg");
      const region = document.querySelector<HTMLElement>('[data-reasoning-body="true"]')
        ?.parentElement?.parentElement;
      if (!region) throw new Error("settled reasoning disclosure region missing");
      expect(region.getAttribute("aria-hidden")).not.toBe("true");
      expect(region.hasAttribute("inert")).toBe(false);
      expect(document.querySelector('[data-reasoning-body="true"]')?.textContent).toContain(
        "Inspecting the adapter.",
      );
      const shortBody = document.querySelector<HTMLElement>('[data-reasoning-body="true"]');
      if (!shortBody) throw new Error("settled reasoning body missing");
      expect(shortBody.scrollHeight).toBeLessThanOrEqual(shortBody.clientHeight);
      expect(getComputedStyle(shortBody).getPropertyValue("--scroll-fade-b").trim()).toBe("0px");
      await expect(blockingAxeViolations()).resolves.toEqual([]);

      trigger.element().blur();
      const darkPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-reasoning/dark-completed-expanded.png",
      });
      expect(darkPath).toContain("dark-completed-expanded.png");

      await trigger.click();
      await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("false");
      await trigger.click();
      await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("true");
      trigger.element().focus();
      await userEvent.keyboard("{Space}");
      await expect.poll(() => trigger.element().getAttribute("aria-expanded")).toBe("false");
      const closedRegion = document
        .querySelector<HTMLElement>('[data-reasoning-body="true"]')
        ?.closest<HTMLElement>("[aria-hidden]");
      if (closedRegion) {
        expect(closedRegion.getAttribute("aria-hidden")).toBe("true");
        expect(closedRegion.hasAttribute("inert")).toBe(true);
      }
    } finally {
      await screen.unmount();
      host.remove();
    }
  });

  it("keeps Chinese compact copy and disables disclosure motion under reduced motion", async () => {
    await page.viewport(390, 320);
    await motionCommands.emulateReducedMotion("reduce");
    document.documentElement.classList.remove("dark");
    localizationTestState.locale = "zh-CN";
    const host = createHost(390);
    const screen = await render(<ReasoningHarness active={false} />, { container: host });

    try {
      // The test surface uses the app's locale switch in the browser harness;
      // setting the document language exercises the same CSS/DOM path while
      // keeping this primitive independent of a provider runtime.
      document.documentElement.lang = "zh-CN";
      expect(window.matchMedia("(prefers-reduced-motion: reduce)").matches).toBe(true);
      const trigger = page.getByRole("button", { name: "已完成思考" });
      await expect.element(trigger).toBeVisible();
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(390);
      expect(trigger.element().className).toContain("focus-visible:ring-2");
      expect(trigger.element().className).toContain("group/activity-header");
      expect(trigger.element().className).toContain("cursor-interaction");
      expect(trigger.element().className).toContain("bg-transparent");
      expect(trigger.element().className).toContain("p-0");
      expect(trigger.element().className).toContain("focus-visible:ring-inset");
      expect(trigger.element().className).not.toContain("active:bg-foreground");
      expect(trigger.element().className).not.toContain("px-1.5");
      expect(trigger.element().className).not.toContain("py-0.5");
      expect(trigger.element().className).not.toContain("min-h-6");
      expect(getComputedStyle(trigger.element()).padding).toBe("0px");
      const chevron = trigger.element().querySelector<HTMLElement>('[data-slot="central-icon"]');
      if (!chevron) throw new Error("compact reasoning chevron missing");
      // Exercise a carried-over hover explicitly: reduced motion changes the
      // transition, not whether a hovered disclosure advertises its affordance.
      await trigger.hover();
      expect(trigger.element().matches(":hover")).toBe(true);
      expect(getComputedStyle(chevron).opacity).toBe("1");
      await userEvent.unhover(trigger);
      expect(trigger.element().matches(":hover")).toBe(false);
      expect(getComputedStyle(chevron).opacity).toBe("0");
      const compactPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-reasoning/compact-390-zh.png",
      });
      expect(compactPath).toContain("compact-390-zh.png");
      await trigger.hover();
      await expect.poll(() => getComputedStyle(chevron).opacity).toBe("1");
      trigger.element().focus();
      expect(document.activeElement).toBe(trigger.element());
      expect(getComputedStyle(chevron).opacity).toBe("1");
      expect(getComputedStyle(chevron).transform).toBe("none");
      expect(getComputedStyle(trigger.element()).boxShadow).not.toBe("none");
      expect(getComputedStyle(trigger.element()).boxShadow).toContain("inset");
      const focusPath = await page.screenshot({
        path: "../../../../../.tmp/ui-parity/HEL-46-reasoning/focus.png",
      });
      expect(focusPath).toContain("focus.png");

      await trigger.click();
      const body = document.querySelector<HTMLElement>('[data-reasoning-body="true"]');
      const shell = body?.parentElement?.parentElement?.parentElement;
      const content = body?.parentElement;
      if (!shell || !content || !chevron) throw new Error("reasoning motion controls missing");
      expect(shell.getAttribute("data-reasoning-disclosure")).toBe("true");
      expect(getComputedStyle(shell).transitionDuration).toBe("0s");
      expect(getComputedStyle(shell).transitionProperty).toBe("none");
      expect(getComputedStyle(content).transitionDuration).toBe("0s");
      expect(getComputedStyle(content).transitionProperty).toBe("none");
      expect(getComputedStyle(chevron).transitionDuration).toBe("0s");
      expect(getComputedStyle(chevron).transitionProperty).toBe("none");
      expect(getComputedStyle(chevron).opacity).toBe("1");
      expect(chevron.getAttribute("class")).toContain("rotate-90");
      await expect.poll(() => getComputedStyle(chevron).rotate).toBe("90deg");
      expect(await blockingAxeViolations()).toEqual([]);
    } finally {
      await screen.unmount();
      host.remove();
    }
  });
});
