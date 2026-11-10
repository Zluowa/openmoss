// FILE: pageRealtimeTokens.ts
// Purpose: Short-lived, single-use tickets that admit one window to one Page room.
// Layer: Pages realtime (collab)
// Why: The room socket is a plain WebSocket outside the RPC connection. An authenticated RPC
//      caller asks for a ticket naming the Page and the mode it may use; the socket presents it
//      once. A ticket cannot open another Page, outlive a minute, or be replayed, and the signing
//      key lives only in this process, so a restart invalidates every outstanding ticket.

import { createHmac, randomBytes, timingSafeEqual } from "node:crypto";

export type RealtimeTicketMode = "edit" | "view";

export interface RealtimeTicket {
  readonly pageId: string;
  readonly scopeSpaceId: string | null;
  readonly mode: RealtimeTicketMode;
  readonly expiresAt: number;
}

export const REALTIME_TICKET_TTL_MS = 60_000;

const encode = (value: Buffer | string) => Buffer.from(value).toString("base64url");

export class PageRealtimeTickets {
  private readonly key = randomBytes(32);
  private readonly used = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  issue(input: Omit<RealtimeTicket, "expiresAt">): { token: string; expiresAt: number } {
    const expiresAt = this.now() + REALTIME_TICKET_TTL_MS;
    const body = encode(
      JSON.stringify({
        v: 1,
        p: input.pageId,
        s: input.scopeSpaceId,
        m: input.mode,
        e: expiresAt,
        n: randomBytes(12).toString("base64url"),
      }),
    );
    return { token: `${body}.${this.sign(body)}`, expiresAt };
  }

  /** Returns the ticket once; a second presentation, a forged or expired one returns null. */
  redeem(token: string, pageId: string): RealtimeTicket | null {
    const [body, signature, extra] = token.split(".");
    if (!body || !signature || extra !== undefined || token.length > 2_048) return null;
    const expected = Buffer.from(this.sign(body));
    const actual = Buffer.from(signature);
    if (expected.length !== actual.length || !timingSafeEqual(expected, actual)) return null;
    let value: { v?: unknown; p?: unknown; s?: unknown; m?: unknown; e?: unknown; n?: unknown };
    try {
      value = JSON.parse(Buffer.from(body, "base64url").toString("utf8"));
    } catch {
      return null;
    }
    const now = this.now();
    this.forgetExpired(now);
    if (
      value.v !== 1 ||
      value.p !== pageId ||
      (value.m !== "edit" && value.m !== "view") ||
      typeof value.e !== "number" ||
      value.e <= now ||
      typeof value.n !== "string" ||
      !(value.s === null || typeof value.s === "string") ||
      this.used.has(value.n)
    )
      return null;
    this.used.set(value.n, value.e);
    return { pageId, scopeSpaceId: value.s, mode: value.m, expiresAt: value.e };
  }

  private sign(body: string) {
    return createHmac("sha256", this.key).update(body).digest("base64url");
  }

  private forgetExpired(now: number) {
    for (const [nonce, expiresAt] of this.used) if (expiresAt <= now) this.used.delete(nonce);
  }
}
