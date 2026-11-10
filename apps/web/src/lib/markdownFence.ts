// FILE: markdownFence.ts
// Purpose: Tell a fenced code block that has closed from one still streaming in.
// Layer: Web chat presentation logic

// How far back from the code its opening fence line may start (fence plus info string).
const MAX_OPENING_LINE = 400;

/**
 * Whether the fenced block whose code starts at `codeOffset` in the message
 * source is followed by its closing fence: the same character as the opener,
 * at least as long, on its own line (a blockquote's `>` prefix allowed).
 *
 * It reads the source around the code instead of parser positions, because a
 * streaming reply is parsed in blocks and from rewritten text, so node offsets
 * do not point into the source. An unknown offset or empty code counts as open,
 * which keeps the block as code until the reply settles.
 */
export function isFenceClosedInSource(source: string, code: string, codeOffset: number): boolean {
  if (code.length === 0 || codeOffset < 0 || codeOffset + code.length > source.length) {
    return false;
  }
  const before = source.slice(Math.max(0, codeOffset - MAX_OPENING_LINE), codeOffset);
  // The code's first line may itself carry the indentation or `>` prefix of its container.
  const opening = /(?:^|\n)[ \t>]*(`{3,}|~{3,})[^\n]*\r?\n[ \t>]*$/u.exec(before)?.[1];
  if (opening === undefined) return false;
  const after = source.slice(codeOffset + code.length);
  const lineBreak = code.endsWith("\n") ? "" : "\\r?\\n";
  const closing = new RegExp(`^${lineBreak}[ \\t>]*(\`{3,}|~{3,})[ \\t\\r]*(?:\\n|$)`, "u").exec(
    after,
  )?.[1];
  return closing !== undefined && closing[0] === opening[0] && closing.length >= opening.length;
}
