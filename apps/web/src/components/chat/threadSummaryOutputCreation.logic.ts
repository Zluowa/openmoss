// FILE: threadSummaryOutputCreation.logic.ts
// Purpose: Composer-only output creation prompts from thread summary.
// Layer: Pure presentation behavior

import type { ThreadSummaryOutputKind } from "./ThreadSummaryPanel";

const OUTPUT_PROMPTS_ZH_CN: Record<ThreadSummaryOutputKind, string> = {
  document:
    "使用 [@Documents](plugin://documents@openai-primary-runtime) 创建一个新文档。先问我它应该是什么主题。",
  presentation:
    "使用 [@Presentations](plugin://presentations@openai-primary-runtime) 创建一个新演示文稿。先问我它应该是什么主题。",
  spreadsheet:
    "使用 [@Spreadsheets](plugin://spreadsheets@openai-primary-runtime) 创建一个新电子表格。先问我它应该是什么主题。",
  site: "使用 [@Sites](plugin://sites@openai-bundled) 创建一个新网站。先问我它应该是什么主题。",
};

const OUTPUT_PROMPTS_EN: Record<ThreadSummaryOutputKind, string> = {
  document:
    "Create a new document with [@Documents](plugin://documents@openai-primary-runtime). Start by asking me what it should be about.",
  presentation:
    "Create a new presentation with [@Presentations](plugin://presentations@openai-primary-runtime). Start by asking me what it should be about.",
  spreadsheet:
    "Create a new spreadsheet with [@Spreadsheets](plugin://spreadsheets@openai-primary-runtime). Start by asking me what it should be about.",
  site: "Create a new site with [@Sites](plugin://sites@openai-bundled). Start by asking me what it should be about.",
};

function currentLocale(): string {
  return typeof navigator === "undefined" ? "en" : navigator.language;
}

export function createThreadSummaryOutputPrompt(
  kind: ThreadSummaryOutputKind,
  locale = currentLocale(),
): string {
  return locale.toLowerCase() === "zh-cn" ? OUTPUT_PROMPTS_ZH_CN[kind] : OUTPUT_PROMPTS_EN[kind];
}

export function appendThreadSummaryOutputPrompt(
  currentDraft: string,
  kind: ThreadSummaryOutputKind,
  locale = currentLocale(),
): string {
  const outputPrompt = createThreadSummaryOutputPrompt(kind, locale);
  const separator = currentDraft.length > 0 && !/\s$/u.test(currentDraft) ? " " : "";
  return `${currentDraft}${separator}${outputPrompt}`;
}
