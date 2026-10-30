// FILE: WorkspaceFilePreview.tex.browser.tsx
// Purpose: TeX attachments stay on Codex's source-text preview path.
// Layer: Focused component integration test

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

it("renders a TeX attachment as source text instead of the Office fallback", async () => {
  const source = "\\documentclass{article}\\n\\begin{document}Hello\\end{document}";
  const readFile = vi.fn().mockResolvedValue({
    relativePath: "notes.tex",
    contents: source,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  } satisfies ProjectReadFileResult);
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { readFile } } as unknown as NativeApi,
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot="/workspace"
          filePath="notes.tex"
          previewEntry="attachment"
        />
      </QueryClientProvider>,
    );

    await vi.waitFor(() => expect(document.querySelector(".editor-file-viewer")).not.toBeNull());
    expect(document.body.textContent).toContain("Hello");
    expect(document.querySelector('[data-artifact-tab="office"]')).toBeNull();
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({ cwd: "/workspace", relativePath: "notes.tex" }),
      expect.anything(),
    );
  } finally {
    queryClient.clear();
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
    document.body.innerHTML = "";
  }
});
