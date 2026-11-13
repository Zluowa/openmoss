// FILE: DesignThumbnail.tsx
// Purpose: A still picture of one 设计 artboard at any width (template gallery, 资料空间 card):
//          the artboard's own document in a script-less frame, scaled down.
// Layer: 资料空间 设计 (web)

import type { Page } from "@moss/contracts";
import {
  parseDesignCanvas,
  type DesignBoard,
  type DesignCanvas,
} from "@moss/shared/spaceItems/designCanvas";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";

import { boardSrcdoc } from "./designDocument";
import { observeSize } from "./designSize";

/** The artboard that stands for a design: its thumbnail, else the first in reading order. */
export function coverBoard(canvas: DesignCanvas): DesignBoard | null {
  const chosen = canvas.thumbnailBoardId
    ? canvas.boards.find((board) => board.id === canvas.thumbnailBoardId)
    : undefined;
  if (chosen) return chosen;
  const page = canvas.pages[0]?.id;
  return (
    [...canvas.boards]
      .filter((board) => board.page === page && !board.hidden)
      .sort((a, b) => (Math.abs(a.y - b.y) < 40 ? a.x - b.x : a.y - b.y))[0] ?? null
  );
}

export function DesignBoardPicture(props: {
  canvas: DesignCanvas;
  board: DesignBoard;
  /** Box the picture fits into (contain). */
  width: number;
  height: number;
}) {
  const scale = Math.min(props.width / props.board.w, props.height / props.board.h);
  const srcDoc = useMemo(
    () => boardSrcdoc(props.board, props.canvas, "export"),
    [props.board, props.canvas],
  );
  return (
    <span
      className="relative block overflow-hidden"
      style={{ width: props.board.w * scale, height: props.board.h * scale }}
      aria-hidden
    >
      <iframe
        title=""
        tabIndex={-1}
        sandbox=""
        srcDoc={srcDoc}
        className="pointer-events-none absolute top-0 left-0 origin-top-left border-0 bg-transparent"
        style={{ width: props.board.w, height: props.board.h, transform: `scale(${scale})` }}
      />
    </span>
  );
}

/** The picture on a 设计 card and template tile: the cover artboard, centred. */
export function DesignThumbnail(props: { canvas: DesignCanvas | null; className?: string }) {
  const frame = useRef<HTMLSpanElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = observeSize(element, setSize);
    return () => observer.disconnect();
  }, []);
  const board = props.canvas ? coverBoard(props.canvas) : null;
  return (
    <span
      ref={frame}
      className={props.className ?? "flex h-36 items-center justify-center overflow-hidden"}
      data-design-thumbnail
    >
      {props.canvas && board && size.width > 0 ? (
        <DesignBoardPicture
          canvas={props.canvas}
          board={board}
          width={size.width - 16}
          height={size.height - 16}
        />
      ) : null}
    </span>
  );
}

export function DesignCardPreview(props: { page: Page }) {
  const query = useQuery({
    queryKey: ["design-card", props.page.scopeSpaceId, props.page.id, props.page.revision],
    queryFn: async () => {
      const item = await ensureNativeApi().pageTypes.read({
        scopeSpaceId: props.page.scopeSpaceId,
        pageId: props.page.id,
      });
      return item.data ? parseDesignCanvas(item.data) : null;
    },
    staleTime: Infinity,
    retry: false,
  });
  return (
    <DesignThumbnail
      canvas={query.data ?? null}
      className="flex h-36 items-center justify-center overflow-hidden rounded-t-panel border-b border-border bg-muted/40"
    />
  );
}
