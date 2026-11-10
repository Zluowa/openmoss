// FILE: BoardItemView.tsx
// Purpose: 白板 (kind `board`): opens Moss Canvas's whiteboard inside the 资料空间.
// Layer: 资料空间 types stream. Drawing, storage and the tldraw license stay inside Moss Canvas;
//        this file only hosts the existing Canvas surface.

import { parseBoardItem } from "@moss/shared/spaceItems/itemData";
import { useMemo, useState } from "react";

import { WhiteboardIcon } from "~/lib/icons";
import { Button } from "../../ui/button";
import { MossCanvasWebSurface } from "../../MossCanvasWebSurface";

export function BoardItemView(props: {
  data: string;
  onLeaveGuardChange?: (guard: (() => Promise<boolean>) | null) => void;
}) {
  const board = useMemo(() => {
    try {
      return parseBoardItem(props.data);
    } catch {
      return null;
    }
  }, [props.data]);
  const [open, setOpen] = useState(true);
  if (!board) {
    return (
      <p role="alert" className="p-8 text-destructive">
        这个白板的内容无法读取。
      </p>
    );
  }
  return open ? (
    <div className="flex min-h-0 flex-1 flex-col" data-board-item={board.canvasProjectKey}>
      <MossCanvasWebSurface
        embedded
        onClose={() => setOpen(false)}
        {...(props.onLeaveGuardChange ? { onLeaveGuardChange: props.onLeaveGuardChange } : {})}
      />
    </div>
  ) : (
    <div className="flex flex-1 flex-col items-center justify-center gap-3 text-muted-foreground">
      <WhiteboardIcon className="size-8" aria-hidden />
      <p className="text-ui-sm">白板在 Moss 画布中打开。</p>
      <Button size="sm" variant="outline" onClick={() => setOpen(true)}>
        打开白板
      </Button>
    </div>
  );
}
