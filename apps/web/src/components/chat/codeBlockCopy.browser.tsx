// FILE: codeBlockCopy.browser.tsx
// Purpose: WALK-6 H-12: with the 差异 pane open the chat narrows, and a transcript code block's
//          copy button sat on the code (「a ⧉ b」). The buttons now have a column of their own:
//          at every width the copy button's box and the first code line's visible text do not
//          meet, for a one-line and a multi-line block.
// Layer: Web appearance tests (real Chromium, real Moss CSS)

import "../../index.css";

import { afterEach, expect, it } from "vitest";
import { page } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import ChatMarkdown from "../ChatMarkdown";
import { TranscriptMarkdownContext } from "./transcript/externalImageHosts";

const ONE_LINE =
  "```js\nexport const sub = (a, b) => a - b; export const mul = (a, b) => a * b; // index.js\n```";
const MULTI_LINE =
  "```js\nexport const sub = (a, b) => a - b; export const mul = (a, b) => a * b; // index.js\nmodule.exports = { add, sub, mul };\n```";

// The chat column at the walker's sizes: a 1101 px window with the 差异 pane open leaves a
// narrow transcript; the wider ones are the chat without the pane.
const CHAT_WIDTHS = [300, 380, 480, 704] as const;

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
  it(`H-12: the copy button never covers the code (${name} block, chat 300 to 704 wide)`, async () => {
    for (const width of CHAT_WIDTHS) {
      await page.viewport(1101, 800);
      const screen = await render(
        <TranscriptMarkdownContext.Provider value>
          <div style={{ width }} className="bg-background text-foreground">
            <ChatMarkdown text={text} cwd={undefined} isStreaming={false} />
          </div>
        </TranscriptMarkdownContext.Provider>,
      );
      try {
        const copy = page.getByRole("button", { name: "Copy code", exact: true });
        await expect.element(copy).toBeVisible();
        const pre = document.querySelector<HTMLElement>(".chat-markdown-codeblock pre")!;
        await expect.poll(() => pre.textContent?.includes("export const sub")).toBe(true);
        const button = copy.element().getBoundingClientRect();
        const line = firstLineVisibleBox(pre);
        expect(line.width, `first line visible at ${width}px`).toBeGreaterThan(0);
        expect(intersects(button, line), `copy over the code at ${width}px`).toBe(false);
        // The block stays inside the chat column, and long lines scroll beneath, not under it.
        const block = document.querySelector<HTMLElement>(".chat-markdown-codeblock")!;
        expect(block.getBoundingClientRect().right).toBeLessThanOrEqual(width + 1);
        expect(button.right).toBeLessThanOrEqual(block.getBoundingClientRect().right);
        expect(pre.getBoundingClientRect().right).toBeLessThanOrEqual(button.left);
        // The first line is 665 px of code: narrower columns scroll it beneath the button column
        // (269, 349 and 449 px of room); at 704 px all 665 px fit, so there is nothing to scroll
        // and nothing under the button (scrollWidth 665 = clientWidth 665).
        if (pre.clientWidth < 665) expect(pre.scrollWidth).toBeGreaterThan(pre.clientWidth);
        else expect(pre.scrollWidth).toBe(pre.clientWidth);
      } finally {
        await screen.unmount();
      }
    }
  });
}
