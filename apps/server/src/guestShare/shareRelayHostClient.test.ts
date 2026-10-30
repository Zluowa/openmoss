import { createHash } from "node:crypto";

import { GuestShareId, SHARE_RELAY_CHUNK_BYTES, SHARE_RELAY_CLOSE_CODES } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  ShareRelayHostClient,
  type GuestRelayRequest,
  type GuestRelayRequestHandler,
  type GuestRelayResponse,
} from "./shareRelayHostClient.ts";
import { FakeShareRelay } from "./testing/fakeShareRelay.ts";

const SHARE_ID = GuestShareId.makeUnsafe("AAAAAAAAAAAAAAAAAAAAAA");
const HOST_KEY = "host-key-for-tests";
const HOST_KEY_HASH = createHash("sha256").update(HOST_KEY).digest("base64url");
const EXPIRES_AT = new Date(Date.now() + 60_000).toISOString();

const jsonBody = (value: unknown): ReadableStream<Uint8Array> =>
  new ReadableStream({
    start: (controller) => {
      controller.enqueue(new TextEncoder().encode(JSON.stringify(value)));
      controller.close();
    },
  });

const readAll = async (body: ReadableStream<Uint8Array>): Promise<string> => {
  const reader = body.getReader();
  const chunks: Array<Uint8Array> = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
};

const waitFor = async (predicate: () => boolean, timeoutMs = 5_000): Promise<void> => {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) throw new Error("Condition not met in time.");
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
};

describe("ShareRelayHostClient", () => {
  let relay: FakeShareRelay;
  const clients: Array<ShareRelayHostClient> = [];

  const makeClient = (input: {
    readonly handle?: GuestRelayRequestHandler;
    readonly onEnded?: () => void;
    readonly reregister?: () => Promise<boolean>;
  }) => {
    const statuses: Array<string> = [];
    const client = new ShareRelayHostClient({
      origin: relay.origin,
      shareId: SHARE_ID,
      hostKey: HOST_KEY,
      handle:
        input.handle ??
        (() =>
          Promise.resolve<GuestRelayResponse>({
            status: 204,
            headers: {},
            body: null,
          })),
      onStatus: (status) => statuses.push(status),
      onEnded: input.onEnded ?? (() => undefined),
      reregister: input.reregister ?? (() => Promise.resolve(false)),
      backoff: { initialMs: 20, maxMs: 100, replacedMs: 100 },
    });
    clients.push(client);
    return { client, statuses };
  };

  beforeEach(async () => {
    relay = await FakeShareRelay.start();
    relay.registrations.set(SHARE_ID, {
      shareId: SHARE_ID,
      hostKeyHash: HOST_KEY_HASH,
      expiresAt: EXPIRES_AT,
      bearer: "bearer",
    });
  });

  afterEach(async () => {
    for (const client of clients.splice(0)) client.close();
    await relay.close();
  });

  it("says hello, goes online, and answers pings", async () => {
    const { client, statuses } = makeClient({});
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    await waitFor(() => client.status === "online");
    expect(statuses).toEqual(["connecting", "online"]);
    await host.ping();
    expect(host.pongs).toHaveLength(1);
  });

  it("answers a request with a streaming body in both directions", async () => {
    const seen: Array<GuestRelayRequest> = [];
    const { client } = makeClient({
      handle: async (request) => {
        seen.push(request);
        const received = request.body === null ? "" : await readAll(request.body);
        const big = "x".repeat(SHARE_RELAY_CHUNK_BYTES * 2 + 17);
        return {
          status: 200,
          headers: { "content-type": "application/json" },
          body: jsonBody({ received, big }),
        };
      },
    });
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    const { response } = host.request({
      method: "POST",
      route: "messages",
      query: "a=1",
      headers: { "content-type": "application/json", cookie: "moss_guest=token" },
      body: [new TextEncoder().encode('{"text":"he'), new TextEncoder().encode('llo"}')],
    });
    const head = await response.head;
    expect(head).toEqual({ status: 200, headers: { "content-type": "application/json" } });
    const body = JSON.parse(await response.text()) as { received: string; big: string };
    expect(body.received).toBe('{"text":"hello"}');
    expect(body.big).toHaveLength(SHARE_RELAY_CHUNK_BYTES * 2 + 17);
    expect(seen[0]).toMatchObject({ method: "POST", route: "messages", query: "a=1" });
    expect(seen[0]?.headers.cookie).toBe("moss_guest=token");
    expect(host.frames.filter((frame) => frame.t === "res-end")).toHaveLength(1);
  });

  it("forwards a request without a body as null and strips the body for HEAD", async () => {
    const bodies: Array<ReadableStream<Uint8Array> | null> = [];
    const { client } = makeClient({
      handle: (request) => {
        bodies.push(request.body);
        return Promise.resolve({ status: 200, headers: {}, body: jsonBody({ ok: true }) });
      },
    });
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    const get = host.request({ method: "GET", route: "session" });
    expect((await get.response.head).status).toBe(200);
    expect(await get.response.text()).toBe('{"ok":true}');
    const head = host.request({ method: "HEAD", route: "session" });
    expect((await head.response.head).status).toBe(200);
    expect(await head.response.text()).toBe("");
    expect(bodies).toEqual([null, null]);
  });

  it("aborts the handler when the relay cancels a request", async () => {
    let aborted = false;
    const { client } = makeClient({
      handle: (request) =>
        new Promise<GuestRelayResponse>((resolve) => {
          request.signal.addEventListener("abort", () => {
            aborted = true;
            resolve({ status: 200, headers: {}, body: null });
          });
        }),
    });
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    const { id } = host.request({ method: "GET", route: "stream" });
    await new Promise((resolve) => setTimeout(resolve, 20));
    host.cancel(id);
    await waitFor(() => aborted);
    await new Promise((resolve) => setTimeout(resolve, 20));
    // Nothing is sent for a cancelled request.
    expect(host.frames.filter((frame) => frame.t === "res")).toHaveLength(0);
  });

  it("stops a streaming response when the guest goes away", async () => {
    let pulls = 0;
    let cancelled = false;
    const { client } = makeClient({
      handle: () =>
        Promise.resolve({
          status: 200,
          headers: { "content-type": "text/event-stream" },
          body: new ReadableStream<Uint8Array>({
            pull: async (controller) => {
              pulls += 1;
              await new Promise((resolve) => setTimeout(resolve, 5));
              controller.enqueue(new TextEncoder().encode(": ping\n\n"));
            },
            cancel: () => {
              cancelled = true;
            },
          }),
        }),
    });
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    const { id, response } = host.request({ method: "GET", route: "stream" });
    expect((await response.head).status).toBe(200);
    expect(await response.next()).not.toBeNull();
    host.cancel(id);
    await waitFor(() => cancelled);
    const pullsAtCancel = pulls;
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(pulls).toBeLessThanOrEqual(pullsAtCancel + 1);
  });

  it("answers a failed handler with a 500 and still ends the response", async () => {
    const { client } = makeClient({ handle: () => Promise.reject(new Error("boom")) });
    client.start();
    const host = await relay.waitForHost(SHARE_ID);
    const { response } = host.request({ method: "GET", route: "session" });
    expect((await response.head).status).toBe(500);
    expect(await response.text()).toBe("");
  });

  it("registers again and reconnects when the relay forgot the share", async () => {
    let reregistered = 0;
    const { client, statuses } = makeClient({
      reregister: () => {
        reregistered += 1;
        relay.registrations.set(SHARE_ID, {
          shareId: SHARE_ID,
          hostKeyHash: HOST_KEY_HASH,
          expiresAt: EXPIRES_AT,
          bearer: "bearer",
        });
        return Promise.resolve(true);
      },
    });
    client.start();
    const first = await relay.waitForHost(SHARE_ID);
    relay.forget(SHARE_ID);
    const second = await relay.waitForHost(SHARE_ID);
    expect(second).not.toBe(first);
    expect(reregistered).toBe(1);
    await waitFor(() => client.status === "online");
    expect(statuses).toEqual(["connecting", "online", "offline", "connecting", "online"]);
  });

  it("reconnects with backoff after an ordinary drop", async () => {
    const { client } = makeClient({});
    client.start();
    const first = await relay.waitForHost(SHARE_ID);
    first.socket.terminate();
    const second = await relay.waitForHost(SHARE_ID);
    expect(second).not.toBe(first);
    await waitFor(() => client.status === "online");
  });

  it("keeps the share and reconnects when the relay restarts (1012)", async () => {
    let ended = 0;
    const { client } = makeClient({ onEnded: () => void (ended += 1) });
    client.start();
    const first = await relay.waitForHost(SHARE_ID);
    await waitFor(() => client.status === "online");
    first.socket.close(SHARE_RELAY_CLOSE_CODES.restarting, "relay restarting");
    const second = await relay.waitForHost(SHARE_ID);
    expect(second).not.toBe(first);
    await waitFor(() => client.status === "online");
    expect(ended).toBe(0);
  });

  it("ends the share and stays closed on 4410", async () => {
    let ended = 0;
    const { client, statuses } = makeClient({ onEnded: () => void (ended += 1) });
    client.start();
    await relay.waitForHost(SHARE_ID);
    relay.end(SHARE_ID);
    await waitFor(() => ended === 1);
    await new Promise((resolve) => setTimeout(resolve, 150));
    expect(relay.hosts.has(SHARE_ID)).toBe(false);
    expect(statuses.at(-1)).toBe("offline");
    expect(client.status).toBe("offline");
  });

  it("backs off longer after another host took over", async () => {
    const { client } = makeClient({});
    client.start();
    const first = await relay.waitForHost(SHARE_ID);
    await waitFor(() => client.status === "online");
    // A second host of the same owner connects; the relay replaces the first.
    const { client: other } = makeClient({});
    other.start();
    await waitFor(() => relay.hosts.get(SHARE_ID)?.socket !== first.socket);
    await waitFor(() => client.status === "offline");
    expect(other.status === "online" || other.status === "connecting").toBe(true);
  });
});
