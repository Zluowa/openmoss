// FILE: mossWords.ts
// Purpose: Words both the desktop and the phone show, written once: the reasoning effort levels
//          and the composer's placeholders. The desktop's dictionaries (apps/web
//          localization.tsx) and the phone's (apps/mobile src/i18n) read them from here.
// Layer: Shared pure data (no imports), so the phone app can import it through Metro.
// A phone wording that differs on purpose sits next to the desktop's, with the reason, never
// in a second dictionary.

export interface MossWord {
  readonly en: string;
  readonly zh: string;
  /** The phone's own wording, where its narrower layout needs a different one. */
  readonly phone?: { readonly en: string; readonly zh: string; readonly why: string };
}

/** Reasoning effort levels, by the provider's value. */
export const EFFORT_WORDS = {
  none: { en: "None", zh: "无" },
  minimal: { en: "Minimal", zh: "最少" },
  low: { en: "Low", zh: "低" },
  medium: {
    en: "Medium",
    zh: "中等",
    phone: { en: "Medium", zh: "中", why: "one character fits under a slider stop" },
  },
  high: { en: "High", zh: "高" },
  xhigh: { en: "Extra high", zh: "极高" },
  max: { en: "Max", zh: "最大" },
  ultra: { en: "Ultra", zh: "超高" },
} as const satisfies Record<string, MossWord>;

/** The composer's placeholders. */
export const COMPOSER_WORDS = {
  followUp: { en: "Ask for follow-up changes", zh: "输入后续修改" },
  followUpAttachments: {
    en: "Ask for follow-up changes or attach images",
    zh: "输入后续修改或附加图片",
  },
  askAnything: {
    en: "Ask anything, @tag files/folders, or use / to show available commands",
    zh: "输入问题，@ 标记文件/文件夹，或输入 / 查看可用命令",
    phone: {
      en: "Ask Moss anything…",
      zh: "问问 Moss…",
      why: "the phone's empty composer is one short line wide",
    },
  },
} as const satisfies Record<string, MossWord>;

/** A word in a language, in the phone's wording where it has one. */
export function phoneWord(word: MossWord, language: "zh" | "en"): string {
  const chosen = word.phone ?? word;
  return language === "zh" ? chosen.zh : chosen.en;
}
