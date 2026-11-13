/**
 * The agent's browser when it runs on the server: a live picture of the
 * thread's tab, and the controls to take it over.
 *
 * Shown wherever no desktop app hosts the browser — the web client, a remote
 * workspace, a phone. Watching is free; input reaches the page only after
 * "Take control", and while you hold control the agent is refused until you
 * release it.
 */
import type { ThreadId } from "@moss/contracts";
import type {
  ServerBrowserStreamControl,
  ServerBrowserStreamTab,
} from "@moss/shared/serverBrowserStream";
import {
  SERVER_BROWSER_UPLOAD_MAX_BYTES,
  serverBrowserModifiers,
} from "@moss/shared/serverBrowserStream";
import { useCallback, useEffect, useRef, useState } from "react";

import {
  ArrowLeftIcon,
  ArrowRightIcon,
  CursorClickIcon,
  DownloadIcon,
  GlobeIcon,
  LoaderCircleIcon,
  Maximize2,
  Minimize2,
  PlusIcon,
  RefreshCwIcon,
  XIcon,
} from "~/lib/icons";
import {
  canvasPointToPage,
  createServerBrowserFramePainter,
  createServerBrowserStreamClient,
  serverBrowserDownloadUrl,
  type ServerBrowserFramePainter,
  type ServerBrowserStreamClient,
} from "~/lib/serverBrowserStream";
import { cn } from "~/lib/utils";
import { useTranslation } from "~/localization";

import {
  CHAT_SURFACE_HEADER_ROW_CLASS_NAME,
  DOCK_HEADER_ICON_BUTTON_CLASS,
  SurfaceTabChip,
} from "../chat/chatHeaderControls";
import { DiffPanelShell, type DiffPanelMode } from "../DiffPanelShell";
import { browserAddressDisplay } from "./browserPanelChrome.logic";
import { Button } from "../ui/button";
import { IconButton } from "../ui/icon-button";
import { Input } from "../ui/input";

export interface ServerBrowserPanelProps {
  readonly mode: DiffPanelMode;
  readonly threadId: ThreadId;
  readonly onClosePanel: () => void;
  readonly layout?:
    | { readonly expanded: boolean; readonly onToggleExpanded: () => void }
    | undefined;
}

const BUTTON_NAMES = ["left", "middle", "right"] as const;
const MAX_STREAM_WIDTH = 3_840;
const MAX_STREAM_HEIGHT = 2_160;
/** A dragged panel edge settles before the page is resized to it. */
const RESIZE_SETTLE_MS = 120;
/** How long a page-dialog notice stays over the page. */
const NOTICE_MS = 6_000;
/** A finger moves this far before a touch becomes a scroll instead of a tap. */
const TOUCH_SLOP_PX = 8;
/** Presses this close in time and place count as one double or triple click. */
const MULTI_CLICK_MS = 500;
const MULTI_CLICK_SLOP_PX = 5;

type StreamState = "connecting" | "connected" | "reconnecting" | "unavailable";

export function ServerBrowserPanel({
  mode,
  threadId,
  onClosePanel,
  layout,
}: ServerBrowserPanelProps) {
  const { t, format } = useTranslation();
  const surfaceRef = useRef<HTMLDivElement | null>(null);
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const clientRef = useRef<ServerBrowserStreamClient | null>(null);
  const painterRef = useRef<ServerBrowserFramePainter | null>(null);
  const viewportRef = useRef({ width: 1280, height: 800 });
  const pendingMoveRef = useRef<{ x: number; y: number; modifiers: number } | null>(null);
  const moveFrameRef = useRef<number | null>(null);
  const [state, setState] = useState<StreamState>("connecting");
  const [tabs, setTabs] = useState<ReadonlyArray<ServerBrowserStreamTab>>([]);
  const [selectedTabId, setSelectedTabId] = useState<string | null>(null);
  const [control, setControl] = useState<ServerBrowserStreamControl | null>(null);
  const [hasFrame, setHasFrame] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [address, setAddress] = useState("");
  const [editingAddress, setEditingAddress] = useState(false);
  /** The address field is opening a new tab rather than navigating this one. */
  const [openingTab, setOpeningTab] = useState(false);
  const addressInputRef = useRef<HTMLInputElement | null>(null);
  /** Takes the person's keys, IME composition and paste while they drive. */
  const keyboardRef = useRef<HTMLTextAreaElement | null>(null);
  const fileInputRef = useRef<HTMLInputElement | null>(null);
  const touchRef = useRef<{ x: number; y: number; scrolled: boolean } | null>(null);
  /** Pointer events carry no click count, so double and triple clicks are counted here. */
  const clickRef = useRef<{ x: number; y: number; at: number; count: number } | null>(null);
  const [dialog, setDialog] = useState<{
    id: string;
    kind: string;
    message: string;
    defaultPrompt: string;
  } | null>(null);
  const [promptText, setPromptText] = useState("");
  const [chooser, setChooser] = useState<{ id: string; multiple: boolean; accept: string } | null>(
    null,
  );
  const [download, setDownload] = useState<{ fileName: string; url: string } | null>(null);
  const tRef = useRef(t);
  tRef.current = t;

  const selectedTab = tabs.find((tab) => tab.tabId === selectedTabId) ?? null;
  const youControl = control?.controller === "you";
  const canTake = control?.canOperate === true && control.controller === "agent";
  // With no tab yet the address bar opens one; afterwards it needs control.
  const addressEditable = youControl || (state === "connected" && tabs.length === 0);

  useEffect(() => {
    const canvas = canvasRef.current;
    const surface = surfaceRef.current;
    if (!canvas || !surface) return;
    const ratio = Math.min(2, window.devicePixelRatio || 1);
    const box = surface.getBoundingClientRect();
    const painter = createServerBrowserFramePainter(canvas, () => setHasFrame(true));
    painterRef.current = painter;
    const client = createServerBrowserStreamClient(
      {
        threadId,
        // Capped by the screen, not the panel: the panel can grow without a reconnect.
        maxWidth: Math.min(MAX_STREAM_WIDTH, Math.max(box.width, window.screen.width) * ratio),
        maxHeight: Math.min(MAX_STREAM_HEIGHT, Math.max(box.height, window.screen.height) * ratio),
      },
      {
        onFrame: (jpeg) => painter.paint(jpeg),
        onTabs: (nextTabs, nextSelected) => {
          setTabs(nextTabs);
          setSelectedTabId(nextSelected);
          if (nextSelected === null) setHasFrame(false);
        },
        onViewport: (viewport) => {
          viewportRef.current = viewport;
        },
        onControl: setControl,
        onDialog: (answered) => setNotice(format("browser.server.dialog", answered)),
        onPersonal: (message) => {
          switch (message.type) {
            case "dialogOpen":
              setDialog(message);
              setPromptText(message.defaultPrompt);
              return;
            case "dialogClosed":
              setDialog((open) => (open?.id === message.id ? null : open));
              return;
            case "fileChooser":
              setChooser(message);
              return;
            case "fileChooserClosed":
              setChooser((open) => (open?.id === message.id ? null : open));
              return;
            case "download":
              setDownload({
                fileName: message.fileName,
                url: serverBrowserDownloadUrl(message.path),
              });
              return;
            case "clipboard":
              void navigator.clipboard
                ?.writeText(message.text)
                .then(() => setNotice(tRef.current("browser.server.copied")))
                .catch(() => undefined);
              return;
            case "navigationBlocked":
              setNotice(format("browser.server.navigationBlocked", { site: message.host }));
              return;
          }
        },
        onConnectedChange: (connected) => setState(connected ? "connected" : "reconnecting"),
        onUnavailable: () => setState("unavailable"),
      },
    );
    clientRef.current = client;
    return () => {
      client.stop();
      painter.stop();
      clientRef.current = null;
      painterRef.current = null;
      if (moveFrameRef.current !== null) cancelAnimationFrame(moveFrameRef.current);
    };
  }, [threadId, format]);

  useEffect(() => {
    if (!editingAddress && !openingTab) setAddress(selectedTab?.url ?? "");
  }, [editingAddress, openingTab, selectedTab?.url]);

  useEffect(() => {
    if (notice === null) return;
    const timer = setTimeout(() => setNotice(null), NOTICE_MS);
    return () => clearTimeout(timer);
  }, [notice]);

  // The page fills the panel: its size follows the panel's, re-sent whenever
  // the watched tab or the connection changes.
  useEffect(() => {
    const surface = surfaceRef.current;
    if (!surface || state !== "connected" || selectedTabId === null) return;
    let timer: ReturnType<typeof setTimeout> | null = null;
    const report = () => {
      const { width, height } = surface.getBoundingClientRect();
      clientRef.current?.send({
        type: "resize",
        width: Math.round(width),
        height: Math.round(height),
      });
    };
    report();
    const observer = new ResizeObserver(() => {
      if (timer !== null) clearTimeout(timer);
      timer = setTimeout(report, RESIZE_SETTLE_MS);
    });
    observer.observe(surface);
    return () => {
      observer.disconnect();
      if (timer !== null) clearTimeout(timer);
    };
  }, [state, selectedTabId]);

  const send = useCallback((input: Parameters<ServerBrowserStreamClient["send"]>[0]) => {
    return clientRef.current?.send(input) ?? false;
  }, []);

  const pagePoint = useCallback((clientX: number, clientY: number) => {
    const canvas = canvasRef.current;
    if (!canvas) return null;
    const rect = canvas.getBoundingClientRect();
    return canvasPointToPage(
      { x: clientX - rect.left, y: clientY - rect.top },
      { width: rect.width, height: rect.height },
      viewportRef.current,
    );
  }, []);

  const onPointer = (
    event: React.PointerEvent<HTMLCanvasElement>,
    action: "down" | "up" | "move",
  ) => {
    if (!youControl) return;
    const point = pagePoint(event.clientX, event.clientY);
    if (!point) return;
    const modifiers = serverBrowserModifiers(event);
    if (action === "move" && event.buttons === 0) {
      // Hover is coalesced to one message per frame; the server merges further.
      pendingMoveRef.current = { ...point, modifiers };
      if (moveFrameRef.current === null) {
        moveFrameRef.current = requestAnimationFrame(() => {
          moveFrameRef.current = null;
          const move = pendingMoveRef.current;
          pendingMoveRef.current = null;
          if (move) {
            send({
              type: "mouse",
              action: "move",
              ...move,
              button: "none",
              buttons: 0,
              clickCount: 0,
            });
          }
        });
      }
      return;
    }
    // Touch reads as a phone expects: a drag scrolls the page, a tap clicks.
    if (event.pointerType === "touch") {
      event.preventDefault();
      const touch = touchRef.current;
      if (action === "down") {
        touchRef.current = { x: event.clientX, y: event.clientY, scrolled: false };
        event.currentTarget.setPointerCapture(event.pointerId);
        return;
      }
      if (!touch) return;
      if (action === "move") {
        const dx = touch.x - event.clientX;
        const dy = touch.y - event.clientY;
        if (!touch.scrolled && Math.hypot(dx, dy) < TOUCH_SLOP_PX) return;
        touchRef.current = { x: event.clientX, y: event.clientY, scrolled: true };
        send({ type: "wheel", ...point, deltaX: dx, deltaY: dy, modifiers: 0 });
        return;
      }
      touchRef.current = null;
      if (touch.scrolled) return;
      keyboardRef.current?.focus({ preventScroll: true });
      for (const press of ["down", "up"] as const) {
        send({
          type: "mouse",
          action: press,
          ...point,
          button: "left",
          buttons: press === "down" ? 1 : 0,
          clickCount: 1,
          modifiers: 0,
        });
      }
      return;
    }
    if (action === "down") {
      keyboardRef.current?.focus({ preventScroll: true });
      event.currentTarget.setPointerCapture(event.pointerId);
      const previous = clickRef.current;
      const now = performance.now();
      const repeat =
        previous !== null &&
        now - previous.at < MULTI_CLICK_MS &&
        Math.hypot(point.x - previous.x, point.y - previous.y) < MULTI_CLICK_SLOP_PX;
      clickRef.current = {
        x: point.x,
        y: point.y,
        at: now,
        count: repeat ? Math.min(3, previous.count + 1) : 1,
      };
    }
    const clickCount = action === "move" ? 0 : (clickRef.current?.count ?? 1);
    send({
      type: "mouse",
      action,
      x: point.x,
      y: point.y,
      button: action === "move" ? "none" : (BUTTON_NAMES[event.button] ?? "left"),
      buttons: event.buttons,
      clickCount,
      modifiers,
    });
  };

  // React's wheel listener is passive; the page must not scroll the panel instead.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const onWheel = (event: WheelEvent) => {
      if (!youControl) return;
      event.preventDefault();
      const point = pagePoint(event.clientX, event.clientY);
      if (!point) return;
      const lineScale = event.deltaMode === 1 ? 16 : event.deltaMode === 2 ? 800 : 1;
      send({
        type: "wheel",
        ...point,
        deltaX: event.deltaX * lineScale,
        deltaY: event.deltaY * lineScale,
        modifiers: serverBrowserModifiers(event),
      });
    };
    canvas.addEventListener("wheel", onWheel, { passive: false });
    return () => canvas.removeEventListener("wheel", onWheel);
  }, [pagePoint, send, youControl]);

  const onKey = (event: React.KeyboardEvent<HTMLTextAreaElement>, action: "down" | "up") => {
    // An IME composes in the hidden field and sends its text when it commits.
    if (!youControl || event.nativeEvent.isComposing || event.keyCode === 229) return;
    // Paste arrives as the paste event's text, not as a key.
    if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "v") return;
    event.preventDefault();
    const printable =
      event.key.length === 1 && !event.ctrlKey && !event.metaKey ? event.key : undefined;
    send({
      type: "key",
      action,
      key: event.key,
      code: event.code,
      keyCode: event.keyCode,
      modifiers: serverBrowserModifiers(event),
      ...(action === "down" && printable ? { text: printable } : {}),
    });
  };

  /** Read the picked files and hand them to the page, within the upload bound. */
  const sendPickedFiles = async (id: string, files: readonly File[]) => {
    const total = files.reduce((sum, file) => sum + file.size, 0);
    if (total > SERVER_BROWSER_UPLOAD_MAX_BYTES) {
      setNotice(t("browser.server.fileTooLarge"));
      return;
    }
    const encoded = await Promise.all(
      files.map(async (file) => ({
        name: file.name,
        mimeType: file.type,
        data: bytesToBase64(new Uint8Array(await file.arrayBuffer())),
      })),
    );
    if (send({ type: "fileChooserAnswer", id, files: encoded })) setChooser(null);
  };

  const addressDisplay = browserAddressDisplay(selectedTab?.url);
  const showAddressOverlay =
    !editingAddress &&
    !openingTab &&
    addressDisplay.kind !== "blank" &&
    address === selectedTab?.url;
  const submitAddress = (form: HTMLFormElement) => {
    const opening = openingTab || tabs.length === 0;
    const sent = opening
      ? send({ type: "open", url: address })
      : send({ type: "navigate", url: address });
    if (!sent) return;
    setOpeningTab(false);
    setEditingAddress(false);
    form.querySelector("input")?.blur();
  };

  const tabRow = (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-browser-tab-row="">
      <div
        role="tablist"
        aria-label={t("browser.server.tabs")}
        className="flex min-w-0 flex-1 items-center gap-1 overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden"
      >
        {tabs.map((tab) => {
          const title = tab.title.trim() || tab.url || t("browser.tabs.newTab");
          const onlyTab = tabs.length === 1;
          const marked = tab.tabId === selectedTabId && !onlyTab;
          return (
            <SurfaceTabChip
              key={tab.tabId}
              active={marked}
              title={title}
              label={
                <span className="pe-3" data-translation-skip="true">
                  {title}
                </span>
              }
              className={cn("shrink", marked ? "min-w-28" : onlyTab ? "min-w-0" : "min-w-20")}
              labelClassName="max-w-[11rem]"
              icon={
                tab.loading ? (
                  <LoaderCircleIcon
                    aria-hidden
                    className="size-4 animate-spin text-muted-foreground"
                  />
                ) : (
                  <GlobeIcon
                    aria-hidden
                    className="size-4 text-[var(--color-text-foreground-secondary)]"
                  />
                )
              }
              onSelect={() => send({ type: "selectTab", tabId: tab.tabId })}
              closePlacement="trailing"
              closeLabel={format("browser.tabs.close", { title })}
              onClose={
                control?.canOperate === false
                  ? undefined
                  : () => send({ type: "closeTab", tabId: tab.tabId })
              }
            />
          );
        })}
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.tabs.newTab")}
          tooltip={t("browser.tabs.newTab")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          disabled={state !== "connected" || control?.canOperate === false}
          onClick={() => {
            setOpeningTab(true);
            setAddress("");
            addressInputRef.current?.focus();
          }}
        >
          <PlusIcon className="size-4" />
        </IconButton>
      </div>
      <div className="flex shrink-0 items-center gap-1">
        {layout ? (
          <IconButton
            variant="chrome"
            size="icon-xs"
            label={layout.expanded ? t("rightDock.restorePanel") : t("rightDock.expandPanel")}
            tooltip={layout.expanded ? t("rightDock.restorePanel") : t("rightDock.expandPanel")}
            tooltipSide="bottom"
            className={DOCK_HEADER_ICON_BUTTON_CLASS}
            aria-pressed={layout.expanded}
            onClick={layout.onToggleExpanded}
          >
            {layout.expanded ? <Minimize2 className="size-4" /> : <Maximize2 className="size-4" />}
          </IconButton>
        ) : null}
        <IconButton
          variant="chrome"
          size="icon-xs"
          label={t("browser.panel.close")}
          tooltip={t("browser.panel.close")}
          tooltipSide="bottom"
          className={DOCK_HEADER_ICON_BUTTON_CLASS}
          onClick={onClosePanel}
        >
          <XIcon className="size-4" />
        </IconButton>
      </div>
    </div>
  );

  const navButton = (label: string, onClick: () => void, icon: React.ReactNode) => (
    <IconButton
      variant="chrome"
      size="icon-xs"
      label={label}
      tooltip={label}
      tooltipSide="bottom"
      className={DOCK_HEADER_ICON_BUTTON_CLASS}
      disabled={!youControl}
      onClick={onClick}
    >
      {icon}
    </IconButton>
  );

  const addressRow = (
    <div className="flex min-w-0 flex-1 items-center gap-1" data-browser-address-row="">
      <div className="flex shrink-0 items-center gap-0.5">
        {navButton(
          t("browser.nav.back"),
          () => send({ type: "history", delta: -1 }),
          <ArrowLeftIcon className="size-4" />,
        )}
        {navButton(
          t("browser.nav.forward"),
          () => send({ type: "history", delta: 1 }),
          <ArrowRightIcon className="size-4" />,
        )}
        {navButton(
          t("browser.nav.reload"),
          () => send({ type: "reload" }),
          <RefreshCwIcon className={cn("size-4", selectedTab?.loading && "animate-spin")} />,
        )}
      </div>
      <form
        className="relative min-w-0 flex-1"
        onSubmit={(event) => {
          event.preventDefault();
          submitAddress(event.currentTarget);
        }}
      >
        <input
          ref={addressInputRef}
          value={address}
          aria-label={t("browser.address.label")}
          placeholder={t("browser.address.placeholder")}
          spellCheck={false}
          autoComplete="off"
          readOnly={!addressEditable && !openingTab}
          onFocus={(event) => {
            if (!addressEditable && !openingTab) return;
            setEditingAddress(true);
            event.currentTarget.select();
          }}
          onBlur={() => {
            setEditingAddress(false);
            setOpeningTab(false);
          }}
          onKeyDown={(event) => {
            if (event.key === "Escape") event.currentTarget.blur();
          }}
          onChange={(event) => setAddress(event.target.value)}
          className={cn(
            "font-system-ui h-7 w-full min-w-0 rounded-control border border-[color:var(--color-border)] bg-transparent px-3 text-ui text-foreground outline-none transition-colors placeholder:text-muted-foreground/70",
            addressEditable || openingTab
              ? "hover:border-[color:var(--color-border-heavy)] focus:border-[color:var(--color-border-focus)] focus:bg-[var(--color-background-surface)]"
              : "cursor-default",
            showAddressOverlay ? "text-transparent caret-transparent" : "text-left",
          )}
        />
        {showAddressOverlay ? (
          <span
            aria-hidden
            className="pointer-events-none absolute inset-0 flex items-center justify-center overflow-hidden px-3 text-ui whitespace-nowrap"
          >
            <span className="flex min-w-0 max-w-full items-baseline" data-translation-skip="true">
              <span className="shrink-0 text-foreground">{addressDisplay.primary}</span>
              <span className="min-w-0 shrink truncate text-muted-foreground">
                {addressDisplay.secondary}
              </span>
            </span>
          </span>
        ) : null}
      </form>
    </div>
  );

  const showEmpty = state === "unavailable" || tabs.length === 0;
  const showControl = !showEmpty && control !== null && control.canOperate;

  return (
    <DiffPanelShell mode={mode} header={tabRow}>
      <div className="flex min-h-0 flex-1 flex-col" data-server-browser="">
        <div className={cn(CHAT_SURFACE_HEADER_ROW_CLASS_NAME, "gap-1.5 px-1.5")}>{addressRow}</div>
        <div ref={surfaceRef} className="relative min-h-0 flex-1 overflow-hidden outline-none">
          <textarea
            ref={keyboardRef}
            aria-hidden
            tabIndex={-1}
            readOnly={!youControl}
            autoCapitalize="off"
            autoCorrect="off"
            spellCheck={false}
            className="pointer-events-none absolute top-0 left-0 size-px resize-none opacity-0"
            onKeyDown={(event) => onKey(event, "down")}
            onKeyUp={(event) => onKey(event, "up")}
            onCompositionEnd={(event) => {
              if (youControl && event.data) send({ type: "text", text: event.data });
              event.currentTarget.value = "";
            }}
            onInput={(event) => {
              const field = event.currentTarget;
              const native = event.nativeEvent as InputEvent;
              if (native.isComposing) return;
              if (youControl && field.value) send({ type: "text", text: field.value });
              field.value = "";
            }}
            onPaste={(event) => {
              event.preventDefault();
              const text = event.clipboardData.getData("text/plain");
              if (youControl && text) send({ type: "text", text });
            }}
          />
          <canvas
            ref={canvasRef}
            aria-label={t("browser.previewAlt")}
            className={cn(
              "absolute inset-0 h-full w-full touch-none object-contain transition-opacity duration-[220ms] ease-out motion-reduce:transition-none",
              hasFrame && !showEmpty ? "opacity-100" : "opacity-0",
            )}
            onPointerCancel={() => {
              touchRef.current = null;
            }}
            onPointerDown={(event) => onPointer(event, "down")}
            // The press must not move focus off the hidden field that takes the keys.
            onMouseDown={(event) => {
              if (youControl) event.preventDefault();
            }}
            onPointerUp={(event) => onPointer(event, "up")}
            onPointerMove={(event) => onPointer(event, "move")}
            onContextMenu={(event) => {
              if (youControl) event.preventDefault();
            }}
          />
          {/* While you drive, a hairline in the accent marks the page as yours. */}
          <div
            aria-hidden
            className={cn(
              "pointer-events-none absolute inset-0 ring-1 ring-inset ring-[color:var(--color-border-focus)] transition-opacity duration-[220ms] ease-out motion-reduce:transition-none",
              youControl ? "opacity-100" : "opacity-0",
            )}
          />
          {showEmpty ? (
            <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 px-6 text-center">
              <GlobeIcon className="mb-1 size-5 text-muted-foreground" aria-hidden />
              <p className="text-ui font-medium text-foreground">
                {state === "unavailable"
                  ? t("browser.server.unavailable")
                  : t("browser.server.emptyTitle")}
              </p>
              {state !== "unavailable" ? (
                <p className="max-w-72 text-ui-sm text-muted-foreground">
                  {t("browser.server.emptyBody")}
                </p>
              ) : null}
            </div>
          ) : null}
          {youControl && dialog ? (
            <div className="absolute inset-0 flex items-center justify-center bg-[color-mix(in_srgb,var(--color-text-foreground)_8%,transparent)] px-4">
              <form
                role="alertdialog"
                aria-label={t("browser.server.pageSays")}
                className="flex w-full max-w-80 flex-col gap-3 rounded-popover border border-border bg-popover p-3 shadow-xl"
                onSubmit={(event) => {
                  event.preventDefault();
                  send({
                    type: "dialogAnswer",
                    id: dialog.id,
                    accept: true,
                    ...(dialog.kind === "prompt" ? { promptText } : {}),
                  });
                  setDialog(null);
                }}
              >
                <div className="flex flex-col gap-1">
                  <p className="text-ui font-medium text-foreground">
                    {t("browser.server.pageSays")}
                  </p>
                  <p className="max-h-40 overflow-auto text-ui-sm whitespace-pre-wrap text-muted-foreground">
                    {dialog.message}
                  </p>
                </div>
                {dialog.kind === "prompt" ? (
                  <Input
                    size="sm"
                    autoFocus
                    value={promptText}
                    aria-label={dialog.message}
                    onChange={(event) => setPromptText(event.target.value)}
                  />
                ) : null}
                <div className="flex justify-end gap-1.5">
                  {dialog.kind !== "alert" ? (
                    <Button
                      type="button"
                      variant="ghost"
                      size="xs"
                      onClick={() => {
                        send({ type: "dialogAnswer", id: dialog.id, accept: false });
                        setDialog(null);
                      }}
                    >
                      {t("browser.server.cancel")}
                    </Button>
                  ) : null}
                  <Button type="submit" size="xs" autoFocus={dialog.kind !== "prompt"}>
                    {t("browser.server.ok")}
                  </Button>
                </div>
              </form>
            </div>
          ) : null}
          {youControl && chooser ? (
            <div className="absolute inset-x-0 top-3 flex justify-center px-3">
              <div
                role="dialog"
                aria-label={t("browser.server.fileChooser")}
                className="flex items-center gap-1.5 rounded-popover border border-border bg-popover p-1 ps-3 text-ui shadow-xl"
              >
                <span className="me-1 text-foreground">{t("browser.server.fileChooser")}</span>
                <Button
                  variant="ghost"
                  size="xs"
                  onClick={() => {
                    send({ type: "fileChooserAnswer", id: chooser.id, files: [] });
                    setChooser(null);
                  }}
                >
                  {t("browser.server.cancel")}
                </Button>
                <Button size="xs" onClick={() => fileInputRef.current?.click()}>
                  {t("browser.server.chooseFile")}
                </Button>
                <input
                  ref={fileInputRef}
                  type="file"
                  hidden
                  multiple={chooser.multiple}
                  accept={chooser.accept || undefined}
                  onChange={(event) => {
                    const picked = [...(event.currentTarget.files ?? [])];
                    event.currentTarget.value = "";
                    if (picked.length === 0) return;
                    void sendPickedFiles(chooser.id, picked);
                  }}
                />
              </div>
            </div>
          ) : null}
          {download ? (
            <div className="absolute inset-x-0 top-3 flex justify-center px-3">
              <div
                role="status"
                className="flex max-w-full items-center gap-1.5 rounded-popover border border-border bg-popover p-1 ps-3 text-ui shadow-xl"
              >
                <DownloadIcon aria-hidden className="size-4 shrink-0 text-muted-foreground" />
                <span className="min-w-0 truncate text-foreground">
                  {format("browser.server.downloaded", { name: download.fileName })}
                </span>
                <Button
                  size="xs"
                  render={<a href={download.url} download={download.fileName} />}
                  onClick={() => setDownload(null)}
                >
                  {t("browser.server.save")}
                </Button>
                <IconButton
                  variant="ghost"
                  size="icon-xs"
                  label={t("browser.server.cancel")}
                  onClick={() => setDownload(null)}
                >
                  <XIcon className="size-4" />
                </IconButton>
              </div>
            </div>
          ) : null}
          {notice && !chooser && !download ? (
            <div className="pointer-events-none absolute inset-x-0 top-3 flex justify-center px-3">
              <p
                role="status"
                className="max-w-full truncate rounded-popover border border-border bg-popover px-3 py-1.5 text-ui-sm text-muted-foreground shadow-xl"
              >
                {notice}
              </p>
            </div>
          ) : null}
          <div
            className={cn(
              "pointer-events-none absolute inset-x-0 bottom-3 flex justify-center px-3 transition-[opacity,translate] duration-[220ms] ease-out motion-reduce:transition-none",
              showControl ? "translate-y-0 opacity-100" : "translate-y-1 opacity-0",
            )}
            data-server-browser-control=""
          >
            {showControl ? (
              <div
                className="pointer-events-auto flex items-center gap-1.5 rounded-popover border border-border bg-popover p-1 text-ui shadow-xl"
                role="group"
              >
                {state !== "connected" ? (
                  <span className="flex items-center gap-1.5 px-2 text-muted-foreground">
                    <LoaderCircleIcon aria-hidden className="size-4 animate-spin" />
                    {t("browser.server.reconnecting")}
                  </span>
                ) : youControl ? (
                  <>
                    <span className="flex items-center gap-1.5 ps-2 text-foreground">
                      <CursorClickIcon
                        aria-hidden
                        className="size-4 text-[var(--color-border-focus)]"
                      />
                      {t("browser.server.controlYou")}
                    </span>
                    <Button
                      variant="secondary"
                      size="xs"
                      onClick={() => {
                        setNotice(null);
                        send({ type: "releaseControl" });
                      }}
                    >
                      {t("browser.server.release")}
                    </Button>
                  </>
                ) : control?.controller === "another-viewer" ? (
                  <span className="px-2 text-muted-foreground">
                    {t("browser.server.controlOther")}
                  </span>
                ) : canTake ? (
                  <Button
                    variant="ghost"
                    size="xs"
                    onClick={() => {
                      setNotice(null);
                      if (send({ type: "takeControl" })) {
                        keyboardRef.current?.focus({ preventScroll: true });
                      }
                    }}
                  >
                    <CursorClickIcon aria-hidden className="size-4" />
                    {t("browser.server.take")}
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        </div>
      </div>
    </DiffPanelShell>
  );
}

/** Base64 for upload, in chunks so large files do not overflow the call stack. */
function bytesToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let index = 0; index < bytes.length; index += 0x8000) {
    binary += String.fromCharCode(...bytes.subarray(index, index + 0x8000));
  }
  return btoa(binary);
}
