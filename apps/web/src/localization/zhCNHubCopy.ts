// FILE: zhCNHubCopy.ts
// Purpose: Simplified Chinese for hub settings, the library panel, the project panel and the names
//          in the project and hub appearance pickers.
// Layer: Pure localization data
// The appearance names are ordinary words a project or folder can also be called, so they are not
// part of the chain. `zhCN.ts` applies them only on a picker's own buttons.

import { phraseTranslator } from "./zhCNPhraseTable";

/** Elements whose label names an appearance option rather than something the person named. */
export const APPEARANCE_OPTION_SELECTOR =
  "[data-project-icon], [data-project-color], [data-appearance-option]";

export const APPEARANCE_OPTION_NAMES: Readonly<Record<string, string>> = {
  // Project icons
  Folder: "文件夹",
  Money: "金钱",
  Book: "书籍",
  Education: "教育",
  Writing: "写作",
  Pen: "羽毛笔",
  Code: "代码",
  Terminal: "终端",
  Music: "音乐",
  Movies: "电影",
  Design: "设计",
  Art: "艺术",
  Health: "健康",
  Medicine: "医药",
  Wellness: "身心健康",
  Work: "工作",
  Analytics: "数据分析",
  Fitness: "健身",
  Notes: "笔记",
  Law: "法律",
  Globe: "地球仪",
  Travel: "旅行",
  Earth: "地球",
  Tools: "工具",
  Pets: "宠物",
  Science: "科学",
  Brain: "大脑",
  Heart: "爱心",
  Nature: "自然",
  Launch: "发布",
  Idea: "灵感",
  Star: "星标",
  Photo: "照片",
  Games: "游戏",
  Home: "主页",
  People: "人物",
  Bot: "机器人",
  Coffee: "咖啡",
  Shopping: "购物",
  Bugs: "缺陷",
  Server: "服务器",
  Puzzle: "拼图",
  Trophy: "奖杯",
  Goal: "目标",
  Place: "地点",
  Chat: "聊天",
  Calendar: "日历",
  Speed: "速度",

  // Hub icons
  Lightbulb: "灯泡",
  Flask: "烧瓶",
  Target: "靶心",
  Agents: "智能体",
  Zap: "闪电",
  "Fast mode": "快速模式",
  Blocks: "积木",
  Gift: "礼物",
  Bug: "虫子",
  Flag: "旗帜",

  // Colors
  Default: "默认",
  "Default color": "默认颜色",
  Red: "红色",
  Orange: "橙色",
  Yellow: "黄色",
  Amber: "琥珀色",
  Green: "绿色",
  Cyan: "青色",
  Blue: "蓝色",
  Purple: "紫色",
  Violet: "紫罗兰色",
  Pink: "粉色",
  Rose: "玫瑰色",
};

function appearanceName(name: string): string {
  return Object.hasOwn(APPEARANCE_OPTION_NAMES, name)
    ? (APPEARANCE_OPTION_NAMES[name] ?? name)
    : name;
}

const HUB_COPY: Readonly<Record<string, string>> = {
  // Hub settings
  "Set up your hub": "设置你的 Hub",
  "The outcome you want the coordinator to work toward.": "你希望协调者达成的结果。",
  Location: "位置",
  "Change…": "更改…",
  Execution: "执行",
  "Deleting...": "正在删除…",
  "Copy library path": "复制资料库路径",
  "Copied library path": "已复制资料库路径",
  "Copy hub folder path": "复制 Hub 文件夹路径",
  "Copied hub folder path": "已复制 Hub 文件夹路径",

  // Library
  Grid: "网格",
  Documents: "文档",
  History: "历史记录",
  Restored: "已恢复",
  "Date modified": "修改日期",

  // Hub memory
  "Like a CLAUDE.md: instructions and rules you write that every new thread reads and follows.":
    "类似 CLAUDE.md：由你编写的指令和规则，每个新对话都会读取并遵循。",

  // Project panel
  "Updating…": "正在更新…",
  "Coordinator is ready.": "协调者已就绪。",
  "Pin coordinator": "固定协调者",
  "Unpin coordinator": "取消固定协调者",
  "Project events": "项目事件",
  "On project events": "项目事件发生时",
  "Add a goal": "添加目标",
  "Write instructions": "编写指令",
};

export const translateZhCnHubCopyText = phraseTranslator(HUB_COPY, [
  // Hub settings
  [/^Hub icon color (.+)$/, ({ 1: name = "" }) => `Hub 图标颜色：${appearanceName(name)}`],
  [/^Assistant color (.+)$/, ({ 1: name = "" }) => `助手颜色：${appearanceName(name)}`],
  [/^Hub icon (.+)$/, ({ 1: name = "" }) => `Hub 图标：${appearanceName(name)}`],
  [/^Type (.+) to confirm$/, "输入 $1 以确认"],
  [
    /^"(.+)" has no threads, files, or linked repositories yet\. Deleting it removes the hub entirely — or keep it and finish setup later\.$/,
    "“$1”还没有对话、文件或关联的代码仓库。删除后这个 Hub 会被彻底移除；你也可以保留它，稍后再完成设置。",
  ],
  [/^Thread memory \((\d+)\)$/, "对话记忆（$1）"],
  [/^Not available for (.+)\.$/, "不适用于 $1。"],
  [/^Resume hub (.+)$/, "恢复 Hub $1"],
  [/^Work: (.+)$/, "工作项：$1"],

  // Library
  [/^Back to library from (.+)$/, "从 $1 返回资料库"],
  [/^History — (.+)$/, "历史记录 — $1"],
  [/^(.+) was restored from (\S+)\.$/, "已从 $2 恢复 $1。"],

  // Project panel
  [/^Blocked: (.+) — (.+)$/, "受阻：$1 — $2"],
  [/^(.+) - On project events$/, "$1 - 项目事件发生时"],
]);
