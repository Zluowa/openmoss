import { Deferred, Effect, Fiber, Layer } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
        models: mossManagedCodexModelsForLane("global"),
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
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite";
import {
  MossManagedProvider,
  type MossManagedProviderShape,
} from "../Services/MossManagedProvider";
import { MossCloudAccountServiceError } from "../mossCloudAccountErrors";
import { makeMossManagedProviderCoordinator } from "../mossAccountLifecycleLock";
import {
  SupabaseMossAuthError,
  type SupabaseGoogleAuthAvailable,
  type SupabaseGoogleAuthClient,
  type SupabaseMossAuthAvailable,
  type SupabaseMossAuthClient,
  type SupabaseMossAuthSession,
} from "../supabaseMossAuth";
import { makeMossCloudAccountService } from "./MossCloudAccountService";
import { mossManagedCodexModelsForLane } from "./MossManagedProvider";

const decoder = new TextDecoder();
const encoder = new TextEncoder();

const user = {
  id: "account-1",
  email: "person@example.com",
  phone: null,
  role: "authenticated",
  audience: "authenticated",
  emailConfirmedAt: "2026-07-12T00:00:00.000Z",
  phoneConfirmedAt: null,
  lastSignInAt: "2026-07-12T00:00:00.000Z",
  createdAt: "2026-07-12T00:00:00.000Z",
  updatedAt: "2026-07-12T00:00:00.000Z",
  appMetadata: { provider: "email" },
  userMetadata: { display_name: "Person" },
} as const;

const session = (input: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}): SupabaseMossAuthSession => ({
  ...input,
  tokenType: "bearer",
  expiresInSeconds: 3_600,
  user,
});

const googleUser = {
  ...user,
  appMetadata: { provider: "google", providers: ["google"] },
} as const;

const googleSession = (input: {
  readonly accessToken: string;
  readonly refreshToken: string;
  readonly expiresAt: number;
}): SupabaseMossAuthSession => ({
  ...input,
  tokenType: "bearer",
  expiresInSeconds: 3_600,
  user: googleUser,
});

const unavailable = async (): Promise<never> => {
  throw new Error("unexpected auth client call");
};

const makeClient = (overrides: Partial<SupabaseMossAuthClient> = {}): SupabaseMossAuthClient => ({
  config: {
    cloudRegion: null,
    supabaseUrl: "https://moss-test.supabase.co",
    redirectUrl: "moss://auth/callback",
    modelGatewayUrl: "https://moss-test.supabase.co/functions/v1/moss-model-gateway",
  },
  signup: unavailable,
  signin: unavailable,
  sendPhoneOtp: unavailable,
  verifyPhoneOtp: unavailable,
  refresh: unavailable,
  getUser: unavailable,
  recover: unavailable,
  exchangeCode: unavailable,
  updatePassword: unavailable,
  logout: unavailable,
  ...overrides,
});

const availableAuth = (client: SupabaseMossAuthClient): SupabaseMossAuthAvailable => ({
  status: "available",
  available: true,
  config: client.config,
  client,
});

const makeGoogleClient = (
  overrides: Partial<SupabaseGoogleAuthClient> = {},
): SupabaseGoogleAuthClient => ({
  config: {
    realm: "supabase-google",
    issuer: "https://moss-test.supabase.co/auth/v1",
    cloudRegion: "global",
    redirectUrl: "moss://auth/callback",
    modelGatewayUrl: "https://global-gateway.example.test",
    realtimeRelayUrl: "https://global-realtime.example.test",
  },
  createAuthorizeUrl: unavailable,
  exchangeCode: unavailable,
  refresh: unavailable,
  getUser: unavailable,
  logout: unavailable,
  ...overrides,
});

const availableGoogleAuth = (client: SupabaseGoogleAuthClient): SupabaseGoogleAuthAvailable => ({
  status: "available",
  available: true,
  config: client.config,
  client,
});

const makeSecretStore = () => {
  const values = new Map<string, Uint8Array>();
  const service: ServerSecretStoreShape = {
    get: (name) => Effect.sync(() => values.get(name)?.slice() ?? null),
    set: (name, value) => Effect.sync(() => values.set(name, value.slice())).pipe(Effect.asVoid),
    getOrCreateRandom: (name, bytes) =>
      Effect.sync(() => {
        const current = values.get(name);
        if (current) return current.slice();
        const created = new Uint8Array(bytes).fill(7);
        values.set(name, created);
        return created.slice();
      }),
    remove: (name) => Effect.sync(() => values.delete(name)).pipe(Effect.asVoid),
  };
  return { service, values };
};

const makeManagedProvider = () => {
  const needsDisable = vi.fn<MossManagedProviderShape["needsDisable"]>(() => Effect.succeed(false));
  const getProvisioningState = vi.fn<MossManagedProviderShape["getProvisioningState"]>(() =>
    Effect.succeed("ready"),
  );
  const provision = vi.fn<MossManagedProviderShape["provision"]>(() => Effect.void);
  const disable = vi.fn<MossManagedProviderShape["disable"]>(() => Effect.void);
  return {
    service: {
      needsDisable,
      getProvisioningState,
      provision,
      disable,
    } satisfies MossManagedProviderShape,
    needsDisable,
    getProvisioningState,
    provision,
    disable,
  };
};

const makeLayer = (
  secretStore: ServerSecretStoreShape,
  managedProvider: MossManagedProviderShape,
) =>
  Layer.mergeAll(
    SqlitePersistenceMemory,
    Layer.succeed(ServerSecretStore, secretStore),
    Layer.succeed(MossManagedProvider, managedProvider),
  );

describe("MossCloudAccountService", () => {
  it.each(["logout", "remove", "switch"] as const)(
    "fences local ownership during an entered account %s",
    async (operation) => {
      const now = 1_800_000_000_000;
      const entered = Deferred.makeUnsafe<void>();
      const release = Deferred.makeUnsafe<void>();
      let exchanges = 0;
      const client = makeGoogleClient({
        createAuthorizeUrl: async ({ flowId, pkce }) =>
          `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
        exchangeCode: async () => ({
          ...googleSession({
            accessToken: `account-access-${++exchanges}`,
            refreshToken: "account-refresh",
            expiresAt: now + 3_600_000,
          }),
          user: {
            ...googleUser,
            id: `account-${exchanges}`,
            email: `person${exchanges}@example.test`,
          },
        }),
        logout: async () => {
          Effect.runSync(Deferred.succeed(entered, undefined));
          await Effect.runPromise(Deferred.await(release));
          return { accepted: true };
        },
      });
      const secrets = makeSecretStore();
      const managed = makeManagedProvider();
      const auth = availableGoogleAuth(client);
      await Effect.gen(function* () {
        const service = yield* makeMossCloudAccountService({ auth, now: () => now });
        const first = yield* service.startGoogleOAuth();
        yield* service.exchangeGoogleOAuthCode({ code: "first-owner-code", flowId: first.flowId });
        const second = yield* service.startGoogleOAuth();
        yield* service.exchangeGoogleOAuthCode({
          code: "second-owner-code",
          flowId: second.flowId,
        });
        if (operation === "switch") {
          managed.provision.mockImplementation(() =>
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          );
        }
        const mutation = yield* (
          operation === "logout"
            ? service.logout().pipe(Effect.asVoid)
            : operation === "remove"
              ? service.removeAccount({ accountId: "account-2" }).pipe(Effect.asVoid)
              : service.selectAccount({ accountId: "account-1" }).pipe(Effect.asVoid)
        ).pipe(Effect.forkChild);
        try {
          yield* Deferred.await(entered);
          const saved = [...secrets.values.entries()].map(([key, bytes]) => [key, bytes.slice()]);
          const reading = yield* service
            .getLocalAuthority()
            .pipe(Effect.forkChild({ startImmediately: true }));
          expect(reading.pollUnsafe()).toBeDefined();
          expect((yield* Fiber.join(reading)).identity).toBeNull();
          const restarted = yield* makeMossCloudAccountService({ auth, now: () => now });
          expect((yield* restarted.getLocalAuthority()).identity).toBeNull();
          expect([...secrets.values.entries()]).toEqual(saved);
          expect(mutation.pollUnsafe()).toBeUndefined();
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.join(mutation);
          expect((yield* service.getLocalAuthority()).identity?.account.id ?? null).toBe(
            operation === "logout" ? null : "account-1",
          );
        } finally {
          yield* Deferred.succeed(release, undefined);
          yield* Fiber.interrupt(mutation);
        }
      }).pipe(
        Effect.provide(makeLayer(secrets.service, managed.service)),
        Effect.scoped,
        Effect.runPromise,
      );
    },
  );

  it("reads local ownership independently of an entered network refresh", async () => {
    let now = 1_800_000_000_000;
    const entered = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode: async () =>
        googleSession({
          accessToken: "held-google-access",
          refreshToken: "held-google-refresh",
          expiresAt: now + 1_000,
        }),
      refresh: async () => {
        Effect.runSync(Deferred.succeed(entered, undefined));
        await Effect.runPromise(Deferred.await(release));
        throw new SupabaseMossAuthError({
          operation: "refresh",
          code: "session_expired",
          status: 401,
          retryable: false,
          message: "revoked fixture",
        });
      },
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(client),
        now: () => now,
      });
      const started = yield* service.startGoogleOAuth();
      yield* service.exchangeGoogleOAuthCode({ code: "held-code", flowId: started.flowId });
      now += 2_000;
      const refreshing = yield* service
        .getAuthorityCredential()
        .pipe(Effect.flip, Effect.forkChild);
      try {
        yield* Deferred.await(entered);
        const saved = [...secrets.values.entries()].find(([key]) =>
          key.startsWith("moss.cloud.session"),
        );
        expect(saved).toBeDefined();
        if (!saved) return yield* Effect.die("Missing verified session fixture");
        const [secretRef, sessionBytes] = saved;
        const recoveryExpired = encoder.encode(
          JSON.stringify({
            ...JSON.parse(decoder.decode(sessionBytes)),
            recoveryAuthorizedUntil: now - 1,
          }),
        );
        secrets.values.set(secretRef, recoveryExpired);
        const reading = yield* service
          .getLocalAuthority()
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(reading.pollUnsafe()).toBeDefined();
        const local = yield* Fiber.join(reading);
        expect(local.identity?.account).toEqual({ id: "account-1", realm: "supabase-google" });
        expect(local.activeRealm).toBe("global");
        expect(secrets.values.get(secretRef)).toEqual(recoveryExpired);
        expect(refreshing.pollUnsafe()).toBeUndefined();
        const queuedLogout = yield* service
          .logout()
          .pipe(Effect.forkChild({ startImmediately: true }));
        expect(queuedLogout.pollUnsafe()).toBeUndefined();
        expect((yield* service.getLocalAuthority()).identity).toBeNull();
        yield* Fiber.interrupt(queuedLogout);
        expect((yield* service.getLocalAuthority()).identity?.account.id).toBe("account-1");
        yield* Deferred.succeed(release, undefined);
        expect(yield* Fiber.join(refreshing)).toMatchObject({ code: "session_expired" });
        expect((yield* service.getLocalAuthority()).identity).toBeNull();
      } finally {
        yield* Deferred.succeed(release, undefined);
        yield* Fiber.interrupt(refreshing);
      }
    }).pipe(
      Effect.provide(makeLayer(secrets.service, managed.service)),
      Effect.scoped,
      Effect.runPromise,
    );
  });

  it("uses a replay-safe one-time realm-bound Google PKCE flow and exposes only its global authority", async () => {
    const now = 1_800_000_000_000;
    let exchangedVerifier = "";
    const exchangeCode = vi.fn<SupabaseGoogleAuthClient["exchangeCode"]>(async (code, verifier) => {
      expect(code).toBe("google-auth-code");
      exchangedVerifier = verifier;
      return googleSession({
        accessToken: "google-access-secret",
        refreshToken: "google-refresh-secret",
        expiresAt: now + 3_600_000,
      });
    });
    const createAuthorizeUrl = vi.fn<SupabaseGoogleAuthClient["createAuthorizeUrl"]>(
      async ({ flowId, pkce }) => {
        const url = new URL("https://moss-test.supabase.co/auth/v1/authorize");
        url.searchParams.set("provider", "google");
        url.searchParams.set("redirect_to", `moss://auth/callback?flow_id=${flowId}`);
        url.searchParams.set("code_challenge", pkce.codeChallenge);
        url.searchParams.set("code_challenge_method", "s256");
        return url.toString();
      },
    );
    const client = makeGoogleClient({ createAuthorizeUrl, exchangeCode });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(client),
        now: () => now,
      });
      const started = yield* service.startGoogleOAuth();
      const authorizeUrl = new URL(started.authorizationUrl);
      expect(authorizeUrl.searchParams.has("state")).toBe(false);
      expect(authorizeUrl.searchParams.get("redirect_to")).toBe(
        `moss://auth/callback?flow_id=${started.flowId}`,
      );

      const flowEnvelope = [...secrets.values.entries()].find(([name]) => name.endsWith(".google"));
      expect(flowEnvelope).toBeDefined();
      expect(JSON.parse(decoder.decode(flowEnvelope?.[1]))).toMatchObject({
        version: 2,
        flow: "google",
        realm: "supabase-google",
        issuer: client.config.issuer,
        flowId: started.flowId,
      });

      const state = yield* service.exchangeGoogleOAuthCode({
        code: "google-auth-code",
        flowId: started.flowId,
      });
      expect(state).toMatchObject({
        authenticated: true,
        authProvider: "supabase_google",
        lastAuthFlow: "google",
      });
      expect(exchangedVerifier.length).toBeGreaterThanOrEqual(43);
      expect(secrets.values.has("moss.cloud.pkce.google")).toBe(false);

      const credential = yield* service.getAuthorityCredential();
      expect(credential).toEqual({
        realm: "supabase-google",
        issuer: client.config.issuer,
        accessToken: "google-access-secret",
        gatewayBaseUrl: client.config.modelGatewayUrl,
        realtimeRelayUrl: client.config.realtimeRelayUrl,
      });
      const storedSession = [...secrets.values.values()]
        .map((bytes) => decoder.decode(bytes))
        .find((value) => value.includes("google-access-secret"));
      expect(JSON.parse(storedSession ?? "{}")).toMatchObject({
        version: 2,
        realm: "supabase-google",
        issuer: client.config.issuer,
        provider: "google",
      });

      managed.provision.mockClear();
      managed.getProvisioningState.mockReturnValueOnce(Effect.succeed("stale"));
      const healedState = yield* service.getState();
      expect(healedState.authenticated).toBe(true);
      expect(managed.provision).toHaveBeenCalledOnce();
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: "supabase-google",
          accessToken: "google-access-secret",
          gatewayBaseUrl: client.config.modelGatewayUrl,
          selectionPolicy: "preserve",
        }),
      );

      const coordinator = makeMossManagedProviderCoordinator(secrets.service, managed.service);
      yield* coordinator.provision({
        authority: "memfire-phone",
        accessToken: "phone-owner-token",
        gatewayBaseUrl: "https://cn-gateway.example.test",
        selectionPolicy: "select",
      });
      managed.provision.mockClear();
      managed.getProvisioningState.mockClear();
      const deferredCloudState = yield* service.getState();
      expect(deferredCloudState.authenticated).toBe(true);
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.getProvisioningState).not.toHaveBeenCalled();

      const explicitlySelected = yield* service.selectAccount({ accountId: "account-1" });
      expect(explicitlySelected.authenticated).toBe(true);
      expect(managed.provision).toHaveBeenCalledOnce();
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          authority: "supabase-google",
          accessToken: "google-access-secret",
          selectionPolicy: "select",
        }),
      );

      const restartedService = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(client),
        now: () => now,
      });
      const replayed = yield* restartedService.exchangeGoogleOAuthCode({
        code: "google-auth-code",
        flowId: started.flowId,
      });
      expect(replayed).toMatchObject({
        authenticated: true,
        authProvider: "supabase_google",
        lastAuthFlow: "google",
      });
      const forgedReplay = yield* restartedService
        .exchangeGoogleOAuthCode({ code: "different-google-code", flowId: started.flowId })
        .pipe(Effect.flip);
      expect(forgedReplay).toMatchObject({ code: "session_expired" });
      expect(exchangeCode).toHaveBeenCalledOnce();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("reads expired Google ownership offline while the live authority still rejects refresh failure", async () => {
    const now = 1_800_000_000_000;
    const refresh = vi.fn<SupabaseGoogleAuthClient["refresh"]>(async () => {
      throw new SupabaseMossAuthError({
        operation: "refresh",
        code: "network_error",
        status: null,
        retryable: true,
        message: "offline fixture",
      });
    });
    const getUser = vi.fn(unavailable);
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode: async () =>
        googleSession({
          accessToken: "expired-google-access",
          refreshToken: "offline-google-refresh",
          expiresAt: now + 1_000,
        }),
      refresh,
      getUser,
    });
    const auth = availableGoogleAuth(client);
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();
    const fetchGatewayModels = vi.fn(() =>
      Effect.succeed({ status: "ready", models: ["gpt-5.5"] } as const),
    );

    await Effect.gen(function* () {
      const first = yield* makeMossCloudAccountService({ auth, now: () => now });
      const started = yield* first.startGoogleOAuth();
      yield* first.exchangeGoogleOAuthCode({ code: "offline-code", flowId: started.flowId });
      const restarted = yield* makeMossCloudAccountService({
        auth,
        now: () => now + 2_000,
        fetchGatewayModels,
      });
      const savedSecrets = [...secrets.values.entries()].map(([name, bytes]) => [
        name,
        bytes.slice(),
      ]);
      managed.provision.mockClear();
      managed.disable.mockClear();
      managed.getProvisioningState.mockClear();

      const local = yield* restarted.getLocalAuthority();
      expect(local.identity).toEqual({
        realm: "supabase-google",
        gatewayBaseUrl: client.config.modelGatewayUrl,
        account: { id: "account-1", realm: "supabase-google" },
        displayName: "Person",
      });
      expect(JSON.stringify(local)).not.toContain("expired-google-access");
      expect(JSON.stringify(local)).not.toContain("offline-google-refresh");
      expect([...secrets.values.entries()]).toEqual(savedSecrets);
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      expect(fetchGatewayModels).not.toHaveBeenCalled();
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).not.toHaveBeenCalled();
      expect(managed.getProvisioningState).not.toHaveBeenCalled();

      const credentialFailure = yield* restarted.getAuthorityCredential().pipe(Effect.flip);
      expect(credentialFailure).toMatchObject({ code: "network_error" });
      expect((yield* restarted.getLocalAuthority()).identity).toEqual(local.identity);
      expect(refresh).toHaveBeenCalledOnce();
      expect(getUser).not.toHaveBeenCalled();
      expect(fetchGatewayModels).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("tracks the selected Google owner across account changes and never revives one after logout", async () => {
    const now = 1_800_000_000_000;
    const exchangeCode = vi
      .fn<SupabaseGoogleAuthClient["exchangeCode"]>()
      .mockResolvedValueOnce(
        googleSession({
          accessToken: "first-google-access",
          refreshToken: "first-google-refresh",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...googleSession({
          accessToken: "second-google-access",
          refreshToken: "second-google-refresh",
          expiresAt: now + 3_600_000,
        }),
        user: { ...googleUser, id: "account-2", email: "other@example.com" },
      });
    const refresh = vi.fn(unavailable);
    const getUser = vi.fn(unavailable);
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode,
      refresh,
      getUser,
      logout,
    });
    const auth = availableGoogleAuth(client);
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({ auth, now: () => now });
      const firstFlow = yield* service.startGoogleOAuth();
      yield* service.exchangeGoogleOAuthCode({ code: "first-code", flowId: firstFlow.flowId });
      expect((yield* service.getLocalAuthority()).identity?.account.id).toBe("account-1");
      const secondFlow = yield* service.startGoogleOAuth();
      yield* service.exchangeGoogleOAuthCode({ code: "second-code", flowId: secondFlow.flowId });
      expect((yield* service.getLocalAuthority()).identity?.account.id).toBe("account-2");

      const restarted = yield* makeMossCloudAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restarted.getLocalAuthority()).identity?.account.id).toBe("account-2");
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
      yield* restarted.logout();
      expect(logout).toHaveBeenCalledWith("second-google-access");
      expect((yield* service.getLocalAuthority()).identity).toBeNull();
      expect((yield* restarted.getLocalAuthority()).identity).toBeNull();
      const afterLogout = yield* makeMossCloudAccountService({ auth, now: () => now + 2_000 });
      expect((yield* afterLogout.getLocalAuthority()).identity).toBeNull();
      const credentialFailure = yield* afterLogout.getAuthorityCredential().pipe(Effect.flip);
      expect(credentialFailure).toMatchObject({ code: "authentication_required" });
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("reads durable Google realm selection after a cross-realm switch and reconstruction", async () => {
    const now = 1_800_000_000_000;
    const refresh = vi.fn(unavailable);
    const getUser = vi.fn(unavailable);
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode: async () =>
        googleSession({
          accessToken: "google-local-realm-access",
          refreshToken: "google-local-realm-refresh",
          expiresAt: now + 3_600_000,
        }),
      refresh,
      getUser,
    });
    const auth = availableGoogleAuth(client);
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({ auth, now: () => now });
      const started = yield* service.startGoogleOAuth();
      yield* service.exchangeGoogleOAuthCode({ code: "google-local-code", flowId: started.flowId });
      expect((yield* service.getLocalAuthority()).activeRealm).toBe("global");
      const restarted = yield* makeMossCloudAccountService({ auth, now: () => now + 1_000 });
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBe("global");
      const coordinator = makeMossManagedProviderCoordinator(secrets.service, managed.service);
      yield* coordinator.provision({
        authority: "memfire-phone",
        accessToken: "other-phone-access",
        gatewayBaseUrl: "https://cn-gateway.example.test",
        selectionPolicy: "select",
      });
      managed.provision.mockClear();
      managed.getProvisioningState.mockClear();

      const local = yield* service.getLocalAuthority();
      expect(local.activeRealm).toBeUndefined();
      expect(local.identity?.account).toEqual({ id: "account-1", realm: "supabase-google" });
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBeUndefined();
      yield* coordinator.provision({
        authority: "supabase-google",
        accessToken: "google-local-realm-access",
        gatewayBaseUrl: client.config.modelGatewayUrl,
        selectionPolicy: "select",
      });
      managed.provision.mockClear();
      expect((yield* service.getLocalAuthority()).activeRealm).toBe("global");
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBe("global");
      secrets.values.delete("moss.managed.binding");
      expect((yield* service.getLocalAuthority()).activeRealm).toBeUndefined();
      expect((yield* restarted.getLocalAuthority()).activeRealm).toBeUndefined();
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.getProvisioningState).not.toHaveBeenCalled();
      expect(refresh).not.toHaveBeenCalled();
      expect(getUser).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it.each(["pending", "corrupt"] as const)(
    "rejects local Google selection with a %s durable binding despite a cached active realm",
    async (state) => {
      const now = 1_800_000_000_000;
      const refresh = vi.fn(unavailable);
      const getUser = vi.fn(unavailable);
      const client = makeGoogleClient({
        createAuthorizeUrl: async ({ flowId, pkce }) =>
          `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
        exchangeCode: async () =>
          googleSession({
            accessToken: "google-binding-access",
            refreshToken: "google-binding-refresh",
            expiresAt: now + 3_600_000,
          }),
        refresh,
        getUser,
      });
      const auth = availableGoogleAuth(client);
      const secrets = makeSecretStore();
      const managed = makeManagedProvider();

      await Effect.gen(function* () {
        const service = yield* makeMossCloudAccountService({ auth, now: () => now });
        const started = yield* service.startGoogleOAuth();
        yield* service.exchangeGoogleOAuthCode({ code: "binding-code", flowId: started.flowId });
        expect((yield* service.getLocalAuthority()).activeRealm).toBe("global");
        const original = JSON.parse(
          decoder.decode(secrets.values.get("moss.managed.binding")),
        ) as Record<string, unknown>;
        const changed = encoder.encode(
          state === "pending" ? JSON.stringify({ ...original, state: "pending" }) : "{invalid-json",
        );
        secrets.values.set("moss.managed.binding", changed);
        managed.provision.mockClear();
        managed.getProvisioningState.mockClear();

        const failure = yield* service.getLocalAuthority().pipe(Effect.flip);
        expect(failure).toMatchObject({ code: "persistence_failed" });
        const restarted = yield* makeMossCloudAccountService({ auth, now: () => now + 1_000 });
        const restartFailure = yield* restarted.getLocalAuthority().pipe(Effect.flip);
        expect(restartFailure).toMatchObject({ code: "persistence_failed" });
        expect(secrets.values.get("moss.managed.binding")).toEqual(changed);
        expect(managed.provision).not.toHaveBeenCalled();
        expect(managed.getProvisioningState).not.toHaveBeenCalled();
        expect(refresh).not.toHaveBeenCalled();
        expect(getUser).not.toHaveBeenCalled();
      }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
    },
  );

  it("keeps a Google session when catalog access is denied and does not provision a static fallback", async () => {
    const now = 1_800_000_000_000;
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode: async () =>
        googleSession({
          accessToken: "google-access-denied",
          refreshToken: "google-refresh-denied",
          expiresAt: now + 3_600_000,
        }),
      getUser: async () => googleUser,
    });
    const auth = availableGoogleAuth(client);
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();
    const fetchGatewayModels = vi.fn(() =>
      Effect.succeed({ status: "auth-denied", models: [] } as const),
    );

    const state = await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth,
        now: () => now,
        fetchGatewayModels,
      });
      const started = yield* service.startGoogleOAuth();
      return yield* service.exchangeGoogleOAuthCode({
        code: "denied-code",
        flowId: started.flowId,
      });
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);

    expect(state).toMatchObject({ authenticated: true, modelGatewayStatus: "auth-denied" });
    expect(managed.provision).not.toHaveBeenCalled();
    expect([...secrets.values.keys()].some((key) => key.startsWith("moss.cloud.session."))).toBe(
      true,
    );
  });

  it("rejects mismatched Google flow ids and disables email/password in the Google realm", async () => {
    const createAuthorizeUrl = vi.fn<SupabaseGoogleAuthClient["createAuthorizeUrl"]>(
      async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
    );
    const exchangeCode = vi.fn<SupabaseGoogleAuthClient["exchangeCode"]>();
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(makeGoogleClient({ createAuthorizeUrl, exchangeCode })),
      });
      const started = yield* service.startGoogleOAuth();
      const mismatched = `${started.flowId.slice(0, -1)}x` as typeof started.flowId;
      const mismatchFailure = yield* service
        .exchangeGoogleOAuthCode({ code: "untrusted-code", flowId: mismatched })
        .pipe(Effect.flip);
      expect(mismatchFailure).toMatchObject({ code: "session_expired" });
      expect(exchangeCode).not.toHaveBeenCalled();

      const passwordFailure = yield* service
        .signIn({ email: "person@example.com", password: "password-123" })
        .pipe(Effect.flip);
      expect(passwordFailure).toMatchObject({ code: "not_configured" });
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("quarantines a legacy email session without sending its token to the Google authority", async () => {
    const now = 1_800_000_000_000;
    const legacySignin = vi.fn(async () =>
      session({
        accessToken: "legacy-email-access",
        refreshToken: "legacy-email-refresh",
        expiresAt: now + 3_600_000,
      }),
    );
    const googleRefresh = vi.fn<SupabaseGoogleAuthClient["refresh"]>();
    const googleGetUser = vi.fn<SupabaseGoogleAuthClient["getUser"]>();
    const googleLogout = vi.fn<SupabaseGoogleAuthClient["logout"]>();
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const legacy = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin: legacySignin })),
        now: () => now,
      });
      yield* legacy.signIn({ email: "person@example.com", password: "password-123" });
      expect(
        [...secrets.values.values()].some((bytes) =>
          decoder.decode(bytes).includes("legacy-email-access"),
        ),
      ).toBe(true);

      managed.provision.mockClear();
      managed.disable.mockClear();
      const googleOnly = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(
          makeGoogleClient({
            refresh: googleRefresh,
            getUser: googleGetUser,
            logout: googleLogout,
          }),
        ),
        now: () => now,
      });
      const localFailure = yield* googleOnly.getLocalAuthority().pipe(Effect.flip);
      expect(localFailure).toMatchObject({ code: "persistence_failed" });
      const restoreFailure = yield* googleOnly.restore().pipe(Effect.flip);

      expect(restoreFailure).toMatchObject({ code: "persistence_failed" });
      expect(googleRefresh).not.toHaveBeenCalled();
      expect(googleGetUser).not.toHaveBeenCalled();
      expect(googleLogout).not.toHaveBeenCalled();
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).toHaveBeenCalledOnce();
      expect((yield* googleOnly.getState()).authenticated).toBe(false);
      expect((yield* googleOnly.getLocalAuthority()).identity).toBeNull();
      const credentialFailure = yield* googleOnly.getAuthorityCredential().pipe(Effect.flip);
      expect(credentialFailure).toMatchObject({ code: "authentication_required" });
      expect(
        [...secrets.values.values()].some((bytes) =>
          decoder.decode(bytes).includes("legacy-email-access"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("consumes the Google flow without persisting a non-Google Supabase identity", async () => {
    const createAuthorizeUrl = vi.fn<SupabaseGoogleAuthClient["createAuthorizeUrl"]>(
      async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
    );
    const exchangeCode = vi.fn<SupabaseGoogleAuthClient["exchangeCode"]>(async () =>
      session({
        accessToken: "email-provider-access",
        refreshToken: "email-provider-refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
    );
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(makeGoogleClient({ createAuthorizeUrl, exchangeCode })),
      });
      const started = yield* service.startGoogleOAuth();
      const failure = yield* service
        .exchangeGoogleOAuthCode({ code: "non-google-code", flowId: started.flowId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "provider_error" });
      expect(secrets.values.has("moss.cloud.pkce.google")).toBe(false);
      expect(
        [...secrets.values.values()].some((bytes) =>
          decoder.decode(bytes).includes("email-provider-access"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("consumes the Google flow without persisting a mixed-provider Supabase identity", async () => {
    const createAuthorizeUrl = vi.fn<SupabaseGoogleAuthClient["createAuthorizeUrl"]>(
      async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
    );
    const exchangeCode = vi.fn<SupabaseGoogleAuthClient["exchangeCode"]>(async () => ({
      ...googleSession({
        accessToken: "mixed-provider-access",
        refreshToken: "mixed-provider-refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
      user: {
        ...googleUser,
        appMetadata: { provider: "google", providers: ["google", "email"] },
      },
    }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(makeGoogleClient({ createAuthorizeUrl, exchangeCode })),
      });
      const started = yield* service.startGoogleOAuth();
      const failure = yield* service
        .exchangeGoogleOAuthCode({ code: "mixed-provider-code", flowId: started.flowId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "provider_error" });
      expect(secrets.values.has("moss.cloud.pkce.google")).toBe(false);
      expect(
        [...secrets.values.values()].some((bytes) =>
          decoder.decode(bytes).includes("mixed-provider-access"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("consumes the Google flow without persisting an unconfirmed Google identity", async () => {
    const createAuthorizeUrl = vi.fn<SupabaseGoogleAuthClient["createAuthorizeUrl"]>(
      async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
    );
    const exchangeCode = vi.fn<SupabaseGoogleAuthClient["exchangeCode"]>(async () => ({
      ...googleSession({
        accessToken: "unconfirmed-google-access",
        refreshToken: "unconfirmed-google-refresh",
        expiresAt: Date.now() + 3_600_000,
      }),
      user: { ...googleUser, emailConfirmedAt: null },
    }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(makeGoogleClient({ createAuthorizeUrl, exchangeCode })),
      });
      const started = yield* service.startGoogleOAuth();
      const failure = yield* service
        .exchangeGoogleOAuthCode({ code: "unconfirmed-google-code", flowId: started.flowId })
        .pipe(Effect.flip);
      expect(failure).toMatchObject({ code: "provider_error" });
      expect(secrets.values.has("moss.cloud.pkce.google")).toBe(false);
      expect(
        [...secrets.values.values()].some((bytes) =>
          decoder.decode(bytes).includes("unconfirmed-google-access"),
        ),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("never restores a Google bearer under a different Supabase issuer", async () => {
    const now = 1_800_000_000_000;
    const client = makeGoogleClient({
      createAuthorizeUrl: async ({ flowId, pkce }) =>
        `https://moss-test.supabase.co/auth/v1/authorize?provider=google&redirect_to=${encodeURIComponent(`moss://auth/callback?flow_id=${flowId}`)}&code_challenge=${pkce.codeChallenge}&code_challenge_method=s256`,
      exchangeCode: async () =>
        googleSession({
          accessToken: "issuer-a-access",
          refreshToken: "issuer-a-refresh",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const first = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(client),
        now: () => now,
      });
      const started = yield* first.startGoogleOAuth();
      yield* first.exchangeGoogleOAuthCode({ code: "issuer-a-code", flowId: started.flowId });

      const otherClient = makeGoogleClient({
        config: {
          ...client.config,
          issuer: "https://other-project.supabase.co/auth/v1",
          modelGatewayUrl: "https://other-global-gateway.example.test",
          realtimeRelayUrl: "https://other-global-realtime.example.test",
        },
      });
      const reconstructed = yield* makeMossCloudAccountService({
        auth: availableGoogleAuth(otherClient),
        now: () => now,
      });
      const localFailure = yield* reconstructed.getLocalAuthority().pipe(Effect.flip);
      expect(localFailure).toMatchObject({ code: "persistence_failed" });
      const stateFailure = yield* reconstructed.getState().pipe(Effect.flip);
      expect(stateFailure).toMatchObject({ code: "persistence_failed" });
      const credentialFailure = yield* reconstructed.getAuthorityCredential().pipe(Effect.flip);
      expect(credentialFailure).toMatchObject({ code: "authentication_required" });
      expect((yield* reconstructed.getLocalAuthority()).identity).toBeNull();
      expect(managed.provision).not.toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "issuer-a-access",
          gatewayBaseUrl: otherClient.config.modelGatewayUrl,
        }),
      );
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("persists only metadata in SQLite and keeps access/refresh tokens in ServerSecretStore", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-secret",
        refreshToken: "refresh-secret",
        expiresAt: now + 3_600_000,
      }),
    );
    const client = makeClient({ signin });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      const state = yield* service.signIn({
        email: "person@example.com",
        password: "password-123",
      });
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM moss_cloud_account_bindings`;

      expect(state).toMatchObject({
        configured: true,
        authenticated: true,
        modelGatewayConfigured: true,
      });
      expect(JSON.stringify(state)).not.toContain("access-secret");
      expect(JSON.stringify(state)).not.toContain("refresh-secret");
      expect(JSON.stringify(rows)).not.toContain("access-secret");
      expect(JSON.stringify(rows)).not.toContain("refresh-secret");
      expect(Object.keys(rows[0] ?? {})).not.toContain("access_token");
      expect(Object.keys(rows[0] ?? {})).not.toContain("refresh_token");

      const secretEnvelope = [...secrets.values.values()]
        .map((bytes) => decoder.decode(bytes))
        .find((value) => value.includes("access-secret"));
      expect(secretEnvelope).toContain("refresh-secret");
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "access-secret",
          models: [...mossManagedCodexModelsForLane("global")],
          selectionPolicy: "select",
        }),
      );
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("rotates the protected session on refresh and restores it after service reconstruction", async () => {
    let now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({ accessToken: "access-old", refreshToken: "refresh-old", expiresAt: now + 30_000 }),
    );
    const refresh = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe("refresh-old");
      return session({
        accessToken: "access-new",
        refreshToken: "refresh-new",
        expiresAt: now + 3_600_000,
      });
    });
    const client = makeClient({ signin, refresh });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const first = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* first.signIn({ email: "person@example.com", password: "password-123" });
      const refreshed = yield* first.refresh();
      expect(refreshed.session?.expiresAt).toBe(new Date(now + 3_600_000).toISOString());
      expect(managed.provision).toHaveBeenLastCalledWith(
        expect.objectContaining({ selectionPolicy: "preserve" }),
      );

      managed.provision.mockClear();
      managed.getProvisioningState.mockClear();
      now += 1_000;
      const reconstructed = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* reconstructed.restore();

      expect(refresh).toHaveBeenCalledOnce();
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.getProvisioningState).toHaveBeenCalledWith({
        authority: "supabase-google",
        accessToken: "access-new",
        gatewayBaseUrl: client.config.modelGatewayUrl,
      });
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-new");
      expect(stored).toContain("refresh-new");
      expect(stored).not.toContain("access-old");
      expect(stored).not.toContain("refresh-old");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("does not disable the shared Moss provider when no cloud account is selected", async () => {
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient()),
      });
      yield* service.restore();

      expect(managed.disable).not.toHaveBeenCalled();
      expect(managed.provision).not.toHaveBeenCalled();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("selects a different managed identity without disabling the rollback target first", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-first",
          refreshToken: "refresh-first",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-second",
          refreshToken: "refresh-second",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.disable.mockClear();
      managed.provision.mockClear();

      yield* service.signIn({ email: "other@example.com", password: "password-123" });

      expect(managed.disable).not.toHaveBeenCalled();
      expect(managed.provision).toHaveBeenCalledOnce();
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "access-second",
          selectionPolicy: "select",
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      const bindings = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
        ORDER BY account_id
      `;
      expect(bindings).toEqual([
        { accountId: "account-1", selected: 0 },
        { accountId: "account-2", selected: 1 },
      ]);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("fences the previous provider when selecting an account with denied catalog access", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({ accessToken: "access-a", refreshToken: "refresh-a", expiresAt: now + 3_600_000 }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-b",
          refreshToken: "refresh-b",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const fetchGatewayModels = vi
      .fn()
      .mockReturnValueOnce(Effect.succeed({ status: "ready", models: ["gpt-5.5"] } as const))
      .mockReturnValueOnce(Effect.succeed({ status: "ready", models: ["gpt-5.5"] } as const))
      .mockReturnValueOnce(Effect.succeed({ status: "auth-denied", models: [] } as const));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
        fetchGatewayModels,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      yield* service.signIn({ email: "other@example.com", password: "password-123" });
      managed.disable.mockClear();
      const state = yield* service.selectAccount({ accountId: "account-1" });
      expect(state).toMatchObject({ authenticated: true, modelGatewayStatus: "auth-denied" });
      expect(managed.disable).toHaveBeenCalled();
      expect(managed.provision).not.toHaveBeenLastCalledWith(
        expect.objectContaining({ accessToken: "access-a" }),
      );
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("clears Cloud gateway readiness after logout", async () => {
    const now = 1_800_000_000_000;
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();
    const client = makeClient({
      signin: async () =>
        session({ accessToken: "logout-a", refreshToken: "logout-r", expiresAt: now + 3_600_000 }),
      logout: async () => ({ accepted: true }),
    });
    const state = await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      expect((yield* service.getState()).modelGatewayStatus).toBe("ready");
      yield* service.logout();
      return yield* service.getState();
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
    expect(state.authenticated).toBe(false);
    expect(state).not.toHaveProperty("modelGatewayStatus");
  });

  it("lists only renderer-safe account summaries and switches a saved identity without a password", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-list-first",
          refreshToken: "refresh-list-first",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-list-second",
          refreshToken: "refresh-list-second",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-first" });
      yield* service.signIn({ email: "other@example.com", password: "password-second" });

      const before = yield* service.listAccounts();
      expect(before.accounts).toHaveLength(2);
      expect(before.accounts[0]).toMatchObject({
        id: "account-2",
        email: "other@example.com",
        selected: true,
        sessionAvailable: true,
      });
      expect(Object.keys(before.accounts[0] ?? {}).toSorted()).toEqual(
        [
          "displayName",
          "email",
          "emailVerified",
          "id",
          "lastUsedAt",
          "selected",
          "sessionAvailable",
          "status",
        ].toSorted(),
      );
      expect(JSON.stringify(before)).not.toContain("access-list");
      expect(JSON.stringify(before)).not.toContain("refresh-list");
      expect(JSON.stringify(before)).not.toContain("sessionSecretRef");

      managed.provision.mockClear();
      const selected = yield* service.selectAccount({ accountId: "account-1" });

      expect(selected.account?.email).toBe("person@example.com");
      expect(signin).toHaveBeenCalledTimes(2);
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "access-list-first",
          selectionPolicy: "select",
        }),
      );
      expect((yield* service.listAccounts()).accounts).toEqual([
        expect.objectContaining({ id: "account-1", selected: true }),
        expect.objectContaining({ id: "account-2", selected: false }),
      ]);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("refreshes the selected saved identity before switching and provisions its rotated token", async () => {
    let now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-expiring-first",
          refreshToken: "refresh-expiring-first",
          expiresAt: now + 600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-current-second",
          refreshToken: "refresh-current-second",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const refresh = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe("refresh-expiring-first");
      return session({
        accessToken: "access-rotated-first",
        refreshToken: "refresh-rotated-first",
        expiresAt: now + 3_600_000,
      });
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, refresh })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-first" });
      yield* service.signIn({ email: "other@example.com", password: "password-second" });
      now += 5 * 60_000 + 1;
      managed.provision.mockClear();

      const selected = yield* service.selectAccount({ accountId: "account-1" });

      expect(refresh).toHaveBeenCalledOnce();
      expect(selected.account?.id).toBe("account-1");
      expect(selected.session?.expiresAt).toBe(new Date(now + 3_600_000).toISOString());
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({
          accessToken: "access-rotated-first",
          selectionPolicy: "select",
        }),
      );
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-rotated-first");
      expect(stored).not.toContain("access-expiring-first");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("removes identities, falls back to another live account, then returns signed out after the last removal", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-remove-first",
          refreshToken: "refresh-remove-first",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-remove-second",
          refreshToken: "refresh-remove-second",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, logout })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-first" });
      yield* service.signIn({ email: "other@example.com", password: "password-second" });
      managed.provision.mockClear();

      const afterSecondRemoval = yield* service.removeAccount({ accountId: "account-2" });

      expect(afterSecondRemoval.state).toMatchObject({ authenticated: true });
      expect(afterSecondRemoval.state.account?.id).toBe("account-1");
      expect(afterSecondRemoval.accounts).toEqual([
        expect.objectContaining({ id: "account-1", selected: true, sessionAvailable: true }),
      ]);
      expect(managed.provision).toHaveBeenCalledWith(
        expect.objectContaining({ accessToken: "access-remove-first", selectionPolicy: "select" }),
      );
      expect(logout).toHaveBeenCalledWith("access-remove-second");

      managed.disable.mockClear();
      const afterLastRemoval = yield* service.removeAccount({ accountId: "account-1" });

      expect(afterLastRemoval).toMatchObject({
        state: { authenticated: false, account: null, session: null },
        accounts: [],
      });
      expect(managed.disable).toHaveBeenCalledOnce();
      expect(logout).toHaveBeenCalledWith("access-remove-first");
      expect(
        [...secrets.values.keys()].some((name) => name.startsWith("moss.cloud.session.")),
      ).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM moss_cloud_account_bindings`;
      expect(rows).toEqual([]);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("keeps the old account, session, and provider intact when a cross-account DB write fails", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-old-account",
          refreshToken: "refresh-old-account",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-new-account",
          refreshToken: "refresh-new-account",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.provision.mockClear();
      managed.disable.mockClear();

      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TRIGGER reject_cross_account_update
        BEFORE UPDATE ON moss_cloud_account_bindings
        BEGIN
          SELECT RAISE(FAIL, 'injected cross-account failure');
        END
      `;
      const failure = yield* service
        .signIn({ email: "other@example.com", password: "password-123" })
        .pipe(Effect.flip);
      yield* sql`DROP TRIGGER reject_cross_account_update`;

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).not.toHaveBeenCalled();
      const rows = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
      `;
      expect(rows).toEqual([{ accountId: "account-1", selected: 1 }]);
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-old-account");
      expect(stored).not.toContain("access-new-account");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("restores the old account, session, and provider when new provider provisioning fails", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-provider-old",
          refreshToken: "refresh-provider-old",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-provider-new",
          refreshToken: "refresh-provider-new",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.provision.mockClear();
      managed.provision.mockImplementationOnce(() =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "persistence_failed",
            message: "injected provider failure",
          }),
        ),
      );

      const failure = yield* service
        .signIn({ email: "other@example.com", password: "password-123" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.provision).toHaveBeenCalledTimes(2);
      expect(managed.provision).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({ accessToken: "access-provider-new" }),
      );
      expect(managed.provision).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          accessToken: "access-provider-old",
          selectionPolicy: "select",
        }),
      );
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
        ORDER BY account_id
      `;
      expect(rows).toEqual([{ accountId: "account-1", selected: 1 }]);
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-provider-old");
      expect(stored).not.toContain("access-provider-new");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("does not disturb the old account or provider when protecting the new session fails", async () => {
    const now = 1_800_000_000_000;
    const secondUser = { ...user, id: "account-2", email: "other@example.com" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-secret-old",
          refreshToken: "refresh-secret-old",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-secret-new",
          refreshToken: "refresh-secret-new",
          expiresAt: now + 3_600_000,
        }),
        user: secondUser,
      });
    const secrets = makeSecretStore();
    const failingSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      set: (name, value) =>
        decoder.decode(value).includes("access-secret-new")
          ? Effect.fail(new SecretStoreError({ message: "injected secret write failure" }))
          : secrets.service.set(name, value),
    };
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.provision.mockClear();
      managed.disable.mockClear();

      const failure = yield* service
        .signIn({ email: "other@example.com", password: "password-123" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).not.toHaveBeenCalled();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
      `;
      expect(rows).toEqual([{ accountId: "account-1", selected: 1 }]);
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-secret-old");
      expect(stored).not.toContain("access-secret-new");
    }).pipe(Effect.provide(makeLayer(failingSecretStore, managed.service)), Effect.runPromise);
  });

  it("replaces an authenticated stale same-email UUID and removes its orphaned session", async () => {
    const now = 1_800_000_000_000;
    const recreatedUser = { ...user, id: "account-2" };
    const signin = vi
      .fn<SupabaseMossAuthClient["signin"]>()
      .mockResolvedValueOnce(
        session({
          accessToken: "access-stale-uuid",
          refreshToken: "refresh-stale-uuid",
          expiresAt: now + 3_600_000,
        }),
      )
      .mockResolvedValueOnce({
        ...session({
          accessToken: "access-recreated-uuid",
          refreshToken: "refresh-recreated-uuid",
          expiresAt: now + 3_600_000,
        }),
        user: recreatedUser,
      });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });

      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
      `;
      expect(rows).toEqual([{ accountId: "account-2", selected: 1 }]);
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-recreated-uuid");
      expect(stored).not.toContain("access-stale-uuid");
      expect(stored).not.toContain("refresh-stale-uuid");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("uses a protected S256 verifier for recovery and clears it after successful exchange", async () => {
    const now = 1_800_000_000_000;
    let verifierFromSecret = "";
    const recover = vi.fn(async (_email: string, challenge: { readonly codeChallenge: string }) => {
      expect(challenge.codeChallenge).not.toBe("");
      return { accepted: true as const };
    });
    const exchangeCode = vi.fn(async (_code: string, verifier: string) => {
      verifierFromSecret = verifier;
      return session({
        accessToken: "access-exchanged",
        refreshToken: "refresh-exchanged",
        expiresAt: now + 3_600_000,
      });
    });
    const client = makeClient({ recover, exchangeCode });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.requestPasswordReset({ email: "person@example.com" });
      const pkceEntry = [...secrets.values.entries()].find(([name]) => name.includes("pkce"));
      expect(pkceEntry).toBeDefined();
      expect(decoder.decode(pkceEntry?.[1])).not.toContain("access-exchanged");

      const exchanged = yield* service.exchangeCode({ code: "callback-code" });

      expect(verifierFromSecret.length).toBeGreaterThanOrEqual(43);
      expect(exchanged.lastAuthFlow).toBe("recovery");
      expect([...secrets.values.keys()].some((name) => name.includes("pkce"))).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<Record<string, unknown>>`SELECT * FROM moss_cloud_account_bindings`;
      expect(JSON.stringify(rows)).not.toContain(verifierFromSecret);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("returns the same successful callback state for an immediate duplicate code without reusing PKCE", async () => {
    const now = 1_800_000_000_000;
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi.fn(async () =>
      session({
        accessToken: "access-idempotent-callback",
        refreshToken: "refresh-idempotent-callback",
        expiresAt: now + 3_600_000,
      }),
    );
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ recover, exchangeCode })),
        now: () => now,
      });
      yield* service.requestPasswordReset({ email: "person@example.com" });

      const first = yield* service.exchangeCode({ code: "one-time-callback-code" });
      const duplicate = yield* service.exchangeCode({ code: "one-time-callback-code" });

      expect(exchangeCode).toHaveBeenCalledOnce();
      expect(duplicate).toEqual(first);
      expect(duplicate.lastAuthFlow).toBe("recovery");
      expect(JSON.stringify(duplicate)).not.toContain("one-time-callback-code");
      expect([...secrets.values.keys()].some((name) => name.includes("pkce"))).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("never resurrects a signed-out session from the successful callback cache", async () => {
    const now = 1_800_000_000_000;
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi.fn(async () =>
      session({
        accessToken: "access-cache-logout",
        refreshToken: "refresh-cache-logout",
        expiresAt: now + 3_600_000,
      }),
    );
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ recover, exchangeCode, logout })),
        now: () => now,
      });
      yield* service.requestPasswordReset({ email: "person@example.com" });
      yield* service.exchangeCode({ code: "used-callback-code" });
      yield* service.logout();

      const failure = yield* service.exchangeCode({ code: "used-callback-code" }).pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "session_expired" });
      expect(exchangeCode).toHaveBeenCalledOnce();
      expect((yield* service.getState()).authenticated).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("keeps signup and recovery PKCE flows isolated and consumes only the matching verifier", async () => {
    let now = 1_800_000_000_000;
    let signupVerifier = "";
    const signup = vi.fn(async () => ({
      user,
      session: null,
      confirmationRequired: true,
    }));
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi.fn(async (_code: string, verifier: string) => {
      if (verifier !== signupVerifier) {
        throw new SupabaseMossAuthError({
          operation: "exchange_code",
          code: "bad_code_verifier",
          status: 400,
          retryable: false,
          message: "The authentication request was rejected.",
        });
      }
      return session({
        accessToken: "access-signup-callback",
        refreshToken: "refresh-signup-callback",
        expiresAt: now + 3_600_000,
      });
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signup, recover, exchangeCode })),
        now: () => now,
      });
      yield* service.signUp({ email: "person@example.com", password: "password-123" });
      const signupEntry = [...secrets.values.entries()].find(([name]) => name.endsWith(".signup"));
      expect(signupEntry).toBeDefined();
      signupVerifier = (JSON.parse(decoder.decode(signupEntry?.[1])) as { verifier: string })
        .verifier;

      now += 1;
      yield* service.requestPasswordReset({ email: "person@example.com" });
      expect([...secrets.values.keys()].filter((name) => name.includes("moss.cloud.pkce"))).toEqual(
        ["moss.cloud.pkce.signup", "moss.cloud.pkce.recovery"],
      );

      const state = yield* service.exchangeCode({ code: "signup-callback-code" });

      expect(exchangeCode).toHaveBeenCalledTimes(2);
      expect(state.lastAuthFlow).toBe("signup");
      expect(secrets.values.has("moss.cloud.pkce.signup")).toBe(false);
      expect(secrets.values.has("moss.cloud.pkce.recovery")).toBe(true);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("preserves a PKCE verifier across retryable exchange failures", async () => {
    const now = 1_800_000_000_000;
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi
      .fn<SupabaseMossAuthClient["exchangeCode"]>()
      .mockRejectedValueOnce(
        new SupabaseMossAuthError({
          operation: "exchange_code",
          code: "network_error",
          status: null,
          retryable: true,
          message: "The authentication service could not be reached.",
        }),
      )
      .mockResolvedValueOnce(
        session({
          accessToken: "access-after-retry",
          refreshToken: "refresh-after-retry",
          expiresAt: now + 3_600_000,
        }),
      );
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ recover, exchangeCode })),
        now: () => now,
      });
      yield* service.requestPasswordReset({ email: "person@example.com" });
      const before = decoder.decode(secrets.values.get("moss.cloud.pkce.recovery"));

      const failure = yield* service.exchangeCode({ code: "callback-code" }).pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "network_error" });
      expect(decoder.decode(secrets.values.get("moss.cloud.pkce.recovery"))).toBe(before);

      const state = yield* service.exchangeCode({ code: "callback-code" });
      expect(state.lastAuthFlow).toBe("recovery");
      expect(secrets.values.has("moss.cloud.pkce.recovery")).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("preserves signup PKCE when the signup request has a retryable network failure", async () => {
    const signup = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "signup",
        code: "network_error",
        status: null,
        retryable: true,
        message: "The authentication service could not be reached.",
      });
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signup })),
      });
      const failure = yield* service
        .signUp({ email: "person@example.com", password: "password-123" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "network_error" });
      expect(secrets.values.has("moss.cloud.pkce.signup")).toBe(true);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("preserves recovery PKCE when the recovery request has a retryable network failure", async () => {
    const recover = vi.fn(async () => {
      throw new SupabaseMossAuthError({
        operation: "recover",
        code: "network_error",
        status: null,
        retryable: true,
        message: "The authentication service could not be reached.",
      });
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ recover })),
      });
      const failure = yield* service
        .requestPasswordReset({ email: "person@example.com" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "network_error" });
      expect(secrets.values.has("moss.cloud.pkce.recovery")).toBe(true);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("persists recovery authorization across service reconstruction and refresh, then consumes it", async () => {
    let now = 1_800_000_000_000;
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi.fn(async () =>
      session({
        accessToken: "access-recovery",
        refreshToken: "refresh-recovery",
        expiresAt: now + 60_000,
      }),
    );
    const refresh = vi.fn(async (refreshToken: string) => {
      expect(refreshToken).toBe("refresh-recovery");
      return session({
        accessToken: "access-recovery-refreshed",
        refreshToken: "refresh-recovery-refreshed",
        expiresAt: now + 3_600_000,
      });
    });
    const updatePassword = vi.fn(async () => user);
    const client = makeClient({ recover, exchangeCode, refresh, updatePassword });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const first = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* first.requestPasswordReset({ email: "person@example.com" });
      const exchanged = yield* first.exchangeCode({ code: "recovery-code" });
      expect(exchanged.lastAuthFlow).toBe("recovery");

      now += 1_000;
      const reconstructed = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      const restored = yield* reconstructed.getState();
      expect(refresh).toHaveBeenCalledOnce();
      expect(restored.lastAuthFlow).toBe("recovery");
      expect(restored.session?.expiresAt).toBe(new Date(now + 3_600_000).toISOString());

      yield* reconstructed.updatePassword({ password: "replacement-password" });
      expect(updatePassword).toHaveBeenCalledWith(
        "access-recovery-refreshed",
        "replacement-password",
      );
      expect((yield* reconstructed.getState()).lastAuthFlow).toBeNull();
      const stored = [...secrets.values.entries()]
        .filter(([name]) => name.startsWith("moss.cloud.session."))
        .map(([, bytes]) => decoder.decode(bytes))
        .join("\n");
      expect(stored).not.toContain("recoveryAuthorizedUntil");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("rejects password updates without a live recovery authorization", async () => {
    let now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-normal-signin",
        refreshToken: "refresh-normal-signin",
        expiresAt: now + 3_600_000,
      }),
    );
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi.fn(async () =>
      session({
        accessToken: "access-recovery-expiring",
        refreshToken: "refresh-recovery-expiring",
        expiresAt: now + 3_600_000,
      }),
    );
    const updatePassword = vi.fn(async () => user);
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, recover, exchangeCode, updatePassword })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const unauthorized = yield* service
        .updatePassword({ password: "replacement-password" })
        .pipe(Effect.flip);
      expect(unauthorized).toMatchObject({ code: "session_expired" });
      expect(updatePassword).not.toHaveBeenCalled();

      yield* service.requestPasswordReset({ email: "person@example.com" });
      yield* service.exchangeCode({ code: "recovery-code" });
      now += 15 * 60_000 + 1;
      expect((yield* service.getState()).lastAuthFlow).toBeNull();
      const expired = yield* service
        .updatePassword({ password: "replacement-password" })
        .pipe(Effect.flip);
      expect(expired).toMatchObject({ code: "session_expired" });
      expect(updatePassword).not.toHaveBeenCalled();
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).not.toContain("recoveryAuthorizedUntil");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("retains PKCE after an unsolicited invalid callback and clears it only on success or expiry", async () => {
    let now = 1_800_000_000_000;
    const recover = vi.fn(async () => ({ accepted: true as const }));
    const exchangeCode = vi
      .fn<SupabaseMossAuthClient["exchangeCode"]>()
      .mockRejectedValueOnce(
        new SupabaseMossAuthError({
          operation: "exchange_code",
          code: "bad_code_verifier",
          status: 400,
          retryable: false,
          message: "The authentication request was rejected.",
        }),
      )
      .mockResolvedValueOnce(
        session({
          accessToken: "access-real-callback",
          refreshToken: "refresh-real-callback",
          expiresAt: now + 3_600_000,
        }),
      );
    const client = makeClient({ recover, exchangeCode });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.requestPasswordReset({ email: "person@example.com" });
      const firstPkce = [...secrets.values.values()]
        .map((bytes) => decoder.decode(bytes))
        .find((value) => value.includes('"flow":"recovery"'))!;
      const firstVerifier = (JSON.parse(firstPkce) as { verifier: string }).verifier;
      const failure = yield* service.exchangeCode({ code: "bad-code" }).pipe(Effect.flip);
      expect(failure).toBeInstanceOf(MossCloudAccountServiceError);
      expect(`${failure.message} ${JSON.stringify(failure)}`).not.toContain(firstVerifier);
      expect(secrets.values.has("moss.cloud.pkce.recovery")).toBe(true);

      const recovered = yield* service.exchangeCode({ code: "real-code" });
      expect(recovered.lastAuthFlow).toBe("recovery");
      expect(secrets.values.has("moss.cloud.pkce.recovery")).toBe(false);

      yield* service.requestPasswordReset({ email: "person@example.com" });
      now += 60 * 60 * 1_000 + 1;
      const expired = yield* service.exchangeCode({ code: "expired-code" }).pipe(Effect.flip);
      expect(expired).toMatchObject({ code: "session_expired" });
      expect([...secrets.values.keys()].some((name) => name.includes("pkce"))).toBe(false);
      expect(exchangeCode).toHaveBeenCalledTimes(2);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("clears the selected local session and fences a persisted pending provider receipt on logout", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-logout",
        refreshToken: "refresh-logout",
        expiresAt: now + 3_600_000,
      }),
    );
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const client = makeClient({ signin, logout });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const receiptBytes = secrets.values.get("moss.managed.binding");
      expect(receiptBytes).toBeDefined();
      const receipt = JSON.parse(decoder.decode(receiptBytes ?? new Uint8Array())) as Record<
        string,
        unknown
      >;
      secrets.values.set(
        "moss.managed.binding",
        encoder.encode(JSON.stringify({ ...receipt, state: "pending" })),
      );
      managed.disable.mockClear();
      const result = yield* service.logout();
      expect(result.revoked).toBe(true);
      expect(logout).toHaveBeenCalledWith("access-logout");
      expect(managed.disable).toHaveBeenCalledOnce();
      expect(managed.disable.mock.calls[0]).toEqual([
        { cleanupFallbackAccessToken: "access-logout" },
      ]);
      expect(secrets.values.has("moss.managed.binding")).toBe(false);
      expect(
        [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n"),
      ).not.toContain("access-logout");
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("force-fences an older same-realm provider receipt after a newer Cloud session was persisted", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "older-provider-access",
        refreshToken: "older-provider-refresh",
        expiresAt: now + 3_600_000,
      }),
    );
    const logout = vi.fn(async () => ({ accepted: true as const }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, logout })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const sessionEntry = [...secrets.values.entries()].find(([name]) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(sessionEntry).toBeDefined();
      const persisted = JSON.parse(decoder.decode(sessionEntry?.[1] ?? new Uint8Array())) as Record<
        string,
        unknown
      >;
      secrets.values.set(
        sessionEntry?.[0] ?? "missing-session",
        encoder.encode(
          JSON.stringify({
            ...persisted,
            accessToken: "newer-session-access",
            refreshToken: "newer-session-refresh",
          }),
        ),
      );
      managed.disable.mockClear();

      const result = yield* service.logout();

      expect(result.revoked).toBe(true);
      expect(logout).toHaveBeenCalledWith("newer-session-access");
      expect(managed.disable).toHaveBeenCalledOnce();
      expect(managed.disable.mock.calls[0]).toEqual([
        { cleanupFallbackAccessToken: "newer-session-access" },
      ]);
      expect(secrets.values.has("moss.managed.binding")).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("retains a rotated same-account session when SQLite metadata persistence fails", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-before-db-failure",
        refreshToken: "refresh-before-db-failure",
        expiresAt: now + 3_600_000,
      }),
    );
    const refresh = vi.fn(async () =>
      session({
        accessToken: "access-after-db-failure",
        refreshToken: "refresh-after-db-failure",
        expiresAt: now + 7_200_000,
      }),
    );
    const client = makeClient({ signin, refresh });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const secretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(secretName).toBeDefined();
      const sql = yield* SqlClient.SqlClient;
      yield* sql`
        CREATE TRIGGER reject_moss_binding_update
        BEFORE UPDATE ON moss_cloud_account_bindings
        BEGIN
          SELECT RAISE(FAIL, 'injected metadata failure');
        END
      `;
      const failure = yield* service.refresh().pipe(Effect.flip);
      yield* sql`DROP TRIGGER reject_moss_binding_update`;

      expect(failure).toMatchObject({ code: "persistence_failed" });
      const rotatedSecret = decoder.decode(secrets.values.get(secretName!));
      expect(rotatedSecret).toContain("access-after-db-failure");
      expect(rotatedSecret).toContain("refresh-after-db-failure");
      expect(rotatedSecret).not.toContain("refresh-before-db-failure");

      const reconstructed = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      expect(yield* reconstructed.getGatewayAccessToken()).toBe("access-after-db-failure");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("reconciles a failed refresh provision with the rotated token and preserve semantics", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-before-provision-failure",
        refreshToken: "refresh-before-provision-failure",
        expiresAt: now + 3_600_000,
      }),
    );
    const refresh = vi.fn(async () =>
      session({
        accessToken: "access-after-provision-failure",
        refreshToken: "refresh-after-provision-failure",
        expiresAt: now + 7_200_000,
      }),
    );
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, refresh })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.provision.mockClear();
      managed.provision.mockImplementationOnce(() =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "persistence_failed",
            message: "injected refresh provision failure",
          }),
        ),
      );

      const failure = yield* service.refresh().pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.provision).toHaveBeenCalledTimes(2);
      expect(managed.provision).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          accessToken: "access-after-provision-failure",
          selectionPolicy: "preserve",
        }),
      );
      expect(yield* service.getGatewayAccessToken()).toBe("access-after-provision-failure");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("repairs a durable provider marker after refresh provision and compensation both fail", async () => {
    const now = 1_800_000_000_000;
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-before-double-failure",
        refreshToken: "refresh-before-double-failure",
        expiresAt: now + 3_600_000,
      }),
    );
    const refresh = vi.fn(async () =>
      session({
        accessToken: "access-after-double-failure",
        refreshToken: "refresh-after-double-failure",
        expiresAt: now + 7_200_000,
      }),
    );
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, refresh })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const secretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(secretName).toBeDefined();
      managed.provision.mockClear();
      managed.provision
        .mockImplementationOnce(() =>
          Effect.fail(
            new MossCloudAccountServiceError({
              code: "persistence_failed",
              message: "injected refresh provision failure",
            }),
          ),
        )
        .mockImplementationOnce(() =>
          Effect.fail(
            new MossCloudAccountServiceError({
              code: "persistence_failed",
              message: "injected refresh compensation failure",
            }),
          ),
        );

      const failure = yield* service.refresh().pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.provision).toHaveBeenCalledTimes(2);
      const pending = JSON.parse(decoder.decode(secrets.values.get(secretName!))) as Record<
        string,
        unknown
      >;
      expect(pending).toMatchObject({
        accessToken: "access-after-double-failure",
        refreshToken: "refresh-after-double-failure",
        needsProviderReconcile: true,
      });

      const repaired = yield* service.getState();

      expect(repaired.authenticated).toBe(true);
      expect(managed.provision).toHaveBeenCalledTimes(3);
      expect(managed.provision).toHaveBeenNthCalledWith(
        3,
        expect.objectContaining({
          accessToken: "access-after-double-failure",
          selectionPolicy: "preserve",
        }),
      );
      const reconciled = JSON.parse(decoder.decode(secrets.values.get(secretName!))) as Record<
        string,
        unknown
      >;
      expect(reconciled).toMatchObject({
        accessToken: "access-after-double-failure",
        refreshToken: "refresh-after-double-failure",
      });
      expect(reconciled).not.toHaveProperty("needsProviderReconcile");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("returns the authenticated account when provider reconciliation fails and keeps a retry marker", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-provider-error",
          refreshToken: "refresh-provider-error",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const secretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(secretName).toBeDefined();

      managed.getProvisioningState.mockReturnValueOnce(Effect.succeed("stale"));
      managed.provision.mockImplementationOnce(() =>
        Effect.fail(
          new MossCloudAccountServiceError({
            code: "provider_error",
            message: "injected gateway reconciliation failure",
          }),
        ),
      );

      const state = yield* service.getState();
      expect(state.authenticated).toBe(true);
      expect(state.account?.id).toBe("account-1");
      expect(JSON.parse(decoder.decode(secrets.values.get(secretName!)))).toMatchObject({
        accessToken: "access-provider-error",
        needsProviderReconcile: true,
      });
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("bounds a stalled provider reconciliation without blocking account state", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-provider-timeout",
          refreshToken: "refresh-provider-timeout",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
        providerReconcileTimeoutMs: 10,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const secretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(secretName).toBeDefined();
      managed.getProvisioningState.mockReturnValue(Effect.succeed("stale"));
      managed.provision.mockImplementation(() => Effect.never);
      const startedAt = Date.now();
      const state = yield* service.getState().pipe(Effect.timeout("1 second"));

      expect(Date.now() - startedAt).toBeLessThan(900);
      expect(state.authenticated).toBe(true);
      expect(JSON.parse(decoder.decode(secrets.values.get(secretName!)))).toMatchObject({
        accessToken: "access-provider-timeout",
      });
      // The timeout fallback is deliberately read-only. A stale snapshot
      // must never write a retry marker after a concurrent refresh/sign-in
      // has replaced this session.
      expect(JSON.parse(decoder.decode(secrets.values.get(secretName!)))).not.toHaveProperty(
        "needsProviderReconcile",
      );
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("returns a local account snapshot when restore holds the serializer on a stalled provider", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-restore-stall",
          refreshToken: "refresh-restore-stall",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
        providerReconcileTimeoutMs: 10,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });

      const providerEntered = yield* Deferred.make<void>();
      managed.getProvisioningState.mockReturnValue(Effect.succeed("stale"));
      managed.provision.mockImplementation(() =>
        Deferred.succeed(providerEntered, undefined).pipe(Effect.andThen(Effect.never)),
      );
      const restoreFiber = yield* service.restore().pipe(Effect.forkChild);
      yield* Deferred.await(providerEntered).pipe(Effect.timeout("1 second"));

      const state = yield* service.getState().pipe(Effect.timeout("1 second"));
      expect(state.authenticated).toBe(true);
      expect(state.account?.id).toBe("account-1");

      yield* Fiber.interrupt(restoreFiber);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("disables the managed provider even when protected-session cleanup fails", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-cleanup-failure",
          refreshToken: "refresh-cleanup-failure",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const failingSecretStore: ServerSecretStoreShape = {
      ...secrets.service,
      remove: (name) =>
        name.startsWith("moss.cloud.session.")
          ? Effect.fail(new SecretStoreError({ message: "injected session cleanup failure" }))
          : secrets.service.remove(name),
    };
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.disable.mockClear();

      const failure = yield* service.logout().pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.disable).toHaveBeenCalledOnce();
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(failingSecretStore, managed.service)), Effect.runPromise);
  });

  it("fails closed when the protected session is corrupt", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-corrupt",
          refreshToken: "refresh-corrupt",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const sessionSecretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(sessionSecretName).toBeDefined();
      secrets.values.set(sessionSecretName!, encoder.encode("{corrupt-session"));
      managed.disable.mockClear();

      const failure = yield* service.restore().pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.disable).toHaveBeenCalledOnce();
      expect(secrets.values.has(sessionSecretName!)).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("clears a verified binding when its protected session is missing", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-missing",
          refreshToken: "refresh-missing",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      const sessionSecretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(sessionSecretName).toBeDefined();
      secrets.values.delete(sessionSecretName!);
      managed.disable.mockClear();

      yield* service.restore();

      expect(managed.disable).toHaveBeenCalledOnce();
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("fails closed when refresh returns a different account identity", async () => {
    const now = 1_800_000_000_000;
    const client = makeClient({
      signin: async () =>
        session({
          accessToken: "access-original",
          refreshToken: "refresh-original",
          expiresAt: now + 3_600_000,
        }),
      refresh: async () => ({
        ...session({
          accessToken: "access-mismatch",
          refreshToken: "refresh-mismatch",
          expiresAt: now + 3_600_000,
        }),
        user: { ...user, id: "account-2", email: "other@example.com" },
      }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.disable.mockClear();

      const failure = yield* service.refresh().pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "provider_error" });
      expect(managed.disable).toHaveBeenCalledOnce();
      expect(
        [...secrets.values.keys()].some((name) => name.startsWith("moss.cloud.session.")),
      ).toBe(false);
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings WHERE selected = 1
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("does not trust or persist a no-session signup identity before callback exchange", async () => {
    const pendingUser = { ...user, id: "pending-account", emailConfirmedAt: null };
    const signup = vi.fn(async () => ({
      user: pendingUser,
      session: null,
      confirmationRequired: true,
    }));
    const client = makeClient({ signup });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({ auth: availableAuth(client) });
      const result = yield* service.signUp({
        email: "person@example.com",
        password: "password-123",
        displayName: "Moss Person",
      });
      const state = yield* service.getState();

      expect(state).toMatchObject({
        authenticated: false,
        emailVerificationRequired: false,
        account: null,
      });
      expect(result.verificationRequired).toBe(true);
      expect(signup).toHaveBeenCalledWith(
        "person@example.com",
        "password-123",
        expect.objectContaining({ codeChallengeMethod: "s256" }),
        "Moss Person",
      );
      expect(managed.disable).not.toHaveBeenCalled();
      const sql = yield* SqlClient.SqlClient;
      const selected = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings
      `;
      expect(Number(selected[0]?.count ?? 0)).toBe(0);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("preserves an authenticated local account when duplicate signup returns an obfuscated user", async () => {
    const now = 1_800_000_000_000;
    const fakeUser = { ...user, id: "obfuscated-user", emailConfirmedAt: null };
    const signin = vi.fn(async () =>
      session({
        accessToken: "access-real-local-user",
        refreshToken: "refresh-real-local-user",
        expiresAt: now + 3_600_000,
      }),
    );
    const signup = vi.fn(async () => ({
      user: fakeUser,
      session: null,
      confirmationRequired: true,
    }));
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(makeClient({ signin, signup })),
        now: () => now,
      });
      yield* service.signIn({ email: "person@example.com", password: "password-123" });
      managed.provision.mockClear();
      managed.disable.mockClear();

      const result = yield* service.signUp({
        email: "person@example.com",
        password: "password-123",
      });

      expect(result.verificationRequired).toBe(true);
      expect(result.state).toMatchObject({
        authenticated: true,
        account: { id: "account-1" },
      });
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).not.toHaveBeenCalled();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly accountId: string; readonly selected: number }>`
        SELECT account_id AS "accountId", selected AS "selected"
        FROM moss_cloud_account_bindings
      `;
      expect(rows).toEqual([{ accountId: "account-1", selected: 1 }]);
      const stored = [...secrets.values.values()].map((bytes) => decoder.decode(bytes)).join("\n");
      expect(stored).toContain("access-real-local-user");
      expect(stored).not.toContain("obfuscated-user");
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("disables a stale managed provider when a successful session has no model gateway", async () => {
    const now = 1_800_000_000_000;
    const baseClient = makeClient();
    const client = makeClient({
      config: { ...baseClient.config, modelGatewayUrl: null },
      signin: async () =>
        session({
          accessToken: "access-without-gateway",
          refreshToken: "refresh-without-gateway",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();
    managed.needsDisable.mockReturnValue(Effect.succeed(true));

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      const state = yield* service.signIn({
        email: "person@example.com",
        password: "password-123",
      });

      expect(state.authenticated).toBe(true);
      expect(state.modelGatewayConfigured).toBe(false);
      expect(managed.provision).not.toHaveBeenCalled();
      expect(managed.disable).toHaveBeenCalledOnce();

      const secretName = [...secrets.values.keys()].find((name) =>
        name.startsWith("moss.cloud.session."),
      );
      expect(secretName).toBeDefined();
      expect(JSON.parse(decoder.decode(secrets.values.get(secretName!)))).toMatchObject({
        needsProviderReconcile: true,
      });

      const recovered = yield* makeMossCloudAccountService({
        auth: availableAuth(baseClient),
        now: () => now,
      });
      const recoveredState = yield* recovered.getState();
      expect(recoveredState.authenticated).toBe(true);
      expect(managed.provision).toHaveBeenCalledOnce();
      expect(JSON.parse(decoder.decode(secrets.values.get(secretName!)))).not.toHaveProperty(
        "needsProviderReconcile",
      );
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("rolls back account persistence when stale-provider disable fails without a gateway", async () => {
    const now = 1_800_000_000_000;
    const baseClient = makeClient();
    const client = makeClient({
      config: { ...baseClient.config, modelGatewayUrl: null },
      signin: async () =>
        session({
          accessToken: "access-disable-failure",
          refreshToken: "refresh-disable-failure",
          expiresAt: now + 3_600_000,
        }),
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();
    managed.needsDisable.mockReturnValue(Effect.succeed(true));
    managed.disable.mockImplementationOnce(() =>
      Effect.fail(
        new MossCloudAccountServiceError({
          code: "persistence_failed",
          message: "injected provider disable failure",
        }),
      ),
    );

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({
        auth: availableAuth(client),
        now: () => now,
      });
      const failure = yield* service
        .signIn({ email: "person@example.com", password: "password-123" })
        .pipe(Effect.flip);

      expect(failure).toMatchObject({ code: "persistence_failed" });
      expect(managed.disable).toHaveBeenCalledOnce();
      const sql = yield* SqlClient.SqlClient;
      const rows = yield* sql<{ readonly count: number }>`
        SELECT COUNT(*) AS "count" FROM moss_cloud_account_bindings
      `;
      expect(Number(rows[0]?.count ?? 0)).toBe(0);
      expect(
        [...secrets.values.keys()].some((name) => name.startsWith("moss.cloud.session.")),
      ).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });

  it("requires a callback URL before creating signup or recovery PKCE state", async () => {
    const signup = vi.fn<SupabaseMossAuthClient["signup"]>();
    const recover = vi.fn<SupabaseMossAuthClient["recover"]>();
    const baseClient = makeClient();
    const client = makeClient({
      config: { ...baseClient.config, redirectUrl: null },
      signup,
      recover,
    });
    const secrets = makeSecretStore();
    const managed = makeManagedProvider();

    await Effect.gen(function* () {
      const service = yield* makeMossCloudAccountService({ auth: availableAuth(client) });
      const signupFailure = yield* service
        .signUp({ email: "person@example.com", password: "password-123" })
        .pipe(Effect.flip);
      const recoveryFailure = yield* service
        .requestPasswordReset({ email: "person@example.com" })
        .pipe(Effect.flip);

      expect(signupFailure).toMatchObject({ code: "not_configured" });
      expect(recoveryFailure).toMatchObject({ code: "not_configured" });
      expect(signup).not.toHaveBeenCalled();
      expect(recover).not.toHaveBeenCalled();
      expect([...secrets.values.keys()].some((name) => name.includes("pkce"))).toBe(false);
    }).pipe(Effect.provide(makeLayer(secrets.service, managed.service)), Effect.runPromise);
  });
});
