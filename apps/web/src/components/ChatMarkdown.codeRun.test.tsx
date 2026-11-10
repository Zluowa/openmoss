// FILE: ChatMarkdown.codeRun.test.tsx
// Purpose: A shell code block in a reply shows "Run in terminal" when the chat can run it;
//   other languages, typed messages and markdown outside a chat do not.
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import type { ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { CodeRunContext, type CodeRunActions } from "./chat/transcript/codeRun";

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
const SHELL_REPLY = "Run this:\n\n```bash\n$ bun install\n```\n";

function render(ui: ReactElement, actions: CodeRunActions | null) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return renderToStaticMarkup(
    <QueryClientProvider client={client}>
      <CodeRunContext.Provider value={actions}>{ui}</CodeRunContext.Provider>
    </QueryClientProvider>,
  );
}

const posix: CodeRunActions = { runInTerminal: () => undefined, shell: "posix" };

describe("ChatMarkdown run in terminal", () => {
  it(
    "offers it on a shell block in a reply",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const markup = render(
        <ChatMarkdown text={SHELL_REPLY} cwd="/repo" isStreaming={false} />,
        posix,
      );
      expect(markup).toContain("data-code-run");
      expect(markup).toContain("Run in terminal");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "says PowerShell on Windows",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      const markup = render(<ChatMarkdown text={SHELL_REPLY} cwd="/repo" isStreaming={false} />, {
        ...posix,
        shell: "powershell",
      });
      expect(markup).toContain("Run in PowerShell");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );

  it(
    "leaves other languages, typed messages and chat-less markdown alone",
    async () => {
      const { default: ChatMarkdown } = await import("./ChatMarkdown");
      expect(
        render(
          <ChatMarkdown text={"```ts\nconst a = 1;\n```"} cwd="/repo" isStreaming={false} />,
          posix,
        ),
      ).not.toContain("data-code-run");
      expect(
        render(
          <ChatMarkdown text={SHELL_REPLY} cwd="/repo" isStreaming={false} variant="user" />,
          posix,
        ),
      ).not.toContain("data-code-run");
      expect(
        render(<ChatMarkdown text={SHELL_REPLY} cwd="/repo" isStreaming={false} />, null),
      ).not.toContain("data-code-run");
    },
    HEAVY_MODULE_TEST_TIMEOUT_MS,
  );
});
