// FILE: inlineVisualizationDirective.ts
// Purpose: Recognize T3 cursor-content visualization tags in Markdown paragraphs.
//          Codex visualize markers are not parsed; Codex CLI 0.162.1 never emits them.
// Layer: Web chat presentation logic

export const INLINE_VISUALIZATION_TAG_NAME = "codex-inline-visualization";
export const INLINE_VISUALIZATION_DATA_ATTRIBUTE = "data-visualization";

// OpenUI native-component track: the model emits OpenUI Lang (thesysdev/openui,
// MIT) instead of an HTML document path, and the client renders it with React
// components — no iframe, no sandbox, and component actions reflow into the
// conversation. Two marker shapes are recognized:
//   1. A fenced code block with info string `openui` (robust; survives blank
//      lines inside the program and streams like any code fence).
//   2. A raw `<openui>…</openui>` block. The closing tag may still be in
//      flight while the model streams, in which case the directive is marked
//      partial and the frame renders progressively.
export const OPENUI_TAG_NAME = "codex-openui";
export const OPENUI_DATA_ATTRIBUTE = "data-openui";

export interface OpenUIDirective {
  readonly source: string;
  readonly code: string;
  readonly title?: string;
  /** True when the closing tag/fence has not streamed in yet. */
  readonly partial: boolean;
}

export interface InlineVisualizationDirective {
  readonly source: string;
  readonly path?: string;
  readonly title?: string;
  readonly mode: "normal" | "wide";
}

interface MarkdownNode {
  type: string;
  value?: string | undefined;
  children?: MarkdownNode[];
  data?: { hName?: string; hProperties?: Record<string, unknown> };
  position?:
    | {
        start?: { offset?: number | undefined } | undefined;
        end?: { offset?: number | undefined } | undefined;
      }
    | undefined;
}

// Codex CLI 0.162.1 never emits `visualize{...}` or `::codex-inline-vis`. Moss
// publishes visuals with moss_show_visual instead of parsing those markers.
// T3/Cursor-style cursor-content tags stay as the fallback for that convention.
const CURSOR_CONTENT_MARKER =
  /^ {0,3}<cursor-content\s+kind="visualization"\s+src="([^"]+)"(?:\s+title="([^"]*)")?\s*>\s*(?:<\/cursor-content>)?[ \t]*$/u;

export function parseInlineVisualizationDirective(
  source: string,
): InlineVisualizationDirective | null {
  const cursorMatch = CURSOR_CONTENT_MARKER.exec(source);
  if (!cursorMatch) return null;
  const [, path, title] = cursorMatch;
  return {
    source,
    ...(path ? { path: path.trim() } : {}),
    ...(title ? { title: title.trim().slice(0, 200) } : {}),
    mode: "normal",
  };
}

/**
 * Paragraph-only transformation deliberately leaves markers in code blocks,
 * inline code, links, tool text and user Markdown untouched.
 */
export function remarkInlineVisualizationDirectives() {
  return (tree: unknown) => {
    const walk = (node: MarkdownNode): void => {
      if (!Array.isArray(node.children)) return;
      for (const child of node.children) {
        if (child.type === "paragraph") {
          // remark parses a bare `<cursor-content>` line as inline `html` nodes
          // (open tag, optional text, close tag), not a single text node.
          const parts = child.children ?? [];
          const raw = parts
            .filter((part) => part.type === "text" || part.type === "html")
            .map((part) => part.value ?? "")
            .join("");
          const singleText =
            parts.length === 1 && parts[0]?.type === "text" ? (parts[0].value as string) : null;
          const candidate = singleText ?? raw;
          if (candidate && parts.every((part) => part.type === "text" || part.type === "html")) {
            const directive = parseInlineVisualizationDirective(candidate);
            if (directive) {
              child.type = "inlineVisualization";
              child.children = [];
              child.data = {
                hName: INLINE_VISUALIZATION_TAG_NAME,
                hProperties: { dataVisualization: JSON.stringify(directive) },
              };
              continue;
            }
          }
        }
        // Do not descend into Markdown code nodes. This keeps even malformed
        // marker-shaped code literal without relying on string heuristics.
        if (child.type !== "code" && child.type !== "inlineCode") walk(child);
      }
    };
    walk(tree as MarkdownNode);
  };
}

export function readInlineVisualizationDirective(
  raw: unknown,
): InlineVisualizationDirective | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const directive = value as Partial<InlineVisualizationDirective>;
    if (
      typeof directive.source !== "string" ||
      (directive.mode !== "normal" && directive.mode !== "wide")
    ) {
      return null;
    }
    return {
      source: directive.source,
      ...(typeof directive.path === "string" && directive.path ? { path: directive.path } : {}),
      ...(typeof directive.title === "string" && directive.title ? { title: directive.title } : {}),
      mode: directive.mode,
    };
  } catch {
    return null;
  }
}

// Matches a standalone `<openui>` element: attributes are limited to an
// optional `title="…"`. Group 1 is the title, group 2 the program body, group
// 3 the closing tag (absent while the model is still streaming the block).
const OPENUI_ELEMENT_MARKER =
  /^ {0,3}<openui(?:\s+title="([^"]*)")?\s*>([\s\S]*?)(<\/openui>)?[ \t]*$/u;

export function parseOpenUIDirective(source: string): OpenUIDirective | null {
  const match = OPENUI_ELEMENT_MARKER.exec(source);
  if (!match) return null;
  const [, rawTitle, rawBody, closingTag] = match;
  const code = (rawBody ?? "").replace(/^\s*\n/, "").replace(/[ \t\n]+$/, "");
  if (code.length === 0) return null;
  return {
    source,
    code,
    ...(rawTitle?.trim() ? { title: rawTitle.trim().slice(0, 200) } : {}),
    partial: closingTag === undefined,
  };
}

/**
 * Recognizes OpenUI Lang output in two node shapes:
 * - `code` nodes with language `openui` (fenced form; never descends into
 *   other code nodes, so marker-shaped text inside ```js blocks stays literal).
 * - `html` nodes carrying a `<openui>` element. Markdown splits raw HTML at
 *   blank lines, so a block-level `<openui>` with blank lines inside arrives
 *   as a run of sibling html/paragraph nodes; the walker stitches that run
 *   back into one node and converts it.
 */
export function remarkOpenUIDirectives() {
  return (tree: unknown, file?: unknown) => {
    // Markdown parses emphasis/code inside a raw <openui> program's strings
    // into rich nodes, so value-based reconstruction corrupts the program.
    // When the parser provides positions, slice the ORIGINAL source instead.
    const source =
      typeof (file as { value?: unknown } | undefined)?.value === "string"
        ? (file as { value: string }).value
        : null;
    const offsetOf = (node: MarkdownNode, which: "start" | "end"): number | null => {
      const offset = node.position?.[which]?.offset;
      return typeof offset === "number" ? offset : null;
    };
    const nodeSource = (node: MarkdownNode): string | null => {
      if (node.type === "html" || node.type === "text") return node.value ?? "";
      if (node.type === "paragraph") {
        const parts = node.children ?? [];
        if (parts.every((part) => part.type === "text" || part.type === "html")) {
          return parts.map((part) => part.value ?? "").join("");
        }
      }
      return null;
    };
    const convert = (node: MarkdownNode, directive: OpenUIDirective): void => {
      node.type = "openuiVisualization";
      node.value = undefined;
      node.children = [];
      node.data = {
        hName: OPENUI_TAG_NAME,
        hProperties: { dataOpenui: JSON.stringify(directive) },
      };
    };
    const walk = (node: MarkdownNode): void => {
      if (!Array.isArray(node.children)) return;
      for (let index = 0; index < node.children.length; index += 1) {
        const child = node.children[index]!;
        if (child.type === "code") {
          if ((child as { lang?: string }).lang === "openui" && child.value?.trim()) {
            convert(child, {
              source: `\`\`\`openui\n${child.value}\n\`\`\``,
              code: child.value.replace(/[ \t\n]+$/, ""),
              partial: false,
            });
          }
          continue;
        }
        if (child.type === "html") {
          const value = child.value ?? "";
          if (!/^ {0,3}<openui(?:\s|\/?>)/u.test(value)) {
            continue;
          }
          const startOffset = offsetOf(child, "start");
          if (source !== null && startOffset !== null) {
            // Position-based stitching: extend through following siblings until
            // the closing tag, slicing the untouched source so markdown
            // formatting inside program strings survives verbatim.
            let endIndex = index;
            let endOffset = offsetOf(child, "end") ?? startOffset + value.length;
            let combined = source.slice(startOffset, endOffset);
            while (!combined.includes("</openui>") && endIndex + 1 < node.children.length) {
              const siblingEnd = offsetOf(node.children[endIndex + 1]!, "end");
              if (siblingEnd === null) break;
              endIndex += 1;
              endOffset = siblingEnd;
              combined = source.slice(startOffset, endOffset);
            }
            const directive = parseOpenUIDirective(combined.trim());
            if (directive) {
              const removed = node.children.splice(index, endIndex - index + 1);
              convert(removed[0]!, directive);
              node.children.splice(index, 0, removed[0]!);
            }
            continue;
          }
          // Fallback for hand-built trees without positions: collect this node
          // plus following siblings until the closing tag.
          const parts = [value];
          let endIndex = index;
          let foundClose = value.includes("</openui>");
          while (!foundClose && endIndex + 1 < node.children.length) {
            const sibling = node.children[endIndex + 1]!;
            const siblingSource = nodeSource(sibling);
            if (siblingSource === null) break;
            parts.push(siblingSource);
            endIndex += 1;
            foundClose = siblingSource.includes("</openui>");
          }
          const combined = parts.join("\n\n");
          const directive = parseOpenUIDirective(combined);
          if (directive) {
            const removed = node.children.splice(index, endIndex - index + 1);
            convert(removed[0]!, directive);
            node.children.splice(index, 0, removed[0]!);
          }
          continue;
        }
        if (child.type === "paragraph") {
          // A whole-program paragraph whose strings contain markdown (`**…**`)
          // parses into rich children; try the untouched source slice first.
          if (source !== null) {
            const startOffset = offsetOf(child, "start");
            const endOffset = offsetOf(child, "end");
            if (startOffset !== null && endOffset !== null) {
              const slice = source.slice(startOffset, endOffset);
              if (/^ {0,3}<openui(?:\s|\/?>)/u.test(slice)) {
                const directive = parseOpenUIDirective(slice.trim());
                if (directive) {
                  convert(child, directive);
                  continue;
                }
              }
            }
          }
          // Inline form: `<openui>root = Button("Hi")</openui>` on one line.
          const parts = child.children ?? [];
          if (parts.every((part) => part.type === "text" || part.type === "html")) {
            const candidate = parts.map((part) => part.value ?? "").join("");
            const directive = parseOpenUIDirective(candidate);
            if (directive) {
              convert(child, directive);
              continue;
            }
          }
        }
        if (child.type !== "inlineCode") walk(child);
      }
    };
    walk(tree as MarkdownNode);
  };
}

export function readOpenUIDirective(raw: unknown): OpenUIDirective | null {
  if (typeof raw !== "string") return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!value || typeof value !== "object" || Array.isArray(value)) return null;
    const directive = value as Partial<OpenUIDirective>;
    if (typeof directive.source !== "string" || typeof directive.code !== "string") {
      return null;
    }
    return {
      source: directive.source,
      code: directive.code,
      ...(typeof directive.title === "string" && directive.title ? { title: directive.title } : {}),
      partial: directive.partial === true,
    };
  } catch {
    return null;
  }
}
