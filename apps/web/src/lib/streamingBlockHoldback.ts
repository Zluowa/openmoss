// FILE: streamingBlockHoldback.ts
// Purpose: While a reply streams, the desktop chat holds back a last line that is only
//          the start of a block ("-", "1.", "- [", "##", ">", "```") until its first
//          real character arrives, so a stray bullet, empty heading or code frame does
//          not flash for a frame and then reflow.
// Layer: Web markdown helpers (pure)
// Exports: holdBackPartialBlockMarker

const QUOTE_PREFIX = "[ \\t]*(?:>[ \\t]*)*";
const LIST_MARKER_ONLY = new RegExp(
  `^${QUOTE_PREFIX}(?:(?:[-*+]|\\d{1,9}[.)]?)$|(?:[-*+]|\\d{1,9}[.)])[ \\t]+(?:\\[(?:[ xX](?:\\][ \\t]*)?)?)?$)`,
);
const HEADING_MARKER_ONLY = /^ {0,3}(?:>[ \t]*)*#{1,6}[ \t]*$/;
const QUOTE_MARKER_ONLY = /^[ \t]*(?:>[ \t]*)+$/;
const FENCE_MARKER_ONLY = /^[ \t>]*(?:`+|~+)[ \t]*$/;

/** `text` without a trailing line that is nothing but a block marker. */
export function holdBackPartialBlockMarker(text: string): string {
  const lineStart = text.lastIndexOf("\n") + 1;
  const lastLine = text.slice(lineStart);
  if (lastLine.trim() === "") return text;
  const partial =
    LIST_MARKER_ONLY.test(lastLine) ||
    HEADING_MARKER_ONLY.test(lastLine) ||
    QUOTE_MARKER_ONLY.test(lastLine) ||
    FENCE_MARKER_ONLY.test(lastLine);
  return partial ? text.slice(0, lineStart) : text;
}
