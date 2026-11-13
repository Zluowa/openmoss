// FILE: DesignShapes.tsx
// Purpose: What the 设计 canvas draws besides artboards and stickies: loose shapes (rectangle,
//          oval, line, arrow, pen and pencil paths, pictures), link cards, the floating bar above
//          a selection, and the cursors and selections of the other people in the live room.
// Layer: 资料空间 设计 (web)
// Why: Loose shapes and link cards are canvas notes, so they move, select, copy and undo with
//      the notes; this file only says how each one looks.

import type { DesignNote } from "@moss/shared/spaceItems/designCanvas";
import { arrowHead } from "@moss/shared/spaceItems/designDraw";
import type { ReactNode } from "react";

import { CopyIcon, CropIcon, ExternalLinkIcon, LinkIcon, TrashCanIcon } from "~/lib/icons";
import { spacePageIdOfLink } from "~/lib/spacePageLink";
import { cn } from "~/lib/utils";
import { Button } from "../../ui/button";
import { IconButton } from "../../ui/icon-button";
import type { DesignPeer } from "./designRoom";

type Rect = { x: number; y: number; w: number; h: number };

/** Lines and arrows get this much extra room around them to be easy to click. */
export const SHAPE_HIT_PAD = 6;
const SHAPE_FILL = "color-mix(in srgb, var(--foreground) 8%, transparent)";
const SHAPE_STROKE = "var(--foreground)";

/** The rectangle a canvas note covers (world coordinates). */
export function canvasNoteRect(note: DesignNote): Rect {
  if (note.kind === "shape" && (note.shape === "line" || note.shape === "arrow")) {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = note.points ?? [];
    return {
      x: note.x + Math.min(x1, x2),
      y: note.y + Math.min(y1, y2),
      w: Math.max(1, Math.abs(x2 - x1)),
      h: Math.max(1, Math.abs(y2 - y1)),
    };
  }
  return { x: note.x, y: note.y, w: note.w ?? 120, h: note.h ?? 120 };
}

/** A loose shape on the canvas. Pointer handling comes from the canvas (it is a note). */
export function CanvasShape(props: { note: DesignNote }) {
  const { note } = props;
  const w = Math.max(1, note.w ?? 120);
  const h = Math.max(1, note.h ?? 120);
  const stroke = note.stroke ?? SHAPE_STROKE;
  const width = note.strokeWidth ?? (note.shape === "rect" || note.shape === "oval" ? 0 : 2);
  if (note.shape === "image" && note.src)
    return (
      <img
        alt={note.text || "图片"}
        src={note.src}
        draggable={false}
        className="pointer-events-none block size-full object-cover"
        style={{ width: w, height: h }}
      />
    );
  if (note.shape === "line" || note.shape === "arrow") {
    const [x1 = 0, y1 = 0, x2 = 0, y2 = 0] = note.points ?? [];
    const left = Math.min(x1, x2);
    const top = Math.min(y1, y2);
    return (
      <svg
        className="pointer-events-none absolute overflow-visible"
        style={{
          left: SHAPE_HIT_PAD,
          top: SHAPE_HIT_PAD,
          width: Math.max(1, Math.abs(x2 - x1)),
          height: Math.max(1, Math.abs(y2 - y1)),
        }}
        viewBox={`${left} ${top} ${Math.max(1, Math.abs(x2 - x1))} ${Math.max(1, Math.abs(y2 - y1))}`}
        aria-hidden
      >
        <line
          x1={x1}
          y1={y1}
          x2={x2}
          y2={y2}
          stroke={stroke}
          strokeWidth={width || 2}
          strokeLinecap="round"
        />
        {note.shape === "arrow" ? (
          <polygon points={arrowHead(x1, y1, x2, y2, 10 + (width || 2) * 2)} fill={stroke} />
        ) : null}
      </svg>
    );
  }
  if (note.shape === "path")
    return (
      <svg
        className="pointer-events-none block overflow-visible"
        width={w}
        height={h}
        viewBox={`0 0 ${note.vw ?? w} ${note.vh ?? h}`}
        preserveAspectRatio="none"
        aria-hidden
      >
        <path
          d={note.d ?? ""}
          fill={note.fill ?? "none"}
          stroke={stroke}
          strokeWidth={width || 2}
          strokeLinecap="round"
          strokeLinejoin="round"
          vectorEffect="non-scaling-stroke"
        />
      </svg>
    );
  return (
    <div
      className="pointer-events-none flex size-full items-center justify-center overflow-hidden text-center"
      style={{
        width: w,
        height: h,
        background: note.fill ?? SHAPE_FILL,
        border: width ? `${width}px solid ${stroke}` : undefined,
        borderRadius: note.shape === "oval" ? "50%" : 8,
        color: "var(--foreground)",
        fontSize: 15,
        lineHeight: "21px",
        padding: 8,
        boxSizing: "border-box",
      }}
    >
      {note.text}
    </div>
  );
}

/** Where a link card goes, as people read it. */
export function linkCardTarget(href: string): string {
  if (spacePageIdOfLink(href)) return "资料空间里的条目";
  try {
    return new URL(href).host;
  } catch {
    return href;
  }
}

export function CanvasLinkCard(props: { note: DesignNote }) {
  const { note } = props;
  return (
    <div
      className="pointer-events-none flex size-full items-center gap-4 rounded-card border border-border bg-background px-6 shadow-sm"
      style={{ width: note.w ?? 640, height: note.h ?? 112 }}
    >
      <span className="flex size-12 shrink-0 items-center justify-center rounded-control bg-[color-mix(in_srgb,var(--foreground)_6%,transparent)] text-muted-foreground">
        <LinkIcon className="size-6" />
      </span>
      <span className="flex min-w-0 flex-col gap-1">
        <span className="truncate text-ui-lg font-medium text-foreground">
          {note.text || "链接"}
        </span>
        <span className="truncate text-ui text-muted-foreground">
          {note.subtitle ?? linkCardTarget(note.href ?? "")}
        </span>
      </span>
    </div>
  );
}

/** The small bar above a selection: quick actions for what is selected. */
export function SelectionBar(props: {
  left: number;
  top: number;
  onDuplicate?: () => void;
  onDelete?: () => void;
  onCrop?: () => void;
  onOpen?: () => void;
  onBold?: () => void;
  bold?: boolean;
  children?: ReactNode;
}) {
  return (
    <div
      data-design-selection-bar=""
      className="pointer-events-auto absolute z-10 flex -translate-x-1/2 -translate-y-full items-center gap-0.5 rounded-control border border-border bg-popover p-0.5 shadow-md"
      style={{ left: props.left, top: props.top - 8 }}
      onPointerDown={(event) => event.stopPropagation()}
    >
      {props.onCrop ? (
        <IconButton label="裁切图片" tooltip="裁切（双击图片）" onClick={props.onCrop}>
          <CropIcon className="size-4" />
        </IconButton>
      ) : null}
      {props.onOpen ? (
        <IconButton label="打开链接" tooltip="打开" onClick={props.onOpen}>
          <ExternalLinkIcon className="size-4" />
        </IconButton>
      ) : null}
      {props.onBold ? (
        <Button
          size="xs"
          variant="ghost"
          aria-pressed={props.bold === true}
          className={cn("px-1.5 font-medium", props.bold && "bg-accent")}
          onClick={props.onBold}
        >
          粗体
        </Button>
      ) : null}
      {props.children}
      {props.onDuplicate ? (
        <IconButton label="复制一份" tooltip="复制一份" onClick={props.onDuplicate}>
          <CopyIcon className="size-4" />
        </IconButton>
      ) : null}
      {props.onDelete ? (
        <IconButton label="删除" tooltip="删除" onClick={props.onDelete}>
          <TrashCanIcon className="size-4" />
        </IconButton>
      ) : null}
    </div>
  );
}

/** Other people's cursors (with names) and what they selected, on this page. */
export function PeerOverlay(props: {
  peers: readonly DesignPeer[];
  pageId: string;
  toScreen: (point: { x: number; y: number }) => { x: number; y: number };
  zoom: number;
  rectOf: (peer: DesignPeer) => Rect[];
}) {
  return (
    <>
      {props.peers.map((peer) => {
        if (peer.self || !peer.presence || peer.presence.page !== props.pageId) return null;
        const cursor = peer.presence.cursor;
        const at = cursor ? props.toScreen(cursor) : null;
        return (
          <div key={peer.id} data-design-peer={peer.id}>
            {props.rectOf(peer).map((rect, index) => {
              const corner = props.toScreen(rect);
              return (
                <div
                  key={index}
                  className="absolute border-2"
                  style={{
                    left: corner.x - 1,
                    top: corner.y - 1,
                    width: rect.w * props.zoom + 2,
                    height: rect.h * props.zoom + 2,
                    borderColor: peer.color,
                  }}
                />
              );
            })}
            {at ? (
              <div
                className="absolute transition-[left,top] duration-75 ease-linear"
                style={{ left: at.x, top: at.y }}
              >
                <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="block">
                  <path
                    d="M1 1L6.5 14.5L8.6 8.6L14.5 6.5Z"
                    fill={peer.color}
                    stroke="white"
                    strokeWidth="1.2"
                    strokeLinejoin="round"
                  />
                </svg>
                <span
                  className="ml-3 inline-block -translate-y-0.5 rounded-inline px-1.5 text-ui-xs whitespace-nowrap text-white"
                  style={{ background: peer.color }}
                >
                  {peer.name}
                </span>
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}
