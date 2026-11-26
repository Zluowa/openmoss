import { describe, expect, it } from "vitest";

import {
  MOSS_DEVELOPER_HANDBOOK_REFERENCES,
  MOSS_DEVELOPER_HARNESS_DIRECTIVE,
  MOSS_DEVELOPER_MARKETPLACE_NAME,
  MOSS_DEVELOPER_PLUGIN_COPY,
  MOSS_DEVELOPER_PLUGIN_ID,
  MOSS_DEVELOPER_PLUGIN_NAME,
  MOSS_DEVELOPER_SKILLS,
  MOSS_DEVELOPER_SKILL_MARKER,
  MOSS_DEVELOPER_STARTER_PROMPTS,
  MOSS_DEVELOPER_ZH_CN_COPY,
  isMossDeveloperPluginInstalled,
  mossDeveloperSkillMarkdown,
} from "./mossDeveloperPlugin";

describe("mossDeveloperPlugin", () => {
  it("defines stable identity, bilingual copy, skills, and handbook references", () => {
    expect(MOSS_DEVELOPER_MARKETPLACE_NAME).toBe("moss-bundled");
    expect(MOSS_DEVELOPER_PLUGIN_NAME).toBe("moss-developer");
    expect(MOSS_DEVELOPER_PLUGIN_ID).toBe("moss-developer@moss-bundled");
    expect(MOSS_DEVELOPER_PLUGIN_COPY.en.displayName).toBe("Moss Developer");
    expect(MOSS_DEVELOPER_PLUGIN_COPY.zhCN.displayName).toBe("Moss 开发者");
    expect(MOSS_DEVELOPER_PLUGIN_COPY.en.defaultPrompt.length).toBeGreaterThanOrEqual(3);
    expect(MOSS_DEVELOPER_PLUGIN_COPY.zhCN.defaultPrompt.length).toBeGreaterThanOrEqual(3);
    expect(MOSS_DEVELOPER_STARTER_PROMPTS.length).toBeGreaterThanOrEqual(3);

    expect(MOSS_DEVELOPER_SKILLS.map((skill) => skill.name)).toEqual(["moss-developer"]);
    for (const skill of MOSS_DEVELOPER_SKILLS) {
      const markdown = mossDeveloperSkillMarkdown(skill);
      expect(markdown).toContain(`name: ${skill.name}`);
      expect(markdown).toContain(MOSS_DEVELOPER_SKILL_MARKER);
      for (const capability of [
        "db",
        "ai",
        "media",
        "voice",
        "chat",
        "mossbot",
        "desktop",
        "files",
        "downloads",
      ]) {
        expect(markdown).toContain(`\`${capability}\``);
      }
      expect(markdown).toContain("moss-ui-kit");
      expect(markdown).toContain("Moss Developer API Key");
    }

    expect(MOSS_DEVELOPER_HANDBOOK_REFERENCES.length).toBeGreaterThanOrEqual(2);
    const handbookText = MOSS_DEVELOPER_HANDBOOK_REFERENCES.map((ref) => ref.body).join("\n");
    for (const symbol of [
      "MossButton",
      "MossCard",
      "MossTabs",
      "MossDrawer",
      "MossDialog",
      "MossBadge",
      "MossToast",
      "MossMarkdown",
      "MossSelectionAsk",
      "MossCompanionDrawer",
      "MossbotMeetingBar",
      "MossVoiceButton",
      "MossRealtimeVoiceBar",
      "MossMediaTrigger",
      "transcribe",
      "speak",
      "startRealtimeSession",
    ]) {
      expect(handbookText).toContain(symbol);
    }

    expect(MOSS_DEVELOPER_HARNESS_DIRECTIVE).toContain("moss_app_guide");
    expect(MOSS_DEVELOPER_HARNESS_DIRECTIVE).toContain("moss_app_publish");
    expect(MOSS_DEVELOPER_HARNESS_DIRECTIVE).toContain("moss-ui-kit");
    expect(MOSS_DEVELOPER_HARNESS_DIRECTIVE).toContain("voice");
    expect(MOSS_DEVELOPER_ZH_CN_COPY["Moss Developer"]).toBe("Moss 开发者");
  });

  it("treats moss-developer as installed by default and uninstalled only when listed", () => {
    expect(isMossDeveloperPluginInstalled(undefined)).toBe(true);
    expect(
      isMossDeveloperPluginInstalled({
        officialPlugins: { uninstalled: ["moss-guide@moss-official"] },
      }),
    ).toBe(true);
    expect(
      isMossDeveloperPluginInstalled({
        officialPlugins: { uninstalled: [MOSS_DEVELOPER_PLUGIN_ID] },
      }),
    ).toBe(false);
    expect(
      isMossDeveloperPluginInstalled({
        officialPlugins: { uninstalled: [MOSS_DEVELOPER_PLUGIN_NAME] },
      }),
    ).toBe(false);
  });
});
