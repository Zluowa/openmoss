import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { MossRealm } from "@moss/shared/mossRealmCatalog";

import { MossAccountServiceError } from "../account/mossAccountErrors.ts";
import { MossCloudAccountServiceError } from "../account/mossCloudAccountErrors.ts";
import {
  makeMossServiceEntryRouter,
  type MossServiceEntryRouter,
} from "../account/mossServiceEntries.ts";
import {
  isOnAccountShareRelay,
  parseShareRelayOrigin,
  resolveShareRelayAccount,
  SHARE_RELAY_ENTRIES_BY_REALM,
  shareRelayDevBearer,
  shareRelayEntriesForOrigin,
  shareRelayEntriesForRealm,
  shareRelayEntryRouter,
  shareRelayHealthUrl,
  type ShareRelayAccountSources,
} from "./shareRelayOrigin.ts";

const CN_NEW = "https://share.mossbotai.com";
const CN_OLD = "https://moss-share.comiction.cn";
const GLOBAL_NEW = "https://share-global.mossbotai.com";
const GLOBAL_OLD = "https://moss-share.inkcomicai.com";

/** Each realm's router over the real entries, with health answered from `reachable`. */
const stubRouters = (reachable: ReadonlySet<string>) => {
  const routers = new Map<MossRealm, MossServiceEntryRouter>();
  const probed: string[] = [];
  return {
    probed,
    routers: (realm: MossRealm) => {
      let router = routers.get(realm);
      if (!router) {
        router = makeMossServiceEntryRouter({
          service: `${realm} share relay`,
          entries: SHARE_RELAY_ENTRIES_BY_REALM[realm],
          healthUrl: shareRelayHealthUrl,
          probe: async (healthUrl) => {
            probed.push(healthUrl);
            return reachable.has(new URL(healthUrl).origin);
          },
        });
        routers.set(realm, router);
      }
      return router;
    },
  };
};

const phoneCredential = {
  realm: "memfire-phone",
  issuer: "https://phone.example",
  accessToken: "phone-token",
  gatewayBaseUrl: "https://gateway.cn.example",
  realtimeRelayUrl: "wss://relay.cn.example",
} as const;
const cloudCredential = {
  realm: "supabase-google",
  issuer: "https://google.example",
  accessToken: "google-token",
  gatewayBaseUrl: "https://gateway.example",
  realtimeRelayUrl: "wss://relay.example",
} as const;

const signedOutPhone = new MossAccountServiceError({
  code: "authentication_required",
  message: "signed out",
});
const signedOutCloud = new MossCloudAccountServiceError({
  code: "authentication_required",
  message: "signed out",
});

const sources = (input: {
  readonly phone?: typeof phoneCredential | MossAccountServiceError;
  readonly cloud?: typeof cloudCredential | MossCloudAccountServiceError;
  readonly activeRealm?: "cn" | "global";
  readonly env?: NodeJS.ProcessEnv;
  readonly reachable?: ReadonlySet<string>;
}): ShareRelayAccountSources => ({
  phoneAccount: {
    getLocalAuthority: () =>
      Effect.succeed({
        ...(input.activeRealm === "cn" ? { activeRealm: "cn" as const } : {}),
        identity: null,
      }),
    getAuthorityCredential: () =>
      input.phone instanceof MossAccountServiceError
        ? Effect.fail(input.phone)
        : Effect.succeed(input.phone ?? phoneCredential),
  },
  cloudAccount: {
    getLocalAuthority: () =>
      Effect.succeed({
        ...(input.activeRealm === "global" ? { activeRealm: "global" as const } : {}),
        identity: null,
      }),
    getAuthorityCredential: () =>
      input.cloud instanceof MossCloudAccountServiceError
        ? Effect.fail(input.cloud)
        : Effect.succeed(input.cloud ?? cloudCredential),
  },
  env: input.env ?? {},
  routers: stubRouters(input.reachable ?? new Set([CN_NEW, CN_OLD, GLOBAL_NEW, GLOBAL_OLD]))
    .routers,
});

const resolve = (input: Parameters<typeof sources>[0]) =>
  Effect.runPromise(resolveShareRelayAccount(sources(input)).pipe(Effect.result));

const success = (result: Awaited<ReturnType<typeof resolve>>) =>
  result._tag === "Success"
    ? {
        origin: result.success.origin,
        bearer: result.success.bearer,
        entries: result.success.relay.entries,
      }
    : null;

describe("parseShareRelayOrigin", () => {
  it("accepts https origins and loopback http only", () => {
    expect(parseShareRelayOrigin("https://moss-share.example/")).toBe("https://moss-share.example");
    expect(parseShareRelayOrigin("http://localhost:8787")).toBe("http://localhost:8787");
    expect(parseShareRelayOrigin("http://127.0.0.1:8787/")).toBe("http://127.0.0.1:8787");
    expect(parseShareRelayOrigin("http://relay.example")).toBeNull();
    expect(parseShareRelayOrigin("https://relay.example/path")).toBeNull();
    expect(parseShareRelayOrigin("https://user:pw@relay.example")).toBeNull();
    expect(parseShareRelayOrigin("nonsense")).toBeNull();
  });

  it("lists each realm's entries, mossbotai.com first, the old hostname after it", () => {
    expect(SHARE_RELAY_ENTRIES_BY_REALM).toEqual({
      cn: [CN_NEW, CN_OLD],
      global: [GLOBAL_NEW, GLOBAL_OLD],
    });
    for (const realm of ["cn", "global"] as const) {
      expect(shareRelayEntryRouter(realm).entries).toEqual(SHARE_RELAY_ENTRIES_BY_REALM[realm]);
    }
    expect(shareRelayHealthUrl(CN_NEW)).toBe(`${CN_NEW}/healthz`);
  });

  it("maps realms to the regional relays unless overridden, and an override has no router", () => {
    const { routers } = stubRouters(new Set());
    expect(shareRelayEntriesForRealm("cn", {}, routers).entries).toEqual([CN_NEW, CN_OLD]);
    expect(shareRelayEntriesForRealm("global", {}, routers).entries).toEqual([
      GLOBAL_NEW,
      GLOBAL_OLD,
    ]);
    expect(
      shareRelayEntriesForRealm("cn", { MOSS_SHARE_RELAY_URL: "http://localhost:1" }, routers),
    ).toEqual({ entries: ["http://localhost:1"], router: null });
    expect(
      shareRelayEntriesForRealm("cn", { MOSS_SHARE_RELAY_URL: "http://evil.example" }, routers)
        .entries,
    ).toEqual([CN_NEW, CN_OLD]);
  });

  it("finds the relay a stored share lives on, by any of its entries", () => {
    const { routers, probed } = stubRouters(new Set());
    expect(shareRelayEntriesForOrigin(CN_OLD, {}, routers).router).toBe(routers("cn"));
    expect(shareRelayEntriesForOrigin(CN_NEW, {}, routers).router).toBe(routers("cn"));
    expect(shareRelayEntriesForOrigin(GLOBAL_OLD, {}, routers).router).toBe(routers("global"));
    expect(shareRelayEntriesForOrigin("https://relay.example", {}, routers)).toEqual({
      entries: ["https://relay.example"],
      router: null,
    });
    // With the override set, a stored share keeps its own origin, as before.
    expect(
      shareRelayEntriesForOrigin(CN_OLD, { MOSS_SHARE_RELAY_URL: "http://127.0.0.1:9" }, routers),
    ).toEqual({ entries: [CN_OLD], router: null });
    // Finding a router sends nothing.
    expect(probed).toEqual([]);
  });

  it("honors the dev bearer only with a loopback override", () => {
    expect(
      shareRelayDevBearer({
        MOSS_SHARE_RELAY_URL: "http://localhost:1",
        MOSS_SHARE_RELAY_DEV_BEARER: "dev",
      }),
    ).toBe("dev");
    expect(
      shareRelayDevBearer({
        MOSS_SHARE_RELAY_URL: "https://moss-share.example",
        MOSS_SHARE_RELAY_DEV_BEARER: "dev",
      }),
    ).toBeNull();
    expect(shareRelayDevBearer({ MOSS_SHARE_RELAY_DEV_BEARER: "dev" })).toBeNull();
  });
});

describe("resolveShareRelayAccount", () => {
  it("uses the phone account on the CN relay's new entry by default", async () => {
    expect(success(await resolve({}))).toEqual({
      origin: CN_NEW,
      bearer: "phone-token",
      entries: [CN_NEW, CN_OLD],
    });
  });

  it("uses the old entry when the new one does not answer", async () => {
    expect(success(await resolve({ reachable: new Set([CN_OLD]) }))).toEqual({
      origin: CN_OLD,
      bearer: "phone-token",
      entries: [CN_NEW, CN_OLD],
    });
  });

  it("prefers the active realm", async () => {
    expect(success(await resolve({ activeRealm: "global" }))).toEqual({
      origin: GLOBAL_NEW,
      bearer: "google-token",
      entries: [GLOBAL_NEW, GLOBAL_OLD],
    });
  });

  it("falls back to the other sign-in when the preferred one is signed out", async () => {
    expect(success(await resolve({ phone: signedOutPhone }))).toEqual({
      origin: GLOBAL_NEW,
      bearer: "google-token",
      entries: [GLOBAL_NEW, GLOBAL_OLD],
    });
  });

  it("requires an account when neither sign-in is available", async () => {
    const result = await resolve({ phone: signedOutPhone, cloud: signedOutCloud });
    expect(result._tag === "Failure" && result.failure.code).toBe("guest_share.account_required");
  });

  it("reports a transient account failure as the relay being unavailable", async () => {
    const result = await resolve({
      phone: new MossAccountServiceError({
        code: "authentication_service_unavailable",
        message: "down",
      }),
      cloud: signedOutCloud,
    });
    expect(result._tag === "Failure" && result.failure.code).toBe("guest_share.relay_unavailable");
  });

  it("uses the dev bearer with a loopback override and no account", async () => {
    const result = await resolve({
      phone: signedOutPhone,
      cloud: signedOutCloud,
      env: { MOSS_SHARE_RELAY_URL: "http://127.0.0.1:9", MOSS_SHARE_RELAY_DEV_BEARER: "dev" },
    });
    expect(result._tag === "Success" && result.success).toEqual({
      origin: "http://127.0.0.1:9",
      bearer: "dev",
      relay: { entries: ["http://127.0.0.1:9"], router: null },
    });
  });

  it("keeps the override origin with a real account", async () => {
    const result = await resolve({ env: { MOSS_SHARE_RELAY_URL: "http://localhost:9" } });
    expect(result._tag === "Success" && result.success).toEqual({
      origin: "http://localhost:9",
      bearer: "phone-token",
      relay: { entries: ["http://localhost:9"], router: null },
    });
  });
});

describe("isOnAccountShareRelay", () => {
  it("renews a share through any entry of the account's relay, never another relay's", async () => {
    const cn = await resolve({});
    const global = await resolve({ activeRealm: "global" });
    const override = await resolve({ env: { MOSS_SHARE_RELAY_URL: "http://localhost:9" } });
    if (cn._tag !== "Success" || global._tag !== "Success" || override._tag !== "Success") {
      throw new Error("expected accounts");
    }
    expect(isOnAccountShareRelay(cn.success, CN_NEW)).toBe(true);
    expect(isOnAccountShareRelay(cn.success, CN_OLD)).toBe(true);
    expect(isOnAccountShareRelay(cn.success, GLOBAL_NEW)).toBe(false);
    expect(isOnAccountShareRelay(cn.success, GLOBAL_OLD)).toBe(false);
    expect(isOnAccountShareRelay(cn.success, "http://localhost:9")).toBe(false);
    expect(isOnAccountShareRelay(global.success, GLOBAL_OLD)).toBe(true);
    expect(isOnAccountShareRelay(global.success, CN_OLD)).toBe(false);
    expect(isOnAccountShareRelay(override.success, "http://localhost:9")).toBe(true);
    expect(isOnAccountShareRelay(override.success, CN_NEW)).toBe(false);
  });
});
