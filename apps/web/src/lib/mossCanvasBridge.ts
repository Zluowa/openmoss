// FILE: mossCanvasBridge.ts
// Purpose: Keep the Images rail entry renderer-safe while Moss Canvas wiring is
// completed in PR2. The optional globals are intentionally discovered at call
// time so this module stays usable in the browser and during server rendering.
// Layer: Web renderer bridge stub

export const MOSS_CANVAS_OPEN_EVENT = "moss-canvas-bridge:open" as const;
export const MOSS_CANVAS_CLOSE_EVENT = "moss-canvas-bridge:close" as const;
export const LEGACY_HOOLA_CANVAS_OPEN_EVENT = "open-hoola-canvas" as const;

export type MossCanvasCloseReason = "surface" | "destination-switch";

export interface MossCanvasOpenOptions {
  readonly surface?: string;
  readonly threadId?: string;
  readonly image?: MossCanvasImageFocus;
}

export interface MossCanvasImageFocus {
  readonly jobId: string;
  readonly imageIndex: number;
  readonly action?:
    | "canvas"
    | "edit"
    | "annotate"
    | "comment"
    | "erase"
    | "remove-background"
    | "resize";
}

export function sanitizeMossCanvasImageFocus(value: unknown): MossCanvasImageFocus | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined;
  const item = value as Record<string, unknown>;
  if (
    typeof item.jobId !== "string" ||
    !/^moss_[A-Za-z0-9_-]{1,128}$/u.test(item.jobId) ||
    !Number.isInteger(item.imageIndex) ||
    (item.imageIndex as number) < 0 ||
    (item.imageIndex as number) > 31 ||
    (item.action !== undefined &&
      !["canvas", "edit", "annotate", "comment", "erase", "remove-background", "resize"].includes(
        String(item.action),
      ))
  )
    return undefined;
  return {
    jobId: item.jobId,
    imageIndex: item.imageIndex as number,
    ...(item.action ? { action: item.action as NonNullable<MossCanvasImageFocus["action"]> } : {}),
  };
}

export interface MossCanvasOpenDetail {
  readonly source: "moss-synara";
  readonly surface: string;
  readonly threadId?: string;
  readonly image?: MossCanvasImageFocus;
}

/**
 * An in-app Canvas host can register a synchronous opener.  This keeps the
 * bridge useful when the Canvas workspace is embedded in the chat shell while
 * preserving the optional preload/standalone aliases for desktop builds.
 */
export type MossCanvasOpenHandler = (detail: MossCanvasOpenDetail) => unknown;

let embeddedCanvasHost: MossCanvasOpenHandler | null = null;

/**
 * Register the renderer-owned Canvas surface. The returned disposer only
 * clears the registration made by this call, so a newer host cannot be
 * accidentally removed by an older route unmount.
 */
export function registerMossCanvasHost(handler: MossCanvasOpenHandler): () => void {
  embeddedCanvasHost = handler;
  return () => {
    if (embeddedCanvasHost === handler) embeddedCanvasHost = null;
  };
}

interface MossCanvasBridgeHost {
  readonly mossCanvasBridge?: {
    open(input: MossCanvasOpenDetail): unknown;
  };
  readonly mossCanvas?: {
    execute(command: MossCanvasOpenCommand): unknown;
  };
  readonly hoolaCanvas?: {
    execute(command: MossCanvasOpenCommand): unknown;
  };
}

interface MossCanvasOpenCommand {
  readonly action: "canvas.ui.open_main_menu";
  readonly args: MossCanvasOpenDetail;
}

/**
 * Rail destination bridge used by Images (Moss Canvas) and Library (资料库).
 *
 * Naming note: historically both destinations share `openMossCanvas` /
 * `canvasSurface` in `_chat.tsx`. Images → `MossImagesWorkspace` (Codex-style
 * prompt-to-image; Canvas host deferred / secondary). Library →
 * `MossLibrarySurface` (应用级资料库) — not the Canvas asset library. Prefer
 * `openMossLibraryDestination()` at Library call sites.
 *
 * The bridge and canvas globals are optional because PR1 can run without the
 * standalone Canvas app. Events remain the final integration seam, allowing a
 * future embed or desktop host to handle the request without changing the
 * sidebar call site.
 */
export function openMossCanvas(options: MossCanvasOpenOptions = {}): void {
  const detail: MossCanvasOpenDetail = {
    source: "moss-synara",
    surface: options.surface?.trim() || "images",
    ...(options.threadId ? { threadId: options.threadId } : {}),
    ...(options.image ? { image: options.image } : {}),
  };

  if (embeddedCanvasHost && invokeEmbeddedCanvasHost(embeddedCanvasHost, detail)) {
    return;
  }

  const host = getCanvasHost();
  if (host && invokeCanvasHost(host, detail)) {
    return;
  }

  // Events are a single fallback seam. PR1 targets the existing standalone
  // Canvas listener (`open-hoola-canvas`); the canonical Moss bridge takes the
  // direct API path above in PR2. Broadcasting both aliases would let one host
  // handle the same click twice.
  dispatchCanvasOpenEvent(LEGACY_HOOLA_CANVAS_OPEN_EVENT, detail);
}

/**
 * Open the 资料库 (Library) destination overlay — not Moss Canvas projects.
 * Thin alias so rail / reviewers do not confuse Library with Images→Canvas.
 */
export function openMossLibraryDestination(): void {
  openMossCanvas({ surface: "library" });
}

function invokeEmbeddedCanvasHost(
  handler: MossCanvasOpenHandler,
  detail: MossCanvasOpenDetail,
): boolean {
  try {
    const result = handler(detail);
    if (result === false) return false;
    consumeBridgeResult(result, () => {
      dispatchCanvasOpenEvent(LEGACY_HOOLA_CANVAS_OPEN_EVENT, detail);
    });
    return true;
  } catch {
    // A route-owned host may have unmounted between a click and its effect
    // cleanup. Continue to the preload/event compatibility paths in that case.
    return false;
  }
}

function getCanvasHost(): MossCanvasBridgeHost | null {
  if (typeof window !== "undefined") {
    return window as unknown as MossCanvasBridgeHost;
  }

  // `globalThis` keeps the utility importable in SSR and unit-test contexts.
  return globalThis as unknown as MossCanvasBridgeHost;
}

function invokeCanvasHost(host: MossCanvasBridgeHost, detail: MossCanvasOpenDetail): boolean {
  const bridge = host.mossCanvasBridge;
  if (typeof bridge?.open === "function") {
    try {
      consumeBridgeResult(bridge.open(detail), () =>
        dispatchCanvasOpenEvent(LEGACY_HOOLA_CANVAS_OPEN_EVENT, detail),
      );
      return true;
    } catch {
      // A stale preload bridge must not prevent the event fallback below.
    }
  }

  const command: MossCanvasOpenCommand = {
    action: "canvas.ui.open_main_menu",
    args: detail,
  };

  for (const canvas of [host.mossCanvas, host.hoolaCanvas]) {
    if (typeof canvas?.execute !== "function") continue;
    try {
      consumeBridgeResult(canvas.execute(command), () =>
        dispatchCanvasOpenEvent(LEGACY_HOOLA_CANVAS_OPEN_EVENT, detail),
      );
      return true;
    } catch {
      // Try the compatibility canvas alias before falling back to events.
    }
  }
  return false;
}

function consumeBridgeResult(result: unknown, onRejected: () => void): void {
  if (!result || (typeof result !== "object" && typeof result !== "function")) return;
  const then = (result as { then?: unknown }).then;
  if (typeof then !== "function") return;

  try {
    void Promise.resolve(result as PromiseLike<unknown>).catch(onRejected);
  } catch {
    // Reading a hostile thenable must never leak into the renderer click path.
    onRejected();
  }
}

function dispatchCanvasOpenEvent(eventName: string, detail: MossCanvasOpenDetail): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent !== "function") return;

  try {
    window.dispatchEvent(new CustomEvent<MossCanvasOpenDetail>(eventName, { detail }));
  } catch {
    // Event dispatch is a best-effort PR1 seam; the optional bridge call above
    // has already had an opportunity to handle the request.
  }
}

/** Close any in-shell Canvas / Library destination surface. */
export function closeMossCanvas(reason: MossCanvasCloseReason = "surface"): void {
  if (typeof window === "undefined" || typeof window.dispatchEvent !== "function") return;
  if (typeof CustomEvent !== "function") return;
  try {
    window.dispatchEvent(new CustomEvent(MOSS_CANVAS_CLOSE_EVENT, { detail: { reason } }));
  } catch {
    // Best-effort close seam for rail destination switches.
  }
}
