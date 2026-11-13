// Real managed provider, real phone account service, fake Auth, fake gateway reachability:
// what a mainland account sees when direct HTTPS to the CN gateway's primary entry is reset
// (2026-11-12) and when it comes back.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore";
import { ServerConfig } from "../../config";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService";
import { ServerSettingsLive, ServerSettingsService } from "../../serverSettings";
import type { FetchMossGatewayModelIds } from "../mossGatewayModels";
import {
  makeMossServiceEntryRouter,
  mossModelGatewayHealthUrl,
  resetMossServiceEntryRoutersForTest,
} from "../mossServiceEntries";
import type { MemFirePhoneAuthAvailable, SupabaseMossAuthSession } from "../supabaseMossAuth";
import {
  MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
  MOSS_MANAGED_PROVIDER_ENV_KEY,
  MOSS_MANAGED_PROVIDER_INSTANCE_ID,
  MossManagedProviderLive,
  mossManagedCodexModelsForLane,
} from "./MossManagedProvider";
import { makeMossPhoneAccountService } from "./MossPhoneAccountService";

const PRIMARY = "https://moss-models.comiction.cn/functions/v1/moss-model-gateway/v1";
const FALLBACK = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
const PHONE = "+8613800138000";
const ISSUED_AT = 1_800_000_000_000;
const HOUR = 3_600_000;

const bearerJwt = (name: string, expiresAt: number): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url"),
    Buffer.from(JSON.stringify({ sub: name, exp: Math.floor(expiresAt / 1000) })).toString(
      "base64url",
    ),
    "test-signature",
  ].join(".");

const authSession = (name: string, expiresAt: number): SupabaseMossAuthSession => ({
  accessToken: bearerJwt(name, expiresAt),
  refreshToken: `${name}-refresh`,
  tokenType: "bearer",
  expiresInSeconds: 3_600,
  expiresAt,
  user: {
    id: "user-1",
    email: null,
    phone: PHONE,
    role: "authenticated",
    audience: "authenticated",
    emailConfirmedAt: null,
    phoneConfirmedAt: "2026-07-14T00:00:00.000Z",
    lastSignInAt: "2026-07-14T00:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    appMetadata: { provider: "phone", providers: ["phone"] },
    userMetadata: {},
  },
});

const makeSecretStore = (): ServerSecretStoreShape => {
  const values = new Map<string, Uint8Array>();
  return {
    get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
    set: (name, value) => Effect.sync(() => values.set(name, value.slice())).pipe(Effect.asVoid),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => values.get(name)?.slice() ?? new Uint8Array(bytes)),
    remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  };
};

/** No chat is running, so every re-provision may go ahead. */
const idleProviderService = {
  listSessions: () => Effect.succeed([]),
  getRuntimeSessionStopTarget: () =>
    Effect.succeed({ session: null, lifecycleGeneration: "generation-1" }),
  fenceProviderInstanceLaunchesAndWait: () => Effect.void,
  stopRuntimeSession: () => Effect.void,
  stopSession: () => Effect.void,
  stopCodexAccountRuntimes: () => Effect.void,
} as unknown as ProviderServiceShape;

const makeHarnessLayer = (baseDir: string) => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const baseLayer = Layer.mergeAll(
    NodeServices.layer,
    serverConfigLayer,
    Layer.succeed(ProviderService, idleProviderService),
    Layer.succeed(ServerSecretStore, makeSecretStore()),
  );
  const settingsLayer = ServerSettingsLive.pipe(Layer.provide(baseLayer));
  const dependencies = Layer.mergeAll(baseLayer, settingsLayer);
  return Layer.mergeAll(dependencies, MossManagedProviderLive.pipe(Layer.provide(dependencies)));
};

/** Where each Moss lane would send its model requests, and whether it is on. */
const managedLanes = Effect.gen(function* () {
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const lane = (id: string) => {
    const instance = settings.providerInstances[id];
    const config = instance?.config as Record<string, unknown> | undefined;
    return { enabled: instance?.enabled, gatewayBaseUrl: config?.gatewayBaseUrl };
  };
  const codex = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
  return {
    codex: lane(MOSS_MANAGED_PROVIDER_INSTANCE_ID),
    claude: lane(MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID),
    bearer: codex?.environment?.find((entry) => entry.name === MOSS_MANAGED_PROVIDER_ENV_KEY)
      ?.value,
  };
});

describe("a mainland phone account when the CN gateway's primary entry is reset", () => {
  let baseDir: string;
  let now: number;
  const reachable = new Set<string>();
  /** Hosts whose health check passes but whose real requests are reset (2026-11-13). */
  const resetsRequests = new Set<string>();

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "moss-cn-failover-"));
    now = ISSUED_AT;
    reachable.clear();
    resetsRequests.clear();
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", PRIMARY);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_FALLBACK_URLS", FALLBACK);
    vi.stubEnv(
      "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
      "https://moss-cn-realtime-edge.inkcomicai.com",
    );
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    resetMossServiceEntryRoutersForTest();
    rmSync(baseDir, { recursive: true, force: true });
  });

  const auth = (): MemFirePhoneAuthAvailable => {
    const config = {
      realm: "memfire-phone" as const,
      issuer: "https://moss.example.cn/auth/v1",
      cloudRegion: "cn" as const,
      modelGatewayUrl: PRIMARY,
      realtimeRelayUrl: "https://moss-cn-realtime-edge.inkcomicai.com",
    };
    return {
      status: "available",
      available: true,
      config,
      client: {
        config,
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => authSession("access-1", ISSUED_AT + 3 * HOUR),
        refresh: async () => authSession("access-2", now + 3 * HOUR),
        getUser: async () => authSession("unused", now + HOUR).user,
        updateUserMetadata: async () => authSession("unused", now + HOUR).user,
        logout: async () => ({ accepted: true }),
      },
    };
  };

  /**
   * The gateway answers on an entry whose host is reachable; otherwise the request fails below
   * HTTP, as the live catalog fetch reports a reset.
   */
  const fetchGatewayModels: FetchMossGatewayModelIds = (input) =>
    Effect.succeed(
      reachable.has(new URL(input.gatewayBaseUrl).host) &&
        !resetsRequests.has(new URL(input.gatewayBaseUrl).host)
        ? { status: "ready" as const, models: mossManagedCodexModelsForLane("cn") }
        : { status: "transport-degraded" as const, models: [], connectionFailed: true as const },
    );

  const makeService = () => {
    const entries = makeMossServiceEntryRouter({
      service: "CN model gateway",
      entries: [PRIMARY, FALLBACK],
      healthUrl: mossModelGatewayHealthUrl,
      probe: async (healthUrl) => reachable.has(new URL(healthUrl).host),
      now: () => now,
    });
    return makeMossPhoneAccountService({
      auth: auth(),
      now: () => now,
      fetchGatewayModels,
      modelGatewayEntries: entries,
    }).pipe(Effect.map((service) => ({ service, entries })));
  };

  const signIn = (service: Effect.Success<ReturnType<typeof makeMossPhoneAccountService>>) =>
    Effect.gen(function* () {
      const challenge = yield* service.startPhoneLogin({ phoneNumber: PHONE });
      return yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    });

  it("provisions every Moss lane on the entry that works, and moves them back to the primary", async () => {
    reachable.add("moss-cn-models.inkcomicai.com");
    const result = await Effect.gen(function* () {
      yield* (yield* ServerSettingsService).start;
      const { service, entries } = yield* makeService();
      yield* signIn(service);
      const afterSignIn = yield* managedLanes;
      const credential = yield* service.getAuthorityCredential();

      // The primary recovers. It failed at sign-in, so it is suspect for the cool-down (30
      // minutes) and then needs four good checks a minute apart; maintenance then moves the
      // lanes. Before that the lanes stay on the fallback.
      reachable.add("moss-models.comiction.cn");
      for (let minute = 1; minute <= 32; minute += 1) {
        now += 60_000;
        yield* Effect.promise(() => entries.refreshIfDue());
      }
      yield* service.maintainSession!();
      const beforeReturn = yield* managedLanes;
      now += 60_000;
      yield* Effect.promise(() => entries.refreshIfDue());
      yield* service.maintainSession!();
      const afterRecovery = yield* managedLanes;
      const session = yield* service.getSession();
      return { afterSignIn, credential, beforeReturn, afterRecovery, session };
    }).pipe(Effect.provide(makeHarnessLayer(baseDir)), Effect.runPromise);

    const bearer = bearerJwt("access-1", ISSUED_AT + 3 * HOUR);
    expect(result.afterSignIn).toEqual({
      codex: { enabled: true, gatewayBaseUrl: FALLBACK },
      claude: { enabled: true, gatewayBaseUrl: FALLBACK.replace(/\/v1$/, "") },
      bearer,
    });
    expect(result.credential.gatewayBaseUrl).toBe(FALLBACK);
    expect(result.beforeReturn.codex.gatewayBaseUrl).toBe(FALLBACK);
    expect(result.afterRecovery).toEqual({
      codex: { enabled: true, gatewayBaseUrl: PRIMARY },
      claude: { enabled: true, gatewayBaseUrl: PRIMARY.replace(/\/v1$/, "") },
      bearer,
    });
    expect(result.session.authenticated).toBe(true);
    expect(result.session.modelGatewayStatus).toBe("ready");
  });

  it("signs in on the fallback when the primary passes its checks but resets the real request", async () => {
    reachable.add("moss-models.comiction.cn");
    reachable.add("moss-cn-models.inkcomicai.com");
    resetsRequests.add("moss-models.comiction.cn");
    const result = await Effect.gen(function* () {
      yield* (yield* ServerSettingsService).start;
      const { service, entries } = yield* makeService();
      yield* signIn(service);
      return {
        lanes: yield* managedLanes,
        session: yield* service.getSession(),
        current: entries.current(),
      };
    }).pipe(Effect.provide(makeHarnessLayer(baseDir)), Effect.runPromise);

    expect(result.current).toBe(FALLBACK);
    expect(result.lanes.codex).toEqual({ enabled: true, gatewayBaseUrl: FALLBACK });
    expect(result.session.modelGatewayStatus).toBe("ready");
  });

  it("moves the lanes when the primary breaks mid-session", async () => {
    reachable.add("moss-models.comiction.cn");
    reachable.add("moss-cn-models.inkcomicai.com");
    const result = await Effect.gen(function* () {
      yield* (yield* ServerSettingsService).start;
      const { service, entries } = yield* makeService();
      yield* signIn(service);
      const beforeReset = yield* managedLanes;
      reachable.delete("moss-models.comiction.cn");
      // Before the re-check interval nothing changes; the background check then finds the
      // reset, and the next maintenance pass re-provisions on the fallback.
      now += 60_000;
      yield* Effect.promise(() => entries.refreshIfDue());
      yield* service.maintainSession!();
      const beforeCheck = yield* managedLanes;
      now += 5 * 60_000;
      yield* Effect.promise(() => entries.refreshIfDue());
      yield* service.maintainSession!();
      return { beforeReset, beforeCheck, afterReset: yield* managedLanes };
    }).pipe(Effect.provide(makeHarnessLayer(baseDir)), Effect.runPromise);

    expect(result.beforeReset.codex.gatewayBaseUrl).toBe(PRIMARY);
    expect(result.beforeCheck.codex.gatewayBaseUrl).toBe(PRIMARY);
    expect(result.afterReset.codex).toEqual({ enabled: true, gatewayBaseUrl: FALLBACK });
    expect(result.afterReset.claude).toEqual({
      enabled: true,
      gatewayBaseUrl: FALLBACK.replace(/\/v1$/, ""),
    });
  });

  it("shows the gateway as unreachable, not signed out, when every entry fails", async () => {
    const result = await Effect.gen(function* () {
      yield* (yield* ServerSettingsService).start;
      const { service, entries } = yield* makeService();
      yield* signIn(service);
      return {
        session: yield* service.getSession(),
        lanes: yield* managedLanes,
        unreachable: entries.allUnreachable(),
      };
    }).pipe(Effect.provide(makeHarnessLayer(baseDir)), Effect.runPromise);

    expect(result.unreachable).toBe(true);
    expect(result.session.authenticated).toBe(true);
    expect(result.session.modelGatewayStatus).toBe("transport-degraded");
    // The lanes stay in place on the primary, so a chat reports the outage instead.
    expect(result.lanes.codex).toEqual({ enabled: true, gatewayBaseUrl: PRIMARY });
  });
});
