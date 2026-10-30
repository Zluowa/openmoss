// FILE: transport.ts
// Purpose: The guest page's calls to the owner's Moss through the share relay.
// Layer: Guest page
// Why: Everything that touches the network sits behind one interface, so the reconnect logic
//      and the UI are testable with a fake, and the dev harness can replay fixtures without a
//      relay. Same origin throughout: the session cookie rides along on its own.

import {
  GUEST_ROUTES,
  guestApiPath,
  parseGuestErrorBody,
  parseGuestStreamEvent,
  type GuestAccessErrorReason,
  type GuestStreamEvent,
} from "./protocol";

export type GuestFailure =
  | {
      readonly kind: "http";
      readonly status: number;
      readonly reason: GuestAccessErrorReason | null;
      /** The server's English fallback, for reasons this page does not know. */
      readonly message: string | null;
    }
  | { readonly kind: "network" };

export const NETWORK_FAILURE: GuestFailure = { kind: "network" };

export type SessionProbe =
  | { readonly ok: true }
  | { readonly ok: false; readonly failure: GuestFailure };

export interface GuestStreamHandlers {
  onEvent(event: GuestStreamEvent): void;
  /** The stream dropped or was refused; the caller decides whether to reconnect. */
  onError(): void;
}

export interface GuestTransport {
  /** 204 while this browser's session opens the share. */
  probeSession(): Promise<SessionProbe>;
  /** Spends the invite and sets the session cookie. Resolves to null on success. */
  redeem(credential: string, name: string): Promise<GuestFailure | null>;
  /** Proposes a message. JSON when there are no files, multipart otherwise. */
  submit(text: string, files: ReadonlyArray<File>): Promise<GuestFailure | null>;
  /** Opens the event stream; the returned function closes it. */
  openStream(handlers: GuestStreamHandlers): () => void;
  /** Where a file of the thread or of the guest's own messages loads from. */
  attachmentUrl(attachmentId: string): string;
}

async function failureOf(response: Response): Promise<GuestFailure> {
  const json: unknown = await response.json().catch(() => null);
  const body = parseGuestErrorBody(json);
  return { kind: "http", status: response.status, reason: body.reason, message: body.message };
}

export function createHttpGuestTransport(shareId: string): GuestTransport {
  const url = (route: keyof typeof GUEST_ROUTES) => guestApiPath(shareId, GUEST_ROUTES[route]);

  const post = async (route: "redeem" | "messages", init: RequestInit) => {
    let response: Response;
    try {
      response = await fetch(url(route), { ...init, method: "POST", cache: "no-store" });
    } catch {
      return NETWORK_FAILURE;
    }
    return response.ok ? null : failureOf(response);
  };

  return {
    async probeSession() {
      let response: Response;
      try {
        response = await fetch(url("session"), { cache: "no-store" });
      } catch {
        return { ok: false, failure: NETWORK_FAILURE };
      }
      return response.ok ? { ok: true } : { ok: false, failure: await failureOf(response) };
    },
    redeem(credential, name) {
      return post("redeem", {
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ credential, name }),
      });
    },
    submit(text, files) {
      if (files.length === 0) {
        return post("messages", {
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        });
      }
      const form = new FormData();
      form.append("text", text);
      for (const file of files) form.append("file", file, file.name);
      return post("messages", { body: form });
    },
    openStream(handlers) {
      // EventSource reaches every browser guests use (WeChat's X5/XWeb, iOS Safari). Its own
      // reconnect is disabled by closing on the first error: the page probes the session
      // instead, so an ended share or an offline owner is told apart from a dropped link.
      const source = new EventSource(url("stream"));
      let closed = false;
      source.addEventListener("message", (message: MessageEvent<string>) => {
        if (closed) return;
        const event = parseGuestStreamEvent(message.data);
        if (event !== null) handlers.onEvent(event);
      });
      source.addEventListener("error", () => {
        if (closed) return;
        closed = true;
        source.close();
        handlers.onError();
      });
      return () => {
        closed = true;
        source.close();
      };
    },
    attachmentUrl(attachmentId) {
      return `${url("attachment")}?id=${encodeURIComponent(attachmentId)}`;
    },
  };
}
