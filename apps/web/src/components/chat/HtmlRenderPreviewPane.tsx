// FILE: HtmlRenderPreviewPane.tsx
// Purpose: Right-dock preview for a visual reply, with zoom and the attachment-style source and
//   save controls.
// Layer: Chat right-dock UI
// Origin: The zoom steps follow HtmlRenderDialog in T3 Code (https://github.com/pingdotgg/t3code,
//   MIT) at 08a463e29976617134de01e9341f898bc881d0eb (PR #17561); Moss shows visual replies in
//   its right dock instead of a full-screen dialog. See THIRD_PARTY_NOTICES.md.

import { htmlRenderFileName } from "@moss/shared/htmlRender";
import { useNavigate } from "@tanstack/react-router";
import { useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { useResidentRuntime } from "~/lib/dockRuntimeResidency";
import { htmlDocumentSourceUrlResolver } from "~/lib/htmlDocumentSource";
import { resolveHtmlRenderFrameUrl } from "~/lib/htmlRenderFrameUrl";
import { resolveInlineVisualizationFrameUrl } from "~/lib/inlineVisualizationFrameUrl";
import {
  AppsIcon,
  ChevronDownIcon,
  CodeIcon,
  DownloadIcon,
  EyeOpenIcon,
  MinusIcon,
  PageCommentIcon,
  PlusIcon,
} from "~/lib/icons";
import { useIsSharedViewer } from "~/lib/sharedViewer";
import { cn } from "~/lib/utils";
import { VisualFollowUpContext, visualFollowUpForThread } from "~/lib/visualFollowUp";
import { useTranslation } from "~/localization";
import type { RightDockHtmlDocument } from "~/rightDockStore.logic";

import { usePageComments } from "../../pageCommentsStore";
import { promoteHtmlToPageApp } from "../pageApps/promoteHtmlToPageApp";
import { Button } from "../ui/button";
import { Menu, MenuItem, MenuTrigger } from "../ui/menu";

import { ComposerPickerMenuPopup } from "./ComposerPickerMenuPopup";
import { PageCommentsLayer } from "./pageComments/PageComments";

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
  /** Controls the surrounding surface adds at the header's end (the guest page's close). */
  readonly headerEnd?: ReactNode;
  /**
   * In the side panel: the pane's residency key and whether it is shown. The page then follows
   * the side panel's shared residency policy (unloaded while hidden long enough, loaded again
   * when shown). Without it the page stays loaded for as long as the pane is mounted.
   */
  readonly residency?: { readonly key: string; readonly visible: boolean };
}) {
  const { format, t } = useTranslation();
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [source, setSource] = useState<string | null>(null);
  const [showSource, setShowSource] = useState(false);
  const [loadingSource, setLoadingSource] = useState(false);
  const [saving, setSaving] = useState(false);
  // A guest reads the owner's conversation: no 资料空间 to keep a page in, no comments to the
  // owner's agent, and the guest's own composer takes a page's follow-up.
  const sharedViewer = useIsSharedViewer();
  const surfaceFollowUp = useContext(VisualFollowUpContext);
  const [error, setError] = useState<string | null>(null);
  const [zoom, setZoom] = useState(1);
  const { expandedImage, setExpandedImage, closeExpandedImage, navigateExpandedImage } =
    useExpandedImagePreview();
  // Comments are for visual replies (html_render pages), which carry the comment bridge.
  const commentsAvailable = props.document.kind === "html-render" && !sharedViewer;
  const pageKey =
    props.document.kind === "html-render" ? `html-render:${props.document.attachmentId}` : "";
  const comments = usePageComments(pageKey);
  const hasUnreadComments = comments.some((comment) => !comment.read);
  const [commentMode, setCommentMode] = useState(false);
  // The page is reloaded from its attachment, so nothing needs saving first. While the reader is
  // commenting it counts as in use and stays loaded.
  const runtime = useResidentRuntime({
    active: props.residency !== undefined,
    key: props.residency?.key ?? "",
    owner: props.threadId,
    runtimeClass: "dockFrame",
    visible: props.residency?.visible ?? true,
    pinned: commentMode,
    suspend: async () => true,
  });
  const [commentsPanelOpen, setCommentsPanelOpen] = useState(false);
  const [commentMarkersVisible, setCommentMarkersVisible] = useState(true);
  const [commentsMenuOpen, setCommentsMenuOpen] = useState(false);
  const [frame, setFrame] = useState<HTMLIFrameElement | null>(null);
  const [frameGeneration, setFrameGeneration] = useState(0);
  // The dock sits outside the thread view, so it names its own thread: a page's
  // follow-up lands in the composer of the thread this document came from.
  const sendFollowUp = useMemo(
    () => (sharedViewer ? surfaceFollowUp : visualFollowUpForThread(props.threadId)),
    [props.threadId, sharedViewer, surfaceFollowUp],
  );

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

  // A pane only ever changes document to a newer page of its surface, which keeps the
  // reader's zoom and shows the older page until the newer one's URL resolves.
  // Unloaded while hidden: mint a fresh URL when it is shown again (the old one may have expired).
  const loaded = runtime.loaded;
  useEffect(() => {
    if (!loaded) return;
    let active = true;
    setSource(null);
    setShowSource(false);
    setError(null);
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
  }, [resolveUrl, loaded]);

  // The document's own bytes: the frame's URL for the owner, the share's `file` route for a guest.
  const resolveSourceUrl = useCallback(async () => {
    const sourceResolver = htmlDocumentSourceUrlResolver();
    if (sourceResolver !== null) return sourceResolver(props.document);
    return resolveUrl(true);
  }, [props.document, resolveUrl]);

  const loadSource = useCallback(async () => {
    setLoadingSource(true);
    setError(null);
    try {
      // Re-mint at the point of use: a visible document may have been open for
      // minutes before the reader asks for source or a download.
      const url = await resolveSourceUrl();
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
  }, [resolveSourceUrl]);

  const save = useCallback(async () => {
    setSaving(true);
    setError(null);
    try {
      const url = await resolveSourceUrl();
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
  }, [props.document, resolveSourceUrl]);

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
        {showsPage && commentsAvailable ? (
          <div className="flex shrink-0 items-center" data-page-comments-control="">
            <Button
              aria-label={commentMode ? "Leave comment mode" : "Comment on the page"}
              aria-pressed={commentMode}
              size="icon-xs"
              title={commentMode ? "Leave comment mode (Esc)" : "Comment on the page"}
              variant="ghost"
              className={cn(
                "relative rounded-e-none",
                commentMode && "bg-[color-mix(in_srgb,var(--foreground)_8%,transparent)]",
              )}
              data-page-comments-toggle=""
              onClick={() => {
                setCommentMode((on) => !on);
                setCommentsPanelOpen((open) => (commentMode ? false : open));
              }}
            >
              <PageCommentIcon />
              {hasUnreadComments ? (
                <span
                  aria-hidden
                  data-page-comments-unread=""
                  className="absolute top-1 right-1 size-1.5 rounded-full bg-[var(--color-text-accent)] ring-1 ring-background"
                />
              ) : null}
            </Button>
            <Menu modal={false} open={commentsMenuOpen} onOpenChange={setCommentsMenuOpen}>
              <MenuTrigger
                render={
                  <Button
                    aria-label="Comment options"
                    title="Comment options"
                    size="icon-xs"
                    variant="ghost"
                    className="w-3.5 rounded-s-none text-muted-foreground [&_[data-slot=central-icon]]:size-3"
                  >
                    <ChevronDownIcon />
                  </Button>
                }
              />
              <ComposerPickerMenuPopup align="end" side="bottom">
                <MenuItem
                  data-page-comments-menu="all"
                  onClick={() => setCommentsPanelOpen((open) => !open)}
                >
                  {commentsPanelOpen ? "Hide all comments" : "All comments"}
                </MenuItem>
                <MenuItem
                  data-page-comments-menu="markers"
                  onClick={() => setCommentMarkersVisible((visible) => !visible)}
                >
                  {commentMarkersVisible ? "Hide comment markers" : "Show comment markers"}
                </MenuItem>
              </ComposerPickerMenuPopup>
            </Menu>
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
        {sharedViewer ? null : (
          <PromoteToPageAppButton
            threadId={props.threadId}
            title={title}
            disabled={unavailable}
            resolveSourceUrl={resolveSourceUrl}
            onError={setError}
          />
        )}
        {props.headerEnd}
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
      ) : src === undefined || !loaded ? (
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
            <VisualFollowUpContext.Provider value={sendFollowUp}>
              <SandboxedHtmlDocument
                // A document keeps its first URL, so a newer page gets a new document.
                key={src}
                src={src}
                title={title}
                className="block size-full"
                // This is the T3 `HtmlRenderDocument` path, not the generic HTML
                // attachment preview. Visual replies may run scripts and submit
                // forms, but must not open popup contexts from the dock.
                sandbox="allow-scripts allow-forms"
                htmlRender={props.document.kind === "html-render"}
                // A fixed overlay inside the scaled box would scale with it.
                onImageExpand={setExpandedImage}
                onFrame={setFrame}
                onLoad={() => setFrameGeneration((generation) => generation + 1)}
              />
            </VisualFollowUpContext.Provider>
          </div>
          {commentsAvailable ? (
            // Outside the scaled box, so pins and cards keep their size at any zoom.
            <PageCommentsLayer
              frame={frame}
              frameGeneration={frameGeneration}
              threadId={props.threadId}
              pageKey={pageKey}
              pageTitle={title}
              zoom={zoom}
              commentMode={commentMode}
              onCommentModeChange={setCommentMode}
              panelOpen={commentsPanelOpen}
              onPanelOpenChange={setCommentsPanelOpen}
              markersVisible={commentMarkersVisible}
            />
          ) : null}
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

/** Keeps the page in 资料空间 as an 应用页 the user can reopen, version and share. */
function PromoteToPageAppButton(props: {
  readonly threadId: string;
  readonly title: string;
  readonly disabled: boolean;
  readonly resolveSourceUrl: () => Promise<string | null>;
  readonly onError: (message: string | null) => void;
}) {
  const navigate = useNavigate();
  const [promoting, setPromoting] = useState(false);
  const { resolveSourceUrl, onError, title, threadId } = props;
  const promote = useCallback(async () => {
    setPromoting(true);
    onError(null);
    try {
      const url = await resolveSourceUrl();
      if (!url) throw new Error("The visual reply is unavailable.");
      const response = await fetch(url, { credentials: "include" });
      if (!response.ok) throw new Error("The visual reply could not be loaded.");
      const app = await promoteHtmlToPageApp({
        html: await response.text(),
        title,
        threadId,
      });
      void navigate({ to: "/apps/$appId", params: { appId: app.id } });
    } catch (cause) {
      onError(cause instanceof Error ? cause.message : "无法存为应用页。");
    } finally {
      setPromoting(false);
    }
  }, [navigate, onError, resolveSourceUrl, threadId, title]);
  return (
    <Button
      aria-label="存为应用页"
      disabled={promoting || props.disabled}
      size="icon-xs"
      title="存为应用页"
      variant="ghost"
      onClick={() => void promote()}
    >
      <AppsIcon />
    </Button>
  );
}
