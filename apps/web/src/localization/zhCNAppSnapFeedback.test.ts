// FILE: zhCNAppSnapFeedback.test.ts
// Purpose: Locks AppSnap/Feedback Chinese UI translations and preservation boundaries.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnAppSnapFeedbackText } from "./zhCNAppSnapFeedback";

describe("translateZhCnAppSnapFeedbackText", () => {
  it("translates static AppSnap settings, welcome, attachment, and toast copy", () => {
    expect(translateZhCnAppSnapFeedbackText("AppSnap")).toBe("应用截图（AppSnap）");
    expect(translateZhCnAppSnapFeedbackText("Enable AppSnap")).toBe("启用应用截图（AppSnap）");
    expect(translateZhCnAppSnapFeedbackText("AppSnap is ready!")).toBe(
      "应用截图（AppSnap）已就绪！",
    );
    expect(translateZhCnAppSnapFeedbackText("Captured app")).toBe("已截图的应用");
    expect(translateZhCnAppSnapFeedbackText("AppSnap added with a warning")).toBe(
      "应用截图（AppSnap）已加入，但有一项警告",
    );
  });

  it("translates static Feedback entry points, categories, dialog copy, and delivery errors", () => {
    expect(translateZhCnAppSnapFeedbackText("Feedback Moss")).toBe("向 Moss 反馈");
    expect(translateZhCnAppSnapFeedbackText("Share feedback")).toBe("分享反馈");
    expect(translateZhCnAppSnapFeedbackText("Performance")).toBe("性能");
    expect(translateZhCnAppSnapFeedbackText("Share details (required)")).toBe("请说明详情（必填）");
    expect(translateZhCnAppSnapFeedbackText("Feedback delivery timed out. Please try again.")).toBe(
      "反馈发送超时，请重试。",
    );
  });

  it("preserves app names while translating dynamic AppSnap UI", () => {
    expect(
      translateZhCnAppSnapFeedbackText("AppSnap requires the Moss desktop app on macOS."),
    ).toBe("应用截图（AppSnap）需要在 macOS 上使用 Moss 桌面应用。");
    expect(
      translateZhCnAppSnapFeedbackText("Captured Visual Studio Code and added it to the composer."),
    ).toBe("已截取 Visual Studio Code 并加入编辑器。");
    expect(translateZhCnAppSnapFeedbackText("Preview AppSnap from Safari")).toBe(
      "预览来自 Safari 的应用截图（AppSnap）",
    );
  });

  it("translates AppSnap setup copy when JSX splits it around the key badge and app name", () => {
    expect(
      translateZhCnAppSnapFeedbackText("keys at once while any app is\n              frontmost."),
    ).toBe("两个键；无论当前位于哪个应用都可使用。");
    expect(
      translateZhCnAppSnapFeedbackText(
        "captures that window as an image, brings itself forward,\n" +
          "and attaches the snap to a task composer — the capture stays on this device until you\n" +
          "send the message.",
      ),
    ).toBe("会将该窗口截为图像、切回前台并附加到任务编辑器；发送消息之前，截图仅保存在此设备上。");
  });

  it("translates native error prefixes while preserving status and diagnostic details", () => {
    expect(
      translateZhCnAppSnapFeedbackText("The AppSnap helper stopped unexpectedly (exit 17)."),
    ).toBe("应用截图（AppSnap）辅助程序意外停止（exit 17）。");
    expect(
      translateZhCnAppSnapFeedbackText(
        "Could not configure window capture: ScreenCaptureKit error -3801",
      ),
    ).toBe("无法配置窗口截图：ScreenCaptureKit error -3801");
    expect(translateZhCnAppSnapFeedbackText("Feedback could not be sent (503).")).toBe(
      "反馈无法发送（503）。",
    );
  });

  it("returns unknown runtime content, paths, brands, and maintainer reports unchanged", () => {
    const values = [
      "Moss",
      "Visual Studio Code",
      "/Users/moss/Pictures/AppSnap.png",
      "Gateway reports /Users/moss/project unavailable.",
      "I ran into a bug in Moss 0.5.5, using codex with gpt-5.",
      "Report type: Bug",
      "A server-provided feedback diagnostic",
    ];

    for (const value of values) {
      expect(translateZhCnAppSnapFeedbackText(value)).toBe(value);
    }
  });
});
