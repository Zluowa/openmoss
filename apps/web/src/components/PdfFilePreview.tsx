// PDF preview session: continuous canvas/text/link pages, artifact toolbar and
// contextual annotations. A URL/revision change creates a fresh callback scope.
import { useCallback, useEffect, useEffectEvent, useRef, useState } from "react";
import { basenameOfPath } from "~/file-icons";
import { buildLocalImageUrl } from "~/lib/localImageUrls";
import type { PdfPreviewAnnotation } from "~/lib/pdf/pdfAnnotations";
import { useContainerSize } from "~/lib/pdf/useContainerSize";
import { usePdfDocument } from "~/lib/pdf/usePdfDocument";
import { usePdfPageNavigation } from "~/lib/pdf/usePdfPageNavigation";
import { usePdfZoomController } from "~/lib/pdf/usePdfZoomController";
import { cn } from "~/lib/utils";
import { PdfPageView } from "./pdf/PdfPageView";
import { PdfViewerToolbar } from "./pdf/PdfViewerToolbar";

export type { PdfPreviewAnnotation } from "~/lib/pdf/pdfAnnotations";

interface PdfFilePreviewProps {
  filePath: string;
  cwd: string | null | undefined;
  previewGrant?: string | null | undefined;
  cacheKey?: string | number | undefined;
  openInTarget: string | null;
  className?: string;
  onReload?: (() => void) | undefined;
  onPreviewReady?: (() => void) | undefined;
  onPreviewError?: (() => void) | undefined;
  onDocumentReady?: (() => void) | undefined;
  onAnnotate?: ((annotation: PdfPreviewAnnotation) => void) | undefined;
}

export function PdfFilePreview(props: PdfFilePreviewProps) {
  const previewUrl = buildLocalImageUrl({
    src: props.filePath,
    cwd: props.cwd ?? undefined,
    grant: props.previewGrant,
    cacheKey: props.cacheKey,
  });
  return <PdfPreviewSession key={previewUrl} {...props} previewUrl={previewUrl} />;
}

function PdfPreviewSession(props: PdfFilePreviewProps & { previewUrl: string }) {
  const doc = usePdfDocument(props.previewUrl);
  const [painted, setPainted] = useState(false);
  const [paintFailed, setPaintFailed] = useState(false);
  const [annotationMode, setAnnotationMode] = useState(false);
  const [scrollRoot, setScrollRoot] = useState<HTMLDivElement | null>(null);
  const containerSize = useContainerSize(scrollRoot);
  const notifications = useRef({ ready: false, error: false, document: false });
  const notifyReady = useEffectEvent(() => props.onPreviewReady?.());
  const notifyError = useEffectEvent(() => props.onPreviewError?.());
  const notifyDocument = useEffectEvent(() => props.onDocumentReady?.());
  useEffect(() => {
    if (doc.status === "ready" && !notifications.current.document) {
      notifications.current.document = true;
      notifyDocument();
    }
    if (painted && !notifications.current.ready) {
      notifications.current.ready = true;
      notifyReady();
    }
    if ((doc.status === "error" || paintFailed) && !notifications.current.error) {
      notifications.current.error = true;
      notifyError();
    }
  }, [doc.status, painted, paintFailed]);
  const onFirstPageReady = useCallback(() => setPainted(true), []);
  const onPageError = useCallback(() => setPaintFailed(true), []);

  useEffect(() => {
    if (!annotationMode) return;
    const onEscape = (event: KeyboardEvent) => {
      if (
        event.defaultPrevented ||
        event.key !== "Escape" ||
        document.querySelector('[role="dialog"][aria-label="PDF annotation"]')
      )
        return;
      event.preventDefault();
      setAnnotationMode(false);
    };
    window.addEventListener("keydown", onEscape);
    return () => window.removeEventListener("keydown", onEscape);
  }, [annotationMode]);

  const navigation = usePdfPageNavigation({
    scrollRoot,
    numPages: doc.numPages,
    enabled: doc.status === "ready",
    resetKey: props.previewUrl,
  });
  const zoom = usePdfZoomController({
    firstPageSize: doc.firstPageSize,
    containerSize,
    scrollRoot,
    resetKey: props.previewUrl,
  });
  const outerClassName = cn(
    "flex h-full min-h-0 min-w-0 flex-1 flex-col bg-[var(--color-background-surface)]",
    props.className,
  );

  if (doc.status === "error") {
    return (
      <div className={outerClassName}>
        <div
          className="flex min-h-0 flex-1 flex-col items-center justify-center gap-2 px-4 text-center text-ui-lg text-muted-foreground"
          role="alert"
        >
          <p>Couldn’t load this preview</p>
          {props.onReload ? (
            <button
              type="button"
              className="rounded-md px-2 py-1 text-ui-sm hover:bg-foreground/8"
              onClick={props.onReload}
            >
              Reload file from disk
            </button>
          ) : null}
        </div>
      </div>
    );
  }

  if (doc.status !== "ready" || !doc.document || !doc.firstPageSize) {
    return (
      <div className={outerClassName}>
        <PdfPreparingPreview />
      </div>
    );
  }
  const readyDocument = doc.document;
  const firstPageSize = doc.firstPageSize;
  return (
    <div className={outerClassName} data-file-preview="pdf">
      <PdfViewerToolbar
        fileName={basenameOfPath(props.filePath)}
        currentPage={navigation.currentPage}
        numPages={doc.numPages}
        onJumpToPage={navigation.jumpToPage}
        zoomMode={zoom.zoomMode}
        scale={zoom.scale}
        onZoomIn={zoom.onZoomIn}
        onZoomOut={zoom.onZoomOut}
        onSetScale={zoom.onSetScale}
        onFitWidth={zoom.onFitWidth}
        onFitPage={zoom.onFitPage}
        openInTarget={props.openInTarget}
        onReload={props.onReload}
        annotationMode={annotationMode}
        onToggleAnnotations={
          props.onAnnotate ? () => setAnnotationMode((active) => !active) : undefined
        }
      />
      <div className="relative flex min-h-0 flex-1">
        <div
          ref={setScrollRoot}
          className="min-h-0 min-w-0 flex-1 overflow-auto"
          data-pdf-scroll="true"
          style={{ overflowAnchor: "none" }}
        >
          <div
            className="flex min-h-full w-max min-w-full flex-col items-center gap-6 px-6 pt-6"
            style={{ paddingBottom: "var(--right-panel-composer-overlay-reserve, 1.5rem)" }}
          >
            {containerSize
              ? Array.from({ length: doc.numPages }, (_, index) => (
                  <PdfPageView
                    key={index + 1}
                    document={readyDocument}
                    pageNumber={index + 1}
                    pageCount={doc.numPages}
                    scale={zoom.scale}
                    intrinsicSize={firstPageSize}
                    scrollRoot={scrollRoot}
                    registerElement={navigation.registerElement}
                    onJumpToPage={navigation.jumpToPage}
                    onRenderReady={index === 0 ? onFirstPageReady : undefined}
                    onRenderError={onPageError}
                    annotationMode={annotationMode}
                    onAnnotate={props.onAnnotate}
                  />
                ))
              : null}
          </div>
        </div>
        {!painted && !paintFailed ? (
          <div className="pointer-events-none absolute inset-0 flex bg-[var(--color-background-surface)]">
            <PdfPreparingPreview />
          </div>
        ) : null}
      </div>
    </div>
  );
}

function PdfPreparingPreview() {
  return (
    <div
      className="flex min-h-0 flex-1 items-center justify-center text-ui-lg text-muted-foreground"
      role="status"
      aria-label="Loading PDF..."
    >
      <span className="animate-pulse">Preparing preview…</span>
    </div>
  );
}
