// FILE: BoardItemView.tsx
// Purpose: 白板 (kind `board`): opens Moss Canvas's whiteboard inside the 资料空间.
// Layer: 资料空间 types stream. Drawing, storage and the tldraw license stay inside Moss Canvas;
//        this file only hosts the existing Canvas surface.

import { parseBoardItem } from "@moss/shared/spaceItems/itemData";
import { useCallback, useEffect, useMemo, useState, type ReactNode } from "react";

import { spaceKindMeta } from "../../space/spaceKinds";
import type {
  SpaceCanvasDockController,
  SpaceCanvasHostInsets,
} from "../../space/spaceCanvasDockContract";
import { Button } from "../../ui/button";
import { MossCanvasWebSurface } from "../../MossCanvasWebSurface";
import type { SpaceTitleMenuHostCapabilities } from "../shared/SpaceEditorChrome";

const CanvasIcon = spaceKindMeta("board").icon;

export function BoardItemView(props: {
  data: string;
  pageId: string;
  scopeSpaceId: string | null;
  onLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
  dock?: SpaceCanvasDockController | null;
  hostInsets?: SpaceCanvasHostInsets;
  hostChrome?: { hideTopBar?: boolean; bottomInsetPx?: number; rightInsetPx?: number };
  onAskDock?: (request: {
    prompt?: string;
    selectedShapeIds?: string[];
    selectionText?: string;
    origin?: "toolbar" | "selection" | "comment";
  }) => void;
  onHostActionsChange?: (actions: ReactNode | null) => void;
  onTitleMenuChange?: (caps: SpaceTitleMenuHostCapabilities | null) => void;
}) {
  const board = useMemo(() => {
    try {
      return parseBoardItem(props.data);
    } catch {
      return null;
    }
  }, [props.data]);
  const [open, setOpen] = useState(true);
  const handleClose = useCallback(() => setOpen(false), []);
  useEffect(() => () => props.onHostActionsChange?.(null), [props.onHostActionsChange]);
  const boardScope = useMemo(
    () =>
      board
        ? {
            pageId: props.pageId,
            canvasProjectKey: board.canvasProjectKey,
            scopeSpaceId: props.scopeSpaceId,
          }
        : undefined,
    [board?.canvasProjectKey, props.pageId, props.scopeSpaceId],
  );
  const effectiveHostChrome = useMemo(
    () =>
      props.hostChrome || props.hostInsets
        ? {
            ...(props.hostChrome ?? {}),
            ...(props.hostChrome?.bottomInsetPx === undefined &&
            props.hostInsets?.bottomInsetPx !== undefined
              ? { bottomInsetPx: props.hostInsets.bottomInsetPx }
              : {}),
            ...(props.hostChrome?.rightInsetPx === undefined &&
            props.hostInsets?.rightInsetPx !== undefined
              ? { rightInsetPx: props.hostInsets.rightInsetPx }
              : {}),
          }
        : undefined,
    [props.hostChrome, props.hostInsets],
  );
  const handleAskDock = useMemo(() => {
    if (props.onAskDock) return props.onAskDock;
    if (!props.dock) return undefined;
    return (request: {
      prompt?: string;
      selectedShapeIds?: string[];
      selectionText?: string;
      origin?: "toolbar" | "selection" | "comment";
    }) => {
      void props.dock?.ask({
        ...(request.prompt ? { prompt: request.prompt } : {}),
        origin:
          request.origin === "selection"
            ? "selection-bar"
            : request.origin === "comment"
              ? "comment-mention"
              : "bottom-pill",
        selection: {
          kind: "board",
          itemId: props.pageId,
          title: "画布",
          ...(request.selectedShapeIds?.length ? { boardIds: request.selectedShapeIds } : {}),
          ...(request.selectionText ? { summary: request.selectionText } : {}),
        },
      });
    };
  }, [props.dock, props.onAskDock, props.pageId]);
  if (!board) {
    return (
      <p role="alert" className="p-8 text-destructive">
        这个画布的内容无法读取。
      </p>
    );
  }
  return open ? (
    <div className="flex min-h-0 flex-1 flex-col" data-board-item={board.canvasProjectKey}>
      <MossCanvasWebSurface
        embedded
        canvasProjectKey={board.canvasProjectKey}
        {...(boardScope ? { boardScope } : {})}
        {...(effectiveHostChrome ? { hostChrome: effectiveHostChrome } : {})}
        {...(handleAskDock ? { onAskDock: handleAskDock } : {})}
        onClose={handleClose}
        {...(props.onLeaveGuardChange ? { onLeaveGuardChange: props.onLeaveGuardChange } : {})}
      />
    </div>
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
      <CanvasIcon className="size-8" aria-hidden />
      <p className="text-ui-sm">在 Moss 画布中打开。</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        打开画布
      </Button>
    </div>
  );
}
