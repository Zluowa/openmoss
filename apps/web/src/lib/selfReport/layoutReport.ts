// FILE: layoutReport.ts
// Purpose: `layout_report`: what is wrong with the current layout as a person would see it,
//          from the real boxes Chromium laid out. Each finding names the element (a selector
//          that finds it again, its rectangle) and what it breaks (its container, the window,
//          or the desktop window's own buttons, which are not in the DOM).
// Layer: Web dev/test tooling (self-report)

import {
  CHAT_SURFACE_HEADER_HEIGHT_PX,
  MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
} from "@moss/shared/desktopChrome";

import {
  accessibleName,
  interactiveElements,
  intersection,
  isAgentHidden,
  isVisible,
  selectorFor,
  toRect,
  type SelfReportRect,
} from "./dom";

export type LayoutFindingKind =
  | "overflow"
  | "clipped"
  | "truncated-text"
  | "popup-outside-window"
  | "overlapping-controls"
  | "under-window-controls";

export interface LayoutFinding {
  readonly kind: LayoutFindingKind;
  readonly selector: string;
  readonly name?: string;
  readonly rect: SelfReportRect;
  /** What it breaks: a container's selector, the window, or the window's own controls. */
  readonly against: { readonly selector: string; readonly rect: SelfReportRect };
}

/** Which window controls the desktop window draws over the page (not in the DOM). */
export type WindowControlsMode = "auto" | "windows" | "mac" | "none";

export interface LayoutReportInput {
  /** Only findings for elements inside this element. The whole page when left out. */
  readonly root?: string;
  readonly max?: number;
  readonly windowControls?: WindowControlsMode;
}

export interface LayoutReport {
  readonly window: { readonly width: number; readonly height: number };
  readonly windowControls: SelfReportRect | null;
  readonly findings: LayoutFinding[];
  /** Findings left out past `max`. */
  readonly more: number;
  readonly error?: string;
}

/**
 * The minimize/maximize/close cluster Windows and Linux draw at the window's top right: as
 * wide as the gutter every top bar keeps for it (`DESKTOP_TOP_BAR_WINDOW_CONTROLS_GUTTER_CLASS`,
 * 138px) and as tall as the top bar.
 */
const WINDOWS_CAPTION_WIDTH_PX = 138;
/** Elements looked at, at most: a long transcript stops here. */
const MAX_ELEMENTS = 6000;
/** Interactive controls compared pairwise, at most. */
const MAX_CONTROLS = 400;
/** Less than this is rounding, not a defect. */
const SLACK_PX = 1.5;
/** A child spilling out of an unclipped box by less than this is a halo or a hit area. */
const SPILL_PX = 4;
/** Boxes this thin are visually hidden (screen-reader text) or hairlines. */
const HIDDEN_PX = 2;
/** Where Moss draws the window's own buttons in the page (Windows and Linux). */
export const DESKTOP_WINDOW_CONTROLS_SELECTOR = "[data-desktop-window-controls]";

const POPUP_SELECTOR = [
  "[role='dialog']",
  "[role='alertdialog']",
  "[role='menu']",
  "[role='listbox']",
  "[role='tooltip']",
  "[popover]:popover-open",
].join(",");

const SKIPPED_TAGS = new Set(["SCRIPT", "STYLE", "TEMPLATE", "NOSCRIPT", "BR", "WBR"]);

function isMac(): boolean {
  return /Mac/i.test(navigator.platform || navigator.userAgent);
}

export function resolveWindowControlsRect(mode: WindowControlsMode): SelfReportRect | null {
  if (mode === "none") return null;
  // Moss draws them itself: measure the real band, wherever and however wide it is.
  const drawn = document.querySelector(DESKTOP_WINDOW_CONTROLS_SELECTOR);
  if (drawn && mode !== "mac" && isVisible(drawn)) return toRect(drawn.getBoundingClientRect());
  const resolved =
    mode === "auto"
      ? typeof window !== "undefined" && "desktopBridge" in window && window.desktopBridge
        ? isMac()
          ? "mac"
          : "windows"
        : "none"
      : mode;
  if (resolved === "windows") {
    return {
      x: window.innerWidth - WINDOWS_CAPTION_WIDTH_PX,
      y: 0,
      width: WINDOWS_CAPTION_WIDTH_PX,
      height: CHAT_SURFACE_HEADER_HEIGHT_PX,
    };
  }
  if (resolved === "mac") {
    return {
      x: 0,
      y: 0,
      width: MAC_DESKTOP_TOP_BAR_TRAFFIC_LIGHT_GUTTER_CSS_PX,
      height: CHAT_SURFACE_HEADER_HEIGHT_PX,
    };
  }
  return null;
}

const clips = (value: string) => value === "hidden" || value === "clip";
const scrolls = (value: string) => value === "auto" || value === "scroll";

function isFormField(element: Element): boolean {
  return (
    element instanceof HTMLInputElement ||
    element instanceof HTMLTextAreaElement ||
    element instanceof HTMLSelectElement ||
    (element instanceof HTMLElement && element.isContentEditable)
  );
}

function hasOwnText(element: Element): boolean {
  for (const node of element.childNodes) {
    if (node.nodeType === Node.TEXT_NODE && node.textContent?.trim()) return true;
  }
  return false;
}

/** Outside `box` on some side by more than rounding, yet still overlapping it. */
function partlyOutside(rect: DOMRectReadOnly, box: DOMRectReadOnly): boolean {
  const outside =
    rect.left < box.left - SLACK_PX ||
    rect.top < box.top - SLACK_PX ||
    rect.right > box.right + SLACK_PX ||
    rect.bottom > box.bottom + SLACK_PX;
  return outside && intersection(rect, box) !== null;
}

/** The box a clipping container shows its content in (inside its borders). */
function paddingBox(element: Element): DOMRect {
  const rect = element.getBoundingClientRect();
  return new DOMRect(
    rect.left + element.clientLeft,
    rect.top + element.clientTop,
    element.clientWidth,
    element.clientHeight,
  );
}

type ClipOwner = { kind: "container"; element: Element } | { kind: "scroll" } | { kind: "none" };

/** The nearest ancestor that clips `element`, or that scrolls it (then nothing is wrong). */
function clipOwner(element: Element, style: CSSStyleDeclaration): ClipOwner {
  if (style.position === "fixed") return { kind: "none" };
  let current = element.parentElement;
  while (current && current !== document.documentElement) {
    const currentStyle = getComputedStyle(current);
    if (scrolls(currentStyle.overflowX) || scrolls(currentStyle.overflowY)) {
      return { kind: "scroll" };
    }
    if (clips(currentStyle.overflowX) || clips(currentStyle.overflowY)) {
      return { kind: "container", element: current };
    }
    // A fixed box escapes the clipping of everything above it.
    if (currentStyle.position === "fixed") return { kind: "none" };
    current = current.parentElement;
  }
  return { kind: "none" };
}

/** Sample points well inside the box; a control a person can reach answers at one of them. */
function isHitTestable(element: Element, rect: DOMRectReadOnly): boolean {
  const view = intersection(rect, new DOMRect(0, 0, window.innerWidth, window.innerHeight));
  if (!view) return false;
  const inset = Math.min(3, view.width / 4, view.height / 4);
  const points: Array<[number, number]> = [
    [view.left + view.width / 2, view.top + view.height / 2],
    [view.left + inset, view.top + inset],
    [view.right - inset, view.top + inset],
    [view.left + inset, view.bottom - inset],
    [view.right - inset, view.bottom - inset],
  ];
  return points.some(([x, y]) => {
    // The window's own buttons drawn over a control do not make it unreachable by design: that
    // is the defect `under-window-controls` reports. Look through them.
    const hit = document
      .elementsFromPoint(x, y)
      .find((candidate) => candidate.closest(DESKTOP_WINDOW_CONTROLS_SELECTOR) === null);
    return hit !== undefined && (hit === element || element.contains(hit));
  });
}

function textName(element: Element): string | undefined {
  if (element.closest("[data-agent-secret]")) return undefined;
  const text = element.textContent?.replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : undefined;
}

export function layoutReport(input: LayoutReportInput = {}): LayoutReport {
  const viewport = new DOMRect(0, 0, window.innerWidth, window.innerHeight);
  const windowRect = toRect(viewport);
  const windowControls = resolveWindowControlsRect(input.windowControls ?? "auto");
  const root = input.root ? document.querySelector(input.root) : document.body;
  if (!root) {
    return {
      window: { width: windowRect.width, height: windowRect.height },
      windowControls,
      findings: [],
      more: 0,
      error: `No element matches ${input.root}.`,
    };
  }
  const max = Math.max(1, Math.min(500, input.max ?? 100));
  const findings: LayoutFinding[] = [];
  const add = (
    kind: LayoutFindingKind,
    element: Element,
    against: LayoutFinding["against"],
    name?: string,
  ) => {
    findings.push({
      kind,
      selector: selectorFor(element),
      ...(name ? { name } : {}),
      rect: toRect(element.getBoundingClientRect()),
      against,
    });
  };
  const windowAgainst = { selector: "window", rect: windowRect };

  const elements = [root, ...root.querySelectorAll("*")].slice(0, MAX_ELEMENTS);
  const reportedClips = new Set<Element>();
  const reportedPopups = new Set<Element>();
  const insideReported = (element: Element, set: Set<Element>) => {
    for (let current = element.parentElement; current; current = current.parentElement) {
      if (set.has(current)) return true;
    }
    return false;
  };

  for (const element of elements) {
    if (SKIPPED_TAGS.has(element.tagName)) continue;
    // Inside an svg only the svg itself counts.
    if (element instanceof SVGElement && !(element instanceof SVGSVGElement)) continue;
    if (isAgentHidden(element) || !isVisible(element)) continue;
    const rect = element.getBoundingClientRect();
    if (rect.width <= HIDDEN_PX || rect.height <= HIDDEN_PX) continue;
    const style = getComputedStyle(element);
    if (style.display === "contents" || style.display === "inline") {
      // Inline pieces belong to their text's box; the text rule covers them.
      continue;
    }

    if (element.matches(POPUP_SELECTOR)) {
      if (partlyOutside(rect, viewport)) {
        add("popup-outside-window", element, windowAgainst, accessibleName(element));
        reportedPopups.add(element);
      }
      continue;
    }

    if (hasOwnText(element) && !isFormField(element)) {
      const cutAcross =
        clips(style.overflowX) &&
        element.scrollWidth > element.clientWidth + 1 &&
        style.textOverflow !== "ellipsis";
      const lineClamp = style.getPropertyValue("-webkit-line-clamp");
      const cutDown =
        clips(style.overflowY) &&
        element.scrollHeight > element.clientHeight + 1 &&
        (lineClamp === "" || lineClamp === "none");
      if (cutAcross || cutDown) {
        const box = paddingBox(element);
        add(
          "truncated-text",
          element,
          {
            selector: selectorFor(element),
            rect: toRect(new DOMRect(box.left, box.top, element.scrollWidth, element.scrollHeight)),
          },
          textName(element),
        );
      }
    }

    if (
      rect.width > 1 &&
      rect.height > 1 &&
      !insideReported(element, reportedClips) &&
      !insideReported(element, reportedPopups)
    ) {
      const owner = clipOwner(element, style);
      if (owner.kind === "container") {
        const ownerStyle = getComputedStyle(owner.element);
        const box = paddingBox(owner.element);
        const across =
          clips(ownerStyle.overflowX) &&
          (rect.left < box.left - SLACK_PX || rect.right > box.right + SLACK_PX);
        const down =
          clips(ownerStyle.overflowY) &&
          (rect.top < box.top - SLACK_PX || rect.bottom > box.bottom + SLACK_PX);
        if (
          (across || down) &&
          intersection(rect, box) !== null &&
          ownerStyle.textOverflow !== "ellipsis"
        ) {
          add(
            "clipped",
            element,
            { selector: selectorFor(owner.element), rect: toRect(box) },
            textName(element),
          );
          reportedClips.add(element);
        }
      } else if (owner.kind === "none" && partlyOutside(rect, viewport)) {
        add("clipped", element, windowAgainst, textName(element));
        reportedClips.add(element);
      }
    }

    if (
      clips(style.overflowX) === false &&
      clips(style.overflowY) === false &&
      !scrolls(style.overflowX) &&
      !scrolls(style.overflowY) &&
      element.children.length > 0 &&
      element !== document.body &&
      (element.scrollWidth > element.clientWidth + 2 ||
        element.scrollHeight > element.clientHeight + 2)
    ) {
      // Name the child that spills out, not the box: that is what a person sees on top of the
      // next thing. Positioned children are decorations placed on purpose.
      for (const child of element.children) {
        const childStyle = getComputedStyle(child);
        if (childStyle.position === "absolute" || childStyle.position === "fixed") continue;
        if (!isVisible(child)) continue;
        const childBox = child.getBoundingClientRect();
        const box = element.getBoundingClientRect();
        const spill = Math.max(
          box.left - childBox.left,
          box.top - childBox.top,
          childBox.right - box.right,
          childBox.bottom - box.bottom,
        );
        if (spill > SPILL_PX && intersection(childBox, box) !== null) {
          add(
            "overflow",
            child,
            { selector: selectorFor(element), rect: toRect(element.getBoundingClientRect()) },
            textName(child),
          );
          break;
        }
      }
    }
  }

  const controls = interactiveElements(root)
    .filter(
      (element) =>
        !isAgentHidden(element) &&
        // The window's own buttons are what the other controls must keep clear of.
        element.closest(DESKTOP_WINDOW_CONTROLS_SELECTOR) === null &&
        isVisible(element),
    )
    .map((element) => ({ element, rect: element.getBoundingClientRect() }))
    .filter(({ element, rect }) => isHitTestable(element, rect))
    .slice(0, MAX_CONTROLS);
  for (let i = 0; i < controls.length; i += 1) {
    const a = controls[i]!;
    for (let j = i + 1; j < controls.length; j += 1) {
      const b = controls[j]!;
      if (a.element.contains(b.element) || b.element.contains(a.element)) continue;
      const overlap = intersection(a.rect, b.rect);
      if (overlap && overlap.width > 2 && overlap.height > 2) {
        add(
          "overlapping-controls",
          a.element,
          { selector: selectorFor(b.element), rect: toRect(b.rect) },
          accessibleName(a.element),
        );
      }
    }
  }
  if (windowControls) {
    const caption = new DOMRect(
      windowControls.x,
      windowControls.y,
      windowControls.width,
      windowControls.height,
    );
    for (const { element, rect } of controls) {
      const overlap = intersection(rect, caption);
      if (overlap && overlap.width > 2 && overlap.height > 2) {
        add(
          "under-window-controls",
          element,
          { selector: "window-controls", rect: windowControls },
          accessibleName(element),
        );
      }
    }
  }

  return {
    window: { width: windowRect.width, height: windowRect.height },
    windowControls,
    findings: findings.slice(0, max),
    more: Math.max(0, findings.length - max),
  };
}
