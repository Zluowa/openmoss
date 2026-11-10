import type { ProviderPluginDescriptor, ProviderSkillDescriptor } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  localizeMossMediaPlugin,
  localizeMossMediaPluginsResult,
  localizeMossMediaSkill,
} from "./mossMediaPluginPresentation";

const plugin = (name: string, marketplace = "moss-bundled"): ProviderPluginDescriptor =>
  ({
    id: `${name}@${marketplace}`,
    name,
    interface: {
      displayName: "Image Generation",
      shortDescription: "Create and edit images with every Moss image model",
      longDescription: "English",
      defaultPrompt: ["Generate an image: "],
    },
  }) as unknown as ProviderPluginDescriptor;

const skill = (name: string, path: string): ProviderSkillDescriptor => ({
  name,
  path,
  enabled: true,
  description: "English description",
});

describe("Moss media plugin presentation", () => {
  it("shows Moss's own media plugins in Chinese for the zh-CN UI only", () => {
    expect(localizeMossMediaPlugin(plugin("moss-imagegen"), "zh-CN").interface).toMatchObject({
      displayName: "生图",
      shortDescription: "用 Moss 的全部图像模型生成和编辑图片",
      defaultPrompt: ["生成一张图片："],
    });
    expect(localizeMossMediaPlugin(plugin("moss-seedance"), "zh-CN").interface).toMatchObject({
      displayName: "即梦视频",
      shortDescription: "用即梦 Seedance 模型生成视频",
    });
    expect(localizeMossMediaPlugin(plugin("moss-imagegen"), "en")).toEqual(plugin("moss-imagegen"));
    // A plugin of the same name from another marketplace keeps its own copy.
    expect(localizeMossMediaPlugin(plugin("moss-imagegen", "someone"), "zh-CN")).toEqual(
      plugin("moss-imagegen", "someone"),
    );
    const result = localizeMossMediaPluginsResult(
      {
        marketplaces: [
          { name: "moss-bundled", path: null, interface: null, plugins: [plugin("moss-canvas")] },
        ],
        marketplaceLoadErrors: [],
        remoteSyncError: null,
        featuredPluginIds: [],
      },
      "zh-CN",
    );
    expect(result.marketplaces[0]!.plugins[0]!.interface?.displayName).toBe("Moss 画布");
  });

  it("describes Moss media skills in Chinese, and leaves same-named user skills alone", () => {
    const bundled = localizeMossMediaSkill(
      skill(
        "moss-imagegen:moss-imagegen",
        "C:/home/plugins/cache/moss-bundled/moss-imagegen/skills/moss-imagegen/SKILL.md",
      ),
      "zh-CN",
    );
    expect(bundled.description).toContain("用 Moss 生成或编辑图片");
    expect(bundled.interface?.displayName).toBe("生图");
    const user = skill("moss-imagegen", "C:/Users/me/.agents/skills/moss-imagegen/SKILL.md");
    expect(localizeMossMediaSkill(user, "zh-CN")).toEqual(user);
  });
});
