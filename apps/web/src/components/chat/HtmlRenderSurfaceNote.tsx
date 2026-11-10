// FILE: HtmlRenderSurfaceNote.tsx
// Purpose: The one-line note a surface's later `html_render` publication shows instead of a
//   page, since the surface's newest page shows where the surface first appeared.
// Layer: Chat UI

import { memo } from "react";

import { CornerLeftUpIcon } from "~/lib/icons";
import { useTranslation } from "~/localization";

export const HtmlRenderSurfaceNote = memo(function HtmlRenderSurfaceNote(props: {
  /** The title this publication gave the page. */
  readonly title: string;
  /** The entry that shows the surface's newest page. */
  readonly liveId: string;
  /** Brings the newest page into view. */
  readonly onShow: (liveId: string) => void;
}) {
  const { format } = useTranslation();
  const { liveId, onShow } = props;
  return (
    <button
      type="button"
      className="inline-flex min-w-0 max-w-full items-center gap-1.5 rounded-md text-muted-foreground text-ui-sm transition-colors duration-150 hover:text-foreground focus-visible:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/60 motion-reduce:transition-none"
      data-html-render-surface-note={liveId}
      onClick={() => onShow(liveId)}
    >
      <CornerLeftUpIcon aria-hidden="true" className="size-3.5 shrink-0" />
      <span className="min-w-0 truncate">
        {format("chat.htmlRender.surfaceUpdated", { title: props.title })}
      </span>
    </button>
  );
});
