import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("settings copy in zh-CN", () => {
  it("translates whole sentences before a word-level rule can catch their first word", () => {
    expect(translateZhCnPresentationText("Show the Hubs tab in the sidebar switcher.")).toBe(
      "在侧边栏切换器中显示 Hubs 标签。",
    );
    expect(translateZhCnPresentationText("Stop and send")).toBe("停止并发送");
    expect(translateZhCnPresentationText("Show details by default")).toBe("默认显示详情");
  });

  it("translates provider status sentences and keeps the command literal", () => {
    expect(
      translateZhCnPresentationText(
        "Claude is not authenticated. Run `claude auth login` and try again.",
      ),
    ).toBe("Claude 尚未登录。请运行 `claude auth login` 后重试。");
    expect(
      translateZhCnPresentationText(
        "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH.",
      ),
    ).toBe("Cursor Agent CLI (`cursor-agent`) 未安装，或不在 PATH 中。");
  });

  it("translates the keyboard shortcut labels", () => {
    expect(translateZhCnPresentationText("Find in thread")).toBe("在对话中查找");
    expect(translateZhCnPresentationText("Toggle preview")).toBe("切换预览");
    expect(translateZhCnPresentationText("Show keybindings")).toBe("显示按键绑定");
    expect(translateZhCnPresentationText("Jump to Void")).toBe("跳转到未归类");
    expect(translateZhCnPresentationText("Jump to space 4")).toBe("跳转到空间 4");
  });

  it.each([
    ["In Moss", "在 Moss 中"],
    ["Share of turns.", "回合占比。"],
    ["Sidebar usage rings", "侧边栏用量圆环"],
    ["Current shortcut", "当前快捷键"],
    ["Check microphone access", "检查麦克风权限"],
    ["Free", "免费版"],
    ["Account", "账号"],
  ])("translates the settings label %s", (english, chinese) => {
    expect(translateZhCnPresentationText(english)).toBe(chinese);
  });

  it("translates whole sentences the sweep found on settings pages", () => {
    for (const sentence of [
      "Press your two-key shortcut while any app is frontmost. Moss captures that window as an image, brings itself forward, and attaches the snap to a task composer — the capture stays on this device until you send the message.",
      "Enable Computer by default in any chat. Leave this off and use /computer-use for one request without adding Computer tools to ordinary turns.",
      "Open the details below the limits. When off, they stay behind the Details toggle; your last toggle also updates this preference.",
      "Codex account usage requires a compatible app-server runtime.",
      "High impact. Tasks may modify the checkout you are actively using instead of an isolated worktree.",
      "High impact. The external agent may start full-access execution without asking you to approve tool actions.",
      "High impact. Tasks may drive this computer's screen — observe, click, type, menus, clipboard. Every computer action still asks for your approval.",
      "Applies to newly launched agent processes. Restart existing sessions to apply consistently.",
      "Visible because projects exist but no chat history is currently available.",
      "Rebuilds local project indexes and refreshes project snapshots. Existing chats stay in place.",
    ]) {
      const translated = translateZhCnPresentationText(sentence);
      expect(translated).not.toBe(sentence);
      expect(translated).not.toMatch(/[a-z]{3,} [a-z]{3,}/);
    }
  });

  it("translates dnd-kit's screen reader instructions with their line breaks", () => {
    expect(
      translateZhCnPresentationText(
        "To pick up a draggable item, press the space bar.\n    While dragging, use the arrow keys to move the item.\n    Press space again to drop the item in its new position, or press escape to cancel.",
      ),
    ).toBe(
      "要拿起可拖动的项目，请按空格键。拖动时，用方向键移动项目。再按一次空格键可放到新位置，按 Esc 键取消。",
    );
  });

  it("gives the reset buttons a Chinese label to place in their sentence", () => {
    expect(translateZhCnPresentationText("enabled providers")).toBe("已启用的服务商");
    expect(translateZhCnPresentationText("keep computer awake")).toBe("保持电脑唤醒");
    expect(translateZhCnPresentationText("thread order")).toBe("对话排序");
  });
});

describe("external agent connection copy in zh-CN", () => {
  it("translates pairing status, project scope and plan name", () => {
    expect(translateZhCnPresentationText("Waiting for pairing")).toBe("等待配对");
    expect(translateZhCnPresentationText("Paired — not used yet")).toBe("已配对，尚未使用");
    expect(translateZhCnPresentationText("All projects, including future ones")).toBe(
      "所有项目，包括以后新建的",
    );
    expect(translateZhCnPresentationText("Enterprise")).toBe("企业版");
  });

  it("translates the joined permission list part by part", () => {
    expect(translateZhCnPresentationText("Create and follow its own tasks")).toBe(
      "创建并跟进自己的任务",
    );
    expect(
      translateZhCnPresentationText(
        "Create and follow its own tasks · Use the shared local checkout · Control this computer (per-action approval still applies)",
      ),
    ).toBe("创建并跟进自己的任务 · 使用共享的本地检出 · 控制这台电脑（每个操作仍需批准）");
  });

  it("never says Mac for the computer-control warning", () => {
    const text = translateZhCnPresentationText(
      "High impact. Tasks may drive this computer's screen — observe, click, type, menus, clipboard. Every computer action still asks for your approval.",
    );
    expect(text).toContain("这台电脑");
    expect(text).not.toContain("Mac");
  });
});
