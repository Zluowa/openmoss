// FILE: forgeRef.ts
// Purpose: Recognize a GitHub pull request or issue link the way the desktop chat
//          does, and decide whether its link text is just the reference (then it is
//          drawn as a chip reading "owner/repo#123").
// Layer: Chat transcript presentation logic (pure)
// Exports: ForgeRef, parseForgeRef, forgeRefLabel, linkTextIsForgeRef

export interface ForgeRef {
  owner: string;
  repo: string;
  kind: "pull" | "issue";
  number: number;
  /** Sub-page of a pull request ("files", "commits", "checks"), if any. */
  detail: "files" | "commits" | "checks" | null;
}

const FORGE_URL =
  /^https?:\/\/(?:www\.)?github\.com\/([\w.-]+)\/([\w.-]+)\/(pull|issues)\/(\d{1,9})(?:\/(files|commits|checks))?\/?(?:[?#].*)?$/i;

export function parseForgeRef(href: string): ForgeRef | null {
  const match = FORGE_URL.exec(href.trim());
  if (!match) return null;
  return {
    owner: match[1]!,
    repo: match[2]!,
    kind: match[3]!.toLowerCase() === "pull" ? "pull" : "issue",
    number: Number(match[4]),
    detail: (match[5]?.toLowerCase() as ForgeRef["detail"]) ?? null,
  };
}

export function forgeRefLabel(ref: ForgeRef): string {
  return `${ref.owner}/${ref.repo}#${ref.number}`;
}

/** True when the authored text says nothing beyond the reference itself. */
export function linkTextIsForgeRef(text: string, href: string, ref: ForgeRef): boolean {
  const value = text.trim();
  if (
    value === "" ||
    value === href.trim() ||
    value.replace(/^https?:\/\//, "") === href.replace(/^https?:\/\//, "")
  ) {
    return true;
  }
  const short = /^(?:([\w.-]+)\/([\w.-]+))?#(\d{1,9})$/.exec(value);
  if (!short || Number(short[3]) !== ref.number) return false;
  return (
    short[1] === undefined ||
    (short[1].toLowerCase() === ref.owner.toLowerCase() &&
      short[2]!.toLowerCase() === ref.repo.toLowerCase())
  );
}
