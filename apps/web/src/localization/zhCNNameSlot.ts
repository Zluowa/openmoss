// FILE: zhCNNameSlot.ts
// Purpose: One definition of "the rest of this label is a name", shared by the zh-CN word-level
//          rules such as `Close <name>`.
// Layer: Pure localization helper
// A bare `(.+)` also caught whole English sentences and left them half translated, for example
// "Stop the current response." became "停止 the current response."

// Words a sentence continues with after its verb, and a name almost never starts with.
const SENTENCE_CONTINUATIONS = [
  "a",
  "after",
  "all",
  "also",
  "an",
  "and",
  "any",
  "as",
  "at",
  "before",
  "by",
  "for",
  "from",
  "in",
  "is",
  "it",
  "its",
  "more",
  "not",
  "of",
  "on",
  "or",
  "our",
  "that",
  "the",
  "them",
  "these",
  "this",
  "those",
  "to",
  "where",
  "with",
  "without",
  "your",
].join("|");

// Captures one name: titles, files and agent names pass, while a slot that opens like a sentence
// or ends one does not. A dot inside a name such as `index.ts` is fine.
const NAME_SLOT = `(?!(?:${SENTENCE_CONTINUATIONS})\\b)((?:(?![.!](?:\\s|$)).)+)`;

/** Builds a word-level rule such as `Close <name>`; group 1 is the name. */
export function nameSlotRule(prefix: string, suffix = ""): RegExp {
  return new RegExp(`^${prefix} ${NAME_SLOT}${suffix}$`);
}
