import { describe, expect, it } from "vitest";

import { buildThreadContextMenuItems, type ThreadContextMenuCopy } from "./threadContextMenu";

const EN_COPY: ThreadContextMenuCopy = {
  pin: "Pin thread",
  unpin: "Unpin thread",
  rename: "Rename thread",
  markUnread: "Mark unread",
  clearNotification: "Clear notification",
  archive: "Archive",
  handoff: "Handoff",
  handoffTo: (target) => `Handoff to ${target}`,
  copy: "Copy",
  copyPath: "Copy Path",
  copyThreadId: "Copy Thread ID",
  openWith: "Open with",
  openPathInTerminal: "Open Path in Terminal",
  delete: "Delete",
};

const ZH_COPY: ThreadContextMenuCopy = {
  pin: "置顶",
  unpin: "取消置顶",
  rename: "重命名",
  markUnread: "标记为未读",
  clearNotification: "清除通知",
  archive: "归档",
  handoff: "移交",
  handoffTo: (target) => `移交给 ${target}`,
  copy: "复制",
  copyPath: "复制路径",
  copyThreadId: "复制对话 ID",
  openWith: "打开方式",
  openPathInTerminal: "在终端中打开路径",
  delete: "删除",
};

describe("buildThreadContextMenuItems", () => {
  it("builds the frozen Chinese supported order with trusted presentation metadata", () => {
    const items = buildThreadContextMenuItems({
      copy: ZH_COPY,
      isPinned: false,
      hasDismissibleNotification: false,
      canArchive: true,
      handoffTargets: [],
      hasWorkspacePath: false,
    });

    expect(items.map((item) => ("id" in item ? item.id : item.label))).toEqual([
      "toggle-pin",
      "rename",
      "mark-unread",
      "archive",
      "复制",
      "delete",
    ]);
    expect(items.slice(0, 4)).toEqual([
      { id: "toggle-pin", label: "置顶", iconKey: "pin", shortcutKey: "pin" },
      { id: "rename", label: "重命名", iconKey: "rename", shortcutKey: "rename" },
      {
        id: "mark-unread",
        label: "标记为未读",
        iconKey: "mark-unread",
        shortcutKey: "mark-unread",
      },
      { id: "archive", label: "归档", iconKey: "archive", shortcutKey: "archive" },
    ]);
    expect(items.at(-1)).toEqual({
      id: "delete",
      label: "删除",
      iconKey: "delete",
      destructive: true,
      separatorBefore: true,
    });
    expect(items.some((item) => "label" in item && item.label === "项目")).toBe(false);
    expect(items.some((item) => "label" in item && item.label === "分区")).toBe(false);
    expect(items.some((item) => "label" in item && item.label === "分享")).toBe(false);
  });

  it("groups conditional actions without changing existing leaf IDs", () => {
    const items = buildThreadContextMenuItems({
      copy: EN_COPY,
      isPinned: true,
      hasDismissibleNotification: true,
      canArchive: false,
      handoffTargets: [
        { instanceId: "claude_moss", label: "Moss Claude / 工作" },
        { instanceId: "codex_moss", label: "Moss Codex / 工作" },
      ],
      hasWorkspacePath: true,
      extraItems: [{ id: "return-to-single-chat", label: "Return to single chat" }],
    });

    expect(items.map((item) => ("id" in item ? item.id : item.label))).toEqual([
      "toggle-pin",
      "rename",
      "mark-unread",
      "clear-notification",
      "Handoff",
      "Copy",
      "Open with",
      "return-to-single-chat",
      "delete",
    ]);
    const handoff = items.find((item) => !("id" in item) && item.label === "Handoff");
    expect(handoff && "children" in handoff ? handoff.children : []).toEqual([
      {
        id: "handoff:claude_moss",
        label: "Handoff to Moss Claude / 工作",
        iconKey: "handoff",
      },
      {
        id: "handoff:codex_moss",
        label: "Handoff to Moss Codex / 工作",
        iconKey: "handoff",
      },
    ]);
    const copy = items.find((item) => !("id" in item) && item.label === "Copy");
    expect(
      copy && "children" in copy
        ? copy.children.map((child) => ("id" in child ? child.id : child.label))
        : [],
    ).toEqual(["copy-path", "copy-thread-id"]);
    const openWith = items.find((item) => !("id" in item) && item.label === "Open with");
    expect(openWith && "children" in openWith ? openWith.children : []).toEqual([
      {
        id: "open-path-in-terminal",
        label: "Open Path in Terminal",
        iconKey: "open-path-in-terminal",
      },
    ]);
  });

  it("adds a trusted Section submenu for current sections and default/new actions", () => {
    const items = buildThreadContextMenuItems({
      copy: {
        ...EN_COPY,
        section: {
          title: "Section",
          newSection: "New section",
          removeFromSection: "Remove from section",
          defaultSection: "Default list",
        },
      },
      isPinned: false,
      hasDismissibleNotification: false,
      canArchive: true,
      sections: [
        { id: "section-a", label: "Research" },
        { id: "section-b", label: "Ship" },
      ],
      currentSectionId: "section-a",
      handoffTargets: [],
      hasWorkspacePath: false,
    });

    const section = items.find((item) => !("id" in item) && item.label === "Section");
    expect(section && "children" in section ? section.children : []).toEqual([
      { id: "section:section-a", label: "Research" },
      { id: "section:section-b", label: "Ship" },
      { id: "section:default", label: "Remove from section" },
      { id: "section:new", label: "New section" },
    ]);
  });
});
