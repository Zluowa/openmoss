// FILE: spaceGallery.test.ts
// Purpose: Unit tests for 资料空间 V2 gallery domain helpers: 8-kind filtering, dashboard
//          classification, tabs (全部 / 你的条目 / 与你共享), owner/sort filters, recent date
//          grouping, kind metadata, and template launch metadata.

import { PageId, ThreadId, type Page } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { getTemplateLaunchMetadata } from "../spaceTypes/templates/TemplatePickerDialog";
import {
  buildSpaceItems,
  effectiveSpaceItemKind,
  getSyncedSpaceHomeKind,
  groupRecentItems,
  itemsForSection,
  markSpaceDashboardItem,
  pageItem,
  setSyncedSpaceHomeKind,
  SPACE_KIND_FILTERS,
  SPACE_TABS,
} from "./spaceItems";
import { spaceKindMeta } from "./spaceKinds";

function makePage(id: string, overrides: Partial<Page> = {}): Page {
  return {
    id: PageId.makeUnsafe(id),
    scopeSpaceId: null,
    title: id,
    spaceId: null,
    parentPageId: null,
    rootPageId: PageId.makeUnsafe(id),
    kind: "page",
    sourceThreadId: null,
    pinned: false,
    trashedAt: null,
    assetIds: [],
    automationIds: [],
    createdAt: "2026-11-20T09:00:00.000Z",
    updatedAt: "2026-11-22T09:00:00.000Z",
    revision: 1,
    ...overrides,
  };
}

describe("spaceGallery domain", () => {
  it("exposes Claude 1:1 tabs and all 8 active kinds plus 站点/文件", () => {
    expect(SPACE_TABS.map((t) => t.label)).toEqual(["全部", "你的条目", "与你共享"]);
    const ids = SPACE_KIND_FILTERS.map((f) => f.id);
    for (const expected of [
      "any",
      "page",
      "slides",
      "sheet",
      "design",
      "dashboard",
      "board",
      "app",
      "image",
      "site",
      "file",
    ]) {
      expect(ids).toContain(expected);
    }
  });

  it("distinguishes 数据看板 from 应用页 once registered and filters cleanly", () => {
    const dashboardPage = makePage("sales-dash", { kind: "app", title: "销售看板" });
    const appPage = makePage("habit-app", { kind: "app", title: "打卡应用" });
    const items = buildSpaceItems({
      pages: [dashboardPage, appPage],
      apps: [],
      outputs: [],
    });

    const dashItem = items.find((i) => i.key === "page:sales-dash")!;
    markSpaceDashboardItem(dashItem.key, true);

    expect(effectiveSpaceItemKind(dashItem)).toBe("dashboard");
    expect(effectiveSpaceItemKind(items.find((i) => i.key === "page:habit-app")!)).toBe("app");

    const dashFiltered = itemsForSection(
      items,
      { type: "all" },
      { tab: "all", kind: "dashboard", query: "" },
    );
    expect(dashFiltered.map((i) => i.key)).toEqual(["page:sales-dash"]);

    const appFiltered = itemsForSection(
      items,
      { type: "all" },
      { tab: "all", kind: "app", query: "" },
    );
    expect(appFiltered.map((i) => i.key)).toEqual(["page:habit-app"]);

    markSpaceDashboardItem(dashItem.key, false);
  });

  it("does not truncate tab=all at 24 items, keeps 与你共享 empty, and supports owner/sort", () => {
    const pages = Array.from({ length: 28 }, (_, i) =>
      makePage(`p-${String(i).padStart(2, "0")}`, {
        title: `文档 ${String(28 - i).padStart(2, "0")}`,
        sourceThreadId: i % 2 === 0 ? ThreadId.makeUnsafe("thread-1") : null,
        createdAt: `2026-11-${String(1 + (i % 20)).padStart(2, "0")}T10:00:00.000Z`,
        updatedAt: `2026-11-${String(28 - i).padStart(2, "0")}T12:00:00.000Z`,
      }),
    );
    const items = buildSpaceItems({ pages, apps: [], outputs: [] });

    expect(
      itemsForSection(items, { type: "all" }, { tab: "all", kind: "any", query: "" }).length,
    ).toBe(28);
    expect(
      itemsForSection(items, { type: "all" }, { tab: "shared", kind: "any", query: "" }),
    ).toEqual([]);

    const mineOnly = itemsForSection(
      items,
      { type: "all" },
      { tab: "all", kind: "any", query: "", owner: "mine" },
    );
    expect(mineOnly.every((i) => i.sourceThreadId === null)).toBe(true);
    expect(mineOnly.length).toBe(14);

    const byTitle = itemsForSection(
      items.slice(0, 5),
      { type: "all" },
      { tab: "all", kind: "any", query: "", sort: "title" },
    );
    expect(byTitle.map((i) => i.title)).toEqual([
      "文档 24",
      "文档 25",
      "文档 26",
      "文档 27",
      "文档 28",
    ]);
  });

  it("groups recent items by 今天 / 昨天 / 近 7 天 / 更早 and syncs extended home kind", () => {
    const now = Date.parse("2026-11-22T15:00:00.000Z");
    const items = [
      pageItem(makePage("a", { updatedAt: "2026-11-22T14:00:00.000Z" })),
      pageItem(makePage("b", { updatedAt: "2026-11-21T14:00:00.000Z" })),
      pageItem(makePage("c", { updatedAt: "2026-11-18T14:00:00.000Z" })),
      pageItem(makePage("d", { updatedAt: "2026-11-01T14:00:00.000Z" })),
    ];
    const groups = groupRecentItems(items, now);
    expect(groups.map((g) => g.label)).toEqual(["今天", "昨天", "近 7 天", "更早"]);

    setSyncedSpaceHomeKind("sheet");
    expect(getSyncedSpaceHomeKind()).toBe("sheet");
    setSyncedSpaceHomeKind("any");
    expect(getSyncedSpaceHomeKind()).toBe("any");
  });

  it("provides kind metadata for 数据看板 & 白板 and keepItemOpen launch metadata for templates", () => {
    expect(spaceKindMeta("dashboard").label).toBe("数据看板");
    expect(spaceKindMeta("board").label).toBe("画布");
    expect(spaceKindMeta("sheet").label).toBe("电子表格");

    const launch = getTemplateLaunchMetadata({
      id: "builtin:meeting-notes",
      kind: "page",
      title: "会议纪要",
      description: "整理议程和结论",
    });
    expect(launch.keepItemOpen).toBe(true);
    expect(launch.starterPrompt.length).toBeGreaterThan(0);
    expect(launch.prefillPrompt).toBe(launch.starterPrompt);

    const customLaunch = getTemplateLaunchMetadata(
      { id: "custom:1", kind: "sheet", title: "自定义预算", description: "" },
      { autoRun: true },
    );
    expect(customLaunch.keepItemOpen).toBe(true);
    expect(customLaunch.autoRun).toBe(true);
    expect(customLaunch.starterPrompt).toContain("自定义预算");
  });
});
