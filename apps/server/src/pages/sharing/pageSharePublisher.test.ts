import { Effect } from "effect";
import WebSocket from "ws";
import { afterEach, describe, expect, it } from "vitest";

import { MossCloudAccountServiceError } from "../../account/mossCloudAccountErrors.ts";
import { makeMossServiceEntryRouter } from "../../account/mossServiceEntries.ts";
import type { ShareRelayTransportShape } from "../../guestShare/Services/ShareRelayTransport.ts";
import {
  currentShareRelayOrigin,
  SHARE_RELAY_ENTRIES_BY_REALM,
  shareRelayHealthUrl,
  type ShareRelayAccountSources,
} from "../../guestShare/shareRelayOrigin.ts";
import { FakeShareRelay } from "../../guestShare/testing/fakeShareRelay.ts";
import { makePageSharePublisher } from "./pageSharePublisher.ts";
import type { PageSharingStore, PublisherRow } from "./pageSharingStore.ts";

const CN = "https://share.mossbotai.com";
/** The CN relay's entry on comiction.cn, which lapses on 2026-11-27. */
const RETIRED = "https://moss-share.comiction.cn";
const SHARE_ID = "pagePublisherShare0001";

/**
 * Every https origin reaches the one fake relay, as the hostnames of one relay do; each request
 * and host socket is recorded with the origin it was addressed to.
 */
async function makeWorld(stored: PublisherRow) {
  const relay = await FakeShareRelay.start();
  const requests: Array<{ method: string; origin: string; bearer: boolean }> = [];
  const sockets: string[] = [];
  const toRelay = (address: string, scheme: "http" | "ws") => {
    const url = new URL(address);
    return `${relay.origin.replace(/^http/u, scheme)}${url.pathname}${url.search}`;
  };
  class RoutedWebSocket extends WebSocket {
    constructor(address: string | URL, options?: WebSocket.ClientOptions) {
      sockets.push(new URL(String(address)).origin.replace(/^ws/u, "http"));
      super(toRelay(String(address), "ws"), options);
    }
  }
  const routers: ShareRelayAccountSources["routers"] = (realm) =>
    makeMossServiceEntryRouter({
      service: `${realm} share relay`,
      entries: SHARE_RELAY_ENTRIES_BY_REALM[realm],
      healthUrl: shareRelayHealthUrl,
      probe: async () => true,
    });
  const transport: ShareRelayTransportShape = {
    env: {},
    fetch: async (input, init) => {
      const url = new URL(String(input));
      requests.push({
        method: init?.method ?? "GET",
        origin: url.origin,
        bearer: new Headers(init?.headers).has("authorization"),
      });
      return globalThis.fetch(toRelay(url.toString(), "http"), init);
    },
    webSocket: RoutedWebSocket as unknown as typeof WebSocket,
    backoff: { initialMs: 20, maxMs: 100, replacedMs: 100 },
    relayRouters: routers,
  };
  let row: PublisherRow | null = stored;
  const store = {
    getPublisher: Effect.sync(() => row),
    insertPublisher: (next: PublisherRow) => Effect.sync(() => void (row = next)),
    deletePublisher: Effect.sync(() => void (row = null)),
  } as unknown as PageSharingStore;
  const signedOut = () =>
    Effect.fail(new MossCloudAccountServiceError({ code: "authentication_required", message: "" }));
  const accountSources = {
    phoneAccount: {
      getLocalAuthority: () => Effect.succeed({ activeRealm: "cn" }),
      getAuthorityCredential: () =>
        Effect.succeed({
          realm: "memfire-phone",
          issuer: "https://phone.example",
          accessToken: "test-only-phone-bearer",
          gatewayBaseUrl: "https://gateway.example",
          realtimeRelayUrl: "wss://relay.example",
        }),
    },
    cloudAccount: {
      getLocalAuthority: () => Effect.succeed({ identity: null }),
      getAuthorityCredential: signedOut,
    },
    env: {},
    routers,
  } as unknown as ShareRelayAccountSources;
  const publisher = await Effect.runPromise(
    makePageSharePublisher({
      store,
      signingKey: new Uint8Array(32).fill(7),
      transport,
      accountSources,
      handle: async () => ({ status: 404, headers: {}, body: [] }) as never,
    }),
  );
  return { relay, requests, sockets, publisher, storedRow: () => row };
}

let world: Awaited<ReturnType<typeof makeWorld>> | null = null;

afterEach(async () => {
  world?.publisher.close();
  await world?.relay.close();
  world = null;
});

describe("currentShareRelayOrigin", () => {
  it("reads the retired comiction.cn entry as the CN relay's working host, and nothing else", () => {
    expect(currentShareRelayOrigin(RETIRED)).toBe(CN);
    expect(currentShareRelayOrigin(CN)).toBe(CN);
    expect(currentShareRelayOrigin("https://share-global.mossbotai.com")).toBe(
      "https://share-global.mossbotai.com",
    );
    expect(currentShareRelayOrigin("https://share.unknown-relay.example")).toBe(
      "https://share.unknown-relay.example",
    );
  });
});

describe("the page share publisher an older version stored", () => {
  it("on comiction.cn is renewed, hosted and linked on the working CN host; the bearer never goes to the old name", async () => {
    const stored = {
      share_id: SHARE_ID,
      relay_origin: RETIRED,
      created_at: "2026-11-01T00:00:00Z",
    };
    world = await makeWorld(stored);
    await Effect.runPromise(world.publisher.resume);
    await world.relay.waitForHost(SHARE_ID);

    expect(world.relay.registerCalls).toHaveLength(1);
    expect(world.requests.filter((request) => request.bearer)).toEqual([
      { method: "POST", origin: CN, bearer: true },
    ]);
    expect(world.sockets.length).toBeGreaterThan(0);
    for (const origin of world.sockets) expect(origin).toBe(CN);
    expect(world.requests.some((request) => request.origin === RETIRED)).toBe(false);
    // Links shown to the owner are built on the working host.
    expect(world.publisher.pageBase()).toBe(`${CN}/p/${SHARE_ID}`);
    expect(world.publisher.registration()?.parentOrigin).toBe(CN);
    // No row is rewritten.
    expect(world.storedRow()).toEqual(stored);
  });

  it("on an origin no realm lists is still not renewed with the account's bearer", async () => {
    const foreign = "https://share.unknown-relay.example";
    world = await makeWorld({
      share_id: SHARE_ID,
      relay_origin: foreign,
      created_at: "2026-11-01T00:00:00Z",
    });
    await Effect.runPromise(world.publisher.resume);

    expect(world.relay.registerCalls).toHaveLength(0);
    expect(world.requests.filter((request) => request.bearer)).toEqual([]);
    expect(world.publisher.registration()).toBeNull();
  });
});
