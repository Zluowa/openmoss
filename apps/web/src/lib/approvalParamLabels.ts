// FILE: approvalParamLabels.ts
// Purpose: Chinese names for the argument rows an approval card shows (Computer actions'
//          arguments above all), so a person reads 「应用 Finder」 rather than `app Finder`.
// Layer: Web chat presentation
// Why: approval rows carry the tool's own argument names; a row that names its own
//      `displayName` keeps it.

import type { MossLocaleCode } from "~/uiLocale";

const ZH_CN_APPROVAL_PARAM_LABELS: Readonly<Record<string, string>> = {
  action: "操作",
  amount: "数量",
  app: "应用",
  bundle_id: "应用 ID",
  button: "鼠标按键",
  delta_x: "横向滚动",
  delta_y: "纵向滚动",
  direction: "方向",
  element: "元素",
  element_index: "元素",
  height: "高度",
  input_route: "输入方式",
  items: "项目",
  key: "按键",
  keys: "按键",
  mode: "方式",
  path: "路径",
  pid: "进程",
  query: "查询",
  steps: "步骤",
  to_x: "终点横坐标",
  to_y: "终点纵坐标",
  url: "网址",
  width: "宽度",
  window_id: "窗口",
  x: "横坐标",
  y: "纵坐标",
  zoom: "缩放",
};

/** The label of an approval row: its own display name, else a known name in the UI language. */
export function approvalParamLabel(
  parameter: { readonly name: string; readonly displayName?: string },
  locale: MossLocaleCode,
): string {
  if (parameter.displayName) return parameter.displayName;
  return locale === "zh-CN"
    ? (ZH_CN_APPROVAL_PARAM_LABELS[parameter.name] ?? parameter.name)
    : parameter.name;
}
