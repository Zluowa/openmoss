import { describe, expect, it } from "vitest";

import {
  MOSS_GUIDE_HARNESS_DIRECTIVE,
  MOSS_GUIDE_PLUGIN_COPY,
  MOSS_GUIDE_PLUGIN_ID,
  MOSS_GUIDE_PLUGIN_NAME,
  MOSS_GUIDE_SKILLS,
  MOSS_GUIDE_SKILL_MARKER,
  MOSS_GUIDE_STARTER_PROMPTS,
  MOSS_OFFICIAL_MARKETPLACE_NAME,
  PLUGIN_SUGGESTION_DISMISS_COOLDOWN_MS,
  activeDismissedSuggestionPluginIds,
  isMossGuidePluginInstalled,
  mossGuideSkillMarkdown,
  upsertDismissedPluginSuggestion,
} from "./mossGuidePlugin";

describe("mossGuidePlugin", () => {
  it("defines the plug-and-play official plugin identity and copy in en and zhCN", () => {
    expect(MOSS_OFFICIAL_MARKETPLACE_NAME).toBe("moss-official");
    expect(MOSS_GUIDE_PLUGIN_NAME).toBe("moss-guide");
    expect(MOSS_GUIDE_PLUGIN_ID).toBe("moss-guide@moss-official");
    expect(MOSS_GUIDE_PLUGIN_COPY.en.displayName).toBe("Moss Guide");
    expect(MOSS_GUIDE_PLUGIN_COPY.zhCN.displayName).toBe("Moss 使用手册");
    expect(MOSS_GUIDE_PLUGIN_COPY.en.defaultPrompt.length).toBeGreaterThanOrEqual(2);
    expect(MOSS_GUIDE_PLUGIN_COPY.zhCN.defaultPrompt.length).toBeGreaterThanOrEqual(2);
  });

  it("bundles both capability-guide and plugin-discovery skills with valid frontmatter and marker", () => {
    expect(MOSS_GUIDE_SKILLS.map((skill) => skill.name)).toEqual([
      "moss-guide",
      "moss-plugin-discovery",
    ]);
    for (const skill of MOSS_GUIDE_SKILLS) {
      const markdown = mossGuideSkillMarkdown(skill);
      expect(markdown.startsWith(`---\nname: ${skill.name}\n`)).toBe(true);
      expect(markdown).toContain(MOSS_GUIDE_SKILL_MARKER);
    }
    expect(MOSS_GUIDE_HARNESS_DIRECTIVE).toContain("moss_search_plugins");
    expect(MOSS_GUIDE_HARNESS_DIRECTIVE).toContain("moss_suggest_plugins");
  });

  it("treats moss-guide as installed by default and uninstalled only when explicitly listed", () => {
    expect(isMossGuidePluginInstalled(undefined)).toBe(true);
    expect(isMossGuidePluginInstalled({ officialPlugins: { uninstalled: [] } })).toBe(true);
    expect(
      isMossGuidePluginInstalled({ officialPlugins: { uninstalled: ["other@moss-official"] } }),
    ).toBe(true);
    expect(
      isMossGuidePluginInstalled({ officialPlugins: { uninstalled: [MOSS_GUIDE_PLUGIN_ID] } }),
    ).toBe(false);
    expect(
      isMossGuidePluginInstalled({ officialPlugins: { uninstalled: [MOSS_GUIDE_PLUGIN_NAME] } }),
    ).toBe(false);
  });

  it("tracks active dismissed suggestions within the 7-day cooldown and updates cleanly", () => {
    const now = Date.parse("2026-11-26T12:00:00.000Z");
    const freshIso = new Date(now - 60_000).toISOString();
    const expiredIso = new Date(now - PLUGIN_SUGGESTION_DISMISS_COOLDOWN_MS - 1_000).toISOString();

    const active = activeDismissedSuggestionPluginIds(
      {
        officialPlugins: {
          dismissedSuggestions: [
            { pluginId: "gmail@moss-apps", dismissedAt: freshIso },
            { pluginId: "slack@moss-apps", dismissedAt: expiredIso },
            { pluginId: "bad@moss-apps", dismissedAt: "not-a-date" },
          ],
        },
      },
      now,
    );
    expect(Array.from(active)).toEqual(["gmail@moss-apps"]);

    const added = upsertDismissedPluginSuggestion(
      [{ pluginId: "gmail@moss-apps", dismissedAt: expiredIso }],
      "gmail@moss-apps",
      true,
      freshIso,
    );
    expect(added).toEqual([{ pluginId: "gmail@moss-apps", dismissedAt: freshIso }]);

    const undone = upsertDismissedPluginSuggestion(added, "gmail@moss-apps", false, freshIso);
    expect(undone).toEqual([]);
    expect(MOSS_GUIDE_STARTER_PROMPTS.length).toBeGreaterThanOrEqual(3);
  });
});
