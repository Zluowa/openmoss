// FILE: InlineVisualizationFrame.tsx
// Purpose: Render a validated Codex visualization marker through the shared sandboxed document path.
// Layer: Chat UI

import { useEffect, useState } from "react";

import type { InlineVisualizationDirective } from "~/lib/inlineVisualizationDirective";
import { resolveInlineVisualizationFrameUrl } from "~/lib/inlineVisualizationFrameUrl";
import { Maximize2 } from "~/lib/icons";
import { useTranslation } from "~/localization";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import { DisclosureRegion } from "../ui/DisclosureRegion";

import { SandboxedHtmlDocument } from "./SandboxedHtmlDocument";

// T3's inline visual frame starts with `group/html-render relative`: it is a
// document in the transcript, not a bordered card. Keep the shared chrome
// borderless while retaining Moss's size constraints below.
export const INLINE_VISUALIZATION_FRAME_CLASS = "group/html-render relative my-2 overflow-hidden";

export function InlineVisualizationFrame(props: {
  readonly threadId: string | undefined;
  readonly directive: InlineVisualizationDirective;
  readonly onOpen?: (directive: InlineVisualizationDirective) => void;
}) {
  const { t } = useTranslation();
  const [src, setSrc] = useState<string | null | undefined>(undefined);
  const [showSource, setShowSource] = useState(false);
  // An iframe owns pointer events over its document in Chromium, so CSS-only
  // ancestor :hover is not reliably refreshed while the pointer is over a
  // rendered visualization. Track the wrapper boundary as well: this keeps
  // the T3-style hover affordance reachable without touching the iframe's
  // sandbox or stealing page interaction.
  const [isPointerOverFrame, setIsPointerOverFrame] = useState(false);
  useEffect(() => {
    let active = true;
    void resolveInlineVisualizationFrameUrl({
      threadId: props.threadId,
      path: props.directive.path,
    }).then(
      (url) => active && setSrc(url),
      () => active && setSrc(null),
    );
    return () => {
      active = false;
    };
  }, [props.directive.path, props.threadId]);
  const unavailable = src === null || !props.directive.path || !props.threadId;
  const title = props.directive.title ?? "Visualization";
  if (unavailable) {
    return (
      <div
        className="my-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
        data-inline-visualization-state="unavailable"
      >
        <p>{t("chat.visualReply.unavailable")}</p>
        <button
          type="button"
          className="mt-1 underline underline-offset-2"
          aria-expanded={showSource}
          onClick={() => setShowSource((open) => !open)}
        >
          {showSource ? t("chat.visualReply.hideSource") : t("chat.visualReply.showSource")}
        </button>
        <DisclosureRegion open={showSource} contentClassName="pt-2">
          <pre className="overflow-x-auto whitespace-pre-wrap rounded bg-background/70 p-2 text-ui-xs text-foreground">
            {props.directive.source}
          </pre>
        </DisclosureRegion>
      </div>
    );
  }
  if (src === undefined) {
    return (
      <div
        className="my-2 h-80 animate-pulse rounded-md bg-muted/30"
        data-inline-visualization-state="loading"
      />
    );
  }
  return (
    <div
      className={`${INLINE_VISUALIZATION_FRAME_CLASS} ${
        props.directive.mode === "wide" ? "w-full max-w-[1024px]" : "max-w-full"
      }`}
      data-inline-visualization-state="ready"
      data-inline-visualization-mode={props.directive.mode}
      onPointerEnter={() => setIsPointerOverFrame(true)}
      onPointerLeave={() => setIsPointerOverFrame(false)}
    >
      <SandboxedHtmlDocument src={src} title={title} className="block h-[420px] w-full" />
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
                  onClick={() => props.onOpen?.(props.directive)}
                />
              }
            >
              <Maximize2 className="size-3.5" />
            </TooltipTrigger>
            <TooltipPopup side="left">{t("chat.visualReply.openInPanel")}</TooltipPopup>
          </Tooltip>
        </div>
      ) : null}
    </div>
  );
}
