import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { FindAwareMarkdownText } from "../ChatMarkdownFind";
import { STREAM_FADE_MS, StreamingFadeScheduler } from "./streamingFadeScheduler";
import { streamingTextSegments } from "./streamingTextSegments";

type TextFadeState = {
  active: boolean;
  settled: Map<number, string>;
  scheduler: StreamingFadeScheduler | null;
};
const TextFadeContext = createContext<TextFadeState | null>(null);

// One fade queue per streaming message, kept while it streams so a row the list
// unmounts and mounts again does not replay words it already showed.
const liveSchedulers = new Map<string, StreamingFadeScheduler>();

function schedulerFor(streamKey: string | undefined): StreamingFadeScheduler {
  if (streamKey === undefined) return new StreamingFadeScheduler();
  let scheduler = liveSchedulers.get(streamKey);
  if (!scheduler) {
    scheduler = new StreamingFadeScheduler();
    liveSchedulers.set(streamKey, scheduler);
  }
  return scheduler;
}

export function StreamingMarkdownProvider(props: {
  active: boolean;
  /** Length of the message text; the fade is skipped while output is very fast. */
  textLength: number;
  /** Identity of the streaming message, so a remount reuses its fade queue. */
  streamKey?: string | undefined;
  children: ReactNode;
}) {
  const [settled] = useState(() => new Map<number, string>());
  // Server-rendered markup cannot animate and must match the settled tree. In
  // the browser, keep Moss's existing Codex-style streamed text fade.
  const active = props.active && typeof window !== "undefined";
  const { streamKey } = props;
  const scheduler = useMemo(() => (active ? schedulerFor(streamKey) : null), [active, streamKey]);
  useMemo(() => scheduler?.sync(props.textLength), [scheduler, props.textLength]);
  const value = useMemo(() => ({ active, settled, scheduler }), [active, settled, scheduler]);
  useEffect(() => {
    if (active) return;
    settled.clear();
    if (streamKey !== undefined) liveSchedulers.delete(streamKey);
  }, [active, settled, streamKey]);
  return <TextFadeContext.Provider value={value}>{props.children}</TextFadeContext.Provider>;
}

const FADE_STYLE_BY_DELAY = new Map<
  number,
  { animationDuration: string; animationDelay?: string }
>();
function fadeStyle(delayMs: number) {
  let style = FADE_STYLE_BY_DELAY.get(delayMs);
  if (!style) {
    style =
      delayMs === 0
        ? { animationDuration: `${STREAM_FADE_MS}ms` }
        : { animationDuration: `${STREAM_FADE_MS}ms`, animationDelay: `${delayMs}ms` };
    FADE_STYLE_BY_DELAY.set(delayMs, style);
  }
  return style;
}

export function StreamingMarkdownText(props: { text: string; sourceOffset: number }) {
  const fade = useContext(TextFadeContext);
  const segments = useMemo(
    () => (fade?.active ? streamingTextSegments(props.text) : []),
    [fade?.active, props.text],
  );
  if (!fade?.active) return <FindAwareMarkdownText {...props} />;

  let offset = props.sourceOffset;
  return segments.map((text) => {
    const sourceOffset = offset;
    offset += text.length;
    const previous = fade.settled.get(sourceOffset);
    // Appending to the last word or remounting an already painted leaf must not
    // replay its fade. The map lives only for this message's active stream.
    const reveal = fade.scheduler?.reveal(sourceOffset, text.length);
    const settled =
      (previous !== undefined && text.startsWith(previous)) || reveal?.instant === true;
    return (
      <span
        key={sourceOffset}
        className={settled ? undefined : "codex-stream-segment"}
        style={settled || !reveal ? undefined : fadeStyle(reveal.delayMs)}
        data-stream-text-start={sourceOffset}
        onAnimationEnd={(event) => {
          if (event.target === event.currentTarget) fade.settled.set(sourceOffset, text);
        }}
      >
        <FindAwareMarkdownText text={text} sourceOffset={sourceOffset} />
      </span>
    );
  });
}
