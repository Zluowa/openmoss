// FILE: SpaceRename.browser.tsx
// Purpose: 重命名 in 资料空间 works where a person reaches for it: the card's ⋯ menu and a
//          document's title menu both turn the name into a field in place; Enter keeps the new
//          name and the card or title shows it, Esc keeps the old one.
// Layer: Web component tests

import "../../index.css";

import { PageId, type NativeApi, type Page } from "@moss/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { PageTextIcon, TableIcon } from "~/lib/icons";
import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";

import { PageTitleMenu } from "../pages/chrome/PageTitleMenu";
import { SpaceTitleMenu } from "../spaceTypes/shared/SpaceEditorChrome";
import { SpaceHome } from "./SpaceHome";
import { buildSpaceItems, setSyncedSpaceHomeKind, type SpaceItem } from "./spaceItems";

function makePage(id: string, title: string): Page {
  return {
    id: PageId.makeUnsafe(id),
    scopeSpaceId: null,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe(id),
    title,
    kind: "sheet",
    sourceThreadId: null,
    pinned: false,
    trashedAt: null,
    assetIds: [],
    automationIds: [],
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T12:00:00.000Z",
    revision: 1,
  };
}

function renderInHarness(node: React.ReactNode) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  return render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <BrowserThemeFixture>{node}</BrowserThemeFixture>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

describe("资料空间 重命名", () => {
  let previousApi: NativeApi | undefined;

  beforeEach(async () => {
    await page.viewport(1280, 900);
    window.localStorage.removeItem("moss:space:view");
    setSyncedSpaceHomeKind("any");
    installBrowserFixtureTheme("light");
    previousApi = window.nativeApi;
    window.nativeApi = createDataSpaceFixture().api;
  });

  afterEach(async () => {
    await cleanup();
    (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
    setSyncedSpaceHomeKind("any");
  });

  it("renames an item from its card menu, in place", async () => {
    const onRename = vi.fn<(item: SpaceItem, title: string) => void>();
    function Harness() {
      const [title, setTitle] = useState("未命名电子表格");
      const items = buildSpaceItems({ pages: [makePage("sheet-1", title)], apps: [], outputs: [] });
      return (
        <SpaceHome
          section={{ type: "all" }}
          title="全部"
          description=""
          items={items}
          loading={false}
          error={null}
          onRetry={() => {}}
          onCreate={() => {}}
          onOpen={() => {}}
          onRename={(item, next) => {
            onRename(item, next);
            setTitle(next);
          }}
          placeOf={() => "个人"}
          emptyCreate="page"
        />
      );
    }
    await renderInHarness(<Harness />);

    const card = () => document.querySelector<HTMLElement>("[data-space-item='page:sheet-1']")!;
    await vi.waitFor(() => expect(card()).not.toBeNull());
    await userEvent.hover(card());
    await userEvent.click(page.getByRole("button", { name: "未命名电子表格 的操作" }));
    await userEvent.click(page.getByRole("menuitem", { name: "重命名" }));

    const field = page.getByRole("textbox", { name: "名称" });
    await expect.element(field).toHaveFocus();
    await expect.element(field).toHaveValue("未命名电子表格");
    await userEvent.keyboard("年度预算{Enter}");

    expect(onRename).toHaveBeenCalledTimes(1);
    expect(onRename.mock.calls[0]![1]).toBe("年度预算");
    await expect.element(page.getByRole("textbox", { name: "名称" })).not.toBeInTheDocument();
    await vi.waitFor(() => expect(card().textContent).toContain("年度预算"));
    expect(card().textContent).not.toContain("未命名电子表格");

    // Esc leaves the name as it was.
    await userEvent.hover(card());
    await userEvent.click(page.getByRole("button", { name: "年度预算 的操作" }));
    await userEvent.click(page.getByRole("menuitem", { name: "重命名" }));
    await expect.element(page.getByRole("textbox", { name: "名称" })).toHaveFocus();
    await userEvent.keyboard("不要这个{Escape}");
    expect(onRename).toHaveBeenCalledTimes(1);
    expect(card().textContent).toContain("年度预算");
  });

  it("renames a document from its title menu, in place", async () => {
    const onRename = vi.fn<(title: string) => void>();
    const noop = () => {};
    function Harness() {
      const [title, setTitle] = useState("季度计划");
      return (
        <PageTitleMenu
          title={title}
          icon={PageTextIcon}
          pinned={false}
          trashed={false}
          sourceEditing={false}
          onNavigation={noop}
          onShare={noop}
          onTogglePin={noop}
          onRename={(next) => {
            onRename(next);
            setTitle(next);
          }}
          onDuplicate={noop}
          onDownload={noop}
          onOpenInNewWindow={noop}
          onActivity={noop}
          onFiles={noop}
          onContinueInChat={noop}
          onBackupDrafts={noop}
          onTrash={noop}
        />
      );
    }
    await renderInHarness(<Harness />);

    await userEvent.click(page.getByRole("button", { name: "季度计划 页面菜单" }));
    await userEvent.click(page.getByRole("menuitem", { name: "重命名" }));
    const field = page.getByRole("textbox", { name: "文档名称" });
    await expect.element(field).toHaveFocus();
    await userEvent.keyboard("年度计划{Enter}");

    expect(onRename).toHaveBeenCalledWith("年度计划");
    await expect.element(page.getByRole("button", { name: "年度计划 页面菜单" })).toBeVisible();
    await expect
      .element(page.getByRole("button", { name: "年度计划 页面菜单" }))
      .toHaveTextContent("年度计划");
  });
  it("renames a sheet, slides or design from the same title menu", async () => {
    const onRename = vi.fn<(title: string) => void>();
    const onSaveAsTemplate = vi.fn();
    function Harness() {
      const [title, setTitle] = useState("未命名电子表格");
      return (
        <SpaceTitleMenu
          title={title}
          untitled="未命名"
          icon={TableIcon}
          readOnly={false}
          onRename={(next) => {
            onRename(next);
            setTitle(next);
          }}
          onSaveAsTemplate={onSaveAsTemplate}
        />
      );
    }
    await renderInHarness(<Harness />);
    await userEvent.click(page.getByRole("button", { name: "未命名电子表格 菜单" }));
    await expect.element(page.getByRole("menuitem", { name: "存为模板" })).toBeVisible();
    await userEvent.click(page.getByRole("menuitem", { name: "重命名" }));
    await expect.element(page.getByRole("textbox", { name: "名称" })).toHaveFocus();
    await userEvent.keyboard("年度预算{Enter}");
    expect(onRename).toHaveBeenCalledWith("年度预算");
    await expect
      .element(page.getByRole("button", { name: "年度预算 菜单" }))
      .toHaveTextContent("年度预算");
  });
});
