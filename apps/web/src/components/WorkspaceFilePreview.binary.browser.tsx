// FILE: WorkspaceFilePreview.binary.browser.tsx
// Purpose: Covers production wiring for binary preview toolbar actions.
// Layer: Focused component integration tests

import "../index.css";

import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page } from "vitest/browser";
import { afterEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

vi.mock("./PdfFilePreview", () => ({
  PdfFilePreview: (props: { openInTarget: string | null }) => (
    <output data-testid="pdf-open-in-target">{props.openInTarget ?? ""}</output>
  ),
}));

vi.mock("./XlsxReader", () => ({
  XlsxReader: (props: { cacheKey?: string | number; onReload?: () => void }) => (
    <div>
      <output data-testid="xlsx-cache-key">{String(props.cacheKey ?? "")}</output>
      <button type="button" aria-label="Reload file from disk" onClick={props.onReload}>
        Reload
      </button>
    </div>
  ),
}));

import { WorkspaceFilePreview } from "./WorkspaceFilePreview";

function makeQueryClient() {
  return new QueryClient({ defaultOptions: { queries: { retry: false } } });
}

afterEach(() => {
  document.body.innerHTML = "";
});

it("passes the workspace-native target into the PDF preview toolbar", async () => {
  const queryClient = makeQueryClient();
  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot="/workspace" filePath="docs/report.pdf" />
      </QueryClientProvider>,
    );

    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='pdf-open-in-target']")?.textContent).toBe(
        "/workspace/docs/report.pdf",
      ),
    );
  } finally {
    queryClient.clear();
  }
});

it("forwards spreadsheet reload through the production preview wiring", async () => {
  const queryClient = makeQueryClient();
  try {
    await render(
      <QueryClientProvider client={queryClient}>
        <WorkspaceFilePreview workspaceRoot="/workspace" filePath="docs/report.xlsx" />
      </QueryClientProvider>,
    );

    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='xlsx-cache-key']")?.textContent).toBe("0"),
    );
    await page.getByRole("button", { name: "Reload file from disk" }).click();
    await vi.waitFor(() =>
      expect(document.querySelector("[data-testid='xlsx-cache-key']")?.textContent).toBe("1"),
    );
  } finally {
    queryClient.clear();
  }
});
