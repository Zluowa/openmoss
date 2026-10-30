// FILE: nativeMenuLocalization.test.ts
// Purpose: Locks reversible English/Simplified-Chinese desktop menu localization.

import { describe, expect, it } from "vitest";

import {
  normalizeNativeMenuLabel,
  normalizeNativeMenuLocale,
  translateNativeAppSnapMessage,
  translateNativeMenuLabel,
} from "./nativeMenuLocalization";

describe("normalizeNativeMenuLocale", () => {
  it("recognizes supported Simplified Chinese locale forms", () => {
    expect(normalizeNativeMenuLocale("zh-CN")).toBe("zh-CN");
    expect(normalizeNativeMenuLocale("zh_CN")).toBe("zh-CN");
    expect(normalizeNativeMenuLocale("zh-Hans-CN")).toBe("zh-CN");
  });

  it("defaults other locales to English instead of forcing Chinese", () => {
    expect(normalizeNativeMenuLocale("en")).toBe("en");
    expect(normalizeNativeMenuLocale("zh-TW")).toBe("en");
    expect(normalizeNativeMenuLocale(undefined)).toBe("en");
  });
});

describe("translateNativeAppSnapMessage", () => {
  it("translates known helper failures and keeps dynamic diagnostics intact", () => {
    expect(
      translateNativeAppSnapMessage(
        "The AppSnap native helper is missing from this desktop build.",
        "zh-CN",
      ),
    ).toBe("此桌面版本缺少应用截图（AppSnap）原生辅助程序。");
    expect(
      translateNativeAppSnapMessage("Could not start window capture: CGError 1001", "zh-CN"),
    ).toBe("无法启动窗口截图：CGError 1001");
    expect(
      translateNativeAppSnapMessage(
        "Moss could retain only the latest 8 AppSnaps while the composer was unavailable. The oldest capture was discarded.",
        "zh-CN",
      ),
    ).toBe("编辑器不可用期间，Moss 只能保留最近 8 张应用截图（AppSnap）。最早的截图已被丢弃。");
  });

  it("leaves English mode and unknown diagnostics untouched", () => {
    expect(translateNativeAppSnapMessage("AppSnap capture failed.", "en")).toBe(
      "AppSnap capture failed.",
    );
    expect(translateNativeAppSnapMessage("User-authored diagnostic", "zh-CN")).toBe(
      "User-authored diagnostic",
    );
  });
});

describe("normalizeNativeMenuLabel", () => {
  it("normalizes English aliases and Chinese labels to stable English keys", () => {
    expect(normalizeNativeMenuLabel("Check for Updates...")).toBe("Check for Updates…");
    expect(normalizeNativeMenuLabel("设置...")).toBe("Settings…");
    expect(normalizeNativeMenuLabel("隐藏 Moss")).toBe("Hide Moss");
    expect(normalizeNativeMenuLabel("复制路径")).toBe("Copy Path");
  });
});

describe("translateNativeMenuLabel", () => {
  it.each([
    ["About Moss", "关于 Moss"],
    ["Check for Updates...", "检查更新…"],
    ["Settings...", "设置…"],
    ["Services", "服务"],
    ["Hide Moss", "隐藏 Moss"],
    ["Hide Others", "隐藏其他应用"],
    ["Show All", "显示全部"],
    ["Quit Moss", "退出 Moss"],
    ["File", "文件"],
    ["Edit", "编辑"],
    ["View", "视图"],
    ["Window", "窗口"],
    ["Help", "帮助"],
  ])("translates application menu %s to %s", (english, chinese) => {
    expect(translateNativeMenuLabel(english, "zh-CN")).toBe(chinese);
    expect(translateNativeMenuLabel(chinese, "en")).toBe(normalizeNativeMenuLabel(english));
  });

  it.each([
    ["Undo", "撤销"],
    ["Paste and Match Style", "粘贴并匹配样式"],
    ["Select All", "全选"],
    ["New Terminal Tab", "新建终端标签页"],
    ["Toggle Sidebar", "切换侧边栏"],
    ["Toggle Browser", "切换浏览器"],
    ["Reset Zoom", "重置缩放"],
    ["Zoom In", "放大"],
    ["Zoom Out", "缩小"],
    ["Toggle Full Screen", "切换全屏"],
    ["Keyboard Shortcuts", "键盘快捷键"],
  ])("translates native role/custom item %s to %s", (english, chinese) => {
    expect(translateNativeMenuLabel(english, "zh-CN")).toBe(chinese);
    expect(translateNativeMenuLabel(chinese, "en")).toBe(english);
  });

  it.each([
    ["Rename thread", "重命名"],
    ["Pin thread", "置顶"],
    ["Unpin thread", "取消置顶"],
    ["Clear notification", "清除通知"],
    ["Mark unread", "标记为未读"],
    ["Copy Path", "复制路径"],
    ["Copy Thread ID", "复制对话 ID"],
    ["Open Path in Terminal", "在终端中打开路径"],
    ["Handoff", "移交"],
    ["Copy", "复制"],
    ["Open with", "打开方式"],
    ["Add to chat", "添加到聊天"],
    ["Reveal in Finder", "在 Finder 中显示"],
    ["Open in Explorer", "在资源管理器中打开"],
    ["Show in folder", "在文件夹中显示"],
    ["Download a copy", "下载副本"],
    ["Reference selection in chat", "在对话中引用所选内容"],
    ["Reference diff in chat", "在对话中引用差异"],
    ["Ask why this changed", "询问为何发生此更改"],
    ["Restore", "恢复"],
    ["Archive", "归档"],
    ["Delete", "删除"],
    ["Delete draft", "删除草稿"],
  ])("round-trips renderer context action %s", (english, chinese) => {
    expect(translateNativeMenuLabel(english, "zh-CN")).toBe(chinese);
    expect(translateNativeMenuLabel(chinese, "en")).toBe(english);
  });

  it("accepts legacy thread labels while emitting the frozen Codex labels", () => {
    expect(translateNativeMenuLabel("重命名对话", "en")).toBe("Rename thread");
    expect(translateNativeMenuLabel("固定对话", "en")).toBe("Pin thread");
    expect(translateNativeMenuLabel("取消固定对话", "en")).toBe("Unpin thread");
  });

  it("keeps generated-image labels exact while preserving Chromium/file-menu labels", () => {
    expect(normalizeNativeMenuLabel("Copy image")).toBe("Copy image");
    expect(translateNativeMenuLabel("Copy image", "en")).toBe("Copy image");
    expect(translateNativeMenuLabel("Copy image", "zh-CN")).toBe("复制图像");
    expect(translateNativeMenuLabel("复制图像", "en")).toBe("Copy Image");
    expect(translateNativeMenuLabel("Copy Image", "en")).toBe("Copy Image");

    expect(normalizeNativeMenuLabel("Show in Finder")).toBe("Show in Finder");
    expect(translateNativeMenuLabel("Show in Finder", "en")).toBe("Show in Finder");
    expect(translateNativeMenuLabel("Show in Finder", "zh-CN")).toBe("在 Finder 中显示");
    expect(translateNativeMenuLabel("Reveal in Finder", "en")).toBe("Reveal in Finder");
    expect(translateNativeMenuLabel("Reveal in Finder", "zh-CN")).toBe("在 Finder 中显示");
  });

  it("round-trips counted context actions", () => {
    expect(translateNativeMenuLabel("Mark unread (12)", "zh-CN")).toBe("标记为未读（12）");
    expect(translateNativeMenuLabel("归档（3）", "en")).toBe("Archive (3)");
    expect(translateNativeMenuLabel("删除(8)", "zh-CN")).toBe("删除（8）");
  });

  it.each([
    ["Reference line 21 in chat", "在对话中引用第 21 行"],
    ["Reference line 21:5-12 in chat", "在对话中引用第 21:5-12 行"],
    ["Reference lines 3-9 in chat", "在对话中引用第 3-9 行"],
    ["Reference lines 21:5-23:8 in chat", "在对话中引用第 21:5-23:8 行"],
    ["Ask why line 7 changed", "询问第 7 行为何发生更改"],
    ["Ask why lines 7-11 changed", "询问第 7-11 行为何发生更改"],
  ])("round-trips dynamic range action %s", (english, chinese) => {
    expect(translateNativeMenuLabel(english, "zh-CN")).toBe(chinese);
    expect(translateNativeMenuLabel(chinese, "en")).toBe(english);
  });

  it("translates only the handoff wrapper and retains the provider label", () => {
    expect(translateNativeMenuLabel("Handoff to Moss Codex / 工作", "zh-CN")).toBe(
      "移交给 Moss Codex / 工作",
    );
    expect(translateNativeMenuLabel("移交给 Moss Codex / 工作", "en")).toBe(
      "Handoff to Moss Codex / 工作",
    );
  });

  it("preserves unknown project names, paths, spelling suggestions, and user content", () => {
    for (const value of [
      "Project Settings",
      "/Users/moss/Projects/Archive",
      "Moss migration notes",
      "自定义用户内容",
      "suggestion-from-dictionary",
    ]) {
      expect(translateNativeMenuLabel(value, "zh-CN")).toBe(value);
      expect(translateNativeMenuLabel(value, "en")).toBe(value);
    }
  });
});
