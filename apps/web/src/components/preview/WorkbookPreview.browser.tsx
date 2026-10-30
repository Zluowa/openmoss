import "../../index.css";

import { page, userEvent } from "@vitest/browser/context";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { workbookFixture } from "~/lib/preview/workbookFixtures";
import { readDelimitedWorkbook } from "~/lib/preview/workbookModel";
import { readXlsxWorkbook } from "~/lib/preview/workbookXlsx";

import { XlsxReader } from "../XlsxReader";
import { WorkbookPreview } from "./WorkbookPreview";

vi.mock("../chat/OpenInPicker", () => ({
  OpenInPicker: () => <button type="button">Open in test host</button>,
}));
// The 700-800px hosts are wider than the default 414px viewport, and the app root clips horizontal
// overflow, so a control past the right edge cannot be scrolled into view and a click misses it.
beforeEach(async () => {
  await page.viewport(1280, 900);
});
afterEach(() => {
  vi.restoreAllMocks();
  document.body.innerHTML = "";
});

it("loads a real XLSX ZIP, shows formula source, navigates merged/hidden cells, copies a range, switches sheets and zooms", async () => {
  const workbook = await readXlsxWorkbook(await workbookFixture());
  const onAnnotate = vi.fn();
  await render(
    <div style={{ width: 800, height: 500 }}>
      <WorkbookPreview workbook={workbook} onAnnotate={onAnnotate} />
    </div>,
  );
  const grid = page.getByRole("grid", { name: "Spreadsheet canvas" });
  const address = page.getByRole("textbox", { name: "Cell or range address" });
  await expect.element(grid).toBeVisible();
  await address.fill("C3");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("textbox", { name: "Formula bar" })).toHaveValue("=B3*2");
  await userEvent.keyboard("{ArrowDown}");
  await expect.element(address).toHaveValue("C5");
  await address.fill("A3:C3");
  await userEvent.keyboard("{Enter}");
  const transfer = new DataTransfer();
  grid
    .element()
    .dispatchEvent(new ClipboardEvent("copy", { bubbles: true, clipboardData: transfer }));
  expect(transfer.getData("text/plain")).toBe("2024-01-01\t$1,234.50\t2,469.00");
  await page.getByRole("button", { name: "Attach selected range to chat" }).click();
  expect(onAnnotate).toHaveBeenCalledWith({
    sheetName: "Financials",
    range: "A3:C3",
    quote: "2024-01-01\t$1,234.50\t2,469.00",
  });
  await page.getByRole("tab", { name: "Second sheet" }).click();
  await address.fill("B2");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("textbox", { name: "Formula bar" })).toHaveValue("second");
  await page.getByRole("combobox", { name: "Spreadsheet zoom" }).selectOptions("150");
  await expect.element(page.getByRole("combobox", { name: "Spreadsheet zoom" })).toHaveValue("150");
  expect(document.querySelectorAll('[role="tab"]')).toHaveLength(2);
  const canvas = grid.element() as HTMLCanvasElement;
  expect(canvas.width).toBeGreaterThan(500);
  expect(canvas.getContext("2d")?.getImageData(100, 100, 1, 1).data[3]).toBe(255);
});

it("keeps 150000 CSV rows virtual, preserves the first record, and navigates to the final row", async () => {
  const workbook = readDelimitedWorkbook("a,b\n".repeat(150_000), ",");
  await render(
    <div style={{ width: 700, height: 450 }}>
      <WorkbookPreview workbook={workbook} />
    </div>,
  );
  const address = page.getByRole("textbox", { name: "Cell or range address" });
  await expect.element(page.getByRole("textbox", { name: "Formula bar" })).toHaveValue("a");
  await address.fill("B150000");
  await userEvent.keyboard("{Enter}");
  await expect.element(page.getByRole("textbox", { name: "Formula bar" })).toHaveValue("b");
  expect(document.querySelectorAll("canvas")).toHaveLength(1);
  expect(document.querySelectorAll("tr")).toHaveLength(0);
  expect(document.querySelectorAll("*").length).toBeLessThan(500);
  expect(document.querySelector('[data-testid="workbook-viewport"]')!.scrollTop).toBeGreaterThan(
    3_000_000,
  );
});

it("settles ready/error callbacks on actual binary fetch and cache-key reload", async () => {
  const bytes = await workbookFixture();
  const fetcher = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(bytes));
  const ready = vi.fn(),
    error = vi.fn();
  const view = await render(
    <div style={{ width: 700, height: 450 }}>
      <XlsxReader
        filePath="report.xlsm"
        cwd="/fixtures"
        onPreviewReady={ready}
        onPreviewError={error}
        cacheKey={1}
      />
    </div>,
  );
  await vi.waitFor(() => expect(ready).toHaveBeenCalledOnce());
  expect(error).not.toHaveBeenCalled();
  fetcher.mockResolvedValue(new Response("denied", { status: 403 }));
  await view.rerender(
    <div style={{ width: 700, height: 450 }}>
      <XlsxReader
        filePath="report.xlsm"
        cwd="/fixtures"
        onPreviewReady={ready}
        onPreviewError={error}
        cacheKey={2}
      />
    </div>,
  );
  await vi.waitFor(() => expect(error).toHaveBeenCalledOnce());
  await expect.element(page.getByRole("alert")).toHaveTextContent("403");
});
