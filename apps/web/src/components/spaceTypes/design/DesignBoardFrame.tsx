// FILE: DesignBoardFrame.tsx
// Purpose: One 设计 artboard's frame on the canvas. While editing it is a same-origin document
//          with scripts off, so the editor reads and patches its DOM; while playing it runs the
//          artboard's scripts in an isolated origin and reports followed links.
// Layer: 资料空间 设计 (web)
// Why: An edit made on the DOM is already on screen, so the frame reloads only when the source
//      changed some other way (undo, an agent's write, a theme or tweak change).

import type { DesignBoard, DesignCanvas } from "@moss/shared/spaceItems/designCanvas";
import { memo, useEffect, useRef, useState } from "react";

import {
  boardSrcdoc,
  DESIGN_ERROR_MESSAGE,
  DESIGN_NAV_MESSAGE,
  type DesignFrameMode,
} from "./designDocument";

export interface DesignFrameHandle {
  readonly boardId: string;
  /** The HTML the frame's DOM matches right now. */
  written: string;
  doc: () => Document | null;
  body: () => HTMLElement | null;
  window: () => Window | null;
}

function styleKey(board: DesignBoard, canvas: DesignCanvas): string {
  return JSON.stringify([
    canvas.theme ?? "light",
    canvas.system?.source ?? null,
    canvas.system?.copiedAt ?? null,
    canvas.system ? canvas.system.tokens.colors.length : 0,
    board.tweaks ?? null,
    board.tweakValues ?? null,
  ]);
}

export const DesignBoardFrame = memo(function DesignBoardFrame(props: {
  board: DesignBoard;
  canvas: DesignCanvas;
  mode: Exclude<DesignFrameMode, "export">;
  /** Lets the frame take pointer events (text editing, playing). */
  interactive: boolean;
  register: (boardId: string, handle: DesignFrameHandle | null) => void;
  onLoad: (boardId: string) => void;
  onNavigate?: ((target: { board?: string; url?: string }) => void) | undefined;
  /** A playing artboard's script threw (play mode only). */
  onError?: ((message: string) => void) | undefined;
}) {
  const frame = useRef<HTMLIFrameElement | null>(null);
  const mode = useRef(props.mode);
  mode.current = props.mode;
  // The frame's DOM is only handed out once the current document has loaded, so an edit made
  // while it reloads never serializes the blank page in between.
  const loaded = useRef(false);
  const handle = useRef<DesignFrameHandle>({
    boardId: props.board.id,
    written: props.board.html,
    doc: () =>
      mode.current === "edit" && loaded.current ? (frame.current?.contentDocument ?? null) : null,
    body: () =>
      mode.current === "edit" && loaded.current
        ? (frame.current?.contentDocument?.body ?? null)
        : null,
    window: () => frame.current?.contentWindow ?? null,
  });
  const keys = useRef({ style: styleKey(props.board, props.canvas), mode: props.mode });
  const [srcDoc, setSrcDoc] = useState(() => boardSrcdoc(props.board, props.canvas, props.mode));
  const current = useRef(srcDoc);
  const reloads = useRef(0);

  useEffect(() => {
    const style = styleKey(props.board, props.canvas);
    const stale =
      props.board.html !== handle.current.written ||
      style !== keys.current.style ||
      props.mode !== keys.current.mode;
    if (!stale) return;
    handle.current.written = props.board.html;
    keys.current = { style, mode: props.mode };
    // The DOM may have been edited in place since the last load, so the same source still needs
    // a fresh load; a counter comment makes the document new to the frame.
    let next = boardSrcdoc(props.board, props.canvas, props.mode);
    if (next === current.current) next = `${next}<!--${(reloads.current += 1)}-->`;
    loaded.current = false;
    current.current = next;
    setSrcDoc(next);
  }, [props.board, props.canvas, props.mode]);

  useEffect(() => {
    const id = props.board.id;
    props.register(id, handle.current);
    return () => props.register(id, null);
    // The handle object is stable for this artboard.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [props.board.id]);

  useEffect(() => {
    if (props.mode !== "play" || (!props.onNavigate && !props.onError)) return;
    const navigate = props.onNavigate;
    const report = props.onError;
    const listen = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow) return;
      const data = event.data as {
        type?: unknown;
        board?: unknown;
        url?: unknown;
        message?: unknown;
      } | null;
      if (data?.type === DESIGN_ERROR_MESSAGE && typeof data.message === "string") {
        report?.(data.message.slice(0, 400));
        return;
      }
      if (!data || data.type !== DESIGN_NAV_MESSAGE || !navigate) return;
      if (typeof data.board === "string") navigate({ board: data.board });
      else if (typeof data.url === "string" && /^https?:\/\//iu.test(data.url))
        navigate({ url: data.url });
    };
    window.addEventListener("message", listen);
    return () => window.removeEventListener("message", listen);
  }, [props.mode, props.onNavigate, props.onError]);

  return (
    <iframe
      ref={frame}
      title={props.board.name}
      // Editing: same origin, no scripts (the editor patches the DOM). Playing: scripts in an
      // opaque origin, no same-origin access, no top navigation.
      sandbox={props.mode === "play" ? "allow-scripts allow-forms" : "allow-same-origin"}
      srcDoc={srcDoc}
      tabIndex={props.interactive ? 0 : -1}
      data-design-frame={props.board.id}
      data-design-frame-mode={props.mode}
      className="absolute inset-0 block border-0 bg-transparent"
      style={{
        width: props.board.w,
        height: props.board.h,
        pointerEvents: props.interactive ? "auto" : "none",
        borderRadius: props.board.radius ?? 0,
      }}
      onLoad={() => {
        loaded.current =
          frame.current?.contentDocument?.readyState === "complete" || props.mode === "play";
        props.onLoad(props.board.id);
      }}
    />
  );
});
