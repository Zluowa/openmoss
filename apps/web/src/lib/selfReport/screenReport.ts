// FILE: screenReport.ts
// Purpose: `screen_report`: what the Moss window shows now, as data: route, size, theme, the
//          dialogs and menus open, what has focus, and the visible text in reading order. Only
//          what is on screen in this window; a field's value, a password, a data-agent-secret
//          value and anything inside data-agent-hidden are never read.
// Layer: Web dev/test tooling (self-report)

import {
  AGENT_SECRET_SELECTOR,
  accessibleName,
  isAgentHidden,
  isVisible,
  selectorFor,
  toRect,
  type SelfReportRect,
} from "./dom";

export interface ScreenReportInput {
  /** Visible text kept, at most (4000 by default, 20000 at most). */
  readonly maxChars?: number;
}

export interface ScreenReport {
  readonly route: string;
  readonly window: {
    readonly width: number;
    readonly height: number;
    readonly dpr: number;
  };
  readonly theme: { readonly mode: "light" | "dark"; readonly colorScheme: string };
  readonly open: Array<{
    readonly kind: string;
    readonly title?: string;
    readonly selector: string;
    readonly rect: SelfReportRect;
  }>;
  readonly focused: {
    readonly selector: string;
    readonly role: string;
    readonly name?: string;
  } | null;
  readonly text: string;
  readonly textTruncated: boolean;
}

const OPEN_LAYER_SELECTOR = [
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']",
  "[popover]:popover-open",
].join(",");
const SKIPPED_TEXT_PARENTS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "TITLE"]);
/** Pieces whose tops are this close sit on one line. */
const LINE_TOLERANCE_PX = 6;

const IMPLICIT_ROLES: Record<string, string> = {
  BUTTON: "button",
  A: "link",
  TEXTAREA: "textbox",
  SELECT: "combobox",
  SUMMARY: "button",
};

function roleOf(element: Element): string {
  const explicit = element.getAttribute("role");
  if (explicit) return explicit;
  if (element instanceof HTMLInputElement) {
    return ["checkbox", "radio", "range"].includes(element.type)
      ? element.type === "range"
        ? "slider"
        : element.type
      : "textbox";
  }
  if (element instanceof HTMLElement && element.isContentEditable) return "textbox";
  return IMPLICIT_ROLES[element.tagName] ?? element.tagName.toLowerCase();
}

function layerTitle(element: Element): string | undefined {
  const named = element.getAttribute("aria-label")?.trim();
  if (named) return named;
  const labelledBy = element.getAttribute("aria-labelledby");
  if (labelledBy) {
    const text = labelledBy
      .split(/\s+/)
      .map((id) => document.getElementById(id)?.textContent ?? "")
      .join(" ")
      .replace(/\s+/g, " ")
      .trim();
    if (text) return text.slice(0, 120);
  }
  const heading = element.querySelector("h1,h2,h3,h4,h5,h6,[role='heading']");
  const text = heading?.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 120) : undefined;
}

interface Piece {
  readonly x: number;
  readonly y: number;
  readonly text: string;
}

function inView(rect: DOMRectReadOnly): boolean {
  return (
    rect.width > 0 &&
    rect.height > 0 &&
    rect.right > 0 &&
    rect.bottom > 0 &&
    rect.left < window.innerWidth &&
    rect.top < window.innerHeight
  );
}

function visibleTextPieces(): Piece[] {
  const pieces: Piece[] = [];
  const secrets = new Set<Element>();
  const range = document.createRange();
  const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent?.replace(/\s+/g, " ").trim();
    const parent = node.parentElement;
    if (!text || !parent || SKIPPED_TEXT_PARENTS.has(parent.tagName)) continue;
    if (isAgentHidden(parent) || parent.closest("[aria-hidden='true']")) continue;
    if (!isVisible(parent)) continue;
    range.selectNodeContents(node);
    const rect = [...range.getClientRects()].find(inView);
    if (!rect) continue;
    const secret = parent.closest(AGENT_SECRET_SELECTOR);
    if (secret) {
      if (!secrets.has(secret)) {
        secrets.add(secret);
        pieces.push({ x: rect.left, y: rect.top, text: "[redacted]" });
      }
      continue;
    }
    pieces.push({ x: rect.left, y: rect.top, text });
  }
  // Fields show what a person typed: name the field, never its value.
  for (const field of document.querySelectorAll(
    "input:not([type='hidden']):not([type='checkbox']):not([type='radio']), textarea, select, [contenteditable='true']",
  )) {
    if (isAgentHidden(field) || !isVisible(field)) continue;
    const rect = field.getBoundingClientRect();
    if (!inView(rect)) continue;
    pieces.push({
      x: rect.left,
      y: rect.top,
      text: `[field: ${accessibleName(field) ?? roleOf(field)}]`,
    });
  }
  return pieces;
}

/** Top to bottom, then left to right within a line. */
function readingOrder(pieces: Piece[]): string[] {
  const sorted = pieces.toSorted((a, b) => a.y - b.y || a.x - b.x);
  const lines: Piece[][] = [];
  for (const piece of sorted) {
    const line = lines.at(-1);
    if (line && Math.abs(piece.y - line[0]!.y) <= LINE_TOLERANCE_PX) line.push(piece);
    else lines.push([piece]);
  }
  return lines.map((line) =>
    line
      .toSorted((a, b) => a.x - b.x)
      .map((piece) => piece.text)
      .join(" "),
  );
}

export function screenReport(input: ScreenReportInput = {}): ScreenReport {
  const maxChars = Math.max(1, Math.min(20_000, input.maxChars ?? 4000));
  const root = document.documentElement;

  const open = [...document.querySelectorAll(OPEN_LAYER_SELECTOR)]
    .filter((element) => !isAgentHidden(element) && isVisible(element))
    .map((element) => {
      const title = layerTitle(element);
      return {
        kind: element.getAttribute("role") ?? "popover",
        ...(title ? { title } : {}),
        selector: selectorFor(element),
        rect: toRect(element.getBoundingClientRect()),
      };
    });

  const active = document.activeElement;
  const focused =
    active && active !== document.body && active !== root && !isAgentHidden(active)
      ? (() => {
          const name = accessibleName(active);
          return { selector: selectorFor(active), role: roleOf(active), ...(name ? { name } : {}) };
        })()
      : null;

  const fullText = readingOrder(visibleTextPieces()).join("\n");
  const textTruncated = fullText.length > maxChars;

  return {
    route: `${location.pathname}${location.search}${location.hash}`,
    window: {
      width: window.innerWidth,
      height: window.innerHeight,
      dpr: window.devicePixelRatio,
    },
    theme: {
      mode: root.classList.contains("dark") ? "dark" : "light",
      colorScheme: getComputedStyle(root).colorScheme,
    },
    open,
    focused,
    text: textTruncated ? fullText.slice(0, maxChars) : fullText,
    textTruncated,
  };
}
