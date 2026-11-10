// FILE: zhCNComposedLabels.test.ts
// Purpose: Locks labels built around another label, mostly hidden accessible names, so the inner
//          label is translated too and product names stay literal.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("composed labels in zh-CN", () => {
  it("translates the shortcut editor's accessible names with the command inside", () => {
    expect(translateZhCnPresentationText("Change the shortcut Ctrl+F for Find in thread")).toBe(
      "更改“在对话中查找”的快捷键 Ctrl+F",
    );
    expect(translateZhCnPresentationText("Remove the shortcut Ctrl+B from Toggle sidebar")).toBe(
      "移除“切换侧边栏”的快捷键 Ctrl+B",
    );
    expect(translateZhCnPresentationText("Add another shortcut for Save file")).toBe(
      "为“保存文件”添加另一个快捷键",
    );
    expect(translateZhCnPresentationText("Set a shortcut for Toggle preview")).toBe(
      "为“切换预览”设置快捷键",
    );
  });

  it("explains a shortcut that cannot be used", () => {
    expect(translateZhCnPresentationText("Ctrl+C is reserved for Copy. Try another.")).toBe(
      "Ctrl+C 已保留给“复制”。请换一个。",
    );
    expect(translateZhCnPresentationText("Ctrl+K is available.")).toBe("Ctrl+K 可用。");
    expect(
      translateZhCnPresentationText("Ctrl+K already runs Find in thread. Saving moves it here."),
    ).toBe("Ctrl+K 已用于“在对话中查找”。保存后会移到这里。");
  });

  it("does not half translate a sidebar or picker toggle", () => {
    expect(translateZhCnPresentationText("Show the Hubs section in the sidebar")).toBe(
      "在侧边栏显示“Hubs”分区",
    );
    expect(translateZhCnPresentationText("Show Devin in the provider picker")).toBe(
      "在服务商选择器中显示 Devin",
    );
    expect(translateZhCnPresentationText("Show Codex usage at the bottom of the sidebar")).toBe(
      "在侧边栏底部显示 Codex 的用量",
    );
  });

  it("keeps provider names literal in account labels", () => {
    expect(translateZhCnPresentationText("Accent color #dc2626 for OpenCode")).toBe(
      "OpenCode 的强调色 #dc2626",
    );
    expect(translateZhCnPresentationText("Disable Oh My Pi")).toBe("停用 Oh My Pi");
    expect(translateZhCnPresentationText("Kimi Code setup guide")).toBe("Kimi Code 设置指南");
    expect(translateZhCnPresentationText("Run pi update")).toBe("运行 pi update");
    expect(translateZhCnPresentationText("Antigravity accounts")).toBe("Antigravity 账号");
  });

  it("translates the theme editor labels and the capability line", () => {
    expect(translateZhCnPresentationText("Dark theme window material")).toBe("深色主题窗口材质");
    expect(translateZhCnPresentationText("Light theme preview: Moss")).toBe("浅色主题预览：Moss");
    expect(translateZhCnPresentationText("Inactive while the app is locked to light.")).toBe(
      "应用锁定为浅色时不生效。",
    );
    expect(translateZhCnPresentationText("screen capture, input, ghost cursor")).toBe(
      "屏幕截图、输入、虚拟光标",
    );
  });

  it("keeps the platform name in the computer control sentence", () => {
    expect(
      translateZhCnPresentationText(
        "This server is running on win32. Computer control needs macOS, or a Wayland desktop on Linux — KWin or Hyprland, or Moss's own nested desktop.",
      ),
    ).toBe(
      "这台服务器运行在 win32 上。电脑控制需要 macOS，或 Linux 上的 Wayland 桌面（KWin、Hyprland 或 Moss 自带的嵌套桌面）。",
    );
  });
});
