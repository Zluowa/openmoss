import { type CSSProperties, useEffect, useRef, useState } from "react";
import { isLocalAbsolutePath, joinWorkspaceRelativePath } from "@synara/shared/path";

import { basenameOfPath } from "~/file-icons";
import {
  CheckIcon,
  ChevronDownIcon,
  DownloadIcon,
  EyeIcon,
  Loader2Icon,
  TriangleAlertIcon,
} from "~/lib/icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import { cn } from "~/lib/utils";

import { Button } from "./ui/button";
import { OpenInPicker } from "./chat/OpenInPicker";
import { Menu, MenuItem, MenuPopupBase, MenuSeparator, MenuTrigger } from "./ui/menu";
import {
  DOCX_PAGE_SELECTOR,
  DOCX_ZOOM_OPTIONS,
  clampDocxZoom,
  docxHasInvalidSymbols,
  docxHasRedlines,
  guardDocxLinks,
  pinchDocxZoom,
  readDocxElement,
  readDocxSelection,
  wheelDocxZoom,
  type DocxPreviewAnnotation,
  type DocxSelection,
} from "./preview/docxModel";

import "./docx-preview.css";

export type { DocxPreviewAnnotation } from "./preview/docxModel";

export interface DocxPreviewPanelProps {
  filePath: string;
  cwd: string | null;
  previewGrant?: string | null;
  cacheKey?: string | number;
  onPreviewReady?: () => void;
  onPreviewError?: () => void;
  /** Supplied only when a conversation can accept a document annotation. */
  onAnnotate?: (annotation: DocxPreviewAnnotation) => void | Promise<void>;
}

export function DocxPreviewPanel(props: DocxPreviewPanelProps) {
  const src = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
  });
  return <DocxDocument key={src} {...props} src={src} />;
}

function DocxDocument(props: DocxPreviewPanelProps & { src: string }) {
  const rootRef = useRef<HTMLElement>(null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const cleanRef = useRef<HTMLDivElement>(null);
  const redlinesRef = useRef<HTMLDivElement>(null);
  const styleRef = useRef<HTMLDivElement>(null);
  const callbacksRef = useRef(props);
  callbacksRef.current = props;
  const [state, setState] = useState<"loading" | "ready" | "error">("loading");
  const [hasRedlines, setHasRedlines] = useState(false);
  const [showRedlines, setShowRedlines] = useState(true);
  const [fitWidth, setFitWidth] = useState(true);
  const [zoom, setZoom] = useState(75);
  const zoomRef = useRef(zoom);
  zoomRef.current = zoom;
  const [selection, setSelection] = useState<DocxSelection | null>(null);
  const [editingAnnotation, setEditingAnnotation] = useState(false);
  const [annotationBody, setAnnotationBody] = useState("");
  const [annotationError, setAnnotationError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const fileName = basenameOfPath(props.filePath);
  const activeRef = hasRedlines && showRedlines ? redlinesRef : cleanRef;
  const downloadUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    download: true,
  });
  const openInTarget = isLocalAbsolutePath(props.filePath)
    ? props.filePath
    : props.cwd
      ? joinWorkspaceRelativePath(props.cwd, props.filePath)
      : null;

  useEffect(() => {
    const controller = new AbortController();
    let cancelled = false;
    void (async () => {
      try {
        const response = await fetch(props.src, { signal: controller.signal });
        if (!response.ok) throw new Error(`DOCX preview request failed (${response.status})`);
        const bytes = await response.arrayBuffer();
        const renderer = await import("docx-preview");
        if (cancelled) return;
        const options = {
          className: "moss-docx-preview",
          renderAltChunks: false,
          useBase64URL: true,
          renderChanges: false,
        };
        const cleanModel = await renderer.parseAsync(bytes, options);
        if (docxHasInvalidSymbols(cleanModel)) throw new Error("Invalid document symbol");
        const changes = docxHasRedlines(cleanModel);
        // Render off-DOM: an obsolete request cannot overwrite a newer document.
        const cleanBody = document.createElement("div");
        const cleanStyles = document.createElement("div");
        const cleanNodes = await renderer.renderDocument(cleanModel, options);
        for (const node of cleanNodes)
          (node.nodeName === "STYLE" ? cleanStyles : cleanBody).appendChild(node);
        guardDocxLinks(cleanBody);
        const redlinesBody = document.createElement("div");
        const redlinesStyles = document.createElement("div");
        if (changes) {
          const redlinesOptions = { ...options, renderChanges: true };
          const redlinesModel = await renderer.parseAsync(bytes, redlinesOptions);
          const redlinesNodes = await renderer.renderDocument(redlinesModel, redlinesOptions);
          for (const node of redlinesNodes)
            (node.nodeName === "STYLE" ? redlinesStyles : redlinesBody).appendChild(node);
          guardDocxLinks(redlinesBody);
        }
        if (cancelled || !cleanRef.current || !redlinesRef.current || !styleRef.current) return;
        cleanRef.current.replaceChildren(...cleanBody.childNodes);
        redlinesRef.current.replaceChildren(...redlinesBody.childNodes);
        styleRef.current.replaceChildren(...cleanStyles.childNodes, ...redlinesStyles.childNodes);
        setHasRedlines(changes);
        setState("ready");
        callbacksRef.current.onPreviewReady?.();
      } catch {
        if (!cancelled) {
          setState("error");
          callbacksRef.current.onPreviewError?.();
        }
      }
    })();
    return () => {
      cancelled = true;
      controller.abort();
    };
  }, [props.src]);

  useEffect(() => {
    if (state !== "ready" || !fitWidth) return;
    const container = activeRef.current;
    if (!container) return;
    const fit = () => {
      const page = container.querySelector<HTMLElement>(DOCX_PAGE_SELECTOR);
      if (!page) return;
      const wrapperStyle = getComputedStyle(page.parentElement ?? container);
      const padding =
        Number.parseFloat(wrapperStyle.paddingLeft) + Number.parseFloat(wrapperStyle.paddingRight);
      const pageWidth = Number.parseFloat(getComputedStyle(page).width);
      if (pageWidth > 0)
        setZoom(
          clampDocxZoom(
            Math.round(
              (Math.max(1, container.clientWidth - (Number.isFinite(padding) ? padding : 0)) /
                pageWidth) *
                100,
            ),
          ),
        );
    };
    fit();
    const observer = new ResizeObserver(fit);
    observer.observe(container);
    return () => observer.disconnect();
  }, [activeRef, fitWidth, state]);

  useEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    let pinch: { distance: number; zoom: number } | null = null;
    const touchDistance = (touches: TouchList) => {
      const first = touches[0];
      const second = touches[1];
      return first && second
        ? Math.hypot(second.clientX - first.clientX, second.clientY - first.clientY)
        : 0;
    };
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      setFitWidth(false);
      setZoom((percent) => wheelDocxZoom(percent, event.deltaY));
    };
    const touchStart = (event: TouchEvent) => {
      if (event.touches.length !== 2) {
        pinch = null;
        return;
      }
      event.preventDefault();
      pinch = { distance: touchDistance(event.touches), zoom: zoomRef.current };
    };
    const touchMove = (event: TouchEvent) => {
      if (event.touches.length !== 2 || !pinch) return;
      event.preventDefault();
      const distance = touchDistance(event.touches);
      if (distance > 0 && pinch.distance > 0) {
        setFitWidth(false);
        setZoom(pinchDocxZoom(pinch.zoom, pinch.distance, distance));
      }
    };
    const touchEnd = () => {
      pinch = null;
    };
    viewport.addEventListener("wheel", wheel, { passive: false });
    viewport.addEventListener("touchstart", touchStart, { passive: false });
    viewport.addEventListener("touchmove", touchMove, { passive: false });
    viewport.addEventListener("touchend", touchEnd);
    viewport.addEventListener("touchcancel", touchEnd);
    return () => {
      viewport.removeEventListener("wheel", wheel);
      viewport.removeEventListener("touchstart", touchStart);
      viewport.removeEventListener("touchmove", touchMove);
      viewport.removeEventListener("touchend", touchEnd);
      viewport.removeEventListener("touchcancel", touchEnd);
    };
  }, []);

  useEffect(() => {
    if (!props.onAnnotate || editingAnnotation || state !== "ready") return;
    const handleShortcut = (event: KeyboardEvent) => {
      if (
        event.key.toLowerCase() !== "i" ||
        !(event.ctrlKey || event.metaKey) ||
        event.altKey ||
        event.shiftKey
      )
        return;
      if (!activeRef.current || !rootRef.current) return;
      if (
        event.target instanceof Element &&
        event.target.closest('input, textarea, [contenteditable="true"]')
      )
        return;
      const candidate =
        readDocxSelection(activeRef.current, rootRef.current) ??
        (selection?.selectionKind !== "text" ? selection : null);
      if (!candidate) return;
      event.preventDefault();
      event.stopPropagation();
      setSelection(candidate);
      setEditingAnnotation(true);
      setAnnotationError("");
    };
    document.addEventListener("keydown", handleShortcut, { capture: true });
    return () => document.removeEventListener("keydown", handleShortcut, { capture: true });
  }, [activeRef, editingAnnotation, props.onAnnotate, selection, state]);

  const updateSelection = () => {
    if (!props.onAnnotate || editingAnnotation || !activeRef.current || !rootRef.current) return;
    setSelection(readDocxSelection(activeRef.current, rootRef.current));
  };

  const selectElement = (target: EventTarget | null) => {
    if (!props.onAnnotate || editingAnnotation || !activeRef.current || !rootRef.current) return;
    if (window.getSelection()?.toString().trim()) return;
    const elementSelection = readDocxElement(target, activeRef.current, rootRef.current);
    if (elementSelection) setSelection(elementSelection);
  };

  const selectFit = () => {
    const container = activeRef.current;
    const pages = container?.querySelectorAll<HTMLElement>(DOCX_PAGE_SELECTOR);
    const bounds = container?.getBoundingClientRect();
    let nearestPage: HTMLElement | null = null;
    let minimumDistance = Infinity;
    if (bounds && pages)
      for (const page of pages) {
        const rect = page.getBoundingClientRect();
        const distance = Math.abs(rect.top + rect.height / 2 - bounds.top - bounds.height / 2);
        if (distance < minimumDistance) {
          minimumDistance = distance;
          nearestPage = page;
        }
      }
    setFitWidth(true);
    if (!fitWidth && nearestPage)
      requestAnimationFrame(() =>
        nearestPage?.scrollIntoView({ block: "center", inline: "center" }),
      );
  };

  return (
    <section
      ref={rootRef}
      className="relative flex h-full min-h-0 flex-1 flex-col bg-surface-secondary"
      data-docx-preview="true"
    >
      <div ref={styleRef} className="hidden" aria-hidden="true" />
      {state === "ready" ? (
        <header className="grid h-10 shrink-0 grid-cols-[minmax(0,1fr)_auto] items-center gap-2 overflow-hidden border-b border-border/50 bg-background pl-4 pr-2">
          <h2 className="truncate text-ui-lg font-medium">{fileName.replace(/\.docx$/i, "")}</h2>
          <div className="flex items-center gap-1">
            {hasRedlines ? (
              <Button
                variant={showRedlines ? "secondary" : "ghost"}
                size="icon-sm"
                aria-label="Show redlines"
                aria-pressed={showRedlines}
                title={showRedlines ? "Hide redlines" : "Show redlines"}
                onClick={() => {
                  const current = activeRef.current;
                  const next = showRedlines ? cleanRef.current : redlinesRef.current;
                  if (current && next)
                    next.scrollTo({ top: current.scrollTop, left: current.scrollLeft });
                  window.getSelection()?.removeAllRanges();
                  setSelection(null);
                  setEditingAnnotation(false);
                  setAnnotationBody("");
                  setShowRedlines((value) => !value);
                }}
              >
                <EyeIcon className="size-4" aria-hidden="true" />
              </Button>
            ) : null}
            <Menu>
              <MenuTrigger
                render={
                  <Button
                    variant="ghost"
                    size="sm"
                    className="gap-0.5 text-ui-lg font-normal text-muted-foreground"
                  />
                }
                aria-label={`Zoom ${zoom}%`}
                data-testid="docx-preview-zoom-trigger"
              >
                <span className="tabular-nums">{zoom}%</span>
                <ChevronDownIcon className="size-3 opacity-50" aria-hidden="true" />
              </MenuTrigger>
              <MenuPopupBase
                align="end"
                sideOffset={4}
                className="w-[136px] min-w-[136px] rounded-popover p-1.5"
              >
                {DOCX_ZOOM_OPTIONS.map((percent) => (
                  <MenuItem
                    key={percent}
                    className="justify-between rounded-md px-2 py-[5px]"
                    onClick={() => {
                      setFitWidth(false);
                      setZoom(percent);
                    }}
                  >
                    {percent}%
                    <CheckIcon
                      className={cn("size-4", (fitWidth || percent !== zoom) && "invisible")}
                      aria-hidden="true"
                    />
                  </MenuItem>
                ))}
                <MenuSeparator />
                <MenuItem className="justify-between rounded-md px-2 py-[5px]" onClick={selectFit}>
                  Fit
                  <CheckIcon
                    className={cn("size-4", !fitWidth && "invisible")}
                    aria-hidden="true"
                  />
                </MenuItem>
              </MenuPopupBase>
            </Menu>
            <a
              href={downloadUrl}
              download={fileName}
              aria-label={`Download ${fileName}`}
              title={`Download ${fileName}`}
              className="inline-flex size-8 items-center justify-center rounded-lg text-muted-foreground hover:bg-foreground/5"
            >
              <DownloadIcon className="size-4" aria-hidden="true" />
            </a>
            <OpenInPicker
              openInTarget={openInTarget}
              defaultEditor="system-default"
              labelMode="always"
            />
          </div>
        </header>
      ) : null}
      <div
        ref={viewportRef}
        className="relative min-h-0 flex-1"
        style={{ "--moss-docx-preview-zoom": zoom / 100 } as CSSProperties}
      >
        <div
          ref={cleanRef}
          aria-label={fileName}
          aria-hidden={(hasRedlines && showRedlines) || state !== "ready"}
          inert={(hasRedlines && showRedlines) || state !== "ready"}
          data-testid={!hasRedlines || !showRedlines ? "docx-preview-panel" : undefined}
          className={cn(
            "moss-docx-preview-body absolute inset-0 overflow-auto overscroll-contain",
            ((hasRedlines && showRedlines) || state !== "ready") && "invisible",
          )}
          onMouseUp={updateSelection}
          onKeyUp={updateSelection}
          onClick={(event) => selectElement(event.target)}
          onScroll={() => {
            if (!editingAnnotation) setSelection(null);
          }}
        />
        <div
          ref={redlinesRef}
          aria-label={fileName}
          aria-hidden={!hasRedlines || !showRedlines || state !== "ready"}
          inert={!hasRedlines || !showRedlines || state !== "ready"}
          data-testid={hasRedlines && showRedlines ? "docx-preview-panel" : undefined}
          className={cn(
            "moss-docx-preview-body absolute inset-0 overflow-auto overscroll-contain",
            (!hasRedlines || !showRedlines || state !== "ready") && "invisible",
          )}
          onMouseUp={updateSelection}
          onKeyUp={updateSelection}
          onClick={(event) => selectElement(event.target)}
          onScroll={() => {
            if (!editingAnnotation) setSelection(null);
          }}
        />
      </div>
      {state === "loading" ? (
        <div className="absolute inset-0 flex items-center justify-center" role="status">
          <Loader2Icon
            className="size-5 animate-spin text-muted-foreground"
            aria-label="Loading DOCX preview"
          />
        </div>
      ) : null}
      {state === "error" ? (
        <div
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-ui-lg text-muted-foreground"
          role="status"
        >
          <TriangleAlertIcon className="size-5" aria-hidden="true" />
          <p>Unable to render {fileName}.</p>
          <a
            className="inline-flex items-center gap-1.5 rounded-md border px-3 py-1.5 text-ui-sm hover:bg-foreground/5"
            href={downloadUrl}
            download={fileName}
          >
            <DownloadIcon className="size-3.5" aria-hidden="true" />
            Download file
          </a>
        </div>
      ) : null}
      {selection && props.onAnnotate ? (
        <>
          {selection.selectionKind !== "text" ? (
            <div
              aria-hidden="true"
              data-testid="artifact-docx-selection-outline"
              className="pointer-events-none absolute z-10 rounded-sm border border-blue-500 bg-blue-500/5"
              style={{
                left: selection.viewportRect.x - 4,
                top: selection.viewportRect.y - 4,
                width: selection.viewportRect.width + 8,
                height: selection.viewportRect.height + 8,
              }}
            />
          ) : null}
          <div
            className="absolute z-20"
            style={{
              left: editingAnnotation ? selection.editorPoint.x : selection.toolbarPoint.x,
              top: editingAnnotation ? selection.editorPoint.y : selection.toolbarPoint.y,
            }}
          >
            {!editingAnnotation ? (
              <Button
                size="sm"
                variant="secondary"
                data-paged-annotation-ask-for-edit="true"
                data-testid="artifact-docx-ask-for-edit-button"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => {
                  setEditingAnnotation(true);
                  setAnnotationError("");
                }}
              >
                Ask for change
              </Button>
            ) : (
              <form
                className="w-72 max-w-[calc(100vw-2rem)] rounded-xl border bg-background p-3 shadow-lg"
                aria-label={`Comment on page ${selection.pageNumber}`}
                onSubmit={(event) => {
                  event.preventDefault();
                  if (!annotationBody.trim() || submitting) return;
                  setSubmitting(true);
                  setAnnotationError("");
                  void Promise.resolve()
                    .then(() =>
                      props.onAnnotate?.({
                        filePath: props.filePath,
                        pageNumber: selection.pageNumber,
                        pageCount: selection.pageCount,
                        pageSize: selection.pageSize,
                        selectedText: selection.selectedText,
                        ...(selection.selectionKind
                          ? { selectionKind: selection.selectionKind }
                          : {}),
                        rect: selection.rect,
                        body: annotationBody.trim(),
                      }),
                    )
                    .then(() => {
                      setSelection(null);
                      setEditingAnnotation(false);
                      setAnnotationBody("");
                      window.getSelection()?.removeAllRanges();
                    })
                    .catch(() => setAnnotationError("Could not add this comment. Try again."))
                    .finally(() => setSubmitting(false));
                }}
              >
                <div className="mb-2 text-ui-sm text-muted-foreground">
                  Page {selection.pageNumber}
                </div>
                <textarea
                  autoFocus
                  aria-label="Requested change"
                  placeholder="Ask for a change…"
                  className="min-h-20 w-full resize-y rounded-md border bg-transparent p-2 text-ui-lg"
                  value={annotationBody}
                  onChange={(event) => setAnnotationBody(event.target.value)}
                  onKeyDown={(event) => {
                    if (event.key === "Escape") {
                      event.preventDefault();
                      setEditingAnnotation(false);
                    }
                  }}
                />
                {annotationError ? (
                  <p role="alert" className="mt-1 text-ui-sm text-destructive">
                    {annotationError}
                  </p>
                ) : null}
                <div className="mt-2 flex justify-end gap-2">
                  <Button
                    type="button"
                    variant="ghost"
                    size="sm"
                    disabled={submitting}
                    onClick={() => {
                      setEditingAnnotation(false);
                      setSelection(null);
                    }}
                  >
                    Cancel
                  </Button>
                  <Button type="submit" size="sm" disabled={!annotationBody.trim() || submitting}>
                    Add to chat
                  </Button>
                </div>
              </form>
            )}
          </div>
        </>
      ) : null}
    </section>
  );
}
