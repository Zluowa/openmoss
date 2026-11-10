// FILE: GuestDeckView.tsx
// Purpose: A shared 幻灯片 for guests: every slide in order, read-only, with 演示 (full screen).
// Layer: Guest page view

import { parseSlidesDeck, type SlidesDeck } from "@moss/shared/spaceItems/slidesDeck";
import { useLayoutEffect, useMemo, useRef, useState } from "react";

import { SlidesPresenter } from "~/components/spaceTypes/slides/SlidesPresenter";
import { SlideView } from "~/components/spaceTypes/slides/SlideView";
import { Button } from "~/components/ui/button";

import type { PageGuestCopy } from "./pageGuestCopy";

export function GuestDeckView(props: { deck: string; copy: PageGuestCopy }) {
  const deck = useMemo<SlidesDeck | null>(() => {
    try {
      return parseSlidesDeck(props.deck);
    } catch {
      return null;
    }
  }, [props.deck]);
  const frame = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(720);
  const [presenting, setPresenting] = useState<number | null>(null);
  useLayoutEffect(() => {
    const element = frame.current;
    if (!element) return;
    const observer = new ResizeObserver(() => setWidth(Math.max(240, element.clientWidth)));
    observer.observe(element);
    return () => observer.disconnect();
  }, []);
  if (!deck) return null;
  const slides = deck.slides.filter((slide) => !slide.hidden);
  return (
    <div ref={frame} className="flex flex-col gap-4" data-guest-deck>
      <div className="flex items-center justify-between text-ui-sm text-muted-foreground">
        <span>{props.copy.slideCount.replace("{count}", String(slides.length))}</span>
        <Button size="sm" variant="outline" onClick={() => setPresenting(0)}>
          {props.copy.present}
        </Button>
      </div>
      {slides.map((slide, index) => (
        <button
          key={slide.id}
          type="button"
          className="overflow-hidden rounded-card border border-border text-left shadow-xs"
          onClick={() => setPresenting(index)}
          aria-label={`${index + 1}`}
        >
          <SlideView slide={slide} theme={deck.theme} width={width} />
        </button>
      ))}
      {presenting !== null ? (
        <SlidesPresenter deck={deck} startIndex={presenting} onClose={() => setPresenting(null)} />
      ) : null}
    </div>
  );
}
