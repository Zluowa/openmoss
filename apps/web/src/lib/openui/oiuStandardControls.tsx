// @ts-nocheck
// FILE: oiuStandardControls.tsx
// Purpose: The overlay pieces of the standard catalog, drawn with Moss's own Base UI
//   primitives: the Tooltip and Popover overlays, the Citation hover card, and the
//   ImageGrid full-screen viewer with arrows between images.
// Layer: Chat UI support (a lazy chunk that oiuStandardViews.tsx loads on first use, so
//   Node, the validation tests and the reference generator never import the primitives)
// Origin: Which overlays exist follows Tooltip, Popover, Citation and the lightbox of the
//   standard generative-UI catalog in CopilotKit (https://github.com/CopilotKit/CopilotKit, MIT) at
//   180a2f0. See THIRD_PARTY_NOTICES.md.

import { useCallback, useEffect, type ReactNode } from "react";
import { Button } from "~/components/ui/button";
import { Dialog, DialogPopup, DialogTitle } from "~/components/ui/dialog";
import { Popover, PopoverPopup, PopoverTitle, PopoverTrigger } from "~/components/ui/popover";
import { PreviewCard, PreviewCardPopup, PreviewCardTrigger } from "~/components/ui/preview-card";
import { Tooltip, TooltipPopup, TooltipTrigger } from "~/components/ui/tooltip";
import { ChevronLeftIcon, ChevronRightIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

/**
 * A dotted-underlined term with Moss's tooltip. With a title (DefinedText passes the term),
 * the tooltip names the term above its definition.
 */
export function TooltipControl({
  trigger,
  content,
  title,
}: {
  trigger: ReactNode;
  content: string;
  title?: string;
}) {
  return (
    <Tooltip>
      <TooltipTrigger
        delay={300}
        render={
          <span
            tabIndex={0}
            className="cursor-help rounded-inline underline decoration-muted-foreground/45 decoration-dotted decoration-1 underline-offset-[0.28em] transition-[text-decoration-color] hover:decoration-muted-foreground focus-visible:outline-2 focus-visible:outline-ring data-[popup-open]:decoration-muted-foreground"
          />
        }
      >
        {trigger}
      </TooltipTrigger>
      <TooltipPopup className="max-w-72">
        {title ? (
          <span className="flex flex-col">
            <span className="font-medium">{title}</span>
            <span className="text-muted-foreground">{content}</span>
          </span>
        ) : (
          content
        )}
      </TooltipPopup>
    </Tooltip>
  );
}

export function PopoverControl({
  trigger,
  title,
  disabled,
  children,
}: {
  trigger: string;
  title?: string;
  disabled: boolean;
  children: ReactNode;
}) {
  return (
    <Popover>
      <PopoverTrigger
        disabled={disabled}
        render={<Button size="sm" variant="outline" className="w-fit" />}
      >
        {trigger}
      </PopoverTrigger>
      <PopoverPopup align="start" className="max-w-80">
        <div className="flex min-w-0 flex-col gap-2 text-ui text-foreground">
          {title ? <PopoverTitle className="text-ui font-medium">{title}</PopoverTitle> : null}
          {children}
        </div>
      </PopoverPopup>
    </Popover>
  );
}

/**
 * A citation chip opens a source card after a short pause (Claude's source cards are about
 * 320px wide); the chip itself links to the source when it has one.
 */
export function CitationControl({
  marker,
  url,
  card,
  className,
}: {
  marker: ReactNode;
  url: string | null;
  card: ReactNode;
  className: string;
}) {
  return (
    <PreviewCard>
      <PreviewCardTrigger
        delay={300}
        closeDelay={120}
        render={
          url ? (
            <a href={url} target="_blank" rel="noopener noreferrer" className={className} />
          ) : (
            <span tabIndex={0} className={className} />
          )
        }
      >
        {marker}
      </PreviewCardTrigger>
      <PreviewCardPopup side="top" align="center" sideOffset={6} className="w-80 p-3">
        {card}
      </PreviewCardPopup>
    </PreviewCard>
  );
}

type LightboxImage = { src: string; alt?: string; caption?: string };

/** Full-screen viewer for one ImageGrid; arrow keys and buttons move between images. */
export function LightboxControl({
  images,
  index,
  onIndexChange,
}: {
  images: LightboxImage[];
  index: number | null;
  onIndexChange: (index: number | null) => void;
}) {
  const { t, format } = useTranslation();
  const count = images.length;
  const open = index !== null && count > 0;
  const current = open ? images[Math.min(index, count - 1)] : null;
  const step = useCallback(
    (delta: number) => {
      if (index === null || count < 2) return;
      onIndexChange((index + delta + count) % count);
    },
    [count, index, onIndexChange],
  );
  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "ArrowLeft") step(-1);
      if (event.key === "ArrowRight") step(1);
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, step]);
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? null : onIndexChange(null))}>
      <DialogPopup className="max-w-[min(92vw,64rem)] gap-3 p-3" bottomStickOnMobile={false}>
        {current ? (
          <>
            <DialogTitle className="sr-only">
              {current.alt ||
                current.caption ||
                format("chat.visualReply.standard.imagePosition", {
                  index: String(index + 1),
                  count: String(count),
                })}
            </DialogTitle>
            <img
              src={current.src}
              alt={current.alt ?? ""}
              className="max-h-[78vh] w-full rounded-card object-contain"
            />
            <div className="flex min-w-0 items-center gap-2">
              <span className="min-w-0 flex-1 truncate text-ui-sm text-muted-foreground">
                {current.caption ?? current.alt ?? ""}
              </span>
              {count > 1 ? (
                <>
                  <span className="text-ui-sm tabular-nums text-muted-foreground">
                    {format("chat.visualReply.standard.imagePosition", {
                      index: String(index + 1),
                      count: String(count),
                    })}
                  </span>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("chat.visualReply.standard.previousImage")}
                    onClick={() => step(-1)}
                  >
                    <ChevronLeftIcon />
                  </Button>
                  <Button
                    size="icon-sm"
                    variant="ghost"
                    aria-label={t("chat.visualReply.standard.nextImage")}
                    onClick={() => step(1)}
                  >
                    <ChevronRightIcon />
                  </Button>
                </>
              ) : null}
            </div>
          </>
        ) : null}
      </DialogPopup>
    </Dialog>
  );
}
