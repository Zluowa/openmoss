// FILE: ChatMarkdown.zonedTime.test.tsx
// Purpose: A time written in another zone is underlined in a message; one in the reader's
//   own zone, in code, or after a date stays plain text.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

vi.mock("@pierre/diffs", () => ({
  getFiletypeFromFileName: () => "text",
  getSharedHighlighter: () =>
    Promise.resolve({
      codeToHtml: (code: string) => `<pre class="shiki"><code>${code}</code></pre>`,
    }),
}));

vi.mock("../hooks/useTheme", () => ({
  useTheme: () => ({ resolvedTheme: "light" }),
}));

const HEAVY_MODULE_TEST_TIMEOUT_MS = 60_000;

function render(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

function offsetText(minutes: number): string {
  const sign = minutes < 0 ? "-" : "+";
  const abs = Math.abs(minutes);
  return `UTC${sign}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}

describe("ChatMarkdown zoned times", () => {
  it(
    "underlines a time in another zone only",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const local = -new Date().getTimezoneOffset();
      const foreign = offsetText(local === 180 ? 0 : 180);
      const markup = render(
        <ChatMarkdown
          text={`Meet at 12:00 ${foreign}, or 12:00 ${offsetText(local)}. Logged 2026-11-04 12:00 ${foreign}. \`12:00 ${foreign}\``}
          cwd="/repo"
          isStreaming={false}
        />,
      );
      expect(markup.match(/data-zoned-time/g)).toHaveLength(1);
      expect(markup).toContain(`12:00 ${foreign}`);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );
});
