// Oversized fenced blocks retain their source without synchronous highlighting.
import { cleanup, render } from "vitest-browser-react";
import { afterEach, describe, expect, it, vi } from "vitest";

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: "en" as const,
      t: (key: Parameters<typeof actual.translateMoss>[1]) => actual.translateMoss("en", key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Parameters<typeof actual.formatMossTranslation>[2],
      ) => actual.formatMossTranslation("en", key, values),
    }),
  };
});

afterEach(async () => {
  await cleanup();
});

const seams = vi.hoisted(() => {
  const highlight = vi.fn((code: string) => `<pre class="shiki"><code>${code}</code></pre>`);
  return {
    highlight,
    highlighter: Promise.resolve({ codeToHtml: highlight }),
    copy: vi.fn(async (_text: string) => undefined),
  };
});

vi.mock("../lib/syntaxHighlighting", async (original) => ({
  ...(await original<typeof import("../lib/syntaxHighlighting")>()),
  getSyntaxHighlighterPromise: () => seams.highlighter,
}));
vi.mock("../hooks/useCopyToClipboard", () => ({
  copyTextToClipboard: seams.copy,
  useCopyToClipboard: () => ({ copyToClipboard: seams.copy, isCopied: false }),
}));

import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlighting";
import ChatMarkdown from "./ChatMarkdown";

describe("ChatMarkdown highlighting size limit", () => {
  it.each([false, true])(
    "keeps oversized source, find and copy intact (streaming=%s)",
    async (isStreaming) => {
      const screen = await render(
        <ChatMarkdown
          text={`\`\`\`javascript\nconst answer = ${isStreaming ? 43 : 42};\n\`\`\``}
          cwd={undefined}
          isStreaming={false}
        />,
      );
      await expect
        .poll(() => seams.highlight.mock.calls.length, { timeout: 5000 })
        .toBeGreaterThan(0);
      // Wait for the priming block's Suspense commit and effect before clearing its calls.
      await expect
        .poll(() => document.querySelector(".chat-markdown-codeblock pre")?.textContent?.trim())
        .toBe(`const answer = ${isStreaming ? 43 : 42};`);
      await new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      );
      seams.highlight.mockClear();
      seams.copy.mockClear();
      const code = `// ${"x".repeat(MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS)}\nneedle final line`;
      await screen.rerender(
        <ChatMarkdown
          text={`\`\`\`javascript\n${code}\n\`\`\``}
          cwd={undefined}
          isStreaming={isStreaming}
          findQuery="needle"
        />,
      );
      await expect
        .poll(
          () =>
            document.querySelector(".chat-markdown-codeblock pre")?.textContent?.trimEnd().length,
        )
        .toBe(code.length);
      // A concurrent Suspense render may finish the preceding small priming block.
      // The size guard must keep every oversized input out of the highlighter.
      expect(
        seams.highlight.mock.calls.every(
          ([text]) => text.length <= MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS,
        ),
      ).toBe(true);
      expect(document.querySelector("[data-chat-find-match]")?.textContent).toBe("needle");
      await screen.getByRole("button", { name: "Copy code", exact: true }).click();
      expect(seams.copy.mock.calls[0]?.[0] === `${code}\n`).toBe(true);
      await screen.getByRole("button", { name: "Enable soft wrap", exact: true }).click();
      expect(document.querySelector(".chat-markdown-codeblock")?.getAttribute("data-wrap")).toBe(
        "true",
      );
      await screen.unmount();
    },
  );
});
