// Moss-owned portable media workflows. Model access, prices, and provider keys
// are decided by the authenticated gateway, never by a downloaded skill. The
// skill text is what a person reads in the skill preview, so it is written in
// Simplified Chinese; the agent answers in the person's own language.
import {
  MOSS_IMAGEGEN_PLUGIN_NAME,
  MOSS_MEDIA_PLUGINS,
  MOSS_VIDEOGEN_PLUGIN_NAME,
  joinZhText,
  mossMediaModelName,
  mossMediaSkillDescription,
  type MossMediaPluginSpec,
} from "@moss/shared/mossMediaPlugins";
import {
  MOSS_DEFAULT_IMAGE_MODEL_ID,
  MOSS_DEFAULT_VIDEO_MODEL_ID,
  MOSS_MEDIA_CREDITS_PER_CNY,
  MOSS_MEDIA_REFERENCE_USD_CNY,
  mossMediaModel,
  mossMediaModelExample,
  mossMediaModelPrice,
} from "./mossMediaModelCatalog";

export const MOSS_BUNDLED_IMAGEGEN_PLUGIN_NAME = MOSS_IMAGEGEN_PLUGIN_NAME;
export const MOSS_BUNDLED_VIDEOGEN_PLUGIN_NAME = MOSS_VIDEOGEN_PLUGIN_NAME;

export type MossBundledMediaPlugin = MossMediaPluginSpec & { readonly kind: "image" | "video" };

/** The image and video plugins; the Canvas plugin has its own workflow. */
export const MOSS_BUNDLED_MEDIA_PLUGINS: readonly MossBundledMediaPlugin[] =
  MOSS_MEDIA_PLUGINS.filter(
    (plugin): plugin is MossBundledMediaPlugin =>
      plugin.kind === "image" || plugin.kind === "video",
  );

function escapeCell(value: string): string {
  return value.replaceAll("|", "\\|").replaceAll("\n", " ");
}

function modelTable(plugin: MossBundledMediaPlugin, defaultModelId: string): string {
  const rows = plugin.models.map((id) => {
    const model = mossMediaModel(id);
    const name = mossMediaModelName(id);
    const price = mossMediaModelPrice(id) ?? "以 moss_media_list 返回为准";
    const example = mossMediaModelExample(id);
    const note = [model?.note, example ? `例：${example}。` : ""].filter(Boolean).join(" ");
    return `| ${escapeCell(id === defaultModelId ? `${name}（默认）` : name)} | \`${id}\` | ${escapeCell(price)} | ${escapeCell(note)} |`;
  });
  return [
    "| 模型 | 模型 ID | 参考价（Moss 积分） | 说明 |",
    "| --- | --- | --- | --- |",
    ...rows,
  ].join("\n");
}

const IMAGE_RULES = [
  "编辑图片时，先在 `moss_media_list` 里确认模型 `supportsReferences` 为 true。把原图的 HTTPS 地址放进 `referenceImages`，或把工作文件夹里的本地图片路径放进 `referencePaths`（不需要 base64）。说清楚改哪里、保留哪里。",
  "局部擦除或透明背景只在模型 `supportsMaskEdits` / `supportsTransparentBackground` 为 true 时使用。",
];

const VIDEO_RULES = [
  "先看 `moss_media_list` 里的参考能力。万相 3.0、即梦 Seedance 2.5、MiniMax H3/H3 Max 支持首尾帧或多模态参考，两种方式不能混用；HappyHorse 支持一张首帧或参考图；改写已有视频用 `happyhorse-video-edit`，并提供 `sourceVideoUrl`、`sourceVideoDuration`，不要再传 `duration`。",
  "传 `referenceVideos` / `referenceAudios` 时同时给出对应的时长数组。遵守每个模型的数量与时长上限；不要丢掉对方给的素材，也不要把编辑悄悄变成纯文字生成。",
  "视频通常要几分钟。生成期间告诉对方大致进度，不要重复提交。",
];

/** One SKILL.md: what the skill covers, every model with its credit cost, and how to run it. */
export function buildMossBundledMediaSkill(plugin: MossBundledMediaPlugin): string {
  const defaultModelId = plugin.general
    ? plugin.kind === "image"
      ? MOSS_DEFAULT_IMAGE_MODEL_ID
      : MOSS_DEFAULT_VIDEO_MODEL_ID
    : plugin.models[0]!;
  const defaultName = mossMediaModelName(defaultModelId);
  const noun = plugin.kind === "image" ? "图片" : "视频";
  const generalSkill = plugin.kind === "image" ? "生图" : "生视频";
  const scope = plugin.general
    ? `这个技能覆盖 Moss 画布里的全部${plugin.kind === "image" ? "图像" : "视频"}模型。对方没有指定模型时用默认模型「${defaultName}」；对方点名某个模型（名称或模型 ID 都算）时就用那个模型。对方没有选技能、只是说想要${noun}，也按这个技能完成。`
    : `${joinZhText("这个技能只用于", plugin.vendor?.zhCN ?? plugin.zhCN.displayName, "的模型")}，默认用「${defaultName}」。对方想用其他厂商的模型时，改用「${generalSkill}」技能。`;
  return `---
name: ${plugin.name}
description: ${mossMediaSkillDescription(plugin)}
---

# ${plugin.zhCN.displayName}

用对方的 Moss 账号${plugin.kind === "image" ? "生成或编辑图片" : "生成视频"}，费用从对方的 Moss 积分里扣除。${scope}

## 模型与价格

${modelTable(plugin, defaultModelId)}

${MOSS_MEDIA_CREDITS_PER_CNY} 积分 = 1 元。表中是参考价，美元计价的模型按 1 美元 ≈ ${MOSS_MEDIA_REFERENCE_USD_CNY} 元折算；实际按每次生成的真实成本和当天汇率从 Moss 积分里扣除，以账单为准。

## 怎么做

1. 用对方说话的语言回复：对方写中文就用中文，写英文就用英文。
2. 选模型：对方点名的模型优先，否则用 \`${defaultModelId}\`。不要为了挑模型反问对方，直接开始。
3. 普通请求直接用所选模型生成。需查看可用模型或价格时调用 \`moss_media_list\`。模型不可用时说明原因，经对方同意后再换。
4. 调用 \`moss_media_generate\`：传 modelId、prompt（保留对方描述的主体、构图、风格、比例和参考意图）、为这次请求新建的 idempotencyKey，以及需要的参考素材、aspectRatio、resolution${plugin.kind === "video" ? "、duration" : ""}。
5. ${plugin.kind === "image" ? "这次调用会等图片生成：对方在聊天里先看到占位图，完成后原位换成成品图。结果提示还在生成时，用同一个 jobId 调用 `moss_media_get` 继续等。结果提示图片已显示时，图片已经在聊天里：不要说“已提交”“正在后台生成”“稍后会显示”，最多回一句简短的话。不要用 shell sleep 或命令等待。" : "记下返回的 jobId，大约每 15 秒用 moss_media_get 查询一次，直到完成。"}
6. ${plugin.kind === "image" ? "图片完成后由 Moss 显示在对话里。" : "完成后在对话里展示结果。"}不要用 Markdown 重复贴出，也不要为普通生成打开画布。只有对方要求打开画布或在画布上编辑时，调用 \`moss_canvas_open\` 并传入 jobId。

## 规则

${(plugin.kind === "image" ? IMAGE_RULES : VIDEO_RULES).map((rule) => `- ${rule}`).join("\n")}
- 超时、断线、HTTP 5xx 或结果不确定时，不要重新提交（可能重复扣费），用原来的 jobId 继续查询。只有对方提出新的生成时才使用新的 idempotencyKey。
- 只报告服务端返回的费用和状态，不要自己估算退款或换算。
- 工具不存在，或返回未登录、积分不足、模型不可用等错误时，用对方的语言简单说明，并请对方在 Moss 里处理（例如登录账号或充值积分）。不要索要任何 API Key，也不要读取本机的凭据或环境变量。
`;
}
