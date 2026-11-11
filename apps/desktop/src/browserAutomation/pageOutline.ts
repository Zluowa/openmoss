// FILE: pageOutline.ts
// Purpose: A compact, bounded outline of what an agent can read and act on in
// the visible page, built from Chromium's accessibility tree over CDP.
// Layer: Desktop browser automation host
// Exports: PAGE_OUTLINE_MAX_BYTES, renderPageOutline, collectPageOutline, closedShadowBackendIds, AxNode and related types
//
// Browser tool results carry this outline so the model sees the page state in
// the same call that changed it, instead of spending another model turn on a
// lone snapshot. Lines use the role and accessible name an agent passes to
// page.getByRole(role, {name}). The accessibility tree also covers closed
// shadow roots, which neither Playwright locators nor snapshot() can reach;
// controls there carry viewport coordinates (`@x,y`) for page.mouse input.

import { utf8ByteLength, type BrowserPageOutline } from "@moss/contracts";

import type { BrowserAutomationVisibleRuntime } from "../browserManager";
import { sendCdpCommand, throwIfAborted } from "./cdpRuntime";

/** UTF-8 budget for the outline text; the contract bound is 6,000 bytes. */
export const PAGE_OUTLINE_MAX_BYTES = 4_800;
const MAX_URL_BYTES = 8_192;
const MAX_TITLE_BYTES = 2_048;
const MAX_LINE_CHARS = 160;
const MAX_TEXT_CHARS = 100;
const MAX_DOM_NODES = 20_000;
const MAX_POSITIONED_CONTROLS = 40;
const MAX_DEPTH = 40;

export interface AxValue {
  readonly type?: string;
  readonly value?: unknown;
}

export interface AxProperty {
  readonly name: string;
  readonly value?: AxValue;
}

export interface AxNode {
  readonly nodeId: string;
  readonly ignored?: boolean;
  readonly role?: AxValue;
  readonly name?: AxValue;
  readonly value?: AxValue;
  readonly properties?: readonly AxProperty[];
  readonly childIds?: readonly string[];
  readonly backendDOMNodeId?: number;
}

export interface DomNode {
  readonly backendNodeId?: number;
  readonly nodeName?: string;
  readonly shadowRootType?: "user-agent" | "open" | "closed";
  readonly children?: readonly DomNode[];
  readonly shadowRoots?: readonly DomNode[];
  readonly contentDocument?: DomNode;
}

const clipBytes = (value: string, maximum: number): string => {
  if (utf8ByteLength(value) <= maximum) return value;
  let clipped = "";
  for (const character of value) {
    if (utf8ByteLength(clipped + character) > maximum) break;
    clipped += character;
  }
  return clipped;
};

/** Roles an agent acts on; each keeps its name, value and states. */
const CONTROL_ROLES = new Set([
  "button",
  "checkbox",
  "combobox",
  "link",
  "listbox",
  "menuitem",
  "menuitemcheckbox",
  "menuitemradio",
  "option",
  "radio",
  "searchbox",
  "slider",
  "spinbutton",
  "switch",
  "tab",
  "textbox",
  "treeitem",
]);

/** Structure worth a line even without being actionable. */
const LANDMARK_ROLES = new Set([
  "alert",
  "dialog",
  "alertdialog",
  "heading",
  "img",
  "image",
  "iframe",
  "menu",
  "menubar",
  "status",
  "tablist",
  "table",
  "row",
  "cell",
  "columnheader",
  "rowheader",
  "group",
  "radiogroup",
  "listitem",
  "progressbar",
]);

const TEXT_ROLES = new Set(["StaticText", "text"]);

const STATE_PROPERTIES = [
  "checked",
  "selected",
  "expanded",
  "pressed",
  "disabled",
  "required",
  "readonly",
] as const;

const clip = (value: string, maximum: number): string => {
  const collapsed = value.replace(/\s+/gu, " ").trim();
  return collapsed.length > maximum ? `${collapsed.slice(0, maximum - 1)}…` : collapsed;
};

const quoted = (value: string, maximum = MAX_TEXT_CHARS) => JSON.stringify(clip(value, maximum));

const stringValue = (value: AxValue | undefined): string =>
  value?.value === undefined || value.value === null ? "" : String(value.value);

function stateSuffix(node: AxNode): string {
  const states: string[] = [];
  for (const property of node.properties ?? []) {
    if (!(STATE_PROPERTIES as readonly string[]).includes(property.name)) continue;
    const value = property.value?.value;
    if (value === true || value === "true") states.push(property.name);
    else if (value === "mixed") states.push(`${property.name}=mixed`);
    else if (property.name === "expanded" && (value === false || value === "false"))
      states.push("collapsed");
  }
  return states.length > 0 ? ` [${states.join(", ")}]` : "";
}

function headingLevel(node: AxNode): string {
  const level = node.properties?.find((property) => property.name === "level")?.value?.value;
  return typeof level === "number" ? ` [level=${level}]` : "";
}

/**
 * Collects the backend node ids that live inside closed shadow roots. Only
 * those need coordinates: everything else is reachable with locators.
 */
export function closedShadowBackendIds(root: DomNode): Set<number> {
  const closed = new Set<number>();
  let visited = 0;
  const walk = (node: DomNode, insideClosed: boolean) => {
    if (visited++ > MAX_DOM_NODES) return;
    if (insideClosed && node.backendNodeId !== undefined) closed.add(node.backendNodeId);
    for (const child of node.children ?? []) walk(child, insideClosed);
    for (const shadow of node.shadowRoots ?? [])
      walk(shadow, insideClosed || shadow.shadowRootType === "closed");
    if (node.contentDocument) walk(node.contentDocument, insideClosed);
  };
  walk(root, false);
  return closed;
}

export interface RenderOutlineOptions {
  readonly maxBytes?: number;
  /** Viewport centers for closed-shadow controls, by backend node id. */
  readonly positions?: ReadonlyMap<number, { readonly x: number; readonly y: number } | null>;
  readonly closed?: ReadonlySet<number>;
}

/** Pure renderer: accessibility nodes in, bounded outline text out. */
export function renderPageOutline(
  nodes: readonly AxNode[],
  options: RenderOutlineOptions = {},
): { readonly outline: string; readonly truncated: boolean } {
  const maxBytes = options.maxBytes ?? PAGE_OUTLINE_MAX_BYTES;
  const byId = new Map(nodes.map((node) => [node.nodeId, node]));
  const referenced = new Set(nodes.flatMap((node) => node.childIds ?? []));
  const roots = nodes.filter((node) => !referenced.has(node.nodeId));
  const lines: string[] = [];
  let bytes = 0;
  let truncated = false;
  const push = (depth: number, text: string) => {
    if (truncated) return;
    const line = `${"  ".repeat(Math.min(depth, 12))}- ${clip(text, MAX_LINE_CHARS)}`;
    const lineBytes = utf8ByteLength(line) + 1;
    if (bytes + lineBytes > maxBytes) {
      truncated = true;
      return;
    }
    lines.push(line);
    bytes += lineBytes;
  };

  // Label text repeats the accessible name of the control or group it labels.
  const labelNames = new Set(
    nodes
      .filter((node) => !node.ignored)
      .filter((node) => {
        const role = stringValue(node.role);
        return CONTROL_ROLES.has(role) || role === "group" || role === "radiogroup";
      })
      .map((node) => clip(stringValue(node.name), MAX_TEXT_CHARS))
      .filter(Boolean),
  );
  const optionsOf = (node: AxNode, depth = 0): AxNode[] =>
    depth > 4
      ? []
      : (node.childIds ?? [])
          .map((id) => byId.get(id))
          .filter((child): child is AxNode => child !== undefined)
          .flatMap((child) =>
            stringValue(child.role) === "option" ? [child] : optionsOf(child, depth + 1),
          );

  const textOf = (node: AxNode): string => {
    if (TEXT_ROLES.has(stringValue(node.role))) return stringValue(node.name);
    return (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AxNode => child !== undefined)
      .map(textOf)
      .join(" ");
  };

  const visit = (node: AxNode, depth: number, insideControl: boolean) => {
    if (truncated || depth > MAX_DEPTH) return;
    const rawRole = stringValue(node.role);
    const role = rawRole === "Iframe" || rawRole === "IframePresentational" ? "iframe" : rawRole;
    const name = stringValue(node.name);
    const children = (node.childIds ?? [])
      .map((id) => byId.get(id))
      .filter((child): child is AxNode => child !== undefined);
    const recurse = (nextDepth: number, nextInsideControl = insideControl) => {
      for (const child of children) visit(child, nextDepth, nextInsideControl);
    };
    if (node.ignored) return recurse(depth);
    if (TEXT_ROLES.has(role)) {
      // Text inside a named control repeats its name; standalone text is content.
      const text = clip(name, MAX_TEXT_CHARS);
      if (!insideControl && text && !labelNames.has(text)) push(depth, `text: ${text}`);
      return;
    }
    if (CONTROL_ROLES.has(role)) {
      if (role === "option" && insideControl) return; // Rendered inline on the select.
      const position =
        node.backendDOMNodeId !== undefined && options.closed?.has(node.backendDOMNodeId)
          ? options.positions?.get(node.backendDOMNodeId)
          : undefined;
      let line = `${role}${name ? ` ${quoted(name)}` : ""}`;
      const value = stringValue(node.value);
      if (value && role !== "link" && value !== name) line += `: ${quoted(value, 60)}`;
      if (role === "combobox" || role === "listbox") {
        const choices = optionsOf(node).map((child) => clip(stringValue(child.name), 40));
        if (choices.length > 0)
          line += ` options: ${choices.slice(0, 12).join(" | ")}${choices.length > 12 ? " | …" : ""}`;
      }
      line += stateSuffix(node);
      if (position === null) line += " @offscreen (closed shadow root)";
      else if (position) line += ` @${position.x},${position.y} (closed shadow root)`;
      push(depth, line);
      // A control's own children are its label text or popup; skip them,
      // except composite controls whose items are separate targets.
      if (role === "listbox" || role === "tablist") recurse(depth + 1, true);
      return;
    }
    if (role === "heading") {
      push(depth, `heading ${quoted(name || textOf(node))}${headingLevel(node)}`);
      return;
    }
    if (role === "img" || role === "image") {
      if (name.trim()) push(depth, `img ${quoted(name)}`);
      return;
    }
    if (role === "iframe") {
      push(depth, `iframe${name ? ` ${quoted(name)}` : ""} (use page.frameLocator)`);
      return;
    }
    if (role === "cell" || role === "columnheader" || role === "rowheader") {
      const text = name || textOf(node);
      if (text.trim()) push(depth, `${role} ${quoted(text, 60)}`);
      recurse(depth + 1, true);
      return;
    }
    if (role === "row") {
      const cells = children.filter((child) =>
        ["cell", "columnheader", "rowheader", "gridcell"].includes(stringValue(child.role)),
      );
      if (cells.length > 0 && cells.every((cell) => !hasControl(cell, byId))) {
        push(
          depth,
          `row: ${cells.map((cell) => clip(stringValue(cell.name) || textOf(cell), 40)).join(" | ")}`,
        );
        return;
      }
    }
    if (LANDMARK_ROLES.has(role)) {
      if (role === "status" || role === "alert") {
        const text = name || textOf(node);
        push(depth, `${role}${text.trim() ? `: ${clip(text, MAX_TEXT_CHARS)}` : " (empty)"}`);
        return;
      }
      const label = name ? ` ${quoted(name)}` : "";
      if (label || ["dialog", "alertdialog", "menu", "table", "tablist"].includes(role)) {
        push(depth, `${role}${label}${stateSuffix(node)}`);
        return recurse(depth + 1);
      }
      return recurse(depth);
    }
    // Wrappers (generic, paragraph, list, form, landmarks…) and unknown roles
    // lift their children.
    return recurse(depth);
  };
  for (const root of roots) visit(root, 0, false);
  return { outline: lines.join("\n"), truncated };
}

function hasControl(node: AxNode, byId: ReadonlyMap<string, AxNode>): boolean {
  if (CONTROL_ROLES.has(stringValue(node.role))) return true;
  return (node.childIds ?? []).some((id) => {
    const child = byId.get(id);
    return child !== undefined && hasControl(child, byId);
  });
}

const controlNeedsPosition = (node: AxNode, closed: ReadonlySet<number>) =>
  !node.ignored &&
  node.backendDOMNodeId !== undefined &&
  closed.has(node.backendDOMNodeId) &&
  CONTROL_ROLES.has(stringValue(node.role));

async function viewportCenter(
  runtime: BrowserAutomationVisibleRuntime,
  backendNodeId: number,
  viewport: { readonly width: number; readonly height: number },
  signal?: AbortSignal,
): Promise<{ x: number; y: number } | null> {
  try {
    const { quads } = await sendCdpCommand<{ readonly quads?: readonly number[][] }>(
      runtime,
      "DOM.getContentQuads",
      { backendNodeId },
      signal,
    );
    const quad = quads?.[0];
    if (!quad || quad.length < 8) return null;
    const x = Math.round((quad[0]! + quad[2]! + quad[4]! + quad[6]!) / 4);
    const y = Math.round((quad[1]! + quad[3]! + quad[5]! + quad[7]!) / 4);
    return x >= 0 && y >= 0 && x <= viewport.width && y <= viewport.height ? { x, y } : null;
  } catch {
    throwIfAborted(signal);
    return null;
  }
}

/**
 * Reads the outline of the main frame. Never throws for page-shaped reasons:
 * an outline is an observation aid, and a missing one must not turn a
 * completed action into a failure.
 */
export async function collectPageOutline(
  runtime: BrowserAutomationVisibleRuntime,
  signal?: AbortSignal,
  maxBytes = PAGE_OUTLINE_MAX_BYTES,
): Promise<BrowserPageOutline | undefined> {
  try {
    throwIfAborted(signal);
    const [{ nodes }, document, layout] = await Promise.all([
      sendCdpCommand<{ readonly nodes: readonly AxNode[] }>(
        runtime,
        "Accessibility.getFullAXTree",
        {},
        signal,
      ),
      sendCdpCommand<{ readonly root: DomNode }>(
        runtime,
        "DOM.getDocument",
        { depth: -1, pierce: true },
        signal,
      ),
      sendCdpCommand<{
        readonly cssLayoutViewport?: {
          readonly clientWidth?: number;
          readonly clientHeight?: number;
        };
      }>(runtime, "Page.getLayoutMetrics", {}, signal),
    ]);
    const closed = closedShadowBackendIds(document.root);
    const viewport = {
      width: layout.cssLayoutViewport?.clientWidth ?? 0,
      height: layout.cssLayoutViewport?.clientHeight ?? 0,
    };
    const positions = new Map<number, { x: number; y: number } | null>();
    if (closed.size > 0) {
      const targets = nodes
        .filter((node) => controlNeedsPosition(node, closed))
        .slice(0, MAX_POSITIONED_CONTROLS);
      for (const node of targets) {
        positions.set(
          node.backendDOMNodeId!,
          await viewportCenter(runtime, node.backendDOMNodeId!, viewport, signal),
        );
      }
    }
    const rendered = renderPageOutline(nodes, { maxBytes, closed, positions });
    return {
      url: clipBytes(runtime.webContents.getURL(), MAX_URL_BYTES),
      title: clipBytes(runtime.webContents.getTitle(), MAX_TITLE_BYTES),
      ...rendered,
    };
  } catch {
    throwIfAborted(signal);
    return undefined;
  }
}
