import { useEffect, useRef, useState } from "react";
import { cn } from "~/lib/utils";
import { mountHtmlPreview, type HtmlPreviewState } from "~/lib/htmlPreviewHost";

/** Moss implementation of Codex's `presentation: code-preview` contract. */
export function CodexCodePreview(props: {
  html: string;
  fileName: string;
  filePath?: string;
  className?: string;
}) {
  const container = useRef<HTMLDivElement>(null);
  const [state, setState] = useState<HtmlPreviewState>({ phase: "loading" });
  const [attempt, setAttempt] = useState(0);
  useEffect(() => {
    if (!container.current) return;
    return mountHtmlPreview(
      container.current,
      {
        html: props.html,
        ...(props.filePath ? { filePath: props.filePath } : {}),
      },
      window.desktopBridge?.htmlPreview,
      setState,
    );
  }, [props.html, props.filePath, attempt]);
  return (
    <div
      className={cn("relative h-full w-full overflow-y-auto", props.className)}
      data-presentation="code-preview"
      data-preview-path={props.fileName}
    >
      <div
        ref={container}
        className="flex h-full min-h-[24rem] w-full"
        aria-label={props.fileName}
      />
      {state.phase === "loading" && (
        <div
          role="status"
          className="pointer-events-none absolute inset-0 flex items-center justify-center bg-background text-ui-lg text-muted-foreground"
        >
          Loading preview…
        </div>
      )}
      {state.phase === "error" && (
        <div
          role="alert"
          className="absolute inset-0 flex flex-col items-center justify-center gap-3 p-6 text-center text-ui-lg text-muted-foreground"
        >
          <p>{state.message}</p>
          {window.desktopBridge?.htmlPreview && (
            <button
              type="button"
              className="rounded-md border px-3 py-1.5 text-foreground"
              onClick={() => setAttempt((value) => value + 1)}
            >
              Retry
            </button>
          )}
        </div>
      )}
    </div>
  );
}
