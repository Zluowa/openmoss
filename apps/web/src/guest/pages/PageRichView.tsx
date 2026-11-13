// FILE: PageRichView.tsx
// Purpose: Read-only rendering of a page's rich document (the editor's JSON) for guests.
// Layer: Guest page (page links and sites)
// Why: The editor runs in an iframe that only the owner's Moss serves, so guests get a small
//      renderer of their own. It builds React elements from the node tree and never sets HTML,
//      so a page cannot inject markup. Unknown blocks fall back to their text, and the Markdown
//      projection is used when the page has no rich document.

import { parsePageRichContent, type PageRichNode } from "@moss/shared/pageRichContent";
import { PageAppId, type PageGuestAppReference } from "@moss/contracts";
import { Option, Schema } from "effect";
import { libraryImageIdFromPath } from "@moss/shared/localPreviewFiles";
import { Fragment, useEffect, useState, type ReactNode } from "react";

import { Button } from "~/components/ui/button";
import { cn } from "~/lib/utils";

const SAFE_LINK = /^(https?:|mailto:)/i;

function safeHref(value: unknown): string | null {
  if (typeof value !== "string") return null;
  return SAFE_LINK.test(value.trim()) ? value.trim() : null;
}

/** The open comment threads a leaf's words carry (Plate's `comment_<id>` marks). */
function commentIdsOf(node: PageRichNode, open: ReadonlySet<string> | undefined): string[] {
  if (!open?.size) return [];
  return Object.keys(node)
    .filter((key) => key.startsWith("comment_") && key !== "comment_draft" && node[key] === true)
    .map((key) => key.slice("comment_".length))
    .filter((id) => open.has(id));
}

function renderLeaf(node: PageRichNode, key: number, options?: RenderOptions): ReactNode {
  let content: ReactNode = node.text ?? "";
  if (node.code === true) {
    content = (
      <code className="rounded-inline bg-muted px-1 py-0.5 font-mono text-[0.9em]">{content}</code>
    );
  }
  if (node.bold === true) content = <strong>{content}</strong>;
  if (node.italic === true) content = <em>{content}</em>;
  if (node.underline === true) content = <u>{content}</u>;
  if (node.strikethrough === true || node.strike === true) content = <s>{content}</s>;
  const comments = commentIdsOf(node, options?.openComments);
  if (comments.length) {
    const focused = options?.focusedComment ? comments.includes(options.focusedComment) : false;
    content = (
      <mark
        className={cn(
          "cursor-pointer border-b-2 border-[color-mix(in_srgb,#f2c94c_70%,transparent)] bg-[color-mix(in_srgb,#f2c94c_16%,transparent)] text-inherit",
          focused && "bg-[color-mix(in_srgb,#f2c94c_36%,transparent)]",
        )}
        data-guest-comment={comments.join(" ")}
        onClick={() => options?.onOpenComment?.(comments[0]!)}
      >
        {content}
      </mark>
    );
  }
  return <Fragment key={key}>{content}</Fragment>;
}

interface RenderOptions {
  readonly renderApp?: ((reference: PageGuestAppReference) => ReactNode) | undefined;
  readonly imageLabel: string;
  readonly imageNotShared: string;
  readonly loadImage?: (itemId: string) => Promise<Blob | null>;
  /** Comment threads on words to highlight, and the one open in the comments panel. */
  readonly openComments?: ReadonlySet<string>;
  readonly focusedComment?: string | null;
  readonly onOpenComment?: (threadId: string) => void;
  /** Which top-level blocks show (the open tab's); all when absent. */
  readonly visibleTop?: (index: number) => boolean;
}

function SharedImage(props: { itemId: string; caption: string; options: RenderOptions }) {
  const [url, setUrl] = useState<string | null>(null);
  const load = props.options.loadImage;
  useEffect(() => {
    let live = true;
    let created: string | null = null;
    setUrl(null);
    if (load)
      void load(props.itemId)
        .then((blob) => {
          if (!live || blob === null) return;
          created = URL.createObjectURL(blob);
          setUrl(created);
        })
        .catch(() => undefined);
    return () => {
      live = false;
      if (created !== null) URL.revokeObjectURL(created);
    };
  }, [load, props.itemId]);
  return url === null ? (
    <figure className="rounded-card border border-dashed border-border px-3 py-6 text-ui-sm text-muted-foreground">
      <figcaption>
        {props.caption} · {props.options.imageNotShared}
      </figcaption>
    </figure>
  ) : (
    <figure className="flex flex-col items-center gap-1">
      <img
        src={url}
        alt={props.caption}
        className="max-h-[70vh] max-w-full rounded-card object-contain"
        onError={() => setUrl(null)}
      />
      <figcaption className="text-ui-xs text-muted-foreground">{props.caption}</figcaption>
    </figure>
  );
}

function renderChildren(
  nodes: readonly PageRichNode[] | undefined,
  options: RenderOptions,
  parent: readonly number[] = [],
) {
  // Numbered indent-list items count up per indent level until another block breaks the run.
  const counters = new Map<number, number>();
  return (nodes ?? []).map((child, index) => {
    let ordinal: number | undefined;
    if (child.listStyleType === "decimal") {
      const level = typeof child.indent === "number" ? child.indent : 1;
      ordinal = (counters.get(level) ?? 0) + 1;
      counters.set(level, ordinal);
      for (const deeper of counters.keys()) if (deeper > level) counters.delete(deeper);
    } else if (typeof child.listStyleType !== "string") {
      counters.clear();
    }
    if (parent.length === 0 && options.visibleTop && !options.visibleTop(index)) return null;
    const rendered = renderNode(child, index, options, [...parent, index], ordinal);
    // Top-level blocks carry their id, so a selection can say which block a comment is on.
    return parent.length === 0 && typeof child.id === "string" ? (
      <div key={index} className="contents" data-guest-block={child.id}>
        {rendered}
      </div>
    ) : (
      rendered
    );
  });
}

function textOf(node: PageRichNode): string {
  return typeof node.text === "string" ? node.text : (node.children ?? []).map(textOf).join("");
}

function renderNode(
  node: PageRichNode,
  key: number,
  options: RenderOptions,
  path: readonly number[],
  ordinal?: number,
): ReactNode {
  if (typeof node.text === "string") return renderLeaf(node, key, options);
  const type = (node.type ?? "").toLowerCase();
  // A tab of the page starts here; the tab bar names it.
  if (type === "moss_tab") return null;
  if (type === "moss_dropdown") {
    const choices = Array.isArray(node.options) ? node.options : [];
    const label =
      typeof node.value === "number" && typeof choices[node.value] === "string"
        ? (choices[node.value] as string)
        : "";
    return label ? (
      <span
        key={key}
        className="mx-0.5 inline-flex h-5 items-center rounded-full bg-muted px-2 align-baseline text-[0.9em]"
      >
        {label}
      </span>
    ) : null;
  }
  if (node.type === "moss_visualization" && options.renderApp && Array.isArray(node.children)) {
    const app = Schema.decodeUnknownOption(PageAppId)(node.appPageId);
    const rev = node.appRevision;
    if (
      Option.isSome(app) &&
      (rev === undefined || (typeof rev === "number" && Number.isSafeInteger(rev) && rev > 0))
    ) {
      return (
        <Fragment key={key}>
          {options.renderApp({
            appId: app.value,
            nodePath: path,
            ...(typeof rev === "number" ? { appRevision: rev } : {}),
          })}
        </Fragment>
      );
    }
  }
  const children = renderChildren(node.children, options, path);
  const heading = /^h([1-6])$/.exec(type);
  if (heading) {
    const level = Number(heading[1]);
    const className = cn(
      "font-medium text-foreground",
      level === 1 && "mt-6 text-[1.6em] leading-tight",
      level === 2 && "mt-5 text-[1.3em] leading-snug",
      level >= 3 && "mt-4 text-[1.1em]",
    );
    const Tag = `h${Math.min(6, level + 1)}` as "h2";
    return (
      <Tag key={key} className={className}>
        {children}
      </Tag>
    );
  }
  switch (type) {
    case "blockquote":
    case "quote":
      return (
        <blockquote key={key} className="border-l-2 border-border pl-3 text-muted-foreground">
          {children}
        </blockquote>
      );
    case "code_block":
    case "codeblock":
    case "code-block":
      return (
        <pre
          key={key}
          className="overflow-x-auto rounded-card bg-muted px-3 py-2 font-mono text-ui-sm leading-relaxed"
        >
          <code>{(node.children ?? []).map(textOf).join("\n")}</code>
        </pre>
      );
    case "a":
    case "link": {
      const href = safeHref(node.url ?? node.href);
      return href ? (
        <a
          key={key}
          href={href}
          target="_blank"
          rel="noopener noreferrer nofollow"
          className="text-primary underline underline-offset-2"
        >
          {children}
        </a>
      ) : (
        <Fragment key={key}>{children}</Fragment>
      );
    }
    case "img":
    case "image":
    case "video":
    case "audio":
    case "file":
    case "media_embed": {
      const caption =
        typeof node.caption === "string"
          ? node.caption
          : typeof node.alt === "string"
            ? node.alt
            : options.imageLabel;
      const itemId =
        (type === "img" || type === "image") && typeof node.url === "string"
          ? libraryImageIdFromPath(node.url)
          : null;
      if (itemId !== null && options.loadImage)
        return <SharedImage key={key} itemId={itemId} caption={caption} options={options} />;
      // External URLs and non-image media remain explicit placeholders, without any request.
      return (
        <figure
          key={key}
          className="flex flex-col items-center gap-1 rounded-card border border-dashed border-border px-3 py-6 text-ui-sm text-muted-foreground"
        >
          <span>{caption}</span>
          <span className="text-ui-xs">{options.imageNotShared}</span>
        </figure>
      );
    }
    case "hr":
    case "horizontal_rule":
      return <hr key={key} className="my-4 border-border" />;
    case "ul":
    case "disc":
      return (
        <ul key={key} className="list-disc pl-6">
          {children}
        </ul>
      );
    case "ol":
    case "decimal":
      return (
        <ol key={key} className="list-decimal pl-6">
          {children}
        </ol>
      );
    case "li":
    case "list_item":
      return <li key={key}>{children}</li>;
    case "table":
      return (
        <div key={key} className="overflow-x-auto">
          <table className="w-full border-collapse text-ui-sm">
            <tbody>{children}</tbody>
          </table>
        </div>
      );
    case "tr":
    case "table_row":
      return <tr key={key}>{children}</tr>;
    case "th":
      return (
        <th key={key} className="border border-border px-2 py-1 text-left font-medium">
          {children}
        </th>
      );
    case "td":
    case "table_cell":
      return (
        <td key={key} className="border border-border px-2 py-1 align-top">
          {children}
        </td>
      );
    case "callout":
      return (
        <div key={key} className="rounded-card bg-muted/70 px-3 py-2">
          {children}
        </div>
      );
    default:
      break;
  }
  // Indent lists: a paragraph carrying `listStyleType` (and `indent`, `checked`).
  if (typeof node.listStyleType === "string" || typeof node.checked === "boolean") {
    const indent = typeof node.indent === "number" ? Math.max(0, Math.min(8, node.indent - 1)) : 0;
    const marker =
      typeof node.checked === "boolean"
        ? node.checked
          ? "☑"
          : "☐"
        : ordinal !== undefined
          ? `${ordinal}.`
          : "•";
    return (
      <div key={key} className="flex gap-2" style={{ paddingLeft: `${indent * 1.5}em` }}>
        <span aria-hidden className="shrink-0 select-none text-muted-foreground">
          {marker}
        </span>
        <div className="min-w-0 flex-1">{children}</div>
      </div>
    );
  }
  if (type === "p" || type === "paragraph" || type === "") {
    return (
      <p key={key} className="min-h-[1.6em]">
        {children}
      </p>
    );
  }
  // Unknown block: keep its text readable.
  return (
    <div key={key} className="min-h-[1.6em]">
      {children}
    </div>
  );
}

function MarkdownFallback(props: { readonly content: string }) {
  const blocks = props.content.split(/\n{2,}/).map((text, position) => ({ text, position }));
  return (
    <div className="flex flex-col gap-2">
      {blocks.map((block) => (
        <p key={block.position} className="whitespace-pre-wrap">
          {block.text}
        </p>
      ))}
    </div>
  );
}

/** The page's tabs (`moss_tab` blocks): each tab's title and the range of blocks it holds. */
export function guestPageTabs(
  nodes: readonly PageRichNode[],
): Array<{ id: string; title: string; level: number; start: number; end: number }> {
  const markers = nodes.flatMap((node, index) => (node.type === "moss_tab" ? [index] : []));
  return markers.map((marker, order) => {
    const node = nodes[marker]!;
    return {
      id: typeof node.id === "string" ? node.id : `tab-${marker}`,
      title: typeof node.title === "string" ? node.title : "",
      level: node.level === 1 ? 1 : 0,
      start: order === 0 && marker > 0 ? 0 : marker + 1,
      end: (markers[order + 1] ?? nodes.length) - 1,
    };
  });
}

export function PageRichView(props: {
  readonly renderApp?: RenderOptions["renderApp"];
  readonly richContent: string | undefined;
  readonly content: string;
  readonly imageLabel: string;
  readonly imageNotShared: string;
  readonly loadImage?: (itemId: string) => Promise<Blob | null>;
  readonly openComments?: ReadonlySet<string>;
  readonly focusedComment?: string | null;
  readonly onOpenComment?: (threadId: string) => void;
  /** A block to show (a comment's block): its tab opens. */
  readonly revealBlockId?: string | null;
  readonly tabsLabel?: string;
  readonly untitledTab?: string;
}) {
  let nodes: readonly PageRichNode[] | null = null;
  if (props.richContent !== undefined) {
    try {
      nodes = parsePageRichContent(props.richContent).nodes;
    } catch {
      nodes = null;
    }
  }
  const tabs = nodes ? guestPageTabs(nodes) : [];
  const [activeTab, setActiveTab] = useState<string | null>(null);
  const reveal = props.revealBlockId;
  useEffect(() => {
    if (!reveal || !nodes) return;
    const index = nodes.findIndex((node) => node.id === reveal);
    const tab = tabs.find((entry) => index >= entry.start && index <= entry.end);
    if (tab) setActiveTab(tab.id);
    // Only a new block to reveal moves the tab.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reveal]);
  const tab = tabs.find((entry) => entry.id === activeTab) ?? tabs[0];
  return (
    <div className="flex flex-col gap-2 text-ui-lg leading-relaxed text-foreground">
      {tabs.length ? (
        <nav
          aria-label={props.tabsLabel ?? "Tabs"}
          className="-mt-1 mb-2 flex flex-wrap gap-1 border-b border-border pb-2"
          data-guest-tabs
        >
          {tabs.map((entry) => (
            <Button
              key={entry.id}
              size="sm"
              variant="ghost"
              aria-current={entry.id === tab?.id ? "page" : undefined}
              className={cn(
                "text-muted-foreground",
                entry.level === 1 && "ms-2",
                entry.id === tab?.id && "bg-accent text-foreground",
              )}
              onClick={() => setActiveTab(entry.id)}
            >
              {entry.title || props.untitledTab || "Tab"}
            </Button>
          ))}
        </nav>
      ) : null}
      {nodes === null ? (
        <MarkdownFallback content={props.content} />
      ) : (
        renderChildren(nodes, {
          ...props,
          ...(tab ? { visibleTop: (index: number) => index >= tab.start && index <= tab.end } : {}),
        })
      )}
    </div>
  );
}
