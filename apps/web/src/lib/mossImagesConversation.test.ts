import { SUPPORTED_PROVIDER_KINDS } from "@synara/contracts";
import { expect, it, vi } from "vitest";
import {
  mossImagesConversationPrompt,
  mossImagesSkillName,
  mossImagesTemplatePrompt,
  resolveMossImagesConversationSkill,
} from "./mossImagesConversation";

it("keeps the requested aspect ratio and selected CLI separate from the internal image Skill", () => {
  const prompt = mossImagesConversationPrompt(
    {
      prompt: "生成横向 16:9 的山间日出",
      modelSelection: { provider: "claudeAgent", model: "claude-sonnet-4-6" },
      modelId: "seedream-5-0",
      references: [],
      isCurrent: () => true,
    },
    mossImagesSkillName("seedream-5-0"),
  );
  expect(prompt).toContain("$moss-seedream\n生成横向 16:9 的山间日出");
  expect(prompt).toContain("此会话的工作文件夹");
  expect(prompt).not.toContain("1:1");
  expect(prompt).not.toContain("使用 Seedream");
});

it("lets the selected CLI choose tools without a hidden image model or forced Skill", () => {
  const prompt = mossImagesConversationPrompt({
    prompt: "  生成横向 16:9 的山间日出  ",
    modelSelection: { provider: "codex", model: "gpt-5.4" },
    references: [],
    isCurrent: () => true,
  });
  expect(prompt).toBe(
    "生成横向 16:9 的山间日出\n\n请使用当前 CLI 已连接且实际可用的图像生成工具或 Skill 生成图像，并保存在此会话的工作文件夹。完成时提供实际文件路径；工具不可用或调用失败时，明确说明原因并保留需求，不将占位图或代码绘图冒充模型生成结果。",
  );
  expect(prompt).not.toContain("$");
});

it.each(SUPPORTED_PROVIDER_KINDS)(
  "keeps %s image requests on its selected CLI and requires real output",
  (provider) => {
    const prompt = mossImagesConversationPrompt({
      prompt: mossImagesTemplatePrompt("为产品设计海报", "16:9"),
      modelSelection: { provider, instanceId: `${provider}_custom`, model: "selected-model" },
      references: [],
      isCurrent: () => true,
    });
    expect(prompt).toContain("为产品设计海报\n\n图像宽高比：16:9。");
    expect(prompt).toContain("当前 CLI 已连接且实际可用的图像生成工具或 Skill");
    expect(prompt).toContain("工具不可用或调用失败时，明确说明原因并保留需求");
    expect(prompt).toContain("实际文件路径");
    expect(prompt).not.toContain("$moss-");
    expect(prompt).not.toContain("1:1");
  },
);

it("does not invent a fixed ratio when a template uses automatic sizing", () => {
  expect(mossImagesTemplatePrompt("  按照参考图设计产品照  ", "auto")).toBe("按照参考图设计产品照");
});

it("does not query or require a model-specific Skill for an ordinary CLI entry", async () => {
  const listSkills = vi.fn(async () => []);
  expect(await resolveMossImagesConversationSkill(undefined, listSkills)).toBeUndefined();
  expect(listSkills).not.toHaveBeenCalled();
});

it("still validates enabled Skills for an explicit legacy model intent", async () => {
  const disabled = { name: "moss-seedream", path: "/skills/seedream", enabled: false };
  const enabled = { ...disabled, name: "moss-seedream:moss-seedream", enabled: true };
  const listSkills = vi.fn(async () => [disabled, enabled]);
  expect(await resolveMossImagesConversationSkill("seedream-5-0", listSkills)).toEqual(enabled);
  expect(listSkills).toHaveBeenCalledTimes(1);
  await expect(
    resolveMossImagesConversationSkill("seedream-5-0", async () => [disabled]),
  ).rejects.toThrow("Skill 尚未连接");
});
