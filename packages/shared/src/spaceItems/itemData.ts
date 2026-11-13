// FILE: itemData.ts
// Purpose: One entry point for the typed 资料空间 item payloads (slides, sheet, board, app, design):
//          validate by kind, create an empty payload, and derive the readable text projection.
// Layer: Shared model
// Why: The server stores payloads it does not render. It still has to reject malformed agent
//      input and keep `content` (search, agent reads, the page list) in step with the payload.

import { createDesignCanvas, parseDesignCanvas, projectDesignCanvas } from "./designCanvas";
import { isDashboardPayload, parseDashboard, projectDashboard } from "./dashboard";
import { createSheetWorkbook, parseSheetWorkbook, projectSheetWorkbook } from "./sheetWorkbook";
import { createSlidesDeck, parseSlidesDeck, projectSlidesDeck } from "./slidesDeck";

export const TYPED_ITEM_KINDS = ["slides", "sheet", "board", "app", "design"] as const;
export type TypedItemKind = (typeof TYPED_ITEM_KINDS)[number];
export const isTypedItemKind = (kind: unknown): kind is TypedItemKind =>
  typeof kind === "string" && (TYPED_ITEM_KINDS as readonly string[]).includes(kind);

/** 白板: the item only names the Moss Canvas project that holds the drawing. */
export interface BoardItem {
  readonly version: 1;
  /** Stable Canvas project key, `space-board-<pageId>` for boards made here. */
  readonly canvasProjectKey: string;
  readonly note?: string;
}

/** The app-page capability names an 应用页 may declare (apps-runtime owns their behavior). */
export const APP_CAPABILITIES = ["db", "ai", "downloads", "user", "permissions"] as const;
export type AppCapability = (typeof APP_CAPABILITIES)[number];

/** 应用页 payload as written by templates. apps-runtime serves and isolates it. */
export interface AppItem {
  readonly version: 1;
  readonly html: string;
  readonly capabilities: readonly AppCapability[];
}

const ITEM_DATA_BYTES = 2_000_000;
function record(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${what}: expected an object`);
  }
  return value as Record<string, unknown>;
}

export function parseBoardItem(input: string | unknown): BoardItem {
  const value = record(typeof input === "string" ? JSON.parse(input) : input, "board");
  if (value.version !== 1) throw new Error("Invalid board: version must be 1");
  if (
    typeof value.canvasProjectKey !== "string" ||
    !/^[A-Za-z0-9:_-]{1,128}$/u.test(value.canvasProjectKey)
  ) {
    throw new Error("Invalid board: canvasProjectKey must be 1-128 letters, digits, :, _ or -");
  }
  if (value.note !== undefined && (typeof value.note !== "string" || value.note.length > 2_000)) {
    throw new Error("Invalid board: note must be at most 2000 characters");
  }
  return {
    version: 1,
    canvasProjectKey: value.canvasProjectKey,
    ...(value.note ? { note: value.note as string } : {}),
  };
}

export function parseAppItem(input: string | unknown): AppItem {
  if (typeof input === "string" && input.length > ITEM_DATA_BYTES)
    throw new Error("Invalid app page: too large");
  const value = record(typeof input === "string" ? JSON.parse(input) : input, "app page");
  if (value.version !== 1) throw new Error("Invalid app page: version must be 1");
  if (
    typeof value.html !== "string" ||
    value.html.length === 0 ||
    value.html.length > ITEM_DATA_BYTES
  ) {
    throw new Error("Invalid app page: html must be a non-empty string");
  }
  if (!Array.isArray(value.capabilities))
    throw new Error("Invalid app page: capabilities must be an array");
  const capabilities = [...new Set(value.capabilities)];
  for (const capability of capabilities) {
    if (!(APP_CAPABILITIES as readonly unknown[]).includes(capability)) {
      throw new Error(`Invalid app page: unknown capability ${String(capability)}`);
    }
  }
  return { version: 1, html: value.html, capabilities: capabilities as AppCapability[] };
}

export interface ParsedItemData {
  /** Normalized JSON to store. */
  readonly data: string;
  /** Markdown/plain projection stored as the page `content`. */
  readonly content: string;
}

/** Validates a payload for its kind and derives the stored projection. Throws on bad input. */
export function parseItemData(kind: TypedItemKind, input: string, title = ""): ParsedItemData {
  if (input.length > ITEM_DATA_BYTES) throw new Error("Item data is larger than 2 MB");
  switch (kind) {
    case "slides": {
      const deck = parseSlidesDeck(input);
      return { data: JSON.stringify(deck), content: projectSlidesDeck(deck) };
    }
    case "sheet": {
      const workbook = parseSheetWorkbook(input);
      return { data: JSON.stringify(workbook), content: projectSheetWorkbook(workbook) };
    }
    case "board": {
      const board = parseBoardItem(input);
      return { data: JSON.stringify(board), content: board.note ?? `白板 ${title}`.trim() };
    }
    case "app": {
      // A 数据看板 is an `app` item with a version-2 payload; v1 应用页 keep their HTML body.
      if (isDashboardPayload(input)) {
        const dashboard = parseDashboard(input);
        return { data: JSON.stringify(dashboard), content: projectDashboard(dashboard, title) };
      }
      const app = parseAppItem(input);
      const text = app.html
        .replace(/<(script|style)[\s\S]*?<\/\1>/giu, " ")
        .replace(/<[^>]+>/gu, " ")
        .replace(/\s+/gu, " ")
        .trim()
        .slice(0, 4_000);
      return { data: JSON.stringify(app), content: text };
    }
    case "design": {
      const canvas = parseDesignCanvas(input);
      return { data: JSON.stringify(canvas), content: projectDesignCanvas(canvas, title) };
    }
  }
}

export function emptyItemData(
  kind: TypedItemKind,
  options: { title?: string; pageKey?: string } = {},
): string {
  switch (kind) {
    case "slides":
      return JSON.stringify(createSlidesDeck(options.title ?? ""));
    case "sheet":
      return JSON.stringify(createSheetWorkbook());
    case "board":
      return JSON.stringify({
        version: 1,
        canvasProjectKey: `space-board-${(options.pageKey ?? "new").replace(/[^A-Za-z0-9_-]/gu, "").slice(0, 100)}`,
      } satisfies BoardItem);
    case "app":
      return JSON.stringify({
        version: 1,
        html: "<!doctype html><title>应用页</title><main><h1>应用页</h1></main>",
        capabilities: [],
      } satisfies AppItem);
    case "design":
      return JSON.stringify(createDesignCanvas());
  }
}
