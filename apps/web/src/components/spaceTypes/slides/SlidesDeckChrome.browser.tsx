// FILE: SlidesDeckChrome.browser.tsx
// Purpose: Browser checks for host-side 幻灯片 parity & controls: SlidesPresenter (docked notes
//          split by default, next title, timer pause/reset, B/W blank screen, optional popout),
//          NewDeckDialog (ui primitives, page picker & prompt), and DeckViewer (ui menu/input).
// Layer: Web component tests

import "../../../index.css";

import {
  createSlidesDeck,
  withBodyText,
  type SlidesDeck,
} from "@moss/shared/spaceItems/slidesDeck";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture } from "~/test/browserThemeFixture";

import { TooltipProvider } from "../../ui/tooltip";
import { DeckViewer } from "./DeckViewer";
import { NewDeckDialog } from "./NewDeckDialog";
import { SlidesPresenter } from "./SlidesPresenter";

function makeTwoSlideDeck(): SlidesDeck {
  const base = createSlidesDeck("第一页标题");
  const first = { ...base.slides[0]!, id: "s-1", notes: "第一页演讲备注" };
  const secondTitle = first.elements[0]!;
  const second = {
    ...first,
    id: "s-2",
    notes: "第二页演讲备注",
    elements: [
      secondTitle.type === "text"
        ? { ...secondTitle, id: "e-2-title", body: withBodyText(secondTitle.body, "下季度重点") }
        : secondTitle,
    ],
  };
  return { ...base, slides: [first, second] };
}

function Harness(props: { children: React.ReactNode }) {
  return (
    <MossLocaleScope locale="zh-CN">
      <TooltipProvider>
        <BrowserThemeFixture>{props.children}</BrowserThemeFixture>
      </TooltipProvider>
    </MossLocaleScope>
  );
}

describe("slides host parity & controls", () => {
  beforeEach(async () => {
    await page.viewport(1280, 800);
  });

  afterEach(async () => {
    vi.restoreAllMocks();
    await cleanup();
  });

  it("docks speaker notes below the slide by default with timer, next title, B/W blank and optional popout", async () => {
    const openSpy = vi.spyOn(window, "open").mockImplementation(() => null);
    const onClose = vi.fn();
    await render(
      <Harness>
        <SlidesPresenter
          deck={makeTwoSlideDeck()}
          startIndex={0}
          surface="presenter"
          onClose={onClose}
        />
      </Harness>,
    );

    expect(openSpy).not.toHaveBeenCalled();
    await vi.waitFor(() => {
      const host = document.querySelector("[data-slides-presenter]");
      expect(host?.getAttribute("data-slides-presenter")).toBe("notes-below");
    });

    await expect.element(page.getByText("演讲备注 · 第 1 / 2 张")).toBeVisible();
    await expect.element(page.getByText("下一张：下季度重点")).toBeVisible();
    await expect.element(page.getByText("第一页演讲备注")).toBeVisible();
    await expect.element(page.getByRole("separator", { name: "调整备注区高度" })).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "暂停计时", exact: true }));
    await expect.element(page.getByRole("button", { name: "继续计时", exact: true })).toBeVisible();

    await userEvent.keyboard("{ArrowRight}");
    await expect.element(page.getByText("演讲备注 · 第 2 / 2 张")).toBeVisible();
    await expect.element(page.getByText("第二页演讲备注")).toBeVisible();
    await expect.element(page.getByText("下一张：已是最后一张")).toBeVisible();

    await userEvent.keyboard("b");
    await vi.waitFor(() => {
      expect(
        document.querySelector("[data-present-blank]")?.getAttribute("data-present-blank"),
      ).toBe("black");
    });
    await userEvent.keyboard("w");
    await vi.waitFor(() => {
      expect(
        document.querySelector("[data-present-blank]")?.getAttribute("data-present-blank"),
      ).toBe("white");
    });
    await userEvent.keyboard("w");
    await vi.waitFor(() => {
      expect(document.querySelector("[data-present-blank]")).toBeNull();
    });

    await userEvent.click(page.getByRole("button", { name: "独立窗口", exact: true }));
    expect(openSpy).toHaveBeenCalledTimes(1);
  });

  it("supports picking a page or submitting a prompt with ui controls in NewDeckDialog", async () => {
    const onFromPage = vi.fn();
    const onGenerate = vi.fn();
    await render(
      <Harness>
        <NewDeckDialog
          open
          onOpenChange={vi.fn()}
          busy={false}
          pages={[
            { id: "p-1", title: "Q4 复盘" },
            { id: "p-2", title: "产品周报" },
          ]}
          onBlank={vi.fn()}
          onTemplate={vi.fn()}
          onImport={vi.fn()}
          onGenerate={onGenerate}
          onFromPage={onFromPage}
        />
      </Harness>,
    );

    const prompt = page.getByLabelText("或者描述你要的演示文稿，让 Moss 生成");
    await userEvent.fill(prompt, "做一份 8 页复盘");
    await userEvent.click(page.getByRole("button", { name: "让 Moss 生成", exact: true }));
    expect(onGenerate).toHaveBeenCalledWith("做一份 8 页复盘");

    await userEvent.click(page.getByRole("button", { name: /用资料空间内容生成/ }));
    await userEvent.fill(page.getByRole("textbox", { name: "搜索页面" }), "周报");
    await userEvent.click(page.getByRole("button", { name: "产品周报", exact: true }));
    expect(onFromPage).toHaveBeenCalledWith({ id: "p-2", title: "产品周报" });
  });

  it("switches slides, exports with notes via ui Menu, and submits requests in DeckViewer", async () => {
    const onExport = vi.fn();
    const onRequestChange = vi.fn();
    await render(
      <Harness>
        <div style={{ width: 1100, height: 700, display: "flex", flexDirection: "column" }}>
          <DeckViewer
            deck={makeTwoSlideDeck()}
            title="季度复盘"
            readOnly={false}
            notice={null}
            drafts={[]}
            highlight={new Set()}
            running={[]}
            aiAvailable
            agentLabel="Moss"
            onRequestChange={onRequestChange}
            onAccept={vi.fn()}
            onDiscard={vi.fn()}
            onPresent={vi.fn()}
            onExport={onExport}
            onShare={vi.fn()}
            onViewChange={vi.fn()}
            onRetryEditor={vi.fn()}
          />
        </div>
      </Harness>,
    );

    const navButtons = document.querySelectorAll("nav[aria-label='幻灯片'] button");
    expect(navButtons.length).toBe(2);
    await userEvent.click(navButtons[1]!);
    await expect.element(page.getByText("第二页演讲备注")).toBeVisible();

    await userEvent.click(page.getByRole("button", { name: "下载", exact: true }));
    await userEvent.click(page.getByRole("menuitemcheckbox", { name: "包含备注" }));
    await userEvent.click(page.getByRole("menuitem", { name: "PDF", exact: true }));
    expect(onExport).toHaveBeenCalledWith("pdf", { includeNotes: true });

    await userEvent.fill(page.getByRole("textbox", { name: "描述修改或提问" }), "精简文字");
    await userEvent.click(page.getByRole("button", { name: "提出修改请求", exact: true }));
    expect(onRequestChange).toHaveBeenCalledWith("精简文字", {
      slideIds: ["s-2"],
      elementIds: [],
    });
  });
});
