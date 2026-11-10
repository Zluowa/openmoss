// FILE: readonlyAppItemCopy.ts
// Purpose: Owner and guest readonly-preview copy using the existing locale context.
// Layer: Web copy; mirrors the guest-page locale dictionary pattern

import type { MossLocaleCode } from "~/uiLocale";

const zh = {
  title: "应用页",
  invalid: "这个预览的内容或版本无效。",
  loading: "正在打开只读预览…",
  timeout: "预览未能打开，请重新打开。",
  expired: "预览授权已过期，请重新打开。",
  accessUnavailable: "目前无法确认访问权限，预览已关闭。",
  unavailable: "预览不可用",
  limit: "只读预览：不保存数据，不连接账号或其他能力",
  capability: {
    db: "数据（保存并共享）",
    ai: "AI 生成",
    downloads: "下载文件",
    user: "查看者身份",
    permissions: "权限",
  },
};
type Copy = {
  readonly [K in keyof typeof zh]: K extends "capability"
    ? Record<keyof typeof zh.capability, string>
    : string;
};
const en: Copy = {
  title: "App page",
  invalid: "This preview has invalid content or version information.",
  loading: "Opening read-only preview…",
  timeout: "The preview could not open. Please reopen it.",
  expired: "Preview access expired. Please reopen it.",
  accessUnavailable: "Access could not be confirmed. The preview has been closed.",
  unavailable: "Unavailable in preview",
  limit: "Read-only preview: no saved data, accounts or other capabilities",
  capability: {
    db: "Saved and shared data",
    ai: "AI generation",
    downloads: "File downloads",
    user: "Viewer identity",
    permissions: "Permissions",
  },
};
export const readonlyAppItemCopy = (locale: MossLocaleCode): Copy => (locale === "zh-CN" ? zh : en);
