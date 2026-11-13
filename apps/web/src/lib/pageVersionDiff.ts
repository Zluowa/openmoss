// FILE: pageVersionDiff.ts
// Purpose: 显示更改 in a page's version history: the lines a version added and removed against
//          the version before it, as one list in reading order (a longest-common-subsequence
//          line diff), plus the day groups the history list is drawn in.
// Layer: Web lib (pages)
// Exports: diffPageLines, PageDiffLine, historyDayLabel

export interface PageDiffLine {
  readonly kind: "same" | "added" | "removed";
  readonly text: string;
}

/** Above this many lines on both sides, the diff compares the changed middle only. */
const MAX_CELLS = 4_000_000;

export function diffPageLines(before: string, after: string): PageDiffLine[] {
  const a = before.replace(/\r\n?/gu, "\n").split("\n");
  const b = after.replace(/\r\n?/gu, "\n").split("\n");
  // Equal heads and tails need no table.
  let head = 0;
  while (head < a.length && head < b.length && a[head] === b[head]) head++;
  let tail = 0;
  while (
    tail < a.length - head &&
    tail < b.length - head &&
    a[a.length - 1 - tail] === b[b.length - 1 - tail]
  )
    tail++;
  const midA = a.slice(head, a.length - tail);
  const midB = b.slice(head, b.length - tail);
  const result: PageDiffLine[] = a.slice(0, head).map((text) => ({ kind: "same", text }));
  if (midA.length * midB.length > MAX_CELLS) {
    for (const text of midA) result.push({ kind: "removed", text });
    for (const text of midB) result.push({ kind: "added", text });
  } else {
    const rows = midA.length + 1;
    const cols = midB.length + 1;
    const table = new Uint32Array(rows * cols);
    for (let i = midA.length - 1; i >= 0; i--) {
      for (let j = midB.length - 1; j >= 0; j--) {
        table[i * cols + j] =
          midA[i] === midB[j]
            ? table[(i + 1) * cols + j + 1]! + 1
            : Math.max(table[(i + 1) * cols + j]!, table[i * cols + j + 1]!);
      }
    }
    let i = 0;
    let j = 0;
    while (i < midA.length || j < midB.length) {
      if (i < midA.length && j < midB.length && midA[i] === midB[j]) {
        result.push({ kind: "same", text: midA[i]! });
        i++;
        j++;
      } else if (
        i < midA.length &&
        (j >= midB.length || table[(i + 1) * cols + j]! >= table[i * cols + j + 1]!)
      ) {
        // A changed line reads as the old one struck, then the new one.
        result.push({ kind: "removed", text: midA[i]! });
        i++;
      } else {
        result.push({ kind: "added", text: midB[j]! });
        j++;
      }
    }
  }
  for (const text of a.slice(a.length - tail)) result.push({ kind: "same", text });
  return result;
}

/** "今天", "昨天", or the date, for the history list's group headings. */
export function historyDayLabel(iso: string, now = new Date()): string {
  const date = new Date(iso);
  const day = (value: Date) =>
    new Date(value.getFullYear(), value.getMonth(), value.getDate()).getTime();
  const days = Math.round((day(now) - day(date)) / 86_400_000);
  if (days === 0) return "今天";
  if (days === 1) return "昨天";
  return date.getFullYear() === now.getFullYear()
    ? `${date.getMonth() + 1}月${date.getDate()}日`
    : `${date.getFullYear()}年${date.getMonth() + 1}月${date.getDate()}日`;
}
