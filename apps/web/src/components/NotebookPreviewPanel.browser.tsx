import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { NotebookPreviewPanel } from "./NotebookPreviewPanel";

afterEach(() => {
  document.body.innerHTML = "";
});

it("renders notebook content, safely isolates HTML, and collapses a cell", async () => {
  const onPreviewReady = vi.fn();
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const contents = JSON.stringify({
    metadata: { title: "Notebook fixture" },
    cells: [
      {
        cell_type: "code",
        execution_count: 9,
        metadata: { codex: { title: "Compute", descriptionMarkdown: "Calculate the result" } },
        source: "print(42)",
        outputs: [
          { output_type: "stream", text: "42\n" },
          {
            output_type: "display_data",
            data: {
              "text/html":
                "<table><tr><td>Table value</td></tr></table><script>window.parent.__notebookExecuted=true</script>",
            },
          },
        ],
      },
      { cell_type: "markdown", source: "# Findings\nA **result**" },
    ],
  });
  const screen = await render(
    <QueryClientProvider client={queryClient}>
      <NotebookPreviewPanel
        filePath="fixture.ipynb"
        contents={contents}
        onPreviewReady={onPreviewReady}
      />
    </QueryClientProvider>,
  );
  await expect.element(screen.getByText("IPYNB · 2 cells")).toBeVisible();
  await expect.element(screen.getByText("Read only")).toBeVisible();
  await expect.element(screen.getByText("Run 9")).toBeVisible();
  await expect.element(screen.getByRole("button", { name: "Run all" })).toBeDisabled();
  await expect.element(screen.getByRole("button", { name: "Restart kernel" })).toBeDisabled();
  await expect.element(screen.getByRole("heading", { name: "Findings" })).toBeVisible();
  expect(onPreviewReady).toHaveBeenCalled();
  const frame = document.querySelector<HTMLIFrameElement>('iframe[title="Notebook HTML output"]');
  expect(frame?.getAttribute("sandbox")).toBe("");
  expect(frame?.srcdoc).toContain("script-src 'none'");
  expect(frame?.srcdoc).toContain("Table value");
  expect((window as unknown as Record<string, unknown>).__notebookExecuted).toBeUndefined();
  await screen.getByRole("button", { name: "Code", exact: true }).click();
  await expect.element(screen.getByText("print(42)", { exact: false })).toBeVisible();
  await screen.getByRole("button", { name: "Compute, cell 1 of 2" }).click();
  expect(document.querySelector('[data-notebook-cell="0"] [aria-expanded="false"]')).not.toBeNull();
  queryClient.clear();
});

it("settles errors and displays invalid input without leaving loading active", async () => {
  const onPreviewError = vi.fn();
  const onPreviewReady = vi.fn();
  const screen = await render(
    <NotebookPreviewPanel
      filePath="invalid.ipynb"
      contents="broken json"
      onPreviewError={onPreviewError}
      onPreviewReady={onPreviewReady}
    />,
  );
  await expect.element(screen.getByRole("alert")).toBeVisible();
  expect(onPreviewError).toHaveBeenCalledWith(expect.any(Error));
  expect(onPreviewReady).not.toHaveBeenCalled();
});
