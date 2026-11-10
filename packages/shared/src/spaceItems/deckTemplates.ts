// FILE: deckTemplates.ts
// Purpose: Moss's built-in slide templates for 从模板开始 and for agents (`template` argument of
//          moss_slides_create). Each one is an outline in a Moss theme, built into a v2 deck.
// Layer: Shared model

import { deckFromOutline, type DeckOutline } from "./deckOps";

export interface DeckTemplate {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly category: "工作" | "规划" | "数据" | "活动";
  readonly outline: DeckOutline;
}

export const DECK_TEMPLATES: readonly DeckTemplate[] = [
  {
    id: "builtin:weekly-report-deck",
    title: "周报汇报",
    description: "封面、本周进展、数据、下周计划",
    category: "工作",
    outline: {
      title: "本周工作汇报",
      subtitle: "团队名称 · 日期",
      theme: "paper",
      slides: [
        { title: "本周进展", bullets: ["完成的事项一", "完成的事项二", "正在推进的事项"] },
        {
          title: "关键数据",
          table: [
            ["指标", "本周", "上周", "变化"],
            ["指标 A", "120", "104", "+15%"],
            ["指标 B", "86%", "81%", "+5 pt"],
          ],
        },
        {
          title: "风险与需要的支持",
          left: "- 风险一\n- 风险二",
          right: "- 需要的支持",
          leftTitle: "风险",
          rightTitle: "支持",
        },
        { title: "下周计划", bullets: ["重点一", "重点二", "重点三"] },
      ],
      closing: "谢谢",
    },
  },
  {
    id: "builtin:pitch-deck",
    title: "项目提案",
    description: "问题、方案、计划和需要的决定",
    category: "规划",
    outline: {
      title: "项目提案",
      subtitle: "一句话说明这个项目",
      theme: "ink",
      sections: [
        {
          title: "为什么",
          slides: [{ title: "要解决的问题", bullets: ["现状", "影响", "为什么是现在"] }],
        },
        {
          title: "怎么做",
          slides: [
            { title: "方案", bullets: ["做什么", "不做什么", "如何衡量成功"] },
            {
              title: "计划与资源",
              leftTitle: "时间线",
              left: "- 第 1 阶段\n- 第 2 阶段",
              rightTitle: "需要",
              right: "- 人员\n- 预算",
            },
          ],
        },
      ],
      closing: "需要今天确认的决定",
    },
  },
  {
    id: "builtin:quarterly-review-deck",
    title: "季度回顾",
    description: "目标完成、数据趋势、经验和下季度重点",
    category: "数据",
    outline: {
      title: "季度回顾",
      subtitle: "第 _ 季度 · 团队名称",
      theme: "sea",
      sections: [
        {
          title: "结果",
          slides: [
            {
              title: "目标完成情况",
              table: [
                ["目标", "计划", "实际", "状态"],
                ["目标一", "100", "112", "达成"],
                ["目标二", "80%", "74%", "未达成"],
                ["目标三", "3 项", "3 项", "达成"],
              ],
            },
            { title: "做得好的", bullets: ["亮点一", "亮点二"] },
          ],
        },
        {
          title: "下一步",
          slides: [
            {
              title: "经验与改进",
              left: "- 继续保持",
              right: "- 需要改进",
              leftTitle: "保持",
              rightTitle: "改进",
            },
            { title: "下季度重点", bullets: ["重点一", "重点二", "重点三"] },
          ],
        },
      ],
    },
  },
  {
    id: "builtin:product-launch-deck",
    title: "产品发布",
    description: "一句话价值、用户问题、功能亮点、上线计划",
    category: "活动",
    outline: {
      title: "产品名称",
      subtitle: "一句话说明它为谁解决什么问题",
      theme: "sand",
      slides: [
        { quote: "用户最常说的一句抱怨，放在这里。", attribution: "来自用户访谈" },
        { title: "功能亮点", bullets: ["亮点一：一句话", "亮点二：一句话", "亮点三：一句话"] },
        { title: "产品截图", caption: "在这里说明截图里的关键点", layout: "image-caption" },
        {
          title: "上线计划",
          table: [
            ["阶段", "日期", "范围"],
            ["内测", "", ""],
            ["公开发布", "", ""],
          ],
        },
      ],
      closing: "现在就试试",
    },
  },
  {
    id: "builtin:training-deck",
    title: "培训课件",
    description: "学习目标、分章节讲解、练习和总结",
    category: "工作",
    outline: {
      title: "课程名称",
      subtitle: "讲师 · 时长",
      theme: "celadon",
      sections: [
        {
          title: "开始",
          slides: [{ title: "学习目标", bullets: ["学完能做到的事一", "学完能做到的事二"] }],
        },
        {
          title: "第一部分",
          slides: [
            { title: "核心概念", body: "用两三句话讲清楚这个概念。" },
            {
              title: "例子",
              left: "错误示范",
              right: "正确示范",
              leftTitle: "之前",
              rightTitle: "之后",
            },
          ],
        },
        {
          title: "练习",
          slides: [{ title: "动手练习", bullets: ["第 1 步", "第 2 步", "第 3 步"] }],
        },
      ],
      closing: "总结与提问",
    },
  },
  {
    id: "builtin:minimal-deck",
    title: "中文通用演示",
    description: "简洁留白，适合任何主题的汇报",
    category: "工作",
    outline: {
      title: "演示标题",
      subtitle: "在这里写下你的核心观点",
      theme: "graphite",
      slides: [
        { title: "目录", bullets: ["第一部分", "第二部分", "第三部分"] },
        { title: "核心观点", body: "一句话讲清楚，再用两三句话展开。" },
        { title: "对比", leftTitle: "现在", left: "- 要点", rightTitle: "目标", right: "- 要点" },
      ],
    },
  },
];

export const findDeckTemplate = (id: string) =>
  DECK_TEMPLATES.find((template) => template.id === id || template.title === id) ?? null;

/** Deck JSON for a template, with fresh ids each time it is used. */
export const deckTemplateData = (template: DeckTemplate): string =>
  JSON.stringify(deckFromOutline(template.outline));
