// FILE: DesignPlayer.tsx
// Purpose: Plays a 设计 prototype full window: the artboard runs with its scripts, `board:` links
//          move between artboards, a web-page artboard fills the window and scrolls, a fixed one
//          is scaled to fit. Escape (or 关闭) returns to the canvas. A script that throws shows a
//          notice with 让 Moss 修复.
// Layer: 资料空间 设计 (web)

import { boardsInReadingOrder, type DesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";

import { ChevronLeftIcon, ChevronRightIcon, XIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import { DesignBoardFrame } from "./DesignBoardFrame";
import { observeSize } from "./designSize";

export function DesignPlayer(props: {
  canvas: DesignCanvas;
  boardId: string;
  onBoard: (boardId: string) => void;
  onClose: () => void;
  /** Asks Moss to fix an artboard whose script threw; absent when no agent is available. */
  onFix?: (boardId: string, message: string) => void;
}) {
  const board = props.canvas.boards.find((entry) => entry.id === props.boardId);
  const [error, setError] = useState<{ boardId: string; message: string } | null>(null);
  const onError = useCallback(
    (message: string) => setError({ boardId: props.boardId, message }),
    [props.boardId],
  );
  const stage = useRef<HTMLDivElement | null>(null);
  const [box, setBox] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = stage.current;
    if (!element) return;
    const observer = observeSize(element, setBox);
    return () => observer.disconnect();
  }, []);
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.preventDefault();
        props.onClose();
      }
    };
    window.addEventListener("keydown", key);
    return () => window.removeEventListener("keydown", key);
  }, [props]);
  const order = board
    ? boardsInReadingOrder(props.canvas, board.page).filter((entry) => !entry.hidden)
    : [];
  const index = board ? order.findIndex((entry) => entry.id === board.id) : -1;
  const navigate = useCallback(
    (target: { board?: string; url?: string }) => {
      if (target.board && props.canvas.boards.some((entry) => entry.id === target.board))
        props.onBoard(target.board);
      else if (target.url) window.open(target.url, "_blank", "noopener,noreferrer");
    },
    [props],
  );
  const register = useCallback(() => undefined, []);
  if (!board) return null;
  const fills = board.layout === "page";
  const scale = fills ? 1 : Math.min(1, (box.width - 48) / board.w, (box.height - 48) / board.h);
  return createPortal(
    <div
      role="dialog"
      aria-modal="true"
      aria-label={`播放“${board.name}”`}
      className="fixed inset-0 z-50 flex flex-col bg-neutral-950"
      data-design-player=""
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-3 text-white">
        <span className="min-w-0 flex-1 truncate text-ui">{board.name}</span>
        <span className="text-ui-xs text-white/60">
          {index + 1} / {order.length}
        </span>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="上一个画板"
          tooltip="上一个画板"
          className="text-white/80 hover:text-white"
          disabled={index <= 0}
          onClick={() => index > 0 && props.onBoard(order[index - 1]!.id)}
        >
          <ChevronLeftIcon className="size-4" />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="下一个画板"
          tooltip="下一个画板"
          className="text-white/80 hover:text-white"
          disabled={index < 0 || index >= order.length - 1}
          onClick={() => index < order.length - 1 && props.onBoard(order[index + 1]!.id)}
        >
          <ChevronRightIcon className="size-4" />
        </IconButton>
        <IconButton
          size="icon-xs"
          variant="ghost"
          label="退出播放"
          tooltip="退出播放（Esc）"
          className="text-white/80 hover:text-white"
          onClick={props.onClose}
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
      <div
        ref={stage}
        className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden"
      >
        {box.width > 0 ? (
          <div
            className="relative overflow-hidden bg-white shadow-2xl"
            style={
              fills
                ? { width: "100%", height: "100%" }
                : {
                    width: board.w * scale,
                    height: board.h * scale,
                    borderRadius: (board.radius ?? 0) * scale,
                  }
            }
          >
            <div
              className="absolute top-0 left-0 origin-top-left"
              style={
                fills
                  ? { inset: 0 }
                  : { transform: `scale(${scale})`, width: board.w, height: board.h }
              }
            >
              <DesignBoardFrame
                key={board.id}
                board={fills ? { ...board, w: box.width, h: box.height } : board}
                canvas={props.canvas}
                mode="play"
                interactive
                register={register}
                onLoad={register}
                onNavigate={navigate}
                onError={onError}
              />
            </div>
          </div>
        ) : null}
        {error && error.boardId === board.id ? (
          <div
            role="alert"
            data-design-play-error=""
            className="absolute bottom-4 left-1/2 flex max-w-[min(560px,calc(100%-32px))] -translate-x-1/2 items-center gap-3 rounded-control border border-border bg-popover px-3 py-2 text-ui text-foreground shadow-xl"
          >
            <span className="min-w-0 flex-1 truncate">这个画板的脚本出错了：{error.message}</span>
            {props.onFix ? (
              <Button
                size="xs"
                onClick={() => {
                  props.onFix?.(error.boardId, error.message);
                  setError(null);
                }}
              >
                让 Moss 修复
              </Button>
            ) : null}
            <Button size="xs" variant="ghost" onClick={() => setError(null)}>
              关闭
            </Button>
          </div>
        ) : null}
      </div>
    </div>,
    window.document.body,
  );
}
