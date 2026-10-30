// FILE: HtmlRenderPreviewPane.tsx
// Purpose: Right-dock preview for a visual reply, with zoom and the attachment-style source and
//   save controls.
// Layer: Chat right-dock UI
// Origin: The zoom steps follow HtmlRenderDialog in T3 Code (https://github.com/pingdotgg/t3code,
//   MIT) at 08a463e29976617134de01e9341f898bc881d0eb (PR #17561); Moss shows visual replies in
//   its right dock instead of a full-screen dialog. See THIRD_PARTY_NOTICES.md.

import { htmlRenderFileName } from "@synara/shared/htmlRender";
import { useCallback, useEffect, useState } from "react";

import { resolveHtmlRenderFrameUrl } from "~/lib/htmlRenderFrameUrl";
import { resolveInlineVisualizationFrameUrl } from "~/lib/inlineVisualizationFrameUrl";
import { CodeIcon, DownloadIcon, EyeOpenIcon, MinusIcon, PlusIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";
import type { RightDockHtmlDocument } from "~/rightDockStore.logic";

import { Button } from "../ui/button";

import { ExpandedImageOverlay } from "./ExpandedImageOverlay";
import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";
import { useExpandedImagePreview } from "./useExpandedImagePreview";

function visualReplyDownloadName(document: RightDockHtmlDocument): string {
  return htmlRenderFileName(document.title);
}

const MIN_ZOOM = 0.5;
const MAX_ZOOM = 2;
const ZOOM_STEP = 0.25;

/**
 * Attachment-style panel preview. The persisted pane contains neither a signed
 * URL nor source bytes: both are rebuilt on demand, so a restored dock cannot
 * leak a capability and a long-idle panel simply receives a fresh URL.
 */
export function HtmlRenderPreviewPane(props: {
  readonly threadId: string;
  readonly document: RightDockHtmlDocument;
}) {
  const { format, t } = useTranslation();
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();

  const resolveUrl = useCallback(
    (forceRefresh = false) =>
      props.document.kind === "html-render"
        ? resolveHtmlRenderFrameUrl(props.document.attachmentId, Date.now(), { forceRefresh })
        : resolveInlineVisualizationFrameUrl({
            threadId: props.threadId,
            path: props.document.path,
          }),
    [props.document, props.threadId],
  );

  useEffect(() => {
    let active = true;
    setSrc(undefined);
    setSource(null);
    setShowSource(false);
    setError(null);
    setZoom(1);
    void resolveUrl(true).then(
      (url) => {
        if (active) setSrc(url);
      },
      () => {
        if (active) setSrc(null);
      },
    );
    return () => {
      active = false;
    };
  }, [resolveUrl]);

  const loadSource = useCallback(async () => {
    setLoadingSource(true);
    setError(null);
    try {
      // Re-mint at the point of use: a visible document may have been open for
      // minutes before the reader asks for source or a download.
      const url = await resolveUrl(true);
      if (!url) throw new Error("The visual reply is unavailable.");
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("The visual reply could not be loaded.");
      setSource(await response.text());
      setShowSource(true);
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "The visual reply could not be loaded.");
    } finally {
      setLoadingSource(false);
    }
  }, [resolveUrl]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const url = await resolveUrl(true);
      if (!url) throw new Error("The visual reply is unavailable.");
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("The visual reply could not be loaded.");
      const blob = await response.blob();
      const downloadUrl = URL.createObjectURL(blob);
      try {
        const anchor = document.createElement("a");
        anchor.href = downloadUrl;
        anchor.download = visualReplyDownloadName(props.document);
        anchor.click();
      } finally {
        setTimeout(() => URL.revokeObjectURL(downloadUrl), 30_000);
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : "Could not save the visual reply.");
    } finally {
      setSaving(false);
    }
  }, [props.document, resolveUrl]);

  const title = props.document.title;
  const unavailable = src === null;
  const showsPage = !showSource && typeof src === "string";
  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden bg-background">
      <header
        className="flex shrink-0 items-center gap-1 border-border/70 border-b px-2 py-1.5"
        data-html-render-preview-header
      >
        <span className="min-w-0 flex-1 truncate px-1 text-ui-xs font-medium" title={title}>
          {title}
        </span>
        {showsPage ? (
          <div className="flex shrink-0 items-center" data-html-render-zoom-controls>
            <Button
              aria-label={t("chat.visualReply.zoomOut")}
              disabled={zoom <= MIN_ZOOM}
              size="icon-xs"
              title={t("chat.visualReply.zoomOut")}
              variant="ghost"
              onClick={() => setZoom((value) => Math.max(MIN_ZOOM, value - ZOOM_STEP))}
            >
              <MinusIcon />
            </Button>
            <Button
              aria-label={t("chat.visualReply.resetZoom")}
              className="min-w-11 tabular-nums"
              size="xs"
              title={t("chat.visualReply.resetZoom")}
              variant="ghost"
              onClick={() => setZoom(1)}
            >
              {Math.round(zoom * 100)}%
            </Button>
            <Button
              aria-label={t("chat.visualReply.zoomIn")}
              disabled={zoom >= MAX_ZOOM}
              size="icon-xs"
              title={t("chat.visualReply.zoomIn")}
              variant="ghost"
              onClick={() => setZoom((value) => Math.min(MAX_ZOOM, value + ZOOM_STEP))}
            >
              <PlusIcon />
            </Button>
          </div>
        ) : null}
        <Button
          aria-label={
            showSource ? t("chat.visualReply.showRendered") : t("chat.visualReply.showSource")
          }
          disabled={loadingSource}
          size="icon-xs"
          title={showSource ? t("chat.visualReply.showRendered") : t("chat.visualReply.showSource")}
          variant="ghost"
          onClick={() => {
            if (showSource) setShowSource(false);
            else if (source !== null) setShowSource(true);
            else void loadSource();
          }}
        >
          {showSource ? <EyeOpenIcon /> : <CodeIcon />}
        </Button>
        <Button
          aria-label={t("chat.visualReply.save")}
          disabled={saving}
          size="icon-xs"
          title={saving ? t("chat.visualReply.preparingSave") : t("chat.visualReply.save")}
          variant="ghost"
          onClick={() => void save()}
        >
          <DownloadIcon />
        </Button>
      </header>
      {error ? (
        <p className="shrink-0 border-border/70 border-b px-3 py-2 text-ui-xs text-destructive">
          {error}
        </p>
      ) : null}
      {showSource && source !== null ? (
        <pre
          className="min-h-0 flex-1 overflow-auto whitespace-pre-wrap break-words p-3 font-mono text-ui-xs"
          data-html-render-source
        >
          {source}
        </pre>
      ) : unavailable ? (
        <p className="flex min-h-0 flex-1 items-center justify-center p-4 text-center text-ui-xs text-muted-foreground">
          {format("chat.htmlRender.unavailable", { title })}
        </p>
      ) : src === undefined ? (
        <div
          className="min-h-0 flex-1 animate-pulse bg-muted/20"
          data-html-render-preview-loading
        />
      ) : (
        <div className="relative min-h-0 flex-1 overflow-hidden" data-html-render-zoom={zoom}>
          {/* Zoom works like a browser's: the page lays out at the pane's width divided by
              the zoom, then scales back to fill the pane, so zooming out shows more of it. */}
          <div
            className="absolute top-0 left-0 origin-top-left"
            style={{
              width: `${100 / zoom}%`,
              height: `${100 / zoom}%`,
              ...(zoom === 1 ? {} : { transform: `scale(${zoom})` }),
            }}
          >
            <SandboxedHtmlDocument
              src={src}
              title={title}
              className="block size-full"
              // This is the T3 `HtmlRenderDocument` path, not the generic HTML
              // attachment preview. Visual replies may run scripts and submit
              // forms, but must not open popup contexts from the dock.
              sandbox="allow-scripts allow-forms"
              // A fixed overlay inside the scaled box would scale with it.
              onImageExpand={setExpandedImage}
            />
          </div>
        </div>
      )}
      <ExpandedImageOverlay
        expandedImage={expandedImage}
        onClose={closeExpandedImage}
        onNavigate={navigateExpandedImage}
      />
    </div>
  );
}
