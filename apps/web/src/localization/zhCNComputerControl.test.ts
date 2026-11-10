// FILE: zhCNComputerControl.test.ts
// Purpose: Locks Computer control Chinese chrome, composed status text, and preservation boundaries.
// Layer: Pure localization tests

import type { ComputerPermission } from "@moss/contracts";
import {
  COMPUTER_PERMISSIONS,
  computerPermissionSetupMessage,
  computerStaleGrantAdvice,
  listComputerPermissions,
} from "@moss/shared/computerGrants";
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
    [
      "Moss couldn't find its computer control component. Reinstall Moss to use computer control.",
      "Moss 找不到电脑控制组件。请重新安装 Moss 后再使用电脑控制。",
    ],
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

  it("translates the Windows Computer control copy without naming third-party components", () => {
    const cases: ReadonlyArray<readonly [string, string]> = [
      ["Available on Windows (cua)", "可在 Windows 上使用（cua）"],
      [
        "Available on Windows (cua); waiting for native capture helper",
        "可在 Windows 上使用（cua）；正在等待原生捕获辅助程序",
      ],
      ["Computer control is ready on Windows.", "电脑控制已可在 Windows 上使用。"],
      ["Available on Linux (cua)", "可在 Linux 上使用（cua）"],
      ["Available on this computer (cua)", "可在这台电脑上使用（cua）"],
      [
        "Moss's computer control is not running yet. Restart Moss, then refresh.",
        "Moss 的电脑控制还没有运行。请重新打开 Moss，然后刷新。",
      ],
      [
        "Allow Moss Accessibility and Screen Recording access in Windows, then refresh.",
        "请在 Windows 中为 Moss 允许辅助功能和屏幕录制权限，然后刷新。",
      ],
      [
        "Allow Moss the UI Automation and screen access Windows asks for, then refresh.",
        "请允许 Windows 为 Moss 请求的界面自动化和屏幕权限，然后刷新。",
      ],
      [
        "Open the Moss desktop app to review Computer control.",
        "请打开 Moss 桌面应用查看电脑控制。",
      ],
    ];
    for (const [source, expected] of cases) {
      expect(translateZhCnPresentationText(source)).toBe(expected);
      expect(expected).not.toMatch(/Cua Driver/);
    }
  });

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

  describe("the macOS permission flow", () => {
    const zh = (value: string) => translateZhCnPresentationText(value);
    // Everything else English in these messages is a real failure to translate.
    const expectFullyTranslated = (value: string) => {
      const translated = zh(value);
      expect(translated).not.toBe(value);
      expect(
        translated
          .replace(/`tccutil reset \w+ [\w.]+`/g, "")
          .replace(/\b(?:Moss|macOS|Mac|Esc)\b/g, ""),
      ).not.toMatch(/[A-Za-z]{2,}/);
    };
    const grantSets: ReadonlyArray<readonly ComputerPermission[]> = [
      ["accessibility"],
      ["screenRecording"],
      ["inputMonitoring"],
      ["accessibility", "screenRecording"],
      ["accessibility", "inputMonitoring"],
      ["screenRecording", "inputMonitoring"],
      ["accessibility", "screenRecording", "inputMonitoring"],
    ];

    it("reads the state the packaged app reports when grants are missing", () => {
      const missing = ["accessibility", "inputMonitoring"] as const;
      const labels = listComputerPermissions(missing);
      expect(zh(`Computer control needs ${labels}`)).toBe("电脑控制需要辅助功能和输入监控权限");
      expect(zh(computerPermissionSetupMessage(missing, "unknown"))).toBe(
        "Moss 需要辅助功能和输入监控权限才能控制这台 Mac。请前往“系统设置 › 隐私与安全性 › 辅助功能和输入监控”打开 Moss，然后重试。",
      );
      expect(zh("Set up")).toBe("设置");
    });

    it("lists three grants the way Chinese does", () => {
      expect(zh(`Computer control needs ${listComputerPermissions(COMPUTER_PERMISSIONS)}`)).toBe(
        "电脑控制需要辅助功能、屏幕录制和输入监控权限",
      );
    });

    it.each(grantSets)("translates every message for %j", (...missing) => {
      const labels = listComputerPermissions(missing);
      for (const message of [
        `Computer control needs ${labels}`,
        `macOS may ask to allow ${labels} for Moss.`,
        `Allow ${labels} for this copy of Moss in System Settings. Return here to check again; if macOS asks you to quit and reopen the app, do so.`,
        computerPermissionSetupMessage(missing, "unknown"),
        computerPermissionSetupMessage(missing, "adhoc"),
        computerPermissionSetupMessage(missing, "adhoc", "com.moss.desktop"),
        computerStaleGrantAdvice(missing, "adhoc")!,
        computerStaleGrantAdvice(missing, "adhoc", "com.moss.desktop")!,
      ]) {
        expectFullyTranslated(message);
        // No other table in the chain may answer these with a second wording.
        expect(zh(message)).toBe(translateZhCnComputerControlText(message));
      }
    });

    it("keeps each tccutil command exactly as it must be typed", () => {
      const translated = zh(
        computerStaleGrantAdvice(
          ["accessibility", "screenRecording"],
          "adhoc",
          "com.moss.desktop",
        )!,
      );
      expect(translated).toContain("`tccutil reset Accessibility com.moss.desktop`");
      expect(translated).toContain("`tccutil reset ScreenCapture com.moss.desktop`");
    });

    it("translates the generic message and the fixed copy around it", () => {
      for (const message of [
        computerPermissionSetupMessage([], "unknown"),
        "Setting up…",
        "Recheck",
        "Setting up computer control",
        "Setting up the desktop may require installing a helper or allowing the permissions Moss needs.",
        "Choose Set up to request missing permissions or open System Settings. Allow access for this Moss app, then return here to recheck.",
        "Choose Set up to check permissions and prepare computer control.",
        "Computer control needs setup",
        "Computer control still needs setup",
        "Couldn't set up computer control",
        "Computer control is ready",
        "Send a message and the agent will pick up where it left off.",
        "Screen capture is not allowed yet",
        "The agent can act on the desktop but cannot see it, so screenshots fail. Turn Moss on in System Settings › Privacy & Security › Screen Recording, then press Set up to reconnect.",
        "The agent can act on the desktop but cannot see it, so screenshots fail. Press Set up to reconnect.",
        "Computer permissions are ready. Send a message to continue; no action is retried automatically.",
        "Computer control is paused until the Escape and human-input listener is ready. Moss reconnects it automatically; check Computer settings if it remains unavailable.",
      ]) {
        expectFullyTranslated(message);
      }
    });

    it.each([
      "Computer control needs Bluetooth",
      "Computer control needs Accessibility and Bluetooth",
      "Computer control needs constructor",
      "macOS may ask to allow toString for Moss.",
      "macOS may ask to allow Bluetooth for Moss.",
      "Moss needs Accessibility to control this Mac. Turn Moss on in System Settings › Privacy & Security › Input Monitoring, then try again.",
      "Moss needs Accessibility to control this Mac. Turn Moss on in System Settings › Privacy & Security › Accessibility, then try again. Unknown diagnostic.",
    ])("leaves anything it does not recognize alone: %s", (source) => {
      expect(translateZhCnComputerControlText(source)).toBe(source);
    });
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
