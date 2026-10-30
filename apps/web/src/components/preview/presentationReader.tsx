import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type KeyboardEvent,
  type PointerEvent,
} from "react";

import { DISCLOSURE_FLOATING_PANEL_MOTION_CLASS } from "~/lib/disclosureMotion";
import { DownloadIcon, MessageCircleIcon, XIcon } from "~/lib/icons";
import type {
  PresentationPreview,
  RenderedPresentationSlide,
} from "~/lib/preview/presentationModel";
import { cn } from "~/lib/utils";
import { OpenInPicker } from "../chat/OpenInPicker";
import { PresentationZoom } from "./presentationZoom";

import "./presentationReader.css";

export interface PresentationAnnotation {
  kind: "presentation";
  slideNumber: number;
  text: string;
  /** Normalized slide coordinates remain stable across viewport sizes and zoom. */
  anchor: { x: number; y: number };
}

function SlideImage({
  preview,
  index,
  eager = false,
  onReady,
  onError,
  onPartial,
}: {
  preview: PresentationPreview;
  index: number;
  eager?: boolean;
  onReady?: () => void;
  onError?: () => void;
  onPartial?: (index: number) => void;
}) {
  const element = useRef<HTMLDivElement>(null);
  const [image, setImage] = useState<RenderedPresentationSlide | null>(null);
  const [failed, setFailed] = useState(false);
  const callbacks = useRef({ onReady, onError, onPartial });
  callbacks.current = { onReady, onError, onPartial };
  useEffect(() => {
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const render = () => {
      timer = setTimeout(() => {
        if (cancelled) return;
        try {
          const rendered = preview.render(index);
          setImage(rendered);
          if (rendered.partial) callbacks.current.onPartial?.(index);
        } catch {
          setFailed(true);
          callbacks.current.onError?.();
        }
      }, 0);
    };
    const target = element.current;
    let observer: IntersectionObserver | undefined;
    if (eager || !target || typeof IntersectionObserver === "undefined") render();
    else {
      observer = new IntersectionObserver(
        (entries) => {
          if (!entries.some((entry) => entry.isIntersecting)) return;
          observer?.disconnect();
          render();
        },
        { rootMargin: "200px" },
      );
      observer.observe(target);
    }
    return () => {
      cancelled = true;
      clearTimeout(timer);
      observer?.disconnect();
    };
  }, [preview, index, eager]);
  return (
    <div
      ref={element}
      className="presentation-slide-image"
      style={{ aspectRatio: `${preview.width} / ${preview.height}` }}
    >
      {image ? (
        <img
          alt=""
          draggable={false}
          src={image.url}
          onLoad={() => callbacks.current.onReady?.()}
          onError={() => {
            setFailed(true);
            callbacks.current.onError?.();
          }}
        />
      ) : null}
      {failed ? (
        <span className="presentation-slide-placeholder">Unable to render this slide</span>
      ) : !image ? (
        <span
          className="presentation-slide-placeholder animate-pulse motion-reduce:animate-none"
          aria-label="Loading slide"
        />
      ) : null}
    </div>
  );
}

function clampZoom(value: number) {
  return Math.max(0.01, Math.min(64, value));
}

export function PresentationReader({
  preview,
  fileName,
  downloadUrl,
  openInTarget,
  onReady,
  onError,
  onAnnotate,
}: {
  preview: PresentationPreview;
  fileName: string;
  downloadUrl: string;
  openInTarget: string | null;
  onReady: () => void;
  onError: () => void;
  onAnnotate?: (annotation: PresentationAnnotation) => void;
}) {
  const root = useRef<HTMLDivElement>(null);
  const viewport = useRef<HTMLDivElement>(null);
  const slideSurface = useRef<HTMLDivElement>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });
  const [windowWide, setWindowWide] = useState(
    () => typeof window !== "undefined" && window.innerWidth >= 900,
  );
  const [active, setActive] = useState(0);
  const [railOpen, setRailOpen] = useState(false);
  const [zoom, setZoom] = useState<number | "fit">("fit");
  const [annotationMode, setAnnotationMode] = useState(false);
  const [annotation, setAnnotation] = useState<{ x: number; y: number } | null>(null);
  const [annotationText, setAnnotationText] = useState("");
  const [partialSlides, setPartialSlides] = useState<Set<number>>(() => new Set());
  const ready = useRef(false);
  const pointer = useRef<{
    id: number;
    x: number;
    y: number;
    scrollLeft: number;
    scrollTop: number;
  } | null>(null);
  const [spaceDown, setSpaceDown] = useState(false);
  const current = preview.slides[active]!;
  const stacked = size.width > 0 && size.width <= 688;
  const desktop = size.width >= 820;
  const showNotes = !stacked && windowWide && current.notes.trim().length > 0;
  const fit = Math.max(
    0.01,
    Math.min(
      (size.width - (desktop ? 166 : 24) - 48) / preview.width,
      (size.height - (showNotes ? 144 : 0) - 48) / preview.height,
    ),
  );
  const scale = zoom === "fit" ? fit : zoom;

  useEffect(() => {
    const target = root.current;
    if (!target) return;
    const resize = () => setSize({ width: target.clientWidth, height: target.clientHeight });
    resize();
    const observer = new ResizeObserver(resize);
    observer.observe(target);
    const query = window.matchMedia("(min-width: 900px)");
    const windowResize = () => setWindowWide(query.matches);
    query.addEventListener("change", windowResize);
    return () => {
      observer.disconnect();
      query.removeEventListener("change", windowResize);
    };
  }, []);

  useEffect(() => {
    const target = viewport.current;
    if (!target || stacked) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      event.preventDefault();
      const bounds = target.getBoundingClientRect();
      const x = event.clientX - bounds.left;
      const y = event.clientY - bounds.top;
      const next = clampZoom(scale * Math.exp(-event.deltaY * 0.002));
      const ratio = next / scale;
      const left = (target.scrollLeft + x) * ratio - x;
      const top = (target.scrollTop + y) * ratio - y;
      setZoom(next);
      requestAnimationFrame(() => {
        target.scrollLeft = left;
        target.scrollTop = top;
      });
    };
    target.addEventListener("wheel", wheel, { passive: false });
    return () => target.removeEventListener("wheel", wheel);
  }, [scale, stacked]);

  const handleReady = useCallback(() => {
    if (ready.current) return;
    ready.current = true;
    onReady();
  }, [onReady]);
  const handlePartial = useCallback(
    (index: number) =>
      setPartialSlides((previous) =>
        previous.has(index) ? previous : new Set([...previous, index]),
      ),
    [],
  );
  const selectSlide = (index: number, focus = false) => {
    const next = Math.max(0, Math.min(preview.slides.length - 1, index));
    setActive(next);
    setAnnotation(null);
    setAnnotationText("");
    if (viewport.current && !stacked) {
      viewport.current.scrollLeft = 0;
      viewport.current.scrollTop = 0;
    }
    if (focus)
      requestAnimationFrame(() => {
        const button = root.current?.querySelector<HTMLButtonElement>(
          `[data-slide-index="${next}"]`,
        );
        button?.scrollIntoView({ block: "nearest", inline: "nearest" });
        button?.focus({ preventScroll: true });
      });
  };
  const handleKeyDown = (event: KeyboardEvent) => {
    if (
      event.target instanceof HTMLInputElement ||
      event.target instanceof HTMLTextAreaElement ||
      event.target instanceof HTMLSelectElement
    )
      return;
    if (event.key === "Escape") {
      setAnnotation(null);
      setAnnotationMode(false);
      setRailOpen(false);
      return;
    }
    if (event.key === " " && event.target === viewport.current) {
      event.preventDefault();
      setSpaceDown(true);
      return;
    }
    if (event.ctrlKey || event.metaKey || event.altKey) return;
    let next: number | undefined;
    if (["ArrowRight", "ArrowDown", "PageDown"].includes(event.key)) next = active + 1;
    if (["ArrowLeft", "ArrowUp", "PageUp"].includes(event.key)) next = active - 1;
    if (event.key === "Home") next = 0;
    if (event.key === "End") next = preview.slides.length - 1;
    if (next !== undefined) {
      event.preventDefault();
      selectSlide(next, stacked || event.target !== viewport.current);
    }
  };
  const pointerDown = (event: PointerEvent<HTMLDivElement>) => {
    if (annotationMode && event.button === 0) {
      const bounds = slideSurface.current?.getBoundingClientRect();
      if (
        !bounds ||
        event.clientX < bounds.left ||
        event.clientX > bounds.right ||
        event.clientY < bounds.top ||
        event.clientY > bounds.bottom
      )
        return;
      setAnnotation({
        x: (event.clientX - bounds.left) / bounds.width,
        y: (event.clientY - bounds.top) / bounds.height,
      });
      setAnnotationText("");
      return;
    }
    if (event.button !== 1 && !(event.button === 0 && spaceDown)) return;
    event.preventDefault();
    const target = event.currentTarget;
    pointer.current = {
      id: event.pointerId,
      x: event.clientX,
      y: event.clientY,
      scrollLeft: target.scrollLeft,
      scrollTop: target.scrollTop,
    };
    target.setPointerCapture(event.pointerId);
  };

  return (
    <section
      className="presentation-reader flex min-h-0 flex-1 flex-col overflow-hidden bg-background text-foreground"
      data-pptx-reader="true"
    >
      <div className="flex h-11 shrink-0 items-center gap-2 px-3" data-testid="presentation-header">
        <span className="min-w-0 flex-1 truncate text-ui-lg" title={fileName}>
          {fileName.replace(/\.pptx$/i, "")}
        </span>
        {onAnnotate ? (
          <button
            type="button"
            className="presentation-toolbar-button"
            aria-label="Annotate slide"
            aria-pressed={annotationMode}
            onClick={() => {
              setAnnotationMode((value) => !value);
              setAnnotation(null);
            }}
          >
            <MessageCircleIcon className="size-4" />
          </button>
        ) : null}
        {!stacked ? <PresentationZoom zoom={zoom} fit={fit} onChange={setZoom} /> : null}
        <a
          className="presentation-toolbar-button"
          href={downloadUrl}
          download={fileName}
          aria-label="Download presentation"
        >
          <DownloadIcon className="size-4" />
        </a>
        <OpenInPicker
          openInTarget={openInTarget}
          labelMode="always"
          defaultEditor="system-default"
        />
      </div>
      {partialSlides.size > 0 ? (
        <div
          role="status"
          className="border-b border-border px-3 py-2 text-ui-sm text-muted-foreground"
        >
          Some elements could not be displayed.{" "}
          <a href={downloadUrl} download={fileName} className="underline">
            Download the presentation
          </a>{" "}
          to view the original.
        </div>
      ) : null}
      <div
        ref={root}
        className="relative min-h-0 flex-1 overflow-hidden"
        data-presentation-layout={stacked ? "stacked" : desktop ? "desktop" : "compact"}
        onKeyDown={handleKeyDown}
        onKeyUp={(event) => {
          if (event.key === " ") setSpaceDown(false);
        }}
        onBlur={() => setSpaceDown(false)}
      >
        {stacked ? (
          <div
            className="presentation-stacked-pages h-full overflow-auto"
            aria-label="Presentation slides"
          >
            {preview.slides.map((slide, index) => (
              <button
                key={index}
                type="button"
                data-slide-index={index}
                aria-label={`Slide ${index + 1}: ${slide.title}`}
                aria-current={active === index ? "page" : undefined}
                className={cn("presentation-stacked-page", annotationMode && "cursor-crosshair")}
                onClick={(event) => {
                  selectSlide(index);
                  if (annotationMode) {
                    const bounds = event.currentTarget.getBoundingClientRect();
                    setAnnotation({
                      x: event.detail === 0 ? 0.5 : (event.clientX - bounds.left) / bounds.width,
                      y: event.detail === 0 ? 0.5 : (event.clientY - bounds.top) / bounds.height,
                    });
                  }
                }}
              >
                <SlideImage
                  preview={preview}
                  index={index}
                  eager={index === 0}
                  onReady={handleReady}
                  onError={onError}
                  onPartial={handlePartial}
                />
              </button>
            ))}
          </div>
        ) : (
          <>
            <div
              ref={viewport}
              tabIndex={0}
              aria-label={`Slide ${active + 1} of ${preview.slides.length}: ${current.title}`}
              className={cn(
                "presentation-viewport h-full overflow-auto outline-none",
                annotationMode ? "cursor-crosshair" : spaceDown ? "cursor-grab" : "",
              )}
              style={{
                paddingLeft: desktop ? 190 : 48,
                paddingRight: 24,
                paddingBottom: showNotes ? 168 : 24,
                paddingTop: 24,
              }}
              onPointerDown={pointerDown}
              onPointerMove={(event) => {
                const start = pointer.current;
                if (!start || start.id !== event.pointerId) return;
                event.currentTarget.scrollLeft = start.scrollLeft - (event.clientX - start.x);
                event.currentTarget.scrollTop = start.scrollTop - (event.clientY - start.y);
              }}
              onPointerUp={() => {
                pointer.current = null;
              }}
              onPointerCancel={() => {
                pointer.current = null;
              }}
            >
              <div
                className="flex min-h-full min-w-full items-center justify-center"
                style={{ width: preview.width * scale, height: preview.height * scale }}
              >
                <div
                  ref={slideSurface}
                  className="presentation-main-slide relative shrink-0 bg-white shadow-sm"
                  style={{ width: preview.width * scale, height: preview.height * scale }}
                >
                  <SlideImage
                    key={active}
                    preview={preview}
                    index={active}
                    eager
                    onReady={handleReady}
                    onError={onError}
                    onPartial={handlePartial}
                  />
                  {annotation ? (
                    <span
                      className="absolute size-3 -translate-x-1/2 -translate-y-1/2 rounded-full border-2 border-white bg-blue-500 shadow"
                      style={{ left: `${annotation.x * 100}%`, top: `${annotation.y * 100}%` }}
                    />
                  ) : null}
                </div>
              </div>
            </div>
            <aside
              className={cn(
                "presentation-thumbnail-rail",
                desktop && "presentation-thumbnail-rail-desktop",
              )}
              style={{ bottom: showNotes ? 144 : 0 }}
              aria-label="Slide list"
              onMouseLeave={() => {
                if (
                  !root.current
                    ?.querySelector(".presentation-thumbnail-rail")
                    ?.contains(document.activeElement)
                )
                  setRailOpen(false);
              }}
            >
              {!desktop ? (
                <button
                  type="button"
                  aria-label="Show slide list"
                  aria-expanded={railOpen}
                  className="presentation-thumbnail-stack"
                  onMouseEnter={() => setRailOpen(true)}
                  onClick={() => setRailOpen((value) => !value)}
                >
                  {preview.slides.map((_, index) => (
                    <span key={index} data-active={active === index} />
                  ))}
                </button>
              ) : null}
              <div
                className={cn(
                  "presentation-thumbnail-panel",
                  !desktop && DISCLOSURE_FLOATING_PANEL_MOTION_CLASS,
                  !desktop && !railOpen && "pointer-events-none -translate-x-2 opacity-0",
                )}
                inert={!desktop && !railOpen}
                aria-hidden={!desktop && !railOpen}
                onFocusCapture={() => setRailOpen(true)}
                onBlurCapture={(event) => {
                  if (!event.currentTarget.contains(event.relatedTarget)) setRailOpen(false);
                }}
              >
                {preview.slides.map((slide, index) => (
                  <button
                    key={index}
                    type="button"
                    data-slide-index={index}
                    aria-label={`Slide ${index + 1}: ${slide.title}`}
                    aria-current={active === index ? "page" : undefined}
                    className="presentation-thumbnail"
                    onClick={() => selectSlide(index)}
                  >
                    <span className="presentation-thumbnail-number">{index + 1}</span>
                    <SlideImage preview={preview} index={index} onPartial={handlePartial} />
                  </button>
                ))}
              </div>
            </aside>
            {showNotes ? (
              <div className="presentation-notes" style={{ left: desktop ? 166 : 0 }}>
                <textarea aria-label="Speaker notes" readOnly value={current.notes} />
              </div>
            ) : null}
          </>
        )}
        {annotation && onAnnotate ? (
          <form
            className="presentation-annotation"
            onSubmit={(event) => {
              event.preventDefault();
              if (!annotationText.trim()) return;
              onAnnotate({
                kind: "presentation",
                slideNumber: active + 1,
                text: annotationText.trim(),
                anchor: annotation,
              });
              setAnnotation(null);
              setAnnotationText("");
              setAnnotationMode(false);
            }}
          >
            <div className="flex items-center justify-between gap-2 text-ui-sm text-muted-foreground">
              <span>Slide {active + 1}</span>
              <button
                type="button"
                aria-label="Close annotation"
                onClick={() => setAnnotation(null)}
              >
                <XIcon className="size-4" />
              </button>
            </div>
            <textarea
              aria-label="Annotation"
              placeholder="Ask for an edit…"
              autoFocus
              value={annotationText}
              onChange={(event) => setAnnotationText(event.target.value)}
              className="min-h-20 w-full resize-y bg-transparent py-2 text-ui-lg outline-none"
            />
            <button
              type="submit"
              disabled={!annotationText.trim()}
              className="rounded-md bg-primary px-3 py-1.5 text-ui-sm text-primary-foreground disabled:opacity-50"
            >
              Add to chat
            </button>
          </form>
        ) : null}
      </div>
    </section>
  );
}
