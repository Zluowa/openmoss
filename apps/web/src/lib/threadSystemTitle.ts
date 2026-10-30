// FILE: threadSystemTitle.ts
// Purpose: Localizes exact legacy Moss-generated thread titles at presentation time only.
// Layer: Web UI localization helper

import { translateMoss } from "../localization";
import type { MossLocaleCode } from "../uiLocale";

// Older voice threads persisted the English product default before thread-title
// creation was localized. Keep this equality intentionally exact: arbitrary,
// user-authored, provider-authored, and already-localized titles stay untouched.
const LEGACY_VOICE_CHAT_TITLE = "New voice chat";
const NEW_TERMINAL_TITLE = "New terminal";

export function resolveLocalizedSystemThreadTitle(title: string, locale: MossLocaleCode): string {
  if (title === LEGACY_VOICE_CHAT_TITLE) {
    return translateMoss(locale, "chat.voice.newChatTitle");
  }
  if (title === NEW_TERMINAL_TITLE) {
    return translateMoss(locale, "chat.header.newTerminal");
  }
  return title;
}
