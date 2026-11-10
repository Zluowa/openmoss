// FILE: zhCNMossbotCopy.ts
// Purpose: Whole Simplified Chinese phrases for personal assistants and group chats that the
//          word-level verb rules ("Show …", "Hide …", "Stop …", "Close …") would half-translate.
// Layer: Pure localization data
// Exports: translateZhCnMossbotCopyText (first in the presentation chain)

import { phraseTranslator } from "./zhCNPhraseTable";

const MOSSBOT_COPY: Readonly<Record<string, string>> = {
  "Close assistant overview": "关闭助手概览",
  "Show assistant": "显示助手",
  "Hide assistant": "隐藏助手",
  "Show group chat": "显示群聊",
  "Hide group chat": "隐藏群聊",
  "Show hidden assistants": "显示已隐藏的助手",
  "Show archived": "显示已归档",
  "Hide archived": "隐藏已归档",
  "Copy template": "复制模板",
  "Stop group": "停止群聊",
};

export const translateZhCnMossbotCopyText = phraseTranslator(MOSSBOT_COPY);
