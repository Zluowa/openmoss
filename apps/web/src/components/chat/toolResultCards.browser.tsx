// FILE: toolResultCards.browser.tsx
// Purpose: What a person sees when a tool row opens (L-013, owner 11-20: 「这个卡片的结果ui，没有遵循
//          moss的图标核对设计标准」): a failed command, a file edit, a diff, a file list and an output,
//          in light and dark, Chinese and English. Every result sits on the shared card (radius 12,
//          hairline, no shadow), code in the 13 px code role, no section labels, no native tooltips.
// Layer: Web appearance tests (real Chromium, real Moss CSS, real theme store).

import "../../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import type { MossLocaleCode } from "~/appSettings";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "../../test/browserThemeFixture";
import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";
import { ToolCallDetailsContent } from "./ToolCallDetailsDialog";

const CASES = (["light", "dark"] as const).flatMap((theme) =>
  (["zh-CN", "en"] as const).map((locale) => ({ theme, locale })),
);
/** Section labels the old result card printed in English whatever the language. */
const OLD_LABELS = ["Files", "Diff", "Edits", "Before", "After", "Output", "Stdout", "Stderr"];

const px = (value: string) => Number.parseFloat(value);

/** Alpha of a computed colour (`rgb()`, `rgba()`, `oklab(… / a)`, `color(srgb … / a)`). */
function alphaOf(color: string): number {
  if (color === "transparent") return 0;
  const slash = /\/\s*([\d.]+)(%?)\s*\)$/.exec(color);
  if (slash) return Number(slash[1]) / (slash[2] === "%" ? 100 : 1);
  const rgba = /^rgba\([^,]+,[^,]+,[^,]+,\s*([\d.]+)\)$/.exec(color);
  return rgba ? Number(rgba[1]) : 1;
}

function expectStandardCard(card: HTMLElement) {
  const style = getComputedStyle(card);
  expect(px(style.borderTopLeftRadius)).toBe(12);
  expect(px(style.borderTopWidth)).toBe(1);
  expect(style.boxShadow).toBe("none");
}

function Stage(props: { locale: MossLocaleCode; children: React.ReactNode }) {
  return (
    <BrowserThemeFixture>
      <MossLocaleScope locale={props.locale}>
        <div className="w-[640px] bg-background p-6 text-foreground">{props.children}</div>
      </MossLocaleScope>
    </BrowserThemeFixture>
  );
}

describe.each(CASES)("tool results ($theme, $locale)", ({ theme, locale }) => {
  let restoreTheme: () => void = () => {};
  beforeEach(async () => {
    restoreTheme = installBrowserFixtureTheme(theme);
    await page.viewport(900, 900);
  });
  afterEach(() => restoreTheme());

  it("opens a failed command onto the shared card with code at 13 px and the exit code below", async () => {
    await render(
      <Stage locale={locale}>
        <TimelineWorkEntryRow
          workEntry={{
            id: "failed-command",
            createdAt: "2026-11-24T02:00:00.000Z",
            label: "Ran command",
            tone: "tool",
            itemType: "command_execution",
            toolTitle: "Ran",
            command: "bun run build",
            toolDetails: {
              kind: "command",
              title: "Ran",
              command: "bun run build",
              output: { stderr: "error: Cannot find module 'vite'", exitCode: 1 },
            },
          }}
          chatMetaFontSizePx={13}
          textFontSizePx={14}
          markdownCwd={undefined}
          onImageExpand={() => {}}
          timestampFormat="locale"
        />
      </Stage>,
    );
    await userEvent.click(
      page.elementLocator(document.querySelector('[data-tool-detail-trigger="true"]')!),
    );
    await expect.poll(() => document.querySelector("[data-command-shell]")).not.toBeNull();
    const shell = document.querySelector<HTMLElement>("[data-command-shell]")!;
    expect(shell.getAttribute("data-slot")).toBe("card");
    expectStandardCard(shell);
    const command = shell.querySelector<HTMLElement>("[data-shell-command]")!;
    const output = shell.querySelector<HTMLElement>("[data-shell-output-scroll]")!;
    expect(px(getComputedStyle(command).fontSize)).toBe(13);
    expect(px(getComputedStyle(output).fontSize)).toBe(13);
    expect(getComputedStyle(output).fontWeight).toBe(getComputedStyle(command).fontWeight);
    expect(shell.querySelector("[data-shell-footer]")?.getAttribute("data-shell-footer")).toBe(
      "exit-code",
    );
    expect(
      px(getComputedStyle(shell.querySelector<HTMLElement>("[data-shell-footer]")!).fontSize),
    ).toBe(13);
    // Copy controls are the shared icon button (24 px square), labelled, no OS tooltip.
    const copy = shell.querySelector<HTMLElement>('[data-shell-copy="output"]')!;
    expect(copy.getBoundingClientRect().height).toBe(24);
    expect(copy.getAttribute("aria-label")).toBeTruthy();
    expect(shell.querySelector("[title]")).toBeNull();
  });

  it("shows an edit, a diff, a file list and an output with no labels, in the theme's diff colours", async () => {
    await render(
      <Stage locale={locale}>
        <ToolCallDetailsContent
          details={{
            kind: "file-change",
            title: "Edited",
            files: ["src/app.ts", "src/lib/math.ts"],
            diff: "@@ -1 +1 @@\n-const a = 1;\n+const a = 2;",
            edits: [{ path: "src/app.ts", oldText: "const a = 1;", newText: "const a = 2;" }],
            output: { stdout: "ok", exitCode: 2, truncated: true },
          }}
        />
      </Stage>,
    );
    const root = document.querySelector<HTMLElement>("[data-tool-call-details]")!;
    const text = root.textContent ?? "";
    for (const label of OLD_LABELS) expect(text).not.toMatch(new RegExp(`\\b${label}\\b`));
    expect(root.querySelector("[title]")).toBeNull();
    for (const card of root.querySelectorAll<HTMLElement>('[data-slot="card"]')) {
      expectStandardCard(card);
      // No card inside a card.
      expect(card.parentElement?.closest('[data-slot="card"]')).toBeNull();
    }
    // Files are list rows, 32 high, each with the app's file icon.
    const rows = root.querySelectorAll<HTMLElement>('[data-tool-files] [data-slot="list-row"]');
    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row.getBoundingClientRect().height).toBe(32);
      expect(row.querySelector("svg, [data-slot='central-icon']")).not.toBeNull();
    }
    // Added and removed lines take the theme's colour at 8% under same-colour text.
    const diffLines = [...root.querySelectorAll<HTMLElement>("[data-tool-diff] span")];
    const added = diffLines.find((line) => line.textContent === "+const a = 2;")!;
    const removed = diffLines.find((line) => line.textContent === "-const a = 1;")!;
    expect(alphaOf(getComputedStyle(added).backgroundColor)).toBeCloseTo(0.08, 2);
    expect(alphaOf(getComputedStyle(removed).backgroundColor)).toBeCloseTo(0.08, 2);
    expect(getComputedStyle(added).color).not.toBe(getComputedStyle(removed).color);
    expect(px(getComputedStyle(added).fontSize)).toBe(13);
    // A failed exit is the shared error badge (18 high, 12 px, tinted).
    const exit = root.querySelector<HTMLElement>("[data-tool-exit-code]")!;
    expect(exit.getAttribute("data-slot")).toBe("badge");
    expect(exit.getBoundingClientRect().height).toBe(18);
    expect(px(getComputedStyle(exit).fontSize)).toBe(12);
    expect(exit.textContent).toContain(locale === "zh-CN" ? "退出代码" : "Exit code");
  });

  it("shows a long file path in full, wrapping instead of losing the file name", async () => {
    const long = `/home/moss/projects/${"nested-folder/".repeat(8)}index.js`;
    await render(
      <Stage locale={locale}>
        <ToolCallDetailsContent
          details={{
            kind: "file-change",
            title: "Edited",
            files: [long],
            edits: [{ path: long, oldText: "a", newText: "b" }],
          }}
        />
      </Stage>,
    );
    const root = document.querySelector<HTMLElement>("[data-tool-call-details]")!;
    for (const holder of [
      root.querySelector<HTMLElement>("[data-tool-files] [data-translation-skip]")!,
      root.querySelector<HTMLElement>("[data-tool-edit] > div")!,
    ]) {
      expect(holder.textContent).toBe(long);
      // Nothing is clipped: the text fits its box, and it wraps onto more than one line.
      expect(holder.scrollWidth).toBeLessThanOrEqual(holder.clientWidth + 1);
      expect(holder.getBoundingClientRect().height).toBeGreaterThan(24);
    }
  });

  it("shows nothing more when a call returned nothing", async () => {
    await render(
      <Stage locale={locale}>
        <div data-testid="host">
          <ToolCallDetailsContent details={undefined} />
        </div>
      </Stage>,
    );
    expect(document.querySelector('[data-testid="host"]')!.textContent).toBe("");
  });
});
