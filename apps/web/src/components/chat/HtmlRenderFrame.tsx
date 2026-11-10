// FILE: HtmlRenderFrame.tsx
// Purpose: An agent's `html_render` page inline in the thread.
// Layer: Chat UI
// Origin: Adapted from apps/web/src/components/chat/HtmlRenderFrame.tsx in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at 08a463e29976617134de01e9341f898bc881d0eb.
//   Moss loads the page from its attachments route (resolveHtmlRenderFrameUrl) instead of
//   T3's signed asset URLs. See THIRD_PARTY_NOTICES.md.

import {
  HTML_RENDER_COLUMN_WIDTH,
  htmlRenderFrameHeight,
  type HtmlRenderReference,
} from "@moss/shared/htmlRender";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { resolveHtmlRenderFrameUrl } from "~/lib/htmlRenderFrameUrl";
import { Maximize2 } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";

import type { ExpandedImagePreview } from "./ExpandedImagePreview";
import { HtmlRenderDocument } from "./HtmlRenderDocument";

/**
 * An agent's HTML render inline in the thread: the page itself on the thread's
 * own background, at its measured or the agent's height until the page reports
 * its own, which the frame then fits in full. Loading and failure hold the same
 * box so nothing below it moves.
 */
export function HtmlRenderFrame(props: {
  readonly htmlRender: HtmlRenderReference;
  readonly onOpen?: (htmlRender: HtmlRenderReference) => void;
  /** The thread's image viewer, for an image the reader clicks in the page. */
  readonly onImageExpand?: (preview: ExpandedImagePreview) => void;
}) {
  const { attachmentId, title } = props.htmlRender;
  const { format, t } = useTranslation();
  // The frame takes the page's height at its own width, read before first
  // paint so the reserved box is already the right size.
  const boxRef = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(HTML_RENDER_COLUMN_WIDTH);
  useLayoutEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    setWidth(box.clientWidth);
    const observer = new ResizeObserver(([entry]) => {
      if (entry) setWidth(entry.contentRect.width);
    });
    observer.observe(box);
    return () => observer.disconnect();
  }, []);
  // Client fonts can wrap a page taller than expected; a frame left short
  // would scroll inside the thread and take the reader's scroll.
  const [reported, setReported] = useState<{ attachmentId: string; height: number }>();
  const height = htmlRenderFrameHeight(props.htmlRender, width, reported?.height);
  // Signing a desktop frame URL is async; a null URL means the page cannot load. A
  // surface's newer page loads into this frame: the older page and its height hold the
  // box until the newer page's URL resolves and that page reports its own height.
  const [frame, setFrame] = useState<{ attachmentId: string; src: string | null }>();
  const failed = frame?.attachmentId === attachmentId && frame.src === null;
  const shownSrc = frame?.src ?? null;
  const shownAttachmentId = frame?.attachmentId ?? attachmentId;
  // Chromium does not always refresh a wrapper's CSS :hover while an iframe
  // owns the pointer. Retain the same hover/focus visual contract explicitly
  // at the wrapper boundary, without changing the page sandbox.
  const [isPointerOverFrame, setIsPointerOverFrame] = useState(false);
  useEffect(() => {
    let current = true;
    const settle = (src: string | null) => {
      if (current) setFrame({ attachmentId, src });
    };
    void resolveHtmlRenderFrameUrl(attachmentId).then(settle, () => settle(null));
    return () => {
      current = false;
    };
  }, [attachmentId]);
  return (
    <div
      ref={boxRef}
      className="group/html-render relative"
      style={{ height }}
      data-html-render-id={attachmentId}
      data-html-render-state={
        failed ? "unavailable" : reported?.attachmentId === attachmentId ? "ready" : "loading"
      }
      onPointerEnter={() => setIsPointerOverFrame(true)}
      onPointerLeave={() => setIsPointerOverFrame(false)}
    >
      {props.onOpen ? (
        // An inline document fills the wrapper exactly, leaving no parent
        // pixels to hover around its iframe. This one-pixel transparent edge
        // is a non-interactive hover entry point; it does not cover page
        // controls, alter sizing, or participate in the document sandbox.
        <div
          aria-hidden="true"
          className="absolute inset-x-0 top-0 z-10 h-px"
          onPointerEnter={() => setIsPointerOverFrame(true)}
        />
      ) : null}
      {failed ? (
        <p className="flex size-full items-center justify-center text-muted-foreground text-ui-xs">
          {format("chat.htmlRender.unavailable", { title })}
        </p>
      ) : shownSrc !== null ? (
        <>
          <HtmlRenderDocument
            // A document keeps its first URL, so a newer page gets a new document.
            key={shownSrc}
            src={shownSrc}
            title={title}
            className="block size-full"
            htmlRender
            onContentHeight={(contentHeight) =>
              setReported({ attachmentId: shownAttachmentId, height: contentHeight })
            }
            {...(props.onImageExpand ? { onImageExpand: props.onImageExpand } : {})}
          />
          {props.onOpen ? (
            <div
              className={`pointer-coarse:opacity-100 absolute end-2 top-2 transition-opacity duration-150 focus-within:opacity-100 group-hover/html-render:opacity-100 ${
                isPointerOverFrame ? "opacity-100" : "opacity-0"
              }`}
            >
              <Tooltip>
                <TooltipTrigger
                  render={
                    <Button
                      aria-label={t("chat.visualReply.openInPanel")}
                      size="icon-xs"
                      variant="glass"
                      onClick={() => props.onOpen?.(props.htmlRender)}
                    />
                  }
                >
                  <Maximize2 className="size-4" />
                </TooltipTrigger>
                <TooltipPopup side="left">{t("chat.visualReply.openInPanel")}</TooltipPopup>
              </Tooltip>
            </div>
          ) : null}
        </>
      ) : null}
    </div>
  );
}
