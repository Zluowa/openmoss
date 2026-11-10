// FILE: templates.ts
// Purpose: Built-in 从模板开始 templates for every creatable kind (page, slides, sheet, app),
//          and the shape both built-in and personal templates share.
// Layer: Shared model (web gallery lists them; server instantiates them, including for agents)

import { KPI_DASHBOARD_HTML, POLL_SIGNUP_HTML, TRACKER_HTML } from "./appTemplateHtml";
import type { AppItem } from "./itemData";
import type { SheetCell, SheetWorkbook } from "./sheetWorkbook";
import { DECK_TEMPLATES, deckTemplateData } from "./deckTemplates";

export const TEMPLATE_KINDS = ["page", "slides", "sheet", "app"] as const;
export type TemplateKind = (typeof TEMPLATE_KINDS)[number];
export const TEMPLATE_CATEGORIES = ["工作", "规划", "数据", "仪表盘", "活动"] as const;
export type TemplateCategory = (typeof TEMPLATE_CATEGORIES)[number];

export interface SpaceTemplateDefinition {
  /** `builtin:<slug>` for Moss templates; personal templates use their stored id. */
  readonly id: string;
  readonly kind: TemplateKind;
  readonly title: string;
  readonly description: string;
  readonly category: TemplateCategory;
  /** Page body (Markdown) for page templates. */
  readonly content?: string;
  /** Typed payload JSON for slides/sheet/app templates. */
  readonly data?: string;
}

/** `formats` maps a column index to a number format for its body rows (`0.0%`, `#,##0`). */
function grid(
  rows: readonly (readonly (string | number | null)[])[],
  formats: Readonly<Record<number, string>> = {},
  bold = 1,
): SheetCell[] {
  const cells: SheetCell[] = [];
  rows.forEach((row, r) =>
    row.forEach((value, c) => {
      if (value === null || value === "") return;
      const formula = typeof value === "string" && value.startsWith("=");
      cells.push({
        r,
        c,
        v: formula ? null : value,
        ...(formula ? { f: value } : {}),
        ...(r < bold
          ? { s: { bold: true, fill: "#EEF4F1" } }
          : formats[c]
            ? { s: { format: formats[c]! } }
            : {}),
      });
    }),
  );
  return cells;
}
function workbook(
  name: string,
  rows: Parameters<typeof grid>[0],
  widths?: Record<string, number>,
  formats?: Readonly<Record<number, string>>,
): string {
  return JSON.stringify({
    version: 1,
    sheets: [
      {
        id: "sheet1",
        name,
        cells: grid(rows, formats),
        ...(widths ? { columnWidths: widths } : {}),
        frozenRows: 1,
      },
    ],
  } satisfies SheetWorkbook);
}
function app(html: string, capabilities: AppItem["capabilities"]): string {
  return JSON.stringify({ version: 1, html, capabilities } satisfies AppItem);
}

export const BUILT_IN_TEMPLATES: readonly SpaceTemplateDefinition[] = [
  {
    id: "builtin:meeting-notes",
    kind: "page",
    title: "会议纪要",
    description: "议程、讨论要点、决定和待办",
    category: "工作",
    content:
      "## 基本信息\n\n- 时间：\n- 参会人：\n\n## 议程\n\n1. \n\n## 讨论要点\n\n- \n\n## 决定\n\n- \n\n## 待办\n\n- [ ] 事项 · 负责人 · 截止日期\n",
  },
  {
    id: "builtin:project-brief",
    kind: "page",
    title: "项目简介",
    description: "背景、目标、范围、里程碑和风险",
    category: "规划",
    content:
      "## 背景\n\n\n## 目标\n\n- \n\n## 范围\n\n**包含：**\n\n- \n\n**不包含：**\n\n- \n\n## 里程碑\n\n| 阶段 | 日期 | 负责人 |\n| --- | --- | --- |\n| 启动 |  |  |\n| 交付 |  |  |\n\n## 风险\n\n- \n",
  },
  ...DECK_TEMPLATES.map(
    (template): SpaceTemplateDefinition => ({
      id: template.id,
      kind: "slides",
      title: template.title,
      description: template.description,
      category: template.category,
      data: deckTemplateData(template),
    }),
  ),
  {
    id: "builtin:budget-sheet",
    kind: "sheet",
    title: "预算表",
    description: "按类别汇总预算、实际和差额，含公式",
    category: "数据",
    data: workbook(
      "预算",
      [
        ["类别", "预算", "实际", "差额", "执行率"],
        ["人员", 120000, 112500, "=B2-C2", "=C2/B2"],
        ["市场", 45000, 51200, "=B3-C3", "=C3/B3"],
        ["设备", 30000, 18600, "=B4-C4", "=C4/B4"],
        ["差旅", 12000, 9400, "=B5-C5", "=C5/B5"],
        ["合计", "=SUM(B2:B5)", "=SUM(C2:C5)", "=B6-C6", "=C6/B6"],
      ],
      { "0": 120, "1": 110, "2": 110, "3": 110, "4": 90 },
      { 4: "0.0%" },
    ),
  },
  {
    id: "builtin:task-sheet",
    kind: "sheet",
    title: "任务清单",
    description: "事项、负责人、状态、截止日期",
    category: "工作",
    data: workbook(
      "任务",
      [
        ["事项", "负责人", "状态", "截止日期", "备注"],
        ["确定范围", "", "进行中", "", ""],
        ["整理需求", "", "未开始", "", ""],
        ["完成数", "", '=COUNTIF(C2:C20,"已完成")', "", ""],
      ],
      { "0": 200, "1": 100, "2": 100, "3": 110, "4": 200 },
    ),
  },
  {
    id: "builtin:kpi-dashboard",
    kind: "app",
    title: "KPI 仪表盘",
    description: "指标卡片和趋势图，可编辑数据",
    category: "仪表盘",
    data: app(KPI_DASHBOARD_HTML, ["db"]),
  },
  {
    id: "builtin:tracker",
    kind: "app",
    title: "跟踪表",
    description: "多人共同维护的事项表，可按状态筛选",
    category: "仪表盘",
    data: app(TRACKER_HTML, ["db"]),
  },
  {
    id: "builtin:poll-signup",
    kind: "app",
    title: "投票与报名",
    description: "选时间投票，登记参加人数",
    category: "活动",
    data: app(POLL_SIGNUP_HTML, ["db", "user"]),
  },
];

export const findBuiltInTemplate = (id: string) =>
  BUILT_IN_TEMPLATES.find((template) => template.id === id);
