// FILE: replyPreviewText.ts
// Purpose: Moss's rules around the plain-text reply preview (Activity rows): what Moss puts
//          in an assistant reply that a preview must never show (OpenUI programs, visual
//          tags, HTML, alert and wiki-link markup, table rules), and credentials, which are
//          masked before the preview leaves the server. Upstream's markdownPlainText does the
//          Markdown itself and stays as upstream wrote it.
// Layer: Shared domain logic (pure)
// Exports: replyPreviewPlainText, prepareReplyMarkdownForPreview, maskPreviewSecrets,
//          PREVIEW_SECRET_MASK

import { markdownToPlainText } from "./markdownPlainText";
import { findTranscriptSecrets } from "./transcriptSecretPatterns";

/** What stands in a preview for a credential: nothing of the value is shown. */
export const PREVIEW_SECRET_MASK = "••••••";

// An OpenUI program (```openui fence, or a raw <openui> block that may still be open) is a
// component the chat draws, not words: it leaves the preview.
const OPENUI_FENCE =
  /(^|\n)[ \t]*(`{3,}|~{3,})[ \t]*openui\b[^\n]*\n[\s\S]*?(?:\n[ \t]*\2[ \t]*(?=\n|$)|$)/gu;
const OPENUI_BLOCK = /<openui\b[^>]*>[\s\S]*?(?:<\/openui>|$)/giu;
// T3/Cursor visual tags render as an embedded page.
const CURSOR_CONTENT_TAG = /<cursor-content\b[^>]*>(?:[\s\S]*?<\/cursor-content>)?/giu;
// GitHub alert markers open a blockquote: "> [!NOTE]".
const ALERT_MARKER = /^([ \t]*>[ \t]*)\[!(?:NOTE|TIP|IMPORTANT|WARNING|CAUTION)\][ \t]*/gimu;
// [[Page]] or [[Page|label]] reads as its label.
const WIKI_LINK = /\[\[([^\]|\n]+)(?:\|([^\]\n]+))?\]\]/gu;
const HTML_BREAK = /<br\s*\/?>/giu;
// Any other HTML tag goes; the text between tags stays.
const HTML_TAG = /<\/?[a-z][a-z0-9-]*(?:\s[^<>]*)?\/?>/giu;
// A Markdown table's rule row (|---|:--:|).
const TABLE_RULE = /^[ \t]*\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/u;

function flattenTables(markdown: string): string {
  const lines = markdown.split("\n");
  if (!lines.some((line) => TABLE_RULE.test(line))) return markdown;
  return lines
    .filter((line) => !TABLE_RULE.test(line))
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed.startsWith("|") || !trimmed.endsWith("|") || trimmed.length < 2) return line;
      return trimmed
        .slice(1, -1)
        .split("|")
        .map((cell) => cell.trim())
        .filter((cell) => cell.length > 0)
        .join(" · ");
    })
    .join("\n");
}

/** The reply's Markdown with Moss-only markup a preview must not show taken out. */
export function prepareReplyMarkdownForPreview(markdown: string): string {
  return flattenTables(
    markdown
      .replace(OPENUI_FENCE, "$1")
      .replace(OPENUI_BLOCK, " ")
      .replace(CURSOR_CONTENT_TAG, " ")
      .replace(ALERT_MARKER, "$1")
      .replace(WIKI_LINK, (_match, page: string, label: string | undefined) =>
        (label ?? page).trim(),
      )
      .replace(HTML_BREAK, " ")
      .replace(HTML_TAG, ""),
  );
}

// Starts of credentials the transcript recognizes. A reply read only up to a limit can end
// partway through one, too short for the full pattern: such a tail is masked as well.
const SECRET_PREFIXES = [
  "moss_sk_",
  "moss_dk_",
  "sk-",
  "rk_live_",
  "sk_live_",
  "ghp_",
  "gho_",
  "ghu_",
  "ghs_",
  "ghr_",
  "github_pat_",
  "AKIA",
  "ASIA",
  "xox",
  "AIza",
  "whsec_",
  "AGE-SECRET-KEY-",
  "eyJ",
];
const OPEN_PRIVATE_KEY =
  /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----(?![\s\S]*-----END [A-Z0-9 ]*PRIVATE KEY-----)[\s\S]*$/u;

/**
 * Plain preview text with every credential masked. `truncated` says the text was cut from a
 * longer reply, so a credential cut at the end is masked from its known prefix on.
 */
export function maskPreviewSecrets(text: string, truncated: boolean): string {
  let masked = "";
  let cursor = 0;
  for (const secret of findTranscriptSecrets(text)) {
    masked += text.slice(cursor, secret.start) + PREVIEW_SECRET_MASK;
    cursor = secret.end;
  }
  masked += text.slice(cursor);
  masked = masked.replace(OPEN_PRIVATE_KEY, PREVIEW_SECRET_MASK);
  if (!truncated) return masked;
  // The last token, after a space or an assignment ("KEY=moss_sk_…", "token: ghp_…").
  const tail = /[^\s=:("'`[<]*$/u.exec(masked)?.[0] ?? "";
  if (tail.length >= 3 && SECRET_PREFIXES.some((prefix) => tail.startsWith(prefix))) {
    masked = `${masked.slice(0, masked.length - tail.length)}${PREVIEW_SECRET_MASK}`;
  }
  return masked;
}

/**
 * The words of a reply as a preview shows them: Moss-only markup out, Markdown flattened to
 * plain text, credentials masked. `truncated` says `markdown` is only the start of the reply.
 */
export function replyPreviewPlainText(markdown: string, truncated: boolean): string {
  return maskPreviewSecrets(
    markdownToPlainText(prepareReplyMarkdownForPreview(markdown)),
    truncated,
  );
}
