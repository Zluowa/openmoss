import { SidebarSectionId } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { reorderSidebarSectionIds, sidebarSectionManagementCopy } from "./sidebarSectionManagement";

const FIRST = SidebarSectionId.makeUnsafe("section-first");
const SECOND = SidebarSectionId.makeUnsafe("section-second");
const THIRD = SidebarSectionId.makeUnsafe("section-third");

describe("sidebar section management helpers", () => {
  it("uses the authoritative English and Simplified Chinese labels", () => {
    expect(sidebarSectionManagementCopy("en").optionsFor("Research")).toBe("Options for Research");
    expect(sidebarSectionManagementCopy("zh-CN").optionsFor("Research")).toBe("“Research”的选项");
    expect(sidebarSectionManagementCopy("zh-CN").editSection).toBe("编辑分区");
    expect(sidebarSectionManagementCopy("zh-CN").archiveAllChats).toBe("归档所有对话");
    expect(sidebarSectionManagementCopy("zh-CN").deleteSection).toBe("删除分区");
    expect(sidebarSectionManagementCopy("zh-CN").unableToConfirmArchive).toBe("无法确认归档");
    expect(sidebarSectionManagementCopy("zh-CN").save).toBe("保存");
  });

  it("moves a section while preserving every active id exactly once", () => {
    expect(reorderSidebarSectionIds([FIRST, SECOND, THIRD], FIRST, THIRD)).toEqual([
      SECOND,
      THIRD,
      FIRST,
    ]);
    expect(reorderSidebarSectionIds([FIRST, SECOND, THIRD], THIRD, FIRST)).toEqual([
      THIRD,
      FIRST,
      SECOND,
    ]);
  });

  it("dispatches nothing for same-target or invalid section sets", () => {
    expect(reorderSidebarSectionIds([FIRST, SECOND], FIRST, FIRST)).toBeNull();
    expect(reorderSidebarSectionIds([FIRST, FIRST], FIRST, SECOND)).toBeNull();
    expect(reorderSidebarSectionIds([FIRST], FIRST, SECOND)).toBeNull();
  });
});
