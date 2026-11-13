// FILE: designEdits.ts
// Purpose: The edits a person makes to the elements of a 设计 artboard, done on the frame's
//          DOM: inline styles, text, insert, duplicate, delete, wrap in a group / flex / grid,
//          ungroup, reorder, flip, nudge and copy/paste of elements and properties.
// Layer: 资料空间 设计 (web)
// Why: Each function changes the DOM only; the editor serializes the body afterwards, so one
//      serializer decides the stored source for every kind of edit.

import {
  elementAt,
  elementPath,
  isSelectable,
  parentPath,
  type DesignElementPath,
} from "./designDocument";

export type DesignWrapKind = "group" | "flex-row" | "flex-column" | "grid";

/** The artboard's root: its first visible element (the one sized to the frame). */
export function boardRoot(body: HTMLElement): HTMLElement | null {
  for (const child of body.children) if (isSelectable(child)) return child as HTMLElement;
  return null;
}

export function computed(element: Element): CSSStyleDeclaration | null {
  return element.ownerDocument.defaultView?.getComputedStyle(element) ?? null;
}

export function isPositioned(element: HTMLElement): boolean {
  const position = computed(element)?.position ?? element.style.position;
  return position === "absolute" || position === "fixed";
}

/** Sets (or clears, for "") one inline style property. */
export function setStyle(element: HTMLElement, property: string, value: string) {
  if (value.trim() === "") element.style.removeProperty(property);
  else element.style.setProperty(property, value.trim());
  if (element.getAttribute("style") === "") element.removeAttribute("style");
}

export function setStyles(element: HTMLElement, values: Readonly<Record<string, string>>) {
  for (const [property, value] of Object.entries(values)) setStyle(element, property, value);
}

/** The inline style as editable lines, one `name: value` per line. */
export function styleLines(element: HTMLElement): string {
  const lines: string[] = [];
  for (let index = 0; index < element.style.length; index += 1) {
    const name = element.style.item(index);
    const priority = element.style.getPropertyPriority(name);
    lines.push(`${name}: ${element.style.getPropertyValue(name)}${priority ? " !important" : ""};`);
  }
  return lines.join("\n");
}

export interface StyleLineError {
  readonly line: number;
  readonly message: string;
}

/** Parses `name: value;` lines; refuses anything that is not one declaration per line. */
export function parseStyleLines(text: string): {
  values: Record<string, string>;
  errors: StyleLineError[];
} {
  const values: Record<string, string> = {};
  const errors: StyleLineError[] = [];
  text.split("\n").forEach((raw, index) => {
    const line = raw.trim().replace(/;$/u, "").trim();
    if (!line || line.startsWith("/*")) return;
    const colon = line.indexOf(":");
    if (colon <= 0) return void errors.push({ line: index + 1, message: "应写成“属性: 值”" });
    const name = line.slice(0, colon).trim().toLowerCase();
    const value = line.slice(colon + 1).trim();
    if (!/^(--[a-z0-9-]+|-?[a-z][a-z-]*)$/u.test(name))
      return void errors.push({ line: index + 1, message: `属性名“${name}”不对` });
    if (!value) return void errors.push({ line: index + 1, message: "缺少值" });
    if (/[<>{}]/u.test(value) || value.includes(";"))
      return void errors.push({ line: index + 1, message: "值里不能有 < > { } ;" });
    if (values[name] !== undefined)
      return void errors.push({ line: index + 1, message: `“${name}”写了两次` });
    values[name] = value;
  });
  return { values, errors };
}

/** Replaces the whole inline style with the given declarations. */
export function replaceStyle(element: HTMLElement, values: Readonly<Record<string, string>>) {
  element.removeAttribute("style");
  for (const [name, value] of Object.entries(values)) {
    const important = /\s*!important$/u.test(value);
    element.style.setProperty(
      name,
      value.replace(/\s*!important$/u, ""),
      important ? "important" : "",
    );
  }
}

function sameParent(elements: readonly HTMLElement[]): HTMLElement | null {
  const parent = elements[0]?.parentElement ?? null;
  return parent && elements.every((element) => element.parentElement === parent)
    ? (parent as HTMLElement)
    : null;
}

/** Elements of the selection in document order (paths resolved; missing ones dropped). */
export function resolve(body: HTMLElement, paths: readonly DesignElementPath[]): HTMLElement[] {
  const elements = paths.flatMap((path) => {
    const element = elementAt(body, path);
    return element ? [element] : [];
  });
  return elements.sort((a, b) =>
    a.compareDocumentPosition(b) & Node.DOCUMENT_POSITION_FOLLOWING ? -1 : 1,
  );
}

export function pathsOf(body: HTMLElement, elements: readonly Element[]): DesignElementPath[] {
  return elements.flatMap((element) => {
    const path = elementPath(element, body);
    return path ? [path] : [];
  });
}

/** Wraps sibling elements in a new container; returns it, or null when they are not siblings. */
export function wrap(elements: readonly HTMLElement[], kind: DesignWrapKind): HTMLElement | null {
  const parent = sameParent(elements);
  if (!parent || elements.length === 0) return null;
  const doc = parent.ownerDocument;
  const box = doc.createElement("div");
  const style =
    kind === "flex-row"
      ? "display: flex; flex-direction: row; align-items: center; gap: 12px"
      : kind === "flex-column"
        ? "display: flex; flex-direction: column; gap: 12px"
        : kind === "grid"
          ? "display: grid; grid-template-columns: repeat(2, minmax(0, 1fr)); gap: 12px"
          : "";
  // A group of freely placed pieces keeps their places: the group takes the first one's spot.
  const placed = elements.every(isPositioned);
  if (placed) {
    const left = Math.min(...elements.map((element) => element.offsetLeft));
    const top = Math.min(...elements.map((element) => element.offsetTop));
    const right = Math.max(...elements.map((element) => element.offsetLeft + element.offsetWidth));
    const bottom = Math.max(...elements.map((element) => element.offsetTop + element.offsetHeight));
    box.setAttribute(
      "style",
      `position: absolute; left: ${left}px; top: ${top}px; width: ${right - left}px; height: ${bottom - top}px${style ? `; ${style}` : ""}`,
    );
    for (const element of elements) {
      if (kind === "group") {
        setStyle(element, "left", `${element.offsetLeft - left}px`);
        setStyle(element, "top", `${element.offsetTop - top}px`);
      } else {
        for (const property of ["position", "left", "top", "right", "bottom"])
          setStyle(element, property, "");
      }
    }
  } else if (style) box.setAttribute("style", style);
  parent.insertBefore(box, elements[0]!);
  for (const element of elements) box.appendChild(element);
  return box;
}

/** Replaces a plain container with its children. Returns them, or null when it can't. */
export function ungroup(element: HTMLElement): HTMLElement[] | null {
  const parent = element.parentElement;
  if (!parent || element.tagName !== "DIV") return null;
  const children = [...element.children].filter(isSelectable) as HTMLElement[];
  if (children.length === 0) return null;
  const placed = isPositioned(element);
  for (const child of children) {
    if (placed && isPositioned(child)) {
      setStyle(child, "left", `${element.offsetLeft + child.offsetLeft}px`);
      setStyle(child, "top", `${element.offsetTop + child.offsetTop}px`);
    }
    parent.insertBefore(child, element);
  }
  element.remove();
  return children;
}

export function duplicate(elements: readonly HTMLElement[]): HTMLElement[] {
  const copies: HTMLElement[] = [];
  for (const element of [...elements].reverse()) {
    const copy = element.cloneNode(true) as HTMLElement;
    if (isPositioned(element)) {
      setStyle(copy, "left", `${element.offsetLeft + 16}px`);
      setStyle(copy, "top", `${element.offsetTop + 16}px`);
    }
    element.after(copy);
    copies.unshift(copy);
  }
  return copies;
}

export function remove(elements: readonly HTMLElement[]) {
  for (const element of elements) element.remove();
}

/** `front`: last among its siblings (drawn on top); `back`: first. */
export function reorder(
  elements: readonly HTMLElement[],
  to: "front" | "back" | "forward" | "backward",
) {
  const list = to === "front" || to === "backward" ? elements : [...elements].reverse();
  for (const element of list) {
    const parent = element.parentElement;
    if (!parent) continue;
    if (to === "front") parent.appendChild(element);
    else if (to === "back") parent.insertBefore(element, parent.firstElementChild);
    else if (to === "forward") element.nextElementSibling?.after(element);
    else element.previousElementSibling?.before(element);
  }
}

/** Moves an element to `index` among its parent's element children. */
export function moveToIndex(element: HTMLElement, index: number) {
  const parent = element.parentElement;
  if (!parent) return;
  const siblings = [...parent.children].filter((child) => child !== element);
  const anchor = siblings[index] ?? null;
  parent.insertBefore(element, anchor);
}

const FLIP = /\bscale([XY])\(-1\)\s*/gu;
export function flip(element: HTMLElement, axis: "x" | "y") {
  const transform = element.style.transform;
  const token = axis === "x" ? "scaleX(-1)" : "scaleY(-1)";
  const has = transform.includes(token);
  const rest = transform
    .replace(FLIP, (match, which: string) => (which.toLowerCase() === axis ? "" : match))
    .trim();
  setStyle(element, "transform", has ? rest : `${rest} ${token}`.trim());
}

export function nudge(element: HTMLElement, dx: number, dy: number) {
  setStyle(element, "left", `${element.offsetLeft + dx}px`);
  setStyle(element, "top", `${element.offsetTop + dy}px`);
}

/** Makes the root a positioning context, then inserts markup into it. Returns the new element. */
export function insertInto(root: HTMLElement, markup: string): HTMLElement | null {
  const position = computed(root)?.position ?? "static";
  if (position === "static") setStyle(root, "position", "relative");
  const template = root.ownerDocument.createElement("template");
  template.innerHTML = markup.trim();
  const element = template.content.firstElementChild as HTMLElement | null;
  if (!element) return null;
  root.appendChild(element);
  return element;
}

/** Pastes copied element markup after `after` (or into the root), offsetting placed pieces. */
export function pasteAfter(
  body: HTMLElement,
  after: HTMLElement | null,
  markup: string,
): HTMLElement[] {
  const template = body.ownerDocument.createElement("template");
  template.innerHTML = markup;
  const pieces = [...template.content.children] as HTMLElement[];
  const target = after ?? boardRoot(body);
  if (!target || pieces.length === 0) return [];
  const pasted: HTMLElement[] = [];
  let anchor: Element = target;
  for (const piece of pieces) {
    if (after) {
      anchor.after(piece);
      anchor = piece;
    } else {
      target.appendChild(piece);
    }
    pasted.push(piece);
  }
  return pasted;
}

export function parentOf(body: HTMLElement, path: DesignElementPath): DesignElementPath | null {
  const parent = parentPath(path);
  return parent && elementAt(body, parent) ? parent : null;
}

/** First selectable child path of `path`, for Enter. */
export function firstChild(body: HTMLElement, path: DesignElementPath): DesignElementPath | null {
  const element = elementAt(body, path);
  if (!element) return null;
  const index = [...element.children].findIndex(isSelectable);
  return index < 0 ? null : `${path}.${index}`;
}

/** Next selectable sibling (wrapping), for Tab / Shift+Tab. */
export function siblingOf(
  body: HTMLElement,
  path: DesignElementPath,
  step: 1 | -1,
): DesignElementPath | null {
  const element = elementAt(body, path);
  const parent = element?.parentElement;
  if (!element || !parent) return null;
  const siblings = [...parent.children];
  const start = siblings.indexOf(element);
  for (let offset = 1; offset <= siblings.length; offset += 1) {
    const index = (start + step * offset + siblings.length * 2) % siblings.length;
    if (isSelectable(siblings[index]!)) {
      const prefix = parentPath(path);
      return prefix ? `${prefix}.${index}` : String(index);
    }
  }
  return null;
}

/** The deepest selectable element at a point of the frame, never the body. */
export function elementAtPoint(doc: Document, x: number, y: number): HTMLElement | null {
  let element = doc.elementFromPoint(x, y);
  // A drawing is one piece: a click on one of its shapes selects the whole <svg>.
  const svg = element?.closest("svg");
  if (svg) element = svg;
  while (element && !isSelectable(element)) element = element.parentElement;
  if (!element || element === doc.body || element === doc.documentElement) return null;
  return element as HTMLElement;
}

/** Rectangle of an element in the frame's own coordinates (the artboard's CSS pixels). */
export function frameRect(element: Element): { x: number; y: number; w: number; h: number } {
  const rect = element.getBoundingClientRect();
  const view = element.ownerDocument.defaultView;
  return {
    x: rect.left + (view?.scrollX ?? 0),
    y: rect.top + (view?.scrollY ?? 0),
    w: rect.width,
    h: rect.height,
  };
}
