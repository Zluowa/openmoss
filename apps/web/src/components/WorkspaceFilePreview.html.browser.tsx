// FILE: WorkspaceFilePreview.html.browser.tsx
// Purpose: Keeps HTML preview loading and reloading on the text-file path.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

it("reads library HTML into a sandboxed webview and reloads it from disk", async () => {
  const firstHtml = "<h1>First preview</h1>";
  const nextHtml = "<h1>Updated preview</h1>";
  const file = (contents: string): ProjectReadFileResult => ({
    relativePath: "sample.html",
    contents,
    truncated: false,
    version: `sha256:${"1".repeat(64)}`,
    encoding: "utf8",
    lineEnding: "lf",
  });
  const readFile = vi.fn().mockResolvedValueOnce(file(firstHtml)).mockResolvedValue(file(nextHtml));
  const register = vi.fn().mockImplementation(async ({ html }: { html: string }) => ({
    id: "a".repeat(48),
    partition: `moss-html-preview-${"a".repeat(48)}`,
    src: "moss-local-preview://" + "a".repeat(48) + "/index.html",
    html,
  }));
  const unregister = vi.fn().mockResolvedValue(undefined);
  const previousDescriptor = Object.getOwnPropertyDescriptor(window, "nativeApi");
  const previousDesktopBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects: { readFile } } as unknown as NativeApi,
  });
  Object.defineProperty(window, "desktopBridge", {
    configurable: true,
    value: { htmlPreview: { register, unregister } },
  });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });

  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview
          workspaceRoot="/workspace/fixtures"
          filePath="sample.html"
          previewEntry="library-cloud"
        />
      </QueryClientProvider>,
    );

    const preview = () =>
      document.querySelector<HTMLElement>('[data-presentation="code-preview"] webview');
    await vi.waitFor(() =>
      expect(preview()?.getAttribute("src")).toContain("moss-local-preview://"),
    );
    expect(preview()?.getAttribute("partition")).toBe(`moss-html-preview-${"a".repeat(48)}`);
    expect(register).toHaveBeenCalledWith(expect.objectContaining({ html: firstHtml }));
    expect(readFile).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/workspace/fixtures",
        relativePath: "sample.html",
      }),
      expect.anything(),
    );

    await page.getByRole("button", { name: "Reload file from disk" }).click();

    await vi.waitFor(() =>
      expect(register).toHaveBeenCalledWith(expect.objectContaining({ html: nextHtml })),
    );
    expect(readFile).toHaveBeenCalledTimes(2);
  } finally {
    queryClient.clear();
    if (previousDescriptor) {
      Object.defineProperty(window, "nativeApi", previousDescriptor);
    } else {
      Reflect.deleteProperty(window, "nativeApi");
    }
    if (previousDesktopBridge) {
      Object.defineProperty(window, "desktopBridge", previousDesktopBridge);
    } else {
      Reflect.deleteProperty(window, "desktopBridge");
    }
    document.body.innerHTML = "";
  }
});
