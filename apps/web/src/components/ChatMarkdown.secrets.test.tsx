// FILE: ChatMarkdown.secrets.test.tsx
// Purpose: A credential written into a message renders as a "Redacted <kind>" pill,
//   in assistant and user messages alike, and its value stays out of the markup's text.
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
const FAKE_TOKEN = `ghp_${"a1".repeat(18)}`;

function renderWithQueryClient(ui: ReactElement) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(<QueryClientProvider client={client}>{ui}</QueryClientProvider>);
}

describe("ChatMarkdown secret redaction", () => {
  it(
    "redacts a token in an assistant message",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const markup = renderWithQueryClient(
        <ChatMarkdown
          text={`Use \`${FAKE_TOKEN}\` for the API.`}
          cwd="/repo"
          isStreaming={false}
        />,
      );
      expect(markup).toContain("Redacted GitHub token");
      expect(markup).toContain('data-redacted-secret="hidden"');
      expect(markup.replace(/data-value="[^"]*"/g, "")).not.toContain(`>${FAKE_TOKEN}<`);
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "redacts a token in plain paragraph text, keeping the words around it",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const markup = renderWithQueryClient(
        <ChatMarkdown
          text={`Set ${FAKE_TOKEN} before you push.`}
          cwd="/repo"
          isStreaming={false}
        />,
      );
      expect(markup).toContain("Redacted GitHub token");
      expect(markup).toContain("Set ");
      expect(markup).toContain(" before you push.");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "redacts a token a person pasted into their own message",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const markup = renderWithQueryClient(
        <ChatMarkdown
          text={`my key is ${FAKE_TOKEN}`}
          cwd="/repo"
          variant="user"
          isStreaming={false}
        />,
      );
      expect(markup).toContain("Redacted GitHub token");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );
});
