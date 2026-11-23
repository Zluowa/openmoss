import { describe, expect, it } from "vitest";

import {
  BROWSER_HISTORY_TITLES,
  MOSS_MCP_TOOL_PRESENTATIONS,
  localizeMossToolHeading,
  mossToolLabel,
} from "./mossToolPresentation";

const HAN = /\p{Script=Han}/u;

describe("Moss tool words, one table for desktop and phone", () => {
  it("has Chinese for every state of every Moss tool, so a Chinese row never shows English", () => {
    const missing: string[] = [];
    for (const [tool, presentation] of Object.entries(MOSS_MCP_TOOL_PRESENTATIONS)) {
      for (const english of new Set([
        presentation.running,
        presentation.completed,
        presentation.failed,
      ])) {
        const chinese = localizeMossToolHeading(english);
        if (!chinese || !HAN.test(chinese)) missing.push(`${tool}: ${english}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("covers every browser tool, live and retired", () => {
    for (const tool of Object.keys(BROWSER_HISTORY_TITLES)) {
      expect(MOSS_MCP_TOOL_PRESENTATIONS, tool).toHaveProperty(`moss_${tool}`);
    }
  });

  it("says each state the desktop's way, however a provider wraps the name", () => {
    expect(
      mossToolLabel({ toolName: "mcp__moss__moss_context", status: "running", locale: "zh-CN" }),
    ).toBe("正在检查上下文");
    expect(
      mossToolLabel({ toolName: "moss_media_generate", status: "completed", locale: "zh-CN" }),
    ).toBe("已提交生成");
    expect(
      mossToolLabel({ toolName: "moss_media_generate", status: "completed", locale: "en" }),
    ).toBe("Moss started a generation");
    expect(
      mossToolLabel({
        toolName: "mcp__moss__moss_canvas_mutate",
        status: "failed",
        locale: "zh-CN",
      }),
    ).toBe("无法更新画布");
    expect(
      mossToolLabel({
        toolName: "mcp__moss__computer_click",
        status: "completed",
        locale: "zh-CN",
      }),
    ).toBe("已点击桌面");
    expect(mossToolLabel({ toolName: "browser_open", locale: "zh-CN" })).toBe("打开浏览器标签页");
    expect(mossToolLabel({ toolName: "browser_run", locale: "zh-CN" })).toBe("执行浏览器操作");
    expect(
      mossToolLabel({ toolName: "moss_theme_set", status: "cancelled", locale: "zh-CN" }),
    ).toBe("已停止更换 Moss 外观");
  });

  it("is not a Moss tool's words for another server's tool", () => {
    expect(mossToolLabel({ toolName: "mcp__github__create_issue", locale: "zh-CN" })).toBeNull();
    expect(mossToolLabel({ toolName: "Bash", locale: "en" })).toBeNull();
    expect(mossToolLabel({ toolName: "mcp__moss_apps__run_action", locale: "en" })).toBeNull();
  });
});
