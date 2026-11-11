// @vitest-environment happy-dom
// Moss's creator skills show a Chinese chip name in a Chinese UI (acceptance 2026-11-11:
// the composer read "Plugin Creator" / "Skill Creator"); other skills keep their id label.
import { afterEach, describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "~/localization/zhCN";
import { formatComposerSkillChipLabel } from "./composerInlineChip";

afterEach(() => {
  delete document.documentElement.dataset.mossLocale;
});

describe("formatComposerSkillChipLabel", () => {
  it("names the creator skills in Chinese when the UI is Chinese", () => {
    document.documentElement.dataset.mossLocale = "zh-CN";
    expect(formatComposerSkillChipLabel("plugin-creator")).toBe("插件创建器");
    expect(formatComposerSkillChipLabel("skill-creator")).toBe("技能创建器");
    expect(formatComposerSkillChipLabel("moss-plugin-creator:plugin-creator")).toBe("插件创建器");
    // A user's own skill keeps the label made from its id.
    expect(formatComposerSkillChipLabel("check-code")).toBe("Check Code");
  });

  it("keeps English names in an English UI", () => {
    document.documentElement.dataset.mossLocale = "en";
    expect(formatComposerSkillChipLabel("plugin-creator")).toBe("Plugin Creator");
    expect(formatComposerSkillChipLabel("skill-creator")).toBe("Skill Creator");
  });

  it("translates the creator plugin's own row text", () => {
    expect(translateZhCnPresentationText("Plugin Creator")).toBe("插件创建器");
    expect(translateZhCnPresentationText("Create and edit plugins")).toBe("创建和编辑插件");
  });
});
