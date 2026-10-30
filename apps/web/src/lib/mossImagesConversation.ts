import type { ComposerImageAttachment } from "../composerDraftStore";
import type { ModelSelection, ProviderSkillDescriptor } from "@synara/contracts";

export interface MossImagesConversationInput {
  readonly prompt: string;
  readonly modelSelection: ModelSelection;
  /** Only explicit legacy media intents select a model-specific Skill. */
  readonly modelId?: string;
  readonly references: readonly File[];
  readonly isCurrent: () => boolean;
}

const IMAGE_SKILLS: Readonly<Record<string, string>> = {
  "gpt-image-2-official": "moss-imagegen",
  "gpt-image-2.5-flare": "moss-imagegen",
  "gpt-image-2.5-sunburst": "moss-imagegen",
  "nano-banana-pro": "moss-nano-banana",
  "gemini-flash-image": "moss-nano-banana-2",
  "grok-imagine-image-2.0": "moss-grok-image",
  "wan2.7-image-pro": "moss-wan-image",
  "seedream-5-0": "moss-seedream",
};

export function mossImagesSkillName(modelId: string): string {
  const name = IMAGE_SKILLS[modelId];
  if (!name) throw new Error("此图像模型的 Skill 尚未就绪，请选择其他模型。");
  return name;
}

export async function resolveMossImagesConversationSkill(
  modelId: string | undefined,
  listSkills: () => Promise<readonly ProviderSkillDescriptor[]>,
): Promise<ProviderSkillDescriptor | undefined> {
  if (modelId === undefined) return undefined;
  const skillName = mossImagesSkillName(modelId);
  const skills = await listSkills();
  const selected = skills.find(
    (skill) =>
      skill.enabled && (skill.name === skillName || skill.name === `${skillName}:${skillName}`),
  );
  if (!selected) throw new Error("所选 CLI 的生图 Skill 尚未连接，请在插件中启用后发送。");
  return selected;
}

/** The normal composer owns uploads, promotion and the single turn dispatch. */
export function mossImagesConversationPrompt(input: MossImagesConversationInput, skill?: string) {
  return `${skill ? `$${skill}\n` : ""}${input.prompt.trim()}\n\n请使用当前 CLI 已连接且实际可用的图像生成工具或 Skill 生成图像，并保存在此会话的工作文件夹。完成时提供实际文件路径；工具不可用或调用失败时，明确说明原因并保留需求，不将占位图或代码绘图冒充模型生成结果。`;
}

/** A template's explicit ratio is part of the request sent to every CLI. */
export function mossImagesTemplatePrompt(prompt: string, aspectRatio: string): string {
  return aspectRatio === "auto"
    ? prompt.trim()
    : `${prompt.trim()}\n\n图像宽高比：${aspectRatio}。`;
}

export function mossImagesComposerAttachments(files: readonly File[]): ComposerImageAttachment[] {
  return files.map((file) => ({
    type: "image",
    id: crypto.randomUUID(),
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    previewUrl: URL.createObjectURL(file),
    file,
  }));
}
