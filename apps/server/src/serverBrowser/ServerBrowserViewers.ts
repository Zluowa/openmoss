/**
 * Viewers of a thread's server browser: one screencast per viewer, and the
 * person's input when they take control.
 *
 * Pacing: Chromium sends the next screencast frame only after the previous
 * one is acknowledged. The viewer acks each frame it received, and the hub
 * keeps at most one frame on the wire and only the newest waiting, acking
 * superseded frames without sending them. A slow link therefore lowers the
 * frame rate instead of queueing stale images, and a viewer whose socket
 * backlog grows past the cap is disconnected rather than buffered without end.
 *
 * Control: viewers watch freely; input is dispatched only for the viewer that
 * took control of that tab, through the tab's session control, so it never
 * interleaves with an agent action.
 *
 * @module ServerBrowserViewers
 */
import { randomUUID } from "node:crypto";

import {
  decodeServerBrowserViewerInput,
  type ServerBrowserStreamInput,
  type ServerBrowserStreamServerMessage,
} from "@moss/shared/serverBrowserStream";
import type { CDPSession, Frame as PageFrame } from "playwright";

import type {
  ServerBrowserRuntime,
  ServerBrowserTab,
  ServerBrowserThreadEvents,
} from "./ServerBrowserRuntime.ts";

/** Beyond this backlog the viewer stopped reading; drop it instead of buffering more. */
const MAX_VIEWER_BACKLOG_BYTES = 8 * 1024 * 1024;
/** Minimum spacing between acks: about 30 frames a second at most. */
const ACK_PACE_MS = 33;
/** Chromium can drop the last frame of a burst; send a still once it settles. */
const SETTLE_MS = 200;
/** A screencast that has sent nothing by now raced a navigation; start it again. */
const NO_FRAME_RETRY_MS = 1_000;
const NAVIGATION_TIMEOUT_MS = 30_000;

export interface ServerBrowserViewerTransport {
  readonly sendBinary: (data: Uint8Array) => void;
  readonly sendText: (text: string) => void;
  /** Bytes queued on the socket and not yet written. */
  readonly backlogBytes: () => number;
  readonly close: (code: number, reason: string) => void;
}

export interface ServerBrowserViewerOptions {
  readonly maxWidth: number;
  readonly maxHeight: number;
  readonly quality: number;
  /** False for viewers that may watch but never take control. */
  readonly canOperate: boolean;
  /**
   * Presence only: tabs and reveal requests, never frames. Not counted as
   * watching, so it never keeps a browser from being reclaimed.
   */
  readonly presence?: boolean;
}

export interface ServerBrowserViewerHandle {
  readonly receive: (raw: string | Uint8Array) => void;
  readonly detach: () => Promise<void>;
}

interface Frame {
  readonly data: Uint8Array;
  readonly ack: () => void;
}

interface Viewer {
  readonly id: string;
  readonly threadId: string;
  readonly transport: ServerBrowserViewerTransport;
  readonly options: ServerBrowserViewerOptions;
  /** The tab the viewer chose; `null` follows the agent's assignment. */
  chosenTabId: string | null;
  watching: { tab: ServerBrowserTab; session: CDPSession; stop: () => Promise<void> } | null;
  switching: Promise<void>;
  inFlight: (() => void) | null;
  pending: Frame | null;
  pressedKeys: Map<string, { key: string; code: string }>;
  pressedButtons: Map<string, { x: number; y: number }>;
  /** The held dialog and file picker this viewer was last told about. */
  shownDialogId: string | null;
  shownChooserId: string | null;
  closed: boolean;
}

const textDecoder = new TextDecoder();

export class ServerBrowserViewerHub {
  private readonly viewers = new Map<string, Set<Viewer>>();

  constructor(private readonly runtime: ServerBrowserRuntime) {
    const events: ServerBrowserThreadEvents = {
      tabsChanged: (threadId) => this.onTabsChanged(threadId),
      controlChanged: (threadId, tabId) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          if (viewer.watching?.tab.tabId === tabId) this.sendControl(viewer);
        }
      },
      dialog: (threadId, tabId, dialog) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          if (viewer.watching?.tab.tabId === tabId) {
            this.send(viewer, {
              type: "dialog",
              kind: dialog.kind,
              message: dialog.message,
              action: dialog.action,
            });
          }
        }
      },
      threadClosed: (threadId) => this.onTabsChanged(threadId),
      reveal: (threadId, tabId) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          // A watching viewer follows the agent to the page it asked to show.
          if (!viewer.options.presence) {
            viewer.chosenTabId = null;
            this.retarget(viewer);
          }
          this.send(viewer, { type: "reveal", tabId });
        }
      },
      pendingChanged: (threadId, tabId) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          if (viewer.watching?.tab.tabId === tabId) this.sendPending(viewer);
        }
      },
      download: (threadId, tabId, download) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          const tab = viewer.watching?.tab;
          if (tab?.tabId === tabId && tab.control.controller === viewer.id) {
            this.send(viewer, { type: "download", ...download });
          }
        }
      },
      navigationBlocked: (threadId, tabId, host) => {
        for (const viewer of this.viewers.get(threadId) ?? []) {
          if (!viewer.options.presence && viewer.watching?.tab.tabId === tabId) {
            this.send(viewer, { type: "navigationBlocked", host });
          }
        }
      },
    };
    runtime.setEvents(events);
  }

  attach(
    threadId: string,
    transport: ServerBrowserViewerTransport,
    options: ServerBrowserViewerOptions,
  ): ServerBrowserViewerHandle {
    const viewer: Viewer = {
      id: randomUUID(),
      threadId,
      transport,
      options: {
        maxWidth: clamp(options.maxWidth, 1, 3_840),
        maxHeight: clamp(options.maxHeight, 1, 2_160),
        quality: clamp(options.quality, 1, 100),
        canOperate: options.canOperate,
        presence: options.presence === true,
      },
      chosenTabId: null,
      watching: null,
      switching: Promise.resolve(),
      inFlight: null,
      pending: null,
      pressedKeys: new Map(),
      pressedButtons: new Map(),
      shownDialogId: null,
      shownChooserId: null,
      closed: false,
    };
    let set = this.viewers.get(threadId);
    if (!set) {
      set = new Set();
      this.viewers.set(threadId, set);
    }
    set.add(viewer);
    if (!viewer.options.presence) this.runtime.viewerAttached(threadId, 1);
    this.sendTabs(viewer);
    this.retarget(viewer);
    return {
      receive: (raw) => this.receive(viewer, raw),
      detach: () => this.detach(viewer),
    };
  }

  private send(viewer: Viewer, message: ServerBrowserStreamServerMessage): void {
    if (viewer.closed) return;
    const text = JSON.stringify(message);
    if (!this.hasRoom(viewer, text.length)) return;
    viewer.transport.sendText(text);
  }

  private hasRoom(viewer: Viewer, bytes: number): boolean {
    if (viewer.transport.backlogBytes() + bytes <= MAX_VIEWER_BACKLOG_BYTES) return true;
    viewer.transport.close(1013, "viewer too slow");
    void this.detach(viewer);
    return false;
  }

  private selectedTabId(viewer: Viewer): string | null {
    const thread = this.runtime.thread(viewer.threadId);
    if (viewer.chosenTabId && thread?.tabs.has(viewer.chosenTabId)) return viewer.chosenTabId;
    return this.runtime.defaultTabId(viewer.threadId);
  }

  private sendTabs(viewer: Viewer): void {
    const thread = this.runtime.thread(viewer.threadId);
    const tabs = thread
      ? [...thread.tabs.values()].map((tab) => ({
          tabId: tab.tabId,
          title: this.runtime.titleOf(tab),
          url: tab.page.url() || "about:blank",
          loading: tab.loading,
        }))
      : [];
    this.send(viewer, { type: "tabs", tabs, selectedTabId: this.selectedTabId(viewer) });
  }

  /** Tell the viewer what its tab holds for the person in control, and what stopped waiting. */
  private sendPending(viewer: Viewer): void {
    const tab = viewer.watching?.tab;
    const dialog = tab?.pendingDialog ?? null;
    if (dialog && viewer.shownDialogId !== dialog.id) {
      viewer.shownDialogId = dialog.id;
      this.send(viewer, {
        type: "dialogOpen",
        id: dialog.id,
        kind: dialog.kind,
        message: dialog.message,
        defaultPrompt: dialog.defaultPrompt,
      });
    } else if (!dialog && viewer.shownDialogId) {
      this.send(viewer, { type: "dialogClosed", id: viewer.shownDialogId });
      viewer.shownDialogId = null;
    }
    const chooser = tab?.pendingChooser ?? null;
    if (chooser && viewer.shownChooserId !== chooser.id) {
      viewer.shownChooserId = chooser.id;
      this.send(viewer, {
        type: "fileChooser",
        id: chooser.id,
        multiple: chooser.multiple,
        accept: chooser.accept,
      });
    } else if (!chooser && viewer.shownChooserId) {
      this.send(viewer, { type: "fileChooserClosed", id: viewer.shownChooserId });
      viewer.shownChooserId = null;
    }
  }

  private sendControl(viewer: Viewer): void {
    const tab = viewer.watching?.tab;
    if (!tab) return;
    const owner = tab.control.controller;
    this.send(viewer, {
      type: "control",
      canOperate: viewer.options.canOperate,
      controller: owner === null ? "agent" : owner === viewer.id ? "you" : "another-viewer",
      generation: tab.control.generation,
    });
  }

  private onTabsChanged(threadId: string): void {
    for (const viewer of this.viewers.get(threadId) ?? []) {
      this.sendTabs(viewer);
      this.retarget(viewer);
    }
  }

  /** Watch the tab the viewer should see, switching screencasts when it changed. */
  private retarget(viewer: Viewer): void {
    if (viewer.options.presence) return;
    viewer.switching = viewer.switching.then(async () => {
      if (viewer.closed) return;
      const tabId = this.selectedTabId(viewer);
      if (viewer.watching?.tab.tabId === tabId && !viewer.watching.tab.page.isClosed()) return;
      await this.stopWatching(viewer);
      const tab = tabId ? this.runtime.thread(viewer.threadId)?.tabs.get(tabId) : undefined;
      if (!tab || viewer.closed) return;
      try {
        await this.startWatching(viewer, tab);
      } catch {
        // The tab closed while the screencast started; the next tabs change retargets.
      }
    });
  }

  private async stopWatching(viewer: Viewer): Promise<void> {
    const watching = viewer.watching;
    viewer.watching = null;
    if (!watching) return;
    await watching.tab.control
      .disconnect(viewer.id, () => this.releaseInput(viewer, watching.session))
      .catch(() => undefined);
    await watching.stop();
    this.sendPending(viewer);
    viewer.inFlight?.();
    viewer.inFlight = null;
    viewer.pending?.ack();
    viewer.pending = null;
  }

  private async startWatching(viewer: Viewer, tab: ServerBrowserTab): Promise<void> {
    const session = await tab.page.context().newCDPSession(tab.page);
    let lastFrameAt = 0;
    let settleTimer: ReturnType<typeof setTimeout> | null = null;
    let stopped = false;
    // A settled page sends one still. It queues behind a frame in flight rather
    // than being skipped: the last screencast frame of a burst (a resize, a
    // reflow) can be blank, and the still is what replaces it.
    const pushStill = async () => {
      if (stopped) return;
      const shot = (await session
        .send("Page.captureScreenshot", { format: "jpeg", quality: viewer.options.quality })
        .catch(() => null)) as { data?: string } | null;
      if (shot?.data && !stopped)
        this.pushFrame(viewer, { data: Buffer.from(shot.data, "base64"), ack: () => {} });
    };
    session.on("Page.screencastFrame", (frame) => {
      if (stopped) return;
      const arrivedAt = Date.now();
      lastFrameAt = arrivedAt;
      if (settleTimer !== null) clearTimeout(settleTimer);
      settleTimer = setTimeout(() => {
        settleTimer = null;
        void pushStill();
      }, SETTLE_MS);
      this.pushFrame(viewer, {
        data: Buffer.from(frame.data, "base64"),
        ack: () => {
          const wait = Math.max(0, arrivedAt + ACK_PACE_MS - Date.now());
          setTimeout(() => {
            if (!stopped) {
              void session
                .send("Page.screencastFrameAck", { sessionId: frame.sessionId })
                .catch(() => undefined);
            }
          }, wait);
        },
      });
    });
    const startScreencast = () =>
      session.send("Page.startScreencast", {
        format: "jpeg",
        quality: viewer.options.quality,
        maxWidth: viewer.options.maxWidth,
        maxHeight: viewer.options.maxHeight,
      });
    // A navigation can move the page to a new renderer, which drops the
    // screencast without a word. Start it again once the page has committed,
    // and send a still in case the new page is already idle.
    const onNavigated = (frame: PageFrame) => {
      if (stopped || frame !== tab.page.mainFrame()) return;
      void startScreencast().catch(() => undefined);
      setTimeout(() => void pushStill(), SETTLE_MS);
    };
    tab.page.on("framenavigated", onNavigated);
    // Nothing arrived at all (the start raced a navigation): try once more.
    const watchdog = setTimeout(() => {
      if (stopped || lastFrameAt !== 0) return;
      void startScreencast().catch(() => undefined);
      void pushStill();
    }, NO_FRAME_RETRY_MS);
    viewer.watching = {
      tab,
      session,
      stop: async () => {
        stopped = true;
        if (settleTimer !== null) clearTimeout(settleTimer);
        clearTimeout(watchdog);
        tab.page.off("framenavigated", onNavigated);
        await session.send("Page.stopScreencast").catch(() => undefined);
        await session.detach().catch(() => undefined);
      },
    };
    const viewport = tab.page.viewportSize();
    if (viewport)
      this.send(viewer, { type: "viewport", width: viewport.width, height: viewport.height });
    this.sendControl(viewer);
    this.sendPending(viewer);
    await startScreencast();
    // An idle page does not repaint for a new screencast: start from a still.
    setTimeout(() => {
      if (lastFrameAt === 0) void pushStill();
    }, 150);
  }

  private pushFrame(viewer: Viewer, frame: Frame): void {
    if (viewer.closed) {
      frame.ack();
      return;
    }
    if (viewer.inFlight === null) {
      if (!this.hasRoom(viewer, frame.data.byteLength)) {
        frame.ack();
        return;
      }
      viewer.inFlight = frame.ack;
      viewer.transport.sendBinary(frame.data);
      return;
    }
    // Never sent, but Chromium still waits for its ack.
    viewer.pending?.ack();
    viewer.pending = frame;
  }

  private onAck(viewer: Viewer): void {
    const ack = viewer.inFlight;
    viewer.inFlight = null;
    ack?.();
    const next = viewer.pending;
    viewer.pending = null;
    if (next) this.pushFrame(viewer, next);
  }

  private receive(viewer: Viewer, raw: string | Uint8Array): void {
    if (viewer.closed) return;
    const input = decodeServerBrowserViewerInput(
      typeof raw === "string" ? raw : textDecoder.decode(raw),
    );
    if (!input) return;
    if (input.type === "ack") {
      this.onAck(viewer);
      return;
    }
    if (input.type === "resize") {
      void viewer.switching.then(() => this.fitToViewer(viewer, input.width, input.height));
      return;
    }
    if (input.type === "selectTab") {
      viewer.chosenTabId = input.tabId;
      this.sendTabs(viewer);
      this.retarget(viewer);
      return;
    }
    if (!viewer.options.canOperate || viewer.options.presence) return;
    if (input.type === "closeTab") {
      void this.runtime.closeTabForViewer(viewer.threadId, input.tabId, viewer.id);
      return;
    }
    if (input.type === "open") {
      const url = normalizeAddress(input.url);
      if (!url) return;
      void (async () => {
        const host = await this.runtime.refusedHost(url);
        if (host !== null) {
          this.send(viewer, { type: "navigationBlocked", host });
          return;
        }
        const tabId = await this.runtime.openTabForViewer(viewer.threadId, url);
        viewer.chosenTabId = tabId;
        this.sendTabs(viewer);
        this.retarget(viewer);
      })().catch(() =>
        this.send(viewer, { type: "error", message: "The page could not be opened." }),
      );
      return;
    }
    void viewer.switching
      .then(() => this.operate(viewer, input))
      .catch(() => this.sendControl(viewer));
  }

  /**
   * Size the page to the viewer's panel so it fills it. Watching is enough:
   * the size is presentation, not input. A tab the agent sized keeps its size.
   */
  private async fitToViewer(viewer: Viewer, width: number, height: number): Promise<void> {
    const tab = viewer.watching?.tab;
    if (!tab || tab.viewportPinned || tab.page.isClosed()) return;
    const next = { width: clamp(width, 320, 3_840), height: clamp(height, 240, 2_160) };
    const current = tab.page.viewportSize();
    if (current?.width === next.width && current.height === next.height) return;
    await tab.page.setViewportSize(next).catch(() => undefined);
    for (const other of this.viewers.get(viewer.threadId) ?? []) {
      if (other.watching?.tab === tab) this.send(other, { type: "viewport", ...next });
    }
  }

  private async operate(viewer: Viewer, input: ServerBrowserStreamInput): Promise<void> {
    const watching = viewer.watching;
    if (!watching) return;
    const { tab, session } = watching;
    const control = tab.control;
    switch (input.type) {
      case "takeControl": {
        this.runtime.interruptAgent(tab);
        const taking = control.take(viewer.id);
        this.sendControl(viewer);
        await taking;
        return;
      }
      case "releaseControl": {
        const releasing = control.release(viewer.id, () => this.releaseInput(viewer, session));
        this.sendControl(viewer);
        await releasing;
        return;
      }
      case "mouse": {
        const dispatch = (message: typeof input) => this.dispatchMouse(viewer, session, message);
        if (input.action === "move" && input.button === "none" && input.buttons === 0) {
          await control.humanLatest(viewer.id, `hover:${input.modifiers}`, input, dispatch);
        } else {
          await control.human(viewer.id, () => dispatch(input));
        }
        return;
      }
      case "wheel":
        await control.humanLatest(
          viewer.id,
          `wheel:${input.modifiers}:${Math.sign(input.deltaX)}:${Math.sign(input.deltaY)}`,
          input,
          async (message) => {
            await session.send("Input.dispatchMouseEvent", {
              type: "mouseWheel",
              x: message.x,
              y: message.y,
              deltaX: message.deltaX,
              deltaY: message.deltaY,
              modifiers: message.modifiers,
            });
          },
          (waiting, next) => ({
            ...next,
            deltaX: waiting.deltaX + next.deltaX,
            deltaY: waiting.deltaY + next.deltaY,
          }),
        );
        return;
      case "key":
        await control.human(viewer.id, async () => {
          if (input.action === "up") {
            await session.send("Input.dispatchKeyEvent", {
              type: "keyUp",
              key: input.key,
              code: input.code,
              modifiers: input.modifiers,
            });
            viewer.pressedKeys.delete(input.code || input.key);
            return;
          }
          // Editing shortcuts run as commands, so Command on a Mac viewer works on
          // a Linux server too, and a copy reaches the viewer's own clipboard.
          const command = editingCommand(input.key, input.modifiers);
          await session.send("Input.dispatchKeyEvent", {
            type: input.text ? "keyDown" : "rawKeyDown",
            key: input.key,
            code: input.code,
            modifiers: input.modifiers,
            ...(input.text ? { text: input.text, unmodifiedText: input.text } : {}),
            ...(command ? { commands: [command] } : {}),
            windowsVirtualKeyCode:
              input.keyCode ?? (input.key.length === 1 ? input.key.toUpperCase().charCodeAt(0) : 0),
          });
          viewer.pressedKeys.set(input.code || input.key, { key: input.key, code: input.code });
          if (command === "copy" || command === "cut") {
            const text = await tab.page.evaluate(SELECTED_TEXT_SCRIPT).catch(() => "");
            if (typeof text === "string" && text.length > 0) {
              this.send(viewer, { type: "clipboard", text: text.slice(0, 1_000_000) });
            }
          }
        });
        return;
      case "dialogAnswer":
        await this.runtime.answerDialog(tab, viewer.id, input.id, input.accept, input.promptText);
        return;
      case "fileChooserAnswer":
        await this.runtime.answerFileChooser(
          viewer.threadId,
          tab,
          viewer.id,
          input.id,
          input.files,
        );
        return;
      case "text":
        await control.human(viewer.id, () =>
          session.send("Input.insertText", { text: input.text }).then(() => undefined),
        );
        return;
      case "navigate": {
        const url = normalizeAddress(input.url);
        if (!url) return;
        await control.human(viewer.id, async () => {
          const host = await this.runtime.refusedHost(url);
          if (host !== null) {
            this.send(viewer, { type: "navigationBlocked", host });
            return;
          }
          control.trackUntilHandoff(
            tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: NAVIGATION_TIMEOUT_MS }),
          );
        });
        return;
      }
      case "history":
        await control.human(viewer.id, async () => {
          control.trackUntilHandoff(
            input.delta < 0
              ? tab.page.goBack({ timeout: NAVIGATION_TIMEOUT_MS })
              : tab.page.goForward({ timeout: NAVIGATION_TIMEOUT_MS }),
          );
        });
        return;
      case "reload":
        await control.human(viewer.id, async () => {
          control.trackUntilHandoff(tab.page.reload({ timeout: NAVIGATION_TIMEOUT_MS }));
        });
        return;
      case "open":
      case "resize":
      case "closeTab":
        return;
    }
  }

  private async dispatchMouse(
    viewer: Viewer,
    session: CDPSession,
    input: Extract<ServerBrowserStreamInput, { type: "mouse" }>,
  ): Promise<void> {
    const type =
      input.action === "down"
        ? "mousePressed"
        : input.action === "up"
          ? "mouseReleased"
          : "mouseMoved";
    await session.send("Input.dispatchMouseEvent", {
      type,
      x: input.x,
      y: input.y,
      button: input.button,
      buttons: input.buttons,
      clickCount: type === "mouseMoved" ? 0 : Math.max(1, input.clickCount),
      modifiers: input.modifiers,
    });
    if (input.button !== "none") {
      if (input.action === "down")
        viewer.pressedButtons.set(input.button, { x: input.x, y: input.y });
      else if (input.action === "up") viewer.pressedButtons.delete(input.button);
    }
  }

  /** Lift anything the viewer still holds, so the agent never inherits a held key. */
  private async releaseInput(viewer: Viewer, session: CDPSession): Promise<void> {
    for (const { key, code } of viewer.pressedKeys.values()) {
      await session
        .send("Input.dispatchKeyEvent", { type: "keyUp", key, code })
        .catch(() => undefined);
    }
    viewer.pressedKeys.clear();
    for (const [button, point] of viewer.pressedButtons) {
      await session
        .send("Input.dispatchMouseEvent", {
          type: "mouseReleased",
          button: button as "left" | "middle" | "right",
          x: point.x,
          y: point.y,
          buttons: 0,
          clickCount: 1,
        })
        .catch(() => undefined);
    }
    viewer.pressedButtons.clear();
  }

  private async detach(viewer: Viewer): Promise<void> {
    if (viewer.closed) return;
    viewer.closed = true;
    const set = this.viewers.get(viewer.threadId);
    set?.delete(viewer);
    if (set?.size === 0) this.viewers.delete(viewer.threadId);
    if (!viewer.options.presence) this.runtime.viewerAttached(viewer.threadId, -1);
    await viewer.switching.catch(() => undefined);
    await this.stopWatching(viewer);
  }
}

/** CDP editing commands for the shortcuts a viewer may press with Ctrl or Command. */
const EDITING_COMMANDS: Readonly<Record<string, string>> = {
  a: "selectAll",
  c: "copy",
  x: "cut",
  z: "undo",
  y: "redo",
};

function editingCommand(key: string, modifiers: number): string | undefined {
  const ctrlOrMeta = (modifiers & 2) !== 0 || (modifiers & 4) !== 0;
  if (!ctrlOrMeta || key.length !== 1) return undefined;
  const lower = key.toLowerCase();
  if (lower === "z" && (modifiers & 8) !== 0) return "redo";
  return EDITING_COMMANDS[lower];
}

/** The page's selected text: a field's selection, else the document's. */
const SELECTED_TEXT_SCRIPT = `(() => {
  const active = document.activeElement;
  if (active && (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)) {
    const start = active.selectionStart ?? 0;
    const end = active.selectionEnd ?? 0;
    if (end > start) return active.value.slice(start, end);
  }
  return String(window.getSelection() ?? "");
})()`;

function clamp(value: number, min: number, max: number): number {
  return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : min;
}

/** An address typed into the viewer: a URL, or a bare host that gets https. */
function normalizeAddress(value: string): string | null {
  const trimmed = value.trim();
  if (!trimmed) return null;
  const local = /^(?:localhost|127(?:\.\d{1,3}){3}|\[::1\]|0\.0\.0\.0)(?::\d+)?(?:[/?#]|$)/iu.test(
    trimmed,
  );
  const candidate = /^[a-z][a-z0-9+.-]*:\/\//iu.test(trimmed)
    ? trimmed
    : `${local ? "http" : "https"}://${trimmed}`;
  try {
    const url = new URL(candidate);
    return url.protocol === "http:" || url.protocol === "https:" ? url.toString() : null;
  } catch {
    return null;
  }
}
