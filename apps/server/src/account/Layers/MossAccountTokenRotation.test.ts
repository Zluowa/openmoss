// Real managed provider, real phone account service, fake auth and provider
// runtimes: what a signed-in person's running chat sees when the hourly access
// token rotates or when they sign out with a chat still open.
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { ThreadId } from "@moss/contracts";
import { Deferred, Duration, Effect, Layer, Logger } from "effect";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ServerSecretStore,
  type ServerSecretStoreShape,
} from "../../auth/Services/ServerSecretStore";
import { ServerConfig } from "../../config";
import { ProviderValidationError } from "../../provider/Errors";
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
import {
  MOSS_BEARER_SEND_ROTATION_LEAD_MS,
  readManagedBearerExpiryMs,
} from "../managedCredentialFreshness";
import { makeMossManagedTurnPreflight } from "./MossManagedTurnPreflight";
import {
  maintainMossPhoneAccountSession,
  makeMossPhoneAccountService,
} from "./MossPhoneAccountService";

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

/** What ProviderService fails with when a thread's lifecycle stays busy past Stop's wait. */
const lifecycleBusyStop = () =>
  new ProviderValidationError({
    operation: "ProviderService.stopRuntimeSession",
    issue: "The provider lifecycle is busy; Stop could not acquire its observed runtime.",
    reason: "stale-interaction",
  });

const makeProviderRuntimes = () => {
  let sessions: FakeSession[] = [];
  let refuseStops = false;
  let hangStops = false;
  const stopCodexAccountRuntimes = vi.fn(
    (): Effect.Effect<void, unknown> =>
      Effect.sync(() => {
        sessions = sessions.filter((session) => session.provider !== "codex");
      }),
  );
  const stopRuntimeSession = vi.fn(
    (input: { readonly threadId: ThreadId }): Effect.Effect<void, unknown> =>
      hangStops
        ? Effect.never
        : refuseStops
          ? Effect.fail(lifecycleBusyStop())
          : Effect.sync(() => {
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
    /** Every exact-session Stop fails, the way a wedged thread lifecycle refuses it. */
    refuseStops: (refuse: boolean) => {
      refuseStops = refuse;
    },
    /** Every exact-session Stop waits forever, like a turn whose process tree never exits. */
    hangStops: (hang: boolean) => {
      hangStops = hang;
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

const managedLanes = Effect.gen(function* () {
  const codex = yield* managedBearer;
  const settings = yield* (yield* ServerSettingsService).getSettings;
  const claude = settings.providerInstances[MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID];
  return {
    codex,
    claude: {
      enabled: claude?.enabled,
      cleanupState: (claude?.config as Record<string, unknown> | undefined)?.managedCleanupState,
    },
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
        updateUserMetadata: async () => authSession("unused", now + HOUR).user,
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
      // 31 minutes left: not yet.
      now = ISSUED_AT + 29 * 60_000;
      yield* service.maintainSession();
      const refreshesWhileFresh = refreshed;
      // 30 minutes early, so a turn that delays the rotation still has a live bearer.
      now = ISSUED_AT + 30 * 60_000;
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
      bearer: bearerJwt("access-2", ISSUED_AT + HOUR + 30 * 60_000),
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

  // 2026-11-12: a Moss Claude turn finished right after a refresh, the deferred
  // rotation could not stop that chat's runtime, and every later pass failed the
  // same way. Both Moss lanes stayed disabled under a signed-in account until a
  // restart.
  it("keeps Moss models usable when a deferred rotation cannot stop the old chat", async () => {
    const runtimes = makeProviderRuntimes();
    const claudeThread = ThreadId.makeUnsafe("thread-claude-turn-ending");
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: claudeThread,
        },
      ]);
      now = ISSUED_AT + HOUR - 4 * 60_000;
      yield* service.maintainSession();
      const duringTurn = yield* managedLanes;

      // The turn ends; the runtime it ran in now refuses to stop.
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "ready",
          threadId: claudeThread,
        },
      ]);
      runtimes.refuseStops(true);
      now += 3_000;
      const afterTurn = yield* service.maintainSession().pipe(Effect.result);
      const lanesAfterTurn = yield* managedLanes;
      now += 60_000;
      const nextPass = yield* service.maintainSession().pipe(Effect.result);
      const session = yield* service.getSession();
      return { duringTurn, afterTurn, lanesAfterTurn, nextPass, session };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    const rotatedBearer = bearerJwt("access-2", ISSUED_AT + 2 * HOUR - 4 * 60_000);
    expect(result.duringTurn.codex).toEqual({
      enabled: true,
      bearer: bearerJwt("access-1", ISSUED_AT + HOUR),
    });
    expect(runtimes.stopRuntimeSession).toHaveBeenCalledWith(
      expect.objectContaining({ threadId: claudeThread }),
    );
    expect(result.afterTurn._tag).toBe("Success");
    expect(result.lanesAfterTurn).toEqual({
      codex: { enabled: true, bearer: rotatedBearer },
      claude: { enabled: true, cleanupState: undefined },
    });
    expect(result.nextPass._tag).toBe("Success");
    expect(result.session.authenticated).toBe(true);
  });

  it("says what failed, and keeps Moss models on through the refresh", async () => {
    const runtimes = makeProviderRuntimes();
    const logged: unknown[] = [];
    const logger = Logger.make(({ message }) => {
      logged.push(...(Array.isArray(message) ? message : [message]));
    });
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
          threadId: ThreadId.makeUnsafe("thread-idle-claude-refusing-stop"),
        },
      ]);
      runtimes.refuseStops(true);
      // Idle at refresh time, so the old generation is disabled before the new one is
      // provisioned. That disable cannot stop the runtime; the same pass goes on and puts
      // the fresh bearer live (round 11: a stuck stop must not hold the lanes).
      now = ISSUED_AT + HOUR - 4 * 60_000;
      yield* maintainMossPhoneAccountSession(service);
      return { afterPass: yield* managedLanes };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
      Effect.runPromise,
    );

    expect(logged).not.toContain("failed to maintain Moss phone account session");
    const failure =
      logged[
        logged.indexOf("Moss lanes kept their old bearer through a refresh; re-provisioning") + 1
      ];
    expect(failure).toMatchObject({
      code: "persistence_failed",
      message: "无法配置 Moss 模型服务。",
    });
    const cause = (failure as { cause?: unknown }).cause;
    expect(cause).toContain("ProviderValidationError[ProviderService.stopRuntimeSession");
    expect(cause).toContain("stale-interaction");
    expect(cause).toContain("The provider lifecycle is busy");
    const everything = JSON.stringify(logged);
    expect(everything).not.toContain(bearerJwt("access-1", ISSUED_AT + HOUR));
    expect(everything).not.toContain("13800138000");

    expect(result.afterPass).toEqual({
      codex: {
        enabled: true,
        bearer: bearerJwt("access-2", ISSUED_AT + 2 * HOUR - 4 * 60_000),
      },
      claude: { enabled: true, cleanupState: undefined },
    });
    expect(logged).toContain(
      "Moss token rotation continued while a previous Moss runtime did not stop",
    );
  });

  it("still leaves Moss models off when signing out cannot stop an open chat", async () => {
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
          threadId: ThreadId.makeUnsafe("thread-claude-sign-out"),
        },
      ]);
      runtimes.refuseStops(true);
      const logout = yield* service.logout().pipe(Effect.result);
      return { logout, lanes: yield* managedLanes };
    }).pipe(
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.logout._tag).toBe("Failure");
    expect(result.lanes.codex).toEqual({ enabled: false, bearer: undefined });
    expect(result.lanes.claude.enabled).toBe(false);
  });

  // Rotate-before-send. The preflight runs the same maintenance pass the server loop runs.
  const makePreflight = (
    service: Effect.Success<ReturnType<typeof makeMossPhoneAccountService>>,
    rotate?: Effect.Effect<void, unknown>,
    wait?: Duration.Input,
  ) =>
    Effect.gen(function* () {
      return makeMossManagedTurnPreflight({
        settings: yield* ServerSettingsService,
        scope: yield* Effect.scope,
        rotate: () => rotate ?? service.maintainSession(),
        now: () => now,
        // Tests about the outcome wait for it; the 3 s send budget has its own test.
        wait: wait ?? Duration.seconds(60),
      });
    });

  it("lets a turn that starts with 25+ minutes left run through the refresh to the end", async () => {
    const runtimes = makeProviderRuntimes();
    const claudeThread = ThreadId.makeUnsafe("thread-long-claude-turn");
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      const preflight = yield* makePreflight(service);
      // Send at 32 minutes left: no rotation needed, the turn starts on access-1.
      now = ISSUED_AT + 28 * 60_000;
      yield* preflight.beforeTurn({ instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID });
      const atSend = yield* managedBearer;
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: claudeThread,
        },
      ]);
      // The refresh lands mid-turn and waits for the turn.
      now = ISSUED_AT + 31 * 60_000;
      yield* service.maintainSession();
      // 27 minutes into the turn the old bearer is still live, so nothing is stopped.
      now = ISSUED_AT + 55 * 60_000;
      yield* service.maintainSession();
      const lateInTurn = yield* managedBearer;
      const stopsDuringTurn = runtimes.stopRuntimeSession.mock.calls.length;
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "ready",
          threadId: claudeThread,
        },
      ]);
      now = ISSUED_AT + 56 * 60_000;
      yield* service.maintainSession();
      return { atSend, lateInTurn, stopsDuringTurn, afterTurn: yield* managedBearer };
    }).pipe(
      Effect.scoped,
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    const firstBearer = bearerJwt("access-1", ISSUED_AT + HOUR);
    expect(result.atSend).toEqual({ enabled: true, bearer: firstBearer });
    expect(refreshed).toBe(1);
    expect(result.stopsDuringTurn).toBe(0);
    expect(result.lateInTurn).toEqual({ enabled: true, bearer: firstBearer });
    expect(ISSUED_AT + 55 * 60_000).toBeLessThan(readManagedBearerExpiryMs(firstBearer)!);
    expect(result.afterTurn).toEqual({
      enabled: true,
      bearer: bearerJwt("access-2", ISSUED_AT + 31 * 60_000 + HOUR),
    });
  });

  it("starts a chat that is sent near expiry on a fresh bearer", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      const preflight = yield* makePreflight(service);
      // No maintenance pass ran (a sleeping laptop); the send itself notices.
      now = ISSUED_AT + 50 * 60_000;
      yield* preflight.beforeTurn({ instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID });
      return yield* managedLanes;
    }).pipe(
      Effect.scoped,
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result).toEqual({
      codex: { enabled: true, bearer: bearerJwt("access-2", ISSUED_AT + 50 * 60_000 + HOUR) },
      claude: { enabled: true, cleanupState: undefined },
    });
  });

  it("heals the next send after a turn died on an expired bearer, without a restart", async () => {
    const runtimes = makeProviderRuntimes();
    const claudeThread = ThreadId.makeUnsafe("thread-claude-401");
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      const preflight = yield* makePreflight(service);
      runtimes.setSessions([
        {
          provider: "claudeAgent",
          providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
          status: "running",
          threadId: claudeThread,
        },
      ]);
      now = ISSUED_AT + 31 * 60_000;
      yield* service.maintainSession();
      // The turn outlived the old bearer, got the gateway's 401 and its CLI exited. The
      // person sends again before any after-turn rotation ran.
      runtimes.setSessions([]);
      now = ISSUED_AT + HOUR + 60_000;
      const beforeRetry = yield* managedBearer;
      yield* preflight.beforeTurn({ instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID });
      return { beforeRetry, atRetry: yield* managedLanes };
    }).pipe(
      Effect.scoped,
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.beforeRetry.bearer).toBe(bearerJwt("access-1", ISSUED_AT + HOUR));
    // The retry runs on a bearer with a full long turn left (here a second refresh, since
    // the first one also has under 30 minutes left by now).
    expect(result.atRetry.codex.enabled).toBe(true);
    expect(result.atRetry.claude).toEqual({ enabled: true, cleanupState: undefined });
    expect(readManagedBearerExpiryMs(result.atRetry.codex.bearer)).toBeGreaterThan(
      ISSUED_AT + HOUR + 60_000 + MOSS_BEARER_SEND_ROTATION_LEAD_MS,
    );
  });

  it("never holds a send for a slow rotation; the rotation finishes on its own", async () => {
    const runtimes = makeProviderRuntimes();
    const result = await Effect.gen(function* () {
      const settingsService = yield* ServerSettingsService;
      yield* settingsService.start;
      const service = yield* makeService();
      yield* signIn(service);
      const gate = yield* Deferred.make<void>();
      const finished = yield* Deferred.make<void>();
      const preflight = yield* makePreflight(
        service,
        Deferred.await(gate).pipe(
          Effect.andThen(service.maintainSession()),
          Effect.ensuring(Deferred.succeed(finished, undefined)),
        ),
        Duration.millis(50),
      );
      now = ISSUED_AT + 50 * 60_000;
      const started = Date.now();
      yield* preflight.beforeTurn({ instanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID });
      const heldMs = Date.now() - started;
      const atSend = yield* managedBearer;
      yield* Deferred.succeed(gate, undefined);
      yield* Deferred.await(finished);
      return { heldMs, atSend, afterRotation: yield* managedBearer };
    }).pipe(
      Effect.scoped,
      Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
      Effect.runPromise,
    );

    expect(result.heldMs).toBeLessThan(2_000);
    expect(result.atSend.bearer).toBe(bearerJwt("access-1", ISSUED_AT + HOUR));
    expect(result.afterRotation.bearer).toBe(bearerJwt("access-2", ISSUED_AT + 50 * 60_000 + HOUR));
  });

  // 2026-11-13, round 11: a Moss Claude runtime never finished stopping, and every later
  // rotation (and so every later send's fresh bearer) waited behind it.
  describe("with a runtime that never stops", () => {
    beforeEach(() => {
      vi.stubEnv("MOSS_MANAGED_RUNTIME_STOP_TIMEOUT_MS", "200");
    });

    it("puts the fresh bearer live within the stop bound, and later sends use it", async () => {
      const runtimes = makeProviderRuntimes();
      const hungThread = ThreadId.makeUnsafe("thread-claude-never-stops");
      const result = await Effect.gen(function* () {
        const settingsService = yield* ServerSettingsService;
        yield* settingsService.start;
        const service = yield* makeService();
        yield* signIn(service);
        const preflight = yield* makePreflight(service);
        runtimes.setSessions([
          {
            provider: "claudeAgent",
            providerInstanceId: MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID,
            status: "ready",
            threadId: hungThread,
          },
        ]);
        runtimes.hangStops(true);
        now = ISSUED_AT + 50 * 60_000;
        const started = Date.now();
        yield* service.maintainSession();
        const rotationMs = Date.now() - started;
        const afterRotation = yield* managedLanes;
        // A second thread's send on another Moss lane: no rotation left to wait for.
        const sendStarted = Date.now();
        yield* preflight.beforeTurn({ instanceId: MOSS_MANAGED_PROVIDER_INSTANCE_ID });
        const sendHeldMs = Date.now() - sendStarted;
        return { rotationMs, afterRotation, sendHeldMs, atSecondSend: yield* managedLanes };
      }).pipe(
        Effect.scoped,
        Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
        Effect.runPromise,
      );

      const fresh = bearerJwt("access-2", ISSUED_AT + 50 * 60_000 + HOUR);
      expect(runtimes.stopRuntimeSession).toHaveBeenCalledWith(
        expect.objectContaining({ threadId: hungThread }),
      );
      expect(result.rotationMs).toBeLessThan(10_000);
      expect(result.afterRotation).toEqual({
        codex: { enabled: true, bearer: fresh },
        claude: { enabled: true, cleanupState: undefined },
      });
      expect(result.sendHeldMs).toBeLessThan(2_000);
      expect(result.atSecondSend.codex.bearer).toBe(fresh);
    });

    it("still fences the lanes on sign-out, and the sign-out ends instead of waiting forever", async () => {
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
            status: "running",
            threadId: ThreadId.makeUnsafe("thread-claude-never-stops-sign-out"),
          },
        ]);
        runtimes.hangStops(true);
        const logout = yield* service.logout().pipe(Effect.result);
        return { logout, lanes: yield* managedLanes };
      }).pipe(
        Effect.provide(makeHarnessLayer(runtimes.service, makeSecretStore(), baseDir)),
        Effect.runPromise,
      );

      expect(result.logout._tag).toBe("Failure");
      expect(result.lanes.codex).toEqual({ enabled: false, bearer: undefined });
      expect(result.lanes.claude.enabled).toBe(false);
    });
  });
});
