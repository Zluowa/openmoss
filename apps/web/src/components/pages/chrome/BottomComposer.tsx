// FILE: BottomComposer.tsx
// Purpose: The page composer: a compact pill docked at the page's lower right. It sends one turn
//          to the selected Moss agent with this page as context; the agent's edits come back as
//          drafts in the page. While idle after a run, the pill shows how that run went, and
//          offers 重试 after one that did not finish.
// Layer: Space page chrome slot `bottomComposer` — owned by page-ai.

import { useNavigate } from "@tanstack/react-router";
import { useEffect, useRef, useState } from "react";

import { ComposerSendArrowIcon } from "~/lib/icons";
import { isActiveRun, pageAiKey, usePageAiSession } from "~/lib/pageAi/pageAiSession";
import { cn } from "~/lib/utils";

import { Button } from "../../ui/button";

import { pageAiLocale, pageAiText } from "../ai/pageAiText";
import type { PageChromeSlotProps } from "./pageChromeContext";

function useNow(active: boolean) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

export function BottomComposer({ context }: PageChromeSlotProps) {
  const navigate = useNavigate();
  const text = pageAiText(pageAiLocale());
  const session = usePageAiSession(
    pageAiKey(context.account, context.scopeSpaceId, context.page.id),
  );
  const [value, setValue] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const latest = session.runs.at(-1);
  const running = !!latest && isActiveRun(latest);
  const now = useNow(running);
  if (context.readOnly) return null;
  const editor = session.editor;
  const busy = session.runs.some((run) => run.mode === "compose" && isActiveRun(run));
  const submit = () => {
    const prompt = value.trim();
    if (!prompt || !editor || busy) return;
    setValue("");
    void editor.startRun({ mode: "compose", prompt, anchorBlockId: null });
  };
  const seconds = latest
    ? Math.max(1, Math.round(((latest.finishedAt ?? now) - latest.startedAt) / 1000))
    : 0;
  // The last run's state reads in the empty pill, the way a page reports what it just did.
  const status = !latest
    ? null
    : running
      ? text.workingFor(seconds)
      : latest.status === "failed"
        ? `${text.failed}${latest.error ? `：${latest.error}` : ""}`
        : text.doneIn(seconds);
  const placeholder = !editor ? text.noAgent : (status ?? text.composerPlaceholder);
  const ready = Boolean(value.trim()) && !!editor && !busy;
  return (
    <div
      className="pointer-events-none sticky bottom-0 z-10 flex justify-end px-6 pb-4 pt-2"
      data-page-composer
    >
      <div
        className="pointer-events-auto flex h-11 w-full max-w-[440px] items-center gap-2 rounded-full border border-border bg-background pl-4 pr-1.5 shadow-[0_4px_16px_rgba(0,0,0,0.08)] focus-within:border-ring"
        onClick={() => input.current?.focus()}
      >
        <span
          aria-hidden
          className={cn(
            "size-1.5 shrink-0 rounded-full",
            running
              ? "animate-pulse bg-emerald-500"
              : latest?.status === "failed"
                ? "bg-destructive"
                : "hidden",
          )}
        />
        <input
          ref={input}
          value={value}
          aria-label={text.composerLabel}
          placeholder={placeholder}
          title={status ?? undefined}
          disabled={!editor}
          onFocus={() => editor?.prepare()}
          onChange={(event) => setValue(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === "Enter" && !event.nativeEvent.isComposing) {
              event.preventDefault();
              submit();
            }
          }}
          className="min-w-0 flex-1 bg-transparent text-ui outline-none placeholder:text-muted-foreground"
        />
        {latest?.status === "failed" && latest.prompt && editor && !value ? (
          <Button
            size="xs"
            variant="ghost"
            className="shrink-0"
            onClick={(event) => {
              event.stopPropagation();
              void editor.startRun({
                mode: latest.mode,
                prompt: latest.prompt,
                anchorBlockId: latest.anchorBlockId,
              });
            }}
          >
            {text.retry}
          </Button>
        ) : null}
        {latest?.threadId && !value ? (
          <button
            type="button"
            className="shrink-0 rounded-full px-2 text-ui-xs text-muted-foreground hover:text-foreground"
            onClick={(event) => {
              event.stopPropagation();
              void context
                .flush()
                .then(() => navigate({ to: "/$threadId", params: { threadId: latest.threadId! } }));
            }}
          >
            {text.openChat}
          </button>
        ) : null}
        <button
          type="button"
          aria-label={text.send}
          disabled={!ready}
          onClick={submit}
          className={cn(
            "grid size-8 shrink-0 place-items-center rounded-full text-background transition-colors",
            ready ? "bg-foreground" : "bg-foreground/30",
          )}
        >
          <ComposerSendArrowIcon aria-hidden className="size-4" />
        </button>
      </div>
    </div>
  );
}
