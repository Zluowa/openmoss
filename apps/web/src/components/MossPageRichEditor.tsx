import { useEffect, useRef, useState } from "react";
import type { SpaceId } from "@moss/contracts";
import { useTheme } from "~/hooks/useTheme";
import { useAppSettings } from "~/appSettings";
import { getAppTypographyScale } from "~/lib/appTypography";
import { resolveWsHttpUrl } from "~/lib/wsHttpUrl";
import {
  PageRichEditorChannel,
  type PageEditorHeaderEvent,
  type PageRichEditorHeader,
  type PageRichEditorValue,
} from "~/lib/pageRichEditorChannel";
import {
  localDeviceLabel,
  localPresenceColor,
  parsePagePresence,
  setPagePresence,
} from "~/lib/pageRealtime/pagePresenceStore";
import { PageRealtimeRelay, type PageRealtimeLink } from "~/lib/pageRealtime/pageRealtimeRelay";
import { ensureNativeApi } from "~/nativeApi";
import { Button } from "./ui/button";
import { PageAiRunWatchers } from "./pages/ai/PageAiRunWatcher";
import { usePageAiBridge, type PageAiHostOptions } from "./pages/ai/usePageAiBridge";

/** A Page with a live room: edits sync through the room instead of the parent's autosave. */
export interface MossPageRealtimeTarget {
  pageId: string;
  scopeSpaceId: SpaceId | null;
}

interface LiveState {
  relay: PageRealtimeRelay | null;
  /** The room document the editor loaded, once it holds a live replica. */
  loaded: { generation: string | null; mode: "edit" | "view" } | null;
  loadedWaiters: Array<() => void>;
  link: PageRealtimeLink;
  pending: boolean;
  pendingWaiters: Array<() => void>;
}

export function MossPageRichEditor(props: {
  documentKey: string;
  content: string;
  richContent: string | null;
  valueVersion: number;
  readOnly: boolean;
  onChange: (value: PageRichEditorValue) => void;
  onFlushChange: (flush: (() => Promise<boolean>) | null) => void;
  onUnavailableChange: (unavailable: boolean) => void;
  realtime?: MossPageRealtimeTarget | null;
  /** The room published a revision (compaction, a merged agent write, a title change). */
  onRealtimeRevision?: (revision: number) => void;
  /** Edits recovered from an outdated replica on this device, to be saved as a new Page. */
  onRecoveredCopy?: (richContent: string) => void;
  /** Page AI (drafts, slash AI items, composer runs); omitted where a page has no agents. */
  ai?: PageAiHostOptions | null;
  /** The page header (title, crumbs, links) the editor draws above the body when it can. */
  header?:
    | (PageRichEditorHeader & {
        onTitleChange: (title: string) => void;
        onAppearanceChange: (
          change: Pick<PageEditorHeaderEvent & { event: "header-change" }, "icon" | "cover">,
        ) => void;
        onAction: (id: string) => void;
      })
    | null;
  /** Whether the loaded editor draws the header, so the page does not draw a second one. */
  onHeaderSupportChange?: (supported: boolean) => void;
}) {
  const { resolvedTheme } = useTheme();
  const { settings } = useAppSettings();
  const fontSize = getAppTypographyScale(settings.chatFontSizePx).chatPx;
  const presentation = useRef({ theme: resolvedTheme, fontSize });
  presentation.current = { theme: resolvedTheme, fontSize };
  const frame = useRef<HTMLIFrameElement | null>(null);
  const latest = useRef(props);
  latest.current = props;
  const [nonce] = useState(() => crypto.randomUUID());
  const [ready, setReady] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [reload, setReload] = useState(0);
  const [headerSupported, setHeaderSupported] = useState(false);
  const [unavailable, setUnavailable] = useState(false);
  const [drawsHeader, setDrawsHeader] = useState(false);
  const [src] = useState(() => {
    const url = new URL(resolveWsHttpUrl("/canvas/page-editor.html"), window.location.origin);
    url.searchParams.delete("token");
    url.searchParams.set("moss_page_editor", "1");
    url.searchParams.set("sessionNonce", nonce);
    url.searchParams.set("moss_parent_origin", window.location.origin);
    return url.toString();
  });
  const origin = new URL(src).origin;
  const live = useRef<LiveState>({
    relay: null,
    loaded: null,
    loadedWaiters: [],
    link: "connecting",
    pending: false,
    pendingWaiters: [],
  });
  const realtimeOn = () => live.current.relay !== null && live.current.loaded !== null;
  const [channel] = useState(
    () =>
      new PageRichEditorChannel(
        nonce,
        (message) => frame.current?.contentWindow?.postMessage(message, origin),
        (value) => {
          // The room persists a live body; the parent's autosave would race it.
          if (!realtimeOn()) latest.current.onChange(value);
        },
        (isReady) => {
          setReady(isReady);
          if (isReady) {
            setError(null);
            for (const resolve of live.current.loadedWaiters.splice(0)) resolve();
          }
        },
        setError,
        (isUnavailable) => {
          setUnavailable(isUnavailable);
          latest.current.onUnavailableChange(isUnavailable);
        },
        {
          frame: (data) => live.current.relay?.send(data),
          presence: (value) => {
            const parsed = parsePagePresence(value);
            const pageId = latest.current.realtime?.pageId;
            if (!parsed || !pageId) return;
            live.current.pending = parsed.pending;
            if (!parsed.pending)
              for (const resolve of live.current.pendingWaiters.splice(0)) resolve();
            setPagePresence(pageId, parsed);
          },
          reset: () => live.current.relay?.restart(),
          retry: () => live.current.relay?.restart(),
          copy: (richContent) => latest.current.onRecoveredCopy?.(richContent),
        },
      ),
  );
  const pageAi = usePageAiBridge(channel, props.ai ?? null, () => {
    frame.current?.focus();
    frame.current?.contentWindow?.focus();
  });
  useEffect(() => {
    channel.onHeaderSupportChange = setHeaderSupported;
    channel.onHeaderEvent = (event) => {
      const header = latest.current.header;
      if (!header) return;
      if (event.event === "header-action") header.onAction(event.id);
      else {
        if (event.title !== undefined) header.onTitleChange(event.title);
        if (event.icon !== undefined || event.cover !== undefined)
          header.onAppearanceChange({
            ...(event.icon === undefined ? {} : { icon: event.icon }),
            ...(event.cover === undefined ? {} : { cover: event.cover }),
          });
      }
    };
    return () => {
      channel.onHeaderSupportChange = () => {};
      channel.onHeaderEvent = () => {};
    };
  }, [channel]);
  // The header moves into the editor once it has loaded this page, and comes back to the page
  // whenever the editor cannot show it (another page loading, the editor unavailable).
  useEffect(() => setDrawsHeader(false), [props.documentKey]);
  useEffect(() => {
    if (unavailable || !headerSupported) setDrawsHeader(false);
    else if (ready) setDrawsHeader(true);
  }, [ready, headerSupported, unavailable]);
  useEffect(() => latest.current.onHeaderSupportChange?.(drawsHeader), [drawsHeader]);
  const headerKey = props.header
    ? JSON.stringify([
        props.header.title,
        props.header.placeholder,
        props.header.editable,
        props.header.crumbs,
        props.header.links,
        props.header.icon,
        props.header.cover,
      ])
    : null;
  useEffect(() => {
    const header = latest.current.header;
    if (!header) return;
    channel.setHeader({
      title: header.title,
      placeholder: header.placeholder,
      editable: header.editable,
      crumbs: header.crumbs,
      links: header.links,
      icon: header.icon,
      cover: header.cover,
    });
  }, [channel, headerKey]);
  useEffect(() => {
    const handler = (event: MessageEvent) => {
      if (event.source !== frame.current?.contentWindow || event.origin !== origin) return;
      channel.receive(event.data);
    };
    window.addEventListener("message", handler);
    return () => {
      window.removeEventListener("message", handler);
      channel.reset();
    };
  }, [channel, origin]);
  const loadDocument = (collab?: { generation: string | null; mode: "edit" | "view" }) => {
    const current = latest.current;
    const target = current.realtime;
    channel.load({
      documentKey: current.documentKey,
      content: current.content,
      richContent: current.richContent,
      readOnly: current.readOnly || collab?.mode === "view",
      ...presentation.current,
      ...(collab && target
        ? {
            collab: {
              pageId: target.pageId,
              generation: collab.generation,
              mode: collab.mode,
              user: { id: nonce, name: localDeviceLabel(), color: localPresenceColor() },
            },
          }
        : {}),
    });
  };
  useEffect(() => {
    // A live document belongs to its room; saved revisions coming back from it must not reload it.
    if (live.current.loaded) return;
    loadDocument();
  }, [channel, props.documentKey, props.valueVersion]);
  const pageId = props.realtime?.pageId ?? null;
  const scopeSpaceId = props.realtime?.scopeSpaceId ?? null;
  useEffect(() => {
    if (!pageId) return;
    const state = live.current;
    const relay: PageRealtimeRelay = new PageRealtimeRelay({
      target: { pageId: pageId as never, scopeSpaceId },
      requestToken: (input) => ensureNativeApi().pages.realtimeToken(input),
      onTicket: async (ticket) => {
        const loaded = state.loaded;
        if (loaded && loaded.generation === ticket.generation && loaded.mode === ticket.mode)
          return;
        await new Promise<void>((resolve, reject) => {
          const timer = setTimeout(() => reject(new Error("页面编辑器尚未载入。")), 15_000);
          state.loadedWaiters.push(() => {
            clearTimeout(timer);
            resolve();
          });
          state.loaded = { generation: ticket.generation, mode: ticket.mode };
          loadDocument(state.loaded);
        });
        if (!channel.supportsRealtime) {
          // An older Canvas bundle keeps the parent-saved editor.
          state.loaded = null;
          relay.stop();
          loadDocument();
          throw new Error("页面编辑器不支持实时协作。");
        }
      },
      onFrame: (data) => {
        if (typeof data === "string" && data.startsWith('{"type":"revision"')) {
          try {
            const revision = (JSON.parse(data) as { revision?: unknown }).revision;
            if (typeof revision === "number") latest.current.onRealtimeRevision?.(revision);
          } catch {
            /* Forwarded to the editor regardless. */
          }
        }
        channel.collabFrame(data);
      },
      onLink: (link, reason) => {
        state.link = link;
        if (link !== "online") for (const resolve of state.pendingWaiters.splice(0)) resolve();
        channel.collabStatus(link, reason);
      },
    });
    state.relay = relay;
    relay.start();
    return () => {
      relay.stop();
      if (state.relay === relay) state.relay = null;
      state.loaded = null;
      setPagePresence(pageId, null);
    };
  }, [channel, pageId, scopeSpaceId]);
  useEffect(
    () => channel.setPresentation({ theme: resolvedTheme, fontSize }),
    [channel, resolvedTheme, fontSize],
  );
  useEffect(() => channel.setReadOnly(props.readOnly), [channel, props.readOnly]);
  useEffect(() => {
    // With a live room a flush completes once the server confirms it stored this window's
    // edits. Offline, they are already safe in this device's replica and sync on reconnect.
    const flush = async () => {
      if (!(await channel.flush())) return false;
      const state = live.current;
      if (!realtimeOn() || !state.pending || state.link !== "online") return true;
      return new Promise<boolean>((resolve) => {
        const timer = setTimeout(() => resolve(false), 5_000);
        state.pendingWaiters.push(() => {
          clearTimeout(timer);
          resolve(true);
        });
      });
    };
    props.onFlushChange(flush);
    return () => props.onFlushChange(null);
  }, [channel, props.onFlushChange]);
  useEffect(() => {
    if (ready || error) return;
    const timer = setTimeout(channel.connectionTimedOut, 15_000);
    return () => clearTimeout(timer);
  }, [channel, ready, error, reload]);

  return (
    <div
      className="relative flex min-h-80 min-w-0 flex-1 flex-col"
      data-page-rich-editor
      // What the editor draws above the body, readable from this page (the editor is another origin).
      data-page-header-title={drawsHeader ? props.header?.title : undefined}
      data-page-header-links={
        drawsHeader ? props.header?.links.map((link) => link.label).join("\n") : undefined
      }
    >
      {error ? (
        <div role="alert" className="flex items-center gap-3 border-b border-border p-3 text-ui-sm">
          <span className="flex-1">{error}</span>
          <Button
            size="sm"
            variant="ghost"
            onClick={() => {
              if (!ready) {
                channel.reset();
                setError(null);
                setReload((value) => value + 1);
              } else void channel.flush();
            }}
          >
            重试编辑器
          </Button>
        </div>
      ) : null}
      <iframe
        key={reload}
        ref={frame}
        src={src}
        title="页面富文本编辑器"
        className="min-h-80 w-full flex-1 border-0 bg-background"
        onLoad={() => {
          channel.reset();
          live.current.loaded = null;
          channel.hello();
          live.current.relay?.restart();
        }}
      />
      {props.ai ? (
        <PageAiRunWatchers
          pageKey={pageAi.key}
          runs={pageAi.runs}
          scopeSpaceId={props.ai.scopeSpaceId}
          pageId={props.ai.document.page.id}
          onDrafted={() => void pageAi.refreshDrafts()}
        />
      ) : null}
      {!ready && !error ? (
        <div
          role="status"
          className="absolute inset-0 flex items-center justify-center bg-background text-ui-sm text-muted-foreground"
        >
          正在加载页面编辑器…
        </div>
      ) : null}
    </div>
  );
}
