// FILE: mossMediaPlugins.ts
// Purpose: One description of Moss's official image/video plugins and the
//          Canvas plugin: which models each covers and how it is named, in
//          English (the plugin manifest) and Simplified Chinese (the UI copy).
// Layer: Shared presentation data. The server writes the native plugins from
//        it; the web localizes and draws them from the same entries.

export type MossMediaPluginKind = "image" | "video" | "canvas";

export interface MossMediaPluginCopy {
  readonly displayName: string;
  readonly shortDescription: string;
  readonly longDescription: string;
  /** Composer text after the plugin chip; the person finishes the sentence. */
  readonly defaultPrompt: string;
}

export interface MossMediaPluginSpec {
  readonly name: string;
  readonly kind: MossMediaPluginKind;
  /** Model ids, default first. Canvas lists none. */
  readonly models: readonly string[];
  /** Installed once on a fresh Moss home; a later uninstall is respected. */
  readonly defaultInstalled: boolean;
  /** Covers every model of its kind rather than one vendor's. */
  readonly general: boolean;
  /** The model vendor a vendor skill covers. */
  readonly vendor?: { readonly en: string; readonly zhCN: string };
  readonly en: MossMediaPluginCopy;
  readonly zhCN: MossMediaPluginCopy;
}

export const MOSS_IMAGEGEN_PLUGIN_NAME = "moss-imagegen";
export const MOSS_VIDEOGEN_PLUGIN_NAME = "moss-videogen";
export const MOSS_CANVAS_PLUGIN_NAME = "moss-canvas";

/** Used whenever a person asks for an image or a video without naming a model. */
export const MOSS_DEFAULT_IMAGE_MODEL_ID = "gpt-image-2.5-flare";
export const MOSS_DEFAULT_VIDEO_MODEL_ID = "doubao-seedance-2.0-fast";

export const MOSS_IMAGE_MODEL_IDS = [
  "gpt-image-2.5-flare",
  "gpt-image-2.5-sunburst",
  "seedream-5-0",
  "nano-banana-pro",
  "gemini-flash-image",
  "grok-imagine-image-2.0",
  "wan2.7-image-pro",
] as const;

export const MOSS_VIDEO_MODEL_IDS = [
  "doubao-seedance-2.0-fast",
  "doubao-seedance-2.0",
  "doubao-seedance-2.5",
  "wan3.0-video",
  "wan3.0-video-prime",
  "happyhorse",
  "happyhorse-video-edit",
  "kling-v3-omni",
  "MiniMax-H3",
  "MiniMax-H3-Max",
] as const;

/** How each model is named: English as the gateway catalog labels it, and in Chinese. */
export const MOSS_MEDIA_MODEL_NAMES: Readonly<
  Record<string, { readonly en: string; readonly zhCN: string }>
> = {
  "gpt-image-2.5-flare": { en: "GPT Image 2.5 Flare", zhCN: "GPT Image 2.5 Flare" },
  "gpt-image-2.5-sunburst": { en: "GPT Image 2.5 Sunburst", zhCN: "GPT Image 2.5 Sunburst" },
  "seedream-5-0": { en: "Seedream 5.0 Pro", zhCN: "即梦 Seedream 5.0 Pro" },
  "nano-banana-pro": { en: "Nano Banana Pro", zhCN: "Nano Banana Pro" },
  "gemini-flash-image": { en: "Nano Banana 2", zhCN: "Nano Banana 2" },
  "grok-imagine-image-2.0": { en: "Grok Imagine 2.0", zhCN: "Grok Imagine 2.0" },
  "wan2.7-image-pro": { en: "Wan 2.7 Image Pro", zhCN: "万相 2.7 Pro" },
  "doubao-seedance-2.0-fast": { en: "Seedance 2.0 Fast", zhCN: "即梦 Seedance 2.0 Fast" },
  "doubao-seedance-2.0": { en: "Seedance 2.0", zhCN: "即梦 Seedance 2.0" },
  "doubao-seedance-2.5": { en: "Seedance 2.5", zhCN: "即梦 Seedance 2.5" },
  "wan3.0-video": { en: "Wan 3.0", zhCN: "万相 3.0" },
  "wan3.0-video-prime": { en: "Wan 3.0 Prime", zhCN: "万相 3.0 Prime" },
  happyhorse: { en: "HappyHorse 1.1", zhCN: "HappyHorse 1.1" },
  "happyhorse-video-edit": { en: "HappyHorse Video Edit", zhCN: "HappyHorse 视频编辑" },
  "kling-v3-omni": { en: "Kling O3", zhCN: "可灵 O3" },
  "MiniMax-H3": { en: "MiniMax H3", zhCN: "MiniMax H3" },
  "MiniMax-H3-Max": { en: "MiniMax H3 Max", zhCN: "MiniMax H3 Max" },
};

export function mossMediaModelName(modelId: string, locale: "en" | "zhCN" = "zhCN"): string {
  return MOSS_MEDIA_MODEL_NAMES[modelId]?.[locale] ?? modelId;
}

const IMAGE_PROMPT = { en: "Generate an image: ", zhCN: "生成一张图片：" } as const;
const VIDEO_PROMPT = { en: "Generate a video: ", zhCN: "生成一段视频：" } as const;

/** Joins Chinese text and a Latin brand with the customary space between them. */
export function joinZhText(...parts: readonly string[]): string {
  return parts.reduce((text, part) => {
    if (!text) return part;
    const latinEdge = /[A-Za-z0-9]$/u.test(text) || /^[A-Za-z0-9]/u.test(part);
    const cjkEdge = /[\u3400-\u9fff]$/u.test(text) || /^[\u3400-\u9fff]/u.test(part);
    return latinEdge && cjkEdge ? `${text} ${part}` : `${text}${part}`;
  }, "");
}

function vendorImage(input: {
  readonly name: string;
  readonly models: readonly string[];
  readonly en: string;
  readonly zhCN: string;
  readonly vendorZhCN: string;
}): MossMediaPluginSpec {
  return {
    name: input.name,
    kind: "image",
    models: input.models,
    defaultInstalled: false,
    general: false,
    vendor: { en: input.en, zhCN: input.vendorZhCN },
    en: {
      displayName: input.en,
      shortDescription: `Create and edit images with ${input.en} models`,
      longDescription: `Create and edit images with ${input.en} models on your Moss account. Each model's cost in Moss credits is listed in the skill.`,
      defaultPrompt: IMAGE_PROMPT.en,
    },
    zhCN: {
      displayName: input.zhCN,
      shortDescription: joinZhText("用", input.vendorZhCN, "模型生成和编辑图片"),
      longDescription: joinZhText(
        "用 Moss 账号调用",
        input.vendorZhCN,
        "模型生成和编辑图片，技能里列出了每个模型消耗的 Moss 积分。",
      ),
      defaultPrompt: IMAGE_PROMPT.zhCN,
    },
  };
}

function vendorVideo(input: {
  readonly name: string;
  readonly models: readonly string[];
  readonly en: string;
  readonly zhCN: string;
  readonly vendorEn: string;
  readonly vendorZhCN: string;
}): MossMediaPluginSpec {
  return {
    name: input.name,
    kind: "video",
    models: input.models,
    defaultInstalled: false,
    general: false,
    vendor: { en: input.vendorEn, zhCN: input.vendorZhCN },
    en: {
      displayName: input.en,
      shortDescription: `Create videos with ${input.vendorEn} models`,
      longDescription: `Create videos with ${input.vendorEn} models on your Moss account. Each model's cost in Moss credits is listed in the skill.`,
      defaultPrompt: VIDEO_PROMPT.en,
    },
    zhCN: {
      displayName: input.zhCN,
      shortDescription: joinZhText("用", input.vendorZhCN, "模型生成视频"),
      longDescription: joinZhText(
        "用 Moss 账号调用",
        input.vendorZhCN,
        "模型生成视频，技能里列出了每个模型消耗的 Moss 积分。",
      ),
      defaultPrompt: VIDEO_PROMPT.zhCN,
    },
  };
}

/** Listed in the order Moss presents them: the general skills, Canvas, then each vendor. */
export const MOSS_MEDIA_PLUGINS: readonly MossMediaPluginSpec[] = [
  {
    name: MOSS_IMAGEGEN_PLUGIN_NAME,
    kind: "image",
    models: MOSS_IMAGE_MODEL_IDS,
    defaultInstalled: true,
    general: true,
    en: {
      displayName: "Image Generation",
      shortDescription: "Create and edit images with every Moss image model",
      longDescription:
        "Create and edit images on your Moss account. Uses GPT Image 2.5 unless you name another model; covers every image model in Moss Canvas, with each model's cost in Moss credits.",
      defaultPrompt: IMAGE_PROMPT.en,
    },
    zhCN: {
      displayName: "生图",
      shortDescription: "用 Moss 的全部图像模型生成和编辑图片",
      longDescription:
        "用 Moss 账号生成和编辑图片。默认使用 GPT Image 2.5，也可以指定其他模型；覆盖 Moss 画布里的全部图像模型，并列出每个模型消耗的 Moss 积分。",
      defaultPrompt: IMAGE_PROMPT.zhCN,
    },
  },
  {
    name: MOSS_VIDEOGEN_PLUGIN_NAME,
    kind: "video",
    models: MOSS_VIDEO_MODEL_IDS,
    defaultInstalled: true,
    general: true,
    en: {
      displayName: "Video Generation",
      shortDescription: "Create videos with every Moss video model",
      longDescription:
        "Create videos on your Moss account. Uses Seedance 2.0 Fast unless you name another model; covers every video model in Moss Canvas, with each model's cost in Moss credits.",
      defaultPrompt: VIDEO_PROMPT.en,
    },
    zhCN: {
      displayName: "生视频",
      shortDescription: "用 Moss 的全部视频模型生成视频",
      longDescription:
        "用 Moss 账号生成视频。默认使用即梦 Seedance 2.0 Fast，也可以指定其他模型；覆盖 Moss 画布里的全部视频模型，并列出每个模型消耗的 Moss 积分。",
      defaultPrompt: VIDEO_PROMPT.zhCN,
    },
  },
  {
    name: MOSS_CANVAS_PLUGIN_NAME,
    kind: "canvas",
    models: [],
    defaultInstalled: true,
    general: false,
    en: {
      displayName: "Moss Canvas",
      shortDescription: "Lay out and edit this conversation's images on a canvas",
      longDescription:
        "Open Moss Canvas, the board where this conversation's generated images and videos are placed, to lay out, compare and edit them.",
      defaultPrompt: "Open Moss Canvas",
    },
    zhCN: {
      displayName: "Moss 画布",
      shortDescription: "在画布上排版、比较和编辑这段对话的图片",
      longDescription:
        "打开 Moss 画布：这段对话生成的图片和视频都会放在上面，可以排版、比较和继续编辑。",
      defaultPrompt: "打开 Moss 画布",
    },
  },
  vendorImage({
    name: "moss-gpt-image",
    models: ["gpt-image-2.5-flare", "gpt-image-2.5-sunburst"],
    en: "GPT Image",
    zhCN: "GPT Image 生图",
    vendorZhCN: "GPT Image",
  }),
  vendorImage({
    name: "moss-seedream",
    models: ["seedream-5-0"],
    en: "Seedream",
    zhCN: "即梦生图",
    vendorZhCN: "即梦 Seedream",
  }),
  vendorImage({
    name: "moss-nano-banana",
    models: ["nano-banana-pro", "gemini-flash-image"],
    en: "Nano Banana",
    zhCN: "Nano Banana 生图",
    vendorZhCN: "Nano Banana",
  }),
  vendorImage({
    name: "moss-grok-image",
    models: ["grok-imagine-image-2.0"],
    en: "Grok Imagine",
    zhCN: "Grok Imagine 生图",
    vendorZhCN: "Grok Imagine",
  }),
  vendorImage({
    name: "moss-wan-image",
    models: ["wan2.7-image-pro"],
    en: "Wan Image",
    zhCN: "万相生图",
    vendorZhCN: "万相",
  }),
  vendorVideo({
    name: "moss-seedance",
    models: ["doubao-seedance-2.0-fast", "doubao-seedance-2.0", "doubao-seedance-2.5"],
    en: "Seedance Video",
    zhCN: "即梦视频",
    vendorEn: "Seedance",
    vendorZhCN: "即梦 Seedance",
  }),
  vendorVideo({
    name: "moss-wan-video",
    models: ["wan3.0-video", "wan3.0-video-prime"],
    en: "Wan Video",
    zhCN: "万相视频",
    vendorEn: "Wan",
    vendorZhCN: "万相",
  }),
  vendorVideo({
    name: "moss-happyhorse",
    models: ["happyhorse", "happyhorse-video-edit"],
    en: "HappyHorse Video",
    zhCN: "HappyHorse 视频",
    vendorEn: "HappyHorse",
    vendorZhCN: "HappyHorse",
  }),
  vendorVideo({
    name: "moss-kling",
    models: ["kling-v3-omni"],
    en: "Kling Video",
    zhCN: "可灵视频",
    vendorEn: "Kling",
    vendorZhCN: "可灵",
  }),
  vendorVideo({
    name: "moss-minimax-h3",
    models: ["MiniMax-H3", "MiniMax-H3-Max"],
    en: "MiniMax Video",
    zhCN: "MiniMax 视频",
    vendorEn: "MiniMax",
    vendorZhCN: "MiniMax",
  }),
];

const PLUGIN_BY_NAME = new Map(MOSS_MEDIA_PLUGINS.map((plugin) => [plugin.name, plugin]));

export function mossMediaPlugin(name: string | null | undefined): MossMediaPluginSpec | undefined {
  return name ? PLUGIN_BY_NAME.get(name.trim().toLowerCase()) : undefined;
}

/** Every plugin that lets an agent use this model: its vendor skill and the general one. */
export function mossMediaPluginsForModel(modelId: string): readonly string[] {
  return MOSS_MEDIA_PLUGINS.filter((plugin) => plugin.models.includes(modelId)).map(
    (plugin) => plugin.name,
  );
}

/**
 * The SKILL.md description: agents read the English one to pick the skill,
 * people read it in the skills list (translated in the zh-CN UI).
 */
export function mossMediaSkillDescription(
  plugin: MossMediaPluginSpec,
  locale: "en" | "zhCN" = "en",
): string {
  const names = plugin.models.map((id) => mossMediaModelName(id, locale));
  if (locale === "zhCN") {
    const what = plugin.kind === "image" ? "生成或编辑图片" : "生成视频";
    return plugin.general
      ? joinZhText(
          "用 Moss ",
          what,
          `，对方没指定模型时也用它。覆盖全部${plugin.kind === "image" ? "图像" : "视频"}模型（${names.join("、")}），默认`,
          names[0] ?? "",
          "。费用从 Moss 积分扣除。",
        )
      : joinZhText(
          "用",
          plugin.vendor?.zhCN ?? plugin.zhCN.displayName,
          "模型",
          what,
          `：${names.join("、")}。费用从 Moss 积分扣除。`,
        );
  }
  const what = plugin.kind === "image" ? "Create or edit images" : "Create videos";
  return plugin.general
    ? `${what} with Moss, for any ${plugin.kind} request even when no model is named. Covers every Moss ${plugin.kind} model (${names.join(", ")}); default ${names[0]}. Charged to the person's Moss credits.`
    : `${what} with ${plugin.vendor?.en ?? plugin.en.displayName} models on Moss: ${names.join(", ")}. Charged to the person's Moss credits.`;
}

export const MOSS_CANVAS_SKILL_DESCRIPTION = {
  en: "Open and read Moss Canvas (画布), the board where this conversation's generated images and videos are placed. Use it whenever the person asks to open, show or use Canvas/画布, or to lay out or edit an image there.",
  zhCN: "打开和查看 Moss 画布：这段对话生成的图片和视频都放在上面。对方要打开、查看或使用画布，或在画布上排版、编辑图片时使用。",
} as const;

/** Retired official plugins whose models a current plugin now covers. */
export const RETIRED_MOSS_MEDIA_PLUGIN_NAMES = ["moss-nano-banana-2"] as const;

/** English manifest copy → Simplified Chinese, for the zh-CN UI. */
const COPY_FIELDS = [
  "displayName",
  "shortDescription",
  "longDescription",
  "defaultPrompt",
] as const;

export const MOSS_MEDIA_PLUGIN_ZH_CN_COPY: Readonly<Record<string, string>> = Object.fromEntries(
  MOSS_MEDIA_PLUGINS.flatMap((plugin): ReadonlyArray<readonly [string, string]> => {
    const skill: readonly [string, string] =
      plugin.kind === "canvas"
        ? [MOSS_CANVAS_SKILL_DESCRIPTION.en, MOSS_CANVAS_SKILL_DESCRIPTION.zhCN]
        : [mossMediaSkillDescription(plugin, "en"), mossMediaSkillDescription(plugin, "zhCN")];
    return COPY_FIELDS.map(
      (field) => [plugin.en[field].trim(), plugin.zhCN[field].trim()] as const,
    ).concat([skill]);
  }),
);
