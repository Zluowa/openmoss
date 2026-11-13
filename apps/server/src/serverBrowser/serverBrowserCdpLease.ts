/**
 * A CDP endpoint whose only authority is one tab of the thread's browser.
 *
 * Betterwright's host-owned mode attaches to an endpoint that must expose
 * exactly one page, and drives that page: never a sibling tab, never the
 * browser itself. Chromium has no such endpoint, so this lease is a loopback
 * WebSocket that looks like a browser with a single tab:
 *
 * - The browser-level `Target.setAutoAttach` is answered here with one
 *   synthetic attachment for the leased tab, routed to a real flattened
 *   session on the upstream browser connection.
 * - Child targets the tab spawns (frames, workers) attach through that session
 *   and pass through under their own session ids.
 * - Target listings and browser-level events about other targets are hidden;
 *   creating, closing or attaching to other targets, and closing the browser,
 *   are refused.
 * - The endpoint path carries a random secret and listens on loopback only.
 *
 * The approach mirrors Playwright's single-tab extension relay and the
 * desktop's Electron lease (`apps/desktop/src/browserAutomation/betterwrightCdp.ts`).
 *
 * @module serverBrowserCdpLease
 */
import { randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";

import { WebSocket, WebSocketServer, type RawData } from "ws";

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

/** The synthetic session id the leased tab is known by downstream. */
const LEASED_SESSION_ID = "moss-leased-tab";

/** Browser-level methods that would reach beyond the leased tab. */
const REFUSED_BROWSER_METHODS = new Set([
  "Browser.close",
  "Browser.crash",
  "Browser.crashGpuProcess",
  "Target.createTarget",
  "Target.closeTarget",
  "Target.attachToTarget",
  "Target.attachToBrowserTarget",
  "Target.createBrowserContext",
  "Target.disposeBrowserContext",
  "Target.exposeDevToolsProtocol",
  "Target.activateTarget",
  "Storage.clearCookies",
  "Storage.setCookies",
  "Storage.getCookies",
]);

/** Methods on the tab's own session that would end or escape it. */
const REFUSED_PAGE_METHODS = new Set(["Page.close", "Page.crash", "Target.closeTarget"]);

/** Browser-level methods answered here without reaching the browser. */
const LOCAL_BROWSER_METHODS = new Set([
  "Target.setDiscoverTargets",
  "Target.setRemoteLocations",
  // Browser-wide settings: the thread's context already denies downloads.
  "Browser.setDownloadBehavior",
  "Browser.resetPermissions",
]);

export interface ServerBrowserCdpLease {
  /** The endpoint to hand to Betterwright as its host target. */
  readonly url: string;
  readonly closed: boolean;
  /** Revoke the endpoint and release the upstream session. Never closes the tab. */
  readonly close: () => Promise<void>;
}

const parse = (data: RawData): CdpMessage | null => {
  try {
    const value = JSON.parse(data.toString()) as unknown;
    return typeof value === "object" && value !== null ? (value as CdpMessage) : null;
  } catch {
    return null;
  }
};

/**
 * Lease one tab of the browser at `browserCdpUrl` as a single-tab endpoint.
 * `targetId` is the tab's CDP target id.
 */
export async function leaseServerBrowserTab(input: {
  readonly browserCdpUrl: string;
  readonly targetId: string;
}): Promise<ServerBrowserCdpLease> {
  const upstream = new WebSocket(input.browserCdpUrl, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    upstream.once("open", () => resolve());
    upstream.once("error", reject);
  });

  let nextUpstreamId = 1;
  const pendingOwn = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (error: Error) => void }
  >();
  /** Upstream id → the downstream request it answers, and how to rewrite the answer. */
  const pendingDownstream = new Map<
    number,
    {
      readonly id: number;
      readonly sessionId?: string;
      readonly rewrite?: (result: unknown) => unknown;
    }
  >();
  const childSessions = new Set<string>();
  let downstream: WebSocket | null = null;
  let closed = false;

  const sendOwn = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      const id = nextUpstreamId++;
      pendingOwn.set(id, { resolve, reject });
      upstream.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  // Set once attached; the message handler below needs to exist before then.
  let upstreamSessionId = "";

  const toDownstream = (message: CdpMessage) => {
    if (downstream?.readyState === WebSocket.OPEN) downstream.send(JSON.stringify(message));
  };
  const reply = (id: number, result: unknown, sessionId?: string) =>
    toDownstream({ id, result, ...(sessionId ? { sessionId } : {}) });
  const refuse = (id: number, method: string, sessionId?: string) =>
    toDownstream({
      id,
      error: { code: -32000, message: `${method} is not permitted on a leased tab.` },
      ...(sessionId ? { sessionId } : {}),
    });

  upstream.on("message", (data) => {
    const message = parse(data);
    if (!message) return;
    if (typeof message.id === "number") {
      const own = pendingOwn.get(message.id);
      if (own) {
        pendingOwn.delete(message.id);
        if (message.error) own.reject(new Error(JSON.stringify(message.error)));
        else own.resolve(message.result);
        return;
      }
      const forwarded = pendingDownstream.get(message.id);
      if (!forwarded) return;
      pendingDownstream.delete(message.id);
      toDownstream({
        id: forwarded.id,
        ...(message.error
          ? { error: message.error }
          : { result: forwarded.rewrite ? forwarded.rewrite(message.result) : message.result }),
        ...(forwarded.sessionId ? { sessionId: forwarded.sessionId } : {}),
      });
      return;
    }
    // Events: only the leased tab's session and its children pass.
    const sessionId = message.sessionId;
    if (sessionId === upstreamSessionId) {
      if (message.method === "Target.attachedToTarget") {
        const child = (message.params as { sessionId?: string } | undefined)?.sessionId;
        if (child) childSessions.add(child);
      } else if (message.method === "Target.detachedFromTarget") {
        const child = (message.params as { sessionId?: string } | undefined)?.sessionId;
        if (child) childSessions.delete(child);
      }
      toDownstream({ ...message, sessionId: LEASED_SESSION_ID });
      return;
    }
    if (sessionId && childSessions.has(sessionId)) {
      toDownstream(message);
      return;
    }
    if (
      !sessionId &&
      message.method === "Target.detachedFromTarget" &&
      (message.params as { sessionId?: string } | undefined)?.sessionId === upstreamSessionId
    ) {
      // The tab went away: the leased browser has no page left.
      toDownstream({
        method: "Target.detachedFromTarget",
        params: { sessionId: LEASED_SESSION_ID, targetId: input.targetId },
      });
      void close();
    }
  });

  try {
    ({ sessionId: upstreamSessionId } = (await sendOwn("Target.attachToTarget", {
      targetId: input.targetId,
      flatten: true,
    })) as { sessionId: string });
  } catch (error) {
    upstream.close();
    throw error;
  }
  const { targetInfo } = (await sendOwn("Target.getTargetInfo", { targetId: input.targetId })) as {
    targetInfo: Record<string, unknown>;
  };
  // Playwright files a target whose context it did not create under its
  // default context: downstream sees one browser, one context, this tab.
  const leasedTargetInfo = { ...targetInfo, attached: true };

  const forward = (
    message: CdpMessage,
    sessionId: string | undefined,
    rewrite?: (result: unknown) => unknown,
  ) => {
    const id = nextUpstreamId++;
    pendingDownstream.set(id, {
      id: message.id!,
      ...(message.sessionId ? { sessionId: message.sessionId } : {}),
      ...(rewrite ? { rewrite } : {}),
    });
    upstream.send(
      JSON.stringify({
        id,
        method: message.method,
        params: message.params ?? {},
        ...(sessionId ? { sessionId } : {}),
      }),
    );
  };

  /** Browser-level sessions Betterwright opened; they carry browser-level rules. */
  const browserSessions = new Set<string>();
  let nextBrowserSession = 1;

  /** A browser-level command, on the root connection or a browser session. */
  const handleBrowserLevel = (message: CdpMessage & { id: number; method: string }) => {
    const { id, method } = message;
    const session = message.sessionId;
    if (method === "Target.setAutoAttach") {
      reply(id, {}, session);
      toDownstream({
        method: "Target.attachedToTarget",
        params: {
          sessionId: LEASED_SESSION_ID,
          targetInfo: leasedTargetInfo,
          waitingForDebugger: false,
        },
        ...(session ? { sessionId: session } : {}),
      });
      return;
    }
    if (method === "Target.attachToBrowserTarget") {
      const browserSession = `moss-leased-browser-${nextBrowserSession++}`;
      browserSessions.add(browserSession);
      return reply(id, { sessionId: browserSession }, session);
    }
    if (method === "Target.detachFromTarget") {
      const detached = message.params?.sessionId;
      if (typeof detached === "string" && browserSessions.delete(detached)) {
        return reply(id, {}, session);
      }
      return refuse(id, method, session);
    }
    if (method === "Target.getTargets")
      return reply(id, { targetInfos: [leasedTargetInfo] }, session);
    if (method === "Target.getTargetInfo") {
      const requested = message.params?.targetId;
      if (requested === undefined) return forward(message, undefined);
      return requested === input.targetId
        ? reply(id, { targetInfo: leasedTargetInfo }, session)
        : refuse(id, method, session);
    }
    if (method === "Target.getBrowserContexts") {
      return reply(id, { browserContextIds: [] }, session);
    }
    if (LOCAL_BROWSER_METHODS.has(method)) return reply(id, {}, session);
    if (REFUSED_BROWSER_METHODS.has(method) || method.startsWith("Target.")) {
      return refuse(id, method, session);
    }
    // Answered on the browser session the caller used, sent on the root.
    forward(message, undefined);
  };

  const handleDownstream = (message: CdpMessage) => {
    if (typeof message.id !== "number" || typeof message.method !== "string") return;
    const command = message as CdpMessage & { id: number; method: string };
    const { id, method } = command;
    if (command.sessionId === LEASED_SESSION_ID) {
      if (REFUSED_PAGE_METHODS.has(method)) return refuse(id, method, command.sessionId);
      return forward(command, upstreamSessionId);
    }
    if (command.sessionId && browserSessions.has(command.sessionId)) {
      return handleBrowserLevel(command);
    }
    if (command.sessionId) {
      if (!childSessions.has(command.sessionId)) return refuse(id, method, command.sessionId);
      return forward(command, command.sessionId);
    }
    handleBrowserLevel(command);
  };

  const secret = randomBytes(24).toString("hex");
  const http: Server = createServer((_request, response) => {
    response.writeHead(404).end();
  });
  const wss = new WebSocketServer({ noServer: true, perMessageDeflate: false });
  http.on("upgrade", (request, socket, head) => {
    if (closed || downstream !== null || request.url !== `/devtools/browser/${secret}`) {
      socket.destroy();
      return;
    }
    wss.handleUpgrade(request, socket, head, (client) => {
      downstream = client;
      client.on("message", (data) => {
        const message = parse(data);
        if (message) handleDownstream(message);
      });
      client.on("close", () => {
        if (downstream === client) downstream = null;
      });
    });
  });
  await new Promise<void>((resolve) => http.listen(0, "127.0.0.1", resolve));
  const address = http.address();
  const port = typeof address === "object" && address ? address.port : 0;

  upstream.on("close", () => void close());

  async function close(): Promise<void> {
    if (closed) return;
    closed = true;
    downstream?.close();
    downstream = null;
    wss.close();
    await new Promise<void>((resolve) => http.close(() => resolve()));
    if (upstream.readyState === WebSocket.OPEN) {
      await sendOwn("Target.detachFromTarget", { sessionId: upstreamSessionId }).catch(
        () => undefined,
      );
      upstream.close();
    }
    for (const pending of pendingOwn.values()) pending.reject(new Error("Lease closed."));
    pendingOwn.clear();
  }

  return {
    url: `ws://127.0.0.1:${port}/devtools/browser/${secret}`,
    get closed() {
      return closed;
    },
    close,
  };
}
