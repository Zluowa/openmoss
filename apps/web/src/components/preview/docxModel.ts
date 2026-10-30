export const DOCX_PAGE_SELECTOR = "section.moss-docx-preview";
export const DOCX_ZOOM_OPTIONS = [25, 50, 100, 150, 200] as const;

export function clampDocxZoom(percent: number): number {
  return Math.min(400, Math.max(10, Number.isFinite(percent) ? percent : 75));
}

export function wheelDocxZoom(percent: number, deltaY: number): number {
  return clampDocxZoom(Math.round(percent * Math.exp(-deltaY * 0.01)));
}

export function pinchDocxZoom(
  percent: number,
  initialDistance: number,
  nextDistance: number,
): number {
  return initialDistance > 0
    ? clampDocxZoom(Math.round((nextDistance / initialDistance) * percent))
    : percent;
}

/** The parser model contains class instances; only inspect documented element fields. */
export function docxHasRedlines(value: unknown): boolean {
  return hasDocxMarker(
    value,
    new WeakSet<object>(),
    new Set(["inserted", "deleted", "deletedText"]),
  );
}

function hasDocxMarker(value: unknown, seen: WeakSet<object>, markers: Set<string>): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasDocxMarker(item, seen, markers));
  const node = value as Record<string, unknown>;
  if (typeof node.type === "string" && markers.has(node.type)) return true;
  return ["parts", "body", "rootElement", "notes", "children"].some((key) =>
    hasDocxMarker(node[key], seen, markers),
  );
}

export function docxHasInvalidSymbols(value: unknown): boolean {
  return hasInvalidSymbols(value, new WeakSet<object>());
}

function hasInvalidSymbols(value: unknown, seen: WeakSet<object>): boolean {
  if (!value || typeof value !== "object") return false;
  if (seen.has(value)) return false;
  seen.add(value);
  if (Array.isArray(value)) return value.some((item) => hasInvalidSymbols(item, seen));
  const node = value as Record<string, unknown>;
  if (node.type === "symbol") {
    if (typeof node.char !== "string" || !/^[\da-f]{1,6}$/i.test(node.char)) return true;
    const codePoint = Number.parseInt(node.char, 16);
    return codePoint > 0x10ffff || (codePoint >= 0xd800 && codePoint <= 0xdfff);
  }
  return ["parts", "body", "rootElement", "notes", "comments", "children"].some((key) =>
    hasInvalidSymbols(node[key], seen),
  );
}

export function guardDocxLinks(container: HTMLElement): void {
  for (const anchor of container.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    try {
      const protocol = new URL(anchor.getAttribute("href") ?? "", window.location.href).protocol;
      if (protocol === "http:" || protocol === "https:") {
        anchor.target = "_blank";
        anchor.rel = "noopener noreferrer";
        continue;
      }
    } catch {
      /* A malformed hyperlink is displayed as plain text. */
    }
    anchor.removeAttribute("href");
  }
}

export interface DocxPreviewAnnotation {
  filePath: string;
  pageNumber: number;
  pageCount: number;
  pageSize: { width: number; height: number };
  selectedText: string;
  selectionKind?: "text" | "image" | "table";
  rect: { x: number; y: number; width: number; height: number };
  body: string;
}

export type DocxSelection = Omit<DocxPreviewAnnotation, "body" | "filePath"> & {
  toolbarPoint: { x: number; y: number };
  editorPoint: { x: number; y: number };
  viewportRect: { x: number; y: number; width: number; height: number };
};

export function readDocxSelection(container: HTMLElement, root: HTMLElement): DocxSelection | null {
  const selection = container.ownerDocument.getSelection();
  if (!selection || selection.isCollapsed || selection.rangeCount === 0) return null;
  const range = selection.getRangeAt(0);
  const start =
    range.startContainer.nodeType === Node.ELEMENT_NODE
      ? (range.startContainer as Element)
      : range.startContainer.parentElement;
  const end =
    range.endContainer.nodeType === Node.ELEMENT_NODE
      ? (range.endContainer as Element)
      : range.endContainer.parentElement;
  const page = start?.closest<HTMLElement>(DOCX_PAGE_SELECTOR);
  if (!page || !container.contains(page) || !end || !page.contains(end)) return null;
  const selectedText = selection.toString().trim();
  if (!selectedText) return null;
  const pageBounds = page.getBoundingClientRect();
  const rect = range.getBoundingClientRect();
  const rootBounds = root.getBoundingClientRect();
  const scale =
    pageBounds.width / (Number.parseFloat(getComputedStyle(page).width) || pageBounds.width);
  const pages = [...container.querySelectorAll(DOCX_PAGE_SELECTOR)];
  return {
    pageNumber: pages.indexOf(page) + 1,
    pageCount: pages.length,
    pageSize: { width: pageBounds.width / scale, height: pageBounds.height / scale },
    selectedText,
    selectionKind: "text",
    rect: {
      x: (rect.x - pageBounds.x) / scale,
      y: (rect.y - pageBounds.y) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
    viewportRect: {
      x: rect.x - rootBounds.x,
      y: rect.y - rootBounds.y,
      width: rect.width,
      height: rect.height,
    },
    toolbarPoint: {
      x: Math.max(8, Math.min(rootBounds.width - 152, rect.x - rootBounds.x)),
      y: Math.max(8, Math.min(rootBounds.height - 40, rect.bottom - rootBounds.y + 6)),
    },
    editorPoint: {
      x: Math.max(8, Math.min(rootBounds.width - 296, rect.x - rootBounds.x)),
      y: Math.max(8, Math.min(rootBounds.height - 220, rect.bottom - rootBounds.y + 6)),
    },
  };
}

export function readDocxElement(
  target: EventTarget | null,
  container: HTMLElement,
  root: HTMLElement,
): DocxSelection | null {
  if (!(target instanceof Element)) return null;
  const element = target.closest<HTMLElement>("img, table");
  if (!element || !container.contains(element)) return null;
  const page = element.closest<HTMLElement>(DOCX_PAGE_SELECTOR);
  if (!page) return null;
  const rect = element.getBoundingClientRect();
  const bounds = page.getBoundingClientRect();
  const rootBounds = root.getBoundingClientRect();
  const scale = bounds.width / (Number.parseFloat(getComputedStyle(page).width) || bounds.width);
  const pages = [...container.querySelectorAll(DOCX_PAGE_SELECTOR)];
  const isImage = element.tagName === "IMG";
  return {
    pageNumber: pages.indexOf(page) + 1,
    pageCount: pages.length,
    pageSize: { width: bounds.width / scale, height: bounds.height / scale },
    selectionKind: isImage ? "image" : "table",
    selectedText: isImage
      ? (element.getAttribute("alt") ?? "")
      : (element.textContent?.trim() ?? ""),
    rect: {
      x: (rect.x - bounds.x) / scale,
      y: (rect.y - bounds.y) / scale,
      width: rect.width / scale,
      height: rect.height / scale,
    },
    viewportRect: {
      x: rect.x - rootBounds.x,
      y: rect.y - rootBounds.y,
      width: rect.width,
      height: rect.height,
    },
    toolbarPoint: {
      x: Math.max(8, Math.min(rootBounds.width - 152, rect.x - rootBounds.x)),
      y: Math.max(8, Math.min(rootBounds.height - 40, rect.bottom - rootBounds.y + 6)),
    },
    editorPoint: {
      x: Math.max(8, Math.min(rootBounds.width - 296, rect.x - rootBounds.x)),
      y: Math.max(8, Math.min(rootBounds.height - 220, rect.bottom - rootBounds.y + 6)),
    },
  };
}
