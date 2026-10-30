import { LexicalComposer, type InitialConfigType } from "@lexical/react/LexicalComposer";
import { useLexicalComposerContext } from "@lexical/react/LexicalComposerContext";
import { ContentEditable } from "@lexical/react/LexicalContentEditable";
import { LexicalErrorBoundary } from "@lexical/react/LexicalErrorBoundary";
import { HistoryPlugin } from "@lexical/react/LexicalHistoryPlugin";
import { OnChangePlugin } from "@lexical/react/LexicalOnChangePlugin";
import { PlainTextPlugin } from "@lexical/react/LexicalPlainTextPlugin";
import {
  $createRangeSelection,
  $getSelection,
  $setSelection,
  $isElementNode,
  $isLineBreakNode,
  $isRangeSelection,
  $isTextNode,
  $createLineBreakNode,
  $createParagraphNode,
  $createTextNode,
  KEY_ARROW_DOWN_COMMAND,
  KEY_ARROW_LEFT_COMMAND,
  KEY_ARROW_RIGHT_COMMAND,
  KEY_ARROW_UP_COMMAND,
  KEY_DOWN_COMMAND,
  KEY_ENTER_COMMAND,
  KEY_TAB_COMMAND,
  COMPOSITION_START_COMMAND,
  COMPOSITION_END_COMMAND,
  BLUR_COMMAND,
  COMMAND_PRIORITY_HIGH,
  COMMAND_PRIORITY_LOW,
  KEY_BACKSPACE_COMMAND,
  PASTE_COMMAND,
  PASTE_TAG,
  $addUpdateTag,
  TextNode,
  $getRoot,
  $nodesOfType,
  type ElementNode,
  type LexicalNode,
  type EditorState,
} from "lexical";
import {
  createContext,
  forwardRef,
  Fragment,
  memo,
  useCallback,
  useContext,
  useEffect,
  useId,
  useImperativeHandle,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ClipboardEventHandler,
  type Ref,
} from "react";

import {
  clampCollapsedComposerCursor,
  collapseExpandedComposerCursor,
  expandCollapsedComposerCursor,
  isCollapsedCursorAdjacentToInlineToken,
} from "~/composer-logic";
import {
  matchComposerLinkToken,
  matchComposerSlashCommandChipToken,
  splitPromptIntoComposerSegments,
  type ComposerPromptSegment,
} from "~/composer-editor-mentions";
import { parseBareComposerLink } from "~/lib/linkChips";
import { type TerminalContextDraft } from "~/lib/terminalContext";
import { shouldCollapsePastedText } from "~/lib/composerPastedText";
import type { ProviderKind, ProviderMentionReference } from "@synara/contracts";
import { useStore } from "~/store";
import { createComposerThreadMentionSourcesSelector } from "~/storeSelectors";
import { resolveThreadDisplayProvider } from "~/lib/threadDisplayProvider";
import { cn } from "~/lib/utils";
import {
  COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
  COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
} from "./chat/composerPickerStyles";
import {
  ComposerMentionNode,
  ComposerSkillNode,
  ComposerSlashCommandNode,
  ComposerAgentMentionNode,
  ComposerTerminalContextNode,
  ComposerLinkNode,
  $createComposerMentionNode,
  $createComposerSkillNode,
  $createComposerSlashCommandNode,
  $createComposerAgentMentionNode,
  $createComposerTerminalContextNode,
  $createComposerLinkNode,
  isComposerInlineTokenNode,
  COMPOSER_NODE_CLASSES,
  ComposerLinkChip,
  createComposerInlineChipDom,
  normalizeComposerSkillName,
  type ComposerInlineChip,
  type ComposerInlineTokenNode,
} from "./composer-nodes";
import { COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME } from "./composerInlineChip";

const COMPOSER_EDITOR_HMR_KEY = `composer-editor-${Math.random().toString(36).slice(2)}`;

const ComposerRemoveTerminalContextContext = createContext<(contextId: string) => void>(() => {});

// Node classes imported from ./composer-nodes

function terminalContextSignature(contexts: ReadonlyArray<TerminalContextDraft>): string {
  return contexts
    .map((context) =>
      [
        context.id,
        context.threadId,
        context.terminalId,
        context.terminalLabel,
        context.lineStart,
        context.lineEnd,
        context.createdAt,
        context.text,
      ].join("\u001f"),
    )
    .join("\u001e");
}

function mentionReferencesSignature(mentions: ReadonlyArray<ProviderMentionReference>): string {
  return mentions.map((mention) => `${mention.name}\u0000${mention.path}`).join("\u0001");
}

function clampExpandedCursor(value: string, cursor: number): number {
  if (!Number.isFinite(cursor)) return value.length;
  return Math.max(0, Math.min(value.length, Math.floor(cursor)));
}

function getComposerInlineTokenTextLength(_node: ComposerInlineTokenNode): 1 {
  return 1;
}

function getComposerInlineTokenExpandedTextLength(node: ComposerInlineTokenNode): number {
  return node.getTextContentSize();
}

function getAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenTextLength(node) : 0);
}

function getExpandedAbsoluteOffsetForInlineTokenPoint(
  node: ComposerInlineTokenNode,
  absoluteOffset: number,
  pointOffset: number,
): number {
  return absoluteOffset + (pointOffset > 0 ? getComposerInlineTokenExpandedTextLength(node) : 0);
}

function findSelectionPointForInlineToken(
  node: ComposerInlineTokenNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "element" } | null {
  const parent = node.getParent();
  if (!parent || !$isElementNode(parent)) return null;
  const index = node.getIndexWithinParent();
  if (remainingRef.value === 0) {
    return {
      key: parent.getKey(),
      offset: index,
      type: "element",
    };
  }
  if (remainingRef.value === getComposerInlineTokenTextLength(node)) {
    return {
      key: parent.getKey(),
      offset: index + 1,
      type: "element",
    };
  }
  remainingRef.value -= getComposerInlineTokenTextLength(node);
  return null;
}

function getComposerNodeTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node.getChildren().reduce((total, child) => total + getComposerNodeTextLength(child), 0);
  }
  return 0;
}

function getComposerNodeExpandedTextLength(node: LexicalNode): number {
  if (isComposerInlineTokenNode(node)) {
    return getComposerInlineTokenExpandedTextLength(node);
  }
  if ($isTextNode(node)) {
    return node.getTextContentSize();
  }
  if ($isLineBreakNode(node)) {
    return 1;
  }
  if ($isElementNode(node)) {
    return node
      .getChildren()
      .reduce((total, child) => total + getComposerNodeExpandedTextLength(child), 0);
  }
  return 0;
}

function getAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeTextLength(sibling);
    }
    current = nextParent;
  }

  if (node instanceof ComposerLinkNode || node instanceof ComposerTerminalContextNode) {
    return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isTextNode(node)) {
    if (
      node instanceof ComposerMentionNode ||
      node instanceof ComposerSkillNode ||
      node instanceof ComposerSlashCommandNode ||
      node instanceof ComposerAgentMentionNode
    ) {
      return getAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeTextLength(child);
    }
    return offset;
  }

  return offset;
}

function getExpandedAbsoluteOffsetForPoint(node: LexicalNode, pointOffset: number): number {
  let offset = 0;
  let current: LexicalNode | null = node;

  while (current) {
    const nextParent = current.getParent() as LexicalNode | null;
    if (!nextParent || !$isElementNode(nextParent)) {
      break;
    }
    const siblings = nextParent.getChildren();
    const index = current.getIndexWithinParent();
    for (let i = 0; i < index; i += 1) {
      const sibling = siblings[i];
      if (!sibling) continue;
      offset += getComposerNodeExpandedTextLength(sibling);
    }
    current = nextParent;
  }

  if (node instanceof ComposerLinkNode || node instanceof ComposerTerminalContextNode) {
    return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
  }

  if ($isTextNode(node)) {
    if (
      node instanceof ComposerMentionNode ||
      node instanceof ComposerSkillNode ||
      node instanceof ComposerSlashCommandNode ||
      node instanceof ComposerAgentMentionNode
    ) {
      return getExpandedAbsoluteOffsetForInlineTokenPoint(node, offset, pointOffset);
    }
    return offset + Math.min(pointOffset, node.getTextContentSize());
  }

  if ($isLineBreakNode(node)) {
    return offset + Math.min(pointOffset, 1);
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    const clampedOffset = Math.max(0, Math.min(pointOffset, children.length));
    for (let i = 0; i < clampedOffset; i += 1) {
      const child = children[i];
      if (!child) continue;
      offset += getComposerNodeExpandedTextLength(child);
    }
    return offset;
  }

  return offset;
}

function findSelectionPointAtOffset(
  node: LexicalNode,
  remainingRef: { value: number },
): { key: string; offset: number; type: "text" | "element" } | null {
  if (
    node instanceof ComposerMentionNode ||
    node instanceof ComposerSkillNode ||
    node instanceof ComposerSlashCommandNode ||
    node instanceof ComposerAgentMentionNode ||
    node instanceof ComposerLinkNode ||
    node instanceof ComposerTerminalContextNode
  ) {
    return findSelectionPointForInlineToken(node, remainingRef);
  }

  if ($isTextNode(node)) {
    const size = node.getTextContentSize();
    if (remainingRef.value <= size) {
      return {
        key: node.getKey(),
        offset: remainingRef.value,
        type: "text",
      };
    }
    remainingRef.value -= size;
    return null;
  }

  if ($isLineBreakNode(node)) {
    const parent = node.getParent();
    if (!parent) return null;
    const index = node.getIndexWithinParent();
    if (remainingRef.value === 0) {
      return {
        key: parent.getKey(),
        offset: index,
        type: "element",
      };
    }
    if (remainingRef.value === 1) {
      return {
        key: parent.getKey(),
        offset: index + 1,
        type: "element",
      };
    }
    remainingRef.value -= 1;
    return null;
  }

  if ($isElementNode(node)) {
    const children = node.getChildren();
    for (const child of children) {
      const point = findSelectionPointAtOffset(child, remainingRef);
      if (point) {
        return point;
      }
    }
    if (remainingRef.value === 0) {
      return {
        key: node.getKey(),
        offset: children.length,
        type: "element",
      };
    }
  }

  return null;
}

function $getComposerRootLength(): number {
  const root = $getRoot();
  const children = root.getChildren();
  return children.reduce((sum, child) => sum + getComposerNodeTextLength(child), 0);
}

function $setSelectionAtComposerOffset(nextOffset: number): void {
  const root = $getRoot();
  const composerLength = $getComposerRootLength();
  const boundedOffset = Math.max(0, Math.min(nextOffset, composerLength));
  const remainingRef = { value: boundedOffset };
  const point = findSelectionPointAtOffset(root, remainingRef) ?? {
    key: root.getKey(),
    offset: root.getChildren().length,
    type: "element" as const,
  };
  const selection = $createRangeSelection();
  selection.anchor.set(point.key, point.offset, point.type);
  selection.focus.set(point.key, point.offset, point.type);
  $setSelection(selection);
}

function $readSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const composerLength = $getComposerRootLength();
  return Math.max(0, Math.min(offset, composerLength));
}

function $readExpandedSelectionOffsetFromEditorState(fallback: number): number {
  const selection = $getSelection();
  if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
    return fallback;
  }
  const anchorNode = selection.anchor.getNode();
  const offset = getExpandedAbsoluteOffsetForPoint(anchorNode, selection.anchor.offset);
  const expandedLength = $getRoot().getTextContent().length;
  return Math.max(0, Math.min(offset, expandedLength));
}

function $appendTextWithLineBreaks(parent: ElementNode, text: string): void {
  const lines = text.split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] ?? "";
    if (line.length > 0) {
      parent.append($createTextNode(line));
    }
    if (index < lines.length - 1) {
      parent.append($createLineBreakNode());
    }
  }
}

type ComposerPromptSegmentOf<T extends ComposerPromptSegment["type"]> = Extract<
  ComposerPromptSegment,
  { type: T }
>;

function resolveMentionSegmentProvider(
  segment: ComposerPromptSegmentOf<"mention">,
): ProviderKind | undefined {
  const thread = segment.threadId
    ? useStore.getState().sidebarThreadSummaryById[segment.threadId]
    : undefined;
  return thread ? resolveThreadDisplayProvider(thread) : undefined;
}

function composerSkillSegmentName(segment: ComposerPromptSegmentOf<"skill">): string {
  return `${segment.prefix ?? "$"}${segment.name}`;
}

const ComposerPredictionChip = memo(
  function ComposerPredictionChip({ chip }: { readonly chip: ComposerInlineChip }) {
    const mountChip = useCallback(
      (host: HTMLSpanElement | null) => host?.replaceChildren(createComposerInlineChipDom(chip)),
      [chip],
    );
    return <span ref={mountChip} />;
  },
  (previous, next) => JSON.stringify(previous.chip) === JSON.stringify(next.chip),
);

/**
 * Codex renders its gray prediction as the parsed prompt, so mentions, skills and commands
 * already look like the chips the composer creates when the prediction is accepted.
 */
function ComposerPredictionContent({
  text,
  mentionReferences,
}: {
  readonly text: string;
  readonly mentionReferences: ReadonlyArray<ProviderMentionReference>;
}) {
  return splitPromptIntoComposerSegments(text, [], mentionReferences).map((segment, index) => {
    const key = `${index}:${segment.type}`;
    switch (segment.type) {
      case "text":
        return <Fragment key={key}>{segment.text}</Fragment>;
      case "mention":
        return (
          <ComposerPredictionChip
            key={key}
            chip={{
              type: "mention",
              path: segment.path,
              kind: segment.kind ?? "path",
              provider: resolveMentionSegmentProvider(segment),
            }}
          />
        );
      case "skill":
        return (
          <ComposerPredictionChip
            key={key}
            chip={{
              type: "skill",
              name: normalizeComposerSkillName(composerSkillSegmentName(segment)),
            }}
          />
        );
      case "slash-command":
        return (
          <ComposerPredictionChip
            key={key}
            chip={{ type: "slash-command", command: segment.command }}
          />
        );
      case "agent-mention":
        return (
          <ComposerPredictionChip
            key={key}
            chip={{ type: "agent-mention", alias: segment.alias, color: segment.color }}
          />
        );
      case "link":
        return (
          <span key={key} className={COMPOSER_INLINE_DECORATOR_HOST_CLASS_NAME}>
            <ComposerLinkChip url={segment.url} />
          </span>
        );
      case "terminal-context":
        return null;
    }
  });
}

function $setComposerEditorPrompt(
  prompt: string,
  terminalContexts: ReadonlyArray<TerminalContextDraft>,
  mentionReferences: ReadonlyArray<ProviderMentionReference> = [],
): void {
  const root = $getRoot();
  root.clear();
  const paragraph = $createParagraphNode();
  root.append(paragraph);

  const segments = splitPromptIntoComposerSegments(prompt, terminalContexts, mentionReferences);
  for (const segment of segments) {
    if (segment.type === "mention") {
      paragraph.append(
        $createComposerMentionNode(
          segment.path,
          segment.kind,
          resolveMentionSegmentProvider(segment),
          segment.threadId,
        ),
      );
      continue;
    }
    if (segment.type === "skill") {
      paragraph.append($createComposerSkillNode(composerSkillSegmentName(segment)));
      continue;
    }
    if (segment.type === "slash-command") {
      paragraph.append($createComposerSlashCommandNode(segment.command));
      continue;
    }
    if (segment.type === "terminal-context") {
      if (segment.context) {
        paragraph.append($createComposerTerminalContextNode(segment.context));
      }
      continue;
    }
    if (segment.type === "agent-mention") {
      paragraph.append($createComposerAgentMentionNode(segment.alias, segment.color));
      continue;
    }
    if (segment.type === "link") {
      paragraph.append($createComposerLinkNode(segment.url));
      continue;
    }
    $appendTextWithLineBreaks(paragraph, segment.text);
  }
}

function collectTerminalContextIds(node: LexicalNode): string[] {
  if (node instanceof ComposerTerminalContextNode) {
    return [node.__context.id];
  }
  if ($isElementNode(node)) {
    return node.getChildren().flatMap((child) => collectTerminalContextIds(child));
  }
  return [];
}

export interface ComposerPromptPrediction {
  base: string;
  suffix: string;
  hint: string;
  showHint: boolean;
  onAccept: () => void;
}

export interface ComposerPromptEditorHandle {
  blur: () => void;
  focus: () => void;
  focusAt: (cursor: number) => void;
  focusAtEnd: () => void;
  isFocused: () => boolean;
  readSnapshot: (options?: { flushPending?: boolean }) => {
    value: string;
    cursor: number;
    expandedCursor: number;
    selectionCollapsed: boolean;
    terminalContextIds: string[];
  };
}

interface ComposerPromptEditorProps {
  value: string;
  cursor: number;
  terminalContexts: ReadonlyArray<TerminalContextDraft>;
  mentionReferences?: ReadonlyArray<ProviderMentionReference>;
  disabled: boolean;
  placeholder: string;
  ariaLabel?: string | undefined;
  className?: string;
  /** One-line field for the single-row composer: one line tall, placeholder truncated. */
  singleLine?: boolean;
  prediction?: ComposerPromptPrediction | null;
  onRemoveTerminalContext: (contextId: string) => void;
  /**
   * Invoked when a sufficiently large text paste should collapse into an attachment
   * card instead of inserting raw text. When omitted, pastes insert as text.
   */
  onCollapsePastedText?: (text: string) => void;
  onChange: (
    nextValue: string,
    nextCursor: number,
    expandedCursor: number,
    cursorAdjacentToMention: boolean,
    terminalContextIds: string[],
  ) => void;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
  onPaste: ClipboardEventHandler<HTMLElement>;
}

interface ComposerPromptEditorInnerProps extends ComposerPromptEditorProps {
  editorRef: Ref<ComposerPromptEditorHandle>;
}

function ComposerCommandKeyPlugin(props: {
  prediction?: ComposerPromptPrediction | null;
  onCommandKeyDown?: (
    key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
    event: KeyboardEvent,
  ) => boolean;
}) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const handleCommand = (
      key: "ArrowDown" | "ArrowUp" | "Enter" | "Tab" | "Slash",
      event: KeyboardEvent | null,
    ): boolean => {
      if (!props.onCommandKeyDown || !event) {
        return false;
      }
      const handled = props.onCommandKeyDown(key, event);
      if (handled) {
        event.preventDefault();
        event.stopPropagation();
      }
      return handled;
    };

    const acceptPrediction = (
      event: KeyboardEvent | null,
      options?: { readonly emptyOnly?: boolean },
    ): boolean => {
      const prediction = props.prediction;
      if (
        !prediction ||
        !event ||
        event.shiftKey ||
        event.metaKey ||
        event.ctrlKey ||
        event.altKey ||
        event.isComposing
      ) {
        return false;
      }
      if (options?.emptyOnly && prediction.base.length > 0) return false;
      let matches = false;
      // A paste can still be sitting in the pending update when Tab arrives.
      // Reading only the committed state would accept a completion for text
      // the user has already replaced.
      const pendingEditorState = (editor as unknown as { _pendingEditorState?: EditorState | null })
        ._pendingEditorState;
      (pendingEditorState ?? editor.getEditorState()).read(() => {
        const selection = $getSelection();
        const currentValue = $getRoot().getTextContent();
        matches =
          $isRangeSelection(selection) &&
          selection.isCollapsed() &&
          $readSelectionOffsetFromEditorState(currentValue.length) === currentValue.length &&
          currentValue === prediction.base;
      });
      if (!matches) return false;
      prediction.onAccept();
      event.preventDefault();
      event.stopPropagation();
      return true;
    };

    const unregisterArrowDown = editor.registerCommand(
      KEY_ARROW_DOWN_COMMAND,
      (event) => handleCommand("ArrowDown", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowUp = editor.registerCommand(
      KEY_ARROW_UP_COMMAND,
      (event) => handleCommand("ArrowUp", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterEnter = editor.registerCommand(
      KEY_ENTER_COMMAND,
      (event) =>
        acceptPrediction(event, { emptyOnly: true }) ? true : handleCommand("Enter", event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterTab = editor.registerCommand(
      KEY_TAB_COMMAND,
      (event) => (acceptPrediction(event) ? true : handleCommand("Tab", event)),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterArrowRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => acceptPrediction(event),
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterSlash = editor.registerCommand(
      KEY_DOWN_COMMAND,
      (event) =>
        event instanceof KeyboardEvent && event.key === "/" ? handleCommand("Slash", event) : false,
      COMMAND_PRIORITY_HIGH,
    );

    return () => {
      unregisterArrowDown();
      unregisterArrowUp();
      unregisterEnter();
      unregisterTab();
      unregisterArrowRight();
      unregisterSlash();
    };
  }, [editor, props]);

  return null;
}

function ComposerPredictionCompositionPlugin(props: {
  onComposingChange: (composing: boolean) => void;
}) {
  const [editor] = useLexicalComposerContext();
  const onComposingChangeRef = useRef(props.onComposingChange);
  useEffect(() => {
    onComposingChangeRef.current = props.onComposingChange;
  }, [props.onComposingChange]);

  useEffect(() => {
    const report = (composing: boolean) => {
      onComposingChangeRef.current(composing);
      return false;
    };
    const unregisterStart = editor.registerCommand(
      COMPOSITION_START_COMMAND,
      () => report(true),
      COMMAND_PRIORITY_LOW,
    );
    const unregisterEnd = editor.registerCommand(
      COMPOSITION_END_COMMAND,
      () => report(false),
      COMMAND_PRIORITY_LOW,
    );
    const unregisterBlur = editor.registerCommand(
      BLUR_COMMAND,
      () => report(false),
      COMMAND_PRIORITY_LOW,
    );
    return () => {
      unregisterStart();
      unregisterEnd();
      unregisterBlur();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenArrowPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    const unregisterLeft = editor.registerCommand(
      KEY_ARROW_LEFT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          if (currentOffset <= 0) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "left")) {
            return;
          }
          nextOffset = currentOffset - 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    const unregisterRight = editor.registerCommand(
      KEY_ARROW_RIGHT_COMMAND,
      (event) => {
        let nextOffset: number | null = null;
        editor.getEditorState().read(() => {
          const selection = $getSelection();
          if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
          const currentOffset = $readSelectionOffsetFromEditorState(0);
          const composerLength = $getComposerRootLength();
          if (currentOffset >= composerLength) return;
          const promptValue = $getRoot().getTextContent();
          if (!isCollapsedCursorAdjacentToInlineToken(promptValue, currentOffset, "right")) {
            return;
          }
          nextOffset = currentOffset + 1;
        });
        if (nextOffset === null) return false;
        const selectionOffset = nextOffset;
        event?.preventDefault();
        event?.stopPropagation();
        editor.update(() => {
          $setSelectionAtComposerOffset(selectionOffset);
        });
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
    return () => {
      unregisterLeft();
      unregisterRight();
    };
  }, [editor]);

  return null;
}

function ComposerInlineTokenSelectionNormalizePlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerUpdateListener(({ editorState }) => {
      let afterOffset: number | null = null;
      editorState.read(() => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) return;
        const anchorNode = selection.anchor.getNode();
        if (!isComposerInlineTokenNode(anchorNode)) return;
        if (selection.anchor.offset === 0) return;
        const beforeOffset = getAbsoluteOffsetForPoint(anchorNode, 0);
        afterOffset = beforeOffset + 1;
      });
      if (afterOffset !== null) {
        queueMicrotask(() => {
          editor.update(() => {
            $setSelectionAtComposerOffset(afterOffset!);
          });
        });
      }
    });
  }, [editor]);

  return null;
}

function ComposerInlineTokenBackspacePlugin() {
  const [editor] = useLexicalComposerContext();
  const onRemoveTerminalContext = useContext(ComposerRemoveTerminalContextContext);

  useEffect(() => {
    return editor.registerCommand(
      KEY_BACKSPACE_COMMAND,
      (event) => {
        const selection = $getSelection();
        if (!$isRangeSelection(selection) || !selection.isCollapsed()) {
          return false;
        }

        const anchorNode = selection.anchor.getNode();
        const selectionOffset = $readSelectionOffsetFromEditorState(0);
        const removeInlineTokenNode = (candidate: unknown): boolean => {
          if (!isComposerInlineTokenNode(candidate)) {
            return false;
          }
          const tokenStart = getAbsoluteOffsetForPoint(candidate, 0);
          candidate.remove();
          if (candidate instanceof ComposerTerminalContextNode) {
            onRemoveTerminalContext(candidate.__context.id);
            $setSelectionAtComposerOffset(selectionOffset);
          } else {
            $setSelectionAtComposerOffset(tokenStart);
          }
          event?.preventDefault();
          return true;
        };
        if (removeInlineTokenNode(anchorNode)) {
          return true;
        }

        if ($isTextNode(anchorNode)) {
          if (selection.anchor.offset > 0) {
            return false;
          }
          if (removeInlineTokenNode(anchorNode.getPreviousSibling())) {
            return true;
          }
          const parent = anchorNode.getParent();
          if ($isElementNode(parent)) {
            const index = anchorNode.getIndexWithinParent();
            if (index > 0 && removeInlineTokenNode(parent.getChildAtIndex(index - 1))) {
              return true;
            }
          }
          return false;
        }

        if ($isElementNode(anchorNode)) {
          const childIndex = selection.anchor.offset - 1;
          if (childIndex >= 0 && removeInlineTokenNode(anchorNode.getChildAtIndex(childIndex))) {
            return true;
          }
        }

        return false;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, onRemoveTerminalContext]);

  return null;
}

function ComposerSlashCommandTransformPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerNodeTransform(TextNode, (node) => {
      if (isComposerInlineTokenNode(node)) {
        return;
      }
      const match = matchComposerSlashCommandChipToken(node.getTextContent());
      if (!match) {
        return;
      }
      const splitNodes = node.splitText(match.start, match.end);
      const commandNode = match.start === 0 ? splitNodes[0] : splitNodes[1];
      commandNode?.replace($createComposerSlashCommandNode(match.command));
    });
  }, [editor]);

  return null;
}

// Converts a bare URL into a link chip as soon as a delimiter follows it while typing, mirroring
// the read-only message bubble. The controlled value→editor sync never re-tokenizes user input
// (the editor text already equals the prompt string, so the rewrite is skipped), so live chipping
// must run as a node transform. A chip's text content is the raw URL, so the serialized prompt is
// unchanged and selection/length stay stable.
function ComposerLinkTransformPlugin() {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    // registerNodeTransform(TextNode) fires only for plain text nodes; the chip subclasses have
    // their own node types and are skipped. The isComposerInlineTokenNode guard is defensive.
    return editor.registerNodeTransform(TextNode, (node) => {
      if (isComposerInlineTokenNode(node)) {
        return;
      }
      const match = matchComposerLinkToken(node.getTextContent(), {
        includeTrailingTokenAtEnd: false,
      });
      if (!match) {
        return;
      }
      const splitNodes = node.splitText(match.start, match.end);
      const urlNode = match.start === 0 ? splitNodes[0] : splitNodes[1];
      urlNode?.replace($createComposerLinkNode(match.url));
    });
  }, [editor]);

  return null;
}

// Read the native clipboard and insert inside the command's existing update.
// Lexical's default plain-text handler queues a nested update; a send command
// can read the editor before that queued insertion has run.
function ComposerPastePlugin(props: { onCollapsePastedText?: (text: string) => void }) {
  const [editor] = useLexicalComposerContext();

  useEffect(() => {
    return editor.registerCommand(
      PASTE_COMMAND,
      (event) => {
        const clipboardData = event instanceof ClipboardEvent ? event.clipboardData : null;
        // Leave file/image intake to the composer's dropzone.
        if (!clipboardData || clipboardData.files.length > 0) return false;
        const text = clipboardData.getData("text/plain");
        if (!text) return false;
        const url = parseBareComposerLink(text);
        if (!url && props.onCollapsePastedText && shouldCollapsePastedText(text)) {
          event.preventDefault();
          props.onCollapsePastedText(text);
          return true;
        }
        const selection = $getSelection();
        if (!$isRangeSelection(selection)) return false;
        event.preventDefault();
        $addUpdateTag(PASTE_TAG);
        if (url) selection.insertNodes([$createComposerLinkNode(url)]);
        else selection.insertRawText(text);
        return true;
      },
      COMMAND_PRIORITY_HIGH,
    );
  }, [editor, props.onCollapsePastedText]);

  return null;
}

// Thread mention chips resolve their provider icon from the sidebar summaries,
// which may not be loaded yet when a draft is restored (and can change after a
// provider handoff). Refresh the stored provider on existing chips whenever the
// summaries change so the icon never stays stale.
function ComposerThreadMentionProviderPlugin() {
  const [editor] = useLexicalComposerContext();
  const threadMentionSources = useStore(
    useMemo(() => createComposerThreadMentionSourcesSelector(), []),
  );
  const providerByThreadId = useMemo(
    () => new Map(threadMentionSources.map((source) => [source.id as string, source.provider])),
    [threadMentionSources],
  );

  useEffect(() => {
    const staleProvider = (node: ComposerMentionNode): boolean => {
      const threadId = node.getMentionThreadId();
      if (!threadId) return false;
      const provider = providerByThreadId.get(threadId);
      return provider !== undefined && provider !== node.getMentionProvider();
    };
    const needsUpdate = editor
      .getEditorState()
      .read(() => $nodesOfType(ComposerMentionNode).some(staleProvider));
    if (!needsUpdate) return;
    editor.update(
      () => {
        for (const node of $nodesOfType(ComposerMentionNode)) {
          if (!staleProvider(node)) continue;
          const provider = providerByThreadId.get(node.getMentionThreadId() ?? "");
          if (provider) node.setMentionProvider(provider);
        }
      },
      { tag: "history-merge" },
    );
  }, [editor, providerByThreadId]);

  return null;
}

function ComposerPromptEditorInner({
  value,
  cursor,
  terminalContexts,
  mentionReferences: mentionReferencesProp,
  disabled,
  placeholder,
  ariaLabel,
  className,
  singleLine,
  prediction,
  onRemoveTerminalContext,
  onCollapsePastedText,
  onChange,
  onCommandKeyDown,
  onPaste,
  editorRef,
}: ComposerPromptEditorInnerProps) {
  const mentionReferences = mentionReferencesProp ?? [];
  const [editor] = useLexicalComposerContext();
  const onChangeRef = useRef(onChange);
  const initialCursor = clampCollapsedComposerCursor(value, cursor);
  const [predictionSelectionEligible, setPredictionSelectionEligible] = useState(
    () => initialCursor === value.length,
  );
  const [isPredictionComposing, setIsPredictionComposing] = useState(false);
  const predictionDescriptionId = useId();
  const terminalContextsSignature = terminalContextSignature(terminalContexts);
  const terminalContextsSignatureRef = useRef(terminalContextsSignature);
  const mentionsSignature = mentionReferencesSignature(mentionReferences);
  const mentionsSignatureRef = useRef(mentionsSignature);
  const snapshotRef = useRef({
    value,
    cursor: initialCursor,
    expandedCursor: expandCollapsedComposerCursor(value, initialCursor),
    selectionCollapsed: true,
    terminalContextIds: terminalContexts.map((context) => context.id),
  });
  const isApplyingControlledUpdateRef = useRef(false);

  useEffect(() => {
    onChangeRef.current = onChange;
  }, [onChange]);

  // Disabling the editor (e.g. while a turn dispatch is connecting) turns off
  // contenteditable, which drops browser focus to <body>. Remember whether the
  // composer owned focus at disable time and hand it back once re-enabled, so
  // sending a message never silently kicks the user out of the input.
  const restoreFocusOnEnableRef = useRef(false);
  useEffect(() => {
    if (disabled) {
      const rootElement = editor.getRootElement();
      restoreFocusOnEnableRef.current = Boolean(
        rootElement && document.activeElement === rootElement,
      );
      editor.setEditable(false);
      return;
    }
    editor.setEditable(true);
    if (restoreFocusOnEnableRef.current) {
      restoreFocusOnEnableRef.current = false;
      editor.getRootElement()?.focus();
    }
  }, [disabled, editor]);

  useLayoutEffect(() => {
    const normalizedCursor = clampCollapsedComposerCursor(value, cursor);
    const previousSnapshot = snapshotRef.current;
    const contextsChanged = terminalContextsSignatureRef.current !== terminalContextsSignature;
    const mentionsChanged = mentionsSignatureRef.current !== mentionsSignature;
    if (
      previousSnapshot.value === value &&
      previousSnapshot.cursor === normalizedCursor &&
      !contextsChanged &&
      !mentionsChanged
    ) {
      return;
    }

    snapshotRef.current = {
      value,
      cursor: normalizedCursor,
      expandedCursor: expandCollapsedComposerCursor(value, normalizedCursor),
      selectionCollapsed: true,
      terminalContextIds: terminalContexts.map((context) => context.id),
    };
    setPredictionSelectionEligible(normalizedCursor === value.length);
    terminalContextsSignatureRef.current = terminalContextsSignature;
    mentionsSignatureRef.current = mentionsSignature;

    const rootElement = editor.getRootElement();
    const isFocused = Boolean(rootElement && document.activeElement === rootElement);
    if (previousSnapshot.value === value && !contextsChanged && !mentionsChanged && !isFocused) {
      return;
    }

    isApplyingControlledUpdateRef.current = true;
    editor.update(() => {
      const shouldRewriteEditorState =
        previousSnapshot.value !== value || contextsChanged || mentionsChanged;
      if (shouldRewriteEditorState) {
        $setComposerEditorPrompt(value, terminalContexts, mentionReferences);
      }
      if (shouldRewriteEditorState || isFocused) {
        $setSelectionAtComposerOffset(normalizedCursor);
      }
    });
    queueMicrotask(() => {
      isApplyingControlledUpdateRef.current = false;
    });
  }, [
    cursor,
    editor,
    mentionReferences,
    mentionsSignature,
    terminalContexts,
    terminalContextsSignature,
    value,
  ]);

  const focusAt = useCallback(
    (nextCursor: number) => {
      const rootElement = editor.getRootElement();
      if (!rootElement) return;
      const boundedCursor = clampCollapsedComposerCursor(snapshotRef.current.value, nextCursor);
      rootElement.focus();
      editor.update(() => {
        $setSelectionAtComposerOffset(boundedCursor);
      });
      snapshotRef.current = {
        value: snapshotRef.current.value,
        cursor: boundedCursor,
        expandedCursor: expandCollapsedComposerCursor(snapshotRef.current.value, boundedCursor),
        selectionCollapsed: true,
        terminalContextIds: snapshotRef.current.terminalContextIds,
      };
      setPredictionSelectionEligible(boundedCursor === snapshotRef.current.value.length);
      onChangeRef.current(
        snapshotRef.current.value,
        boundedCursor,
        snapshotRef.current.expandedCursor,
        false,
        snapshotRef.current.terminalContextIds,
      );
    },
    [editor],
  );

  const blurEditor = useCallback(() => {
    editor.getRootElement()?.blur();
  }, [editor]);

  // Keep global shortcuts decoupled from Lexical's root element details.
  const isEditorFocused = useCallback(() => {
    const rootElement = editor.getRootElement();
    return Boolean(
      rootElement && typeof document !== "undefined" && document.activeElement === rootElement,
    );
  }, [editor]);

  const readSnapshot = useCallback(
    (options?: {
      // Force editor.read()'s pending-update flush. Only safe when the current
      // Lexical command is fully handled by the app (e.g. send): the flush freezes
      // the in-flight pending map, so a command that falls through to Lexical's
      // own handlers (plain-text Enter) must never take this path.
      flushPending?: boolean;
    }): {
      value: string;
      cursor: number;
      expandedCursor: number;
      selectionCollapsed: boolean;
      terminalContextIds: string[];
    } => {
      const flushPending = options?.flushPending === true;
      let snapshot = snapshotRef.current;
      const internalEditor = editor as unknown as {
        _updating?: boolean;
        _pendingEditorState?: EditorState | null;
      };
      const readLatestSnapshot = () => {
        const selection = $getSelection();
        const selectionCollapsed = !$isRangeSelection(selection) || selection.isCollapsed();
        const nextValue = $getRoot().getTextContent();
        const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
        const nextCursor = clampCollapsedComposerCursor(
          nextValue,
          $readSelectionOffsetFromEditorState(fallbackCursor),
        );
        const fallbackExpandedCursor = clampExpandedCursor(
          nextValue,
          snapshotRef.current.expandedCursor,
        );
        const nextExpandedCursor = clampExpandedCursor(
          nextValue,
          $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
        );
        const terminalContextIds = collectTerminalContextIds($getRoot());
        snapshot = {
          value: nextValue,
          cursor: nextCursor,
          expandedCursor: nextExpandedCursor,
          selectionCollapsed,
          terminalContextIds,
        };
      };
      if (flushPending !== true && internalEditor._updating === true) {
        // Inside a Lexical command update (e.g. Enter): editor.read() would run
        // $commitPendingUpdates and freeze the in-flight pending node map, and the
        // command's own handler then explodes on the frozen map. The pending state
        // already carries everything uncommitted (paste included), so read it (or
        // the committed state) directly instead.
        (internalEditor._pendingEditorState ?? editor.getEditorState()).read(readLatestSnapshot);
      } else {
        // Outside an update, editor.read() flushes a still-pending paste before the
        // snapshot is taken (Enter/Send right after a native paste).
        editor.read(readLatestSnapshot);
      }
      snapshotRef.current = snapshot;
      return snapshot;
    },
    [editor],
  );

  useImperativeHandle(
    editorRef,
    () => ({
      blur: blurEditor,
      focus: () => {
        focusAt(snapshotRef.current.cursor);
      },
      focusAt,
      focusAtEnd: () => {
        focusAt(
          collapseExpandedComposerCursor(
            snapshotRef.current.value,
            snapshotRef.current.value.length,
          ),
        );
      },
      isFocused: isEditorFocused,
      readSnapshot,
    }),
    [blurEditor, focusAt, isEditorFocused, readSnapshot],
  );

  const handleEditorChange = useCallback((editorState: EditorState) => {
    editorState.read(() => {
      const selection = $getSelection();
      const selectionCollapsed = !$isRangeSelection(selection) || selection.isCollapsed();
      const nextValue = $getRoot().getTextContent();
      const fallbackCursor = clampCollapsedComposerCursor(nextValue, snapshotRef.current.cursor);
      const nextCursor = clampCollapsedComposerCursor(
        nextValue,
        $readSelectionOffsetFromEditorState(fallbackCursor),
      );
      const fallbackExpandedCursor = clampExpandedCursor(
        nextValue,
        snapshotRef.current.expandedCursor,
      );
      const nextExpandedCursor = clampExpandedCursor(
        nextValue,
        $readExpandedSelectionOffsetFromEditorState(fallbackExpandedCursor),
      );
      const terminalContextIds = collectTerminalContextIds($getRoot());
      const previousSnapshot = snapshotRef.current;
      const contentSnapshotUnchanged =
        previousSnapshot.value === nextValue &&
        previousSnapshot.cursor === nextCursor &&
        previousSnapshot.expandedCursor === nextExpandedCursor &&
        previousSnapshot.terminalContextIds.length === terminalContextIds.length &&
        previousSnapshot.terminalContextIds.every((id, index) => id === terminalContextIds[index]);
      if (contentSnapshotUnchanged && previousSnapshot.selectionCollapsed === selectionCollapsed) {
        return;
      }
      if (isApplyingControlledUpdateRef.current) {
        return;
      }
      snapshotRef.current = {
        value: nextValue,
        cursor: nextCursor,
        expandedCursor: nextExpandedCursor,
        selectionCollapsed,
        terminalContextIds,
      };
      setPredictionSelectionEligible(selectionCollapsed && nextCursor === nextValue.length);
      if (contentSnapshotUnchanged) {
        return;
      }
      const cursorAdjacentToMention =
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "left") ||
        isCollapsedCursorAdjacentToInlineToken(nextValue, nextCursor, "right");
      onChangeRef.current(
        nextValue,
        nextCursor,
        nextExpandedCursor,
        cursorAdjacentToMention,
        terminalContextIds,
      );
    });
  }, []);

  const activePrediction =
    !isPredictionComposing && predictionSelectionEligible && prediction?.suffix ? prediction : null;
  return (
    <ComposerRemoveTerminalContextContext.Provider value={onRemoveTerminalContext}>
      <div className="relative grid">
        {activePrediction ? (
          <div
            aria-hidden="true"
            onMouseDown={(event) => {
              // Codex keeps a visible prediction from stealing the editor's
              // selection: a primary click only focuses the composer.
              if (event.button === 0) {
                event.preventDefault();
                editor.focus();
              }
            }}
            className={cn(
              "relative z-0 col-start-1 row-start-1 block w-full whitespace-pre-wrap break-words",
              COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
              singleLine && "min-h-[1lh]",
              className,
            )}
            data-testid="composer-prediction"
          >
            <span className="invisible">{value}</span>
            <span
              className="me-1.5 text-tertiary"
              data-testid="composer-prediction-text"
              style={{ opacity: "var(--composer-editor-placeholder-opacity, .5)" }}
            >
              {activePrediction.base.length === 0 ? (
                <ComposerPredictionContent
                  text={activePrediction.suffix}
                  mentionReferences={mentionReferences}
                />
              ) : (
                // A completion of typed text cannot know the token boundaries it continues.
                activePrediction.suffix
              )}
            </span>
            {activePrediction.showHint ? (
              <span
                className="inline-block rounded-row whitespace-nowrap bg-text/3 px-1.75 py-0.5 text-ui-sm leading-4 font-normal text-tertiary/50"
                data-testid="composer-prediction-hint"
              >
                {activePrediction.hint}
              </span>
            ) : null}
          </div>
        ) : null}
        {activePrediction ? (
          <span className="sr-only" id={predictionDescriptionId}>
            {activePrediction.hint}: {activePrediction.suffix}
          </span>
        ) : null}
        <PlainTextPlugin
          contentEditable={
            <ContentEditable
              className={cn(
                "relative z-10 col-start-1 row-start-1 block max-h-[200px] w-full overflow-y-auto whitespace-pre-wrap break-words bg-transparent text-foreground focus:outline-none",
                COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                COMPOSER_EDITOR_MIN_HEIGHT_CLASS_NAME,
                COMPOSER_EDITOR_CONTENT_RESET_CLASS_NAME,
                singleLine && "min-h-[1lh]",
                className,
              )}
              data-testid="composer-editor"
              aria-placeholder={placeholder}
              aria-label={ariaLabel}
              aria-describedby={activePrediction ? predictionDescriptionId : undefined}
              placeholder={<span />}
              onPaste={onPaste}
            />
          }
          placeholder={
            terminalContexts.length > 0 || activePrediction ? null : (
              <div
                className={cn(
                  "pointer-events-none absolute inset-0",
                  COMPOSER_PLACEHOLDER_TEXT_CLASS_NAME,
                  COMPOSER_EDITOR_TYPOGRAPHY_CLASS_NAME,
                  singleLine && "truncate",
                )}
              >
                {placeholder}
              </div>
            )
          }
          ErrorBoundary={LexicalErrorBoundary}
        />
        <OnChangePlugin onChange={handleEditorChange} />
        <ComposerCommandKeyPlugin
          {...(activePrediction ? { prediction: activePrediction } : {})}
          {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        />
        <ComposerPredictionCompositionPlugin onComposingChange={setIsPredictionComposing} />
        <ComposerInlineTokenArrowPlugin />
        <ComposerInlineTokenSelectionNormalizePlugin />
        <ComposerInlineTokenBackspacePlugin />
        <ComposerSlashCommandTransformPlugin />
        <ComposerLinkTransformPlugin />
        <ComposerThreadMentionProviderPlugin />
        <ComposerPastePlugin {...(onCollapsePastedText ? { onCollapsePastedText } : {})} />
        <HistoryPlugin />
      </div>
    </ComposerRemoveTerminalContextContext.Provider>
  );
}

export const ComposerPromptEditor = forwardRef<
  ComposerPromptEditorHandle,
  ComposerPromptEditorProps
>(function ComposerPromptEditor(
  {
    value,
    cursor,
    terminalContexts,
    mentionReferences,
    disabled,
    placeholder,
    ariaLabel,
    className,
    singleLine,
    prediction,
    onRemoveTerminalContext,
    onCollapsePastedText,
    onChange,
    onCommandKeyDown,
    onPaste,
  },
  ref,
) {
  const initialValueRef = useRef(value);
  const initialTerminalContextsRef = useRef(terminalContexts);
  // Normalize once at the wrapper boundary so the inner editor can treat mention refs as concrete.
  const normalizedMentionReferences = mentionReferences ?? [];
  const initialMentionReferencesRef = useRef(normalizedMentionReferences);
  const initialConfig: InitialConfigType = {
    namespace: "moss-composer-editor",
    editable: true,
    nodes: [...COMPOSER_NODE_CLASSES],
    editorState: () => {
      $setComposerEditorPrompt(
        initialValueRef.current,
        initialTerminalContextsRef.current,
        initialMentionReferencesRef.current,
      );
    },
    onError: (error) => {
      throw error;
    },
  };

  return (
    <LexicalComposer key={COMPOSER_EDITOR_HMR_KEY} initialConfig={initialConfig}>
      <ComposerPromptEditorInner
        value={value}
        cursor={cursor}
        terminalContexts={terminalContexts}
        mentionReferences={normalizedMentionReferences}
        disabled={disabled}
        placeholder={placeholder}
        ariaLabel={ariaLabel}
        onRemoveTerminalContext={onRemoveTerminalContext}
        onChange={onChange}
        onPaste={onPaste}
        editorRef={ref}
        {...(prediction ? { prediction } : {})}
        {...(onCollapsePastedText ? { onCollapsePastedText } : {})}
        {...(onCommandKeyDown ? { onCommandKeyDown } : {})}
        {...(className ? { className } : {})}
        {...(singleLine ? { singleLine } : {})}
      />
    </LexicalComposer>
  );
});
