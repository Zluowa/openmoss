import { describe, it, expect } from "vitest";
import {
  createGuestEditTransport,
  decodeEditBytes,
  encodeEditBytes,
} from "./guestPageEditTransport";
const id = "A".repeat(22),
  entry = { visitor: "visitor-fixture", key: "fixture-proof" },
  ticket = { sessionKey: "1".repeat(64), epoch: "2".repeat(32) };
const signal = new AbortController().signal,
  raw = (value: string) => new TextEncoder().encode(value);
const response = (chunks: Uint8Array[], type = "text/event-stream") =>
  new Response(
    new ReadableStream({
      start(ctrl) {
        for (const c of chunks) ctrl.enqueue(c);
        ctrl.close();
      },
    }),
    { headers: { "content-type": type } },
  );
describe("guest edit transport boundaries", () => {
  it("takes bounded canonical update bytes only", () => {
    for (const encoded of ["", "AQ==", "Af", "A+".repeat(10), "A".repeat(349527)])
      expect(() => decodeEditBytes(encoded)).toThrow();
    const largest = new Uint8Array(262144);
    largest[largest.length - 1] = 235;
    expect(decodeEditBytes(encodeEditBytes(largest)).at(-1)).toBe(235);
  });
  it("handles split SSE frames, comments and terminal refresh, never putting proof in URLs or cookies", async () => {
    const parts = [
      'data: {"v":1,',
      '"type":"ready","revision":8}\r',
      "\n\r\n: keepalive\r\n\r\n",
      'data: {"v":1,"type":"refresh"}\n\n',
    ];
    const t = createGuestEditTransport(id, (async (url, init) => {
      expect(String(url)).not.toContain(entry.key);
      expect(String(url)).not.toContain(ticket.sessionKey);
      expect(init).toMatchObject({
        method: "POST",
        credentials: "omit",
        referrerPolicy: "no-referrer",
        redirect: "error",
      });
      return response(parts.map(raw));
    }) as typeof fetch);
    const seen: unknown[] = [];
    await t.events("p", entry, ticket, signal, (e) => seen.push(e));
    expect(seen).toEqual([{ type: "ready", revision: 8 }, { type: "refresh" }]);
  });
  it.each([
    ["oversized", raw("x".repeat(16385))],
    ["data beyond bound", raw("data: " + "x".repeat(700) + "\n\n")],
    ["early EOF", raw(": keepalive\n\n")],
  ])("closes on %s instead of treating disconnection as an accepted save", async (_name, chunk) => {
    const t = createGuestEditTransport(id, (async () =>
      response([chunk as Uint8Array])) as typeof fetch);
    await expect(t.events("p", entry, ticket, signal, () => {})).rejects.toThrow();
  });
  it("does not interpret a proxy error as a decision by the owner", async () => {
    const t = createGuestEditTransport(
      id,
      (async () =>
        new Response(JSON.stringify({ message: "private diagnostics" }), {
          status: 503,
          headers: { "content-type": "application/json" },
        })) as typeof fetch,
    );
    await expect(t.submit("p", entry, ticket, Uint8Array.of(1), signal)).rejects.toMatchObject({
      reason: "network",
    });
  });
});
