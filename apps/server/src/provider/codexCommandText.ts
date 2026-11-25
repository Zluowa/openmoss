// FILE: codexCommandText.ts
// Purpose: The text of a command Codex asks to run, as its approval card shows it (walk
//          WALK-13 N13-2, REVIEW-RULES rule 9).
// Layer: Provider adapter helper (pure).
//
// Codex does not send the line a shell will read: it sends the program and its arguments
// joined into one line with POSIX shell quoting (Rust's `shlex::try_join`). An argument
// holding a backslash goes in double quotes, where that quoting writes every backslash
// twice, so on Windows the card read
//   "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe" -Command 'Get-ChildItem -Name'
// while the program Codex starts is C:\Windows\System32\WindowsPowerShell\v1.0\powershell.exe.
// Windows never sees the doubled form.
//
// The line is kept exactly as Codex wrote it (its quotes, its spacing, its other escapes)
// with one change: inside double quotes, an escaped lone backslash before an ordinary
// character is written once. POSIX quoting reads `"a\b"` and `"a\\b"` as the same `a\b`, so
// the program and every argument stay what Codex sent; the result is checked to split into
// exactly Codex's argument list, and when it does not (or Codex's line does not split at
// all) Codex's line is returned untouched. A backslash next to another backslash, before a
// quote, `$`, a backtick or a line break, or at the end of a quoted part keeps its escape:
// there the escape is what keeps the argument the same.

import { splitPosixQuotedArgv } from "@moss/shared/shellCommandShape";

/** Characters a backslash escapes inside POSIX double quotes. */
const DOUBLE_QUOTE_ESCAPED = new Set(["\\", '"', "$", "`", "\n"]);

function rewriteDoubleQuotedSpan(
  command: string,
  startIndex: number,
): { readonly text: string; readonly nextIndex: number } {
  let text = '"';
  let afterEscapedBackslash = false;
  let hasConsecutiveEscapedBackslashes = false;
  let index = startIndex + 1;
  while (index < command.length) {
    const char = command[index]!;
    if (char === "\\" && index + 1 < command.length) {
      const next = command[index + 1]!;
      if (DOUBLE_QUOTE_ESCAPED.has(next)) {
        const isEscapedBackslash = next === "\\";
        if (isEscapedBackslash && afterEscapedBackslash) {
          hasConsecutiveEscapedBackslashes = true;
        }
        const following = command[index + 2];
        const lone =
          isEscapedBackslash &&
          !afterEscapedBackslash &&
          following !== undefined &&
          !DOUBLE_QUOTE_ESCAPED.has(following);
        text += lone ? "\\" : `${char}${next}`;
        afterEscapedBackslash = isEscapedBackslash;
        index += 2;
        continue;
      }
    }
    afterEscapedBackslash = false;
    text += char;
    index += 1;
    if (char === '"') {
      return {
        text: hasConsecutiveEscapedBackslashes ? command.slice(startIndex, index) : text,
        nextIndex: index,
      };
    }
  }
  return { text: command.slice(startIndex), nextIndex: command.length };
}

export function codexCommandText(command: string): string {
  const argv = splitPosixQuotedArgv(command);
  if (!argv) return command;
  let text = "";
  let quote: "'" | null = null;
  let index = 0;
  while (index < command.length) {
    const char = command[index]!;
    if (quote === "'") {
      text += char;
      if (char === "'") quote = null;
      index += 1;
      continue;
    }
    if (char === '"') {
      const span = rewriteDoubleQuotedSpan(command, index);
      text += span.text;
      index = span.nextIndex;
      continue;
    }
    if (char === "'") quote = "'";
    text += char;
    index += 1;
  }
  const reread = splitPosixQuotedArgv(text);
  const same =
    reread !== null &&
    reread.length === argv.length &&
    reread.every((argument, position) => argument === argv[position]);
  return same ? text : command;
}
