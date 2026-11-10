// Adapted from OpenMaus @ 58378e8 (Apache-2.0). See third_party/openmaus/UI-PORTS.md.
import { isMentionBoundary, isMentionNameContinuation } from "@moss/shared/mossbotRoom";
export type MentionPeer = { name: string; hidden?: boolean | undefined };
export type MentionPerson = { profileName?: string | null };
export type MentionRange = { start: number; end: number; color?: string };
export function mentionQueryAt(
  text: string,
  caret: number,
): { start: number; query: string } | null {
  const upto = text.slice(0, caret);
  const at = upto.lastIndexOf("@");
  if (at === -1) return null;
  if (at > 0 && !/\s/.test(upto[at - 1] ?? "")) return null;
  const query = upto.slice(at + 1);
  if (query.length > 24 || query.includes("@") || query.includes("\n")) return null;
  return { start: at, query };
}

export function mentionChoicesForQuery<T extends { name: string }>(
  pool: readonly T[],
  query: string,
): T[] {
  const normalized = query.trim().toLowerCase();
  if (query.endsWith(" ") && pool.some((choice) => choice.name.toLowerCase() === normalized))
    return [];
  return pool.filter((choice) => !normalized || choice.name.toLowerCase().includes(normalized));
}

export function mentionRanges(
  text: string,
  peers: readonly MentionPeer[],
  everyone = false,
  _person?: MentionPerson,
): MentionRange[] {
  const candidates = peers
    .filter((p) => !p.hidden && p.name.trim())
    .sort((a, b) => b.name.length - a.name.length);
  const ranges: MentionRange[] = [];
  let at = -1;
  while ((at = text.indexOf("@", at + 1)) !== -1) {
    if (!isMentionBoundary(text, at)) continue;
    const rest = text.slice(at + 1);
    const peer = candidates.find(
      ({ name }) =>
        rest.slice(0, name.length).toLowerCase() === name.toLowerCase() &&
        !isMentionNameContinuation(rest.slice(name.length)),
    );
    const all =
      everyone &&
      rest.slice(0, 8).toLowerCase() === "everyone" &&
      !isMentionNameContinuation(rest.slice(8));
    const length = all ? 8 : peer?.name.length;
    if (length === undefined) continue;
    ranges.push({ start: at, end: at + length + 1 });
    at += length;
  }
  return ranges;
}
export function mentionClassName(_range: MentionRange) {
  return "mention-highlight";
}
