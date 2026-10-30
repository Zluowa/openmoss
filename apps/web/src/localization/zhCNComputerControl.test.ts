// FILE: zhCNComputerControl.test.ts
// Purpose: Locks Computer control Chinese chrome, composed status text, and preservation boundaries.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { summarizeComputerControlToast } from "../composerSlashCommands";
import { translateMoss } from "../localization";
import {
  rankSettingsSearchEntries,
  SETTINGS_SEARCH_ENTRIES,
  settingsSearchEntryTitle,
} from "../settingsSearchIndex";
import { translateZhCnPresentationText } from "./zhCN";
import { translateZhCnComputerControlText } from "./zhCNComputerControl";

describe("translateZhCnComputerControlText", () => {
  it.each([
    ["Computer control", "电脑控制"],
    ["Checking status…", "正在检查状态…"],
    ["Checking status...", "正在检查状态…"],
    [
      "Asking the desktop helper for Computer control availability.",
      "正在向桌面辅助程序查询电脑控制的可用性。",
    ],
    ["Desktop only", "仅限桌面应用"],
    [
      "Open Moss on macOS to review Computer control. Linux support is coming soon.",
      "请在 macOS 上打开 Moss 以查看电脑控制。即将支持 Linux。",
    ],
    ["Status unavailable", "无法获取状态"],
    ["Could not read Computer control status.", "无法读取电脑控制状态。"],
    ["Retry", "重试"],
    ["Refresh", "刷新"],
    ["Availability", "可用性"],
    ["Coming soon on Linux", "即将支持 Linux"],
    ["Unsupported on this platform", "此平台暂不支持"],
    ["Backend unavailable", "后端不可用"],
    ["Unavailable", "不可用"],
    ["Permissions & helper", "权限与辅助程序"],
    ["Input helper ready", "输入辅助程序已就绪"],
    ["Input helper not ready", "输入辅助程序尚未就绪"],
    ["Capture attached", "屏幕捕获已连接"],
    ["Capture not attached", "屏幕捕获尚未连接"],
    ["cliclick mentioned in host status", "主机状态中提及 cliclick"],
    ["Desktop capture", "桌面捕获"],
    [
      "Desktop capture is ready for a Computer Use thread. Run /computer-use in chat to enable capture for the current thread; this panel does not render a live desktop preview.",
      "桌面捕获已就绪，可用于电脑控制对话。在聊天中运行 /computer-use 即可为当前对话启用捕获；此面板不显示实时桌面预览。",
    ],
    [
      "Desktop capture becomes ready after Screen Recording permission and the native capture helper are ready; this panel does not render a live desktop preview.",
      "授予屏幕录制权限且原生捕获辅助程序就绪后，即可使用桌面捕获；此面板不显示实时桌面预览。",
    ],
    ["macOS permissions", "macOS 权限"],
    ["Privacy panes", "隐私设置"],
    [
      "Grant Accessibility and Screen Recording to Moss, then refresh. In chat, run /computer-use to enable control for the current thread.",
      "请为 Moss 授予辅助功能和屏幕录制权限，然后刷新。在聊天中运行 /computer-use 即可为当前对话启用电脑控制。",
    ],
    ["Accessibility", "辅助功能"],
    ["Screen Recording", "屏幕录制"],
    ["Open System Settings", "打开系统设置"],
    [
      "System Settings → Privacy & Security → Accessibility → allow Moss.",
      "系统设置 → 隐私与安全性 → 辅助功能 → 允许 Moss。",
    ],
    [
      "System Settings → Privacy & Security → Screen & System Audio Recording → allow Moss.",
      "系统设置 → 隐私与安全性 → 屏幕与系统音频录制 → 允许 Moss。",
    ],
    ["Moss Computer Use is ready on macOS.", "Moss 电脑控制已在 macOS 上就绪。"],
    [
      "Moss Computer Use is enabled on macOS; the native helper will attach when available.",
      "Moss 电脑控制已在 macOS 上启用；原生辅助程序可用后将自动连接。",
    ],
    [
      "Moss Computer Use is attached on macOS and is waiting for desktop permissions.",
      "Moss 电脑控制已在 macOS 上连接，正在等待桌面权限。",
    ],
    [
      "Moss Computer Use is attached on macOS; permission status is unavailable.",
      "Moss 电脑控制已在 macOS 上连接；无法获取权限状态。",
    ],
    ["Computer control is coming soon on Linux.", "电脑控制即将支持 Linux。"],
    ["Computer control is unavailable on this platform.", "此平台暂不支持电脑控制。"],
    ["Moss Computer Use is not available on this platform.", "此平台暂不支持 Moss 电脑控制。"],
    ["Computer Use is unavailable", "电脑控制不可用"],
    [
      "Open Moss on a supported desktop to use Computer Use.",
      "请在支持的桌面系统上打开 Moss 以使用电脑控制。",
    ],
    ["Invalid /computer-use command", "/computer-use 命令无效"],
    [
      "Use /computer-use, /computer-use on, /computer-use off, or /computer-use status.",
      "请使用 /computer-use、/computer-use on、/computer-use off 或 /computer-use status。",
    ],
    ["Computer Use is coming soon on Linux", "电脑控制即将支持 Linux"],
    ["Moss Computer Use currently supports macOS only.", "Moss 电脑控制目前仅支持 macOS。"],
    ["Computer control needs permissions", "电脑控制需要授权"],
    [
      "Grant Accessibility and Screen Recording to Moss in System Settings, then retry.",
      "请在系统设置中为 Moss 授予辅助功能和屏幕录制权限，然后重试。",
    ],
    ["Computer control status", "电脑控制状态"],
    ["Computer control enabled", "电脑控制已启用"],
    ["Computer control disabled", "电脑控制已关闭"],
    ["Moss could not update desktop control status.", "Moss 无法更新桌面控制状态。"],
  ])("translates %s directly and through the presentation chain", (source, expected) => {
    expect(translateZhCnComputerControlText(source)).toBe(expected);
    expect(translateZhCnPresentationText(source)).toBe(expected);
  });

  it.each(["cua", "cliclick", "custom-backend"])(
    "preserves the %s backend in both macOS availability states",
    (backend) => {
      expect(translateZhCnPresentationText(`Available on macOS (${backend})`)).toBe(
        `可在 macOS 上使用（${backend}）`,
      );
      expect(
        translateZhCnPresentationText(
          `Available on macOS (${backend}); waiting for native capture helper`,
        ),
      ).toBe(`可在 macOS 上使用（${backend}）；正在等待原生捕获辅助程序`);
    },
  );

  it.each([true, false])("translates composed helper rows with input ready = %s", (input) => {
    for (const capture of [true, false]) {
      for (const cliclick of [true, false]) {
        const source = `Input helper ${input ? "" : "not "}ready · Capture ${capture ? "" : "not "}attached${cliclick ? " · cliclick mentioned in host status" : ""}`;
        const expected = `输入辅助程序${input ? "已就绪" : "尚未就绪"} · 屏幕捕获${capture ? "已连接" : "尚未连接"}${cliclick ? " · 主机状态中提及 cliclick" : ""}`;
        expect(translateZhCnPresentationText(source)).toBe(expected);
        expect(
          translateZhCnPresentationText(`Moss Computer Use is ready on macOS. (${source})`),
        ).toBe(`Moss 电脑控制已在 macOS 上就绪。（${expected}）`);
        expect(
          translateZhCnPresentationText(`Host diagnostic (cliclick): exit 17\nEPERM (${source})`),
        ).toBe(`Host diagnostic (cliclick): exit 17\nEPERM（${expected}）`);
      }
    }
  });

  it("translates either or both native permission instructions inside the helper row", () => {
    const permissions = [
      [
        "Accessibility (System Settings → Privacy & Security → Accessibility → allow Moss)",
        "辅助功能（系统设置 → 隐私与安全性 → 辅助功能 → 允许 Moss）",
      ],
      [
        "Screen Recording (System Settings → Privacy & Security → Screen & System Audio Recording → allow Moss)",
        "屏幕录制（系统设置 → 隐私与安全性 → 屏幕与系统音频录制 → 允许 Moss）",
      ],
    ];
    for (const missing of [[permissions[0]!], [permissions[1]!], permissions]) {
      const source = `Moss Computer Use needs permission: ${missing.map(([en]) => en).join("; ")}. Then retry Computer Use.`;
      const expected = `Moss 电脑控制需要以下权限：${missing.map(([, zh]) => zh).join("；")}。然后重试电脑控制。`;
      expect(translateZhCnPresentationText(source)).toBe(expected);
      expect(
        translateZhCnPresentationText(`${source} (Input helper ready · Capture attached)`),
      ).toBe(`${expected}（输入辅助程序已就绪 · 屏幕捕获已连接）`);
    }
  });

  it("translates the actual slash toast summaries without changing their English source", () => {
    const enabled = summarizeComputerControlToast({
      enabled: true,
      availabilityKind: "available",
      backend: "cua",
      inputCapable: true,
      captureCapable: false,
      provisionSummary: "Moss Computer Use is ready on macOS.",
    });
    expect(enabled).toBe(
      "Computer control enabled for this chat (cua; input ready, capture unavailable). Moss Computer Use is ready on macOS.",
    );
    expect(translateZhCnPresentationText(enabled)).toBe(
      "已为此对话启用电脑控制（cua；输入已就绪，屏幕捕获不可用）。 Moss 电脑控制已在 macOS 上就绪。",
    );
    const disabled = summarizeComputerControlToast({
      enabled: false,
      availabilityKind: "backend-unavailable",
      inputCapable: false,
      captureCapable: true,
      provisionSummary: "Unknown helper error: /tmp/moss.sock\nexit 17",
    });
    expect(translateZhCnPresentationText(disabled)).toBe(
      "此对话的电脑控制已关闭（backend-unavailable；输入不可用，屏幕捕获已就绪）。 Unknown helper error: /tmp/moss.sock\nexit 17",
    );
    expect(
      translateZhCnPresentationText(
        "Computer control is off for this chat (cua; input unavailable, capture unavailable).",
      ),
    ).toBe("此对话的电脑控制已关闭（cua；输入不可用，屏幕捕获不可用）。");
  });

  it.each([
    "Moss",
    "cua",
    "cliclick",
    "/computer-use",
    "/Users/moss/Desktop/capture.png",
    "ScreenCaptureKit error -3801",
    "Available on macOS (cua) with custom diagnostic details",
    "prefix Available on macOS (cua)",
    "Input helper ready · Capture attached · unknown capability",
    "Custom status (Input helper ready)",
    "Moss Computer Use needs permission: UnknownPermission. Then retry Computer Use.",
  ])("preserves unknown runtime content and unmatched patterns: %s", (source) => {
    expect(translateZhCnComputerControlText(source)).toBe(source);
    expect(translateZhCnPresentationText(source)).toBe(source);
  });

  it("uses the existing localized navigation keys for settings search, retaining English", () => {
    const entry = SETTINGS_SEARCH_ENTRIES.find(
      ({ id }) => id === "computer:how-agents-use-the-desktop",
    )!;
    expect(settingsSearchEntryTitle(entry, (key) => translateMoss("zh-CN", key))).toBe("电脑控制");
    expect(settingsSearchEntryTitle(entry, (key) => translateMoss("en", key))).toBe(
      "Computer control",
    );
    expect(settingsSearchEntryTitle(entry)).toBe("Computer control");
    expect(
      rankSettingsSearchEntries("权限", 10, (key) => translateMoss("zh-CN", key)),
    ).toContainEqual(entry);
  });
});
