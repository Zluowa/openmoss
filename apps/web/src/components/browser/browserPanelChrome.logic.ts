// FILE: browserPanelChrome.logic.ts
// Purpose: Pure rules behind the browser panel's chrome: how the address field shows a
//   page (host dark, path muted; a local page as its file name, never its folder
//   chain), the viewport presets and how a preset fits the page area, and which tab
//   a page should open in.
// Layer: BrowserPanel logic

import type { BrowserTabState } from "@moss/contracts";
import { isBlankBrowserTabUrl, localFilePathFromUrl } from "@moss/shared/browserSession";
import { isWorkspaceRootWithin } from "@moss/shared/threadWorkspace";

export interface BrowserAddressDisplay {
  /** Read first and drawn in the primary tone: the host, or a local page's file name. */
  readonly primary: string;
  /** Drawn muted after (or, for a local page, before) the primary part. */
  readonly secondary: string;
  readonly kind: "web" | "file" | "blank" | "other";
}

const EMPTY_DISPLAY: BrowserAddressDisplay = { primary: "", secondary: "", kind: "blank" };

function splitPath(path: string): { folder: string; name: string } {
  const normalized = path.replaceAll("\\", "/");
  const slash = normalized.lastIndexOf("/");
  return slash < 0
    ? { folder: "", name: normalized }
    : { folder: normalized.slice(0, slash + 1), name: normalized.slice(slash + 1) };
}

/**
 * The address field's resting text. A web page reads `localhost:5173` + `/path?query`;
 * a page opened from disk reads only as its name, with the folder it sits in under the
 * project (`site/` + `index.html`) and never the drive-to-file chain.
 */
export function browserAddressDisplay(
  url: string | null | undefined,
  workspaceRoot?: string | null,
): BrowserAddressDisplay {
  const value = url?.trim() ?? "";
  if (value.length === 0 || value === "about:blank") return EMPTY_DISPLAY;
  const filePath = localFilePathFromUrl(value);
  if (filePath) {
    const { name } = splitPath(filePath);
    let folder = "";
    if (workspaceRoot && isWorkspaceRootWithin(filePath, workspaceRoot)) {
      const relative = filePath
        .replaceAll("\\", "/")
        .slice(workspaceRoot.replaceAll("\\", "/").replace(/\/+$/, "").length + 1);
      folder = splitPath(relative).folder;
    }
    return { primary: name, secondary: folder, kind: "file" };
  }
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    return { primary: value, secondary: "", kind: "other" };
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return { primary: value, secondary: "", kind: "other" };
  }
  const rest = `${parsed.pathname === "/" ? "" : parsed.pathname}${parsed.search}${parsed.hash}`;
  return { primary: parsed.host, secondary: rest, kind: "web" };
}

/** What the address field holds while it is being edited. */
export function browserAddressEditValue(
  url: string | null | undefined,
  workspaceRoot?: string | null,
): string {
  const display = browserAddressDisplay(url, workspaceRoot);
  if (display.kind === "file") return `${display.secondary}${display.primary}`;
  if (display.kind === "blank") return "";
  return url?.trim() ?? "";
}

// ---------------------------------------------------------------------------
// Viewport

export interface BrowserViewportPreset {
  readonly id: "laptop" | "desktop" | "mobile" | "tablet";
  readonly width: number;
  readonly height: number;
  /** Shown beside the label in the menu. */
  readonly hint: string;
}

/** Device sizes offered under "Viewport". "Responsive" (null) fills the panel. */
export const BROWSER_VIEWPORT_PRESETS: readonly BrowserViewportPreset[] = [
  { id: "laptop", width: 1280, height: 800, hint: "16:10" },
  { id: "desktop", width: 1024, height: 768, hint: "4:3" },
  { id: "mobile", width: 375, height: 812, hint: "375 × 812" },
  { id: "tablet", width: 768, height: 1024, hint: "768 × 1024" },
];

export function findBrowserViewportPreset(
  id: string | null | undefined,
): BrowserViewportPreset | null {
  return BROWSER_VIEWPORT_PRESETS.find((preset) => preset.id === id) ?? null;
}

export interface BrowserViewportFrame {
  /** Offset and size of the page inside the page area, in CSS pixels. */
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
  /** Page zoom so the page lays out at the preset's width while drawn this size. */
  readonly scale: number;
}

const VIEWPORT_MARGIN_PX = 12;

/**
 * Where a preset sits in the page area: centred, at its own size when it fits, else
 * scaled down as a whole (the page still lays out at the preset width). Null for
 * Responsive.
 */
export function resolveBrowserViewportFrame(
  slot: { readonly width: number; readonly height: number },
  preset: BrowserViewportPreset | null,
): BrowserViewportFrame | null {
  if (!preset || slot.width <= 0 || slot.height <= 0) return null;
  const availableWidth = Math.max(1, slot.width - VIEWPORT_MARGIN_PX * 2);
  const availableHeight = Math.max(1, slot.height - VIEWPORT_MARGIN_PX * 2);
  const scale = Math.min(1, availableWidth / preset.width, availableHeight / preset.height);
  const width = Math.max(1, Math.floor(preset.width * scale));
  const height = Math.max(1, Math.floor(preset.height * scale));
  return {
    x: Math.round((slot.width - width) / 2),
    y: Math.round((slot.height - height) / 2),
    width,
    height,
    scale,
  };
}

// ---------------------------------------------------------------------------
// Which tab a page opens in

function comparableUrl(url: string | null | undefined): string {
  if (!url) return "";
  try {
    const parsed = new URL(url);
    parsed.hash = "";
    return parsed.href.replace(/\/$/, "");
  } catch {
    return url.trim();
  }
}

function urlOrigin(url: string | null | undefined): string | null {
  if (!url) return null;
  try {
    const parsed = new URL(url);
    return parsed.protocol === "http:" || parsed.protocol === "https:" ? parsed.origin : null;
  } catch {
    return null;
  }
}

export type BrowserOpenPlan =
  | { readonly kind: "select"; readonly tabId: string; readonly reload: boolean }
  | { readonly kind: "navigate"; readonly tabId: string }
  | { readonly kind: "newTab" };

/**
 * Opening a page reuses the tab already showing it (a file is reloaded so its latest
 * version shows; a server keeps whatever page the person reached on it), fills a blank
 * active tab, and otherwise takes a new tab, so it never replaces a page in use.
 */
export function planBrowserOpen(input: {
  readonly tabs: readonly BrowserTabState[];
  readonly activeTabId: string | null;
  readonly url: string;
}): BrowserOpenPlan {
  const target = comparableUrl(input.url);
  const isFile = localFilePathFromUrl(input.url) !== null;
  const exact = input.tabs.find(
    (tab) =>
      comparableUrl(tab.lastCommittedUrl ?? tab.url) === target ||
      comparableUrl(tab.url) === target,
  );
  if (exact) return { kind: "select", tabId: exact.id, reload: isFile };
  const origin = isFile ? null : urlOrigin(input.url);
  const targetPath = (() => {
    try {
      return new URL(input.url).pathname;
    } catch {
      return "/";
    }
  })();
  if (origin && (targetPath === "/" || targetPath === "")) {
    const sameOrigin = input.tabs.find(
      (tab) => urlOrigin(tab.lastCommittedUrl ?? tab.url) === origin,
    );
    if (sameOrigin) return { kind: "select", tabId: sameOrigin.id, reload: false };
  }
  const active = input.tabs.find((tab) => tab.id === input.activeTabId) ?? null;
  if (active && isBlankBrowserTabUrl(active)) return { kind: "navigate", tabId: active.id };
  return { kind: "newTab" };
}
