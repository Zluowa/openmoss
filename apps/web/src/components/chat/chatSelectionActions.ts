// FILE: chatSelectionActions.ts
// Purpose: Helpers for reading assistant text selections from the transcript without re-render churn.
// Layer: Chat transcript interaction helpers

export interface TranscriptAssistantSelection {
  assistantMessageId: string;
  text: string;
}

export interface TranscriptSelectionActionLayout {
  left: number;
  top: number;
  placement: "top" | "bottom";
}

// Slot the layout reserves for the toolbar. The toolbar itself sizes to its labels and
// centers inside this slot, so the width only needs to be a close estimate for viewport
// clamping. Height must match the toolbar exactly (h-7 + 1px border top and bottom).
export const TRANSCRIPT_SELECTION_ACTION_WIDTH_PX = 320;
export const TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX = 30;
const TRANSCRIPT_SELECTION_ACTION_GAP_PX = 8;
const INLINE_MARKDOWN_DELIMITERS = new Set(["*", "_", "`", "~"]);

export function resolveTranscriptMarkerRange(input: {
  messageText: string;
  selectedText: string;
}): { startOffset: number; endOffset: number } | null {
  const selected = input.selectedText.trim();
  if (!selected) return null;
  const direct = input.messageText.indexOf(selected);
  if (direct >= 0 && input.messageText.indexOf(selected, direct + selected.length) < 0) {
    return { startOffset: direct, endOffset: direct + selected.length };
  }
  const normalize = (value: string) => value.replace(/\r\n/g, "\n").replace(/\s+/g, " ").trim();
  const target = normalize(selected);
  const source = input.messageText;
  let normalized = "";
  const starts: number[] = [];
  const ends: number[] = [];
  let pendingStart: number | null = null;
  let pendingEnd = 0;
  for (let i = 0; i < source.length; i++) {
    const c = source[i] ?? "";
    if (INLINE_MARKDOWN_DELIMITERS.has(c)) continue;
    if (/\s/.test(c)) {
      pendingStart ??= i;
      pendingEnd = i + 1;
      continue;
    }
    if (pendingStart !== null) {
      normalized += " ";
      starts.push(pendingStart);
      ends.push(pendingEnd);
      pendingStart = null;
    }
    normalized += c;
    starts.push(i);
    ends.push(i + 1);
  }
  if (pendingStart !== null) {
    normalized += " ";
    starts.push(pendingStart);
    ends.push(pendingEnd);
  }
  const at = normalized.indexOf(target);
  if (at < 0 || normalized.indexOf(target, at + target.length) >= 0) return null;
  const startOffset = starts[at];
  const endOffset = ends[at + target.length - 1];
  return startOffset === undefined || endOffset === undefined ? null : { startOffset, endOffset };
}
function getSelectionRect(selection: Selection): DOMRect | null {
  if (selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }
  const range = selection.getRangeAt(0);
  const rects = Array.from(range.getClientRects()).filter(
    (rect) => rect.width > 0 || rect.height > 0,
  );
  if (rects.length > 0) {
    return rects[rects.length - 1] ?? null;
  }
  const boundingRect = range.getBoundingClientRect();
  return boundingRect.width > 0 || boundingRect.height > 0 ? boundingRect : null;
}

// Rect of the active window selection, for positioning floating selection actions.
export function getActiveSelectionRect(): DOMRect | null {
  const selection = window.getSelection();
  if (!selection) {
    return null;
  }
  return getSelectionRect(selection);
}

// `closest()` that escapes open shadow roots (e.g. the @pierre/diffs custom
// element) by hopping from a shadow root to its host element.
export function closestThroughShadow(start: Node | null, selector: string): HTMLElement | null {
  let node: Node | null = start;
  while (node) {
    const element = node instanceof HTMLElement ? node : node.parentElement;
    const match = element?.closest<HTMLElement>(selector) ?? null;
    if (match) {
      return match;
    }
    const root = (element ?? node).getRootNode();
    node = root instanceof ShadowRoot ? root.host : null;
  }
  return null;
}

function selectionContainerForNode(node: Node | null): HTMLElement | null {
  if (!node) {
    return null;
  }
  const element = node instanceof HTMLElement ? node : node.parentElement;
  return element?.closest<HTMLElement>("[data-assistant-message-id]") ?? null;
}

export function readTranscriptAssistantSelection(input: {
  container: HTMLElement | null;
}): { selection: TranscriptAssistantSelection; selectionRect: DOMRect | null } | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0 || selection.isCollapsed) {
    return null;
  }

  const anchorContainer = selectionContainerForNode(selection.anchorNode);
  const focusContainer = selectionContainerForNode(selection.focusNode);
  if (!anchorContainer || !focusContainer || anchorContainer !== focusContainer) {
    return null;
  }
  const { container } = input;
  if (!container || !container.contains(anchorContainer)) {
    return null;
  }

  const assistantMessageId = anchorContainer.dataset.assistantMessageId?.trim() ?? "";
  const text = selection
    .toString()
    .replace(/\r\n/g, "\n")
    .replace(/^\n+|\n+$/g, "")
    .trim();
  if (assistantMessageId.length === 0 || text.length === 0) {
    return null;
  }

  return {
    selection: {
      assistantMessageId,
      text,
    },
    selectionRect: getSelectionRect(selection),
  };
}

export function resolveTranscriptSelectionActionLayout(input: {
  selectionRect: DOMRect | null;
  pointer: { x: number; y: number };
  viewport?: { width: number; height: number } | null;
  size?: { width: number; height: number } | null;
}): TranscriptSelectionActionLayout {
  const surfaceWidth = input.size?.width ?? TRANSCRIPT_SELECTION_ACTION_WIDTH_PX;
  const surfaceHeight = input.size?.height ?? TRANSCRIPT_SELECTION_ACTION_HEIGHT_PX;
  const viewportWidth =
    input.viewport?.width ??
    (typeof window === "undefined" ? input.pointer.x + 8 : window.innerWidth);
  const viewportHeight =
    input.viewport?.height ??
    (typeof window === "undefined" ? input.pointer.y + 8 : window.innerHeight);

  const anchorCenterX =
    input.selectionRect !== null
      ? input.selectionRect.left + input.selectionRect.width / 2
      : input.pointer.x;
  const selectionTop = input.selectionRect?.top ?? input.pointer.y;
  const selectionBottom = input.selectionRect?.bottom ?? input.pointer.y;
  const availableAbove = selectionTop;
  const availableBelow = viewportHeight - selectionBottom;
  const placement =
    availableAbove >= surfaceHeight + TRANSCRIPT_SELECTION_ACTION_GAP_PX ||
    availableAbove >= availableBelow
      ? "top"
      : "bottom";
  const unclampedTop =
    placement === "top"
      ? selectionTop - surfaceHeight - TRANSCRIPT_SELECTION_ACTION_GAP_PX
      : selectionBottom + TRANSCRIPT_SELECTION_ACTION_GAP_PX;

  return {
    left: Math.max(
      8,
      Math.min(
        Math.round(anchorCenterX - surfaceWidth / 2),
        Math.max(viewportWidth - surfaceWidth - 8, 8),
      ),
    ),
    top: Math.max(
      8,
      Math.min(Math.round(unclampedTop), Math.max(viewportHeight - surfaceHeight - 8, 8)),
    ),
    placement,
  };
}
