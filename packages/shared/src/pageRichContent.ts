/** Plate JSON is the canonical rich document. Markdown is only a readable projection. */
export const PAGE_RICH_CONTENT_LIMITS = { bytes: 2_000_000, depth: 64, nodes: 20_000 } as const;

export interface PageRichNode {
  readonly text?: string;
  readonly type?: string;
  readonly children?: readonly PageRichNode[];
  readonly [key: string]: unknown;
}
export interface ParsedPageRichContent {
  readonly richContent: string;
  readonly content: string;
  readonly nodes: readonly PageRichNode[];
}

const forbiddenKeys = new Set(["__proto__", "prototype", "constructor"]);
const mediaNodeTypes = new Set(["img", "video", "audio", "file", "media_embed"]);

/** Match the controlled Canvas host: Pages cannot retain temporary or active URLs. */
function durablePageUrl(value: string, allowMailto: boolean): boolean {
  if (value.trim() !== value || /[\u0000-\u001f\u007f]/u.test(value)) return false;
  try {
    const url = new URL(value, "https://page.invalid/");
    return (
      !url.username &&
      !url.password &&
      (url.protocol === "http:" ||
        url.protocol === "https:" ||
        (allowMailto && url.protocol === "mailto:"))
    );
  } catch {
    return false;
  }
}

function validateKnownPageUrl(node: Record<string, unknown>): void {
  if (
    typeof node.type !== "string" ||
    (node.type !== "a" && !mediaNodeTypes.has(node.type)) ||
    typeof node.url !== "string" ||
    !node.url
  )
    return;
  if (!durablePageUrl(node.url, node.type === "a")) {
    invalid(
      node.type === "a" ? "unsafe link URL" : "media requires a durable HTTP(S) or relative URL",
    );
  }
}

function invalid(message: string): never {
  throw new Error(`Invalid page richContent: ${message}`);
}

/** Validate untrusted JSON without loading an editor, executing HTML or losing unknown node data. */
export function parsePageRichContent(input: string): ParsedPageRichContent {
  if (
    input.length > PAGE_RICH_CONTENT_LIMITS.bytes ||
    new TextEncoder().encode(input).byteLength > PAGE_RICH_CONTENT_LIMITS.bytes
  )
    invalid("document exceeds the byte limit");
  let parsed: unknown;
  try {
    parsed = JSON.parse(input);
  } catch {
    return invalid("expected a JSON node array");
  }
  if (!Array.isArray(parsed)) invalid("expected a JSON node array");
  const pending: { value: unknown; depth: number }[] = [{ value: parsed, depth: 0 }];
  let containers = 0;
  while (pending.length > 0) {
    const { value, depth } = pending.pop()!;
    if (depth > PAGE_RICH_CONTENT_LIMITS.depth) invalid("document exceeds the depth limit");
    if (value === null || typeof value !== "object") continue;
    if (++containers > PAGE_RICH_CONTENT_LIMITS.nodes) invalid("document exceeds the node limit");
    if (!Array.isArray(value)) validateKnownPageUrl(value as Record<string, unknown>);
    for (const [key, child] of Object.entries(value)) {
      if (forbiddenKeys.has(key)) invalid("unsafe object key");
      pending.push({ value: child, depth: depth + 1 });
    }
  }
  const validateNode = (value: unknown): value is PageRichNode => {
    if (value === null || typeof value !== "object" || Array.isArray(value))
      invalid("each node must be an object");
    const node = value as Record<string, unknown>;
    if (typeof node.text === "string") {
      if ("children" in node) invalid("a text leaf cannot have children");
      return true;
    }
    if (
      typeof node.type !== "string" ||
      node.type.length === 0 ||
      node.type.length > 256 ||
      !Array.isArray(node.children)
    )
      invalid("elements require a type and children array");
    for (const child of node.children) validateNode(child);
    return true;
  };
  for (const node of parsed) validateNode(node);
  const nodes = parsed as PageRichNode[];
  const content = projectPageRichNodes(nodes);
  if (content.length > PAGE_RICH_CONTENT_LIMITS.bytes)
    invalid("readable projection exceeds the content limit");
  return { richContent: JSON.stringify(nodes), content, nodes };
}

const escapeText = (value: string) =>
  value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/([\\`*_\[\]~|])/g, "\\$1");
const backtickFence = (value: string, minimum: number) => {
  let length = minimum;
  for (const match of value.matchAll(/`+/g)) length = Math.max(length, match[0].length + 1);
  return "`".repeat(length);
};
const plainText = (node: PageRichNode): string =>
  typeof node.text === "string" ? node.text : (node.children ?? []).map(plainText).join("");
const safeUrl = (value: unknown, allowMailto = true): string | null => {
  if (typeof value !== "string" || !value || !durablePageUrl(value, allowMailto)) return null;
  return value
    .replace(/\s/gu, (character) => encodeURIComponent(character))
    .replace(/\(/g, "%28")
    .replace(/\)/g, "%29")
    .replace(/</g, "%3C")
    .replace(/>/g, "%3E");
};

/** Pure projection: callers must never use it as a replacement for the preserved rich AST. */
export function projectPageRichNodes(nodes: readonly PageRichNode[]): string {
  const render = (node: PageRichNode): string => {
    if (typeof node.text === "string") {
      if (node.code === true) {
        const fence = backtickFence(node.text, 1);
        const padding = node.text.startsWith("`") || node.text.endsWith("`") ? " " : "";
        return `${fence}${padding}${node.text}${padding}${fence}`;
      }
      let text = escapeText(node.text);
      if (node.bold === true) text = `**${text}**`;
      if (node.italic === true) text = `*${text}*`;
      if (node.strikethrough === true || node.strike === true) text = `~~${text}~~`;
      return text;
    }
    const children = node.children ?? [];
    const type = (node.type ?? "").toLowerCase();
    const body = () => children.map(render).join("");
    const heading = /^h([1-6])$/.exec(type);
    if (heading) return `${"#".repeat(Number(heading[1]))} ${body().trim()}\n\n`;
    if (type === "blockquote" || type === "quote")
      return (
        body()
          .trim()
          .split("\n")
          .map((line) => `> ${line}`)
          .join("\n") + "\n\n"
      );
    if (type === "code_block" || type === "codeblock" || type === "code-block") {
      const code = children.map(plainText).join("\n");
      const language =
        typeof node.lang === "string" ? node.lang.replace(/[^a-zA-Z0-9_+-]/g, "") : "";
      const fence = backtickFence(code, 3);
      return `${fence}${language}\n${code}\n${fence}\n\n`;
    }
    if (type === "code_line" || type === "codeline") return plainText(node) + "\n";
    if (type === "a" || type === "link") {
      const url = safeUrl(node.url ?? node.href);
      return url ? `[${body()}](${url})` : body();
    }
    if (type === "img" || type === "image") {
      const url = safeUrl(node.url ?? node.src, false);
      const label = escapeText(
        typeof node.caption === "string"
          ? node.caption
          : typeof node.alt === "string"
            ? node.alt
            : "Image",
      );
      return url ? `![${label}](${url})\n\n` : `[${label}]\n\n`;
    }
    if (
      type === "li" ||
      type === "list_item" ||
      type === "todo" ||
      node.listStyleType !== undefined ||
      node.listType !== undefined
    ) {
      const ordered = node.listStyleType === "decimal" || node.listType === "ol" || type === "ol";
      const prefix =
        typeof node.checked === "boolean"
          ? `- [${node.checked ? "x" : " "}] `
          : ordered
            ? "1. "
            : "- ";
      const indent =
        typeof node.indent === "number"
          ? "  ".repeat(Math.max(0, Math.min(32, Math.floor(node.indent) - 1)))
          : "";
      return indent + prefix + body().trim() + "\n";
    }
    if (
      type === "ul" ||
      type === "ol" ||
      type === "disc" ||
      type === "decimal" ||
      type === "list"
    ) {
      const ordered = type === "ol" || type === "decimal";
      return (
        children
          .map((child) =>
            render(
              child.type === "li"
                ? { ...child, listStyleType: ordered ? "decimal" : "disc" }
                : child,
            ),
          )
          .join("")
          .trimEnd() + "\n\n"
      );
    }
    if (type === "tr" || type === "table_row")
      return `| ${children.map((cell) => cell.children?.map(render).join("").trim().replace(/\n/g, " ") ?? "").join(" | ")} |\n`;
    if (type === "table") {
      const rows = children.map(render);
      if (rows.length === 0) return "";
      const columns = children[0]?.children?.length ?? 1;
      return (
        rows[0] +
        `| ${Array.from({ length: columns }, () => "---").join(" | ")} |\n` +
        rows.slice(1).join("") +
        "\n"
      );
    }
    if (type === "hr" || type === "horizontal_rule") return "---\n\n";
    if (type === "p" || type === "paragraph") return body().trimEnd() + "\n\n";
    if (type === "td" || type === "th" || type === "table_cell") return body();
    // Unknown legal elements remain in the canonical JSON, while their real
    // descendant text remains available to CLI clients in this projection.
    return body() + (children.some((child) => child.children !== undefined) ? "\n\n" : "");
  };
  return nodes.map(render).join("").trimEnd();
}
