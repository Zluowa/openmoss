// FILE: zhCNMossMediaPluginsCopy.ts
// Purpose: Simplified Chinese for Moss's own image, video and Canvas plugins: their names,
//          descriptions, example prompts and skill descriptions as the plugin page and the
//          skills list show them. The manifests stay English for the English UI.
// Layer: Pure localization data, from the same entries the server writes the plugins from.

import { MOSS_MEDIA_PLUGIN_ZH_CN_COPY } from "@moss/shared/mossMediaPlugins";

import { lookupPhrase, phraseTranslator } from "./zhCNPhraseTable";

const LEGACY_MOSS_MEDIA_PLUGIN_COPY: Readonly<Record<string, string>> = {
  // Copy shipped by 1.0.3 and earlier, still on disk until the next start rewrites it.
  "Moss Images": "生图",
  "Generate images with your Moss account": "用 Moss 账号生成图片",
  "Generate videos with your Moss account": "用 Moss 账号生成视频",
  "Lay out and edit images on a canvas": "在画布上排版和编辑图片",
  "Use Moss Images to create or edit an image.": "用 Moss 生成或编辑一张图片：",
  "Open this image in Moss Canvas.": "打开 Moss 画布",
};

export const translateZhCnMossMediaPluginsText = phraseTranslator({
  ...LEGACY_MOSS_MEDIA_PLUGIN_COPY,
  ...MOSS_MEDIA_PLUGIN_ZH_CN_COPY,
});

/** A Moss media plugin's example prompt, in the language the person reads the UI in. */
export function localizeMossMediaPluginPrompt(prompt: string, locale: "en" | "zh-CN"): string {
  if (locale !== "zh-CN") return prompt;
  return (
    lookupPhrase(MOSS_MEDIA_PLUGIN_ZH_CN_COPY, prompt.trim()) ??
    lookupPhrase(LEGACY_MOSS_MEDIA_PLUGIN_COPY, prompt.trim()) ??
    prompt
  );
}
