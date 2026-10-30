import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { MossAccountServiceError } from "../account/mossAccountErrors.ts";
import { MossCloudAccountServiceError } from "../account/mossCloudAccountErrors.ts";
import {
  parseShareRelayOrigin,
  resolveShareRelayAccount,
  SHARE_RELAY_ORIGIN_BY_REALM,
  shareRelayDevBearer,
  shareRelayOriginForRealm,
  type ShareRelayAccountSources,
} from "./shareRelayOrigin.ts";

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
});

const resolve = (input: Parameters<typeof sources>[0]) =>
  Effect.runPromise(resolveShareRelayAccount(sources(input)).pipe(Effect.result));

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

  it("maps realms to the regional relays unless overridden", () => {
    expect(shareRelayOriginForRealm("cn", {})).toBe(SHARE_RELAY_ORIGIN_BY_REALM.cn);
    expect(shareRelayOriginForRealm("global", {})).toBe(SHARE_RELAY_ORIGIN_BY_REALM.global);
    expect(shareRelayOriginForRealm("cn", { MOSS_SHARE_RELAY_URL: "http://localhost:1" })).toBe(
      "http://localhost:1",
    );
    expect(shareRelayOriginForRealm("cn", { MOSS_SHARE_RELAY_URL: "http://evil.example" })).toBe(
      SHARE_RELAY_ORIGIN_BY_REALM.cn,
    );
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
  it("uses the phone account on the CN relay by default", async () => {
    const result = await resolve({});
    expect(result._tag === "Success" && result.success).toEqual({
      origin: SHARE_RELAY_ORIGIN_BY_REALM.cn,
      bearer: "phone-token",
    });
  });

  it("prefers the active realm", async () => {
    const result = await resolve({ activeRealm: "global" });
    expect(result._tag === "Success" && result.success).toEqual({
      origin: SHARE_RELAY_ORIGIN_BY_REALM.global,
      bearer: "google-token",
    });
  });

  it("falls back to the other sign-in when the preferred one is signed out", async () => {
    const result = await resolve({ phone: signedOutPhone });
    expect(result._tag === "Success" && result.success).toEqual({
      origin: SHARE_RELAY_ORIGIN_BY_REALM.global,
      bearer: "google-token",
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
    });
  });

  it("keeps the override origin with a real account", async () => {
    const result = await resolve({ env: { MOSS_SHARE_RELAY_URL: "http://localhost:9" } });
    expect(result._tag === "Success" && result.success).toEqual({
      origin: "http://localhost:9",
      bearer: "phone-token",
    });
  });
});
