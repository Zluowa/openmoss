// FILE: InlineVisualFrame.tsx
// Purpose: One agent-published inline visual in the transcript: runs its document in a sandboxed
//          frame (srcdoc on desktop, served on a shared conversation), and bridges size, theme,
//          and scroll intent.
// Layer: Chat transcript row content
// Exports: InlineVisualFrame

import type { InlineVisualActivityPayload, ThreadId } from "@moss/contracts";
import {
  buildInlineVisualDocument,
  clampInlineVisualHeight,
  inlineVisualThemeMessage,
  readInlineVisualFrameMessage,
  type InlineVisualTheme,
} from "@moss/shared/inlineVisual";
import { useQuery } from "@tanstack/react-query";
import { useEffect, useLayoutEffect, useRef, useState } from "react";

import { isElectron } from "~/env";
import { useInlineVisualTheme } from "~/hooks/useInlineVisualTheme";
import { DISCLOSURE_FADE_MOTION_CLASS } from "~/lib/disclosureMotion";
import { RotateCcwIcon } from "~/lib/icons";
import { inlineVisualHost, resolveWebInlineVisualFrameUrl } from "~/lib/inlineVisualHosting";
import { inlineVisualQueryOptions } from "~/lib/providerReactQuery";
import { cn } from "~/lib/utils";

import { Button } from "../ui/button";
import { CopyTextButton } from "../ui/copyTextButton";
import { IconButton } from "../ui/icon-button";

/**
 * An inline visual. The box holds the agent's expected height while the
 * document loads, then fits the height the page reports, so the transcript
 * grows once rather than jumping. Growth only re-measures the list row; it is
 * never a follow signal. A reader who scrolls over the frame still detaches
 * follow through `onScrollIntent`, since those gestures never reach the host.
 */
export function InlineVisualFrame(props: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  // A document can navigate its own iframe, and a page cannot stop that once it starts. Agent
  // HTML runs only where something refuses the navigation before any request leaves: desktop's
  // native guard for a `srcdoc` frame, or in a browser the page's own `frame-src` for a served
  // document (the web app's own server and local addresses; a shared conversation's guest page,
  // only its own origin). A `srcdoc` frame cannot be used there: it inherits the page's
  // `script-src 'self'`. Either way the document is offline: its policy blocks every fetch.
  return <InlineVisualFrameBody {...props} hosted={!isElectron} />;
}

function InlineVisualFrameBody({
  threadId,
  visual,
  onScrollIntent,
  hosted,
}: {
  readonly threadId: ThreadId;
  readonly visual: InlineVisualActivityPayload;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
  /** Load a served document (any browser) instead of a `srcdoc` built here (desktop). */
  readonly hosted: boolean;
}) {
  const theme = useInlineVisualTheme();
  const visualDocument = useQuery(
    inlineVisualQueryOptions({ threadId, visualId: visual.visualId }),
  );
  // The served document's address: resolved once per visual with the theme of that moment;
  // later theme changes arrive as messages, as they do for a `srcdoc` frame.
  const [hostedSrc, setHostedSrc] = useState<string | null | undefined>(undefined);
  const initialAppearance = useRef(theme.appearance);
  useEffect(() => {
    if (!hosted) return;
    let active = true;
    // A shared conversation's guest page loads it through the share; the web app from its server.
    const resolveFrameUrl = inlineVisualHost()?.frameUrl ?? resolveWebInlineVisualFrameUrl;
    void resolveFrameUrl({
      threadId,
      visualId: visual.visualId,
      appearance: initialAppearance.current,
    }).then(
      (url) => {
        if (active) setHostedSrc(url);
      },
      () => {
        if (active) setHostedSrc(null);
      },
    );
    return () => {
      active = false;
    };
  }, [hosted, threadId, visual.visualId]);
  // Reload mounts a fresh frame (and clears a stopped one) without refetching.
  const [generation, setGeneration] = useState(0);
  const [stopped, setStopped] = useState(false);
  const reload = () => {
    setStopped(false);
    setGeneration((value) => value + 1);
  };
  const html = visualDocument.data;
  const frameDocument: InlineVisualDocumentSource | null = hosted
    ? typeof hostedSrc === "string"
      ? { kind: "src", src: hostedSrc }
      : null
    : html !== undefined
      ? { kind: "srcdoc", html }
      : null;
  // A served frame does not need the source (only Copy does), so only its address can fail it.
  const failed = hosted ? hostedSrc === null : visualDocument.isError;

  // No caption row: the page is part of the reply and lines up with its text.
  // The title names the figure and frame for assistive technology instead.
  return (
    <figure className="group/inline-visual relative m-0 min-w-0" aria-label={visual.title}>
      {frameDocument !== null && !stopped ? (
        <>
          <InlineVisualDocument
            key={`${visual.visualId}:${generation}`}
            source={frameDocument}
            title={visual.title}
            reservedHeight={visual.height}
            theme={theme}
            onStopped={() => setStopped(true)}
            onScrollIntent={onScrollIntent}
          />
          <div
            className={cn(
              DISCLOSURE_FADE_MOTION_CLASS,
              "absolute end-1 top-1 flex items-center gap-0.5 rounded-control border border-border/60 bg-popover/90 p-0.5 opacity-0 shadow-xs backdrop-blur-sm focus-within:opacity-100 group-hover/inline-visual:opacity-100 pointer-coarse:opacity-100",
            )}
          >
            {html !== undefined ? (
              <CopyTextButton text={html} label="source" className="text-ui-xs" />
            ) : null}
            <IconButton label="Reload visual" tooltip="Reload" onClick={reload}>
              <RotateCcwIcon className="size-4" />
            </IconButton>
          </div>
        </>
      ) : stopped ? (
        <InlineVisualNotice
          title={visual.title}
          message="This visual stopped because it could not stay isolated."
          action="Reload"
          onAction={reload}
        />
      ) : failed ? (
        <InlineVisualNotice
          title={visual.title}
          message="Visual unavailable."
          {...(visualDocument.isError && isRetryable(visualDocument.error)
            ? { action: "Retry", onAction: () => void visualDocument.refetch() }
            : {})}
        />
      ) : (
        <div
          className="flex items-center justify-center rounded-card bg-muted/40 text-muted-foreground text-ui-xs"
          style={{ height: clampInlineVisualHeight(visual.height) }}
          role="status"
        >
          Loading visual…
        </div>
      )}
    </figure>
  );
}

function isRetryable(error: unknown): boolean {
  return (error as { retryable?: unknown } | null)?.retryable !== false;
}

function InlineVisualNotice(props: {
  readonly title: string;
  readonly message: string;
  readonly action?: string;
  readonly onAction?: () => void;
}) {
  return (
    <div
      className="flex items-center gap-2 rounded-card border border-border/60 px-3 py-2 text-muted-foreground text-ui-sm"
      role="status"
    >
      <span className="max-w-[40%] truncate text-foreground">{props.title}</span>
      <span className="min-w-0 flex-1">{props.message}</span>
      {props.action && props.onAction ? (
        <Button size="xs" variant="outline" onClick={props.onAction}>
          {props.action}
        </Button>
      ) : null}
    </div>
  );
}

/** A visual's frame document: built here as `srcdoc` (desktop), or served (guest page). */
type InlineVisualDocumentSource =
  | { readonly kind: "srcdoc"; readonly html: string }
  | { readonly kind: "src"; readonly src: string };

function InlineVisualDocument({
  source,
  title,
  reservedHeight,
  theme,
  onStopped,
  onScrollIntent,
}: {
  readonly source: InlineVisualDocumentSource;
  readonly title: string;
  readonly reservedHeight: number;
  readonly theme: InlineVisualTheme;
  readonly onStopped: () => void;
  readonly onScrollIntent?: ((upward: boolean) => void) | undefined;
}) {
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [contentHeight, setContentHeight] = useState<number | null>(null);
  const [loaded, setLoaded] = useState(false);
  // Built once per mount with the theme of that moment; later theme changes
  // arrive as messages, since a new srcdoc would reload the page and lose its
  // state. The parent keys this component by visual id and reload count.
  const [srcDoc] = useState(() =>
    source.kind === "srcdoc" ? buildInlineVisualDocument(source.html, theme) : undefined,
  );
  const callbacks = useRef({ onStopped, onScrollIntent });
  const loads = useRef(0);
  const loadedWindow = useRef<Window | null>(null);
  useLayoutEffect(() => {
    callbacks.current = { onStopped, onScrollIntent };
  });

  useEffect(() => {
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  }, [theme]);

  // Registered in the commit that inserts the frame: a fast page can post its
  // first size before a passive effect would run.
  useLayoutEffect(() => {
    let heightTimer: ReturnType<typeof setTimeout> | undefined;
    let pendingHeight: number | undefined;
    const onMessage = (event: MessageEvent) => {
      const frame = frameRef.current;
      // Only the frame's own window; the page's origin is opaque, so this is
      // the only way to tell its messages from anyone else's.
      if (frame === null || event.source === null || event.source !== frame.contentWindow) {
        return;
      }
      const message = readInlineVisualFrameMessage(event.data);
      if (message === undefined) return;
      if (message.type === "size") {
        pendingHeight = clampInlineVisualHeight(message.height);
        // Bound expensive transcript remeasurement to ten updates per second.
        if (heightTimer === undefined) {
          heightTimer = setTimeout(() => {
            heightTimer = undefined;
            setContentHeight(pendingHeight ?? null);
          }, 100);
        }
      } else if (message.type === "stopped") {
        callbacks.current.onStopped();
      } else if (message.type === "scroll-intent") {
        callbacks.current.onScrollIntent?.(message.upward);
      }
      // Untrusted HTML cannot open host URLs, even during user activation.
    };
    window.addEventListener("message", onMessage);
    return () => {
      window.removeEventListener("message", onMessage);
      if (heightTimer !== undefined) clearTimeout(heightTimer);
    };
  }, []);

  const onLoad = () => {
    // srcdoc (or the served document) loads exactly once per browsing context. A
    // second load in the same context means the page tried to navigate its own
    // frame (desktop and the guest page's policy refuse it, which still ends the
    // document), so stop showing it. A frame re-inserted into the
    // document, where the list cannot move it intact, gets a new context and
    // its own srcdoc again: that is a fresh first load, not a navigation.
    const frameWindow = frameRef.current?.contentWindow ?? null;
    if (frameWindow !== loadedWindow.current) {
      loadedWindow.current = frameWindow;
      loads.current = 0;
    }
    loads.current += 1;
    if (loads.current > 1) {
      callbacks.current.onStopped();
      return;
    }
    setLoaded(true);
    // Covers a theme change that landed while the page was parsing.
    frameRef.current?.contentWindow?.postMessage(inlineVisualThemeMessage(theme), "*");
  };
  const height = contentHeight ?? clampInlineVisualHeight(reservedHeight);
  const colorScheme = loaded ? theme.appearance : "light";
  return (
    <iframe
      ref={frameRef}
      {...(source.kind === "src" ? { src: source.src } : { srcDoc })}
      title={title}
      // Never allow-same-origin: the opaque origin keeps the page away from the
      // app's storage, cookies, and DOM. No popups, modals, downloads, or top
      // navigation; forms only so submit handlers run (CSP blocks submission).
      sandbox="allow-scripts allow-forms"
      referrerPolicy="no-referrer"
      onLoad={onLoad}
      className="block w-full border-0 bg-transparent"
      // A frame whose color scheme differs from its document's paints an
      // opaque canvas, so the blank document would flash until the page is in.
      style={{ height, colorScheme }}
      data-inline-visual-frame=""
    />
  );
}
