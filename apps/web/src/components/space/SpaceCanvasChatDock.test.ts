import { ThreadId } from "@moss/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  SPACE_DOCK_PERSIST_KEYS,
  type SpaceCanvasSelectionContext,
} from "./spaceCanvasDockContract";
import {
  SPACE_DOCK_DEFAULT_PIP_SIZE,
  SPACE_DOCK_MIN_PIP_HEIGHT_PX,
  SPACE_DOCK_MIN_PIP_WIDTH_PX,
  SPACE_DOCK_RECENT_THREADS_LRU_LIMIT,
  applySpaceDockPipResize,
  areSpaceDockSelectionsEqual,
  buildSpaceDockCompanionContext,
  clampSpaceDockPipRect,
  computeSpaceDockHostInsets,
  formatSpaceDockElapsedLabel,
  formatSpaceDockSelectionSummary,
  isNearSpaceDockRightSnapZone,
  readPersistedSpaceDockMode,
  readPersistedSpaceDockPipSize,
  readSkipSidechatCloseConfirmation,
  readSpaceDockRecentThreads,
  recordSpaceDockRecentThread,
  resetSpaceDockLogicForTests,
  writePersistedSpaceDockMode,
  writePersistedSpaceDockPipSize,
  writeSkipSidechatCloseConfirmation,
} from "./SpaceCanvasChatDock.logic";

describe("SpaceCanvasChatDock.logic", () => {
  beforeEach(() => {
    const store = new Map<string, string>();
    vi.stubGlobal("window", {
      localStorage: {
        getItem: (key: string) => store.get(key) ?? null,
        setItem: (key: string, value: string) => {
          store.set(key, value);
        },
        removeItem: (key: string) => {
          store.delete(key);
        },
      },
    });
    resetSpaceDockLogicForTests();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
    resetSpaceDockLogicForTests();
  });

  it("formats elapsed timer and idle/done status labels cleanly", () => {
    expect(formatSpaceDockElapsedLabel(true, 0)).toBe("已处理 0秒");
    expect(formatSpaceDockElapsedLabel(true, 14.9)).toBe("已处理 14秒");
    expect(formatSpaceDockElapsedLabel(false, 12)).toBe("已完成");
    expect(formatSpaceDockElapsedLabel(false, 0)).toBe("问 Moss");
  });

  it("clamps PiP default 560x640 size to viewport bounds (min 372x400, max 50vw)", () => {
    const clampedWide = clampSpaceDockPipRect({}, { width: 1440, height: 900 });
    expect(clampedWide.width).toBe(SPACE_DOCK_DEFAULT_PIP_SIZE.width);
    expect(clampedWide.height).toBe(SPACE_DOCK_DEFAULT_PIP_SIZE.height);

    const clampedNarrow = clampSpaceDockPipRect(
      { width: 900, height: 900 },
      { width: 1000, height: 700, topInsetPx: 44 },
    );
    expect(clampedNarrow.width).toBe(500); // 50vw of 1000
    expect(clampedNarrow.height).toBe(624); // 700 - 44 - 32

    const clampedTooSmall = clampSpaceDockPipRect(
      { width: 120, height: 150 },
      { width: 1440, height: 900 },
    );
    expect(clampedTooSmall.width).toBe(SPACE_DOCK_MIN_PIP_WIDTH_PX);
    expect(clampedTooSmall.height).toBe(SPACE_DOCK_MIN_PIP_HEIGHT_PX);
  });

  it("applies PiP corner and edge resizing while keeping opposite anchors fixed", () => {
    const viewport = { width: 1440, height: 900, topInsetPx: 44, bottomInsetPx: 60 };
    const start = { left: 800, top: 180, width: 560, height: 640 };

    const nw = applySpaceDockPipResize(start, "nw", 40, 30, viewport);
    expect(nw.left).toBe(840);
    expect(nw.top).toBe(210);
    expect(nw.left + nw.width).toBe(start.left + start.width);
    expect(nw.top + nw.height).toBe(start.top + start.height);

    const se = applySpaceDockPipResize(start, "se", -100, -100, viewport);
    expect(se.left).toBe(start.left);
    expect(se.top).toBe(start.top);
    expect(se.width).toBe(460);
    expect(se.height).toBe(540);
  });

  it("detects the right-edge snap drop zone cleanly", () => {
    expect(
      isNearSpaceDockRightSnapZone({
        rectRightPx: 1300,
        containerWidthPx: 1440,
        pointerClientX: 1390,
        containerRightPx: 1440,
      }),
    ).toBe(true);
    expect(
      isNearSpaceDockRightSnapZone({
        rectRightPx: 1200,
        containerWidthPx: 1440,
        pointerClientX: 1100,
        containerRightPx: 1440,
      }),
    ).toBe(false);
  });

  it("formats artifact selection summary and companion context across all kinds", () => {
    const selection: SpaceCanvasSelectionContext = {
      kind: "sheet",
      itemId: "sheet-1",
      title: "季度预算",
      sheetName: "Q4",
      range: "A1:C12",
      quote: "总支出超出预期 12%",
    };
    expect(formatSpaceDockSelectionSummary(selection)).toBe("Q4 · A1:C12 · 总支出超出预期 12%");
    const block = buildSpaceDockCompanionContext(
      {
        kind: "sheet",
        itemId: "sheet-1",
        title: "季度预算",
        scopeSpaceId: "space-1" as never,
        revision: 4,
      },
      selection,
      "请补充同比计算列",
    );
    expect(block).toContain("kind: sheet (电子表格)");
    expect(block).toContain("sheetName: Q4");
    expect(block).toContain("range: A1:C12");
    expect(block).toContain("revision: 4");
    expect(block).toContain("请补充同比计算列");
  });

  it("persists dock mode, PiP size, close-confirmation opt-out, and 500-LRU recent threads", () => {
    writePersistedSpaceDockMode("docked");
    expect(window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.mode)).toBe("docked");
    expect(readPersistedSpaceDockMode()).toBe("docked");

    writePersistedSpaceDockPipSize({ width: 520, height: 610 });
    expect(readPersistedSpaceDockPipSize()).toEqual({ width: 520, height: 610 });

    expect(readSkipSidechatCloseConfirmation()).toBe(false);
    writeSkipSidechatCloseConfirmation(true);
    expect(window.localStorage.getItem(SPACE_DOCK_PERSIST_KEYS.skipCloseConfirm)).toBe("true");
    expect(readSkipSidechatCloseConfirmation()).toBe(true);

    for (let i = 0; i < SPACE_DOCK_RECENT_THREADS_LRU_LIMIT + 5; i++) {
      recordSpaceDockRecentThread({
        threadId: ThreadId.makeUnsafe(`thread-${i}`),
        title: `Thread ${i}`,
        artifactKey: `acct:local:page:${i}`,
        kind: "page",
        itemId: `item-${i}`,
        scopeSpaceId: null,
        updatedAt: i,
      });
    }
    const recent = readSpaceDockRecentThreads();
    expect(recent).toHaveLength(SPACE_DOCK_RECENT_THREADS_LRU_LIMIT);
    expect(recent[0]?.threadId).toBe(ThreadId.makeUnsafe("thread-504"));
  });

  it("computes hostInsets to avoid covering floating bottom bars", () => {
    expect(computeSpaceDockHostInsets({ state: "collapsed", showCollapsedPill: false })).toEqual({
      bottomInsetPx: 0,
      rightInsetPx: 0,
    });
    expect(
      computeSpaceDockHostInsets({
        state: "collapsed",
        showCollapsedPill: true,
        collapsedPillHeightPx: 40,
      }),
    ).toEqual({
      bottomInsetPx: 56,
      rightInsetPx: 0,
    });
    expect(
      computeSpaceDockHostInsets({
        state: "docked",
        showCollapsedPill: false,
        dockedWidthPx: 480,
      }),
    ).toEqual({
      bottomInsetPx: 0,
      rightInsetPx: 480,
    });
  });

  it("compares selection contexts structurally so identical re-emissions stay idempotent", () => {
    const base: SpaceCanvasSelectionContext = {
      kind: "page",
      itemId: "page-1",
      title: "PRD",
      anchorBlockId: "blk-1",
      slideIds: ["s1", "s2"],
      elementIds: ["e1"],
      boardIds: ["b1"],
      quote: "hello",
      summary: "sum",
    };

    expect(areSpaceDockSelectionsEqual(null, null)).toBe(true);
    expect(areSpaceDockSelectionsEqual(base, null)).toBe(false);
    expect(areSpaceDockSelectionsEqual(null, base)).toBe(false);
    expect(areSpaceDockSelectionsEqual(base, { ...base })).toBe(true);
    expect(
      areSpaceDockSelectionsEqual(base, {
        ...base,
        slideIds: ["s1", "s2"],
        elementIds: ["e1"],
        boardIds: ["b1"],
      }),
    ).toBe(true);
    expect(
      areSpaceDockSelectionsEqual(
        { kind: "sheet", itemId: "s-1", title: "Budget", sheetName: null },
        { kind: "sheet", itemId: "s-1", title: "Budget", range: null },
      ),
    ).toBe(true);
    expect(areSpaceDockSelectionsEqual(base, { ...base, title: "Updated" })).toBe(false);
    expect(areSpaceDockSelectionsEqual(base, { ...base, slideIds: ["s1"] })).toBe(false);
    expect(areSpaceDockSelectionsEqual(base, { ...base, elementIds: ["e2"] })).toBe(false);
    expect(areSpaceDockSelectionsEqual(base, { ...base, boardIds: ["b2"] })).toBe(false);
  });
});
