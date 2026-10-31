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
  });
});
