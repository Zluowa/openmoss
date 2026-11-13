/**
 * The agent's browser when no desktop app hosts one: headless Chromium on the
 * server, one process per thread, streamed to any viewer that opens the thread.
 *
 * A Moss server reached over SSH, opened from the web client or watched from a
 * phone has no Electron webview to drive. This runtime gives those threads the
 * same `browser_*` tools: simple tools run on Playwright directly, and
 * `browser_run` runs the same Betterwright script engine the desktop uses,
 * attached over CDP to the thread's own browser.
 *
 * Isolation and lifetime:
 * - One Chromium process per thread. A Betterwright worker attached to it sees
 *   that thread's tabs only, and a crash takes down one thread's browser.
 * - Bounded: at most `maxThreads` browsers and `maxTabsPerThread` tabs; the
 *   least recently used browser without viewers is closed to make room, and
 *   idle browsers are closed after `idleMs`.
 *
 * Reach:
 * - Pages load from the public web only. Every top-level and frame document
 *   request, redirects included, is checked against the server's own machine
 *   and private networks before it leaves (`serverBrowserDocumentGuard.ts`,
 *   `serverBrowserNavigationGuard.ts`).
 *
 * Control:
 * - Every tab carries a {@link BrowserSessionControl}. A viewer taking control
 *   aborts the agent action in flight and refuses the agent's next action with
 *   `BrowserInterruptedByHuman` until the viewer releases it.
 *
 * Streaming and viewer input live in `ServerBrowserViewers.ts`.
 *
 * @module ServerBrowserRuntime
 */
import { randomUUID } from "node:crypto";
import { createServer } from "node:net";
import * as FS from "node:fs/promises";
import { tmpdir } from "node:os";
import * as Path from "node:path";

import type { BrowserErrorCode, BrowserToolName } from "@moss/contracts";
import {
  BrowserControlRefusedError,
  BrowserSessionControl,
} from "@moss/shared/browserSessionControl";
import { makeBrowserMcpToolErrorEnvelope } from "@moss/shared/browserAutomationErrors";
import {
  SERVER_BROWSER_DOWNLOAD_PATH,
  SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM,
} from "@moss/shared/serverBrowserStream";
import type { Browser, BrowserContext, Page, Request as PlaywrightRequest } from "playwright";

import { BrowserHostRpcError } from "../browserAutomation/browserHostRpcClient.ts";

import {
  guardServerBrowserDocuments,
  type ServerBrowserDocumentGuard,
} from "./serverBrowserDocumentGuard.ts";
import { isServerBrowserNavigable, serverBrowserHost } from "./serverBrowserNavigationGuard.ts";

export const SERVER_BROWSER_DEFAULT_VIEWPORT = { width: 1280, height: 800 } as const;
const MAX_LOG_ENTRIES = 500;
const MAX_DIALOG_EVENTS = 20;
const MAX_REDIRECTS = 20;
const MAX_URL_LENGTH = 8_192;
const MAX_TITLE_LENGTH = 2_048;
const MAX_SCREENSHOT_HEIGHT = 16_384;
const MAX_RUN_RESULT_BYTES = 262_144;
const MAX_UPLOAD_FILE_BYTES = 100 * 1024 * 1024;

export interface ServerBrowserLaunched {
  readonly browser: Browser;
  /** The browser-level CDP endpoint Betterwright attaches to. */
  readonly cdpUrl: string;
}

export interface ServerBrowserRuntimeOptions {
  /** Resolve (installing when needed) the Chromium executable to launch. */
  readonly resolveExecutable: () => Promise<string>;
  /** Betterwright's home: worker state, never a browser profile. */
  readonly betterwrightHome: string;
  /** Where files a person uploads to or downloads from a page are kept. */
  readonly filesDir?: string;
  readonly maxThreads?: number;
  readonly maxTabsPerThread?: number;
  readonly idleMs?: number;
  /**
   * Whether a page may load `url`; defaults to public web addresses only.
   * Tests widen it to their own loopback fixture.
   */
  readonly navigationGuard?: (url: URL) => Promise<boolean>;
  /** Test seam; defaults to launching `executable` with a loopback CDP port. */
  readonly launch?: (executable: string) => Promise<ServerBrowserLaunched>;
  /** Test seam for `browser_run`; defaults to Betterwright on a single-tab lease. */
  readonly runScript?: (input: {
    readonly cdpUrl: string;
    readonly targetId: string;
    readonly code: string;
    readonly timeoutMs: number;
    readonly signal: AbortSignal;
  }) => Promise<unknown>;
  readonly now?: () => number;
}

export interface ServerBrowserExecuteInput {
  readonly threadId: string;
  readonly name: BrowserToolName;
  readonly arguments: Record<string, unknown>;
  readonly workspaceRoot?: string;
  readonly timeoutMs: number;
  readonly signal?: AbortSignal;
}

type LogEntry =
  | {
      readonly kind: "console";
      readonly timestamp: string;
      readonly level: "debug" | "info" | "log" | "warn" | "error" | "exception";
      readonly text: string;
      readonly url?: string;
      readonly lineNumber?: number;
      readonly columnNumber?: number;
    }
  | {
      readonly kind: "network";
      readonly timestamp: string;
      readonly phase: "request" | "response" | "failure";
      readonly requestId: string;
      readonly url: string;
      readonly method: string;
      readonly status?: number;
      readonly mimeType?: string;
      readonly errorText?: string;
      readonly durationMs?: number;
    };

interface DialogEvent {
  readonly kind: "alert" | "confirm" | "prompt" | "beforeunload";
  readonly message: string;
  readonly defaultPrompt?: string;
  readonly action: "accepted" | "dismissed";
  readonly openedAt: string;
}

export interface ServerBrowserTab {
  readonly tabId: string;
  readonly page: Page;
  readonly control: BrowserSessionControl;
  readonly startedAt: string;
  readonly logs: LogEntry[];
  droppedLogs: number;
  dialogs: DialogEvent[];
  loading: boolean;
  /** The agent set this tab's size; viewers no longer resize it to their panel. */
  viewportPinned: boolean;
  /** The agent action in flight, aborted when a viewer takes control. */
  agentAbort: AbortController | null;
  pendingDialog: ServerBrowserPendingDialog | null;
  pendingChooser: ServerBrowserPendingChooser | null;
  /** The host of the last document request refused on this tab. */
  blockedHost: string | null;
}

export interface ServerBrowserThread {
  readonly threadId: string;
  readonly browser: Browser;
  readonly context: BrowserContext;
  readonly cdpUrl: string;
  /** Checks every document request of this browser before it leaves. */
  readonly guard: ServerBrowserDocumentGuard;
  readonly tabs: Map<string, ServerBrowserTab>;
  assignedTabId: string | null;
  lastUsedAt: number;
}

export interface ServerBrowserThreadEvents {
  /** Tabs opened, closed, retitled or navigated. */
  readonly tabsChanged: (threadId: string) => void;
  /** A tab's control owner changed. */
  readonly controlChanged: (threadId: string, tabId: string) => void;
  /** A dialog was answered on a tab. */
  readonly dialog: (threadId: string, tabId: string, dialog: DialogEvent) => void;
  /** The thread's browser closed (idle, evicted, crashed or disposed). */
  readonly threadClosed: (threadId: string) => void;
  /** The agent opened a page and asked for it to be shown. */
  readonly reveal: (threadId: string, tabId: string) => void;
  /** A dialog or file picker now waits for, or no longer waits for, the person in control. */
  readonly pendingChanged: (threadId: string, tabId: string) => void;
  /** The person in control downloaded a file. */
  readonly download: (threadId: string, tabId: string, download: ServerBrowserDownload) => void;
  /** A page load on a tab was refused: `host` is on the server's machine or network. */
  readonly navigationBlocked: (threadId: string, tabId: string, host: string) => void;
}

export interface ServerBrowserDownload {
  readonly fileName: string;
  readonly sizeBytes: number;
  /** The one-time path that serves it. */
  readonly path: string;
}

const noopEvents: ServerBrowserThreadEvents = {
  tabsChanged: () => {},
  controlChanged: () => {},
  dialog: () => {},
  threadClosed: () => {},
  reveal: () => {},
  pendingChanged: () => {},
  download: () => {},
  navigationBlocked: () => {},
};

/** A page dialog held for the person in control, answered from their viewer. */
export interface ServerBrowserPendingDialog {
  readonly id: string;
  readonly kind: DialogEvent["kind"];
  readonly message: string;
  readonly defaultPrompt: string;
  readonly answer: (accept: boolean, promptText?: string) => Promise<void>;
}

/** A page file picker held for the person in control. */
export interface ServerBrowserPendingChooser {
  readonly id: string;
  readonly multiple: boolean;
  readonly accept: string;
  readonly answer: (paths: readonly string[]) => Promise<void>;
}

/** How long a held dialog waits for the person before it is dismissed. */
const PENDING_DIALOG_TIMEOUT_MS = 60_000;
/** How long a download stays fetchable: long enough to press Save, no longer. */
export const SERVER_BROWSER_DOWNLOAD_TTL_MS = 2 * 60_000;

/** A browser tool failure in the gateway's own error dialect. */
export function serverBrowserError(
  code: BrowserErrorCode,
  options: {
    readonly retryable?: boolean;
    readonly phase?:
      | "routing"
      | "runtime"
      | "navigation"
      | "snapshot"
      | "target"
      | "input"
      | "evaluate"
      | "cleanup";
    readonly effectMayHaveCommitted?: boolean;
    readonly tabId?: string;
  } = {},
): BrowserHostRpcError {
  const envelope = makeBrowserMcpToolErrorEnvelope({
    code,
    retryable: options.retryable ?? false,
    phase: options.phase ?? "runtime",
    effectMayHaveCommitted: options.effectMayHaveCommitted ?? false,
    ...(options.tabId ? { tabId: options.tabId as never } : {}),
  } as Parameters<typeof makeBrowserMcpToolErrorEnvelope>[0]);
  return new BrowserHostRpcError("remote", envelope.error.message, envelope);
}

const bounded = (value: string, max: number): string =>
  value.length <= max ? value : value.slice(0, max);

const urlOf = (page: Page): string => bounded(page.url() || "about:blank", MAX_URL_LENGTH);

function freeLoopbackPort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.unref();
    server.on("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port > 0 ? resolve(port) : reject(new Error("No free port."))));
    });
  });
}

async function readCdpUrl(port: number, signal: AbortSignal): Promise<string> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    signal.throwIfAborted();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/json/version`, { signal });
      const body = (await response.json()) as { webSocketDebuggerUrl?: unknown };
      if (typeof body.webSocketDebuggerUrl === "string") return body.webSocketDebuggerUrl;
    } catch {
      // Not listening yet.
    }
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  throw new Error("The server browser did not expose its DevTools endpoint.");
}

/** Launch headless Chromium with a loopback-only CDP endpoint for Betterwright. */
export async function launchServerBrowser(executable: string): Promise<ServerBrowserLaunched> {
  const { chromium } = await import("playwright");
  const port = await freeLoopbackPort();
  const browser = await chromium.launch({
    executablePath: executable,
    headless: true,
    args: [
      "--no-first-run",
      "--no-default-browser-check",
      "--disable-gpu",
      "--mute-audio",
      `--remote-debugging-port=${port}`,
      "--remote-debugging-address=127.0.0.1",
    ],
  });
  try {
    const cdpUrl = await readCdpUrl(port, AbortSignal.timeout(10_000));
    return { browser, cdpUrl };
  } catch (error) {
    await browser.close().catch(() => undefined);
    throw error;
  }
}

/** Thrown inside a run when Betterwright attached to a tab other than the leased one. */
const WRONG_TAB_SENTINEL = "moss-server-browser-wrong-tab";

/**
 * The run's first statement: refuse unless the page is the leased tab, so a
 * worker that attached to a sibling tab stops before its first action. The
 * marker is the tab's random id, which no other tab's page can know.
 */
export function guardedRunCode(code: string, marker: string): string {
  return `{ const mossTab = await page.evaluate(() => globalThis.__mossServerBrowserTab ?? null); if (mossTab !== ${JSON.stringify(marker)}) throw new Error(${JSON.stringify(WRONG_TAB_SENTINEL)} + ":" + String(mossTab) + ":" + page.url()); }\n${code}`;
}

/**
 * Betterwright in host-owned mode on a single-tab lease of the thread's
 * browser: the worker sees exactly the leased tab and nothing else.
 *
 * The lease is the network boundary as well: page traffic runs in the
 * thread's own browser, not through Betterwright's guard proxy, as for any
 * browser Moss hosts on the server.
 */
export async function runBetterwrightOnTab(input: {
  readonly home: string;
  readonly cdpUrl: string;
  readonly targetId: string;
  readonly code: string;
  readonly timeoutMs: number;
  readonly signal: AbortSignal;
}): Promise<unknown> {
  const [{ BetterWright }, { leaseServerBrowserTab }] = await Promise.all([
    import("betterwright"),
    import("./serverBrowserCdpLease.ts"),
  ]);
  const leases = new Set<Awaited<ReturnType<typeof leaseServerBrowserTab>>>();
  const runner = new BetterWright({
    home: input.home,
    hostTarget: {
      connect: async () => {
        input.signal.throwIfAborted();
        const lease = await leaseServerBrowserTab({
          browserCdpUrl: input.cdpUrl,
          targetId: input.targetId,
        });
        leases.add(lease);
        return {
          provider: { cdpUrl: lease.url },
          get closed() {
            return lease.closed;
          },
          close: async () => {
            leases.delete(lease);
            await lease.close();
          },
        };
      },
      run: (operation) => operation(input.signal),
    },
    vault: false,
    credentialCapture: false,
    adBlock: false,
    downloadPolicy: "deny",
  });
  try {
    const result = await runner.run(input.code, {
      timeout: input.timeoutMs / 1000,
      signal: input.signal,
      automaticUI: false,
    });
    if (!result.ok) {
      if (typeof result.error === "string" && result.error.includes(WRONG_TAB_SENTINEL)) {
        throw serverBrowserError("BrowserReconciliationRequired");
      }
      throw serverBrowserError("BrowserEvaluationFailed", {
        phase: "evaluate",
        effectMayHaveCommitted: true,
      });
    }
    return result.result;
  } finally {
    await runner.close().catch(() => undefined);
    await Promise.all([...leases].map((lease) => lease.close()));
  }
}

export class ServerBrowserRuntime {
  private readonly threads = new Map<string, ServerBrowserThread>();
  private readonly viewerCounts = new Map<string, number>();
  private readonly launching = new Map<string, Promise<ServerBrowserThread>>();
  private readonly options: Required<
    Pick<ServerBrowserRuntimeOptions, "maxThreads" | "maxTabsPerThread" | "idleMs" | "now">
  > &
    ServerBrowserRuntimeOptions;
  private events: ServerBrowserThreadEvents = noopEvents;
  private readonly idleTimer: ReturnType<typeof setInterval>;
  private disposed = false;

  constructor(options: ServerBrowserRuntimeOptions) {
    this.options = {
      maxThreads: 4,
      maxTabsPerThread: 8,
      idleMs: 15 * 60_000,
      now: Date.now,
      ...options,
    };
    this.idleTimer = setInterval(() => void this.closeIdle(), 60_000);
    this.idleTimer.unref?.();
  }

  setEvents(events: ServerBrowserThreadEvents): void {
    this.events = events;
  }

  thread(threadId: string): ServerBrowserThread | undefined {
    return this.threads.get(threadId);
  }

  /** The tab a viewer of this thread should watch: the agent's assignment, else the newest. */
  defaultTabId(threadId: string): string | null {
    const thread = this.threads.get(threadId);
    if (!thread) return null;
    if (thread.assignedTabId && thread.tabs.has(thread.assignedTabId)) return thread.assignedTabId;
    return [...thread.tabs.keys()].at(-1) ?? null;
  }

  /** The handoff notice for this thread's agent since its last call, if any. */
  consumeHandoffNotice(threadId: string): string | undefined {
    const thread = this.threads.get(threadId);
    if (!thread) return undefined;
    for (const tab of thread.tabs.values()) {
      const notice = tab.control.consumeHandoffNotice();
      if (notice) {
        return `A person took control of browser tab ${tab.tabId} and has released it. The page may have changed: observe it again before acting.`;
      }
    }
    return undefined;
  }

  /**
   * Count a viewer in or out. Counted per thread, not per browser: a viewer can
   * open a thread before its agent starts a browser, and a watched browser is
   * never evicted or closed as idle.
   */
  viewerAttached(threadId: string, delta: 1 | -1): void {
    const count = Math.max(0, (this.viewerCounts.get(threadId) ?? 0) + delta);
    if (count === 0) this.viewerCounts.delete(threadId);
    else this.viewerCounts.set(threadId, count);
    const thread = this.threads.get(threadId);
    if (thread) thread.lastUsedAt = this.options.now();
  }

  private watched(threadId: string): boolean {
    return (this.viewerCounts.get(threadId) ?? 0) > 0;
  }

  /** A viewer took control of a tab: stop the agent's action in flight. */
  interruptAgent(tab: ServerBrowserTab): void {
    tab.agentAbort?.abort(
      serverBrowserError("BrowserInterruptedByHuman", {
        retryable: true,
        phase: "input",
        effectMayHaveCommitted: true,
        tabId: tab.tabId,
      }),
    );
  }

  async execute(input: ServerBrowserExecuteInput): Promise<unknown> {
    if (this.disposed)
      throw serverBrowserError("BrowserHostUnavailable", { retryable: true, phase: "routing" });
    const args = input.arguments;
    switch (input.name) {
      case "browser_status": {
        const thread = this.threads.get(input.threadId);
        return {
          available: true,
          physicalScope: "server-headless-chromium",
          assignedTabId: thread?.assignedTabId ?? null,
          authorization: "not-required",
        };
      }
      case "browser_tabs":
        return this.tabsOutput(input.threadId);
      case "browser_open":
        return this.open(input, args);
      case "browser_close":
        return this.closeTab(input.threadId, args);
      default:
        return this.tabTool(input, args);
    }
  }

  private tabsOutput(threadId: string) {
    const thread = this.threads.get(threadId);
    const tabs = thread ? [...thread.tabs.values()] : [];
    const activeTabId = thread ? this.defaultTabId(threadId) : null;
    return {
      tabs: tabs.slice(0, 24).map((tab) => this.tabSummary(tab, tab.tabId === activeTabId)),
      activeTabId,
      assignedTabId: thread?.assignedTabId ?? null,
    };
  }

  tabSummary(tab: ServerBrowserTab, active: boolean) {
    return {
      tabId: tab.tabId,
      title: bounded(this.titleOf(tab), MAX_TITLE_LENGTH),
      url: urlOf(tab.page),
      active,
      loading: tab.loading,
      routable: !tab.page.isClosed(),
      state: tab.page.isClosed() ? ("crashed" as const) : ("live" as const),
    };
  }

  private readonly titles = new WeakMap<Page, string>();

  titleOf(tab: ServerBrowserTab): string {
    return this.titles.get(tab.page) ?? "";
  }

  private async ensureThread(threadId: string): Promise<ServerBrowserThread> {
    const existing = this.threads.get(threadId);
    if (existing) {
      existing.lastUsedAt = this.options.now();
      return existing;
    }
    const pending = this.launching.get(threadId);
    if (pending) return pending;
    const launching = (async () => {
      await this.makeRoom();
      let launched: ServerBrowserLaunched;
      let guard: ServerBrowserDocumentGuard;
      try {
        const executable = await this.options.resolveExecutable();
        launched = await (this.options.launch ?? launchServerBrowser)(executable);
      } catch {
        throw serverBrowserError("BrowserHostUnavailable", { retryable: true, phase: "routing" });
      }
      try {
        // Before any page exists: no document leaves unchecked.
        guard = await guardServerBrowserDocuments({
          browserCdpUrl: launched.cdpUrl,
          allow: (url) => this.navigable(url),
          onBlocked: (targetId, openerId, host) =>
            this.documentBlocked(threadId, targetId, openerId, host),
        });
      } catch {
        await launched.browser.close().catch(() => undefined);
        throw serverBrowserError("BrowserHostUnavailable", { retryable: true, phase: "routing" });
      }
      const context = await launched.browser.newContext({
        viewport: SERVER_BROWSER_DEFAULT_VIEWPORT,
        deviceScaleFactor: 1,
        // Downloads land only while a person drives the tab; the agent's are cancelled.
        acceptDownloads: true,
      });
      const thread: ServerBrowserThread = {
        threadId,
        browser: launched.browser,
        context,
        cdpUrl: launched.cdpUrl,
        guard,
        tabs: new Map(),
        assignedTabId: null,
        lastUsedAt: this.options.now(),
      };
      launched.browser.on("disconnected", () => {
        if (this.threads.get(threadId) === thread) void this.closeThread(threadId);
      });
      // Pages a script opens (window.open, target=_blank) join the thread as tabs.
      context.on("page", (page) => {
        if (![...thread.tabs.values()].some((tab) => tab.page === page)) {
          this.adoptPage(thread, page);
        }
      });
      this.threads.set(threadId, thread);
      return thread;
    })().finally(() => this.launching.delete(threadId));
    this.launching.set(threadId, launching);
    return launching;
  }

  private async makeRoom(): Promise<void> {
    while (this.threads.size + this.launching.size >= this.options.maxThreads) {
      const evictable = [...this.threads.values()]
        .filter((thread) => !this.watched(thread.threadId))
        .toSorted((a, b) => a.lastUsedAt - b.lastUsedAt)[0];
      if (!evictable)
        throw serverBrowserError("BrowserCapacityExceeded", { retryable: true, phase: "routing" });
      await this.closeThread(evictable.threadId);
    }
  }

  private adoptPage(thread: ServerBrowserThread, page: Page): ServerBrowserTab {
    const tabId = randomUUID();
    const tab: ServerBrowserTab = {
      tabId,
      page,
      control: new BrowserSessionControl({
        onChange: () => {
          this.events.controlChanged(thread.threadId, tabId);
          // Control went back to the agent: nothing it holds for a person can be answered now.
          if (tab.control.controller === null) {
            void tab.pendingDialog?.answer(false);
            void tab.pendingChooser?.answer([]);
          }
        },
        now: this.options.now,
      }),
      startedAt: new Date(this.options.now()).toISOString(),
      logs: [],
      droppedLogs: 0,
      dialogs: [],
      loading: false,
      viewportPinned: false,
      pendingDialog: null,
      pendingChooser: null,
      agentAbort: null,
      blockedHost: null,
    };
    // Known before the tab's first navigation, so a refused request maps to it.
    void this.targetIdOf(tab)
      .then((targetId) => {
        // A page a script opened at a refused address was refused before it
        // joined the thread: say so, and close the blank tab it left.
        if (!this.unclaimedBlocks.has(targetId)) return;
        const host = this.unclaimedBlocks.get(targetId);
        this.unclaimedBlocks.delete(targetId);
        if (host) this.events.navigationBlocked(thread.threadId, tabId, host);
        if (page.url() === "about:blank") void page.close().catch(() => undefined);
      })
      .catch(() => undefined);
    const log = (entry: LogEntry) => {
      tab.logs.push(entry);
      if (tab.logs.length > MAX_LOG_ENTRIES) {
        tab.logs.shift();
        tab.droppedLogs += 1;
      }
    };
    const requestStarts = new WeakMap<PlaywrightRequest, number>();
    const requestIds = new WeakMap<PlaywrightRequest, string>();
    const requestId = (request: PlaywrightRequest) => {
      let id = requestIds.get(request);
      if (!id) {
        id = randomUUID();
        requestIds.set(request, id);
      }
      return id;
    };
    page.on("console", (message) => {
      const type = message.type();
      const level =
        type === "debug" || type === "info" || type === "warning" || type === "error"
          ? type === "warning"
            ? "warn"
            : type
          : "log";
      const location = message.location();
      log({
        kind: "console",
        timestamp: new Date().toISOString(),
        level,
        text: bounded(message.text(), 4_096),
        ...(location.url ? { url: bounded(location.url, MAX_URL_LENGTH) } : {}),
        ...(location.lineNumber >= 0 ? { lineNumber: location.lineNumber } : {}),
        ...(location.columnNumber >= 0 ? { columnNumber: location.columnNumber } : {}),
      });
    });
    page.on("pageerror", (error) =>
      log({
        kind: "console",
        timestamp: new Date().toISOString(),
        level: "exception",
        text: bounded(String(error.message || error), 4_096),
      }),
    );
    page.on("request", (request) => {
      requestStarts.set(request, this.options.now());
      log({
        kind: "network",
        timestamp: new Date().toISOString(),
        phase: "request",
        requestId: requestId(request),
        url: bounded(request.url(), MAX_URL_LENGTH),
        method: bounded(request.method(), 32),
      });
    });
    page.on("response", (response) => {
      const request = response.request();
      const started = requestStarts.get(request);
      const status = response.status();
      const mimeType = response.headers()["content-type"];
      log({
        kind: "network",
        timestamp: new Date().toISOString(),
        phase: "response",
        requestId: requestId(request),
        url: bounded(response.url(), MAX_URL_LENGTH),
        method: bounded(request.method(), 32),
        ...(status >= 100 && status <= 599 ? { status } : {}),
        ...(mimeType ? { mimeType: bounded(mimeType, 256) } : {}),
        ...(started !== undefined
          ? { durationMs: Math.min(3_600_000, Math.max(0, this.options.now() - started)) }
          : {}),
      });
    });
    page.on("requestfailed", (request) =>
      log({
        kind: "network",
        timestamp: new Date().toISOString(),
        phase: "failure",
        requestId: requestId(request),
        url: bounded(request.url(), MAX_URL_LENGTH),
        method: bounded(request.method(), 32),
        errorText: bounded(request.failure()?.errorText ?? "failed", 1_024),
      }),
    );
    // A dialog blocks the page until answered. Nobody can answer it from a
    // headless browser in time, so alerts are accepted and the rest dismissed;
    // the agent learns about each in its next result, viewers immediately.
    page.on("dialog", (dialog) => {
      const kind = dialog.type() as DialogEvent["kind"];
      if (tab.control.controller !== null && !tab.pendingDialog) {
        // A person drives the tab: the dialog is theirs to answer.
        const id = randomUUID();
        let settled = false;
        const timer = setTimeout(() => void held.answer(false), PENDING_DIALOG_TIMEOUT_MS);
        timer.unref?.();
        const held: ServerBrowserPendingDialog = {
          id,
          kind,
          message: bounded(dialog.message(), 4_096),
          defaultPrompt: kind === "prompt" ? bounded(dialog.defaultValue(), 4_096) : "",
          answer: async (accept, promptText) => {
            if (settled) return;
            settled = true;
            clearTimeout(timer);
            if (tab.pendingDialog === held) tab.pendingDialog = null;
            const event: DialogEvent = {
              kind,
              message: held.message,
              ...(kind === "prompt" ? { defaultPrompt: held.defaultPrompt } : {}),
              action: accept ? "accepted" : "dismissed",
              openedAt: new Date().toISOString(),
            };
            tab.dialogs = [...tab.dialogs, event].slice(-MAX_DIALOG_EVENTS);
            this.events.pendingChanged(thread.threadId, tabId);
            await (accept ? dialog.accept(promptText) : dialog.dismiss()).catch(() => undefined);
          },
        };
        tab.pendingDialog = held;
        this.events.pendingChanged(thread.threadId, tabId);
        return;
      }
      const accept = kind === "alert";
      const event: DialogEvent = {
        kind,
        message: bounded(dialog.message(), 4_096),
        ...(kind === "prompt" ? { defaultPrompt: bounded(dialog.defaultValue(), 4_096) } : {}),
        action: accept ? "accepted" : "dismissed",
        openedAt: new Date().toISOString(),
      };
      tab.dialogs = [...tab.dialogs, event].slice(-MAX_DIALOG_EVENTS);
      this.events.dialog(thread.threadId, tabId, event);
      void (accept ? dialog.accept() : dialog.dismiss()).catch(() => undefined);
    });
    page.on("filechooser", (chooser) => {
      // The agent attaches files with browser_upload; only a person's picker is answered.
      if (tab.control.controller === null || tab.pendingChooser) return;
      let settled = false;
      const held: ServerBrowserPendingChooser = {
        id: randomUUID(),
        multiple: chooser.isMultiple(),
        // Filled in from the input's accept attribute below.
        accept: "",
        answer: async (paths) => {
          if (settled) return;
          settled = true;
          if (tab.pendingChooser === held) tab.pendingChooser = null;
          this.events.pendingChanged(thread.threadId, tabId);
          await chooser.setFiles([...paths]).catch(() => undefined);
        },
      };
      tab.pendingChooser = held;
      void chooser
        .element()
        .getAttribute("accept")
        .then((accept) => {
          if (tab.pendingChooser === held && accept) {
            tab.pendingChooser = { ...held, accept: bounded(accept, 256) };
          }
        })
        .catch(() => undefined)
        .finally(() => this.events.pendingChanged(thread.threadId, tabId));
    });
    page.on("download", (download) => {
      if (tab.control.controller === null) {
        // Agent downloads need approval the server browser cannot ask for.
        void download.cancel().catch(() => undefined);
        return;
      }
      void this.keepDownload(thread.threadId, tabId, download);
    });
    const refreshTitle = () => {
      void page
        .title()
        .then((title) => {
          this.titles.set(page, title);
          this.events.tabsChanged(thread.threadId);
        })
        .catch(() => undefined);
    };
    page.on("framenavigated", (frame) => {
      if (frame === page.mainFrame()) {
        tab.loading = true;
        this.events.tabsChanged(thread.threadId);
      }
    });
    page.on("load", () => {
      tab.loading = false;
      refreshTitle();
    });
    page.on("domcontentloaded", refreshTitle);
    page.on("close", () => {
      if (thread.tabs.get(tabId) === tab) {
        thread.tabs.delete(tabId);
        if (thread.assignedTabId === tabId) thread.assignedTabId = null;
        void tab.control.close();
        this.events.tabsChanged(thread.threadId);
      }
    });
    thread.tabs.set(tabId, tab);
    this.events.tabsChanged(thread.threadId);
    return tab;
  }

  private navigable(url: URL): Promise<boolean> {
    return (this.options.navigationGuard ?? isServerBrowserNavigable)(url).catch(() => false);
  }

  /** The guard refused a document request of the tab with CDP target `targetId`. */
  private documentBlocked(
    threadId: string,
    targetId: string,
    openerId: string | undefined,
    host: string,
  ): void {
    const tabs = [...(this.threads.get(threadId)?.tabs.values() ?? [])];
    const tab = tabs.find((candidate) => this.targetIds.get(candidate.page) === targetId);
    if (tab) {
      tab.blockedHost = host;
      this.events.navigationBlocked(threadId, tab.tabId, host);
      return;
    }
    // Not a tab yet: the first request of a page a script opened. Its opener is
    // what the person watches; the blank page is closed once it shows up.
    const opener = tabs.find((candidate) => this.targetIds.get(candidate.page) === openerId);
    if (opener) this.events.navigationBlocked(threadId, opener.tabId, host);
    this.unclaimedBlocks.set(targetId, opener ? null : host);
    if (this.unclaimedBlocks.size > 64) {
      this.unclaimedBlocks.delete(this.unclaimedBlocks.keys().next().value!);
    }
  }

  /**
   * Refusals for targets that were not yet tabs, by CDP target id: the host
   * still to report, or null when the opener's viewers were already told.
   */
  private readonly unclaimedBlocks = new Map<string, string | null>();

  /** The host to name when the web URL `value` may not be loaded, else null. */
  async refusedHost(value: string): Promise<string | null> {
    const url = new URL(value);
    return (await this.navigable(url)) ? null : serverBrowserHost(url);
  }

  /**
   * Refuse a page load the agent or a person asked for: web URLs only, and
   * never the server's own machine or private network.
   */
  private async assertNavigable(value: string): Promise<void> {
    assertWebUrl(value);
    if ((await this.refusedHost(value)) !== null) {
      throw serverBrowserError("BrowserNavigationBlocked", { phase: "navigation" });
    }
  }

  private async open(input: ServerBrowserExecuteInput, args: Record<string, unknown>) {
    const url = typeof args.url === "string" ? args.url : undefined;
    if (url !== undefined) await this.assertNavigable(url);
    const thread = await this.ensureThread(input.threadId);
    const reusable =
      args.reuse !== false && thread.assignedTabId
        ? thread.tabs.get(thread.assignedTabId)
        : undefined;
    let tab = reusable;
    let disposition: "created" | "reused" = "reused";
    if (!tab) {
      if (thread.tabs.size >= this.options.maxTabsPerThread) {
        throw serverBrowserError("BrowserCapacityExceeded", { retryable: false, phase: "routing" });
      }
      const page = await thread.context.newPage();
      tab =
        [...thread.tabs.values()].find((candidate) => candidate.page === page) ??
        this.adoptPage(thread, page);
      disposition = "created";
    }
    thread.assignedTabId = tab.tabId;
    this.events.tabsChanged(thread.threadId);
    if (args.show !== false) this.events.reveal(thread.threadId, tab.tabId);
    const navigation = url
      ? await this.agentAction(tab, input, (signal) =>
          this.navigate(tab, signal, () =>
            tab.page.goto(url, { waitUntil: "domcontentloaded", timeout: input.timeoutMs }),
          ),
        )
      : { finalUrl: urlOf(tab.page), redirects: [] as string[] };
    return {
      tabId: tab.tabId,
      finalUrl: navigation.finalUrl,
      redirects: navigation.redirects,
      loadState: "domcontentloaded" as const,
      disposition,
      ...this.takeDialogs(tab),
    };
  }

  private readonly downloads = new Map<
    string,
    {
      readonly path: string;
      readonly fileName: string;
      readonly threadId: string;
      readonly expiresAt: number;
    }
  >();

  private filesDir(threadId: string, kind: "uploads" | "downloads"): string {
    const root = this.options.filesDir ?? Path.join(tmpdir(), "moss-server-browser");
    return Path.join(root, encodeURIComponent(threadId), kind, randomUUID());
  }

  private async keepDownload(
    threadId: string,
    tabId: string,
    download: import("playwright").Download,
  ): Promise<void> {
    try {
      const fileName = bounded(Path.basename(download.suggestedFilename()) || "download", 255);
      const directory = this.filesDir(threadId, "downloads");
      await FS.mkdir(directory, { recursive: true });
      const path = Path.join(directory, fileName);
      await download.saveAs(path);
      const { size } = await FS.stat(path);
      const token = randomUUID();
      this.downloads.set(token, {
        path,
        fileName,
        threadId,
        expiresAt: this.options.now() + SERVER_BROWSER_DOWNLOAD_TTL_MS,
      });
      this.events.download(threadId, tabId, {
        fileName,
        sizeBytes: size,
        path: `${SERVER_BROWSER_DOWNLOAD_PATH}?${SERVER_BROWSER_DOWNLOAD_TOKEN_PARAM}=${token}`,
      });
    } catch {
      // A cancelled or failed download has nothing to offer.
    }
  }

  /**
   * A kept download by its token, once: the token is spent on the first take,
   * and an expired one is refused.
   */
  takeDownload(token: string): { readonly path: string; readonly fileName: string } | undefined {
    const entry = this.downloads.get(token);
    if (!entry) return undefined;
    this.downloads.delete(token);
    if (entry.expiresAt < this.options.now()) return undefined;
    return { path: entry.path, fileName: entry.fileName };
  }

  /** Answer a held dialog; only the viewer in control may. */
  async answerDialog(
    tab: ServerBrowserTab,
    viewerId: string,
    id: string,
    accept: boolean,
    promptText?: string,
  ): Promise<void> {
    if (tab.control.controller !== viewerId || tab.pendingDialog?.id !== id) return;
    await tab.pendingDialog.answer(accept, promptText);
  }

  /** Answer a held file picker with the viewer's files; none cancels it. */
  async answerFileChooser(
    threadId: string,
    tab: ServerBrowserTab,
    viewerId: string,
    id: string,
    files: ReadonlyArray<{ readonly name: string; readonly data: string }>,
  ): Promise<void> {
    const chooser = tab.pendingChooser;
    if (tab.control.controller !== viewerId || chooser?.id !== id) return;
    if (files.length === 0) {
      await chooser.answer([]);
      return;
    }
    const directory = this.filesDir(threadId, "uploads");
    await FS.mkdir(directory, { recursive: true });
    const paths: string[] = [];
    for (const file of chooser.multiple ? files : files.slice(0, 1)) {
      // One folder per file keeps its own name, which is what the page reads.
      const name = Path.basename(file.name).replace(/^\.+/u, "") || "file";
      const folder = Path.join(directory, String(paths.length));
      await FS.mkdir(folder, { recursive: true });
      const path = Path.join(folder, name);
      await FS.writeFile(path, Buffer.from(file.data, "base64"));
      paths.push(path);
    }
    await chooser.answer(paths);
  }

  /** A person closes a tab, unless another viewer is driving it. */
  async closeTabForViewer(threadId: string, tabId: string, viewerId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    const tab = thread?.tabs.get(tabId);
    if (!thread || !tab) return;
    const owner = tab.control.controller;
    if (owner !== null && owner !== viewerId) return;
    this.interruptAgent(tab);
    thread.tabs.delete(tabId);
    if (thread.assignedTabId === tabId) thread.assignedTabId = null;
    await tab.control.close();
    await tab.page.close().catch(() => undefined);
    this.events.tabsChanged(threadId);
  }

  /**
   * A person opens a page from a viewer. The tab joins the thread like any
   * other, and becomes the agent's assignment when it has none, so the agent
   * continues on the page the person chose.
   */
  async openTabForViewer(threadId: string, url: string): Promise<string> {
    await this.assertNavigable(url);
    const thread = await this.ensureThread(threadId);
    if (thread.tabs.size >= this.options.maxTabsPerThread) {
      throw serverBrowserError("BrowserCapacityExceeded", { retryable: false, phase: "routing" });
    }
    const page = await thread.context.newPage();
    const tab =
      [...thread.tabs.values()].find((candidate) => candidate.page === page) ??
      this.adoptPage(thread, page);
    if (!thread.assignedTabId) thread.assignedTabId = tab.tabId;
    this.events.tabsChanged(threadId);
    void page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 }).catch(() => undefined);
    return tab.tabId;
  }

  private async closeTab(threadId: string, args: Record<string, unknown>) {
    const thread = this.threads.get(threadId);
    const tab = thread ? this.resolveTab(thread, args) : undefined;
    if (!thread || !tab) throw serverBrowserError("BrowserTabNotFound", { phase: "routing" });
    if (!tab.control.agentCanAct()) throw this.humanControlError(tab);
    thread.tabs.delete(tab.tabId);
    if (thread.assignedTabId === tab.tabId) thread.assignedTabId = null;
    await tab.control.close();
    await tab.page.close().catch(() => undefined);
    this.events.tabsChanged(threadId);
    return { closedTabId: tab.tabId, activeTabId: this.defaultTabId(threadId) };
  }

  private resolveTab(
    thread: ServerBrowserThread,
    args: Record<string, unknown>,
  ): ServerBrowserTab | undefined {
    const requested = typeof args.tabId === "string" ? args.tabId : thread.assignedTabId;
    return requested ? thread.tabs.get(requested) : undefined;
  }

  private humanControlError(tab: ServerBrowserTab): BrowserHostRpcError {
    return serverBrowserError("BrowserInterruptedByHuman", {
      retryable: true,
      phase: "input",
      effectMayHaveCommitted: false,
      tabId: tab.tabId,
    });
  }

  /**
   * Run an agent mutation under the tab's control, aborted by a takeover or the
   * caller. A takeover reports `BrowserInterruptedByHuman`; the effect of an
   * interrupted action is unknown, so it is never retried automatically.
   */
  private async agentAction<A>(
    tab: ServerBrowserTab,
    input: ServerBrowserExecuteInput,
    run: (signal: AbortSignal) => Promise<A>,
  ): Promise<A> {
    const abort = new AbortController();
    const signals = [abort.signal, AbortSignal.timeout(Math.max(100, input.timeoutMs))];
    if (input.signal) signals.push(input.signal);
    const signal = AbortSignal.any(signals);
    try {
      return await tab.control.agent(async () => {
        tab.agentAbort = abort;
        try {
          return await raceAbort(run(signal), signal);
        } finally {
          if (tab.agentAbort === abort) tab.agentAbort = null;
        }
      });
    } catch (error) {
      if (error instanceof BrowserControlRefusedError) {
        if (error.reason === "closed")
          throw serverBrowserError("BrowserTabNotFound", { phase: "routing" });
        throw this.humanControlError(tab);
      }
      if (error instanceof BrowserHostRpcError) throw error;
      if (signal.aborted) {
        const reason = signal.reason;
        if (reason instanceof BrowserHostRpcError) throw reason;
        if (input.signal?.aborted)
          throw serverBrowserError("BrowserCancelled", {
            phase: "runtime",
            effectMayHaveCommitted: true,
          });
        throw serverBrowserError("BrowserTimeout", {
          retryable: true,
          phase: "runtime",
          effectMayHaveCommitted: true,
        });
      }
      throw error;
    }
  }

  private async navigate(
    tab: ServerBrowserTab,
    signal: AbortSignal,
    go: () => Promise<import("playwright").Response | null>,
  ): Promise<{ finalUrl: string; redirects: string[] }> {
    // The refusal, if any, is recorded against the tab's target id.
    await this.targetIdOf(tab).catch(() => undefined);
    signal.throwIfAborted();
    tab.blockedHost = null;
    let response: import("playwright").Response | null;
    try {
      response = await go();
    } catch (error) {
      if (signal.aborted) throw error;
      if (tab.blockedHost !== null) {
        throw serverBrowserError("BrowserNavigationBlocked", {
          phase: "navigation",
          tabId: tab.tabId,
        });
      }
      throw serverBrowserError("BrowserNavigationFailed", {
        retryable: true,
        phase: "navigation",
        effectMayHaveCommitted: true,
        tabId: tab.tabId,
      });
    }
    const redirects: string[] = [];
    let request = response?.request().redirectedFrom() ?? null;
    while (request && redirects.length < MAX_REDIRECTS) {
      redirects.unshift(bounded(request.url(), MAX_URL_LENGTH));
      request = request.redirectedFrom();
    }
    return { finalUrl: urlOf(tab.page), redirects };
  }

  private takeDialogs(tab: ServerBrowserTab): { dialogs?: DialogEvent[] } {
    if (tab.dialogs.length === 0) return {};
    const dialogs = tab.dialogs;
    tab.dialogs = [];
    return { dialogs };
  }

  private async tabTool(input: ServerBrowserExecuteInput, args: Record<string, unknown>) {
    const thread = this.threads.get(input.threadId);
    const tab = thread ? this.resolveTab(thread, args) : undefined;
    if (!thread || !tab) throw serverBrowserError("BrowserTabNotFound", { phase: "routing" });
    thread.lastUsedAt = this.options.now();
    const waitUntil = loadStateOf(args.waitUntil);
    const navigation = (go: () => Promise<import("playwright").Response | null>) =>
      this.agentAction(tab, input, (signal) => this.navigate(tab, signal, go)).then((result) => ({
        tabId: tab.tabId,
        ...result,
        loadState: waitUntil,
        ...this.takeDialogs(tab),
      }));
    const timeout = input.timeoutMs;
    switch (input.name) {
      case "browser_navigate": {
        if (typeof args.url !== "string") {
          // Annotation ids name a page captured in the desktop's own webview.
          throw serverBrowserError("BrowserInvalidArguments");
        }
        const url = args.url;
        await this.assertNavigable(url);
        return navigation(() => tab.page.goto(url, { waitUntil, timeout }));
      }
      case "browser_back":
        return navigation(() => tab.page.goBack({ waitUntil, timeout }));
      case "browser_forward":
        return navigation(() => tab.page.goForward({ waitUntil, timeout }));
      case "browser_reload":
        if (args.ignoreCache === true) {
          return navigation(async () => {
            const session = await tab.page.context().newCDPSession(tab.page);
            try {
              const waiting = (
                waitUntil === "load"
                  ? tab.page.waitForEvent("load", { timeout })
                  : tab.page.waitForEvent("domcontentloaded", { timeout })
              ).catch(() => undefined);
              await session.send("Page.reload", { ignoreCache: true });
              await waiting;
            } finally {
              await session.detach().catch(() => undefined);
            }
            return null;
          });
        }
        return navigation(() => tab.page.reload({ waitUntil, timeout }));
      case "browser_resize": {
        const width = Number(args.width);
        const height = Number(args.height);
        await this.agentAction(tab, input, () => tab.page.setViewportSize({ width, height }));
        tab.viewportPinned = true;
        const observed = tab.page.viewportSize() ?? { width, height };
        this.events.tabsChanged(thread.threadId);
        return {
          tabId: tab.tabId,
          requested: { width, height },
          observed: { width: observed.width, height: observed.height, deviceScaleFactor: 1 },
          ...this.takeDialogs(tab),
        };
      }
      case "browser_screenshot":
        return tab.control.observe(() => this.screenshot(tab, args.fullPage === true));
      case "browser_logs":
        return tab.control.observe(async () => this.logsOutput(tab, args));
      case "browser_upload":
        return this.upload(tab, input, args);
      case "browser_run":
        return this.run(thread, tab, input, args);
      default:
        throw serverBrowserError("BrowserInvalidArguments");
    }
  }

  private async screenshot(tab: ServerBrowserTab, fullPage: boolean) {
    let clipped = false;
    let buffer: Buffer;
    if (fullPage) {
      const height = await tab.page.evaluate(() => {
        // Runs in the page; the server's own types have no DOM.
        const page = globalThis as unknown as {
          document: {
            documentElement: { scrollHeight: number };
            body: { scrollHeight: number } | null;
          };
        };
        return Math.max(
          page.document.documentElement.scrollHeight,
          page.document.body?.scrollHeight ?? 0,
        );
      });
      const viewport = tab.page.viewportSize() ?? SERVER_BROWSER_DEFAULT_VIEWPORT;
      clipped = height > MAX_SCREENSHOT_HEIGHT;
      buffer = await tab.page.screenshot({
        type: "png",
        fullPage: !clipped,
        ...(clipped
          ? { clip: { x: 0, y: 0, width: viewport.width, height: MAX_SCREENSHOT_HEIGHT } }
          : {}),
      });
    } else {
      buffer = await tab.page.screenshot({ type: "png" });
    }
    if (buffer.byteLength > 8 * 1024 * 1024) {
      throw serverBrowserError("BrowserScreenshotTooLarge");
    }
    const { width, height } = pngSize(buffer);
    const data = buffer.toString("base64");
    const image = { mimeType: "image/png" as const, width, height, byteLength: buffer.byteLength };
    return {
      structuredContent: {
        tabId: tab.tabId,
        url: urlOf(tab.page),
        capturedAt: new Date().toISOString(),
        mode: fullPage ? ("fullPage" as const) : ("viewport" as const),
        clipped,
        image,
        ...this.takeDialogs(tab),
      },
      image: { ...image, data },
    };
  }

  private logsOutput(tab: ServerBrowserTab, args: Record<string, unknown>) {
    const includeConsole = args.includeConsole !== false;
    const includeNetwork = args.includeNetwork !== false;
    const limit = typeof args.limit === "number" ? args.limit : 100;
    const matching = tab.logs.filter((entry) =>
      entry.kind === "console" ? includeConsole : includeNetwork,
    );
    const entries = matching.slice(-limit);
    return {
      tabId: tab.tabId,
      startedAt: tab.startedAt,
      capturedAt: new Date().toISOString(),
      entries,
      droppedCount: tab.droppedLogs,
      truncated: matching.length > entries.length || tab.droppedLogs > 0,
      ...this.takeDialogs(tab),
    };
  }

  private async upload(
    tab: ServerBrowserTab,
    input: ServerBrowserExecuteInput,
    args: Record<string, unknown>,
  ) {
    const root = input.workspaceRoot;
    if (!root) throw serverBrowserError("BrowserUploadWorkspaceUnavailable");
    const paths = Array.isArray(args.paths) ? (args.paths as string[]) : [];
    const files = await resolveWorkspaceFiles(root, paths);
    const target = args.target as { selector?: string; locator?: Record<string, unknown> };
    const locator = target.selector
      ? tab.page.locator(target.selector)
      : locatorFor(tab.page, target.locator ?? {});
    await this.agentAction(tab, input, async () => {
      const count = await locator.count();
      if (count === 0)
        throw serverBrowserError("BrowserTargetNotFound", { phase: "target", tabId: tab.tabId });
      if (count > 1) throw serverBrowserError("BrowserTargetAmbiguous", { tabId: tab.tabId });
      await locator.setInputFiles(
        files.map((file) => file.path),
        { timeout: input.timeoutMs },
      );
    });
    return {
      tabId: tab.tabId,
      target: {},
      files: files.map((file) => ({ name: file.name, byteLength: file.byteLength })),
      ...this.takeDialogs(tab),
    };
  }

  private async run(
    thread: ServerBrowserThread,
    tab: ServerBrowserTab,
    input: ServerBrowserExecuteInput,
    args: Record<string, unknown>,
  ) {
    const code = String(args.code ?? "");
    const runScript =
      this.options.runScript ??
      ((script: Parameters<NonNullable<ServerBrowserRuntimeOptions["runScript"]>>[0]) =>
        runBetterwrightOnTab({ home: this.options.betterwrightHome, ...script }));
    // The worker attaches to a lease of exactly this tab. The marker check is
    // a second fence: a worker that somehow reached another page stops first.
    const value = await this.agentAction(tab, input, async (signal) => {
      const targetId = await this.targetIdOf(tab);
      await tab.page.evaluate((marker) => {
        Object.defineProperty(globalThis, "__mossServerBrowserTab", {
          value: marker,
          configurable: true,
        });
      }, tab.tabId);
      return runScript({
        cdpUrl: thread.cdpUrl,
        targetId,
        code: guardedRunCode(code, tab.tabId),
        timeoutMs: input.timeoutMs,
        signal,
      });
    });
    const serialized = JSON.stringify(value ?? null) ?? "null";
    const serializedByteCount = Buffer.byteLength(serialized, "utf8");
    if (serializedByteCount > MAX_RUN_RESULT_BYTES) {
      throw serverBrowserError("BrowserEvaluationResultTooLarge", {
        phase: "evaluate",
        effectMayHaveCommitted: true,
        tabId: tab.tabId,
      });
    }
    this.events.tabsChanged(thread.threadId);
    return {
      tabId: tab.tabId,
      value: JSON.parse(serialized) as unknown,
      serializedByteCount,
      ...this.takeDialogs(tab),
    };
  }

  private readonly targetIds = new WeakMap<Page, string>();

  /** The tab's CDP target id, which a single-tab lease is cut to. */
  private async targetIdOf(tab: ServerBrowserTab): Promise<string> {
    const known = this.targetIds.get(tab.page);
    if (known) return known;
    const session = await tab.page.context().newCDPSession(tab.page);
    try {
      const { targetInfo } = (await session.send("Target.getTargetInfo")) as {
        targetInfo: { targetId: string };
      };
      this.targetIds.set(tab.page, targetInfo.targetId);
      return targetInfo.targetId;
    } finally {
      await session.detach().catch(() => undefined);
    }
  }

  private async closeIdle(): Promise<void> {
    const now = this.options.now();
    // A snapshot: closing a thread removes it from the map being walked.
    for (const thread of Array.from(this.threads.values())) {
      if (!this.watched(thread.threadId) && now - thread.lastUsedAt > this.options.idleMs) {
        await this.closeThread(thread.threadId);
      }
    }
  }

  async closeThread(threadId: string): Promise<void> {
    const thread = this.threads.get(threadId);
    if (!thread) return;
    this.threads.delete(threadId);
    await Promise.all([...thread.tabs.values()].map((tab) => tab.control.close()));
    thread.tabs.clear();
    await thread.guard.close().catch(() => undefined);
    await thread.browser.close().catch(() => undefined);
    for (const [token, entry] of this.downloads) {
      if (entry.threadId === threadId) this.downloads.delete(token);
    }
    const root = this.options.filesDir ?? Path.join(tmpdir(), "moss-server-browser");
    await FS.rm(Path.join(root, encodeURIComponent(threadId)), {
      recursive: true,
      force: true,
    }).catch(() => undefined);
    this.events.threadClosed(threadId);
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.idleTimer);
    await Promise.allSettled(this.launching.values());
    await Promise.all([...this.threads.keys()].map((threadId) => this.closeThread(threadId)));
  }
}

function raceAbort<A>(work: Promise<A>, signal: AbortSignal): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const onAbort = () => reject(signal.reason);
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

function loadStateOf(value: unknown): "commit" | "domcontentloaded" | "load" | "networkidle" {
  return value === "commit" || value === "load" || value === "networkidle"
    ? value
    : "domcontentloaded";
}

/** Tool input accepts web URLs only; local files open from the address bar. */
function assertWebUrl(value: string): void {
  let protocol: string;
  try {
    protocol = new URL(value).protocol;
  } catch {
    throw serverBrowserError("BrowserInvalidArguments");
  }
  if (protocol !== "http:" && protocol !== "https:")
    throw serverBrowserError("BrowserNavigationBlocked", { phase: "navigation" });
}

function locatorFor(page: Page, locator: Record<string, unknown>) {
  const exact = locator.exact === true;
  switch (locator.kind) {
    case "role":
      return page.getByRole(locator.role as Parameters<Page["getByRole"]>[0], {
        ...(typeof locator.name === "string" ? { name: locator.name } : {}),
        exact,
      });
    case "label":
      return page.getByLabel(String(locator.text), { exact });
    case "placeholder":
      return page.getByPlaceholder(String(locator.text), { exact });
    case "testId":
      return page.getByTestId(String(locator.value));
    default:
      return page.getByText(String(locator.text), { exact });
  }
}

/** Resolve workspace-relative files without following anything out of the workspace. */
async function resolveWorkspaceFiles(
  root: string,
  paths: readonly string[],
): Promise<Array<{ path: string; name: string; byteLength: number }>> {
  const canonicalRoot = await FS.realpath(root).catch(() => {
    throw serverBrowserError("BrowserUploadWorkspaceUnavailable");
  });
  return Promise.all(
    paths.map(async (relative) => {
      const candidate = Path.resolve(canonicalRoot, relative);
      const real = await FS.realpath(candidate).catch(() => {
        throw serverBrowserError("BrowserUploadFileUnsupported");
      });
      const inside = Path.relative(canonicalRoot, real);
      if (inside.startsWith("..") || Path.isAbsolute(inside)) {
        throw serverBrowserError("BrowserUploadPathOutsideWorkspace");
      }
      const stat = await FS.stat(real);
      if (!stat.isFile() || stat.size > MAX_UPLOAD_FILE_BYTES)
        throw serverBrowserError("BrowserUploadFileUnsupported");
      return { path: real, name: Path.basename(real), byteLength: stat.size };
    }),
  );
}

/** Width and height from a PNG's IHDR chunk. */
function pngSize(buffer: Buffer): { width: number; height: number } {
  if (buffer.byteLength < 24) return { width: 1, height: 1 };
  return {
    width: Math.max(1, buffer.readUInt32BE(16)),
    height: Math.max(1, buffer.readUInt32BE(20)),
  };
}
