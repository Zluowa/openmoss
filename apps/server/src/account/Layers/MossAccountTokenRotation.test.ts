// Real managed provider, real phone account service, fake auth and provider
// runtimes: what a signed-in person's running chat sees when the hourly access
// token rotates or when they sign out with a chat still open.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@moss/contracts";
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
import type { MemFirePhoneAuthAvailable, SupabaseMossAuthSession } from "../supabaseMossAuth";
import {
  MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
  MOSS_MANAGED_PROVIDER_ENV_KEY,
  MOSS_MANAGED_PROVIDER_INSTANCE_ID,
  MossManagedProviderLive,
  mossManagedCodexModelsForLane,
} from "./MossManagedProvider";
import { makeMossPhoneAccountService } from "./MossPhoneAccountService";

const GATEWAY_URL = "https://moss.example.cn/functions/v1/moss-model-gateway/v1";
const PHONE = "+8613800138000";
const ISSUED_AT = 1_800_000_000_000;
const HOUR = 3_600_000;

/** A bearer shaped like the real one: the running-turn wait reads its `exp`. */
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

type FakeSession = {
  readonly provider: "codex" | "claudeAgent";
  readonly providerInstanceId: string;
  readonly status: "ready" | "running";
  readonly threadId: ThreadId;
};

const toProviderSession = (session: FakeSession) => ({
  ...session,
  runtimeMode: "full-access" as const,
  createdAt: "2026-11-01T00:00:00.000Z",
  updatedAt: "2026-11-01T00:00:00.000Z",
});

const makeProviderRuntimes = () => {
  let sessions: FakeSession[] = [];
  const stopCodexAccountRuntimes = vi.fn(
    (): Effect.Effect<void, unknown> =>
      Effect.sync(() => {
        sessions = sessions.filter((session) => session.provider !== "codex");
      }),
  );
  const stopRuntimeSession = vi.fn((input: { readonly threadId: ThreadId }) =>
    Effect.sync(() => {
      sessions = sessions.filter((session) => session.threadId !== input.threadId);
    }),
  );
  const service = {
    listSessions: () => Effect.sync(() => sessions.map(toProviderSession)),
    getRuntimeSessionStopTarget: (input: { readonly threadId: ThreadId }) =>
      Effect.sync(() => {
        const session = sessions.find((candidate) => candidate.threadId === input.threadId);
        return {
          session: session ? toProviderSession(session) : null,
          lifecycleGeneration: "generation-1",
        };
      }),
    fenceProviderInstanceLaunchesAndWait: () => Effect.void,
    stopRuntimeSession,
    stopSession: () => Effect.void,
    stopCodexAccountRuntimes,
  } as unknown as ProviderServiceShape;
  return {
    service,
    stopCodexAccountRuntimes,
    stopRuntimeSession,
    setSessions: (next: FakeSession[]) => {
      sessions = next;
    },
  };
};

const makeHarnessLayer = (
  providerService: ProviderServiceShape,
  secretStore: ServerSecretStoreShape,
  baseDir: string,
) => {
  const serverConfigLayer = ServerConfig.layerTest(process.cwd(), baseDir).pipe(
    Layer.provide(NodeServices.layer),
  );
  const baseLayer = Layer.mergeAll(
    NodeServices.layer,
    serverConfigLayer,
    Layer.succeed(ProviderService, providerService),
    Layer.succeed(ServerSecretStore, secretStore),
  );
  const settingsLayer = ServerSettingsLive.pipe(Layer.provide(baseLayer));
  const dependencies = Layer.mergeAll(baseLayer, settingsLayer);
  return Layer.mergeAll(dependencies, MossManagedProviderLive.pipe(Layer.provide(dependencies)));
};

const managedBearer = Effect.gen(function* () {
  const settingsService = yield* ServerSettingsService;
  const settings = yield* settingsService.getSettings;
  const instance = settings.providerInstances[MOSS_MANAGED_PROVIDER_INSTANCE_ID];
  return {
    enabled: instance?.enabled,
    bearer: instance?.environment?.find((entry) => entry.name === MOSS_MANAGED_PROVIDER_ENV_KEY)
      ?.value,
  };
});

describe("Moss phone session with a live managed runtime", () => {
  let baseDir: string;
  let now: number;
  let refreshed: number;

  beforeEach(() => {
    baseDir = mkdtempSync(path.join(tmpdir(), "moss-account-rotation-"));
    now = ISSUED_AT;
    refreshed = 0;
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", GATEWAY_URL);
    vi.stubEnv("MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL", "https://realtime.moss.example.cn");
  });

  afterEach(() => {
    vi.unstubAllEnvs();
    rmSync(baseDir, { recursive: true, force: true });
  });

  const auth = (): MemFirePhoneAuthAvailable => {
    const config = {
      realm: "memfire-phone" as const,
      issuer: "https://moss.example.cn/auth/v1",
      cloudRegion: "cn" as const,
      modelGatewayUrl: GATEWAY_URL,
      realtimeRelayUrl: "https://realtime.moss.example.cn",
    };
    return {
      status: "available",
      available: true,
      config,
      client: {
        config,
        sendPhoneOtp: async () => ({ accepted: true }),
        verifyPhoneOtp: async () => authSession("access-1", ISSUED_AT + HOUR),
        refresh: async () => {
          refreshed += 1;
          return authSession(`access-${refreshed + 1}`, now + HOUR);
        },
        getUser: async () => authSession("unused", now + HOUR).user,
        logout: async () => ({ accepted: true }),
      },
    };
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

  const makeService = () =>
    makeMossPhoneAccountService({
      auth: auth(),
      now: () => now,
      fetchGatewayModels: () =>
        Effect.succeed({ status: "ready" as const, models: mossManagedCodexModelsForLane("cn") }),
    });

  it("lets a running turn finish on the old bearer, then rotates once the runtime is idle", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      const afterSignIn = yield* managedBearer;

      runtimes.setSessions([
        {
          provider: "codex",
          providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: ThreadId.makeUnsafe("thread-long-turn"),
        },
      ]);
      now = ISSUED_AT + HOUR - 30_000;
      const whileRunning = yield* service.getSession();
      const duringTurn = yield* managedBearer;
      const stopsDuringTurn = runtimes.stopCodexAccountRuntimes.mock.calls.length;

      runtimes.setSessions([]);
      const afterTurn = yield* service.getSession();
      const afterIdle = yield* managedBearer;

      return { afterSignIn, whileRunning, duringTurn, stopsDuringTurn, afterTurn, afterIdle };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.afterSignIn).toEqual({
      enabled: true,
      bearer: bearerJwt("access-1", ISSUED_AT + HOUR),
    });
    // The refresh itself still happened, so the durable session never lapses.
    expect(refreshed).toBe(1);
    expect(result.whileRunning.authenticated).toBe(true);
    expect(result.stopsDuringTurn).toBe(0);
    expect(result.duringTurn).toEqual({
      enabled: true,
      bearer: bearerJwt("access-1", ISSUED_AT + HOUR),
    });
    expect(result.afterTurn.authenticated).toBe(true);
    expect(result.afterIdle).toEqual({
      enabled: true,
      bearer: bearerJwt("access-2", ISSUED_AT + 2 * HOUR - 30_000),
    });
  });

  it("stops waiting once the old bearer has expired, so one stuck turn cannot block new chats", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "codex",
          providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: ThreadId.makeUnsafe("thread-stuck-turn"),
        },
      ]);
      now = ISSUED_AT + HOUR - 30_000;
      yield* service.getSession();
      // Past the old bearer's expiry plus the grace for a model stream in flight.
      now = ISSUED_AT + HOUR + 6 * 60_000;
      yield* service.getSession();
      return yield* managedBearer;
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(runtimes.stopCodexAccountRuntimes).toHaveBeenCalled();
    expect(result.enabled).toBe(true);
    expect(result.bearer).not.toBe(bearerJwt("access-1", ISSUED_AT + HOUR));
  });

  it("signs out cleanly while a rotation is still waiting for a running turn", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "codex",
          providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: ThreadId.makeUnsafe("thread-waiting-rotation"),
        },
      ]);
      now = ISSUED_AT + HOUR - 30_000;
      yield* service.getSession();
      const logout = yield* service.logout();
      return { logout, session: yield* service.getSession(), managed: yield* managedBearer };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.logout).toEqual({ revokedCount: 1 });
    expect(result.session.authenticated).toBe(false);
    expect(runtimes.stopCodexAccountRuntimes).toHaveBeenCalled();
    expect(result.managed.bearer).toBeUndefined();
  });

  it("still stops a running turn at once when the person signs out", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "codex",
          providerInstanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: ThreadId.makeUnsafe("thread-explicit-sign-out"),
        },
      ]);
      return yield* service.logout();
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result).toEqual({ revokedCount: 1 });
    expect(runtimes.stopCodexAccountRuntimes).toHaveBeenCalled();
  });

  it("signs out while a Moss Claude chat is still open, stopping only that chat", async () => {
    const runtimes = makeProviderRuntimes();
    const claudeThread = ThreadId.makeUnsafe("thread-open-claude");
    const personalClaudeThread = ThreadId.makeUnsafe("thread-personal-claude");
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "ready",
          threadId: claudeThread,
        },
        {
          provider: "claudeAgent",
          providerInstanceId: "claude_personal",
          status: "ready",
          threadId: personalClaudeThread,
        },
      ]);
      const logout = yield* service.logout().pipe(Effect.result);
      const session = yield* service.getSession();
      return { logout, session };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.logout._tag).toBe("Success");
    expect(result.session.authenticated).toBe(false);
    expect(runtimes.stopRuntimeSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: claudeThread }),
    );
    expect(runtimes.stopRuntimeSession).not.toHaveBeenCalledWith(
      expect.objectContaining({ threadId: personalClaudeThread }),
    );
  });

  it("refreshes a session nobody is reading, which the UI alone would leave to expire", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      now = ISSUED_AT + 30 * 60_000;
      yield* service.maintainSession();
      const refreshesWhileFresh = refreshed;
      // Five minutes early, so a rotation that has to wait for a turn still has room.
      now = ISSUED_AT + HOUR - 4 * 60_000;
      yield* service.maintainSession();
      return { refreshesWhileFresh, managed: yield* managedBearer };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.refreshesWhileFresh).toBe(0);
    expect(refreshed).toBe(1);
    expect(result.managed).toEqual({
      enabled: true,
      bearer: bearerJwt("access-2", ISSUED_AT + 2 * HOUR - 4 * 60_000),
    });
  });

  it("rotates past an idle Moss Claude chat instead of disabling Moss models", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "ready",
          threadId: ThreadId.makeUnsafe("thread-idle-claude"),
        },
      ]);
      now = ISSUED_AT + HOUR - 30_000;
      const session = yield* service.getSession().pipe(Effect.result);
      return { session, managed: yield* managedBearer };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.session._tag).toBe("Success");
    expect(result.managed).toEqual({
      enabled: true,
      bearer: bearerJwt("access-2", ISSUED_AT + 2 * HOUR - 30_000),
    });
  });
});
