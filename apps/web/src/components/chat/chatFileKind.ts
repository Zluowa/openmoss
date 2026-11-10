// FILE: chatFileKind.ts
// Purpose: What a file named in a reply is, in the words the chat shows on its hover
//          card and page card ("HTML page", "Image", ...), plus a page's own title.
// Layer: Chat presentation helpers
// Exports: chatFileKindLabel, isChatHtmlPagePath, readHtmlDocumentTitle,
//          formatChatRelativeTimeAgo

import type { MossLocaleCode } from "~/appSettings";
import { formatRelativeTime } from "~/lib/relativeTime";

const HTML_EXTENSIONS = new Set(["html", "htm"]);
const MARKDOWN_EXTENSIONS = new Set(["md", "mdx", "markdown"]);
const IMAGE_EXTENSIONS = new Set(["png", "jpg", "jpeg", "gif", "webp", "svg", "avif", "bmp"]);

function extensionOf(path: string): string {
  const name = path.replace(/\\/g, "/").split("/").pop() ?? "";
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

export function isChatHtmlPagePath(path: string): boolean {
  return HTML_EXTENSIONS.has(extensionOf(path));
}

/** English label; the zh-CN presentation table translates it like every other UI string. */
export function chatFileKindLabel(path: string): string {
  if (/[\\/]$/.test(path)) return "Folder";
  const extension = extensionOf(path);
  if (HTML_EXTENSIONS.has(extension)) return "HTML page";
  if (MARKDOWN_EXTENSIONS.has(extension)) return "Markdown document";
  if (IMAGE_EXTENSIONS.has(extension)) return "Image";
  if (extension === "pdf") return "PDF document";
  return "File";
}

const NAMED_ENTITIES: Record<string, string> = {
  amp: "&",
  lt: "<",
  gt: ">",
  quot: '"',
  apos: "'",
  nbsp: " ",
};

/**
 * The text of a page's `<title>`, or null. Read as plain text (React escapes it when
 * shown), never parsed as markup, so a page cannot inject anything through it.
 */
export function readHtmlDocumentTitle(contents: string): string | null {
  const match = /<title[^>]*>([\s\S]*?)<\/title\s*>/i.exec(contents.slice(0, 64_000));
  if (!match?.[1]) return null;
  const decoded = match[1].replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (entity, body: string) => {
    if (body.startsWith("#x") || body.startsWith("#X")) {
      const code = Number.parseInt(body.slice(2), 16);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : entity;
    }
    if (body.startsWith("#")) {
      const code = Number.parseInt(body.slice(1), 10);
      return Number.isFinite(code) && code > 0 && code < 0x110000
        ? String.fromCodePoint(code)
        : entity;
    }
    return NAMED_ENTITIES[body.toLowerCase()] ?? entity;
  });
  const title = decoded.replace(/\s+/g, " ").trim();
  return title.length > 0 ? title.slice(0, 160) : null;
}

/** "1m ago" / "1 分钟前", the narrow relative time the hover card shows. */
export function formatChatRelativeTimeAgo(iso: string, locale: MossLocaleCode): string {
  const relative = formatRelativeTime(iso, locale);
  if (locale === "zh-CN") return relative === "刚刚" ? relative : `${relative}前`;
  return relative === "now" ? "Just now" : `${relative} ago`;
}
