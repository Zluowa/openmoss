// FILE: designComponents.ts
// Purpose: 设计 components on the artboard DOM: make a component from a selected element, place
//          an instance, write the master into every instance (keeping where each one sits), and
//          detach an instance.
// Layer: 资料空间 设计 (web)
// Why: A component is plain HTML like everything else; an instance is an element carrying
//      `data-design-component="<id>"`, so agents, exports and the code tab all see real markup.

import type { DesignComponent } from "@moss/shared/spaceItems/designCanvas";

export const COMPONENT_ATTR = "data-design-component";

/** Styles that say where an instance sits, not how it looks; syncing keeps them. */
const PLACEMENT = [
  "position",
  "left",
  "top",
  "right",
  "bottom",
  "z-index",
  "margin",
  "margin-top",
  "margin-right",
  "margin-bottom",
  "margin-left",
  "align-self",
  "justify-self",
  "flex",
  "flex-grow",
  "flex-shrink",
  "flex-basis",
  "grid-column",
  "grid-row",
  "order",
];

function fragmentElement(doc: Document, html: string): HTMLElement | null {
  const template = doc.createElement("template");
  template.innerHTML = html.trim();
  const element = template.content.firstElementChild;
  return element instanceof (doc.defaultView?.HTMLElement ?? HTMLElement)
    ? (element as HTMLElement)
    : null;
}

/** The component master made from `element`: its markup without where it sat. */
export function componentFromElement(
  element: HTMLElement,
  id: string,
  name: string,
): DesignComponent {
  const master = element.cloneNode(true) as HTMLElement;
  for (const property of PLACEMENT) master.style.removeProperty(property);
  master.setAttribute(COMPONENT_ATTR, id);
  master.removeAttribute("contenteditable");
  if (!master.getAttribute("style")) master.removeAttribute("style");
  element.setAttribute(COMPONENT_ATTR, id);
  return { id, name, html: master.outerHTML };
}

/** An instance of `component` to place in an artboard root, at `at` when given. */
export function instanceMarkup(
  doc: Document,
  component: DesignComponent,
  at?: { x: number; y: number },
): string {
  const element = fragmentElement(doc, component.html);
  if (!element) return "";
  element.setAttribute(COMPONENT_ATTR, component.id);
  if (at) {
    element.style.setProperty("position", "absolute");
    element.style.setProperty("left", `${Math.round(at.x)}px`);
    element.style.setProperty("top", `${Math.round(at.y)}px`);
  }
  return element.outerHTML;
}

export function instancesOf(body: HTMLElement, componentId: string): HTMLElement[] {
  return [...body.querySelectorAll<HTMLElement>(`[${COMPONENT_ATTR}]`)].filter(
    (element) => element.getAttribute(COMPONENT_ATTR) === componentId,
  );
}

/** Writes the master into every instance in `body`; returns how many changed. */
export function syncInstances(body: HTMLElement, component: DesignComponent): number {
  let changed = 0;
  for (const instance of instancesOf(body, component.id)) {
    const fresh = fragmentElement(body.ownerDocument, component.html);
    if (!fresh) continue;
    for (const property of PLACEMENT) {
      const value = instance.style.getPropertyValue(property);
      if (value) fresh.style.setProperty(property, value);
    }
    fresh.setAttribute(COMPONENT_ATTR, component.id);
    if (fresh.outerHTML === instance.outerHTML) continue;
    instance.replaceWith(fresh);
    changed += 1;
  }
  return changed;
}

/** The component this element is an instance of (it or its nearest ancestor). */
export function instanceRoot(element: HTMLElement): HTMLElement | null {
  return element.closest<HTMLElement>(`[${COMPONENT_ATTR}]`);
}

export function detachInstance(element: HTMLElement) {
  element.removeAttribute(COMPONENT_ATTR);
}
