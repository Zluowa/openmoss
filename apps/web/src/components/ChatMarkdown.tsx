// FILE: ChatMarkdown.tsx
// Purpose: Renders assistant and plan markdown with syntax highlighting and local file links.
// Layer: Web chat presentation component
// Exports: ChatMarkdown

import { StreamingMarkdownProvider, StreamingMarkdownText } from "./chat/StreamingMarkdownText";
import {
  CheckIcon,
  CopyIcon,
  InfoIcon,
  LightbulbIcon,
  OctagonAlertIcon,
  TextWrapIcon,
  TriangleAlertIcon,
  type LucideIcon,
} from "~/lib/icons";
import {
  INLINE_VISUAL_EMBED_FENCE,
  INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS,
  ThreadId,
  type ProviderMentionReference,
  type ThreadMarker,
} from "@synara/contracts";
import { readInlineVisualEmbedId } from "@synara/shared/inlineVisual";
import { isLocalAbsolutePath } from "@synara/shared/path";
import "katex/dist/katex.min.css";
import { matchWikiLinkAt, remarkWikiLinks } from "../lib/remarkWikiLinks";
import { remarkGithubAlerts, type GithubAlertKind } from "../lib/remarkGithubAlerts";
import { remarkHtmlBreaks } from "../lib/remarkHtmlBreaks";
import React, {
  Children,
  createContext,
  useContext,
  type CSSProperties,
  Suspense,
  isValidElement,
  memo,
  use,
  useDeferredValue,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
  type SyntheticEvent,
} from "react";
import type { Components } from "react-markdown";
import ReactMarkdown from "react-markdown";
import { useQuery } from "@tanstack/react-query";
import { defaultUrlTransform } from "react-markdown";
import rehypeKatex from "rehype-katex";
import rehypeRaw from "rehype-raw";
import rehypeSanitize, { defaultSchema } from "rehype-sanitize";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkMath from "remark-math";
import { copyTextToClipboard } from "../hooks/useCopyToClipboard";
import { resolveDiffThemeName, type DiffThemeName } from "../lib/diffRendering";
import { dedentCode, parseCodeFenceInfo, type CodeFenceInfo } from "../lib/codeFence";
import { MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS } from "../lib/syntaxHighlightingLimits";
import { getFileIconName, pathLooksLikeKnownFile } from "../file-icons";
import { CentralIcon } from "~/lib/central-icons";
import { isLocalImageMarkdownSrc } from "../lib/localImageUrls";
import { repairMarkdownTableDelimiters } from "../lib/markdownTableRepair";
import { showFileReferenceContextMenu } from "../lib/fileReferenceContextMenu";
import {
  ChatLinkActionsContext,
  resolveGitHubItemClickOpener,
  showLinkContextMenu,
} from "../lib/linkContextMenu";
import { useTheme } from "../hooks/useTheme";
import { useSmoothStreamedText } from "../hooks/useSmoothStreamedText";
import { useStableValue } from "../hooks/useStableValue";
import { useThrottledStreamingValue } from "../hooks/useThrottledStreamingValue";
import { openWorkspaceFileReference, useWorkspaceFileOpener } from "../lib/workspaceFileOpener";
import { projectResolveWorkspaceFileReferenceQueryOptions } from "../lib/projectReactQuery";
import {
  extractAbsoluteFilesystemPaths,
  resolveChatFileChipTarget,
  resolveMarkdownFileLinkTarget,
  rewriteMarkdownFileUriHref,
} from "../markdown-links";
import { useTranslation } from "../localization";
import { decodePythonBytesLiteral } from "@synara/shared/textPayload";
import type { ExpandedImagePreview } from "./chat/ExpandedImagePreview";
import { GeneratedMarkdownImage } from "./chat/GeneratedMarkdownImage";
import { TerminalContextInlineChip } from "./chat/TerminalContextInlineChip";
import type { ParsedTerminalContextEntry } from "../lib/terminalContext";
import { formatInlineTerminalContextLabel } from "./chat/userMessageTerminalContexts";
import {
  COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME,
  COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME,
} from "./composerInlineChip";
import { LinkChipIcon } from "./LinkChipIcon";
import { InlineAgentChip } from "./chat/InlineAgentChip";
import { InlineLinkChip } from "./InlineLinkChip";
import { InlineMentionChip } from "./chat/InlineMentionChip";
import { InlineSkillChip } from "./chat/InlineSkillChip";
import { InlineSlashCommandChip } from "./chat/InlineSlashCommandChip";
import { InlineVisualizationFrame } from "./chat/InlineVisualizationFrame";
import { OpenUIFrame } from "./chat/OpenUIFrame";
import { InlineVisualEmbedContext } from "./chat/inlineVisualEmbedContext";
import {
  COMPOSER_CHIP_SEGMENT_ATTRIBUTE,
  COMPOSER_CHIP_TAG_NAME,
  TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE,
  TERMINAL_CONTEXT_CHIP_TAG_NAME,
  createComposerChipsRemarkPlugin,
  parseComposerChipSegment,
} from "../lib/remarkComposerChips";
import {
  INLINE_VISUALIZATION_DATA_ATTRIBUTE,
  INLINE_VISUALIZATION_TAG_NAME,
  OPENUI_DATA_ATTRIBUTE,
  OPENUI_TAG_NAME,
  type InlineVisualizationDirective,
  parseInlineVisualizationDirective,
  readInlineVisualizationDirective,
  readOpenUIDirective,
  remarkInlineVisualizationDirectives,
  remarkOpenUIDirectives,
} from "../lib/inlineVisualizationDirective";
import { IconButton } from "./ui/icon-button";
import {
  applyActiveChatFindMatch,
  normalizeFindQuery,
  type ThreadFindRange,
} from "./chat/threadFind.logic";
import {
  useStreamingMarkdownChildren,
  type StreamingMarkdownBlock,
} from "./chat/streamingMarkdownBlocks";
import {
  ChatFindRenderProvider,
  FindAwareCodeFallback,
  FindAwareMarkdownText,
  FindAwareShikiHtml,
} from "./ChatMarkdownFind";

const EXTERNAL_HTTP_HREF_PATTERN = /^https?:\/\//i;
// Trailing `:line` / `:line:col` position suffix on a resolved file link. Kept on
// the href (so opening jumps to the line) but stripped for icon/title resolution.
const MARKDOWN_LINK_POSITION_SUFFIX_PATTERN = /:\d+(?::\d+)?$/;
const MARKDOWN_EXTERNAL_LINK_CLASS_NAME =
  "inline font-medium text-[var(--info-foreground)] underline-offset-2 hover:underline";
const MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME = `${COMPOSER_INLINE_CHIP_TOKEN_ICON_CLASS_NAME} ${COMPOSER_INLINE_CHIP_ICON_LABEL_GAP_CLASS_NAME}`;

function isExternalHttpHref(href: string | undefined): href is string {
  return typeof href === "string" && EXTERNAL_HTTP_HREF_PATTERN.test(href);
}

class CodeHighlightErrorBoundary extends React.Component<
  { fallback: ReactNode; children: ReactNode },
  { hasError: boolean }
> {
  constructor(props: { fallback: ReactNode; children: ReactNode }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    if (this.state.hasError) {
      return this.props.fallback;
    }
    return this.props.children;
  }
}

interface ChatMarkdownProps {
  text: string;
  cwd: string | undefined;
  isStreaming?: boolean;
  className?: string | undefined;
  style?: CSSProperties | undefined;
  /**
   * Shields rendered markdown from the DOM translation pass. User-authored and generated
   * markdown is protected by default; callers rendering a known static UI fallback may opt out.
   */
  protectTranslation?: boolean;
  onImageExpand?:
    | ((preview: ExpandedImagePreview, sourceImage?: HTMLImageElement) => void)
    | undefined;
  markers?: readonly ThreadMarker[] | undefined;
  wikiLinkRoot?: string | undefined;
  /**
   * Assigns native bidi ownership to transcript markdown blocks. The default
   * keeps the shared renderer's existing direction behavior for previews,
   * plans, and other non-transcript consumers.
   */
  directionMode?: "off" | "auto-blocks" | undefined;
  /** Case-insensitive substring to wrap while in-thread find is open. */
  findQuery?: string | undefined;
  /** Active occurrence in this markdown body; other hits stay dimmer. */
  findActiveRange?: ThreadFindRange | null | undefined;
  /**
   * "user" renders a sent prompt: GFM plus hard line breaks (single newlines
   * survive the way they were typed), no math/KaTeX and no literal-dollar
   * rewriting (`$50` and `$skill` stay verbatim), and composer inline tokens
   * (skills, mentions, agents, bare links) render as the shared chips.
   */
  variant?: "assistant" | "user";
  /** Moss thread id scopes server-side validation of native Codex marker paths. */
  threadId?: string | undefined;
  /** Stable transcript identity for scoped interactive-form drafts. */
  messageId?: string | undefined;
  segmentIndex?: number | undefined;
  /** Enabled only by the assistant transcript; prevents tool/detail/user Markdown from becoming a frame. */
  renderInlineVisualizations?: boolean | undefined;
  /** Opens a validated Codex-native visualization in the right-side document panel. */
  onOpenInlineVisualization?: ((directive: InlineVisualizationDirective) => void) | undefined;
  /** Mention metadata for chip icon resolution; only used by the user variant. */
  mentionReferences?: ReadonlyArray<ProviderMentionReference> | undefined;
  /**
   * Parses and sanitizes authored HTML embedded in the markdown. Keep this
   * disabled for provider/user content, which must continue to render HTML as
   * text.
   */
  parseHtml?: boolean | undefined;
  onOpenThread?: ((threadId: ThreadId) => void) | undefined;
  /** Terminal selections rendered as inline chips inside user-message markdown. */
  terminalContexts?: ReadonlyArray<ParsedTerminalContextEntry> | undefined;
  /**
   * Makes GFM task-list checkboxes interactive. Receives the 1-based line of
   * the task item in `text` so the caller can flip that `[ ]` marker at the
   * source (line numbers stay valid because the internal dollar protection is
   * length- and newline-preserving). Without it checkboxes render read-only.
   */
  onTaskToggle?: ((input: { sourceLine: number; checked: boolean }) => void) | undefined;
  /**
   * Absolute paths already observed on this turn's tool calls. A relative
   * inline-code chip uses one of these when the match is unique.
   */
  knownAbsoluteFilePaths?: ReadonlyArray<string> | undefined;
}

// Source line of the enclosing task-list item, provided by the `li` override.
// The checkbox `input` element is synthesized by mdast-util-to-hast without
// position info, so it cannot read its own source location.
const TaskItemSourceLineContext = React.createContext<number | null>(null);

function MarkdownTaskCheckbox(props: {
  checked: boolean;
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
}) {
  const { checked, onTaskToggle } = props;
  const sourceLine = React.useContext(TaskItemSourceLineContext);
  const interactive = onTaskToggle !== undefined && sourceLine !== null;
  return (
    <input
      type="checkbox"
      className="chat-markdown-task-checkbox"
      checked={checked}
      disabled={!interactive}
      {...(interactive ? { onChange: () => onTaskToggle({ sourceLine, checked: !checked }) } : {})}
    />
  );
}

const CODE_FENCE_LANGUAGE_REGEX = /(?:^|\s)language-([^\s]+)/;
type MarkdownRemarkPlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["remarkPlugins"]
>;
type MarkdownRehypePlugins = NonNullable<
  React.ComponentProps<typeof ReactMarkdown>["rehypePlugins"]
>;
interface ParsedMarkdownProps {
  text: string;
  /**
   * Parses settled top-level blocks once and re-parses only the growing tail
   * (see streamingMarkdownBlocks). The flattened output matches a single parse
   * of `text` element for element, keys included, so turning this off when a
   * stream ends updates the same DOM nodes in place.
   */
  splitBlocks: boolean;
  remarkPlugins: MarkdownRemarkPlugins;
  rehypePlugins: MarkdownRehypePlugins;
  components: Components;
}

// react-markdown's `Markdown` is synchronous and hook-free, so calling it as a
// function yields exactly the element tree it renders as a component.
const renderMarkdownToElements = ReactMarkdown;

function markdownRootChildren(root: ReactNode): readonly ReactNode[] {
  if (
    isValidElement<{ children?: ReactNode }>(root) &&
    root.type === React.Fragment &&
    root.key === null
  ) {
    const children = root.props.children;
    if (Array.isArray(children)) return children;
    return children === undefined || children === null ? [] : [children];
  }
  return root === undefined || root === null ? [] : [root];
}

interface MarkdownParseOptions {
  readonly remarkPlugins: MarkdownRemarkPlugins;
  readonly rehypePlugins: MarkdownRehypePlugins;
  readonly components: Components;
}

function parseMarkdownBlock(
  block: StreamingMarkdownBlock,
  options: MarkdownParseOptions,
): readonly ReactNode[] {
  return markdownRootChildren(
    renderMarkdownToElements({
      children: block.text,
      remarkPlugins:
        block.offset === 0
          ? options.remarkPlugins
          : withSourcePositionOffset(options.remarkPlugins, block),
      rehypePlugins: options.rehypePlugins,
      components: options.components,
      urlTransform: markdownUrlTransform,
    }),
  );
}

const ParsedMarkdown = memo(function ParsedMarkdown({
  text,
  splitBlocks,
  remarkPlugins,
  rehypePlugins,
  components,
}: ParsedMarkdownProps) {
  const children = useStreamingMarkdownChildren(
    text,
    splitBlocks,
    { remarkPlugins, rehypePlugins, components },
    parseMarkdownBlock,
  );
  return <>{children}</>;
});

const MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [
  remarkGfm,
  [remarkMath, { singleDollarTextMath: true }],
  remarkGithubAlerts,
  remarkHtmlBreaks,
];
// User prompts are casual typing, not authored markdown: hard-break single
// newlines and skip math entirely (the composer chip plugin is appended per
// render because it closes over the message's mention references).
const USER_MARKDOWN_REMARK_PLUGINS: MarkdownRemarkPlugins = [remarkGfm, remarkBreaks];
const USER_MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [];
const LITERAL_DOLLAR_PLACEHOLDER = "\uE000";
// `\$` is two source characters that render as a single `$`. Collapsing it to one placeholder used
// to shorten the protected string, which shifted every downstream offset (thread-marker positions
// are resolved against the raw text but applied against the parsed mdast positions). A two-character
// placeholder keeps `protectLiteralMarkdownDollars` length-preserving so those offsets stay aligned;
// it is restored ahead of the single-char placeholder (the two share no characters, so order is
// only for clarity).
const ESCAPED_DOLLAR_PLACEHOLDER = "\uE001\uE002";

function restoreLiteralDollarPlaceholders(value: string): string {
  return value
    .replaceAll(ESCAPED_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(LITERAL_DOLLAR_PLACEHOLDER, "$")
    .replaceAll(encodeURIComponent(ESCAPED_DOLLAR_PLACEHOLDER), "$")
    .replaceAll(encodeURIComponent(LITERAL_DOLLAR_PLACEHOLDER), "$");
}

// moss://thread/<target> links carry an id or title that may be
// %-encoded; a malformed sequence keeps the raw target instead of throwing.
function decodeMossThreadLinkTarget(target: string): string {
  try {
    return decodeURIComponent(target).trim();
  } catch {
    return target.trim();
  }
}

function markdownUrlTransform(href: string): string {
  const restoredHref = restoreLiteralDollarPlaceholders(href);
  if (restoredHref.startsWith("thread://") || restoredHref.startsWith("moss://thread/")) {
    return restoredHref;
  }
  return rewriteMarkdownFileUriHref(restoredHref) ?? defaultUrlTransform(restoredHref);
}

function restoreLiteralDollarsInNode(node: unknown): void {
  if (!node || typeof node !== "object") {
    return;
  }

  if ("type" in node && node.type === "text" && "value" in node && typeof node.value === "string") {
    node.value = restoreLiteralDollarPlaceholders(node.value);
  }

  if ("children" in node && Array.isArray(node.children)) {
    for (const child of node.children) {
      restoreLiteralDollarsInNode(child);
    }
  }
}

function rehypeRestoreLiteralDollars() {
  return (tree: unknown) => {
    restoreLiteralDollarsInNode(tree);
  };
}

const MARKDOWN_REHYPE_PLUGINS: MarkdownRehypePlugins = [
  [rehypeKatex, { output: "htmlAndMathml", strict: false, throwOnError: false }],
  rehypeRestoreLiteralDollars,
];

type BidiHastNode = {
  type?: string;
  tagName?: string;
  properties?: Record<string, unknown>;
  children?: BidiHastNode[];
};

const TOP_LEVEL_BIDI_OWNER_TAGS = new Set(["p", "h1", "h2", "h3", "h4", "h5", "h6"]);
const NESTED_BIDI_OWNER_TAGS = new Set(["li", "blockquote", "th", "td"]);

function setBidiDirection(node: BidiHastNode, direction: "auto" | "ltr"): void {
  node.properties = { ...node.properties, dir: direction };
}

function applyNestedBidiOwners(node: BidiHastNode): void {
  if (node.type === "element" && node.tagName) {
    if (NESTED_BIDI_OWNER_TAGS.has(node.tagName)) {
      setBidiDirection(node, "auto");
    } else if (
      node.tagName === "pre" ||
      node.tagName === "table" ||
      (Array.isArray(node.properties?.className) && node.properties.className.includes("katex")) ||
      node.properties?.className === "katex"
    ) {
      // Code, tables, and rendered math retain source/LTR ordering and must
      // not contribute their Latin text to an enclosing prose block's scan.
      setBidiDirection(node, "ltr");
    }
  }

  for (const child of node.children ?? []) {
    applyNestedBidiOwners(child);
  }
}

/**
 * Let the browser's Unicode bidi algorithm choose each prose block's first
 * strong direction. Regular anchors intentionally remain direction-neutral:
 * a link label is part of its paragraph's content, so setting dir=auto on the
 * anchor would isolate it and make a link-only Arabic paragraph resolve LTR.
 */
function rehypeBidiBlockDirection() {
  return (tree: BidiHastNode) => {
    for (const child of tree.children ?? []) {
      if (
        child.type === "element" &&
        child.tagName &&
        TOP_LEVEL_BIDI_OWNER_TAGS.has(child.tagName)
      ) {
        setBidiDirection(child, "auto");
      }
      applyNestedBidiOwners(child);
    }
  };
}
type MarkdownTextNode = {
  type: "text";
  value: string;
  position?: {
    start?: { offset?: number };
    end?: { offset?: number };
  };
};
type MarkdownParentNode = {
  type?: string;
  children?: MarkdownNode[];
};
type MarkdownNode = MarkdownTextNode | MarkdownParentNode | Record<string, unknown>;
const CHAT_FIND_TEXT_TAG_NAME = "chat-find-text";
const CHAT_FIND_TEXT_START_ATTRIBUTE = "data-chat-find-text-start";
type TextRangeFragmentContinuity = {
  readonly continuesBefore: boolean;
  readonly continuesAfter: boolean;
};

type MarkdownRangeDecoration = {
  startOffset: number;
  endOffset: number;
  nodeType: string;
  classNameFor: (continuity: TextRangeFragmentContinuity) => string;
  properties: Record<string, string>;
};

type RenderableThreadMarker = ThreadMarker & { className: string };

// The "active" ring (a transient deep-link highlight) is applied imperatively by the timeline so
// it never re-parses the markdown tree; this className is the stable, parse-time-only part.
function markerClassNameFor(marker: ThreadMarker) {
  return [
    "thread-marker",
    marker.style === "highlight" ? "thread-marker-highlight" : "thread-marker-underline",
    `thread-marker-${marker.color}`,
    marker.done ? "thread-marker-done" : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function rangeFragmentClassName(
  className: string,
  continuity: TextRangeFragmentContinuity,
  continuesBeforeClass: string,
  continuesAfterClass: string,
): string {
  return [
    className,
    continuity.continuesBefore ? continuesBeforeClass : "",
    continuity.continuesAfter ? continuesAfterClass : "",
  ]
    .filter(Boolean)
    .join(" ");
}

function normalizeRenderableMarkers(input: {
  text: string;
  markers: readonly ThreadMarker[] | undefined;
}): RenderableThreadMarker[] {
  const markers = input.markers ?? [];
  const result: RenderableThreadMarker[] = [];
  let previousEnd = -1;
  for (const marker of markers.toSorted((left, right) => left.startOffset - right.startOffset)) {
    if (marker.startOffset < previousEnd) {
      continue;
    }
    if (marker.endOffset <= marker.startOffset || marker.endOffset > input.text.length) {
      continue;
    }
    if (input.text.slice(marker.startOffset, marker.endOffset) !== marker.selectedText) {
      continue;
    }
    result.push({
      ...marker,
      className: markerClassNameFor(marker),
    });
    previousEnd = marker.endOffset;
  }
  return result;
}

function threadMarkerDecorations(input: {
  text: string;
  markers: readonly ThreadMarker[] | undefined;
}): MarkdownRangeDecoration[] {
  return normalizeRenderableMarkers(input).map((marker) => ({
    startOffset: marker.startOffset,
    endOffset: marker.endOffset,
    nodeType: "threadMarker",
    classNameFor: (continuity) =>
      rangeFragmentClassName(
        marker.className,
        continuity,
        "thread-marker-continues-before",
        "thread-marker-continues-after",
      ),
    properties: {
      "data-thread-marker-id": marker.id,
      "data-thread-marker-style": marker.style,
      "data-thread-marker-color": marker.color,
    },
  }));
}

function collapseOverlappingDecorations(
  decorations: readonly MarkdownRangeDecoration[],
): MarkdownRangeDecoration[] {
  const result: MarkdownRangeDecoration[] = [];
  let previousEnd = -1;
  for (const decoration of decorations.toSorted(
    (left, right) => left.startOffset - right.startOffset || right.endOffset - left.endOffset,
  )) {
    if (decoration.startOffset < previousEnd) {
      continue;
    }
    if (decoration.endOffset <= decoration.startOffset) {
      continue;
    }
    result.push(decoration);
    previousEnd = decoration.endOffset;
  }
  return result;
}

function remarkTextRangeDecorations(options: { decorations: readonly MarkdownRangeDecoration[] }) {
  const usable = collapseOverlappingDecorations(options.decorations);
  return (tree: MarkdownNode) => {
    if (usable.length > 0) {
      applyRangeDecorationsToNode(tree, usable);
    }
  };
}

// Keep the renderer's generated metadata through the authored-HTML sanitizer.
// KaTeX runs afterward so its generated MathML/styles do not widen this allowlist.
const AUTHORED_HTML_SCHEMA = {
  ...defaultSchema,
  tagNames: [...(defaultSchema.tagNames ?? []), CHAT_FIND_TEXT_TAG_NAME],
  attributes: {
    ...defaultSchema.attributes,
    [CHAT_FIND_TEXT_TAG_NAME]: ["dataChatFindTextStart"],
    blockquote: [
      ...(defaultSchema.attributes?.blockquote ?? []),
      ["dataGithubAlert", "note", "tip", "important", "warning", "caution"],
    ],
  },
  protocols: {
    ...defaultSchema.protocols,
    // Historical conversation links remain readable; new product links use moss.
    href: [...(defaultSchema.protocols?.href ?? []), "file", "thread", "moss", "synara"],
  },
};
function remarkFindableText() {
  return (tree: MarkdownNode) => wrapFindableTextNodes(tree);
}

function wrapFindableTextNodes(node: MarkdownNode): void {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }
  const parent = node as MarkdownParentNode;
  parent.children = (parent.children ?? []).map((child) => {
    if (child && typeof child === "object" && "type" in child && child.type === "text") {
      return wrapFindableTextNode(child as MarkdownTextNode);
    }
    wrapFindableTextNodes(child);
    return child;
  });
}

function wrapFindableTextNode(node: MarkdownTextNode): MarkdownNode {
  const startOffset = node.position?.start?.offset;
  if (startOffset === undefined || node.value.length === 0) {
    return node;
  }
  return {
    type: "chatFindText",
    data: {
      hName: CHAT_FIND_TEXT_TAG_NAME,
      hProperties: { [CHAT_FIND_TEXT_START_ATTRIBUTE]: String(startOffset) },
    },
    children: [node],
  };
}

function applyRangeDecorationsToNode(
  node: MarkdownNode,
  decorations: readonly MarkdownRangeDecoration[],
) {
  if (!node || typeof node !== "object" || !("children" in node) || !Array.isArray(node.children)) {
    return;
  }

  const parent = node as MarkdownParentNode;
  // The guard above already proved `children` is an array; `?? []` only satisfies the optional type.
  parent.children = (parent.children ?? []).flatMap((child) => {
    if (child && typeof child === "object" && "type" in child && child.type === "text") {
      return splitTextNodeWithRangeDecorations(child as MarkdownTextNode, decorations);
    }
    applyRangeDecorationsToNode(child, decorations);
    return [child];
  });
}

function splitTextNodeWithRangeDecorations(
  node: MarkdownTextNode,
  decorations: readonly MarkdownRangeDecoration[],
): MarkdownNode[] {
  const startOffset = node.position?.start?.offset;
  const endOffset = node.position?.end?.offset;
  if (startOffset === undefined || endOffset === undefined) {
    return [node];
  }
  const overlapping: MarkdownRangeDecoration[] = [];
  for (const decoration of decorations) {
    if (decoration.endOffset <= startOffset) {
      continue;
    }
    if (decoration.startOffset >= endOffset) {
      break;
    }
    overlapping.push(decoration);
  }
  if (overlapping.length === 0) {
    return [node];
  }

  const nodes: MarkdownNode[] = [];
  let cursor = 0;
  for (const decoration of overlapping) {
    const rangeStart = Math.max(0, decoration.startOffset - startOffset);
    const rangeEnd = Math.min(node.value.length, decoration.endOffset - startOffset);
    if (rangeStart < cursor || rangeEnd > node.value.length) {
      continue;
    }
    const absoluteFragmentStart = startOffset + rangeStart;
    const absoluteFragmentEnd = startOffset + rangeEnd;
    if (rangeStart > cursor) {
      nodes.push(
        createPositionedTextNode(
          node.value.slice(cursor, rangeStart),
          startOffset + cursor,
          absoluteFragmentStart,
        ),
      );
    }
    nodes.push({
      type: decoration.nodeType,
      data: {
        hName: "span",
        hProperties: {
          className: decoration.classNameFor({
            continuesBefore: absoluteFragmentStart > decoration.startOffset,
            continuesAfter: absoluteFragmentEnd < decoration.endOffset,
          }),
          ...decoration.properties,
        },
      },
      children: [
        createPositionedTextNode(
          node.value.slice(rangeStart, rangeEnd),
          absoluteFragmentStart,
          absoluteFragmentEnd,
        ),
      ],
    });
    cursor = rangeEnd;
  }
  if (cursor < node.value.length) {
    nodes.push(createPositionedTextNode(node.value.slice(cursor), startOffset + cursor, endOffset));
  }
  return nodes.length > 0 ? nodes : [node];
}

function createPositionedTextNode(
  value: string,
  startOffset: number,
  endOffset: number,
): MarkdownTextNode {
  return {
    type: "text",
    value,
    position: {
      start: { offset: startOffset },
      end: { offset: endOffset },
    },
  };
}

type SourcePoint = { line: number; column: number; offset?: number | undefined };
type SourcePositionedNode = {
  position?: { start: SourcePoint; end: SourcePoint } | undefined;
  children?: SourcePositionedNode[];
};

/**
 * Moves the mdast positions of a block parsed on its own to where the block
 * sits in the whole message, so find offsets, code source offsets and task
 * line numbers match a single parse. Runs after the plugins that slice the
 * block's own source by offset (alerts, wiki links) and before
 * `remarkFindableText`. Plugins may share point objects between nodes, so
 * points are replaced, never mutated.
 */
function remarkSourcePositionOffset(options: { offset: number; lineOffset: number }) {
  const shiftPoint = (point: SourcePoint): SourcePoint => ({
    ...point,
    line: point.line + options.lineOffset,
    ...(point.offset === undefined ? {} : { offset: point.offset + options.offset }),
  });
  const shiftNode = (node: SourcePositionedNode): void => {
    if (node.position) {
      node.position = {
        ...node.position,
        start: shiftPoint(node.position.start),
        end: shiftPoint(node.position.end),
      };
    }
    for (const child of node.children ?? []) shiftNode(child);
  };
  return (tree: SourcePositionedNode) => shiftNode(tree);
}

function withSourcePositionOffset(
  plugins: MarkdownRemarkPlugins,
  block: StreamingMarkdownBlock,
): MarkdownRemarkPlugins {
  const offsetPlugin: MarkdownRemarkPlugins[number] = [
    remarkSourcePositionOffset,
    { offset: block.offset, lineOffset: block.line - 1 },
  ];
  const rangeDecorationIndex = plugins.findIndex(
    (plugin) => Array.isArray(plugin) && plugin[0] === remarkTextRangeDecorations,
  );
  const findableIndex = plugins.indexOf(remarkFindableText);
  const positionAwareIndex = rangeDecorationIndex >= 0 ? rangeDecorationIndex : findableIndex;
  return positionAwareIndex < 0
    ? [...plugins, offsetPlugin]
    : [...plugins.slice(0, positionAwareIndex), offsetPlugin, ...plugins.slice(positionAwareIndex)];
}
const INLINE_MATH_HINT_REGEX = /[\\^_=+\-*/<>()[\]{}]/;
const ALL_CAPS_DOLLAR_IDENTIFIER_REGEX = /^[A-Z][A-Z0-9_]{1,31}$/;

function isLineStart(value: string, index: number): boolean {
  return index === 0 || value[index - 1] === "\n";
}

function matchFenceDelimiter(
  value: string,
  index: number,
): { marker: "`" | "~"; length: number } | null {
  if (!isLineStart(value, index)) {
    return null;
  }

  const marker = value[index];
  if (marker !== "`" && marker !== "~") {
    return null;
  }

  let cursor = index;
  while (value[cursor] === marker) {
    cursor += 1;
  }

  return cursor - index >= 3 ? { marker, length: cursor - index } : null;
}

function findFenceEndIndex(
  value: string,
  index: number,
  marker: "`" | "~",
  length: number,
): number {
  let cursor = value.indexOf("\n", index);
  if (cursor === -1) {
    return value.length;
  }
  cursor += 1;

  while (cursor < value.length) {
    if (isLineStart(value, cursor) && value[cursor] === marker) {
      let markerEnd = cursor;
      while (value[markerEnd] === marker) {
        markerEnd += 1;
      }
      if (markerEnd - cursor >= length) {
        const lineEnd = value.indexOf("\n", markerEnd);
        return lineEnd === -1 ? value.length : lineEnd + 1;
      }
    }

    const nextLine = value.indexOf("\n", cursor);
    if (nextLine === -1) {
      return value.length;
    }
    cursor = nextLine + 1;
  }

  return value.length;
}

function findInlineCodeEndIndex(value: string, index: number, length: number): number {
  let cursor = index + length;
  while (cursor < value.length) {
    if (value[cursor] !== "`") {
      cursor += 1;
      continue;
    }

    let markerEnd = cursor;
    while (value[markerEnd] === "`") {
      markerEnd += 1;
    }

    if (markerEnd - cursor === length) {
      return markerEnd;
    }
    cursor = markerEnd;
  }

  return value.length;
}

function looksLikeInlineMath(content: string): boolean {
  const trimmed = content.trim();
  if (trimmed.length === 0) {
    return false;
  }
  if (ALL_CAPS_DOLLAR_IDENTIFIER_REGEX.test(trimmed)) {
    return false;
  }
  if (INLINE_MATH_HINT_REGEX.test(trimmed)) {
    return true;
  }
  return /^(?:\d+(?:\.\d+)?)?[A-Za-z][A-Za-z0-9]{0,15}$/.test(trimmed);
}

// Reject obvious literal/currency dollars before searching for a closing math delimiter.
function canOpenInlineMath(value: string, index: number): boolean {
  const next = value[index + 1];
  if (!next || /\s/.test(next)) {
    return false;
  }
  if (/\d/.test(next)) {
    const closingIndex = findInlineMathClosingDollar(value, index + 1);
    if (closingIndex === -1 || /\d/.test(value[closingIndex + 1] ?? "")) {
      return false;
    }
    // A numeric prefix can be a coefficient. Require a complete expression
    // on this line; do not pair prices across lines or consume `$5-$10`.
    const content = value.slice(index + 1, closingIndex);
    return !/[\r\n]/.test(content) && looksLikeInlineMath(content);
  }
  return true;
}

// Markdown math delimiters should hug content; loose "$ " endings are treated as prose.
function canCloseInlineMath(value: string, index: number): boolean {
  const previous = value[index - 1];
  if (!previous || /\s/.test(previous)) {
    return false;
  }
  return true;
}

function findInlineMathClosingDollar(value: string, index: number): number {
  let cursor = index;
  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd !== -1) {
      // Dollars in Markdown links/images cannot close preceding literal text.
      // Dollar-free [f](x) remains valid inside a TeX expression.
      if (value.slice(cursor, linkEnd).includes("$")) {
        return -1;
      }
      cursor = linkEnd;
      continue;
    }
    if (value[cursor] === "$") {
      return canCloseInlineMath(value, cursor) ? cursor : -1;
    }
    cursor += 1;
  }
  return -1;
}

function protectLiteralDollarsInMarkdownLinks(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += ESCAPED_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    // Scan links and math together: splitting at every `[` breaks TeX such as
    // \left[...\right] before its closing dollars can be found. A math span is
    // consumed whole below, so brackets inside it never enter link detection.
    const linkEnd = findInlineMarkdownLinkEnd(value, cursor);
    if (linkEnd !== -1) {
      result += value.slice(cursor, linkEnd).replaceAll("$", LITERAL_DOLLAR_PLACEHOLDER);
      cursor = linkEnd;
      continue;
    }

    if (value.startsWith("$$", cursor)) {
      const closingIndex = value.indexOf("$$", cursor + 2);
      if (closingIndex === -1) {
        result += `${LITERAL_DOLLAR_PLACEHOLDER}${LITERAL_DOLLAR_PLACEHOLDER}`;
        cursor += 2;
        continue;
      }
      result += value.slice(cursor, closingIndex + 2);
      cursor = closingIndex + 2;
      continue;
    }

    if (value[cursor] === "$") {
      if (!canOpenInlineMath(value, cursor)) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const closingIndex = findInlineMathClosingDollar(value, cursor + 1);
      if (closingIndex === -1) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const content = value.slice(cursor + 1, closingIndex);
      result += looksLikeInlineMath(content)
        ? `$${content}$`
        : `${LITERAL_DOLLAR_PLACEHOLDER}${content}${LITERAL_DOLLAR_PLACEHOLDER}`;
      cursor = closingIndex + 1;
      continue;
    }

    result += value[cursor];
    cursor += 1;
  }

  return result;
}

function protectLiteralDollarsInPlainText(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    if (value[cursor] === "\\" && value[cursor + 1] === "$") {
      result += ESCAPED_DOLLAR_PLACEHOLDER;
      cursor += 2;
      continue;
    }

    if (value.startsWith("$$", cursor)) {
      const closingIndex = value.indexOf("$$", cursor + 2);
      if (closingIndex === -1) {
        // A valid markdown link inside a formula can still split the scan, so
        // keep an unmatched delimiter verbatim rather than masking real math.
        result += "$$";
        cursor += 2;
        continue;
      }
      result += value.slice(cursor, closingIndex + 2);
      cursor = closingIndex + 2;
      continue;
    }

    if (value[cursor] === "$") {
      if (!canOpenInlineMath(value, cursor)) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const closingIndex = findInlineMathClosingDollar(value, cursor + 1);
      if (closingIndex === -1) {
        result += LITERAL_DOLLAR_PLACEHOLDER;
        cursor += 1;
        continue;
      }

      const content = value.slice(cursor + 1, closingIndex);
      // An image inside the candidate span is a real markdown image, not math
      // content — its URL dollars (`$variant.png`) must not close fake math.
      const holdsImageLink =
        content.includes("![") && findInlineMarkdownLinkEnd(content, content.indexOf("![")) !== -1;
      result +=
        !holdsImageLink && looksLikeInlineMath(content)
          ? `$${content}$`
          : `${LITERAL_DOLLAR_PLACEHOLDER}${content}${LITERAL_DOLLAR_PLACEHOLDER}`;
      cursor = closingIndex + 1;
      continue;
    }

    result += value[cursor];
    cursor += 1;
  }

  return result;
}

function findMarkdownBracketEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "[") {
      depth += 1;
    } else if (value[cursor] === "]") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findMarkdownParenEnd(value: string, startIndex: number): number {
  let depth = 0;
  let cursor = startIndex;

  while (cursor < value.length) {
    if (value[cursor] === "\\") {
      cursor += 2;
      continue;
    }
    if (value[cursor] === "(") {
      depth += 1;
    } else if (value[cursor] === ")") {
      depth -= 1;
      if (depth === 0) {
        return cursor;
      }
    }
    cursor += 1;
  }

  return -1;
}

function findInlineMarkdownLinkEnd(value: string, index: number): number {
  const wikiLink = matchWikiLinkAt(value, index);
  if (wikiLink) return index + wikiLink[0].length;
  const bracketStart = value[index] === "!" && value[index + 1] === "[" ? index + 1 : index;
  if (value[bracketStart] !== "[") {
    return -1;
  }

  const bracketEnd = findMarkdownBracketEnd(value, bracketStart);
  if (bracketEnd === -1 || value[bracketEnd + 1] !== "(") {
    return -1;
  }

  const parenEnd = findMarkdownParenEnd(value, bracketEnd + 1);
  return parenEnd === -1 ? -1 : parenEnd + 1;
}

// Tighten single-dollar math so currency and escaped dollars stay literal without touching code spans.
function protectLiteralMarkdownDollars(value: string): string {
  let result = "";
  let cursor = 0;

  while (cursor < value.length) {
    const fenceDelimiter = matchFenceDelimiter(value, cursor);
    if (fenceDelimiter) {
      const fenceEndIndex = findFenceEndIndex(
        value,
        cursor,
        fenceDelimiter.marker,
        fenceDelimiter.length,
      );
      result += value.slice(cursor, fenceEndIndex);
      cursor = fenceEndIndex;
      continue;
    }

    if (value[cursor] === "`") {
      let markerEnd = cursor;
      while (value[markerEnd] === "`") {
        markerEnd += 1;
      }
      const inlineCodeEndIndex = findInlineCodeEndIndex(value, cursor, markerEnd - cursor);
      result += value.slice(cursor, inlineCodeEndIndex);
      cursor = inlineCodeEndIndex;
      continue;
    }

    let nextCodeIndex = cursor;
    while (nextCodeIndex < value.length) {
      if (value[nextCodeIndex] === "`" || matchFenceDelimiter(value, nextCodeIndex)) {
        break;
      }
      nextCodeIndex += 1;
    }

    result += protectLiteralDollarsInMarkdownLinks(value.slice(cursor, nextCodeIndex));
    cursor = nextCodeIndex;
  }

  return result;
}

// Returns the raw fence info string (the token after ```), e.g. "ts" or the
// Cursor reference form "173:186:packages/shared/src/model.ts". Parsing into a
// highlighter language + file metadata is handled by `parseCodeFenceInfo`.
function extractRawFenceInfo(className: string | undefined): string {
  const match = className?.match(CODE_FENCE_LANGUAGE_REGEX);
  return match?.[1] ?? "text";
}

function nodeToPlainText(node: ReactNode): string {
  if (typeof node === "string" || typeof node === "number") {
    return String(node);
  }
  if (Array.isArray(node)) {
    return node.map((child) => nodeToPlainText(child)).join("");
  }
  if (isValidElement<{ children?: ReactNode }>(node)) {
    return nodeToPlainText(node.props.children);
  }
  return "";
}

function extractCodeBlock(
  children: ReactNode,
): { className: string | undefined; code: string } | null {
  const childNodes = Children.toArray(children);
  if (childNodes.length !== 1) {
    return null;
  }

  // The single child is the fenced code element. Its rendered `type` is the
  // custom `code` component (not the string "code") once we override `code`
  // below, so detect by shape (a valid element carrying the code text) rather
  // than by tag identity. `pre` only ever wraps a code element in markdown.
  const onlyChild = childNodes[0];
  if (!isValidElement<{ className?: string; children?: ReactNode }>(onlyChild)) {
    return null;
  }

  return {
    className: onlyChild.props.className,
    code: nodeToPlainText(onlyChild.props.children),
  };
}

const INLINE_CODE_FILE_PATH_MAX_LENGTH = 120;

// Decides whether an inline code span names a file/path that should render as a
// mention chip (icon + medium label), matching how a file reads in the composer.
// Conservative on purpose: requires a recognized filename/extension and rejects
// whitespace and URLs so ordinary prose tokens stay plain inline code.
function inlineCodeFilePath(raw: string): string | null {
  // Strip a pair of surrounding quotes/backticks the author may have wrapped the
  // path in (e.g. `'src/data/social-metrics.ts'`).
  const value = raw.trim().replace(/^['"`]+|['"`]+$/g, "");
  if (value.length === 0 || /\s/.test(value) || value.includes("://")) {
    return null;
  }
  const withoutPosition = value.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  // Absolute local files and directories (`/Users/…/annotate-pr`) are chips
  // even without a known filename extension. Relative names still need a
  // recognizable file so ordinary tokens stay code.
  if (resolveMarkdownFileLinkTarget(withoutPosition)) {
    return value;
  }
  if (withoutPosition.length > INLINE_CODE_FILE_PATH_MAX_LENGTH) {
    return null;
  }
  return pathLooksLikeKnownFile(withoutPosition) ? value : null;
}

function VerifiedWorkspaceFileChip(props: {
  rawReference: string;
  cwd: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const relativePath = props.rawReference.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const query = useQuery(
    projectResolveWorkspaceFileReferenceQueryOptions({
      cwd: props.cwd,
      relativePath,
    }),
  );
  const fallback = <code>{props.label ?? relativePath}</code>;
  if (query.isPending || query.isError || query.data === undefined) {
    return fallback;
  }
  if (query.data === null) {
    return fallback;
  }
  return (
    <OpenableFileChip
      targetPath={query.data}
      theme={props.theme}
      {...(props.label !== undefined ? { label: props.label } : {})}
      {...(props.href ? { href: props.href } : {})}
    />
  );
}

// Shared openable file chip: the same mention-chip UI (file icon + medium label)
// used for both assistant markdown file links and inline code that names a file.
// A plain click prefers the surface's in-app viewer (right-dock file pane);
// meta/ctrl-click — or a surface without a viewer — opens the preferred
// external editor. `targetPath` may carry a `:line` suffix (used to open); the
// chip icon and title use the position-free path.
function OpenableFileChip(props: {
  targetPath: string;
  theme: "light" | "dark";
  label?: ReactNode;
  href?: string;
}) {
  const opener = useWorkspaceFileOpener();
  const chipPath = props.targetPath.replace(MARKDOWN_LINK_POSITION_SUFFIX_PATTERN, "");
  const revealPath = isLocalAbsolutePath(chipPath) ? chipPath : undefined;
  return (
    <InlineMentionChip
      path={chipPath}
      theme={props.theme}
      href={props.href ?? props.targetPath}
      onActivate={(event) => {
        event.preventDefault();
        event.stopPropagation();
        const forceExternalEditor = event.metaKey || event.ctrlKey;
        openWorkspaceFileReference(forceExternalEditor ? null : opener, props.targetPath);
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        event.stopPropagation();
        void showFileReferenceContextMenu({
          path: chipPath,
          ...(revealPath ? { revealPath } : {}),
          position: { x: event.clientX, y: event.clientY },
          onReferenceInChat: undefined,
        });
      }}
      {...(opener?.prefetchFile
        ? { onHoverPrefetch: () => opener.prefetchFile?.(props.targetPath) }
        : {})}
      {...(props.label !== undefined ? { label: props.label } : {})}
    />
  );
}

// Renders the custom element emitted by the composer-chips remark plugin with the
// shared chip components, so chips in a sent message match the composer exactly.
function ComposerChipElement(props: {
  serializedSegment: string | undefined;
  theme: "light" | "dark";
  mentionReferences: ReadonlyArray<ProviderMentionReference>;
}) {
  const segment = parseComposerChipSegment(props.serializedSegment);
  if (!segment) {
    return null;
  }
  if (segment.type === "skill") {
    return <InlineSkillChip skillName={segment.name} />;
  }
  if (segment.type === "mention") {
    return (
      <InlineMentionChip
        path={segment.path}
        theme={props.theme}
        mentionReferences={props.mentionReferences}
        {...(segment.kind ? { kind: segment.kind } : {})}
      />
    );
  }
  if (segment.type === "agent-mention") {
    return <InlineAgentChip alias={segment.alias} color={segment.color} />;
  }
  if (segment.type === "slash-command") {
    return <InlineSlashCommandChip command={segment.command} />;
  }
  return <InlineLinkChip url={segment.url} interactive />;
}

function CodeBlockHeaderTitle({ fence }: { fence: CodeFenceInfo }) {
  if (fence.isFileReference && fence.fileName) {
    return (
      <span className="chat-markdown-codeblock__file" title={fence.filePath ?? fence.fileName}>
        <CentralIcon
          name={getFileIconName(fence.filePath ?? fence.fileName)}
          className="chat-markdown-codeblock__file-icon"
        />
        <span className="chat-markdown-codeblock__file-name">{fence.fileName}</span>
        {fence.directory ? (
          <span className="chat-markdown-codeblock__file-dir">{fence.directory}</span>
        ) : null}
        {fence.lineRange ? (
          <span className="chat-markdown-codeblock__file-lines">{fence.lineRange}</span>
        ) : null}
      </span>
    );
  }

  const label =
    fence.language === "text" || fence.language === "plaintext" ? "Plain text" : fence.language;
  return (
    <span className="chat-markdown-codeblock__lang">
      <CentralIcon name="code" className="size-4 shrink-0" />
      {label}
    </span>
  );
}

function MarkdownCodeBlock({
  code,
  fence,
  children,
  direction,
}: {
  code: string;
  fence: CodeFenceInfo;
  children: ReactNode;
  direction?: "ltr" | undefined;
}) {
  const { t } = useTranslation();
  const [copied, setCopied] = useState(false);
  const [wrap, setWrap] = useState(false);
  const copiedTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const handleCopy = () => {
    void copyTextToClipboard(code)
      .then(() => {
        if (copiedTimerRef.current != null) {
          clearTimeout(copiedTimerRef.current);
        }
        setCopied(true);
        copiedTimerRef.current = setTimeout(() => {
          setCopied(false);
          copiedTimerRef.current = null;
        }, 1200);
      })
      .catch(() => undefined);
  };
  const toggleWrap = () => setWrap((previous) => !previous);

  useEffect(
    () => () => {
      if (copiedTimerRef.current != null) {
        clearTimeout(copiedTimerRef.current);
        copiedTimerRef.current = null;
      }
    },
    [],
  );

  const wrapLabel = t(
    wrap ? "chat.markdown.code.disableSoftWrap" : "chat.markdown.code.enableSoftWrap",
  );
  const copyLabel = t(copied ? "chat.markdown.code.copied" : "chat.markdown.code.copy");

  return (
    <div className="chat-markdown-codeblock" data-wrap={wrap ? "true" : "false"} dir={direction}>
      <div className="chat-markdown-codeblock__header">
        <CodeBlockHeaderTitle fence={fence} />
        <div className="chat-markdown-codeblock__actions">
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={toggleWrap}
            title={wrapLabel}
            label={wrapLabel}
            aria-pressed={wrap}
            data-active={wrap ? "true" : "false"}
            size="icon-xs"
            variant="ghost"
          >
            <TextWrapIcon className="size-4" />
          </IconButton>
          <IconButton
            className="chat-markdown-codeblock__action"
            onClick={handleCopy}
            title={copyLabel}
            label={copyLabel}
            size="icon-xs"
            variant="ghost"
          >
            {copied ? <CheckIcon className="size-4" /> : <CopyIcon className="size-4" />}
          </IconButton>
        </div>
      </div>
      <div className="chat-markdown-codeblock__body">{children}</div>
    </div>
  );
}

interface SuspenseShikiCodeBlockProps {
  language: string;
  code: string;
  themeName: DiffThemeName;
  isStreaming: boolean;
  sourceOffset: number;
}

type SyntaxHighlightingModule = typeof import("../lib/syntaxHighlighting");
let syntaxHighlightingModulePromise: Promise<SyntaxHighlightingModule> | null = null;

function getSyntaxHighlightingModulePromise(): Promise<SyntaxHighlightingModule> {
  syntaxHighlightingModulePromise ??= import("../lib/syntaxHighlighting");
  return syntaxHighlightingModulePromise;
}

// While a message streams, its open code block grows on every reveal commit (~25/s) and
// each commit re-tokenizes the whole block — quadratic in block length and the single
// largest renderer cost of a code-heavy turn. Highlight at most this often while
// streaming; the prefix already on screen stays put and the trailing value always lands,
// so the block converges to exactly the settled highlight.
// Each highlight costs roughly linearly in block length, so the cadence also stretches
// with size: small blocks stay at the base interval, a block at
// `STREAMING_CODE_HIGHLIGHT_SLOW_CHARS` is highlighted at most once per
// `STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS`, keeping per-second tokenization work bounded.
const STREAMING_CODE_HIGHLIGHT_INTERVAL_MS = 160;
const STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS = 1_000;
const STREAMING_CODE_HIGHLIGHT_BASE_CHARS = 8_000;
const STREAMING_CODE_HIGHLIGHT_SLOW_CHARS = 80_000;

export function streamingCodeHighlightIntervalMs(codeLength: number): number {
  if (codeLength <= STREAMING_CODE_HIGHLIGHT_BASE_CHARS) {
    return STREAMING_CODE_HIGHLIGHT_INTERVAL_MS;
  }
  const progress = Math.min(
    1,
    (codeLength - STREAMING_CODE_HIGHLIGHT_BASE_CHARS) /
      (STREAMING_CODE_HIGHLIGHT_SLOW_CHARS - STREAMING_CODE_HIGHLIGHT_BASE_CHARS),
  );
  return Math.round(
    STREAMING_CODE_HIGHLIGHT_INTERVAL_MS +
      progress * (STREAMING_CODE_HIGHLIGHT_MAX_INTERVAL_MS - STREAMING_CODE_HIGHLIGHT_INTERVAL_MS),
  );
}

function SuspenseShikiCodeBlock({
  language,
  code: liveCode,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps) {
  const code = useThrottledStreamingValue(
    liveCode,
    isStreaming,
    streamingCodeHighlightIntervalMs(liveCode.length),
  );
  const syntaxHighlighting = use(getSyntaxHighlightingModulePromise());
  return (
    <LoadedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
      sourceOffset={sourceOffset}
    />
  );
}

function LoadedShikiCodeBlock({
  syntaxHighlighting,
  language,
  code,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps & { syntaxHighlighting: SyntaxHighlightingModule }) {
  const cacheKey = syntaxHighlighting.createSyntaxHighlightCacheKey(code, language, themeName);
  const cachedHighlightedHtml = !isStreaming
    ? syntaxHighlighting.getCachedSyntaxHighlightedHtml(cacheKey)
    : null;

  if (cachedHighlightedHtml != null) {
    return <FindAwareShikiHtml html={cachedHighlightedHtml} sourceOffset={sourceOffset} />;
  }

  // The uncached path lives in its own component: an early return above must
  // not change this component's hook order once the cache fills.
  return (
    <UncachedShikiCodeBlock
      syntaxHighlighting={syntaxHighlighting}
      cacheKey={cacheKey}
      language={language}
      code={code}
      themeName={themeName}
      isStreaming={isStreaming}
      sourceOffset={sourceOffset}
    />
  );
}

function UncachedShikiCodeBlock({
  syntaxHighlighting,
  cacheKey,
  language,
  code,
  themeName,
  isStreaming,
  sourceOffset,
}: SuspenseShikiCodeBlockProps & {
  syntaxHighlighting: SyntaxHighlightingModule;
  cacheKey: string;
}) {
  const highlighter = use(syntaxHighlighting.getSyntaxHighlighterPromise(language));
  const highlightedHtml = syntaxHighlighting.highlightCodeToHtmlWithFallback(
    highlighter,
    code,
    language,
    themeName,
  );

  useEffect(() => {
    if (!isStreaming) {
      syntaxHighlighting.cacheSyntaxHighlightedHtml(cacheKey, highlightedHtml, code);
    }
  }, [cacheKey, code, highlightedHtml, isStreaming, syntaxHighlighting]);

  return <FindAwareShikiHtml html={highlightedHtml} sourceOffset={sourceOffset} />;
}

interface MarkdownRenderContextValue {
  isInsideLink: boolean;
  cwd: ChatMarkdownProps["cwd"];
  knownAbsoluteFilePaths: string[] | undefined;
  diffThemeName: DiffThemeName;
  isStreaming: boolean;
  isUserVariant: boolean;
  usesAutomaticBlockDirection: boolean;
  mentionReferences: ChatMarkdownProps["mentionReferences"];
  onImageExpand: ChatMarkdownProps["onImageExpand"];
  onOpenThread: ChatMarkdownProps["onOpenThread"];
  onTaskToggle: ChatMarkdownProps["onTaskToggle"];
  resolvedTheme: ReturnType<typeof useTheme>["resolvedTheme"];
  terminalContexts: ChatMarkdownProps["terminalContexts"];
  threadId: ChatMarkdownProps["threadId"];
  messageId: ChatMarkdownProps["messageId"];
  segmentIndex: ChatMarkdownProps["segmentIndex"];
  renderInlineVisualizations: boolean;
  onOpenInlineVisualization: ChatMarkdownProps["onOpenInlineVisualization"];
}

const MarkdownRenderContext = createContext<MarkdownRenderContextValue | null>(null);
// The raw message text changes with every streamed token; only code blocks and
// inline code normally read it, so it stays out of MarkdownRenderContext and
// settled prose, links, images and chips do not re-render per token.
const MarkdownSourceTextContext = createContext("");

// Stable component types preserve code highlighting timers, copy state and image state.
const GITHUB_ALERTS: Record<GithubAlertKind, { title: string; icon: LucideIcon }> = {
  note: { title: "Note", icon: InfoIcon },
  tip: { title: "Tip", icon: LightbulbIcon },
  important: { title: "Important", icon: InfoIcon },
  warning: { title: "Warning", icon: TriangleAlertIcon },
  caution: { title: "Caution", icon: OctagonAlertIcon },
};

function TechnicalBidiIsolate(props: { active: boolean; children: ReactNode }) {
  if (!props.active) {
    return <>{props.children}</>;
  }
  return (
    <bdi className="chat-markdown-technical-isolate" dir="ltr">
      {props.children}
    </bdi>
  );
}

function PythonBytesParagraph(props: {
  startOffset: number;
  endOffset: number;
  children: ReactNode;
  paragraphProps: React.ComponentPropsWithoutRef<"p">;
}) {
  const sourceText = useContext(MarkdownSourceTextContext);
  const raw = sourceText.slice(props.startOffset, props.endOffset);
  const decoded = decodePythonBytesLiteral(raw);
  return decoded !== null ? (
    <p {...props.paragraphProps} className="whitespace-pre-wrap" title={raw}>
      {decoded}
    </p>
  ) : (
    <p {...props.paragraphProps}>{props.children}</p>
  );
}

const MARKDOWN_COMPONENTS: Components = {
  p: function MarkdownParagraph({ node, children, ...props }) {
    const { isUserVariant } = useContext(MarkdownRenderContext)!;
    const start = node?.position?.start.offset;
    const end = node?.position?.end.offset;
    // Only potential complete Python bytes payloads subscribe to the changing
    // source string; ordinary settled paragraphs remain outside that hot path.
    if (
      !isUserVariant &&
      start !== undefined &&
      end !== undefined &&
      /^b['"]/i.test(nodeToPlainText(children).trim())
    ) {
      return (
        <PythonBytesParagraph startOffset={start} endOffset={end} paragraphProps={props}>
          {children}
        </PythonBytesParagraph>
      );
    }
    return <p {...props}>{children}</p>;
  },
  blockquote: function MarkdownBlockquote({ node: _node, children, ...props }) {
    const kind = (props as { "data-github-alert"?: GithubAlertKind })["data-github-alert"];
    const alert = kind ? GITHUB_ALERTS[kind] : undefined;
    if (!alert) return <blockquote {...props}>{children}</blockquote>;
    const Icon = alert.icon;
    return (
      <blockquote {...props}>
        <p className="markdown-alert-title">
          <Icon aria-hidden className="size-[1.1em] shrink-0" />
          {alert.title}
        </p>
        {children}
      </blockquote>
    );
  },
  a: function MarkdownLink({ node: _node, href, children, ...props }) {
    const context = useContext(MarkdownRenderContext)!;
    const {
      isUserVariant,
      usesAutomaticBlockDirection,
      cwd,
      knownAbsoluteFilePaths,
      resolvedTheme,
      onOpenThread,
    } = context;
    const linkedContext = useMemo(
      () => ({ ...context, onImageExpand: undefined, isInsideLink: true }),
      [context],
    );
    // Linked images belong to the link, not to the fullscreen gallery.
    const linkedChildren = (
      <MarkdownRenderContext.Provider value={linkedContext}>
        {children}
      </MarkdownRenderContext.Provider>
    );
    const linkActions = useContext(ChatLinkActionsContext);
    const restoredHref = href ? restoreLiteralDollarPlaceholders(href) : href;
    const threadHref = restoredHref?.startsWith("thread://")
      ? restoredHref.slice("thread://".length)
      : restoredHref?.startsWith("moss://thread/")
        ? decodeMossThreadLinkTarget(restoredHref.slice("moss://thread/".length))
        : null;
    if (threadHref && onOpenThread) {
      return (
        <button
          type="button"
          className="inline p-0 text-inherit underline decoration-foreground/30 underline-offset-2 hover:decoration-foreground/70"
          onClick={() => onOpenThread(ThreadId.makeUnsafe(threadHref))}
        >
          {linkedChildren}
        </button>
      );
    }
    const isExternalHttp = isExternalHttpHref(restoredHref);
    if (isUserVariant && isExternalHttp) {
      // GFM autolinks a pasted URL before the chips plugin can see it; when the
      // link text is just the URL itself, render the composer's link chip so a
      // pasted link looks identical in the composer and in the sent bubble.
      // Authored `[label](url)` links keep the regular anchor treatment below.
      const plainText = nodeToPlainText(children);
      if (
        plainText === restoredHref ||
        restoredHref === `http://${plainText}` ||
        restoredHref === `https://${plainText}`
      ) {
        return (
          <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
            <InlineLinkChip url={restoredHref} interactive />
          </TechnicalBidiIsolate>
        );
      }
    }
    const targetPath = isExternalHttp
      ? null
      : resolveChatFileChipTarget(restoredHref, cwd, knownAbsoluteFilePaths);
    if (!targetPath) {
      return (
        <a
          {...props}
          href={restoredHref}
          target="_blank"
          rel="noopener noreferrer"
          className={isExternalHttp ? MARKDOWN_EXTERNAL_LINK_CLASS_NAME : props.className}
          {...(isExternalHttp
            ? {
                // A plain click on a pull request or issue follows the user's setting (in
                // the app by default); cmd/ctrl-click keeps the default external open.
                onClick: (event: React.MouseEvent) => {
                  if (event.metaKey || event.ctrlKey) return;
                  const openGitHubItem = resolveGitHubItemClickOpener(restoredHref, linkActions);
                  if (!openGitHubItem) return;
                  event.preventDefault();
                  openGitHubItem(restoredHref);
                },
                onContextMenu: (event: React.MouseEvent) => {
                  event.preventDefault();
                  event.stopPropagation();
                  void showLinkContextMenu({
                    url: restoredHref,
                    position: { x: event.clientX, y: event.clientY },
                    actions: linkActions,
                  });
                },
              }
            : {})}
        >
          {isExternalHttp ? (
            <LinkChipIcon url={restoredHref} className={MARKDOWN_EXTERNAL_LINK_ICON_CLASS_NAME} />
          ) : null}
          {linkedChildren}
        </a>
      );
    }

    return (
      <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
        <OpenableFileChip
          targetPath={targetPath}
          theme={resolvedTheme}
          label={
            usesAutomaticBlockDirection ? <bdi dir="auto">{linkedChildren}</bdi> : linkedChildren
          }
          {...(restoredHref ? { href: restoredHref } : {})}
        />
      </TechnicalBidiIsolate>
    );
  },
  pre: function MarkdownPre({ node, children, ...props }) {
    const { diffThemeName, isStreaming, isUserVariant, usesAutomaticBlockDirection } =
      useContext(MarkdownRenderContext)!;
    const sourceText = useContext(MarkdownSourceTextContext);
    const renderInlineVisual = useContext(InlineVisualEmbedContext);
    const codeBlock = extractCodeBlock(children);
    if (!codeBlock) {
      return <pre {...props}>{children}</pre>;
    }

    const rawFenceInfo = extractRawFenceInfo(codeBlock.className);
    // An agent places a visual in its reply with a fence naming the visual id.
    // Only this transcript's own visuals render; anything else stays code.
    if (
      (rawFenceInfo === INLINE_VISUAL_EMBED_FENCE ||
        rawFenceInfo === INLINE_VISUAL_EMBED_FENCE_UPSTREAM_ALIAS) &&
      renderInlineVisual &&
      !isUserVariant
    ) {
      const visualId = readInlineVisualEmbedId(dedentCode(codeBlock.code));
      const visual = visualId === null ? null : renderInlineVisual(visualId);
      if (visual !== null) return <div className="my-4 first:mt-0 last:mb-0">{visual}</div>;
      // The fence streams in before its id is complete.
      if (isStreaming && visualId === null) return null;
    }
    const fence = parseCodeFenceInfo(rawFenceInfo);

    const code = dedentCode(codeBlock.code);
    const blockStart = node?.position?.start?.offset ?? 0;
    const codeOffsetInSource = sourceText.indexOf(code, blockStart);
    const sourceOffset = codeOffsetInSource < 0 ? blockStart : codeOffsetInSource;
    const highlightedFallback = (
      <pre {...props}>
        <FindAwareCodeFallback code={code} sourceOffset={sourceOffset}>
          {children}
        </FindAwareCodeFallback>
      </pre>
    );

    return (
      <MarkdownCodeBlock
        code={code}
        fence={fence}
        direction={usesAutomaticBlockDirection ? "ltr" : undefined}
      >
        {code.length > MAX_SYNTAX_HIGHLIGHT_INPUT_CHARS ? (
          highlightedFallback
        ) : (
          <CodeHighlightErrorBoundary fallback={highlightedFallback}>
            <Suspense fallback={highlightedFallback}>
              <SuspenseShikiCodeBlock
                language={fence.language}
                code={code}
                themeName={diffThemeName}
                isStreaming={isStreaming}
                sourceOffset={sourceOffset}
              />
            </Suspense>
          </CodeHighlightErrorBoundary>
        )}
      </MarkdownCodeBlock>
    );
  },
  code: function MarkdownInlineCode({ node, className, children, ...props }) {
    const {
      knownAbsoluteFilePaths,
      cwd,
      resolvedTheme,
      isUserVariant,
      usesAutomaticBlockDirection,
    } = useContext(MarkdownRenderContext)!;
    const sourceText = useContext(MarkdownSourceTextContext);
    const codeSource = sourceText.slice(node?.position?.start?.offset, node?.position?.end?.offset);
    if (!isUserVariant && !className && codeSource.startsWith("`") && !codeSource.includes("\n")) {
      const raw = nodeToPlainText(children);
      const decoded = decodePythonBytesLiteral(raw);
      if (decoded !== null) {
        return (
          <code {...props} className="whitespace-pre-wrap" title={raw}>
            {decoded}
          </code>
        );
      }
    }
    // Fenced blocks carry a `language-*` class and are rendered by `pre`;
    // only inline code (no class) that names a file becomes an openable
    // mention chip. Absolute local paths chip immediately. Relative names
    // chip only when that file actually exists in the chat workspace.
    if (!className) {
      const filePath = inlineCodeFilePath(nodeToPlainText(children));
      if (filePath) {
        const nodeStart = node?.position?.start?.offset ?? 0;
        const filePathOffset = sourceText.indexOf(filePath, nodeStart);
        const sourceOffset = filePathOffset < 0 ? nodeStart : filePathOffset;
        const findLabelProps = {
          label: <FindAwareMarkdownText text={filePath} sourceOffset={sourceOffset} />,
        };
        const knownTarget = resolveChatFileChipTarget(filePath, undefined, knownAbsoluteFilePaths);
        if (knownTarget) {
          return (
            <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
              <OpenableFileChip
                targetPath={knownTarget}
                theme={resolvedTheme}
                {...findLabelProps}
              />
            </TechnicalBidiIsolate>
          );
        }
        if (resolveMarkdownFileLinkTarget(filePath, cwd) && cwd) {
          return (
            <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
              <VerifiedWorkspaceFileChip
                rawReference={filePath}
                cwd={cwd}
                theme={resolvedTheme}
                {...findLabelProps}
              />
            </TechnicalBidiIsolate>
          );
        }
      }
    }
    return (
      <code className={className} {...props} dir={usesAutomaticBlockDirection ? "ltr" : undefined}>
        {children}
      </code>
    );
  },
  img: function MarkdownImage({ node: _node, src, alt: altProp, ...props }) {
    const { cwd, onImageExpand, isInsideLink } = useContext(MarkdownRenderContext)!;
    const alt = altProp ?? "";
    const restoredSrc = src ? restoreLiteralDollarPlaceholders(src) : "";
    if (isLocalImageMarkdownSrc(restoredSrc)) {
      return (
        <GeneratedMarkdownImage
          src={restoredSrc}
          alt={alt}
          cwd={cwd}
          onImageExpand={onImageExpand}
          isLinked={isInsideLink}
        />
      );
    }
    if (!onImageExpand || !restoredSrc) {
      return <img {...props} src={restoredSrc} alt={alt} loading="lazy" />;
    }
    const expandImage = (event: SyntheticEvent<HTMLImageElement>) => {
      event.preventDefault();
      onImageExpand(
        { images: [{ src: restoredSrc, name: alt || "Image" }], index: 0 },
        event.currentTarget,
      );
    };
    return (
      <img
        {...props}
        src={restoredSrc}
        alt={alt}
        loading="lazy"
        role="button"
        tabIndex={0}
        data-expandable-image=""
        onClick={expandImage}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") expandImage(event);
        }}
      />
    );
  },
  li: function MarkdownListItem({ node, children, ...props }) {
    // Task items carry their source line down to the checkbox via context.
    const isTaskItem =
      typeof props.className === "string" && props.className.includes("task-list-item");
    const sourceLine = node?.position?.start.line ?? null;
    if (!isTaskItem || sourceLine === null) {
      return <li {...props}>{children}</li>;
    }
    return (
      <li {...props}>
        <TaskItemSourceLineContext.Provider value={sourceLine}>
          {children}
        </TaskItemSourceLineContext.Provider>
      </li>
    );
  },
  input: function MarkdownInput({ node: _node, ...props }) {
    const { onTaskToggle } = useContext(MarkdownRenderContext)!;
    if (props.type === "checkbox") {
      return <MarkdownTaskCheckbox checked={props.checked === true} onTaskToggle={onTaskToggle} />;
    }
    return <input {...props} />;
  },
  // Custom elements emitted by the composer-chips remark plugin (user
  // variant only; they never appear in assistant markdown). `Components`
  // only models intrinsic tags, so these entries are typed on their own
  // and cast into the map.
  ...({
    [COMPOSER_CHIP_TAG_NAME]: function MarkdownComposerChip(props: {
      className?: string | undefined;
      [COMPOSER_CHIP_SEGMENT_ATTRIBUTE]?: string | undefined;
    }) {
      const { resolvedTheme, mentionReferences, usesAutomaticBlockDirection } =
        useContext(MarkdownRenderContext)!;
      return (
        <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
          <ComposerChipElement
            serializedSegment={props[COMPOSER_CHIP_SEGMENT_ATTRIBUTE]}
            theme={resolvedTheme}
            mentionReferences={mentionReferences ?? []}
          />
        </TechnicalBidiIsolate>
      );
    },
    [TERMINAL_CONTEXT_CHIP_TAG_NAME]: function MarkdownTerminalChip(props: {
      [TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE]?: string | undefined;
    }) {
      const { terminalContexts, usesAutomaticBlockDirection } = useContext(MarkdownRenderContext)!;
      const rawIndex = props[TERMINAL_CONTEXT_CHIP_INDEX_ATTRIBUTE];
      const index = rawIndex === undefined ? Number.NaN : Number.parseInt(rawIndex, 10);
      const context = Number.isInteger(index) ? terminalContexts?.[index] : undefined;
      if (!context) {
        return null;
      }
      const tooltipText =
        context.body.length > 0 ? `${context.header}\n${context.body}` : context.header;
      return (
        <TechnicalBidiIsolate active={usesAutomaticBlockDirection}>
          <TerminalContextInlineChip label={context.header} tooltipText={tooltipText} />
        </TechnicalBidiIsolate>
      );
    },
    [CHAT_FIND_TEXT_TAG_NAME]: function MarkdownFindText(props: {
      children?: ReactNode;
      [CHAT_FIND_TEXT_START_ATTRIBUTE]?: string | undefined;
    }) {
      const rawSourceOffset = props[CHAT_FIND_TEXT_START_ATTRIBUTE];
      const sourceOffset =
        rawSourceOffset === undefined ? Number.NaN : Number.parseInt(rawSourceOffset, 10);
      const text = nodeToPlainText(props.children);
      if (!Number.isFinite(sourceOffset) || text.length === 0) {
        return <>{props.children}</>;
      }
      return <StreamingMarkdownText text={text} sourceOffset={sourceOffset} />;
    },
    [INLINE_VISUALIZATION_TAG_NAME]: function MarkdownInlineVisualization(props: {
      [INLINE_VISUALIZATION_DATA_ATTRIBUTE]?: string | undefined;
    }) {
      const { isUserVariant, renderInlineVisualizations, threadId, onOpenInlineVisualization } =
        useContext(MarkdownRenderContext)!;
      const directive = readInlineVisualizationDirective(
        props[INLINE_VISUALIZATION_DATA_ATTRIBUTE],
      );
      // The transformer runs only for assistant Markdown. Retain this guard so
      // a crafted user custom node can never request a local provider file.
      if (isUserVariant || !renderInlineVisualizations || !directive) return null;
      // React Markdown normalizes custom data attributes. Reparse the original
      // marker so its local path survives that DOM-property conversion.
      return (
        <InlineVisualizationFrame
          threadId={threadId}
          directive={parseInlineVisualizationDirective(directive.source) ?? directive}
          {...(onOpenInlineVisualization ? { onOpen: onOpenInlineVisualization } : {})}
        />
      );
    },
    [OPENUI_TAG_NAME]: function MarkdownOpenUIVisualization(props: {
      [OPENUI_DATA_ATTRIBUTE]?: string | undefined;
      node?: { position?: { start?: { offset?: number } } } | undefined;
    }) {
      const {
        isUserVariant,
        renderInlineVisualizations,
        threadId,
        messageId,
        segmentIndex,
        isStreaming,
      } = useContext(MarkdownRenderContext)!;
      const directive = readOpenUIDirective(props[OPENUI_DATA_ATTRIBUTE]);
      // Same guard as the iframe track: only assistant Markdown may render
      // model-authored component programs.
      if (isUserVariant || !renderInlineVisualizations || !directive) return null;
      return (
        <OpenUIFrame
          threadId={threadId}
          messageId={messageId}
          segmentIndex={segmentIndex}
          blockOffset={props.node?.position?.start?.offset}
          directive={directive}
          isStreaming={isStreaming}
        />
      );
    },
  } as unknown as Components),
};

function stringArraysEqual(previous: readonly string[], next: readonly string[]): boolean {
  return previous.length === next.length && previous.every((value, index) => value === next[index]);
}

function ChatMarkdown({
  text,
  cwd,
  wikiLinkRoot,
  directionMode: directionModeProp,
  isStreaming: isStreamingProp,
  className: classNameProp,
  style,
  protectTranslation: protectTranslationProp,
  onImageExpand,
  markers,
  findQuery: findQueryProp,
  findActiveRange: findActiveRangeProp,
  onTaskToggle,
  knownAbsoluteFilePaths: knownAbsoluteFilePathsProp,
  variant: variantProp,
  mentionReferences,
  terminalContexts,
  onOpenThread,
  parseHtml: parseHtmlProp,
  threadId,
  messageId,
  segmentIndex,
  renderInlineVisualizations: renderInlineVisualizationsProp,
  onOpenInlineVisualization,
}: ChatMarkdownProps) {
  // Defaults applied with ?? in the body, not in the destructuring: default
  // values in parameter destructuring make React Compiler 1.0.0 bail on the
  // whole component (BuildHIR AssignmentPattern), losing its auto-memoization.
  const isStreaming = isStreamingProp ?? false;
  const directionMode = directionModeProp ?? "off";
  const usesAutomaticBlockDirection = directionMode === "auto-blocks";
  const className = classNameProp ?? "text-chat leading-relaxed";
  const protectTranslation = protectTranslationProp ?? true;
  const variant = variantProp ?? "assistant";
  const parseHtml = parseHtmlProp ?? false;
  const renderInlineVisualizations =
    renderInlineVisualizationsProp === true && variant === "assistant";
  const findQuery = findQueryProp ?? "";
  const findActiveRange = findActiveRangeProp ?? null;
  const { resolvedTheme } = useTheme();
  const diffThemeName = resolveDiffThemeName(resolvedTheme);
  const isUserVariant = variant === "user";
  // A fresh array per streamed token would rebuild the render context and
  // re-render every link and code node; keep it while its paths are unchanged.
  const extractedAbsoluteFilePaths = useStableValue(
    useMemo(() => extractAbsoluteFilesystemPaths(text), [text]),
    stringArraysEqual,
  );
  const knownAbsoluteFilePaths = useMemo(() => {
    if (
      (knownAbsoluteFilePathsProp === undefined || knownAbsoluteFilePathsProp.length === 0) &&
      extractedAbsoluteFilePaths.length === 0
    ) {
      return undefined;
    }
    return [...new Set([...(knownAbsoluteFilePathsProp ?? []), ...extractedAbsoluteFilePaths])];
  }, [extractedAbsoluteFilePaths, knownAbsoluteFilePathsProp]);
  // Reveal streamed text at a steady, adaptive cadence so tokens appear fluidly instead of
  // in the ~100ms network clumps that land in the store. No-ops (returns `text`) when not
  // streaming or under reduced motion. Governs cadence only; the deferred value below still
  // bounds the markdown re-parse cost.
  const smoothedText = useSmoothStreamedText(text, isStreaming);
  // The dollar rewrite exists to disambiguate math from currency; the user
  // variant has no math, so its text must stay byte-for-byte what was typed.
  // Table repair runs first so find offsets use the same normalized text.
  const sourceText = useMemo(
    () => (isUserVariant ? text : repairMarkdownTableDelimiters(text)),
    [isUserVariant, text],
  );
  const normalizedText = useMemo(() => {
    if (isUserVariant) return smoothedText;
    // Once the reveal has caught up (and always outside streaming) the smoothed
    // text is the raw text, whose repair is already done above.
    const repairedText =
      smoothedText === text ? sourceText : repairMarkdownTableDelimiters(smoothedText);
    return protectLiteralMarkdownDollars(repairedText);
  }, [isUserVariant, smoothedText, text, sourceText]);
  // While streaming, let React deprioritize and coalesce the markdown re-parse so a
  // fast token stream (one flush per ~100ms) doesn't re-render the full ReactMarkdown
  // tree on every flush. The deferred value always converges to the latest text, and
  // completed messages render the exact current text immediately (no visual change).
  const deferredNormalizedText = useDeferredValue(normalizedText);
  const renderedText = isStreaming ? deferredNormalizedText : normalizedText;
  // Marker offsets are applied against mdast positions, which come from the
  // repaired text — validate them against the same string. A marker recorded
  // after a repaired delimiter row fails its `selectedText` check and is
  // dropped instead of highlighting a shifted range.
  const markerSourceText = markers?.length ? sourceText : "";
  const rangeDecorationRemarkPlugin = useMemo<MarkdownRemarkPlugins[number]>(() => {
    return [
      remarkTextRangeDecorations,
      { decorations: threadMarkerDecorations({ text: markerSourceText, markers }) },
    ];
  }, [markers, markerSourceText]);
  // Only streaming assistant markdown is split; authored HTML previews go
  // through rehype-raw, which re-parses positions, and are never streamed.
  const splitBlocks = isStreaming && !isUserVariant && !parseHtml;
  const animateStreamingText = isStreaming && !isUserVariant && typeof window !== "undefined";
  // Find ranges are empty without a query; keep the provider's value stable
  // then instead of recomputing it (and every text node) per streamed token.
  const findSourceText = normalizeFindQuery(findQuery).length > 0 ? sourceText : "";
  const composerChipsRemarkPlugin = useMemo(
    () =>
      isUserVariant
        ? createComposerChipsRemarkPlugin(
            mentionReferences ?? [],
            (terminalContexts ?? []).map((context, index) => ({
              label: formatInlineTerminalContextLabel(context.header),
              index,
            })),
          )
        : null,
    [isUserVariant, mentionReferences, terminalContexts],
  );
  const remarkPlugins = useMemo<MarkdownRemarkPlugins>(() => {
    if (composerChipsRemarkPlugin) {
      return [
        ...USER_MARKDOWN_REMARK_PLUGINS,
        composerChipsRemarkPlugin,
        rangeDecorationRemarkPlugin,
        remarkFindableText,
      ];
    }
    return [
      ...MARKDOWN_REMARK_PLUGINS,
      [remarkWikiLinks, { root: wikiLinkRoot ?? cwd }],
      ...(renderInlineVisualizations
        ? [remarkInlineVisualizationDirectives, remarkOpenUIDirectives]
        : []),
      rangeDecorationRemarkPlugin,
      remarkFindableText,
    ];
  }, [
    composerChipsRemarkPlugin,
    rangeDecorationRemarkPlugin,
    renderInlineVisualizations,
    wikiLinkRoot,
    cwd,
  ]);
  const rehypePlugins = useMemo<MarkdownRehypePlugins>(() => {
    const basePlugins: MarkdownRehypePlugins = isUserVariant
      ? USER_MARKDOWN_REHYPE_PLUGINS
      : parseHtml
        ? // Raw HTML is only enabled for authored local-file previews. Sanitize
          // immediately after parsing so scripts, event handlers, and unsafe URL
          // schemes never reach React's renderer.
          [rehypeRaw, [rehypeSanitize, AUTHORED_HTML_SCHEMA], ...MARKDOWN_REHYPE_PLUGINS]
        : MARKDOWN_REHYPE_PLUGINS;
    return usesAutomaticBlockDirection
      ? ([...basePlugins, rehypeBidiBlockDirection] as MarkdownRehypePlugins)
      : basePlugins;
  }, [isUserVariant, parseHtml, usesAutomaticBlockDirection]);
  const rootRef = useRef<HTMLDivElement | null>(null);
  useLayoutEffect(() => {
    applyActiveChatFindMatch(rootRef.current, findActiveRange);
  }, [findActiveRange, findQuery, renderedText]);
  const renderContext = useMemo<MarkdownRenderContextValue>(
    () => ({
      isInsideLink: false,
      cwd,
      knownAbsoluteFilePaths,
      diffThemeName,
      isStreaming,
      isUserVariant,
      usesAutomaticBlockDirection,
      mentionReferences,
      onImageExpand,
      onOpenThread,
      onTaskToggle,
      resolvedTheme,
      terminalContexts,
      threadId,
      messageId,
      segmentIndex,
      renderInlineVisualizations,
      onOpenInlineVisualization,
    }),
    [
      cwd,
      knownAbsoluteFilePaths,
      diffThemeName,
      isStreaming,
      isUserVariant,
      usesAutomaticBlockDirection,
      mentionReferences,
      onImageExpand,
      onOpenThread,
      onTaskToggle,
      resolvedTheme,
      terminalContexts,
      threadId,
      messageId,
      segmentIndex,
      renderInlineVisualizations,
      onOpenInlineVisualization,
    ],
  );

  return (
    <div
      data-direction-mode={directionMode}
      data-codex-streaming={animateStreamingText ? "true" : undefined}
      data-translation-skip={protectTranslation ? "true" : undefined}
      {...(usesAutomaticBlockDirection ? { "data-direction-mode": "auto-blocks" } : {})}
      className={`chat-markdown ${isUserVariant ? "chat-markdown--user " : ""}w-full min-w-0 ${className} ${isUserVariant ? "text-inherit" : "text-foreground"}`}
      style={
        {
          "--markdown-font-size": style?.fontSize ?? "var(--codex-chat-font-size)",
          ...style,
        } as CSSProperties
      }
    >
      <ChatFindRenderProvider
        query={findQuery}
        sourceText={findSourceText}
        activeRange={findActiveRange}
      >
        <MarkdownRenderContext.Provider value={renderContext}>
          <MarkdownSourceTextContext.Provider value={sourceText}>
            <StreamingMarkdownProvider active={animateStreamingText}>
              <ParsedMarkdown
                text={renderedText}
                splitBlocks={splitBlocks}
                remarkPlugins={remarkPlugins}
                rehypePlugins={rehypePlugins}
                components={MARKDOWN_COMPONENTS}
              />
            </StreamingMarkdownProvider>
          </MarkdownSourceTextContext.Provider>
        </MarkdownRenderContext.Provider>
      </ChatFindRenderProvider>
    </div>
  );
}

export default memo(ChatMarkdown);
