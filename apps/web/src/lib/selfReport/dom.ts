// FILE: dom.ts
// Purpose: Shared DOM helpers for Moss's self-report tools: what counts as visible, a short
//          selector that finds an element again, a plain rectangle, and what an agent may never
//          read (data-agent-hidden areas, data-agent-secret values, form field values).
// Layer: Web dev/test tooling (self-report)

export interface SelfReportRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export function toRect(rect: DOMRectReadOnly): SelfReportRect {
  const round = (value: number) => Math.round(value * 10) / 10;
  return {
    x: round(rect.left),
    y: round(rect.top),
    width: round(rect.width),
    height: round(rect.height),
  };
}

/** Areas an agent never sees, as in UI SDK's agent bridge. */
export const AGENT_HIDDEN_SELECTOR = "[data-agent-hidden]";
/** Areas whose text an agent sees as "[redacted]". */
export const AGENT_SECRET_SELECTOR = "[data-agent-secret]";

export function isAgentHidden(element: Element): boolean {
  return element.closest(AGENT_HIDDEN_SELECTOR) !== null;
}

/** Rendered, with a size, not hidden by visibility, display or opacity (on it or an ancestor). */
export function isVisible(element: Element): boolean {
  const rect = element.getBoundingClientRect();
  if (rect.width <= 0 || rect.height <= 0) return false;
  if (typeof element.checkVisibility === "function") {
    return element.checkVisibility({ opacityProperty: true, visibilityProperty: true });
  }
  const style = getComputedStyle(element);
  return style.visibility !== "hidden" && style.display !== "none" && style.opacity !== "0";
}

const INTERACTIVE_SELECTOR = [
  "button",
  "a[href]",
  "input:not([type='hidden'])",
  "select",
  "textarea",
  "summary",
  "[role='button']",
  "[role='link']",
  "[role='menuitem']",
  "[role='menuitemcheckbox']",
  "[role='menuitemradio']",
  "[role='option']",
  "[role='tab']",
  "[role='checkbox']",
  "[role='radio']",
  "[role='switch']",
  "[role='slider']",
  "[role='combobox']",
  "[contenteditable='true']",
].join(",");

export function isInteractive(element: Element): boolean {
  return element.matches(INTERACTIVE_SELECTOR);
}

export function interactiveElements(root: ParentNode): Element[] {
  return [...root.querySelectorAll(INTERACTIVE_SELECTOR)];
}

/** The element's accessible name as far as the page says it, bounded. */
export function accessibleName(element: Element): string | undefined {
  const label =
    element.getAttribute("aria-label") ??
    labelledByText(element) ??
    (element instanceof HTMLInputElement || element instanceof HTMLTextAreaElement
      ? (element.labels?.[0]?.textContent ?? element.placeholder)
      : null) ??
    element.getAttribute("title") ??
    (element.closest(AGENT_SECRET_SELECTOR) ? null : element.textContent);
  const text = label?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 80) : undefined;
}

function labelledByText(element: Element): string | null {
  const ids = element.getAttribute("aria-labelledby");
  if (!ids) return null;
  const text = ids
    .split(/\s+/)
    .map((id) => element.ownerDocument.getElementById(id)?.textContent ?? "")
    .join(" ")
    .trim();
  return text || null;
}

const STABLE_ATTRIBUTES = [
  "data-testid",
  "data-slot",
  "data-mossbot-onboarding",
  "aria-label",
  "name",
  "role",
];

function cssEscape(value: string): string {
  return typeof CSS !== "undefined" && typeof CSS.escape === "function"
    ? CSS.escape(value)
    : value.replace(/["\\]/g, "\\$&");
}

function unique(selector: string, element: Element): boolean {
  try {
    const matches = element.ownerDocument.querySelectorAll(selector);
    return matches.length === 1 && matches[0] === element;
  } catch {
    return false;
  }
}

/** One step of a selector: an id, a stable attribute, or the tag with its position. */
function step(element: Element): string {
  if (element.id && !/^\d/.test(element.id) && !element.id.includes(":")) {
    return `#${cssEscape(element.id)}`;
  }
  const tag = element.tagName.toLowerCase();
  for (const attribute of STABLE_ATTRIBUTES) {
    const value = element.getAttribute(attribute);
    if (value !== null && value.length <= 60) {
      return `${tag}[${attribute}="${value.replace(/["\\]/g, "\\$&")}"]`;
    }
  }
  const parent = element.parentElement;
  if (!parent) return tag;
  const sameTag = [...parent.children].filter((child) => child.tagName === element.tagName);
  return sameTag.length === 1 ? tag : `${tag}:nth-of-type(${sameTag.indexOf(element) + 1})`;
}

/** A selector that finds this element again (unique on the page), as short as it can be. */
export function selectorFor(element: Element): string {
  let selector = step(element);
  if (unique(selector, element)) return selector;
  let current = element.parentElement;
  let depth = 0;
  while (current && current !== element.ownerDocument.documentElement && depth < 12) {
    selector = `${step(current)} > ${selector}`;
    if (unique(selector, element)) return selector;
    current = current.parentElement;
    depth += 1;
  }
  return selector;
}

export function intersection(a: DOMRectReadOnly, b: DOMRectReadOnly): DOMRect | null {
  const left = Math.max(a.left, b.left);
  const top = Math.max(a.top, b.top);
  const right = Math.min(a.right, b.right);
  const bottom = Math.min(a.bottom, b.bottom);
  return right > left && bottom > top ? new DOMRect(left, top, right - left, bottom - top) : null;
}
