// FILE: SpaceGallery.browser.tsx
// Purpose: Browser UI verification for 资料空间 V2 gallery: Claude 1:1 Home layout & 6 pastel
//          creation tiles, dismissible 快速开始 template strip with keepItemOpen launch metadata,
//          3-col miniature previews (page/sheet/board/dashboard), 8-kind SpaceSidebar sync, and
//          clean SpaceCreateMenu without dead-end ComingSoon traps.

import "../../index.css";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import {
  PageId,
  ThreadId,
  type NativeApi,
  type Page,
  type PageTypedItem,
  type SpaceTemplate,
} from "@moss/contracts";
import { BUILT_IN_TEMPLATES } from "@moss/shared/spaceItems/templates";
import { useState } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { page, userEvent } from "vitest/browser";
import { cleanup, render } from "vitest-browser-react";

import { MossLocaleScope } from "~/localization";
import { BrowserThemeFixture, installBrowserFixtureTheme } from "~/test/browserThemeFixture";
import { createDataSpaceFixture } from "~/test/mossDataSpaceFixture";

import {
  SPACE_TEMPLATE_LAUNCH_EVENT,
  TemplatePickerDialog,
  type SpaceTemplateLaunchMetadata,
} from "../spaceTypes/templates/TemplatePickerDialog";
import { Button } from "../ui/button";
import { SpaceHome } from "./SpaceHome";
import { SpaceItemCard } from "./SpaceItemCard";
import { SpaceSidebar } from "./SpaceSidebar";
import { GalleryProvider } from "./gallery/GalleryContext";
import {
  buildSpaceItems,
  recentItems,
  setSyncedSpaceHomeKind,
  type SpaceSection,
} from "./spaceItems";

const SHEET_WORKBOOK_DATA = BUILT_IN_TEMPLATES.find((entry) => entry.kind === "sheet")?.data ?? "";
const DASHBOARD_DATA =
  BUILT_IN_TEMPLATES.find((entry) => entry.id === "builtin:sales-dashboard")?.data ?? "";

function makePage(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id: PageId.makeUnsafe(id),
    scopeSpaceId: null,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe(id),
    title: id,
    kind: "page",
    sourceThreadId: null,
    pinned: false,
    trashedAt: null,
    assetIds: [],
    automationIds: [],
    createdAt: "2026-11-22T08:00:00.000Z",
    updatedAt: "2026-11-22T12:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

function renderInHarness(node: React.ReactNode) {
  const client = new QueryClient({
    defaultOptions: { queries: { retry: false } },
  });
  return render(
    <QueryClientProvider client={client}>
      <MossLocaleScope locale="zh-CN">
        <BrowserThemeFixture>{node}</BrowserThemeFixture>
      </MossLocaleScope>
    </QueryClientProvider>,
  );
}

describe("SpaceGallery V2", () => {
  let previousApi: NativeApi | undefined;

  beforeEach(async () => {
    await page.viewport(1280, 900);
    window.localStorage.removeItem("moss:space:view");
    window.localStorage.removeItem("moss:space:hide-create-tiles");
    window.localStorage.removeItem("moss:space:hide-quick-start");
    setSyncedSpaceHomeKind("any");
    installBrowserFixtureTheme("light");
    previousApi = window.nativeApi;
  });

  afterEach(async () => {
    await cleanup();
    (window as { nativeApi?: NativeApi | undefined }).nativeApi = previousApi;
    window.localStorage.removeItem("moss:space:view");
    window.localStorage.removeItem("moss:space:hide-create-tiles");
    window.localStorage.removeItem("moss:space:hide-quick-start");
    setSyncedSpaceHomeKind("any");
    window.document.documentElement.classList.remove("dark");
  });

  it("renders Claude 1:1 Home layout, 6 136x96 pastel tiles, and 2:1 card previews for page/sheet/board/dashboard", async () => {
    const fixture = createDataSpaceFixture();
    const docPage = makePage("doc-1", { title: "Q4 规划文档", kind: "page" });
    const sheetPage = makePage("sheet-1", { title: "年度预算表", kind: "sheet" });
    const boardPage = makePage("board-1", { title: "架构白板", kind: "board" });
    const dashPage = makePage("dash-1", { title: "营收看板", kind: "app" });

    const originalPagesRead = fixture.api.pages.read;
    Object.assign(fixture.api.pages, {
      read: vi.fn(async (input: { scopeSpaceId: string | null; pageId: PageId }) => {
        if (input.pageId === docPage.id) {
          return {
            page: docPage,
            content: "# 核心目标\n完成全部模块上线并保持零阻塞",
            versions: [],
          };
        }
        return originalPagesRead(input as Parameters<typeof originalPagesRead>[0]);
      }),
    });
    Object.assign(fixture.api, {
      pageTypes: {
        read: vi.fn(async (input: { pageId: PageId }) => {
          if (input.pageId === sheetPage.id) {
            return { page: sheetPage, data: SHEET_WORKBOOK_DATA };
          }
          if (input.pageId === dashPage.id) {
            return { page: dashPage, data: DASHBOARD_DATA };
          }
          return { page: boardPage, data: null };
        }),
        create: vi.fn(),
        save: vi.fn(),
        templates: {
          list: vi.fn(async () => ({ templates: [] })),
          delete: vi.fn(),
        },
      },
    });
    window.nativeApi = fixture.api;

    const items = buildSpaceItems({
      pages: [docPage, sheetPage, boardPage, dashPage],
      apps: [],
      outputs: [],
    });
    const onCreate = vi.fn();

    await renderInHarness(
      <SpaceHome
        section={{ type: "all" }}
        title="资料空间"
        description=""
        items={items}
        loading={false}
        error={null}
        onRetry={() => {}}
        onCreate={onCreate}
        onOpen={() => {}}
        placeOf={() => "个人"}
        emptyCreate="page"
      />,
    );

    // A young 资料空间 (fewer than six items) still offers 新建 and 快速开始.
    await expect.element(page.getByRole("region", { name: "新建", exact: true })).toBeVisible();

    const tiles = [...document.querySelectorAll<HTMLElement>("[data-space-create-tile]")];
    expect(tiles.map((el) => el.getAttribute("data-space-create-tile"))).toEqual([
      "page",
      "slides",
      "sheet",
      "design",
      "dashboard",
      "board",
    ]);
    const rect = tiles[0]!.getBoundingClientRect();
    expect(Math.round(rect.width)).toBe(136);
    expect(Math.round(rect.height)).toBe(96);

    // Tiles are just the kind: no corner badges (the 创建 menu notes what is Beta).
    expect(tiles[2]!.textContent).toBe("电子表格");
    expect(tiles[5]!.textContent).toBe("画布");
    await userEvent.click(tiles[5]!);
    expect(onCreate).toHaveBeenCalledWith("board");

    await vi.waitFor(() => {
      expect(document.querySelector('[data-space-card-preview="page"]')).not.toBeNull();
      expect(document.querySelector('[data-space-card-preview="sheet"]')).not.toBeNull();
      expect(document.querySelector('[data-space-card-preview="board"]')).not.toBeNull();
      expect(document.querySelector('[data-space-card-preview="dashboard"]')).not.toBeNull();
    });
    expect(document.querySelector('[data-space-card-preview="page"]')?.textContent).toContain(
      "核心目标",
    );
    expect(document.querySelector('[data-space-card-preview="sheet"] table')).not.toBeNull();
  });

  it("offers 新建 & 快速开始 while young, hides them once the space fills, and emits keepItemOpen on starter launch", async () => {
    const fixture = createDataSpaceFixture();
    const createdPage = makePage("meeting-1", { title: "会议纪要", kind: "page" });
    const createdItem: PageTypedItem = {
      page: createdPage,
      kind: "page",
      data: null,
      dataRevision: 1,
    };
    const createSpy = vi.fn(async () => createdItem);

    Object.assign(fixture.api, {
      pageTypes: {
        create: createSpy,
        read: vi.fn(),
        save: vi.fn(),
        templates: {
          list: vi.fn(async () => ({ templates: [] })),
          delete: vi.fn(),
        },
      },
    });
    window.nativeApi = fixture.api;

    const launches: SpaceTemplateLaunchMetadata[] = [];
    const windowEvents: SpaceTemplateLaunchMetadata[] = [];
    const listener = (event: Event) => {
      const detail = (event as CustomEvent<{ launch: SpaceTemplateLaunchMetadata }>).detail;
      windowEvents.push(detail.launch);
    };
    window.addEventListener(SPACE_TEMPLATE_LAUNCH_EVENT, listener);

    try {
      await renderInHarness(
        <SpaceHome
          section={{ type: "all" }}
          title="资料空间"
          description=""
          items={[]}
          loading={false}
          error={null}
          onRetry={() => {}}
          onCreate={() => {}}
          onOpen={() => {}}
          placeOf={() => "个人"}
          emptyCreate="page"
          onLaunchTemplate={({ launch }) => launches.push(launch)}
        />,
      );

      await userEvent.click(
        page.getByRole("button", { name: /builtin:meeting-notes|会议纪要/ }).first(),
      );
      await vi.waitFor(() => {
        expect(createSpy).toHaveBeenCalledTimes(1);
        expect(launches).toHaveLength(1);
      });
      expect(launches[0]!.keepItemOpen).toBe(true);
      expect(launches[0]!.starterPrompt.length).toBeGreaterThan(0);
      expect(launches[0]!.prefillPrompt).toBe(launches[0]!.starterPrompt);
      expect(windowEvents[0]?.keepItemOpen).toBe(true);

      await cleanup();
      const full = buildSpaceItems({
        pages: Array.from({ length: 6 }, (_, index) => makePage(`full-${index}`)),
        apps: [],
        outputs: [],
      });
      await renderInHarness(
        <SpaceHome
          section={{ type: "all" }}
          title="资料空间"
          description=""
          items={full}
          loading={false}
          error={null}
          onRetry={() => {}}
          onCreate={() => {}}
          onOpen={() => {}}
          placeOf={() => "个人"}
          emptyCreate="page"
        />,
      );
      await expect.element(page.getByRole("heading", { name: "资料空间" })).toBeVisible();
      expect(document.querySelector("[data-space-create-tiles]")).toBeNull();
      expect(document.querySelector("[data-space-quick-start]")).toBeNull();
    } finally {
      window.removeEventListener(SPACE_TEMPLATE_LAUNCH_EVENT, listener);
    }
  });

  it("syncs all 8 active kinds from SpaceSidebar to SpaceHome and keeps SpaceCreateMenu to what can be made", async () => {
    const fixture = createDataSpaceFixture();
    const docPage = makePage("doc-1", { title: "文档条目", kind: "page" });
    const sheetPage = makePage("sheet-1", { title: "电子表格条目", kind: "sheet" });
    const boardPage = makePage("board-1", { title: "白板条目", kind: "board" });
    Object.assign(fixture.api, {
      pageTypes: {
        read: vi.fn(async () => ({ page: sheetPage, data: SHEET_WORKBOOK_DATA })),
        create: vi.fn(),
        save: vi.fn(),
        templates: { list: vi.fn(async () => ({ templates: [] })), delete: vi.fn() },
      },
    });
    window.nativeApi = fixture.api;

    const allItems = buildSpaceItems({
      pages: [docPage, sheetPage, boardPage],
      apps: [],
      outputs: [],
    });

    function Shell() {
      const [section, setSection] = useState<SpaceSection>({ type: "all" });
      return (
        <div className="flex h-screen">
          <SpaceSidebar
            scopeSpaceId={null}
            section={section}
            openKey={null}
            recent={recentItems(allItems)}
            spaces={[]}
            pages={[docPage, sheetPage, boardPage]}
            onSection={setSection}
            onOpen={() => {}}
            onOpenPage={() => {}}
            onCreate={() => {}}
            onCreateSubpage={() => {}}
            onRenameSpace={() => {}}
            onSpaceIcon={() => {}}
            onTrashSpace={() => {}}
            onClose={() => {}}
          />
          {section.type !== "trash" ? (
            <SpaceHome
              section={section}
              title="资料空间"
              description=""
              items={allItems}
              loading={false}
              error={null}
              onRetry={() => {}}
              onCreate={() => {}}
              onOpen={() => {}}
              placeOf={() => "个人"}
              emptyCreate="page"
            />
          ) : null}
        </div>
      );
    }

    await renderInHarness(<Shell />);

    const nav = page.getByRole("navigation", { name: "条目", exact: true });
    // Kinds fold away under 类型 until asked for.
    await expect
      .element(nav.getByRole("button", { name: "类型", exact: true }))
      .toHaveAttribute("aria-expanded", "false");
    await userEvent.click(nav.getByRole("button", { name: "类型", exact: true }));
    for (const label of [
      "全部",
      "文档",
      "幻灯片",
      "电子表格",
      "设计",
      "数据看板",
      "画布",
      "应用页",
      "图像",
      "站点",
    ]) {
      await expect.element(nav.getByRole("button", { name: label, exact: true })).toBeVisible();
    }
    // No standing explanation under 回收站.
    await expect.element(page.getByText("已删除条目保留 30 天")).not.toBeInTheDocument();

    await userEvent.click(nav.getByRole("button", { name: "电子表格", exact: true }));
    await vi.waitFor(() => {
      const cards = [...document.querySelectorAll("[data-space-item]")].map((el) =>
        el.getAttribute("data-space-item"),
      );
      expect(cards).toEqual(["page:sheet-1"]);
    });

    await userEvent.click(page.getByRole("button", { name: "创建", exact: true }).first());
    // Only what can be created now: no greyed or "coming soon" rows (WALK-2 N2-2).
    await expect.element(page.getByRole("menuitem", { name: "上传文件" })).toBeVisible();
    const rows = [...document.querySelectorAll<HTMLElement>("[data-space-create]")];
    expect(rows.map((row) => row.dataset.spaceCreate)).toEqual([
      "page",
      "slides",
      "sheet",
      "board",
      "design",
      "dashboard",
      "app",
      "image",
      "template",
      "upload",
    ]);
    expect(rows.filter((row) => row.getAttribute("aria-disabled") === "true")).toEqual([]);
    expect(document.querySelector('[data-space-create="sheet"]')?.textContent).toContain("Beta");
  });

  it("emits keepItemOpen & starterPrompt metadata from TemplatePickerDialog", async () => {
    const fixture = createDataSpaceFixture();
    const builtInTemplate: SpaceTemplate = {
      id: "builtin:budget-sheet",
      kind: "sheet",
      title: "预算明细表",
      description: "月度预算模板",
      category: "sheet",
      builtIn: true,
      sourcePageId: null,
      createdAt: null,
    };
    const createdItem: PageTypedItem = {
      page: makePage("budget-1", { title: "预算明细表", kind: "sheet" }),
      kind: "sheet",
      data: SHEET_WORKBOOK_DATA,
      dataRevision: 1,
    };
    Object.assign(fixture.api, {
      pageTypes: {
        templates: {
          list: vi.fn(async () => ({ templates: [builtInTemplate] })),
          delete: vi.fn(),
        },
        create: vi.fn(async () => createdItem),
        read: vi.fn(),
        save: vi.fn(),
      },
    });
    window.nativeApi = fixture.api;

    const onCreated = vi.fn();
    await renderInHarness(
      <div>
        <Button size="sm">背景按钮</Button>
        <TemplatePickerDialog
          open
          onOpenChange={() => {}}
          account="local"
          scopeSpaceId={null}
          onCreated={onCreated}
        />
      </div>,
    );

    const tile = await vi.waitFor(() => {
      const el = document.querySelector<HTMLElement>('[data-template-id="builtin:budget-sheet"]');
      expect(el).not.toBeNull();
      return el!;
    });
    await userEvent.click(tile);
    await vi.waitFor(() => expect(onCreated).toHaveBeenCalledTimes(1));
    const [returnedItem, launch] = onCreated.mock.calls[0]!;
    expect(returnedItem.page.id).toBe(createdItem.page.id);
    expect(launch?.keepItemOpen).toBe(true);
    expect(launch?.starterPrompt.length).toBeGreaterThan(0);
  });

  it("supports dark mode, filter menu sort/owner options, and grid/list toggle", async () => {
    installBrowserFixtureTheme("dark");
    const fixture = createDataSpaceFixture();
    const myDoc = makePage("alpha-doc", {
      title: "A 手动文档",
      sourceThreadId: null,
      updatedAt: "2026-11-21T10:00:00.000Z",
    });
    const aiBoard = makePage("zebra-board", {
      title: "Z 对话白板",
      kind: "board",
      sourceThreadId: ThreadId.makeUnsafe("t-1"),
      updatedAt: "2026-11-22T12:00:00.000Z",
    });
    window.nativeApi = fixture.api;
    const items = buildSpaceItems({ pages: [myDoc, aiBoard], apps: [], outputs: [] });

    await renderInHarness(
      <SpaceHome
        section={{ type: "all" }}
        title="资料空间"
        description=""
        items={items}
        loading={false}
        error={null}
        onRetry={() => {}}
        onCreate={() => {}}
        onOpen={() => {}}
        placeOf={() => "个人"}
        emptyCreate="page"
      />,
    );

    expect(document.querySelector("[data-space-grid]")).not.toBeNull();
    await userEvent.click(page.getByRole("button", { name: "筛选：全部类型", exact: true }));
    await userEvent.click(page.getByRole("menuitem", { name: "由我新建", exact: true }));
    await vi.waitFor(() => {
      const visible = [...document.querySelectorAll("[data-space-item]")].map((el) =>
        el.getAttribute("data-space-item"),
      );
      expect(visible).toEqual(["page:alpha-doc"]);
    });

    await userEvent.click(page.getByRole("button", { name: "列表视图", exact: true }));
    await expect.element(page.getByRole("grid", { name: "条目列表", exact: true })).toBeVisible();
    await userEvent.click(page.getByRole("button", { name: "网格视图", exact: true }));
    expect(document.querySelector("[data-space-grid]")).not.toBeNull();
  });

  it("loads local library image cards with a preview grant instead of firing ungranted /api/local-image requests", async () => {
    const fixture = createDataSpaceFixture();
    let resolveGrant!: (value: { grant: string; expiresAt: string }) => void;
    const createGrant = vi.fn(
      () =>
        new Promise<{ grant: string; expiresAt: string }>((resolve) => {
          resolveGrant = resolve;
        }),
    );
    Object.assign(fixture.api, {
      projects: { createLocalFilePreviewGrant: createGrant },
    });
    window.nativeApi = fixture.api;

    const observedSrcs: string[] = [];
    const recordImages = () => {
      for (const img of document.querySelectorAll<HTMLImageElement>(
        '[data-space-item="library:lib-moss-1"] img',
      )) {
        const src = img.getAttribute("src");
        if (src) observedSrcs.push(src);
      }
    };
    const observer = new MutationObserver(recordImages);
    observer.observe(document.body, {
      childList: true,
      subtree: true,
      attributes: true,
      attributeFilter: ["src"],
    });

    try {
      const items = buildSpaceItems({
        pages: [],
        apps: [],
        outputs: [],
        library: [
          {
            id: "lib-moss-1",
            title: "苔花如米.webp",
            kind: "image",
            source: "user:import",
            sourceCli: "moss",
            path: "D:/moss-home/library/imports/苔花如米.webp",
            mimeType: "image/webp",
            size: 43000,
            favorite: false,
            folderId: null,
            trashedAt: null,
            originationThreadId: null,
            createdAt: "2026-11-26T00:00:00.000Z",
            updatedAt: "2026-11-26T00:00:00.000Z",
          },
        ],
      });

      await renderInHarness(
        <GalleryProvider
          account="local"
          scopeSpaceId={null}
          items={items}
          spaces={[]}
          libraryFolders={[]}
          loading={false}
          onOpenItem={() => {}}
          onPlace={() => {}}
        >
          <SpaceItemCard
            item={items[0]!}
            view="grid"
            place="资料库"
            now={Date.now()}
            onOpen={() => {}}
          />
        </GalleryProvider>,
      );

      await vi.waitFor(() => {
        expect(createGrant).toHaveBeenCalledWith({
          path: "D:/moss-home/library/imports/苔花如米.webp",
        });
      });
      // Before the grant resolves, no ungranted /api/local-image <img> may mount.
      recordImages();
      expect(observedSrcs).toEqual([]);

      resolveGrant({
        grant: "grant-moss-1",
        expiresAt: "2026-12-01T00:00:00.000Z",
      });

      await vi.waitFor(() => {
        recordImages();
        expect(
          observedSrcs.some(
            (src) => src.includes("/api/local-image") && src.includes("grant=grant-moss-1"),
          ),
        ).toBe(true);
      });
    } finally {
      observer.disconnect();
    }
  });
});
