import { MOSS_MEDIA_PLUGINS, mossMediaSkillDescription } from "@moss/shared/mossMediaPlugins";
import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

describe("Moss media plugin copy in zh-CN", () => {
  it("shows every official image, video and Canvas plugin in Chinese", () => {
    for (const plugin of MOSS_MEDIA_PLUGINS) {
      expect(translateZhCnPresentationText(plugin.en.displayName)).toBe(plugin.zhCN.displayName);
      expect(translateZhCnPresentationText(plugin.en.shortDescription)).toBe(
        plugin.zhCN.shortDescription,
      );
      if (plugin.kind !== "canvas")
        expect(translateZhCnPresentationText(mossMediaSkillDescription(plugin))).toBe(
          mossMediaSkillDescription(plugin, "zhCN"),
        );
    }
    expect(translateZhCnPresentationText("Image Generation")).toBe("生图");
    expect(translateZhCnPresentationText("Video Generation")).toBe("生视频");
    expect(translateZhCnPresentationText("Seedance Video")).toBe("即梦视频");
    expect(translateZhCnPresentationText("Create videos with Seedance models")).toBe(
      "用即梦 Seedance 模型生成视频",
    );
    // What 1.0.3 wrote to disk, until the next start rewrites it.
    expect(translateZhCnPresentationText("Generate images with your Moss account")).toBe(
      "用 Moss 账号生成图片",
    );
  });
});
