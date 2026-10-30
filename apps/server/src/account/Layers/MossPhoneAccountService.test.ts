import { Effect, Fiber, Layer, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

// The gateway catalog is exercised by mossGatewayModels.test.ts; these service
// tests stay offline and inject a representative authoritative lineup.
vi.mock("../mossGatewayModels", async () => {
  const { Effect } = await import("effect");
  const { mossManagedCodexModelsForLane } = await import("./MossManagedProvider");
  return {
    fetchMossGatewayModelIds: () =>
      Effect.succeed({
        status: "ready",
        models: mossManagedCodexModelsForLane("cn"),
      }),
    normalizeMossGatewayModelCatalog: (value: unknown) =>
      value === null
        ? { status: "transport-degraded", models: [] }
        : Array.isArray(value)
          ? { status: value.length > 0 ? "ready" : "no-entitlement", models: value }
          : value,
  };
});

import {
  SecretStoreError,
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore";
import { makeMossManagedProviderCoordinator } from "../mossAccountLifecycleLock";
import {
  MossManagedProvider,
  type MossManagedProviderShape,
} from "../Services/MossManagedProvider";
import { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import {
  createMemFirePhoneAuth,
  SupabaseMossAuthError,
  type MemFirePhoneAuthAvailable,
  type MemFirePhoneAuthClient,
  type SupabaseMossAuthSession,
} from "../supabaseMossAuth";
import { makeMossPhoneAccountService } from "./MossPhoneAccountService";

const TEST_MEMFIRE_ISSUER = "https://moss.example.cn/auth/v1";

const unexpected = async (): Promise<never> => {
  throw new Error("unexpected auth call");
};

const syntheticAccessJwt = (payload: Readonly<Record<string, unknown>>): string =>
  [
    Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" }), "utf8").toString("base64url"),
    Buffer.from(JSON.stringify(payload), "utf8").toString("base64url"),
    "test-signature",
  ].join(".");

// Phone accounts provision the complete CN OpenRouter lineup, default first.
const expectedManagedProvisionModels = [
  "deepseek-v4-pro",
  "deepseek-v4-flash",
  "glm-5.3",
  "glm-5.3-flash",
  "kimi-k3",
  "minimax-m3",
  "qwen3.8-max",
] as const;

const makeClient = (overrides: Partial<MemFirePhoneAuthClient> = {}): MemFirePhoneAuthClient => ({
  config: {
    realm: "memfire-phone",
    issuer: TEST_MEMFIRE_ISSUER,
    cloudRegion: "cn",
    modelGatewayUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
    realtimeRelayUrl: "https://realtime.moss.example.cn",
  },
  sendPhoneOtp: unexpected,
  verifyPhoneOtp: unexpected,
  refresh: unexpected,
  getUser: unexpected,
  logout: unexpected,
  ...overrides,
});

const availableAuth = (client: MemFirePhoneAuthClient): MemFirePhoneAuthAvailable => ({
  status: "available",
  available: true,
  config: client.config,
  client,
});

const phoneSession = (
  overrides: Partial<SupabaseMossAuthSession> = {},
): SupabaseMossAuthSession => ({
  accessToken: "moss-access-token",
  refreshToken: "moss-refresh-token",
  tokenType: "bearer",
  expiresInSeconds: 3_600,
  expiresAt: 1_800_003_600_000,
  user: {
    id: "user-1",
    email: null,
    phone: "+8613800138000",
    role: "authenticated",
    audience: "authenticated",
    emailConfirmedAt: null,
    phoneConfirmedAt: "2026-07-14T00:00:00.000Z",
    lastSignInAt: "2026-07-14T00:00:00.000Z",
    createdAt: "2026-07-14T00:00:00.000Z",
    updatedAt: "2026-07-14T00:00:00.000Z",
    appMetadata: { provider: "phone", providers: ["phone"] },
    userMetadata: { display_name: "测试用户" },
  },
  ...overrides,
});

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const service: ServerSecretStoreShape = {
    get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
    set: (name, value) => Effect.sync(() => values.set(name, value.slice())).pipe(Effect.asVoid),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => values.get(name)?.slice() ?? new Uint8Array(bytes)),
    remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  };
  return { values, service };
};

const seedLegacyPhoneSession = (
  values: Map<string, Uint8Array>,
  input: {
    readonly accessToken: string;
    readonly accessTokenExpiresAt: number;
    readonly refreshToken?: string;
  },
) => {
  const createdAt = new Date(1_800_000_000_000).toISOString();
  values.set(
    "moss.phone.session",
    new TextEncoder().encode(
      JSON.stringify({
        version: 2,
        accessToken: input.accessToken,
        refreshToken: input.refreshToken ?? "legacy-refresh-token",
        accessTokenExpiresAt: input.accessTokenExpiresAt,
        session: {
          id: "moss_phone_legacy_fixture",
          user: {
            id: "user-1",
            phoneNumber: "+8613800138000",
            displayName: "测试用户",
            role: "member",
            status: "active",
            createdAt,
            updatedAt: createdAt,
            lastLoginAt: createdAt,
          },
          createdAt,
          expiresAt: new Date(input.accessTokenExpiresAt).toISOString(),
          lastSeenAt: createdAt,
        },
      }),
    ),
  );
};

const makeGate = () => {
  let open!: () => void;
  const promise = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { promise, open };
};

const makePhoneServiceDependencies = (secretStore: ServerSecretStoreShape) => {
  let activeManagedAccessToken: string | null = null;
  const provision: MossManagedProviderShape["provision"] = vi.fn((input) =>
    Effect.sync(() => {
      activeManagedAccessToken = input.accessToken;
    }),
  );
  const disable: MossManagedProviderShape["disable"] = vi.fn(() =>
    Effect.sync(() => {
      activeManagedAccessToken = null;
    }),
  );
  const needsDisable: MossManagedProviderShape["needsDisable"] = vi.fn(() =>
    Effect.sync(() => activeManagedAccessToken !== null),
  );
  const getProvisioningState: MossManagedProviderShape["getProvisioningState"] = vi.fn((input) =>
    Effect.sync(() => (activeManagedAccessToken === input.accessToken ? "ready" : "stale")),
  );
  return {
    provision,
    disable,
    needsDisable,
    getProvisioningState,
    getActiveManagedAccessToken: () => activeManagedAccessToken,
    layer: Layer.merge(
      Layer.succeed(ServerSecretStore, secretStore),
      Layer.succeed(MossManagedProvider, {
        provision,
        disable,
        needsDisable,
        getProvisioningState,
      }),
    ),
  };
};

describe("MossPhoneAccountService", () => {
  it("fences local ownership during an entered remote logout without running cleanup", async () => {
    const now = 1_800_000_000_000;
    const entered = makeGate();
    const release = makeGate();
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        logout: async () => {
          entered.open();
          await release.promise;
          return { accepted: true };
        },
      }),
    );
    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({ ...challenge, code: "123456" });
      const loggingOut = yield* service.logout().pipe(Effect.forkChild);
      try {
        yield* Effect.promise(() => entered.promise);
        const saved = [...secrets.values.entries()].map(([key, bytes]) => [key, bytes.slice()]);
        const reading = yield* service
          .getLocalAuthority()
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(reading.pollUnsafe()).toBeDefined();
        expect((yield* Fiber.join(reading)).identity).toBeNull();
        const restarted = yield* makeMossPhoneAccountService({ auth, now: () => now });
        expect((yield* restarted.getLocalAuthority()).identity).toBeNull();
        expect([...secrets.values.entries()]).toEqual(saved);
        expect(dependencies.disable).not.toHaveBeenCalled();
        expect(loggingOut.pollUnsafe()).toBeUndefined();
        release.open();
        yield* Fiber.join(loggingOut);
        expect((yield* service.getLocalAuthority()).identity).toBeNull();
      } finally {
        release.open();
        yield* Fiber.interrupt(loggingOut);
      }
    }).pipe(Effect.provide(dependencies.layer), Effect.scoped, Effect.runPromise);
  });

  it("reads local ownership independently of an entered network refresh", async () => {
    let now = 1_800_000_000_000;
    const entered = makeGate();
    const release = makeGate();
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession({ expiresAt: now + 1_000 }),
        refresh: async () => {
          entered.open();
          await release.promise;
          throw new SupabaseMossAuthError({
            operation: "refresh",
            code: "session_expired",
            status: 401,
            retryable: false,
            message: "revoked fixture",
          });
        },
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({ ...challenge, code: "123456" });
      now += 2_000;
      const refreshing = yield* service.getSession().pipe(Effect.forkChild);
      try {
        yield* Effect.promise(() => entered.promise);
        // The fixture's durable reads are synchronous. Starting immediately
        // must complete the local snapshot without releasing the network gate.
        const reading = yield* service
          .getLocalAuthority()
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(reading.pollUnsafe()).toBeDefined();
        const local = yield* Fiber.join(reading);
        expect(local.identity?.account).toEqual({ id: "user-1", realm: "memfire-phone" });
        expect(local.activeRealm).toBe("cn");
        expect(refreshing.pollUnsafe()).toBeUndefined();
        const queuedLogout = yield* service
          .logout()
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(queuedLogout.pollUnsafe()).toBeUndefined();
        expect((yield* service.getLocalAuthority()).identity).toBeNull();
        yield* Fiber.interrupt(queuedLogout);
        expect((yield* service.getLocalAuthority()).identity?.account.id).toBe("user-1");
        release.open();
        expect((yield* Fiber.join(refreshing)).authenticated).toBe(false);
        expect((yield* service.getLocalAuthority()).identity).toBeNull();
      } finally {
        release.open();
        yield* Fiber.interrupt(refreshing);
      }
    }).pipe(Effect.provide(dependencies.layer), Effect.scoped, Effect.runPromise);
  });

  it("recovers one pre-dispatch region verification failure without replaying the OTP request", async () => {
    let attempts = 0;
    const sendPhoneOtp = vi.fn(async () => {
      attempts += 1;
      if (attempts === 1) {
        throw new SupabaseMossAuthError({
          operation: "send_phone_otp",
          code: "cloud_region_unavailable",
          status: null,
          retryable: true,
          message: "pre-dispatch cold-start region verifier failed; OTP was not sent",
        });
      }
      return { accepted: true as const };
    });
    const auth = availableAuth(makeClient({ sendPhoneOtp }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => 1_800_000_000_000 });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });

      expect(challenge.delivery).toBe("sent");
      expect(sendPhoneOtp).toHaveBeenCalledTimes(2);
      expect(dependencies.provision).not.toHaveBeenCalled();
    }).pipe(Effect.provide(dependencies.layer));
  });

  it("uses Moss MemFire OTP, stores realm-bound tokens only in the secret store, and restores the session", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () => phoneSession());
    const getUser = vi.fn(async () => phoneSession().user);
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp, getUser }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* first.startPhoneLogin({ phoneNumber: "138 0013 8000" });
      const signedIn = yield* first.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });

      expect(sendPhoneOtp).toHaveBeenCalledWith("+8613800138000");
      expect(verifyPhoneOtp).toHaveBeenCalledWith("+8613800138000", "123456");
      expect(signedIn).toMatchObject({
        configured: true,
        authenticated: true,
        session: { user: { id: "user-1", phoneNumber: "+8613800138000" } },
      });
      expect(JSON.stringify(signedIn)).not.toContain("moss-access-token");
      expect(JSON.stringify(signedIn)).not.toContain("moss-refresh-token");
      expect(dependencies.disable).not.toHaveBeenCalled();
      expect(
        [...secrets.values.values()].map((value) => new TextDecoder().decode(value)).join(""),
      ).toContain("moss-refresh-token");
      const persistedPhoneSession = new TextDecoder().decode(
        secrets.values.get("moss.phone.session") ?? new Uint8Array(),
      );
      expect(persistedPhoneSession).toContain('"version":3');
      expect(persistedPhoneSession).toContain('"realm":"memfire-phone"');
      expect(persistedPhoneSession).toContain('"issuer":"https://moss.example.cn/auth/v1"');

      const restoredService = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      const restored = yield* restoredService.getSession();
      const restoredAgain = yield* restoredService.getSession();
      expect(restored.authenticated).toBe(true);
      expect(restoredAgain.authenticated).toBe(true);
      expect(getUser).toHaveBeenCalledTimes(2);
      expect(getUser).toHaveBeenCalledWith("moss-access-token");
      expect(dependencies.provision).toHaveBeenNthCalledWith(1, {
        authority: "memfire-phone",
        accessToken: "moss-access-token",
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        models: expectedManagedProvisionModels,
        selectionPolicy: "select",
      });
      expect(dependencies.provision).toHaveBeenCalledTimes(1);

      const authority = yield* restoredService.getAuthorityCredential();
      expect(authority).toEqual({
        realm: "memfire-phone",
        issuer: "https://moss.example.cn/auth/v1",
        accessToken: "moss-access-token",
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        realtimeRelayUrl: "https://realtime.moss.example.cn",
      });

      // A durable binding receipt must not mask an interrupted settings fence.
      // The next account reconciliation restores both managed launch surfaces.
      vi.mocked(dependencies.getProvisioningState).mockReturnValueOnce(Effect.succeed("stale"));
      const healed = yield* restoredService.getSession();
      expect(healed.authenticated).toBe(true);
      expect(dependencies.provision).toHaveBeenNthCalledWith(2, {
        authority: "memfire-phone",
        accessToken: "moss-access-token",
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        models: expectedManagedProvisionModels,
        selectionPolicy: "preserve",
      });
      expect(dependencies.provision).toHaveBeenCalledTimes(2);

      const coordinator = makeMossManagedProviderCoordinator(secrets.service, {
        provision: dependencies.provision,
        disable: dependencies.disable,
        needsDisable: dependencies.needsDisable,
        getProvisioningState: dependencies.getProvisioningState,
      });
      yield* coordinator.provision({
        authority: "supabase-google",
        accessToken: "cloud-owner-token",
        gatewayBaseUrl: "https://global-gateway.example.test",
        selectionPolicy: "select",
      });
      vi.mocked(dependencies.provision).mockClear();
      vi.mocked(dependencies.getProvisioningState).mockClear();

      const deferredPhoneState = yield* restoredService.getSession();
      expect(deferredPhoneState.authenticated).toBe(true);
      expect(dependencies.provision).not.toHaveBeenCalled();
      expect(dependencies.getProvisioningState).not.toHaveBeenCalled();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("restores a session when MemFire returns the phone claim without the plus sign", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true as const }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => ({ ...phoneSession().user, phone: "8613800138000" }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });

      const restored = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restored.getSession()).authenticated).toBe(true);
      expect(secrets.values.has("moss.phone.session")).toBe(true);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("validates a persisted phone session without waiting for a rate-limited CN catalog", async () => {
    const now = 1_800_000_000_000;
    const gatewayResponse = {
      status: "ready",
      models: expectedManagedProvisionModels,
    } as const;
    const gatewayGate = makeGate();
    let blockGateway = false;
    const fetchGatewayModels = vi.fn(() =>
      blockGateway
        ? Effect.promise(() => gatewayGate.promise.then(() => gatewayResponse))
        : Effect.succeed(gatewayResponse),
    );
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => phoneSession().user,
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    const result = await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({
        auth,
        now: () => now,
        fetchGatewayModels,
      });
      const challenge = yield* first.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* first.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });

      blockGateway = true;
      const restored = yield* makeMossPhoneAccountService({
        auth,
        now: () => now + 1_000,
        fetchGatewayModels,
      });
      return yield* restored.restoreSession!().pipe(Effect.timeoutOption(25));
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(Option.isSome(result)).toBe(true);
    expect(fetchGatewayModels).toHaveBeenCalledTimes(1);
    expect(dependencies.provision).toHaveBeenCalledTimes(1);
    gatewayGate.open();
  });

  it("does not admit startup when MemFire cannot validate the persisted bearer", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => phoneSession().user,
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const offline = availableAuth(
      makeClient({
        getUser: async () => {
          throw new Error("temporary MemFire transport failure");
        },
      }),
    );
    const error = await Effect.gen(function* () {
      const restored = yield* makeMossPhoneAccountService({
        auth: offline,
        now: () => now + 1_000,
      });
      return yield* restored.restoreSession!().pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error.code).toBe("authentication_service_unavailable");
    expect(dependencies.provision).toHaveBeenCalledOnce();
  });

  it("upgrades a legacy unscoped session only after MemFire validates its bearer", async () => {
    const now = 1_800_000_000_000;
    const legacyAccessToken = syntheticAccessJwt({ iss: TEST_MEMFIRE_ISSUER, sub: "user-1" });
    const getUser = vi.fn(async () => phoneSession().user);
    const refresh = vi.fn(unexpected);
    const auth = availableAuth(makeClient({ refresh, getUser }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    seedLegacyPhoneSession(secrets.values, {
      accessToken: legacyAccessToken,
      accessTokenExpiresAt: now + 3_600_000,
    });

    await Effect.gen(function* () {
      const restored = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const state = yield* restored.getSession();
      expect(state.authenticated).toBe(true);
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).toHaveBeenCalledOnce();
      expect(getUser).toHaveBeenCalledWith(legacyAccessToken);
      const upgraded = new TextDecoder().decode(
        secrets.values.get("moss.phone.session") ?? new Uint8Array(),
      );
      expect(upgraded).toContain('"version":3');
      expect(upgraded).toContain('"realm":"memfire-phone"');
      expect(upgraded).toContain('"issuer":"https://moss.example.cn/auth/v1"');
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it.each([
    {
      label: "mismatched issuer",
      accessToken: syntheticAccessJwt({
        iss: "https://another-project.example.cn/auth/v1",
        sub: "user-1",
      }),
      expiresAtOffset: -1,
    },
    {
      label: "missing issuer",
      accessToken: syntheticAccessJwt({ sub: "user-1" }),
      expiresAtOffset: 3_600_000,
    },
    {
      label: "malformed JWT",
      accessToken: "not-a-jwt",
      expiresAtOffset: -1,
    },
  ])(
    "clears a legacy session with $label before any auth client call",
    async ({ accessToken, expiresAtOffset }) => {
      const now = 1_800_000_000_000;
      const refresh = vi.fn(unexpected);
      const getUser = vi.fn(unexpected);
      const logout = vi.fn(unexpected);
      const auth = availableAuth(makeClient({ refresh, getUser, logout }));
      const secrets = makeSecretStore();
      const dependencies = makePhoneServiceDependencies(secrets.service);
      seedLegacyPhoneSession(secrets.values, {
        accessToken,
        accessTokenExpiresAt: now + expiresAtOffset,
      });

      const error = await Effect.gen(function* () {
        const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
        return yield* service.getAccessToken().pipe(Effect.flip);
      }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

      expect(error).toMatchObject({ code: "authentication_required" });
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(secrets.values.has("moss.phone.session")).toBe(false);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
      expect(dependencies.disable).not.toHaveBeenCalled();
    },
  );

  it.each([
    ["missing issuer", syntheticAccessJwt({ sub: "user-1" })],
    ["malformed JWT", "not-a-jwt"],
  ])(
    "clears a legacy session with %s while Auth is unavailable without fetching",
    async (_label, accessToken) => {
      const now = 1_800_000_000_000;
      const fetchImpl = vi.fn(unexpected) as unknown as typeof fetch;
      const auth = createMemFirePhoneAuth({ env: {}, fetchImpl });
      const secrets = makeSecretStore();
      const dependencies = makePhoneServiceDependencies(secrets.service);
      seedLegacyPhoneSession(secrets.values, {
        accessToken,
        accessTokenExpiresAt: now + 3_600_000,
      });

      const error = await Effect.gen(function* () {
        const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
        return yield* service.getAccessToken().pipe(Effect.flip);
      }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

      expect(error).toMatchObject({ code: "authentication_required" });
      expect(fetchImpl).not.toHaveBeenCalled();
      expect(secrets.values.has("moss.phone.session")).toBe(false);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
      expect(dependencies.disable).not.toHaveBeenCalled();
    },
  );

  it("remotely revokes a legacy session only when its unverified issuer pins the current route", async () => {
    const now = 1_800_000_000_000;
    const accessToken = syntheticAccessJwt({ iss: TEST_MEMFIRE_ISSUER, sub: "user-1" });
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const auth = availableAuth(makeClient({ logout }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    seedLegacyPhoneSession(secrets.values, {
      accessToken,
      accessTokenExpiresAt: now + 3_600_000,
    });

    const result = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      return yield* service.logout();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(result).toEqual({ revokedCount: 1 });
    expect(logout).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledWith(accessToken);
    expect(secrets.values.has("moss.phone.session")).toBe(false);
  });

  it("fences a persisted pending managed receipt before completing phone logout", async () => {
    const now = 1_800_000_000_000;
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession({ accessToken: "pending-phone-access" }),
        logout,
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
      const receiptBytes = secrets.values.get("moss.managed.binding");
      expect(receiptBytes).toBeDefined();
      const receipt = JSON.parse(
        new TextDecoder().decode(receiptBytes ?? new Uint8Array()),
      ) as Record<string, unknown>;
      secrets.values.set(
        "moss.managed.binding",
        new TextEncoder().encode(JSON.stringify({ ...receipt, state: "pending" })),
      );
      vi.mocked(dependencies.disable).mockClear();

      const result = yield* service.logout();

      expect(result).toEqual({ revokedCount: 1 });
      expect(dependencies.disable).toHaveBeenCalledOnce();
      expect(vi.mocked(dependencies.disable).mock.calls[0]).toEqual([
        { cleanupFallbackAccessToken: "pending-phone-access" },
      ]);
      expect(secrets.values.has("moss.managed.binding")).toBe(false);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
      expect(dependencies.getActiveManagedAccessToken()).toBeNull();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it.each([
    ["mismatched issuer", syntheticAccessJwt({ iss: "https://other.example.cn/auth/v1" })],
    ["missing issuer", syntheticAccessJwt({ sub: "user-1" })],
    ["malformed JWT", "not-a-jwt"],
  ])(
    "logs out a legacy session with %s locally with zero auth calls",
    async (_label, accessToken) => {
      const now = 1_800_000_000_000;
      const logout = vi.fn(unexpected);
      const auth = availableAuth(makeClient({ logout }));
      const secrets = makeSecretStore();
      const dependencies = makePhoneServiceDependencies(secrets.service);
      seedLegacyPhoneSession(secrets.values, {
        accessToken,
        accessTokenExpiresAt: now + 3_600_000,
      });

      const result = await Effect.gen(function* () {
        const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
        return yield* service.logout();
      }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

      expect(result).toEqual({ revokedCount: 1 });
      expect(logout).not.toHaveBeenCalled();
      expect(secrets.values.has("moss.phone.session")).toBe(false);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
    },
  );

  it("restores a persisted phone challenge after service reconstruction and consumes it on success", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () =>
      phoneSession({ accessToken: "challenge-restored-access" }),
    );
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* first.startPhoneLogin({ phoneNumber: "13800138000" });
      expect(secrets.values.has("moss.phone.challenges")).toBe(true);
      expect(
        new TextDecoder().decode(secrets.values.get("moss.phone.challenges") ?? new Uint8Array()),
      ).not.toContain("123456");

      const reconstructed = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      const signedIn = yield* reconstructed.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });

      expect(signedIn.authenticated).toBe(true);
      expect(verifyPhoneOtp).toHaveBeenCalledWith("+8613800138000", "123456");
      expect(
        new TextDecoder().decode(secrets.values.get("moss.phone.challenges") ?? new Uint8Array()),
      ).toBe("");
      expect(secrets.values.has("moss.phone.challenges")).toBe(false);

      const consumedError = yield* reconstructed
        .verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);
      expect(consumedError.code).toBe("challenge_not_found");
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("fails closed and clears an expired persisted phone challenge after service reconstruction", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () => phoneSession());
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* first.startPhoneLogin({ phoneNumber: "13800138000" });

      const reconstructed = yield* makeMossPhoneAccountService({
        auth,
        now: () => now + 10 * 60_000 + 1,
      });
      const expiredError = yield* reconstructed
        .verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);

      expect(expiredError.code).toBe("challenge_not_found");
      expect(verifyPhoneOtp).not.toHaveBeenCalled();
      expect(secrets.values.has("moss.phone.challenges")).toBe(false);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("invalidates the earlier challenge when the same phone starts login twice", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () => phoneSession({ accessToken: "double-start-access" }));
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const first = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      const second = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });

      const firstFailure = yield* service
        .verifyPhoneLogin({
          challengeId: first.challengeId,
          phoneNumber: first.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);
      expect(firstFailure.code).toBe("challenge_not_found");

      const signedIn = yield* service.verifyPhoneLogin({
        challengeId: second.challengeId,
        phoneNumber: second.phoneNumber,
        code: "123456",
      });
      expect(signedIn.authenticated).toBe(true);
      expect(verifyPhoneOtp).toHaveBeenCalledTimes(1);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("returns no usable challenge when OTP delivery succeeds but challenge persistence fails", async () => {
    const now = 1_800_000_000_000;
    const phoneNumber = "13800138000";
    const verificationCode = "123456";
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () => phoneSession());
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp }));
    const secrets = makeSecretStore();
    let challengeToRetire = "";
    let failReplacementPersist = false;
    const controlledSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      set: (name, value) => {
        const encoded = new TextDecoder().decode(value);
        if (
          name === "moss.phone.challenges" &&
          failReplacementPersist &&
          !encoded.includes(challengeToRetire)
        ) {
          failReplacementPersist = false;
          return Effect.fail(
            new SecretStoreError({
              message: `fixture must stay private: ${phoneNumber} ${verificationCode} ${challengeToRetire}`,
            }),
          );
        }
        return secrets.service.set(name, value);
      },
    };
    const dependencies = makePhoneServiceDependencies(controlledSecretStore);

    const service = await makeMossPhoneAccountService({ auth, now: () => now }).pipe(
      Effect.provide(dependencies.layer),
      Effect.runPromise,
    );
    const earlier = await service.startPhoneLogin({ phoneNumber }).pipe(Effect.runPromise);
    challengeToRetire = earlier.challengeId;
    failReplacementPersist = true;

    const persistenceFailure = await service
      .startPhoneLogin({ phoneNumber })
      .pipe(Effect.flip, Effect.runPromise);

    expect(sendPhoneOtp).toHaveBeenCalledTimes(2);
    expect(persistenceFailure).toMatchObject({ code: "persistence_failed" });
    expect(persistenceFailure.cause).toBeUndefined();
    const serializedFailure = JSON.stringify(persistenceFailure);
    expect(serializedFailure).not.toContain(phoneNumber);
    expect(serializedFailure).not.toContain(verificationCode);
    expect(serializedFailure).not.toContain(challengeToRetire);
    expect(secrets.values.has("moss.phone.challenges")).toBe(false);

    const retiredFailure = await service
      .verifyPhoneLogin({
        challengeId: earlier.challengeId,
        phoneNumber: earlier.phoneNumber,
        code: verificationCode,
      })
      .pipe(Effect.flip, Effect.runPromise);
    expect(retiredFailure.code).toBe("challenge_not_found");
    expect(verifyPhoneOtp).not.toHaveBeenCalled();
  });

  it.each(["generation persistence", "challenge clearing"] as const)(
    "keeps logout fail-closed across restart when %s fails",
    async (failurePoint) => {
      const now = 1_800_000_000_000;
      const phoneNumber = "13800138000";
      const verificationCode = "123456";
      const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
      const verifyPhoneOtp = vi.fn(async () => phoneSession());
      const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp }));
      const secrets = makeSecretStore();
      let injectFailure = false;
      let privateChallengeId = "";
      const failure = () =>
        new SecretStoreError({
          message: `fixture must stay private: ${phoneNumber} ${verificationCode} ${privateChallengeId}`,
        });
      const controlledSecretStore: ServerSecretStoreShape = {
        ...secrets.service,
        set: (name, value) => {
          if (
            injectFailure &&
            failurePoint === "generation persistence" &&
            name === "moss.phone.challenge_generation"
          ) {
            injectFailure = false;
            return Effect.fail(failure());
          }
          return secrets.service.set(name, value);
        },
        remove: (name) => {
          if (
            injectFailure &&
            failurePoint === "challenge clearing" &&
            name === "moss.phone.challenges"
          ) {
            injectFailure = false;
            return Effect.fail(failure());
          }
          return secrets.service.remove(name);
        },
      };
      const dependencies = makePhoneServiceDependencies(controlledSecretStore);
      const first = await makeMossPhoneAccountService({ auth, now: () => now }).pipe(
        Effect.provide(dependencies.layer),
        Effect.runPromise,
      );
      const preLogout = await first.startPhoneLogin({ phoneNumber }).pipe(Effect.runPromise);
      privateChallengeId = preLogout.challengeId;
      injectFailure = true;

      const logoutFailure = await first.logout().pipe(Effect.flip, Effect.runPromise);

      expect(logoutFailure).toMatchObject({ code: "persistence_failed" });
      expect(logoutFailure.cause).toBeUndefined();
      const serializedFailure = JSON.stringify(logoutFailure);
      expect(serializedFailure).not.toContain(phoneNumber);
      expect(serializedFailure).not.toContain(verificationCode);
      expect(serializedFailure).not.toContain(privateChallengeId);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(true);
      expect(verifyPhoneOtp).not.toHaveBeenCalled();

      const restarted = await makeMossPhoneAccountService({ auth, now: () => now + 1_000 }).pipe(
        Effect.provide(dependencies.layer),
        Effect.runPromise,
      );
      const staleFailure = await restarted
        .verifyPhoneLogin({
          challengeId: preLogout.challengeId,
          phoneNumber: preLogout.phoneNumber,
          code: verificationCode,
        })
        .pipe(Effect.flip, Effect.runPromise);

      expect(staleFailure.code).toBe("challenge_not_found");
      expect(verifyPhoneOtp).not.toHaveBeenCalled();
      expect(secrets.values.has("moss.phone.challenges")).toBe(false);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
    },
  );

  it("rejects a pre-logout challenge after logout and allows a new post-logout challenge", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    let verificationCount = 0;
    const verifyPhoneOtp = vi.fn(async () => {
      verificationCount += 1;
      return phoneSession({ accessToken: `logout-boundary-access-${verificationCount}` });
    });
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp, logout }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const initial = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: initial.challengeId,
        phoneNumber: initial.phoneNumber,
        code: "123456",
      });

      const preLogout = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.logout();
      const preLogoutFailure = yield* service
        .verifyPhoneLogin({
          challengeId: preLogout.challengeId,
          phoneNumber: preLogout.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);
      expect(preLogoutFailure.code).toBe("challenge_not_found");

      const postLogout = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      const restored = yield* service.verifyPhoneLogin({
        challengeId: postLogout.challengeId,
        phoneNumber: postLogout.phoneNumber,
        code: "123456",
      });
      expect(restored.authenticated).toBe(true);
      expect(verifyPhoneOtp).toHaveBeenCalledTimes(2);
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
      expect(secrets.values.has("moss.phone.challenges")).toBe(false);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("rejects non-mainland numbers before calling Moss Auth", async () => {
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient({ sendPhoneOtp })),
      });
      return yield* service.startPhoneLogin({ phoneNumber: "+12025550123" }).pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error.code).toBe("invalid_phone_number");
    expect(sendPhoneOtp).not.toHaveBeenCalled();
  });

  it("rejects malformed verification codes before calling Moss Auth", async () => {
    const verifyPhoneOtp = vi.fn(async () => {
      throw new Error("must not be called");
    });
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(
          makeClient({
            sendPhoneOtp: async () => ({ accepted: true }),
            verifyPhoneOtp,
          }),
        ),
      });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      return yield* service
        .verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "12345",
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error.code).toBe("invalid_verification_code");
    expect(verifyPhoneOtp).not.toHaveBeenCalled();
  });

  it("maps an invalid auth response to a safe localized phone-login error", async () => {
    const verifyPhoneOtp = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "verify_phone_otp",
        code: "invalid_response",
        status: null,
        retryable: false,
        message: "The authentication service returned an invalid response.",
      });
    });
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(
          makeClient({
            sendPhoneOtp: async () => ({ accepted: true }),
            verifyPhoneOtp,
          }),
        ),
      });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      return yield* service
        .verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error).toMatchObject({
      code: "invalid_authentication_response",
      message: "手机号登录响应异常，请重新获取验证码后再试。",
    });
    expect(error.message).not.toContain("authentication service");
  });

  it("removes a server-rejected session and never reports it as authenticated", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const firstAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession({ accessToken: "revoked-token" }),
      }),
    );

    await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({ auth: firstAuth, now: () => now });
      const challenge = yield* first.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* first.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const rejectedFetch = vi.fn(async (input: Parameters<typeof fetch>[0]) =>
      String(input).endsWith("/rest/v1/rpc/moss_get_public_cloud_region")
        ? new Response(JSON.stringify("cn"), { status: 200 })
        : new Response(JSON.stringify({ code: "AUTH_REQUIRED" }), { status: 401 }),
    ) as unknown as typeof fetch;
    const rejected = await Effect.gen(function* () {
      const auth = createMemFirePhoneAuth({
        env: {
          MOSS_MEMFIRE_PHONE_URL: "https://moss-ref.baseapi.memfiredb.com",
          MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "publishable-test-value",
          MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
            "https://model-gateway.moss.example.cn/functions/v1/moss-model-gateway/v1",
          MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: "https://realtime.moss.example.cn",
        },
        fetchImpl: rejectedFetch,
      });
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(rejected.authenticated).toBe(false);
    expect(secrets.values.size).toBe(0);
    expect(dependencies.disable).toHaveBeenCalledOnce();
  });

  it("provisions the complete managed OpenRouter lineup even when the gateway catalog is stale", async () => {
    const now = 1_800_000_000_000;
    const sendPhoneOtp = vi.fn(async () => ({ accepted: true as const }));
    const verifyPhoneOtp = vi.fn(async () => phoneSession());
    const getUser = vi.fn(async () => phoneSession().user);
    const auth = availableAuth(makeClient({ sendPhoneOtp, verifyPhoneOtp, getUser }));
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const fetchGatewayModels = vi.fn(() =>
      Effect.succeed([
        "deepseek-v4-flash",
        "glm-5.3",
        "not-in-realm-model",
      ] as ReadonlyArray<string>),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth,
        now: () => now,
        fetchGatewayModels,
      });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "138 0013 8000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(fetchGatewayModels).toHaveBeenCalledWith({
      gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
      accessToken: "moss-access-token",
    });
    // The gateway response is only a readiness signal. Basic accounts retain
    // the full model catalog and are limited by quota/credit admission.
    expect(dependencies.provision).toHaveBeenLastCalledWith(
      expect.objectContaining({
        authority: "memfire-phone",
        models: expectedManagedProvisionModels,
      }),
    );
  });

  it("keeps the phone session when the gateway denies catalog access without provisioning a fallback", async () => {
    const now = 1_800_000_000_000;
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => phoneSession().user,
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const fetchGatewayModels = vi.fn(() =>
      Effect.succeed({ status: "auth-denied", models: [] } as const),
    );

    const state = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth,
        now: () => now,
        fetchGatewayModels,
      });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      return yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(state).toMatchObject({
      authenticated: true,
      modelGatewayStatus: "auth-denied",
      session: { user: { id: "user-1" } },
    });
    expect(dependencies.provision).not.toHaveBeenCalled();
    expect(secrets.values.has("moss.phone.session")).toBe(true);
  });

  it("exposes and explicitly re-selects the persisted CN active realm", async () => {
    const now = 1_800_000_000_000;
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => phoneSession().user,
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const state = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      const signedIn = yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
      expect(signedIn.activeRealm).toBe("cn");
      const selected = yield* service.activateRealm({ realm: "cn" });
      expect(selected.activeRealm).toBe("cn");
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(state.activeRealm).toBe("cn");
    const restored = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      expect((yield* service.getLocalAuthority()).activeRealm).toBe("cn");
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
    expect(restored.activeRealm).toBe("cn");
    await expect(
      Effect.gen(function* () {
        const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
        return yield* service.activateRealm({ realm: "global" });
      }).pipe(Effect.provide(dependencies.layer), Effect.runPromise),
    ).rejects.toMatchObject({ code: "persistence_failed" });
  });

  it("fails closed when selecting the CN realm while auth configuration is unavailable", async () => {
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const service = await makeMossPhoneAccountService({
      auth: {
        status: "unavailable",
        available: false,
        reason: "missing_configuration",
        message: "fixture unavailable",
        missing: ["MOSS_MEMFIRE_PHONE_URL"],
        invalid: [],
      },
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    await expect(
      service.activateRealm({ realm: "cn" }).pipe(Effect.runPromise),
    ).rejects.toMatchObject({
      code: "authentication_service_unavailable",
    });
    expect(dependencies.provision).not.toHaveBeenCalled();
  });

  it("clears phone gateway readiness on logout", async () => {
    const now = 1_800_000_000_000;
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        getUser: async () => phoneSession().user,
        logout: async () => ({ accepted: true }),
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const service = await Effect.gen(function* () {
      return yield* makeMossPhoneAccountService({ auth, now: () => now });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
    const state = await Effect.gen(function* () {
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      const signedIn = yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
      expect(signedIn.modelGatewayStatus).toBe("ready");
      expect((yield* service.getLocalAuthority()).identity?.account).toEqual({
        id: "user-1",
        realm: "memfire-phone",
      });
      yield* service.logout();
      expect((yield* service.getLocalAuthority()).identity).toBeNull();
      const restarted = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restarted.getLocalAuthority()).identity).toBeNull();
      const credentialFailure = yield* restarted.getAuthorityCredential().pipe(Effect.flip);
      expect(credentialFailure).toMatchObject({ code: "authentication_required" });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
    expect(state.authenticated).toBe(false);
    expect(state).not.toHaveProperty("modelGatewayStatus");
  });

  it("rotates an expired access token with the Moss refresh token", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "expired-access", expiresAt: now + 1_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const refresh = vi.fn(async () =>
      phoneSession({
        accessToken: "rotated-access",
        refreshToken: "rotated-refresh",
        expiresAt: now + 3_600_000,
      }),
    );
    const getUser = vi.fn(async () => phoneSession().user);
    const accessToken = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient({ refresh, getUser })),
        now: () => now + 2_000,
      });
      return yield* service.getAccessToken();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(accessToken).toBe("rotated-access");
    expect(refresh).toHaveBeenCalledWith("moss-refresh-token");
    expect(getUser).toHaveBeenCalledWith("rotated-access");
    expect(
      [...secrets.values.values()].map((value) => new TextDecoder().decode(value)).join(""),
    ).toContain("rotated-refresh");
    expect(dependencies.provision).toHaveBeenLastCalledWith({
      authority: "memfire-phone",
      accessToken: "rotated-access",
      gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
      models: expectedManagedProvisionModels,
      selectionPolicy: "preserve",
    });
    expect(dependencies.disable).toHaveBeenCalledOnce();
    expect(dependencies.getActiveManagedAccessToken()).toBe("rotated-access");
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
  });

  it("refreshes a legacy locally-expired session instead of requiring another OTP", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const legacyAccessToken = syntheticAccessJwt({ iss: TEST_MEMFIRE_ISSUER, sub: "user-1" });
    seedLegacyPhoneSession(secrets.values, {
      accessToken: legacyAccessToken,
      accessTokenExpiresAt: now - 1,
      refreshToken: "moss-refresh-token",
    });

    const refresh = vi.fn(async () =>
      phoneSession({
        accessToken: "restored-access",
        refreshToken: "restored-refresh",
        expiresAt: now + 3_600_000,
      }),
    );
    const getUser = vi.fn(async () => phoneSession().user);
    const state = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient({ refresh, getUser })),
        now: () => now,
      });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(state).toMatchObject({ authenticated: true, session: { user: { id: "user-1" } } });
    expect(refresh).toHaveBeenCalledWith("moss-refresh-token");
    expect(getUser).toHaveBeenCalledWith("restored-access");
    expect(secrets.values.has("moss.phone.session")).toBe(true);
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
    expect(
      JSON.parse(new TextDecoder().decode(secrets.values.get("moss.phone.session"))).version,
    ).toBe(3);
  });

  it("keeps a legacy locally-expired session durable during a transient refresh failure", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "legacy-offline-access", expiresAt: now + 1_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const refresh = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "refresh",
        code: "network_unavailable",
        status: null,
        retryable: true,
        message: "private network detail",
      });
    });
    const state = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient({ refresh })),
        now: () => now + 31 * 24 * 60 * 60_000,
      });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(state).toMatchObject({ authenticated: true, session: { user: { id: "user-1" } } });
    expect(refresh).toHaveBeenCalledOnce();
    expect(secrets.values.has("moss.phone.session")).toBe(true);
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
  });

  it("preserves the previous durable session when refreshed-session persistence fails", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    let rejectRefreshedSession = false;
    const controlledSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      set: (name, value) => {
        if (
          rejectRefreshedSession &&
          name === "moss.phone.session" &&
          new TextDecoder().decode(value).includes("replacement-access")
        ) {
          rejectRefreshedSession = false;
          return Effect.fail(new SecretStoreError({ message: "private keychain detail" }));
        }
        return secrets.service.set(name, value);
      },
    };
    const dependencies = makePhoneServiceDependencies(controlledSecretStore);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "previous-access", expiresAt: now + 1_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    rejectRefreshedSession = true;
    const persistenceFailure = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(
          makeClient({
            refresh: async () =>
              phoneSession({
                accessToken: "replacement-access",
                refreshToken: "replacement-refresh",
                expiresAt: now + 3_600_000,
              }),
          }),
        ),
        now: () => now + 2_000,
      });
      return yield* service.getSession().pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(persistenceFailure).toMatchObject({ code: "persistence_failed" });
    expect(persistenceFailure).not.toHaveProperty("cause");
    expect(secrets.values.has("moss.phone.session")).toBe(true);
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
    expect(new TextDecoder().decode(secrets.values.get("moss.phone.session"))).toContain(
      "previous-access",
    );
    expect(dependencies.getActiveManagedAccessToken()).toBeNull();

    const recovered = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(
          makeClient({
            refresh: async (refreshToken) => {
              expect(refreshToken).toBe("moss-refresh-token");
              return phoneSession({
                accessToken: "recovered-access",
                refreshToken: "recovered-refresh",
                expiresAt: now + 3_600_000,
              });
            },
            getUser: async () => phoneSession().user,
          }),
        ),
        now: () => now + 3_000,
      });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(recovered.authenticated).toBe(true);
  });

  it("clears a refresh-rejected session before failing the server-only token request", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "expired-access", expiresAt: now + 1_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const refresh = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "refresh",
        code: "session_expired",
        status: 401,
        retryable: false,
        message: "expired fixture",
      });
    });
    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient({ refresh })),
        now: () => now + 2_000,
      });
      return yield* service.getAccessToken().pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error.code).toBe("session_expired");
    expect(refresh).toHaveBeenCalledWith("moss-refresh-token");
    expect(secrets.values.size).toBe(0);
    expect(dependencies.disable).toHaveBeenCalledOnce();
    expect(dependencies.getActiveManagedAccessToken()).toBeNull();
  });

  it("reads verified local phone ownership offline without returning an expired bearer", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "expired-access", expiresAt: now + 1_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const refresh = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "refresh",
        code: "network_unavailable",
        status: null,
        retryable: true,
        message: "offline fixture",
      });
    });
    const getUser = vi.fn(unexpected);
    const fetchGatewayModels = vi.fn(() =>
      Effect.succeed({ status: "ready", models: [...expectedManagedProvisionModels] } as const),
    );
    const service = await makeMossPhoneAccountService({
      auth: availableAuth(makeClient({ refresh, getUser })),
      now: () => now + 2_000,
      fetchGatewayModels,
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const storedBeforeLocalRead = secrets.values.get("moss.phone.session")?.slice();
    const local = await service.getLocalAuthority().pipe(Effect.runPromise);
    expect(local.identity).toEqual({
      realm: "memfire-phone",
      gatewayBaseUrl: initialAuth.config.modelGatewayUrl,
      account: { id: "user-1", realm: "memfire-phone" },
      displayName: "测试用户",
      phoneNumber: "+8613800138000",
    });
    expect(JSON.stringify(local)).not.toContain("expired-access");
    expect(JSON.stringify(local)).not.toContain("moss-refresh-token");
    expect(secrets.values.get("moss.phone.session")).toEqual(storedBeforeLocalRead);
    expect(refresh).not.toHaveBeenCalled();
    expect(getUser).not.toHaveBeenCalled();
    expect(fetchGatewayModels).not.toHaveBeenCalled();
    expect(dependencies.provision).toHaveBeenCalledTimes(1);

    const state = await service.getSession().pipe(Effect.runPromise);
    const error = await service.getAccessToken().pipe(Effect.flip, Effect.runPromise);
    const authorityError = await service
      .getAuthorityCredential()
      .pipe(Effect.flip, Effect.runPromise);

    expect(state).toMatchObject({ authenticated: true, session: { user: { id: "user-1" } } });
    expect(error).toMatchObject({ code: "authentication_service_unavailable" });
    expect(authorityError).toMatchObject({ code: "authentication_service_unavailable" });
    expect((await service.getLocalAuthority().pipe(Effect.runPromise)).identity).toEqual(
      local.identity,
    );
    expect(refresh).toHaveBeenCalledTimes(3);
    expect(getUser).not.toHaveBeenCalled();
    expect(fetchGatewayModels).not.toHaveBeenCalled();
    expect(secrets.values.has("moss.phone.session")).toBe(true);
    expect(dependencies.provision).toHaveBeenCalledTimes(1);
    expect(dependencies.disable).toHaveBeenCalledOnce();
    expect(dependencies.getActiveManagedAccessToken()).toBeNull();
  });

  it.each([
    {
      label: "a different configured issuer",
      version: 3,
      realm: "memfire-phone",
      otherIssuer: true,
    },
    { label: "a different stored realm", version: 3, realm: "supabase-google", otherIssuer: false },
    {
      label: "an unverified legacy session",
      version: 2,
      realm: "memfire-phone",
      otherIssuer: false,
    },
  ])("never exposes local phone ownership from $label", async ({ version, realm, otherIssuer }) => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    seedLegacyPhoneSession(secrets.values, {
      accessToken: syntheticAccessJwt({ iss: TEST_MEMFIRE_ISSUER, sub: "user-1" }),
      accessTokenExpiresAt: now - 1_000,
    });
    const stored = JSON.parse(
      new TextDecoder().decode(secrets.values.get("moss.phone.session")),
    ) as Record<string, unknown>;
    secrets.values.set(
      "moss.phone.session",
      new TextEncoder().encode(
        JSON.stringify({ ...stored, version, realm, issuer: TEST_MEMFIRE_ISSUER }),
      ),
    );
    const refresh = vi.fn(unexpected);
    const getUser = vi.fn(unexpected);
    const logout = vi.fn(unexpected);
    const client = makeClient({ refresh, getUser, logout });
    const auth = availableAuth(
      otherIssuer
        ? makeClient({
            ...client,
            config: { ...client.config, issuer: "https://other.example.cn/auth/v1" },
          })
        : client,
    );
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      expect((yield* service.getLocalAuthority()).identity).toBeNull();
      const restarted = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restarted.getLocalAuthority()).identity).toBeNull();
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(logout).not.toHaveBeenCalled();
      expect(dependencies.provision).not.toHaveBeenCalled();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it("reads durable phone realm selection after a cross-realm switch and reconstruction", async () => {
    const now = 1_800_000_000_000;
    const refresh = vi.fn(unexpected);
    const getUser = vi.fn(unexpected);
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
        refresh,
        getUser,
      }),
    );
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
      expect((yield* service.getLocalAuthority()).activeRealm).toBe("cn");
      const coordinator = makeMossManagedProviderCoordinator(secrets.service, {
        provision: dependencies.provision,
        disable: dependencies.disable,
        needsDisable: dependencies.needsDisable,
        getProvisioningState: dependencies.getProvisioningState,
      });
      yield* coordinator.provision({
        authority: "supabase-google",
        accessToken: "other-realm-access",
        gatewayBaseUrl: "https://global-gateway.example.test",
        selectionPolicy: "select",
      });
      vi.mocked(dependencies.provision).mockClear();
      vi.mocked(dependencies.getProvisioningState).mockClear();

      const local = yield* service.getLocalAuthority();
      expect(local.activeRealm).toBeUndefined();
      expect(local.identity?.account).toEqual({ id: "user-1", realm: "memfire-phone" });
      const restarted = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBeUndefined();
      expect(dependencies.provision).not.toHaveBeenCalled();
      expect(dependencies.getProvisioningState).not.toHaveBeenCalled();

      yield* coordinator.provision({
        authority: "memfire-phone",
        accessToken: "moss-access-token",
        gatewayBaseUrl: auth.config.modelGatewayUrl,
        selectionPolicy: "select",
      });
      vi.mocked(dependencies.provision).mockClear();
      expect((yield* service.getLocalAuthority()).activeRealm).toBe("cn");
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBe("cn");
      secrets.values.delete("moss.managed.binding");
      expect((yield* service.getLocalAuthority()).activeRealm).toBeUndefined();
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBeUndefined();
      expect(dependencies.provision).not.toHaveBeenCalled();
      expect(dependencies.getProvisioningState).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
  });

  it.each(["pending", "corrupt"] as const)(
    "rejects local phone selection with a %s durable binding despite a cached active realm",
    async (state) => {
      const now = 1_800_000_000_000;
      const refresh = vi.fn(unexpected);
      const getUser = vi.fn(unexpected);
      const auth = availableAuth(
        makeClient({
          sendPhoneOtp: async () => ({ accepted: true }),
          verifyPhoneOtp: async () => phoneSession(),
          refresh,
          getUser,
        }),
      );
      const secrets = makeSecretStore();
      const dependencies = makePhoneServiceDependencies(secrets.service);

      await Effect.gen(function* () {
        const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
        const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
        yield* service.verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "123456",
        });
        expect((yield* service.getLocalAuthority()).activeRealm).toBe("cn");
        const original = JSON.parse(
          new TextDecoder().decode(secrets.values.get("moss.managed.binding")),
        ) as Record<string, unknown>;
        const changed = new TextEncoder().encode(
          state === "pending" ? JSON.stringify({ ...original, state: "pending" }) : "{invalid-json",
        );
        secrets.values.set("moss.managed.binding", changed);
        vi.mocked(dependencies.provision).mockClear();
        vi.mocked(dependencies.getProvisioningState).mockClear();

        const failure = yield* service.getLocalAuthority().pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "persistence_failed" });
        const restarted = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
        const restartFailure = yield* restarted.getLocalAuthority().pipe(Effect.flip);
        expect(restartFailure).toMatchObject({ code: "persistence_failed" });
        expect(secrets.values.get("moss.managed.binding")).toEqual(changed);
        expect(dependencies.provision).not.toHaveBeenCalled();
        expect(dependencies.getProvisioningState).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(getUser).not.toHaveBeenCalled();
      }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);
    },
  );

  it("preserves an unexpired access token when an early offline refresh fails", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const initialAuth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () =>
          phoneSession({ accessToken: "still-valid-access", expiresAt: now + 30_000 }),
      }),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth: initialAuth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const refresh = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "refresh",
        code: "network_unavailable",
        status: null,
        retryable: true,
        message: "offline fixture",
      });
    });
    const service = await makeMossPhoneAccountService({
      auth: availableAuth(makeClient({ refresh })),
      now: () => now + 2_000,
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    const state = await service.getSession().pipe(Effect.runPromise);
    const accessToken = await service.getAccessToken().pipe(Effect.runPromise);

    expect(state).toMatchObject({ authenticated: true, session: { user: { id: "user-1" } } });
    expect(accessToken).toBe("still-valid-access");
    expect(refresh).toHaveBeenCalledTimes(2);
    expect(secrets.values.has("moss.phone.session")).toBe(true);
    expect(dependencies.disable).not.toHaveBeenCalled();
    expect(dependencies.getActiveManagedAccessToken()).toBe("still-valid-access");
  });

  it("fails closed after clearing a malformed persisted phone token envelope", async () => {
    const secrets = makeSecretStore();
    secrets.values.set("moss.phone.session", new TextEncoder().encode("{not-json"));
    const dependencies = makePhoneServiceDependencies(secrets.service);

    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({
        auth: availableAuth(makeClient()),
      });
      return yield* service.getAccessToken().pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error.code).toBe("persistence_failed");
    expect(secrets.values.size).toBe(0);
    expect(dependencies.disable).not.toHaveBeenCalled();
  });

  it("rolls back the saved phone session when managed model provisioning fails", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const providerFailure = new MossCloudAccountServiceError({
      code: "provider_error",
      message: "managed provider unavailable",
    });
    vi.mocked(dependencies.provision).mockReturnValueOnce(Effect.fail(providerFailure));
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession(),
      }),
    );

    const error = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      return yield* service
        .verifyPhoneLogin({
          challengeId: challenge.challengeId,
          phoneNumber: challenge.phoneNumber,
          code: "123456",
        })
        .pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(error).toMatchObject({ code: "persistence_failed" });
    expect(secrets.values.size).toBe(0);
    expect(dependencies.disable).not.toHaveBeenCalled();
  });

  it("reports the normal credential-free missing session as signed out without teardown", async () => {
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(makeClient());

    const state = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth });
      return yield* service.getSession();
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(state).toMatchObject({ configured: true, authenticated: false, session: null });
    expect(dependencies.needsDisable).toHaveBeenCalledOnce();
    expect(dependencies.disable).not.toHaveBeenCalled();
    expect(secrets.values.size).toBe(0);
  });

  it("fails closed instead of unscoped teardown when an orphan has no authority receipt", async () => {
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const auth = availableAuth(makeClient());
    await dependencies
      .provision({
        authority: "memfire-phone",
        accessToken: "orphaned-access-token",
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        selectionPolicy: "preserve",
      })
      .pipe(Effect.runPromise);

    const failure = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth });
      return yield* service.getSession().pipe(Effect.flip);
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    expect(failure).toMatchObject({ code: "persistence_failed" });
    expect(dependencies.disable).not.toHaveBeenCalled();
    expect(dependencies.getActiveManagedAccessToken()).toBe("orphaned-access-token");
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(true);
  });

  it("keeps a durable non-secret logout tombstone across a reservation conflict", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const dependencies = makePhoneServiceDependencies(secrets.service);
    const disableFailure = new MossCloudAccountServiceError({
      code: "provider_error",
      message: "A reserved Moss provider conflicts with an existing user-managed account.",
    });
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => phoneSession({ accessToken: "access-before-failed-logout" }),
        logout,
      }),
    );

    const firstService = await Effect.gen(function* () {
      const service = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const challenge = yield* service.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* service.verifyPhoneLogin({
        challengeId: challenge.challengeId,
        phoneNumber: challenge.phoneNumber,
        code: "123456",
      });
      return service;
    }).pipe(Effect.provide(dependencies.layer), Effect.runPromise);

    vi.mocked(dependencies.disable).mockReturnValueOnce(Effect.fail(disableFailure));
    const failure = await firstService.logout().pipe(Effect.flip, Effect.runPromise);

    expect(failure).toMatchObject({
      code: "persistence_failed",
      cause: { message: expect.stringMatching(/reserved Moss provider conflicts/i) },
    });
    expect(logout).toHaveBeenCalledWith("access-before-failed-logout");
    expect(dependencies.getActiveManagedAccessToken()).toBe("access-before-failed-logout");
    expect(secrets.values.has("moss.phone.session")).toBe(false);
    const tombstoneBytes = secrets.values.get("moss.phone.logout_pending");
    expect(tombstoneBytes).toBeDefined();
    const tombstone = new TextDecoder().decode(tombstoneBytes);
    const pendingGeneration = JSON.parse(tombstone).generation;
    expect(JSON.parse(tombstone)).toMatchObject({ version: 1, requestedAt: now });
    expect(pendingGeneration).toEqual(expect.any(String));
    expect(tombstone).not.toContain("access-before-failed-logout");
    expect(tombstone).not.toContain("moss-refresh-token");

    vi.mocked(dependencies.disable).mockReturnValueOnce(Effect.fail(disableFailure));
    const retryService = await makeMossPhoneAccountService({ auth, now: () => now + 1_000 }).pipe(
      Effect.provide(dependencies.layer),
      Effect.runPromise,
    );
    const retryFailure = await retryService.getSession().pipe(Effect.flip, Effect.runPromise);

    expect(retryFailure).toMatchObject({ code: "persistence_failed" });
    expect(dependencies.getActiveManagedAccessToken()).toBe("access-before-failed-logout");
    expect(secrets.values.has("moss.phone.session")).toBe(false);
    expect(
      JSON.parse(new TextDecoder().decode(secrets.values.get("moss.phone.logout_pending")))
        .generation,
    ).toBe(pendingGeneration);

    const restored = await makeMossPhoneAccountService({ auth, now: () => now + 2_000 }).pipe(
      Effect.provide(dependencies.layer),
      Effect.runPromise,
    );

    // Layer construction remains non-blocking so health can listen. The first
    // account readiness query must finish the pending disable before it can
    // expose any account/provider state.
    expect(dependencies.disable).toHaveBeenCalledTimes(2);
    const restoredState = await restored.getSession().pipe(Effect.runPromise);

    expect(restoredState).toMatchObject({ authenticated: false, session: null });
    expect(dependencies.disable).toHaveBeenCalledTimes(3);
    expect([...secrets.values.keys()]).toEqual(["moss.phone.challenge_generation"]);
  });

  it("retires generation A before persisting B so a crash cannot expose A after restart", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const replacementPersisted = makeGate();
    const controlledSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      set: (name, value) => {
        const isReplacementSession =
          name === "moss.phone.session" &&
          new TextDecoder().decode(value).includes("access-generation-b");
        const persisted = secrets.service.set(name, value);
        return isReplacementSession
          ? persisted.pipe(
              Effect.tap(() => Effect.sync(() => replacementPersisted.open())),
              // Simulate a process exit after the durable set but before the
              // verify flow can call managedProvider.provision(B).
              Effect.flatMap(() => Effect.never),
            )
          : persisted;
      },
    };
    let activeManagedAccessToken: string | null = null;
    const provision: MossManagedProviderShape["provision"] = vi.fn((input) =>
      Effect.sync(() => {
        activeManagedAccessToken = input.accessToken;
      }),
    );
    const disable: MossManagedProviderShape["disable"] = vi.fn(() =>
      Effect.sync(() => {
        activeManagedAccessToken = null;
      }),
    );
    const needsDisable: MossManagedProviderShape["needsDisable"] = vi.fn(() =>
      Effect.sync(() => activeManagedAccessToken !== null),
    );
    const getProvisioningState: MossManagedProviderShape["getProvisioningState"] = vi.fn((input) =>
      Effect.sync(() => (activeManagedAccessToken === input.accessToken ? "ready" : "stale")),
    );
    const dependencies = Layer.merge(
      Layer.succeed(ServerSecretStore, controlledSecretStore),
      Layer.succeed(MossManagedProvider, {
        provision,
        disable,
        needsDisable,
        getProvisioningState,
      }),
    );
    let verificationCount = 0;
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => {
          verificationCount += 1;
          return verificationCount === 1
            ? phoneSession({
                accessToken: "access-generation-a",
                refreshToken: "refresh-generation-a",
              })
            : phoneSession({
                accessToken: "access-generation-b",
                refreshToken: "refresh-generation-b",
              });
        },
        getUser: async () => phoneSession().user,
      }),
    );

    await Effect.gen(function* () {
      const first = yield* makeMossPhoneAccountService({ auth, now: () => now });
      const firstChallenge = yield* first.startPhoneLogin({ phoneNumber: "13800138000" });
      yield* first.verifyPhoneLogin({
        challengeId: firstChallenge.challengeId,
        phoneNumber: firstChallenge.phoneNumber,
        code: "123456",
      });
      expect(activeManagedAccessToken).toBe("access-generation-a");

      const replacementChallenge = yield* first.startPhoneLogin({
        phoneNumber: "13800138000",
      });
      const interruptedReplacement = yield* first
        .verifyPhoneLogin({
          challengeId: replacementChallenge.challengeId,
          phoneNumber: replacementChallenge.phoneNumber,
          code: "654321",
        })
        .pipe(Effect.forkChild);
      yield* Effect.promise(() => replacementPersisted.promise);

      // B is durable, but the only launch surface is already disabled. In
      // particular, generation A cannot be used before account restoration.
      expect(activeManagedAccessToken).toBeNull();
      const persisted = JSON.parse(
        new TextDecoder().decode(secrets.values.get("moss.phone.session")),
      );
      expect(persisted.accessToken).toBe("access-generation-b");
      expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);
      yield* Fiber.interrupt(interruptedReplacement);

      // Recreating the account service has no eager side effect. The managed
      // surface remains disabled until getSession validates B and provisions
      // exactly B, never A.
      const restored = yield* makeMossPhoneAccountService({ auth, now: () => now + 1_000 });
      expect(activeManagedAccessToken).toBeNull();
      const restoredState = yield* restored.getSession();
      expect(restoredState.authenticated).toBe(true);
      expect(activeManagedAccessToken).toBe("access-generation-b");
      expect(vi.mocked(provision)).toHaveBeenLastCalledWith({
        authority: "memfire-phone",
        accessToken: "access-generation-b",
        gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
        models: expectedManagedProvisionModels,
        selectionPolicy: "preserve",
      });
    }).pipe(Effect.provide(dependencies), Effect.runPromise);
  });

  it("rejects a queued pre-logout verify after logout completes and only allows a fresh post-logout challenge", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const sessionRemoveStarted = makeGate();
    const releaseSessionRemove = makeGate();
    let pauseNextSessionRemove = false;
    const controlledSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      remove: (name) => {
        if (name !== "moss.phone.session" || !pauseNextSessionRemove) {
          return secrets.service.remove(name);
        }
        pauseNextSessionRemove = false;
        return Effect.sync(() => sessionRemoveStarted.open()).pipe(
          Effect.flatMap(() => Effect.promise(() => releaseSessionRemove.promise)),
          Effect.flatMap(() => secrets.service.remove(name)),
        );
      },
    };
    const dependencies = makePhoneServiceDependencies(controlledSecretStore);
    let verificationCount = 0;
    const verifyPhoneOtp = vi.fn(async () => {
      verificationCount += 1;
      if (verificationCount === 1) {
        return phoneSession({
          accessToken: "access-generation-a",
          refreshToken: "refresh-generation-a",
        });
      }
      return phoneSession({
        accessToken: "access-generation-b",
        refreshToken: "refresh-generation-b",
      });
    });
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const auth = availableAuth(
      makeClient({
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp,
        logout,
      }),
    );

    const service = await makeMossPhoneAccountService({ auth, now: () => now }).pipe(
      Effect.provide(dependencies.layer),
      Effect.runPromise,
    );
    const firstChallenge = await service
      .startPhoneLogin({ phoneNumber: "13800138000" })
      .pipe(Effect.runPromise);
    await service
      .verifyPhoneLogin({
        challengeId: firstChallenge.challengeId,
        phoneNumber: firstChallenge.phoneNumber,
        code: "123456",
      })
      .pipe(Effect.runPromise);
    const replacementChallenge = await service
      .startPhoneLogin({ phoneNumber: "13800138000" })
      .pipe(Effect.runPromise);

    pauseNextSessionRemove = true;
    const logoutPromise = service.logout().pipe(Effect.runPromise);
    await sessionRemoveStarted.promise;
    const replacementPromise = service
      .verifyPhoneLogin({
        challengeId: replacementChallenge.challengeId,
        phoneNumber: replacementChallenge.phoneNumber,
        code: "654321",
      })
      .pipe(Effect.flip, Effect.runPromise);

    // Starting the effect is synchronous through the auth thunk. If the
    // lifecycle semaphore were absent, generation B would already be inside
    // verifyPhoneOtp while logout A is paused before deleting its session.
    expect(verifyPhoneOtp).toHaveBeenCalledTimes(1);

    releaseSessionRemove.open();
    const logoutResult = await logoutPromise;

    // Logout is the hard session boundary. The pre-logout challenge must never
    // revive an account after logout returns, even if its verify call was
    // queued while logout was paused.
    expect(logoutResult).toEqual({ revokedCount: 1 });
    expect(secrets.values.has("moss.phone.session")).toBe(false);
    expect(dependencies.disable).toHaveBeenCalledOnce();
    expect(logout).toHaveBeenCalledWith("access-generation-a");

    const replacementFailure = await replacementPromise;
    expect(replacementFailure.code).toBe("challenge_not_found");
    expect(verifyPhoneOtp).toHaveBeenCalledTimes(1);
    expect(secrets.values.has("moss.phone.logout_pending")).toBe(false);

    const postLogoutChallenge = await service
      .startPhoneLogin({ phoneNumber: "13800138000" })
      .pipe(Effect.runPromise);
    const postLogoutState = await service
      .verifyPhoneLogin({
        challengeId: postLogoutChallenge.challengeId,
        phoneNumber: postLogoutChallenge.phoneNumber,
        code: "123456",
      })
      .pipe(Effect.runPromise);
    expect(postLogoutState.authenticated).toBe(true);
    const persistedBytes = secrets.values.get("moss.phone.session");
    expect(persistedBytes).toBeDefined();
    const persisted = JSON.parse(new TextDecoder().decode(persistedBytes));
    expect(persisted.accessToken).toBe("access-generation-b");
    expect(persisted.refreshToken).toBe("refresh-generation-b");
    expect(persisted.session.id).toBe(postLogoutState.session?.id);
    expect(dependencies.provision).toHaveBeenLastCalledWith({
      authority: "memfire-phone",
      accessToken: "access-generation-b",
      gatewayBaseUrl: "https://moss.example.cn/functions/v1/moss-model-gateway",
      models: expectedManagedProvisionModels,
      selectionPolicy: "select",
    });
    expect(vi.mocked(dependencies.disable).mock.invocationCallOrder.at(-1) ?? 0).toBeLessThan(
      vi.mocked(dependencies.provision).mock.invocationCallOrder.at(-1) ?? 0,
    );
  });
});
