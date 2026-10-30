// Inline subagent sentence.
// i18n: subagents.activity.summary

export type InlineSubagentStatus =
  | "active"
  | "updated"
  | "interrupted"
  | "completed"
  | "failed"
  | "progress";

export interface InlineSubagentNameList {
  readonly visibleNames: readonly string[];
  readonly hiddenCount: number;
}

/** Codex shows every name up to three, then the first two plus a hidden count. */
export function selectInlineSubagentNames(names: readonly string[]): InlineSubagentNameList {
  const visible = names.map((name) => name.trim()).filter((name) => name.length > 0);
  if (visible.length <= 3) {
    return { visibleNames: visible, hiddenCount: 0 };
  }
  return { visibleNames: visible.slice(0, 2), hiddenCount: visible.length - 2 };
}

export function formatInlineSubagentNameList(names: readonly string[], locale: string): string {
  const { visibleNames, hiddenCount } = selectInlineSubagentNames(names);
  if (visibleNames.length === 0) return "";
  const chinese = locale.toLowerCase().startsWith("zh");
  const joiner = chinese ? "、" : ", ";
  const andWord = chinese ? "和" : "and";
  const more =
    hiddenCount > 0 ? (chinese ? `另外 ${hiddenCount} 个` : `${hiddenCount} more`) : null;
  if (visibleNames.length === 1 && !more) return visibleNames[0]!;
  if (visibleNames.length === 2 && !more) {
    return `${visibleNames[0]} ${andWord} ${visibleNames[1]}`;
  }
  if (!more) {
    return `${visibleNames[0]}${joiner}${visibleNames[1]} ${andWord} ${visibleNames[2]}`;
  }
  return `${visibleNames[0]}${joiner}${visibleNames[1]} ${andWord} ${more}`;
}
