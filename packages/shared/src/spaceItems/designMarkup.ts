// FILE: designMarkup.ts
// Purpose: The markup a 设计 editor tool drops into an artboard (text, rectangle, oval, line,
//          frame, image, video) and a new artboard's empty root.
// Layer: Shared model (web editor tools; agents may use the same starting shapes)
// Why: Defaults read the installed design system through var(--ds-*) with a plain fallback, so a
//      new shape matches the design whatever system it uses.

export type DesignInsertKind = "text" | "rect" | "oval" | "line" | "frame" | "image" | "video";

/** Markup a tool drops into an artboard, placed absolutely at (x, y) in its root element. */
export function insertMarkup(
  kind: DesignInsertKind,
  at: { x: number; y: number },
  src?: string,
): string {
  const place = `position: absolute; left: ${Math.round(at.x)}px; top: ${Math.round(at.y)}px`;
  switch (kind) {
    case "text":
      return `<div style="${place}; font-size: 16px; line-height: 1.4; color: var(--ds-ink, #141413)">输入文字</div>`;
    case "rect":
      return `<div style="${place}; box-sizing: border-box; width: 120px; height: 120px; background-color: var(--ds-fill, #e8e8e6); border-radius: 8px"></div>`;
    case "oval":
      return `<div style="${place}; box-sizing: border-box; width: 96px; height: 96px; background-color: var(--ds-fill, #e8e8e6); border-radius: 50%"></div>`;
    case "line":
      return `<div style="${place}; width: 160px; height: 0; border-top: 2px solid var(--ds-ink, #141413)"></div>`;
    case "frame":
      return `<div style="${place}; box-sizing: border-box; display: flex; flex-direction: column; gap: 12px; width: 240px; min-height: 120px; padding: 16px; background-color: var(--ds-panel, #ffffff); border-radius: 12px; box-shadow: 0 1px 3px rgba(0, 0, 0, 0.08)"></div>`;
    case "image":
      return `<img alt="图片" src="${(src ?? "").replace(/"/gu, "&quot;")}" style="${place}; width: 240px; height: auto; object-fit: cover">`;
    case "video":
      return `<video src="${(src ?? "").replace(/"/gu, "&quot;")}" controls playsinline preload="metadata" style="${place}; width: 320px; height: 180px; object-fit: cover; background-color: black; border-radius: 8px"></video>`;
  }
}

/** A new artboard's starting markup: an empty root at its size. */
export function emptyBoardHtml(w: number, h: number): string {
  return `<div style="position: relative; box-sizing: border-box; width: ${w}px; height: ${h}px; background: var(--ds-paper, #ffffff); color: var(--ds-ink, #141413); font-family: var(--ds-font-sans, system-ui, sans-serif)"></div>`;
}
