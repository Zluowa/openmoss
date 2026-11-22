// FILE: spaceCanvasDockContract.ts
// Purpose: Shared Stage-0 interface contracts for the unified 3-state canvas-bound AI dock,
//          cross-editor selection context, and per-artifact persistent assistant threads.
// Layer: Space / Artifacts UI contract (Stage 0)

import type { ThreadId } from "@moss/contracts";

/** Three live presentation states of the non-unmounting canvas-bound AI dock. */
export type SpaceCanvasDockState = "collapsed" | "pip" | "docked";

/** Supported 资料空间 / Artifacts editor kinds. */
export type SpaceArtifactKind =
  | "page"
  | "slides"
  | "sheet"
  | "design"
  | "dashboard"
  | "board"
  | "app";

/** Host overlay occlusion insets reported by the active dock state (in CSS px). */
export interface SpaceCanvasHostInsets {
  readonly bottomInsetPx: number;
  readonly rightInsetPx: number;
}

/** Structured selection / viewport metadata captured automatically from the active canvas. */
export interface SpaceCanvasSelectionContext {
  readonly kind: SpaceArtifactKind;
  readonly itemId: string;
  readonly title: string;
  readonly anchorBlockId?: string | null;
  readonly slideIds?: readonly string[];
  readonly elementIds?: readonly string[];
  readonly sheetName?: string | null;
  readonly range?: string | null;
  readonly boardIds?: readonly string[];
  readonly quote?: string | null;
  readonly summary?: string | null;
}

export type SpaceCanvasDockAskOrigin =
  | "bottom-pill"
  | "inline-card"
  | "selection-bar"
  | "comment-mention"
  | "template-auto-run"
  | "top-chrome"
  | "editor-bridge";

/** Parameters to summon, prefill, or immediately dispatch a turn inside the canvas dock. */
export interface SpaceCanvasDockRequest {
  readonly prompt?: string;
  readonly prefillOnly?: boolean;
  readonly autoRun?: boolean;
  readonly preferredState?: SpaceCanvasDockState;
  readonly selection?: SpaceCanvasSelectionContext | null;
  readonly keepItemOpen?: boolean;
  readonly origin?: SpaceCanvasDockAskOrigin;
}

/** Imperative & reactive controller shared between artifact hosts and SpaceCanvasChatDock. */
export interface SpaceCanvasDockController {
  readonly state: SpaceCanvasDockState;
  readonly setState: (state: SpaceCanvasDockState) => void;
  readonly activeThreadId: ThreadId | null;
  readonly busy: boolean;
  readonly elapsedSeconds: number;
  readonly statusLabel: string | null;
  readonly ask: (request?: SpaceCanvasDockRequest) => Promise<void> | void;
  readonly openSideChatTab: (options?: {
    readonly title?: string;
    readonly prompt?: string;
  }) => void;
  readonly selection: SpaceCanvasSelectionContext | null;
  readonly setSelection: (selection: SpaceCanvasSelectionContext | null) => void;
  readonly registerHostInsets?: (listener: (insets: SpaceCanvasHostInsets) => void) => () => void;
}

/** Persistent storage keys shared across dock components (single source of truth). */
export const SPACE_DOCK_PERSIST_KEYS = {
  mode: "moss.spaceCanvasDock.mode.v1",
  pipSize: "moss.spaceCanvasDock.pipSize.v1",
  rightWidthRatio: "moss.spaceCanvasDock.rightWidthRatio.v1",
  skipCloseConfirm: "moss.spaceCanvasDock.skipSideChatCloseConfirm.v1",
} as const;
