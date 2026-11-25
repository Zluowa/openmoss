// FILE: codeBlockCopy.browser.tsx
// Purpose: WALK-6 / WALK-13 H-12: with the side panel open at 1100x780 the chat narrows (<= 420px),
//          and a transcript code block's copy button sat inline beside/over the first code line.
//          The actions now live in a dedicated top row above the code body: at every width the
//          action buttons sit strictly above <pre> and never meet code text or narrow the block,
//          for both one-line and multi-line blocks (including multi-action shell blocks).
// Layer: Web appearance tests (real Chromium, real Moss CSS)

import "../../index.css";

import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";
import { CodeRunContext } from "./transcript/codeRun";
import { TranscriptMarkdownContext } from "./transcript/externalImageHosts";

const ONE_LINE =
  "```js\nexport const sub = (a, b) => a - b; export const mul = (a, b) => a * b; // index.js\n```";
const MULTI_LINE =
  "```js\nexport const sub = (a, b) => a - b; export const mul = (a, b) => a * b; // index.js\nmodule.exports = { add, sub, mul };\n```";
const NARROW_SHELL_MULTI_LINE = [
  "```powershell",
  "Get-ChildItem -Path C:\\Windows\\System32 -Filter *.exe | Select-Object -First 5",
  "Write-Output 'done'",
  "```",
].join("\n");

// The chat column at the walker's sizes: a 1100 px window with the side panel open leaves a
// narrow transcript (<= 420 px); the wider ones are the chat without the pane.
const CHAT_WIDTHS = [300, 380, 420, 480, 704] as const;

/** The first line's text, as far as it shows inside the block (the rest scrolls). */
function firstLineVisibleBox(pre: HTMLElement): DOMRect {
  const range = document.createRange();
  range.selectNodeContents(pre);
  const rects = [...range.getClientRects()].filter((rect) => rect.width > 0 && rect.height > 0);
  const top = Math.min(...rects.map((rect) => rect.top));
  const line = rects.filter((rect) => Math.abs(rect.top - top) < 2);
  const left = Math.min(...line.map((rect) => rect.left));
  const right = Math.max(...line.map((rect) => rect.right));
  const bottom = Math.max(...line.map((rect) => rect.bottom));
  const visible = pre.getBoundingClientRect();
  return new DOMRect(
    Math.max(left, visible.left),
    top,
    Math.max(0, Math.min(right, visible.right) - Math.max(left, visible.left)),
    bottom - top,
  );
}

function intersects(a: DOMRect, b: DOMRect): boolean {
  return a.left < b.right && b.left < a.right && a.top < b.bottom && b.top < a.bottom;
}

afterEach(async () => {
  await cleanup();
});

for (const [name, text] of [
  ["one-line", ONE_LINE],
  ["multi-line", MULTI_LINE],
] as const) {
  it(`H-12: the copy button sits in a top bar above the code (${name} block, chat 300 to 704 wide)`, async () => {
    for (const width of CHAT_WIDTHS) {
      await page.viewport(1100, 780);
      const screen = await render(
        <TranscriptMarkdownContext.Provider value>
          <div style={{ width }} className="bg-background text-foreground">
            <ChatMarkdown text={text} cwd={undefined} isStreaming={false} />
          </div>
        </TranscriptMarkdownContext.Provider>,
      );
      try {
        await document.fonts.ready;
        const copy = page.getByRole("button", { name: "Copy code", exact: true });
        await expect.element(copy).toBeVisible();
        const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre")!;
        await expect.poll(() => pre.textContent?.includes("export const sub")).toBe(true);
        const button = copy.element().getBoundingClientRect();
        const preBox = pre.getBoundingClientRect();
        const line = firstLineVisibleBox(pre);
        expect(line.width, `first line visible at ${width}px`).toBeGreaterThan(0);
        expect(intersects(button, line), `copy over the code at ${width}px`).toBe(false);
        // The button sits in a dedicated top row above <pre>, never sharing a row with line 1
        // or squeezing <pre>'s width / scrollbar inside narrow (<= 420px) columns.
        expect(button.bottom, `copy row above pre at ${width}px`).toBeLessThanOrEqual(
          preBox.top + 0.5,
        );
        expect(button.bottom, `copy row above first line at ${width}px`).toBeLessThanOrEqual(
          line.top,
        );
        const block = document.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
        const blockBox = block.getBoundingClientRect();
        expect(blockBox.right).toBeLessThanOrEqual(width + 1);
        expect(button.right).toBeLessThanOrEqual(blockBox.right);
        expect(preBox.width).toBeGreaterThanOrEqual(blockBox.width - 2);
        // Narrow columns (<= 480px) scroll horizontally inside <pre>; at 704px the line fits
        // cleanly inside the column (`fit-content` < 704px) with no horizontal overflow.
        if (width <= 480) expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
        else expect(pre.scrollWidth).toBe(pre.clientWidth);
      } finally {
        await screen.unmount();
      }
    }
  });
}

it("H-12: multi-action shell code block stays clear of code at narrow chat width (<= 420px)", async () => {
  const width = 360;
  await page.viewport(1100, 780);
  const screen = await render(
    <CodeRunContext.Provider value={{ runInTerminal: () => {}, shell: "powershell" }}>
      <TranscriptMarkdownContext.Provider value>
        <div style={{ width }} className="bg-background text-foreground">
          <ChatMarkdown text={NARROW_SHELL_MULTI_LINE} cwd={undefined} isStreaming={false} />
        </div>
      </TranscriptMarkdownContext.Provider>
    </CodeRunContext.Provider>,
  );
  try {
    await document.fonts.ready;
    const run = page.getByRole("button", { name: "Run in PowerShell", exact: true });
    const copy = page.getByRole("button", { name: "Copy code", exact: true });
    await expect.element(run).toBeVisible();
    await expect.element(copy).toBeVisible();
    const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre")!;
    await expect.poll(() => pre.textContent?.includes("Get-ChildItem")).toBe(true);
    const block = document.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
    const blockBox = block.getBoundingClientRect();
    const preBox = pre.getBoundingClientRect();
    const line = firstLineVisibleBox(pre);
    const runBox = run.element().getBoundingClientRect();
    const copyBox = copy.element().getBoundingClientRect();

    expect(blockBox.right).toBeLessThanOrEqual(width + 1);
    expect(preBox.width).toBeGreaterThanOrEqual(blockBox.width - 2);
    expect(intersects(runBox, copyBox)).toBe(false);
    for (const actionBox of [runBox, copyBox]) {
      expect(actionBox.right).toBeLessThanOrEqual(blockBox.right);
      expect(intersects(actionBox, line)).toBe(false);
      expect(actionBox.bottom).toBeLessThanOrEqual(preBox.top + 0.5);
      expect(actionBox.bottom).toBeLessThanOrEqual(line.top);
    }
  } finally {
    await screen.unmount();
  }
});
