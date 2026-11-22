// FILE: SheetDockIntegration.browser.tsx
// Purpose: Verifies Sheet dock ask routing, selection sync, shimmer grid skeleton, live blue
//          Moss cell-range indicator, and standalone fallback without dock.
// Layer: Web component browser tests

import "../../../index.css";

import { ThreadId } from "@moss/contracts";
import { parseSheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { afterEach, describe, expect, it, vi } from "vitest";
import { page } from "vitest/browser";
import { render } from "vitest-browser-react";

import type { SpaceCanvasDockController } from "~/components/space/spaceCanvasDockContract";
import { SheetEditor } from "./SheetEditor";

const workbook = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "sheet1",
      name: "预算",
      cells: [
        { r: 0, c: 0, v: "项目" },
        { r: 0, c: 1, v: "金额" },
        { r: 1, c: 0, v: "房租" },
        { r: 1, c: 1, v: 1200 },
      ],
    },
  ],
});

function createDock(busy = false): SpaceCanvasDockController {
  return {
    state: "collapsed",
    setState: vi.fn(),
    activeThreadId: ThreadId.makeUnsafe("sheet-thread-1"),
    busy,
    elapsedSeconds: 0,
    statusLabel: null,
    ask: vi.fn(async () => undefined),
    openSideChatTab: vi.fn(),
    selection: null,
    setSelection: vi.fn(),
  };
}

describe("Sheet dock integration", () => {
  afterEach(() => {
    vi.clearAllMocks();
  });

  it("syncs range context to dock, routes 问 Moss to dock.ask, and shows shimmer & Moss presence", async () => {
    await page.viewport(1200, 720);
    const dock = createDock(false);
    const onHostActionsChange = vi.fn();
    const mounted = await render(
      <div style={{ width: 1100, height: 640, display: "flex", flexDirection: "column" }}>
        <SheetEditor
          workbook={workbook}
          title="预算表"
          viewerKey="sheet-test-1"
          dock={dock}
          onHostActionsChange={onHostActionsChange}
          onChange={() => {}}
          onReplace={() => {}}
        />
      </div>,
    );
    try {
      await vi.waitFor(() =>
        expect(dock.setSelection).toHaveBeenCalledWith(
          expect.objectContaining({
            kind: "sheet",
            sheetName: "预算",
            range: "A1",
          }),
        ),
      );
      expect(onHostActionsChange).toHaveBeenCalled();
      // File menu lifted to host chrome, leaving clean 36px formula row.
      expect(
        document.querySelector('[data-sheet-view-tools] [data-testid="sheet-file-menu"]'),
      ).toBeNull();
      const askTrigger = page.getByTestId("sheet-ask-moss-trigger");
      await expect.element(askTrigger).toBeVisible();
      await askTrigger.click();
      expect(dock.ask).toHaveBeenCalledWith(
        expect.objectContaining({
          origin: "bottom-pill",
          prefillOnly: true,
          keepItemOpen: true,
          selection: expect.objectContaining({
            kind: "sheet",
            sheetName: "预算",
            range: "A1",
          }),
        }),
      );

      await mounted.rerender(
        <div style={{ width: 1100, height: 640, display: "flex", flexDirection: "column" }}>
          <SheetEditor
            workbook={workbook}
            title="预算表"
            viewerKey="sheet-test-1"
            dock={createDock(true)}
            loading
            onChange={() => {}}
            onReplace={() => {}}
          />
        </div>,
      );
      await expect
        .element(page.getByTestId("sheet-moss-presence"))
        .toHaveTextContent("Moss · 正在思考...");
      await expect.element(page.getByTestId("sheet-shimmer")).toBeVisible();
    } finally {
      await mounted.unmount();
    }
  });

  it("falls back to standalone inline ask input when dock is absent", async () => {
    await page.viewport(1200, 720);
    const onAsk = vi.fn();
    const mounted = await render(
      <div style={{ width: 1100, height: 640, display: "flex", flexDirection: "column" }}>
        <SheetEditor
          workbook={workbook}
          title="预算表"
          moss={{ label: "Moss", busy: false, onAsk }}
          onChange={() => {}}
          onReplace={() => {}}
        />
      </div>,
    );
    try {
      const input = page.getByTestId("sheet-ask-moss");
      await expect.element(input).toBeVisible();
      await input.fill("增加合计行");
      await input
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
      const form = input.element().closest("form")!;
      form.dispatchEvent(new Event("submit", { bubbles: true, cancelable: true }));
      expect(onAsk).toHaveBeenCalledWith(expect.objectContaining({ text: "增加合计行" }));
    } finally {
      await mounted.unmount();
    }
  });
});
