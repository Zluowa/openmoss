// FILE: replyQuote.ts
// Purpose: The desktop chat's selection Reply wire format. A reply is sent as
//          "<!-- reply -->", the quoted selection as Markdown quote lines, a blank
//          line, then the reader's words; the transcript draws such a message as a
//          quote above the bubble text.
// Layer: Chat transcript logic (pure)
// Exports: REPLY_MARKER, REPLY_QUOTE_MAX_CHARS, buildReplyPrompt, parseReplyPrompt,
//          stripReplyMarkers

export const REPLY_MARKER = "<!-- reply -->";
/** Longest quote carried into a reply or a side chat (desktop chat: 1500). */
export const REPLY_QUOTE_MAX_CHARS = 1500;

function clampQuote(quote: string): string {
  const text = quote.replace(/\r\n/g, "\n").trim();
  return text.length > REPLY_QUOTE_MAX_CHARS ? `${text.slice(0, REPLY_QUOTE_MAX_CHARS)}…` : text;
}

export function buildReplyPrompt(quote: string, comment: string): string {
  const quoted = clampQuote(quote)
    .split("\n")
    .map((line) => (line.length > 0 ? `> ${line}` : ">"))
    .join("\n");
  return `${REPLY_MARKER}\n${quoted}\n\n${comment.trim()}`;
}

const REPLY_BLOCK = /^<!-- reply(?: [1-9][0-9]?)? -->\r?\n((?:>(?: [^\r\n]*)?(?:\r?\n|$))+)\s*/;

/** Splits a reply message into its quotes and the reader's own text. */
export function parseReplyPrompt(text: string): { quotes: string[]; body: string } | null {
  let rest = text;
  const quotes: string[] = [];
  for (;;) {
    const match = REPLY_BLOCK.exec(rest);
    if (!match) break;
    quotes.push(
      match[1]!
        .split(/\r?\n/)
        .filter((line) => line.startsWith(">"))
        .map((line) => line.replace(/^> ?/, ""))
        .join("\n")
        .trim(),
    );
    rest = rest.slice(match[0].length);
  }
  return quotes.length > 0 ? { quotes, body: rest.trim() } : null;
}

const REPLY_MARKER_LINE = /^<!-- reply(?: [1-9][0-9]?)? -->\r?\n(?=>(?: |\r?\n|$))/gm;

/**
 * Display text for a sent reply: the markers go, the quote lines stay, so the bubble
 * shows each quote as a Markdown quote above the reader's words (desktop chat).
 */
export function stripReplyMarkers(text: string): string {
  return text.startsWith("<!-- reply") ? text.replace(REPLY_MARKER_LINE, "") : text;
}
