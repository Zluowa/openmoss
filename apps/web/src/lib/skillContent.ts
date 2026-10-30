// Display helpers only. The server authorizes reads against its discovered skill catalog.
export function skillMarkdownBody(contents: string): string {
  const normalized = contents.replace(/^\uFEFF/, "");
  if (!/^---\r?\n/.test(normalized)) return normalized;
  const closing = /^---[\t ]*\r?$/gm;
  closing.lastIndex = normalized.indexOf("\n") + 1;
  const match = closing.exec(normalized);
  return match ? normalized.slice(match.index + match[0].length).replace(/^\r?\n/, "") : normalized;
}

export function skillFilePath(path: string): string | null {
  if (!path.startsWith("/") && !/^[A-Za-z]:[\\/]/.test(path)) return null;
  if (path.includes("\0") || path.includes("\r") || path.includes("\n")) return null;
  if (/(?:^|[\\/])SKILL\.md$/i.test(path)) return path;
  const separator = /^[A-Za-z]:\\/.test(path) ? "\\" : "/";
  return `${path.replace(/[\\/]+$/, "")}${separator}SKILL.md`;
}
