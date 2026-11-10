// FILE: zhCNPhraseTable.ts
// Purpose: One lookup for the zh-CN copy modules: the exact phrase first, then anchored patterns
//          whose slots carry names, numbers and paths through untouched.
// Layer: Pure localization helper

export type PhrasePattern = readonly [
  pattern: RegExp,
  replacement: string | ((match: RegExpExecArray) => string),
];

/**
 * A table's own phrase for `key`. Indexing a plain object also finds `constructor`, `toString` and
 * the rest of Object.prototype, and the chain would write that member into the page as text.
 */
export function lookupPhrase(
  phrases: Readonly<Record<string, string>>,
  key: string,
): string | undefined {
  return Object.hasOwn(phrases, key) ? phrases[key] : undefined;
}

export function phraseTranslator(
  phrases: Readonly<Record<string, string>>,
  patterns: ReadonlyArray<PhrasePattern> = [],
): (value: string) => string {
  return (value) => {
    const exact = lookupPhrase(phrases, value);
    if (exact !== undefined) return exact;
    for (const [pattern, replacement] of patterns) {
      const match = pattern.exec(value);
      if (!match) continue;
      return typeof replacement === "string"
        ? value.replace(pattern, replacement)
        : replacement(match);
    }
    return value;
  };
}
