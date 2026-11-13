// FILE: SheetEditor.browser.tsx
// Purpose: Browser coverage for the 电子表格 editor: the Claude-shaped layout (formula row, tool
//          card, sheet bar), tools that change cells through the engine, the formula field, sheet
//          tabs, the empty-sheet offer, a chart drawn over the cells, the cell menu, and cell
//          comments (a thread on a cell, comment mode, a reply sent to Moss).
// Layer: Web component tests
import "../../../index.css";

import { parseSheetWorkbook, type SheetWorkbook } from "@moss/shared/spaceItems/sheetWorkbook";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { page, userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode, useEffect } from "react";

import { useTheme } from "~/hooks/useTheme";
import { usePageCommentsStore } from "~/pageCommentsStore";

import { SheetEditor } from "./SheetEditor";

const workbook = parseSheetWorkbook({
  version: 1,
  sheets: [
    {
      id: "sheet1",
      name: "预算",
      frozenRows: 1,
      columnWidths: { "0": 120 },
      table: { c0: 0, c1: 2, headerR0: 0, headerR1: 0 },
      dropdowns: [
        {
          id: "ddn_1",
          ranges: [{ r0: 1, c0: 2, r1: 6, c1: 2 }],
          options: [
            { id: "o1", label: "完成", color: "#C7EACD" },
            { id: "o2", label: "进行中", color: "#C9DEF8" },
          ],
        },
      ],
      charts: [
        {
          id: "cht_1",
          name: "每月花费",
          caption: "",
          kind: "bar",
          source: { sheetId: "sheet1", range: { r0: 0, c0: 0, r1: 20, c1: 1 } },
          anchor: { r: 1, c: 4, dx: 0, dy: 0 },
          width: 360,
          height: 220,
        },
      ],
      cells: [
        { r: 0, c: 0, v: "项目", s: { fill: "#F3F3F3" } },
        { r: 0, c: 1, v: "金额", s: { fill: "#F3F3F3" } },
        { r: 0, c: 2, v: "状态", s: { fill: "#F3F3F3" } },
        { r: 1, c: 0, v: "房租" },
        { r: 1, c: 1, v: 1200, s: { format: "#,##0" } },
        { r: 1, c: 2, v: "完成" },
        { r: 2, c: 0, v: "伙食" },
        { r: 2, c: 1, v: 800, s: { format: "#,##0" } },
        { r: 2, c: 2, v: "进行中" },
        { r: 3, c: 0, v: "合计" },
        { r: 3, c: 1, v: 2000, f: "=SUM(B2:B3)", s: { format: "#,##0" } },
      ],
    },
    { id: "sheet2", name: "笔记", cells: [] },
  ],
});

function mount(
  onChange = vi.fn<(next: SheetWorkbook) => void>(),
  onReplace = vi.fn<(next: SheetWorkbook) => void>(),
) {
  // StrictMode as in the app: React runs updates twice there, and the engine must cope.
  return render(
    <StrictMode>
      <div style={{ width: 1100, height: 680, display: "flex", flexDirection: "column" }}>
        <SheetEditor workbook={workbook} title="预算表" onChange={onChange} onReplace={onReplace} />
      </div>
    </StrictMode>,
  );
}

describe("电子表格 editor", () => {
  it("lays out the formula row, the grid, the tool card and the sheet bar", async () => {
    await page.viewport(1200, 760);
    await mount();
    await expect.element(page.getByRole("textbox", { name: "编辑栏" })).toBeVisible();
    await expect.element(page.getByRole("toolbar", { name: "工具" })).toBeVisible();
    await expect
      .element(page.getByRole("tab", { name: "预算" }))
      .toHaveAttribute("aria-selected", "true");
    await expect.element(page.getByRole("tab", { name: "笔记" })).toBeVisible();
    const row = document.querySelector("[data-sheet-formula-row]") as HTMLElement;
    const bar = document.querySelector("[data-sheet-bar]") as HTMLElement;
    expect(row.getBoundingClientRect().height).toBe(36);
    expect(bar.getBoundingClientRect().height).toBe(36);
    // The tool card floats over the grid's foot, not in a row of its own.
    const card = document.querySelector("[data-sheet-tools]")!.getBoundingClientRect();
    const grid = document.querySelector("[data-sheet-grid]")!.getBoundingClientRect();
    expect(card.bottom).toBeLessThanOrEqual(grid.bottom - 8);
    expect(card.top).toBeGreaterThan(grid.top);
    // The engine's own toolbar, formula bar and tabs are not shown.
    expect(document.querySelector(".fortune-toolbar")).toBeNull();
    expect(document.querySelector(".fortune-sheettab-container")).toBeNull();
    await expect.element(page.getByRole("figure", { name: "每月花费" })).toBeVisible();
  });

  it("formats the selection and writes through the formula field", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    await page.getByRole("button", { name: "加粗", exact: true }).click();
    await vi.waitFor(() => {
      const last = onChange.mock.lastCall?.[0];
      expect(last?.sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0)?.s?.bold).toBe(
        true,
      );
    });
    const field = page.getByRole("textbox", { name: "编辑栏" });
    await field.click();
    await field.fill("=B2*2");
    await field
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() => {
      const last = onChange.mock.lastCall?.[0];
      expect(last?.sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0)?.f).toBe("=B2*2");
    });
  });

  it("adds a sheet and offers Moss or an import on a blank sheet", async () => {
    await page.viewport(1200, 760);
    const onReplace = vi.fn<(next: SheetWorkbook) => void>();
    await mount(undefined, onReplace);
    await page.getByRole("tab", { name: "笔记" }).click();
    await expect.element(page.getByText("导入一个文件开始。")).toBeVisible();
    await page.getByRole("button", { name: "添加工作表" }).click();
    await page.getByRole("menuitem", { name: "空白工作表" }).click();
    expect(onReplace.mock.lastCall?.[0].sheets.map((sheet) => sheet.name)).toEqual([
      "预算",
      "笔记",
      "工作表3",
    ]);
  });

  it("draws the same sheet light and dark (screenshots for review)", async () => {
    await page.viewport(1200, 760);
    function Themed(props: { mode: "light" | "dark" }) {
      const { setTheme } = useTheme();
      useEffect(() => setTheme(props.mode), [props.mode, setTheme]);
      return (
        <div
          style={{ width: 1100, height: 680, display: "flex", flexDirection: "column" }}
          className="bg-background text-foreground"
        >
          <SheetEditor
            workbook={workbook}
            title="预算表"
            onChange={() => {}}
            onReplace={() => {}}
            moss={{ label: "Moss", busy: false, onAsk: () => {} }}
          />
        </div>
      );
    }
    for (const mode of ["light", "dark"] as const) {
      const view = await render(<Themed mode={mode} />);
      await expect.element(page.getByRole("figure", { name: "每月花费" })).toBeVisible();
      await vi.waitFor(() =>
        expect(document.querySelector(`[data-sheet-theme="${mode}"]`)).not.toBeNull(),
      );
      await new Promise((resolve) => setTimeout(resolve, 400));
      await page.screenshot({ path: `__screenshots__/sheet-editor/${mode}.png` });
      await view.unmount();
    }
  });

  it("opens the Moss cell menu on a right click", async () => {
    await page.viewport(1200, 760);
    await mount();
    const grid = document.querySelector("[data-sheet-grid] canvas") as HTMLElement;
    const box = grid.getBoundingClientRect();
    grid.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 200,
        clientY: box.top + 60,
      }),
    );
    await expect.element(page.getByRole("menuitem", { name: "在上方插入行" })).toBeVisible();
    await expect.element(page.getByRole("menuitem", { name: "清除内容" })).toBeVisible();
  });

  it("keeps a comment on a cell and sends a reply to Moss", async () => {
    await page.viewport(1200, 760);
    usePageCommentsStore.setState({ commentsByPage: {} });
    const ask = vi.fn(() => Promise.resolve("thread-sheet-comment"));
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    await render(
      <QueryClientProvider client={client}>
        <div style={{ width: 1100, height: 680, display: "flex", flexDirection: "column" }}>
          <SheetEditor
            workbook={workbook}
            title="预算表"
            onChange={() => {}}
            onReplace={() => {}}
            comments={{ pageKey: "sheet:test", pageTitle: "预算表", sourceThreadId: "", ask }}
          />
        </div>
      </QueryClientProvider>,
    );
    const grid = document.querySelector("[data-sheet-grid] canvas") as HTMLElement;
    const box = grid.getBoundingClientRect();
    grid.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 80,
        clientY: box.top + 40,
      }),
    );
    await page.getByRole("menuitem", { name: "评论", exact: true }).click();
    const field = page.getByRole("textbox", { name: "Comment" });
    await field.fill("这一项要拆开吗？");
    await page.getByRole("button", { name: "Post comment" }).click();
    await vi.waitFor(() =>
      expect(usePageCommentsStore.getState().commentsByPage["sheet:test"]?.[0]).toMatchObject({
        body: "这一项要拆开吗？",
        anchor: { selector: "sheet1/0:0", label: "预算!A1" },
      }),
    );
    await expect.element(page.getByRole("button", { name: "评论，1 条未解决" })).toBeVisible();

    // Comment mode: the hint and a pin on the commented cell; the pin opens the thread.
    await page.getByRole("button", { name: "评论，1 条未解决" }).click();
    await expect.element(page.getByText("点按一个单元格来评论。按 Esc 退出。")).toBeVisible();
    await page.getByRole("button", { name: /comment from/i }).click();
    const thread = page.getByRole("group", { name: "Comment thread" });
    await expect.element(thread.getByText("这一项要拆开吗？")).toBeVisible();
    await page.screenshot({ path: "__screenshots__/sheet-editor/comments.png" });

    const reply = page.getByRole("textbox", { name: "Reply" });
    await reply.fill("@Moss 帮我看看合计对不对");
    await reply
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    await vi.waitFor(() =>
      expect(ask).toHaveBeenCalledWith("@Moss 帮我看看合计对不对", {
        sheetId: "sheet1",
        r: 0,
        c: 0,
      }),
    );
  });

  it("adds a conditional-format rule from the 条件格式 pane", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    await page.getByRole("button", { name: "更多", exact: true }).click();
    await page.getByRole("menuitem", { name: "条件格式…" }).click();
    const pane = page.getByTestId("sheet-rules-pane");
    await expect
      .element(pane.getByText("这张工作表还没有条件格式。", { exact: false }))
      .toBeVisible();
    await pane.getByRole("button", { name: "新建规则" }).click();
    await pane.getByRole("textbox", { name: "应用于" }).fill("B2:B4");
    await pane.getByRole("textbox", { name: "值", exact: true }).fill("1000");
    await pane.getByRole("button", { name: "添加规则" }).click();
    await vi.waitFor(() => {
      const rules = onChange.mock.lastCall?.[0].sheets[0]!.rules;
      expect(rules?.[0]?.ranges).toEqual([{ r0: 1, c0: 1, r1: 3, c1: 1 }]);
    });
    await expect.element(pane.getByText("单元格大于 1000 · B2:B4")).toBeVisible();
    await page.screenshot({ path: "__screenshots__/sheet-editor/rules.png" });
  });

  it("works out Moss's added functions in the engine (TEXTJOIN, XLOOKUP, IFERROR)", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    const field = page.getByRole("textbox", { name: "编辑栏" });
    const write = async (formula: string) => {
      await field.click();
      await field.fill(formula);
      await field
        .element()
        .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    };
    const a1 = () =>
      onChange.mock.lastCall?.[0].sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0);
    await write('=TEXTJOIN("-",TRUE,A2:A3)');
    await vi.waitFor(() => expect(a1()?.v).toBe("房租-伙食"));
    await write('=XLOOKUP("伙食",A2:A3,B2:B3)');
    await vi.waitFor(() => expect(a1()?.v).toBe(800));
    await write('=IFERROR(XLOOKUP("水电",A2:A3,B2:B3),"没有")');
    await vi.waitFor(() => expect(a1()?.v).toBe("没有"));
  });

  it("shows a chart's values for the category under the pointer", async () => {
    await page.viewport(1200, 760);
    await mount();
    await expect.element(page.getByRole("figure", { name: "每月花费" })).toBeVisible();
    const hit = document.querySelector('[data-chart-hit="1"]') as Element;
    await userEvent.hover(hit);
    const tip = page.getByRole("tooltip");
    await expect.element(tip).toBeVisible();
    await expect.element(tip.getByText("伙食")).toBeVisible();
    await expect.element(tip.getByText("800")).toBeVisible();
  });

  it("groups the selected rows and folds the group", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    const more = page.getByRole("button", { name: "更多", exact: true });
    await more.click();
    await page.getByRole("menuitem", { name: "组合" }).click();
    await page.getByRole("menuitem", { name: "组合所选行" }).click();
    await vi.waitFor(() =>
      expect(onChange.mock.lastCall?.[0].sheets[0]!.rowGroups).toEqual([
        { start: 0, end: 0, collapsed: false },
      ]),
    );
    await more.click();
    await page.getByRole("menuitem", { name: "组合" }).click();
    await page.getByRole("menuitem", { name: "收起这组行" }).click();
    await vi.waitFor(() =>
      expect(onChange.mock.lastCall?.[0].sheets[0]!.rowGroups?.[0]?.collapsed).toBe(true),
    );
    // The gutter mark unfolds it again.
    await page.getByRole("button", { name: "展开第 1–1 行" }).click();
    await vi.waitFor(() =>
      expect(onChange.mock.lastCall?.[0].sheets[0]!.rowGroups?.[0]?.collapsed).toBe(false),
    );
  });

  it("turns text that reads as a number into one from the cell menu", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    const field = page.getByRole("textbox", { name: "编辑栏" });
    await field.click();
    await field.fill("'1,250");
    await field
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const a1 = () =>
      onChange.mock.lastCall?.[0].sheets[0]!.cells.find((cell) => cell.r === 0 && cell.c === 0);
    await vi.waitFor(() => expect(a1()?.v).toBe("1,250"));
    const grid = document.querySelector("[data-sheet-grid] canvas") as HTMLElement;
    const box = grid.getBoundingClientRect();
    grid.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 80,
        clientY: box.top + 40,
      }),
    );
    await page.getByRole("menuitem", { name: "把文字转换成数字" }).click();
    await vi.waitFor(() => expect(a1()?.v).toBe(1250));
  });

  it("tells a screen reader the selected cell and what a tool did", async () => {
    await page.viewport(1200, 760);
    await mount();
    const announcer = () => document.querySelector("[data-sheet-announcer]")?.textContent ?? "";
    await vi.waitFor(() => expect(announcer()).toBe("A1，项目"));
    await page.getByRole("button", { name: "加粗", exact: true }).click();
    await vi.waitFor(() => expect(announcer()).toBe("已切换加粗"));
    await expect.element(page.getByRole("region", { name: "电子表格：预算表" })).toBeVisible();
  });

  it("spills a block answer into the cells below", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await mount(onChange);
    await page.getByRole("tab", { name: "笔记" }).click();
    const field = page.getByRole("textbox", { name: "编辑栏" });
    await field.click();
    await field.fill("=SEQUENCE(3)");
    await field
      .element()
      .dispatchEvent(new KeyboardEvent("keydown", { key: "Enter", bubbles: true }));
    const at = (r: number) =>
      onChange.mock.lastCall?.[0].sheets
        .find((sheet) => sheet.name === "笔记")
        ?.cells.find((cell) => cell.r === r && cell.c === 0)?.v;
    await vi.waitFor(() => {
      expect(at(0)).toBe(1);
      expect(at(1)).toBe(2);
      expect(at(2)).toBe(3);
    });
  });

  it("lets a view-only reader filter a column, without saving it", async () => {
    await page.viewport(1200, 760);
    const onChange = vi.fn<(next: SheetWorkbook) => void>();
    await render(
      <div style={{ width: 1100, height: 680, display: "flex", flexDirection: "column" }}>
        <SheetEditor
          workbook={workbook}
          title="预算表"
          readOnly
          viewerKey="reader-test"
          onChange={onChange}
          onReplace={() => {}}
        />
      </div>,
    );
    const grid = document.querySelector("[data-sheet-grid] canvas") as HTMLElement;
    const box = grid.getBoundingClientRect();
    grid.dispatchEvent(
      new MouseEvent("contextmenu", {
        bubbles: true,
        cancelable: true,
        clientX: box.left + 80,
        clientY: box.top + 40,
      }),
    );
    await page.getByRole("menuitem", { name: "筛选这一列…" }).click();
    await page.getByRole("checkbox", { name: "房租" }).click();
    await page.getByTestId("sheet-reader-filter-apply").click();
    await expect.element(page.getByText("只有你看到。", { exact: false })).toBeVisible();
    expect(onChange).not.toHaveBeenCalled();
    window.localStorage.removeItem("moss.sheet.readerFilters:reader-test");
  });
});
