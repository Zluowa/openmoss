/**
 * Checks every document request of a thread's browser before it leaves.
 *
 * One browser-level CDP client per browser auto-attaches to every page and
 * frame target the moment it is created, while it still waits for a debugger:
 * Fetch interception for documents is switched on first, and only then is the
 * target let run. So the first request of a tab, of a popup a script opened
 * and of a cross-site frame are checked like every later one, redirect hops
 * included (Fetch pauses each hop as its own request).
 *
 * A refused request is failed as aborted, so the tab stays on the page it was
 * on rather than committing an error page.
 *
 * @module serverBrowserDocumentGuard
 */
import { WebSocket, type RawData } from "ws";

import { serverBrowserHost } from "./serverBrowserNavigationGuard.ts";

interface CdpMessage {
  readonly id?: number;
  readonly method?: string;
  readonly params?: Record<string, unknown>;
  readonly sessionId?: string;
  readonly result?: unknown;
  readonly error?: unknown;
}

interface AttachedToTarget {
  readonly sessionId: string;
  readonly waitingForDebugger: boolean;
  readonly targetInfo: {
    readonly targetId: string;
    readonly type: string;
    /** The page that opened this one (`window.open`, a link with a target). */
    readonly openerId?: string;
  };
}

interface RequestPaused {
  readonly requestId: string;
  readonly request: { readonly url: string };
}

export interface ServerBrowserDocumentGuard {
  readonly close: () => Promise<void>;
}

const DOCUMENT_REQUESTS = {
  patterns: [{ urlPattern: "*", resourceType: "Document", requestStage: "Request" }],
};
const AUTO_ATTACH = { autoAttach: true, waitForDebuggerOnStart: true, flatten: true };

const parse = (data: RawData): CdpMessage | null => {
  try {
    const value = JSON.parse(data.toString()) as unknown;
    return typeof value === "object" && value !== null ? (value as CdpMessage) : null;
  } catch {
    return null;
  }
};

/**
 * Guard the browser at `browserCdpUrl`. `allow` decides each http(s) document
 * request; `onBlocked` names the top-level tab (its target id), the page that
 * opened it if any, and the host of every refused one, before it is failed.
 */
export async function guardServerBrowserDocuments(input: {
  readonly browserCdpUrl: string;
  readonly allow: (url: URL) => Promise<boolean>;
  readonly onBlocked: (
    tabTargetId: string,
    openerTargetId: string | undefined,
    host: string,
  ) => void;
}): Promise<ServerBrowserDocumentGuard> {
  const socket = new WebSocket(input.browserCdpUrl, { perMessageDeflate: false });
  await new Promise<void>((resolve, reject) => {
    socket.once("open", () => resolve());
    socket.once("error", reject);
  });
  socket.on("error", () => undefined);

  let nextId = 1;
  const pending = new Map<
    number,
    { resolve: (value: unknown) => void; reject: (e: Error) => void }
  >();
  /** Session → the tab (top-level page target) it belongs to. */
  const tabOfSession = new Map<string, string>();
  /** Tab → the tab that opened it. */
  const openerOfTab = new Map<string, string>();

  const send = (method: string, params: Record<string, unknown> = {}, sessionId?: string) =>
    new Promise<unknown>((resolve, reject) => {
      if (socket.readyState !== WebSocket.OPEN) {
        reject(new Error("The browser guard is closed."));
        return;
      }
      const id = nextId++;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) }));
    });

  const attached = async (parentSessionId: string | undefined, event: AttachedToTarget) => {
    const { sessionId, targetInfo } = event;
    const documents = targetInfo.type === "page" || targetInfo.type === "iframe";
    tabOfSession.set(
      sessionId,
      (parentSessionId && tabOfSession.get(parentSessionId)) || targetInfo.targetId,
    );
    if (targetInfo.type === "page" && targetInfo.openerId) {
      openerOfTab.set(targetInfo.targetId, targetInfo.openerId);
    }
    try {
      if (documents) {
        await send("Fetch.enable", DOCUMENT_REQUESTS, sessionId);
        // Frames the page creates attach through its session, held the same way.
        await send("Target.setAutoAttach", AUTO_ATTACH, sessionId);
      }
      if (event.waitingForDebugger) await send("Runtime.runIfWaitingForDebugger", {}, sessionId);
    } catch {
      // Fail closed: a document target that cannot be checked does not run.
      if (documents && socket.readyState === WebSocket.OPEN) {
        await send("Target.closeTarget", { targetId: targetInfo.targetId }).catch(() => undefined);
      }
    }
  };

  const paused = async (sessionId: string, event: RequestPaused) => {
    let url: URL | null = null;
    try {
      url = new URL(event.request.url);
    } catch {
      // Not a URL the guard can judge; the browser's own rules apply.
    }
    const web = url !== null && (url.protocol === "http:" || url.protocol === "https:");
    if (!web || (await input.allow(url!).catch(() => false))) {
      await send("Fetch.continueRequest", { requestId: event.requestId }, sessionId);
      return;
    }
    const tab = tabOfSession.get(sessionId) ?? "";
    input.onBlocked(tab, openerOfTab.get(tab), serverBrowserHost(url!));
    await send(
      "Fetch.failRequest",
      { requestId: event.requestId, errorReason: "Aborted" },
      sessionId,
    );
  };

  socket.on("message", (data) => {
    const message = parse(data);
    if (!message) return;
    if (typeof message.id === "number") {
      const waiter = pending.get(message.id);
      if (!waiter) return;
      pending.delete(message.id);
      if (message.error) waiter.reject(new Error(JSON.stringify(message.error)));
      else waiter.resolve(message.result);
      return;
    }
    switch (message.method) {
      case "Target.attachedToTarget":
        void attached(message.sessionId, message.params as unknown as AttachedToTarget);
        return;
      case "Target.detachedFromTarget": {
        const detached = (message.params as { sessionId?: string } | undefined)?.sessionId;
        if (detached) {
          const tab = tabOfSession.get(detached);
          tabOfSession.delete(detached);
          if (tab) openerOfTab.delete(tab);
        }
        return;
      }
      case "Fetch.requestPaused":
        if (message.sessionId) {
          void paused(message.sessionId, message.params as unknown as RequestPaused).catch(
            () => undefined,
          );
        }
        return;
    }
  });
  socket.on("close", () => {
    for (const waiter of pending.values()) waiter.reject(new Error("The browser guard closed."));
    pending.clear();
  });

  try {
    await send("Target.setAutoAttach", AUTO_ATTACH);
  } catch (error) {
    socket.close();
    throw error;
  }

  return {
    close: async () => {
      if (socket.readyState === WebSocket.CLOSED) return;
      await new Promise<void>((resolve) => {
        socket.once("close", () => resolve());
        socket.close();
      });
    },
  };
}
