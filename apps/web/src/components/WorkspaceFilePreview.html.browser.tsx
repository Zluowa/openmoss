// FILE: WorkspaceFilePreview.html.browser.tsx
// Purpose: HTML files open rendered from every entry point, always in an opaque,
//          offline sandbox served from a scoped grant that names no local folder; the
//          source is one switch away.
// Layer: Focused component integration tests

import "../index.css";

import type { NativeApi, ProjectReadFileResult } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

const htmlFile = (relativePath: string, contents: string): ProjectReadFileResult => ({
  relativePath,
  contents,
  truncated: false,
  version: `sha256:${"1".repeat(64)}`,
  encoding: "utf8",
  lineEnding: "lf",
});

async function withNativeApi(
  projects: Partial<NativeApi["projects"]>,
  run: (queryClient: QueryClient) => Promise<void>,
) {
  const previousApi = Object.getOwnPropertyDescriptor(window, "nativeApi");
  const previousBridge = Object.getOwnPropertyDescriptor(window, "desktopBridge");
  Object.defineProperty(window, "nativeApi", {
    configurable: true,
    value: { projects } as unknown as NativeApi,
  });
  Object.defineProperty(window, "desktopBridge", { configurable: true, value: undefined });
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  try {
    await run(queryClient);
  } finally {
    queryClient.clear();
    if (previousApi) Object.defineProperty(window, "nativeApi", previousApi);
    else Reflect.deleteProperty(window, "nativeApi");
    if (previousBridge) Object.defineProperty(window, "desktopBridge", previousBridge);
    else Reflect.deleteProperty(window, "desktopBridge");
    document.body.innerHTML = "";
  }
}

const frame = (title: string) =>
  document.querySelector<HTMLIFrameElement>(`iframe[title="${title}"]`);

it.each(["local", "library-cloud", "library-local", "attachment"] as const)(
  "renders %s HTML by default in the same opaque sandbox, with a source switch",
  async (previewEntry) => {
    const createLocalFilePreviewGrant = vi.fn().mockResolvedValue({
      grant: "library-grant",
      expiresAt: new Date(Date.now() + 120_000).toISOString(),
    });
    const readFile = vi.fn().mockResolvedValue(htmlFile("report.html", "<h1>Report</h1>"));
    await withNativeApi({ readFile, createLocalFilePreviewGrant }, async (queryClient) => {
      await render(
        <QueryClientProvider client={queryClient}>
          <WorkspaceFilePreview
            workspaceRoot="/workspace/library"
            filePath="report.html"
            previewEntry={previewEntry}
          />
        </QueryClientProvider>,
      );
      await vi.waitFor(() => expect(frame("report.html")).not.toBeNull());
      expect([...frame("report.html")!.sandbox]).toEqual(["allow-scripts"]);
      await expect
        .element(page.getByRole("radio", { name: "HTML preview", exact: true }))
        .toHaveAttribute("aria-checked", "true");
      await page.getByRole("radio", { name: "HTML source", exact: true }).click();
      expect(frame("report.html")).toBeNull();
    });
  },
);

it("renders a workspace page first, only inside the opaque sandbox, and shows its source on request", async () => {
  const html = '<h1>Untrusted page</h1><script>fetch("https://example.com")</script>';
  const readFile = vi.fn().mockResolvedValue(htmlFile("page.html", html));
  const createLocalFilePreviewGrant = vi.fn().mockResolvedValue({
    grant: "page-grant",
    expiresAt: new Date(Date.now() + 120_000).toISOString(),
  });
  await withNativeApi({ readFile, createLocalFilePreviewGrant }, async (queryClient) => {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot="/workspace/fixtures" filePath="page.html" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(frame("page.html")).not.toBeNull());
    // The page runs only in the frame: scripts in an opaque origin, no Moss origin,
    // storage, forms, popups or navigation; the grant names the file alone.
    expect([...frame("page.html")!.sandbox]).toEqual(["allow-scripts"]);
    expect(frame("page.html")!.hasAttribute("srcdoc")).toBe(false);
    expect(createLocalFilePreviewGrant).toHaveBeenCalledWith({
      path: "/workspace/fixtures/page.html",
    });
    await expect
      .element(page.getByRole("radio", { name: "HTML preview", exact: true }))
      .toHaveAttribute("aria-checked", "true");
    // A rendered page is not labelled read-only: there is nothing to type into.
    expect(document.body.textContent).not.toContain("Read-only");

    await page.getByRole("radio", { name: "HTML source", exact: true }).click();
    expect(frame("page.html")).toBeNull();
    await expect.element(page.getByText("Untrusted page", { exact: false })).toBeVisible();
  });
});

it("renders in an opaque sandbox from a scoped URL, with source switch and reload", async () => {
  const grant = "browser-scoped-preview";
  const createLocalFilePreviewGrant = vi
    .fn()
    .mockResolvedValue({ grant, expiresAt: new Date(Date.now() + 120_000).toISOString() });
  const readFile = vi
    .fn()
    .mockResolvedValueOnce(htmlFile("site/index.html", '<h1>First</h1><img src="photo.png">'))
    .mockResolvedValue(htmlFile("site/index.html", "<h1>Updated</h1>"));
  await withNativeApi({ readFile, createLocalFilePreviewGrant }, async (queryClient) => {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot="E:/演示" filePath="site/index.html" />
      </QueryClientProvider>,
    );
    await vi.waitFor(() => expect(frame("index.html")).not.toBeNull());
    const rendered = frame("index.html")!;
    expect(createLocalFilePreviewGrant).toHaveBeenCalledWith({ path: "E:/演示/site/index.html" });

    // Opaque origin: scripts only, none of Moss's origin, storage or navigation.
    expect([...rendered.sandbox]).toEqual(["allow-scripts"]);
    expect(rendered.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(rendered.hasAttribute("srcdoc")).toBe(false);

    // The frame URL carries the grant and the file name only.
    const src = new URL(rendered.src);
    expect(decodeURIComponent(src.pathname)).toBe(`/api/local-html/${grant}/index.html`);
    expect(src.search).toBe("");
    for (const folder of ["演示", "site", "E:"]) {
      expect(decodeURIComponent(rendered.src)).not.toContain(folder);
    }

    await page.getByRole("button", { name: "More actions" }).click();
    await page.getByRole("menuitem", { name: "Reload file from disk" }).click();
    await vi.waitFor(() => expect(readFile).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(frame("index.html")).not.toBe(rendered));

    await page.getByRole("radio", { name: "HTML source", exact: true }).click();
    expect(frame("index.html")).toBeNull();
    await expect.element(page.getByText("Updated", { exact: false })).toBeVisible();
  });
});
