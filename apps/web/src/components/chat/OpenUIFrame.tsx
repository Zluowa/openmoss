// FILE: OpenUIFrame.tsx
// Purpose: Render an OpenUI Lang program inline in the transcript through the
//          OpenUI React renderer (no iframe, no sandbox), and reflow component
//          interactions (form submits, button clicks) back into the composer.
// Layer: Chat UI

import { Component, Suspense, lazy, useEffect, useState, type ReactNode } from "react";
import type { ThreadId } from "@synara/contracts";
import { useQueryClient } from "@tanstack/react-query";

import type { OpenUIDirective } from "~/lib/inlineVisualizationDirective";
import { useOpenUIFormState } from "~/lib/openUIFormState";
import {
  injectOpenUIFollowUpIntoComposer,
  resolveOpenUIActionDispatch,
  type OpenUIActionEventLike,
} from "~/lib/openUIReflow";
import { useTranslation } from "~/localization";
import { DisclosureRegion } from "../ui/DisclosureRegion";

import { INLINE_VISUALIZATION_FRAME_CLASS } from "./InlineVisualizationFrame";

// The renderer pulls in d3, radix and react-syntax-highlighter; keep it out of
// the chat hot path. Vite code-splits the chunk (and its stylesheet).
const OpenUIRendererInner = lazy(() => import("./OpenUIRendererInner"));

interface OpenUIFrameErrorBoundaryProps {
  readonly children: ReactNode;
  readonly fallback: ReactNode;
}

class OpenUIFrameErrorBoundary extends Component<
  OpenUIFrameErrorBoundaryProps,
  { hasError: boolean }
> {
  override state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  override render() {
    return this.state.hasError ? this.props.fallback : this.props.children;
  }
}

export function OpenUIFrameFallback(props: {
  readonly directive: OpenUIDirective;
  readonly unknownComponents?: ReadonlyArray<string> | undefined;
}) {
  const { t, format } = useTranslation();
  const [showSource, setShowSource] = useState(false);
  return (
    <div
      className="my-2 rounded-md border border-border/70 bg-muted/20 px-3 py-2 text-ui-xs text-muted-foreground"
      data-openui-state="error"
    >
      <p>{t("chat.visualReply.unavailable")}</p>
      {props.unknownComponents && props.unknownComponents.length > 0 ? (
        <p className="mt-1">
          {format("chat.visualReply.unknownComponents", {
            names: props.unknownComponents.join(", "),
          })}
        </p>
      ) : null}
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
          {props.directive.code}
        </pre>
      </DisclosureRegion>
    </div>
  );
}

export function OpenUIFrame(props: {
  readonly threadId: string | undefined;
  readonly messageId?: string | undefined;
  readonly segmentIndex?: number | undefined;
  readonly blockOffset?: number | undefined;
  readonly directive: OpenUIDirective;
  readonly isStreaming: boolean;
  /** Overrides the default composer-draft reflow for component actions. */
  readonly onFollowUp?: ((message: string) => void) | undefined;
}) {
  const formState = useOpenUIFormState(useQueryClient(), {
    threadId: props.threadId,
    messageId: props.messageId,
    segmentIndex: props.segmentIndex,
    blockOffset: props.blockOffset,
    code: props.directive.code,
    isStreaming: props.isStreaming || props.directive.partial,
  });
  // Client-only mount: the OpenUI renderer touches browser-only APIs, and the
  // mounted gate also keeps renderToStaticMarkup (unit tests) on the
  // placeholder path instead of evaluating the lazy chunk.
  const [mounted, setMounted] = useState(false);
  useEffect(() => setMounted(true), []);

  const handleAction = (event: OpenUIActionEventLike) => {
    const dispatch = resolveOpenUIActionDispatch(event);
    if (dispatch.kind === "ignore") return;
    if (dispatch.kind === "open-url") {
      window.open(dispatch.url, "_blank", "noopener,noreferrer");
      return;
    }
    if (props.onFollowUp) {
      props.onFollowUp(dispatch.message);
      return;
    }
    if (props.threadId) {
      injectOpenUIFollowUpIntoComposer(props.threadId as ThreadId, dispatch.message);
    }
  };

  return (
    <div
      className={`${INLINE_VISUALIZATION_FRAME_CLASS} max-w-full`}
      data-openui-state={mounted ? "ready" : "loading"}
    >
      {mounted ? (
        <OpenUIFrameErrorBoundary
          key={formState.rendererKey}
          fallback={<OpenUIFrameFallback directive={props.directive} />}
        >
          <Suspense
            fallback={
              <div
                className="my-2 h-40 animate-pulse rounded-md bg-muted/30"
                data-openui-state="loading"
              />
            }
          >
            <OpenUIRendererInner
              directive={props.directive}
              formState={formState}
              isStreaming={props.isStreaming || props.directive.partial}
              onAction={handleAction}
            />
          </Suspense>
        </OpenUIFrameErrorBoundary>
      ) : (
        <div
          className="my-2 h-40 animate-pulse rounded-md bg-muted/30"
          data-openui-state="loading"
        />
      )}
    </div>
  );
}
