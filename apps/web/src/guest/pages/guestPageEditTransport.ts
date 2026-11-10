import {
  GUEST_ROUTES,
  PAGE_GUEST_EDIT_LIMITS as limits,
  guestApiPath,
  type PageGuestEditTicket,
  type PageGuestViewRequest,
} from "@moss/contracts";

export type GuestEditEntry = Pick<PageGuestViewRequest, "link" | "key" | "visitor">;
export type EditTicket = PageGuestEditTicket;
export interface OpenedProjection {
  ticket: EditTicket;
  revision: number;
  seed: Uint8Array;
  expiresAt: number;
}
export type EditEvent = { type: "ready"; revision: number } | { type: "refresh" | "ended" };
export type GuestEditFailure =
  | "unavailable"
  | "conflict"
  | "unsupported"
  | "invalid"
  | "rate-limited"
  | "forbidden"
  | "network";
export class GuestEditError extends Error {
  constructor(readonly reason: GuestEditFailure) {
    super(reason);
  }
}
const routes = {
  open: GUEST_ROUTES.pageEditOpen,
  update: GUEST_ROUTES.pageEditUpdate,
  close: GUEST_ROUTES.pageEditClose,
  events: GUEST_ROUTES.pageEditEvents,
} as const;
const object = (x: unknown): x is Record<string, unknown> =>
  !!x && typeof x === "object" && !Array.isArray(x);
const revision = (x: unknown): x is number =>
  typeof x === "number" && Number.isSafeInteger(x) && x > 0;
const failed = () => new GuestEditError("invalid");
export function encodeEditBytes(bytes: Uint8Array) {
  if (!bytes.length || bytes.length > limits.bytes) throw failed();
  let output = "";
  for (let i = 0; i < bytes.length; i += 8192)
    output += String.fromCharCode(...bytes.subarray(i, i + 8192));
  return btoa(output).replace(/\+/gu, "-").replace(/\//gu, "_").replace(/=+$/u, "");
}
export function decodeEditBytes(x: unknown) {
  if (
    typeof x !== "string" ||
    !x.length ||
    x.length > limits.encodedChars ||
    !/^[A-Za-z0-9_-]+$/u.test(x)
  )
    throw failed();
  try {
    const bytes = Uint8Array.from(atob(x.replace(/-/gu, "+").replace(/_/gu, "/")), (c) =>
      c.charCodeAt(0),
    );
    if (encodeEditBytes(bytes) !== x) throw failed();
    return bytes;
  } catch {
    throw failed();
  }
}
async function json(response: Response, limit: number): Promise<Record<string, unknown>> {
  if (
    response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
      "application/json" ||
    !response.body
  ) {
    await response.body?.cancel();
    throw failed();
  }
  const reader = response.body.getReader(),
    decoder = new TextDecoder("utf-8", { fatal: true });
  let size = 0,
    raw = "";
  try {
    for (;;) {
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > limit) throw failed();
      raw += decoder.decode(next.value, { stream: true });
    }
    const value: unknown = JSON.parse(raw + decoder.decode());
    if (!object(value)) throw failed();
    return value;
  } catch {
    throw failed();
  } finally {
    await reader.cancel().catch(() => {});
    reader.releaseLock();
  }
}
export interface GuestEditTransport {
  open(pageId: string, entry: GuestEditEntry, signal: AbortSignal): Promise<OpenedProjection>;
  submit(
    pageId: string,
    entry: GuestEditEntry,
    ticket: EditTicket,
    update: Uint8Array,
    signal: AbortSignal,
  ): Promise<{ revision: number; applied: boolean }>;
  events(
    pageId: string,
    entry: GuestEditEntry,
    ticket: EditTicket,
    signal: AbortSignal,
    receive: (e: EditEvent) => void,
  ): Promise<void>;
  close(pageId: string, entry: GuestEditEntry, ticket: EditTicket): Promise<void>;
}
const reasons = [
  "unavailable",
  "conflict",
  "unsupported",
  "invalid",
  "rate-limited",
  "forbidden",
] as const;
export function createGuestEditTransport(
  shareId: string,
  fetchImpl: typeof fetch,
): GuestEditTransport {
  const post = async (
    route: keyof typeof routes,
    body: unknown,
    signal: AbortSignal,
    sse = false,
  ) => {
    let response: Response;
    try {
      response = await fetchImpl(guestApiPath(shareId, routes[route]), {
        method: "POST",
        credentials: "omit",
        cache: "no-store",
        redirect: "error",
        referrerPolicy: "no-referrer",
        signal,
        headers: {
          "content-type": "application/json",
          accept: sse ? "text/event-stream" : "application/json",
        },
        body: JSON.stringify(body),
      });
    } catch {
      throw new GuestEditError("network");
    }
    if (!response.ok) {
      let raw: Record<string, unknown> = {};
      try {
        raw = await json(response, limits.jsonBytes);
      } catch {
        /* No diagnostics are displayed. */
      }
      if (response.status >= 500) throw new GuestEditError("network");
      throw new GuestEditError(reasons.find((v) => v === raw.reason) ?? "unavailable");
    }
    return response;
  };
  return {
    async open(pageId, entry, signal) {
      const start = Date.now();
      const v = await json(
        await post("open", { v: 1, pageId, entry }, signal),
        limits.updateBodyBytes,
      );
      if (
        v.v !== 1 ||
        v.expiresInMs !== limits.ttlMs ||
        !revision(v.revision) ||
        !object(v.ticket) ||
        typeof v.ticket.sessionKey !== "string" ||
        !/^[a-f0-9]{64}$/u.test(v.ticket.sessionKey) ||
        typeof v.ticket.epoch !== "string" ||
        !/^[a-f0-9]{32}$/u.test(v.ticket.epoch)
      )
        throw failed();
      return {
        ticket: { sessionKey: v.ticket.sessionKey, epoch: v.ticket.epoch },
        revision: v.revision,
        seed: decodeEditBytes(v.seed),
        expiresAt: start + limits.ttlMs,
      };
    },
    async submit(pageId, entry, ticket, update, signal) {
      const v = await json(
        await post(
          "update",
          { v: 1, pageId, entry, ticket, update: encodeEditBytes(update) },
          signal,
        ),
        limits.jsonBytes,
      );
      if (v.v !== 1 || !revision(v.revision) || typeof v.applied !== "boolean") throw failed();
      return { revision: v.revision, applied: v.applied };
    },
    async close(pageId, entry, ticket) {
      const abort = new AbortController(),
        timer = setTimeout(() => abort.abort(), 4000);
      try {
        const r = await post("close", { v: 1, pageId, entry, ticket }, abort.signal);
        await r.body?.cancel();
      } catch {
        /* TTL also retires a disconnected client. */
      } finally {
        clearTimeout(timer);
      }
    },
    async events(pageId, entry, ticket, signal, receive) {
      const response = await post("events", { v: 1, pageId, entry, ticket }, signal, true);
      if (
        response.headers.get("content-type")?.split(";", 1)[0]?.trim().toLowerCase() !==
          "text/event-stream" ||
        !response.body
      ) {
        await response.body?.cancel();
        throw failed();
      }
      const reader = response.body.getReader(),
        decoder = new TextDecoder("utf-8", { fatal: true });
      let pending = "",
        total = 0,
        ready = false;
      try {
        for (;;) {
          const item = await reader.read();
          if (item.done) throw new GuestEditError("network");
          if ((total += item.value.byteLength) > limits.streamBytes) throw failed();
          pending += decoder.decode(item.value, { stream: true });
          pending = pending.replace(/\r\n/gu, "\n");
          let cut: number;
          while ((cut = pending.indexOf("\n\n")) >= 0) {
            const block = pending.slice(0, cut);
            pending = pending.slice(cut + 2);
            if (!block || (block.startsWith(":") && !block.includes("\n"))) continue;
            if (!block.startsWith("data: ") || block.includes("\n") || block.length > 256)
              throw failed();
            const data: unknown = JSON.parse(block.slice(6));
            if (!object(data) || data.v !== 1) throw failed();
            if (data.type === "ready" && !ready && revision(data.revision)) {
              ready = true;
              receive({ type: "ready", revision: data.revision });
            } else if (data.type === "ended" || data.type === "refresh") {
              receive({ type: data.type });
              return;
            } else throw failed();
          }
          if (pending.length > 512) throw failed();
        }
      } finally {
        await reader.cancel().catch(() => {});
        reader.releaseLock();
      }
    },
  };
}
