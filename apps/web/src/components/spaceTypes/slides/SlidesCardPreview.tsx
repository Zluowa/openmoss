// FILE: SlidesCardPreview.tsx
// Purpose: The picture on a 幻灯片 card in 资料空间: the deck's cover slide, painted by SlideView
//          at the card's width (no stored thumbnails to go stale).
// Layer: 资料空间 幻灯片

import type { Page } from "@moss/contracts";
import { parseSlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { useQuery } from "@tanstack/react-query";
import { useLayoutEffect, useRef, useState } from "react";

import { ensureNativeApi } from "~/nativeApi";

import { coverSlide, SlideView } from "./SlideView";

export function SlidesCardPreview(props: { page: Page }) {
  const frame = useRef<HTMLSpanElement>(null);
  const [width, setWidth] = useState(0);
  const query = useQuery({
    queryKey: ["slides-card", props.page.scopeSpaceId, props.page.id, props.page.revision],
    queryFn: async () => {
      const item = await ensureNativeApi().pageTypes.read({
        scopeSpaceId: props.page.scopeSpaceId,
        pageId: props.page.id,
      });
      return item.data ? parseSlidesDeck(item.data) : null;
    },
    staleTime: Infinity,
    retry: false,
  });
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(element.clientWidth));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  const deck = query.data;
  const slide = deck ? coverSlide(deck) : null;
  return (
    <span
      ref={frame}
      className="block aspect-video overflow-hidden rounded-t-panel border-b border-border bg-muted/40"
      data-slides-card-preview
    >
      {deck && slide && width > 0 ? (
        <SlideView slide={slide} theme={deck.theme} width={width} />
      ) : null}
    </span>
  );
}
