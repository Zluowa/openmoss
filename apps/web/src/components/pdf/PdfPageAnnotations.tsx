import { type RefObject, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
import {
  isPdfAnnotationShortcut,
  normalizePdfAnnotationRect,
  type PdfAnnotationRect,
  type PdfPreviewAnnotation,
} from "~/lib/pdf/pdfAnnotations";

interface SelectionAnchor {
  rect: PdfAnnotationRect;
  selectedText: string;
}

export function PdfPageAnnotations(props: {
  pageRef: RefObject<HTMLDivElement | null>;
  pageNumber: number;
  pageCount: number;
  annotationMode: boolean;
  onAnnotate: (annotation: PdfPreviewAnnotation) => void;
}) {
  const [selection, setSelection] = useState<SelectionAnchor | null>(null);
  const [draft, setDraft] = useState<SelectionAnchor | null>(null);
  const [body, setBody] = useState("");
  const [region, setRegion] = useState<PdfAnnotationRect | null>(null);
  const dragStart = useRef<{ x: number; y: number } | null>(null);
  const draftRef = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (draft) draftRef.current?.focus();
  }, [draft]);

  useEffect(() => {
    const readSelection = (): SelectionAnchor | null => {
      const page = props.pageRef.current;
      const selected = window.getSelection();
      if (!page || !selected || selected.isCollapsed || !selected.rangeCount) return null;
      const range = selected.getRangeAt(0);
      if (!page.contains(range.startContainer) || !page.contains(range.endContainer)) return null;
      const textLayer = page.querySelector(".pdf-viewer-page__text-layer");
      if (!textLayer?.contains(range.startContainer) || !textLayer.contains(range.endContainer))
        return null;
      const selectedText = selected.toString().trim();
      if (!selectedText) return null;
      const rect = normalizePdfAnnotationRect(
        range.getBoundingClientRect(),
        page.getBoundingClientRect(),
      );
      return rect ? { rect, selectedText } : null;
    };
    const update = () => {
      if (!draft) setSelection(props.annotationMode ? readSelection() : null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.defaultPrevented) return;
      if (event.key === "Escape" && draft) {
        event.preventDefault();
        event.stopPropagation();
        setDraft(null);
        setBody("");
        return;
      }
      if (!isPdfAnnotationShortcut(event)) return;
      if (!props.annotationMode) return;
      const next = readSelection();
      if (!next) return;
      event.preventDefault();
      event.stopPropagation();
      setDraft(next);
      setBody("");
      setSelection(null);
    };
    document.addEventListener("selectionchange", update);
    document.addEventListener("pointerup", update);
    window.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("selectionchange", update);
      document.removeEventListener("pointerup", update);
      window.removeEventListener("keydown", onKeyDown);
    };
  }, [draft, props.annotationMode, props.pageRef]);

  const startDraft = (anchor: SelectionAnchor) => {
    setDraft(anchor);
    setSelection(null);
    setBody("");
  };
  const pageBounds = props.pageRef.current?.getBoundingClientRect();
  const draftLeft =
    pageBounds && draft
      ? Math.max(
          8,
          Math.min(window.innerWidth - 302, pageBounds.left + draft.rect.x * pageBounds.width),
        )
      : 8;
  const draftTop =
    pageBounds && draft
      ? Math.max(
          8,
          Math.min(
            window.innerHeight - 190,
            pageBounds.top + (draft.rect.y + draft.rect.height) * pageBounds.height + 8,
          ),
        )
      : 8;
  const highlight = draft?.rect ?? region;
  const regionAt = (x: number, y: number) => {
    const start = dragStart.current;
    const page = props.pageRef.current;
    if (!start || !page) return null;
    return normalizePdfAnnotationRect(
      {
        left: Math.min(start.x, x),
        top: Math.min(start.y, y),
        width: Math.abs(x - start.x),
        height: Math.abs(y - start.y),
      },
      page.getBoundingClientRect(),
    );
  };

  return (
    <div
      className={
        props.annotationMode && !draft
          ? "absolute inset-0 z-[3] cursor-crosshair"
          : "pointer-events-none absolute inset-0 z-[3]"
      }
      data-testid="artifact-pdf-comment-layer"
      onPointerDown={(event) => {
        if (
          !props.annotationMode ||
          draft ||
          event.button !== 0 ||
          event.target !== event.currentTarget
        )
          return;
        event.preventDefault();
        event.currentTarget.setPointerCapture(event.pointerId);
        dragStart.current = { x: event.clientX, y: event.clientY };
        setSelection(null);
      }}
      onPointerMove={(event) => {
        if (dragStart.current) setRegion(regionAt(event.clientX, event.clientY));
      }}
      onPointerUp={(event) => {
        if (!dragStart.current) return;
        const rect = regionAt(event.clientX, event.clientY);
        dragStart.current = null;
        setRegion(null);
        if (event.currentTarget.hasPointerCapture(event.pointerId))
          event.currentTarget.releasePointerCapture(event.pointerId);
        if (
          rect &&
          pageBounds &&
          rect.width * pageBounds.width >= 3 &&
          rect.height * pageBounds.height >= 3
        ) {
          startDraft({ rect, selectedText: "" });
        }
      }}
      onPointerCancel={() => {
        dragStart.current = null;
        setRegion(null);
      }}
    >
      {highlight ? (
        <div
          data-testid="artifact-pdf-annotation-highlight"
          className="pointer-events-none absolute rounded-sm border border-blue-500 bg-blue-500/10"
          style={{
            left: `${highlight.x * 100}%`,
            top: `${highlight.y * 100}%`,
            width: `${highlight.width * 100}%`,
            height: `${highlight.height * 100}%`,
          }}
        />
      ) : null}
      {selection && !draft ? (
        <button
          type="button"
          className="pointer-events-auto absolute z-10 whitespace-nowrap rounded-lg border border-border bg-popover px-2.5 py-1.5 text-ui-sm text-popover-foreground shadow-md"
          style={{
            left: `${Math.min(selection.rect.x, 0.7) * 100}%`,
            top: `calc(${(selection.rect.y + selection.rect.height) * 100}% + 6px)`,
          }}
          data-testid="artifact-pdf-ask-for-edit-button"
          onPointerDown={(event) => event.preventDefault()}
          onClick={() => startDraft(selection)}
        >
          Ask for change
        </button>
      ) : null}
      {draft
        ? createPortal(
            <form
              role="dialog"
              aria-label="PDF annotation"
              className="fixed z-50 flex w-[294px] flex-col gap-2 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-xl"
              style={{ left: draftLeft, top: draftTop }}
              onPointerDown={(event) => event.stopPropagation()}
              onKeyDown={(event) => {
                if (event.key === "Escape") {
                  event.preventDefault();
                  event.stopPropagation();
                  setDraft(null);
                  setBody("");
                } else if (event.key === "Enter" && (event.metaKey || event.ctrlKey)) {
                  event.preventDefault();
                  event.currentTarget.requestSubmit();
                }
              }}
              onSubmit={(event) => {
                event.preventDefault();
                if (!body.trim()) return;
                props.onAnnotate({
                  pageNumber: props.pageNumber,
                  pageCount: props.pageCount,
                  selectedText: draft.selectedText,
                  rect: draft.rect,
                  body: body.trim(),
                });
                setDraft(null);
                setBody("");
                setSelection(null);
                window.getSelection()?.removeAllRanges();
              }}
            >
              <textarea
                ref={draftRef}
                aria-label="PDF annotation comment"
                placeholder="Describe a change or ask a question"
                className="min-h-20 resize-none rounded-md bg-transparent text-ui-lg outline-none"
                value={body}
                onChange={(event) => setBody(event.target.value)}
              />
              <div className="flex justify-end gap-2">
                <button
                  type="button"
                  className="rounded-md px-2 py-1 text-ui-sm hover:bg-foreground/5"
                  onClick={() => {
                    setDraft(null);
                    setBody("");
                  }}
                >
                  Cancel
                </button>
                <button
                  type="submit"
                  disabled={!body.trim()}
                  className="rounded-md bg-primary px-2 py-1 text-ui-sm text-primary-foreground disabled:opacity-40"
                >
                  Add comment
                </button>
              </div>
            </form>,
            document.body,
          )
        : null}
    </div>
  );
}
