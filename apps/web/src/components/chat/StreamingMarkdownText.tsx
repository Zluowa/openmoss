import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from "react";

import { FindAwareMarkdownText } from "../ChatMarkdownFind";
import { streamingTextSegments } from "./streamingTextSegments";

type TextFadeState = { active: boolean; settled: Map<number, string> };
const TextFadeContext = createContext<TextFadeState | null>(null);

export function StreamingMarkdownProvider(props: { active: boolean; children: ReactNode }) {
  const [settled] = useState(() => new Map<number, string>());
  // Server-rendered markup cannot animate and must match the settled tree. In
  // the browser, keep Moss's existing Codex-style streamed text fade.
  const active = props.active && typeof window !== "undefined";
  const value = useMemo(() => ({ active, settled }), [active, settled]);
  useEffect(() => {
    if (!active) settled.clear();
  }, [active, settled]);
  return <TextFadeContext.Provider value={value}>{props.children}</TextFadeContext.Provider>;
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
    const settled = previous !== undefined && text.startsWith(previous);
    return (
      <span
        key={sourceOffset}
        className={settled ? undefined : "codex-stream-segment"}
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
