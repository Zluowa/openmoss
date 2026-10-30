// Real ProviderService/SQLite/settings; the native adapter is fake and never runs a CLI.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { it, assert, vi } from "@effect/vitest";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Layer, Option, Stream } from "effect";
import {
  DEFAULT_SERVER_SETTINGS,
  ThreadId,
  TurnId,
  type ProviderInstanceId,
  type ProviderSession,
  type ServerSettings,
} from "@synara/contracts";
import { ServerConfig } from "../../config.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import {
  buildMossManagedHomeOwnershipMarker,
  readManagedCodexHomeAuthority,
} from "../../account/mossManagedHomeAuthority.ts";
import { readCodexSharedContinuationGeneration } from "../../codexProcessEnv.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { ProviderSessionRuntimeRepositoryLive } from "../../persistence/Layers/ProviderSessionRuntime.ts";
import type {
  ProviderAdapterShape,
  ProviderAdapterSessionStartInput,
} from "../Services/ProviderAdapter.ts";
import { ProviderAdapterRegistry } from "../Services/ProviderAdapterRegistry.ts";
import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderSessionDirectory } from "../Services/ProviderSessionDirectory.ts";
import { ProviderSessionDirectoryLive } from "./ProviderSessionDirectory.ts";
import { makeProviderServiceLive } from "./ProviderService.ts";
const asThreadId = ThreadId.makeUnsafe;
const asRuntimePayloadRecord = (value: unknown) => value as Record<string, unknown>;
function makeProviderServiceLayer(
  _unused: undefined,
  input: { serverSettings: ServerSettings; serverBaseDir: string },
) {
  const sessions = new Map<ThreadId, ProviderSession>();
  const startSession = vi.fn((start: ProviderAdapterSessionStartInput) =>
    Effect.sync(() => {
      const now = new Date().toISOString();
      const session: ProviderSession = {
        provider: "codex",
        threadId: start.threadId,
        status: "ready",
        runtimeMode: start.runtimeMode,
        cwd: start.cwd ?? input.serverBaseDir,
        resumeCursor: start.resumeCursor ?? { threadId: "native-copy" },
        ...(start.providerInstanceId ? { providerInstanceId: start.providerInstanceId } : {}),
        createdAt: now,
        updatedAt: now,
      };
      sessions.set(start.threadId, session);
      return session;
    }),
  );
  const adapter: ProviderAdapterShape<never> = {
    provider: "codex",
    capabilities: { conversationRollback: "native", sessionModelSwitch: "in-session" },
    startSession,
    sendTurn: (turn) =>
      Effect.succeed({ threadId: turn.threadId, turnId: TurnId.makeUnsafe("unused") }),
    interruptTurn: () => Effect.void,
    respondToRequest: () => Effect.void,
    respondToUserInput: () => Effect.void,
    stopSession: (id) =>
      Effect.sync(() => {
        sessions.delete(id);
      }),
    stopAll: () => Effect.sync(() => sessions.clear()),
    listSessions: () => Effect.sync(() => [...sessions.values()]),
    hasSession: (id) => Effect.sync(() => sessions.has(id)),
    readThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
    rollbackThread: (id) => Effect.succeed({ threadId: id, turns: [] }),
    forkThread: (fork) =>
      Effect.succeed({ threadId: fork.threadId, resumeCursor: { threadId: "native-copy" } }),
    streamEvents: Stream.never,
  };
  const directory = ProviderSessionDirectoryLive.pipe(
    Layer.provide(
      ProviderSessionRuntimeRepositoryLive.pipe(Layer.provide(SqlitePersistenceMemory)),
    ),
  );
  const settings = ServerSettingsService.layerTest(input.serverSettings);
  const secret = Layer.succeed(ServerSecretStore, {
    get: () => Effect.succeed(null),
    set: () => Effect.void,
    remove: () => Effect.void,
    getOrCreateRandom: (_name, size) => Effect.succeed(new Uint8Array(size).fill(21)),
  });
  const registry = Layer.succeed(ProviderAdapterRegistry, {
    getByProvider: () => Effect.succeed(adapter),
    listProviders: () => Effect.succeed(["codex"] as const),
  });
  const rawLayer = Layer.mergeAll(
    makeProviderServiceLive().pipe(
      Layer.provide(Layer.mergeAll(directory, settings, secret, registry)),
      Layer.provide(ServerConfig.layerTest(process.cwd(), input.serverBaseDir)),
    ),
    directory,
    settings,
  ).pipe(Layer.provideMerge(NodeServices.layer));
  return { rawLayer, codex: { startSession } };
}
it.effect(
  "persists and resumes the canonical managed continuation with live reservation authority",
  () => {
    const platform = vi.spyOn(process, "platform", "get").mockReturnValue("win32");
    const baseDir = fs.mkdtempSync(path.join(os.tmpdir(), "moss-managed-continuation-service-"));
    const stateDir = path.join(baseDir, "userdata");
    const homePath = path.join(stateDir, "moss-codex-home");
    fs.mkdirSync(homePath, { recursive: true });
    const nonce = "e546cc3c-b0d1-4884-a8ce-1b9c7a51b4f9";
    fs.writeFileSync(
      path.join(homePath, ".moss-managed-home"),
      buildMossManagedHomeOwnershipMarker(nonce),
    );
    fs.writeFileSync(path.join(homePath, "config.toml"), 'model_provider = "moss"\n');
    const settings: ServerSettings = {
      ...DEFAULT_SERVER_SETTINGS,
      providers: {
        ...DEFAULT_SERVER_SETTINGS.providers,
        codex: {
          ...DEFAULT_SERVER_SETTINGS.providers.codex,
          accounts: [{ id: "moss", label: "Moss", homePath, shadowHomePath: "" }],
        },
      },
      providerInstances: {
        codex_moss: {
          driver: "codex",
          enabled: true,
          config: { managed: true, accountId: "moss", homePath, homeOwnershipNonce: nonce },
        },
      },
    };
    const managed = makeProviderServiceLayer(undefined, {
      serverSettings: settings,
      serverBaseDir: baseDir,
    });
    return Effect.gen(function* () {
      const provider = yield* ProviderService;
      const directory = yield* ProviderSessionDirectory;
      const serverSettings = yield* ServerSettingsService;
      const threadId = asThreadId("managed-authority-continuation");
      yield* provider.importExternalThread!({
        threadId,
        provider: "codex",
        externalThreadId: "existing-source-thread",
        sourceCwd: baseDir,
        modelSelection: { provider: "codex", model: "gpt-5.4", instanceId: "codex_moss" },
        runtimeMode: "full-access",
      });
      const authority = yield* Effect.promise(() =>
        readManagedCodexHomeAuthority({
          stateDir,
          readSettings: () => Effect.runPromise(serverSettings.getSettings),
          readSettingsSync: () => Effect.runSync(serverSettings.getSettings),
          input: { homePath, accountId: "moss", env: process.env },
        }),
      );
      const generation = readCodexSharedContinuationGeneration({
        homePath,
        accountId: "moss",
        managedHomeAuthority: authority!,
      });
      assert.isString(generation);
      const imported = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.match(
        String(asRuntimePayloadRecord(imported.runtimePayload).continuationIdentity),
        new RegExp(`^codex:shared-v2:${generation}:`),
      );
      const startInput = {
        provider: "codex" as const,
        providerInstanceId: "codex_moss" as ProviderInstanceId,
        threadId,
        cwd: baseDir,
        runtimeMode: "full-access" as const,
        resumeCursor: imported.resumeCursor,
      };
      yield* provider.startSession(threadId, startInput);
      const started = Option.getOrThrow(yield* directory.getBinding(threadId));
      assert.equal(
        asRuntimePayloadRecord(started.runtimePayload).continuationIdentity,
        asRuntimePayloadRecord(imported.runtimePayload).continuationIdentity,
      );
      assert.equal(
        managed.codex.startSession.mock.calls.at(-1)?.[0].expectedCodexContinuationGeneration,
        generation,
      );
      assert.notProperty(asRuntimePayloadRecord(started.runtimePayload), "managedHomeAuthority");
      yield* provider.stopRuntimeSession!({ threadId });
      yield* serverSettings.updateSettings({
        providerInstances: {
          codex_moss: {
            ...settings.providerInstances.codex_moss!,
            config: {
              managed: true,
              accountId: "moss",
              homePath,
              homeOwnershipNonce: "c7a9ba80-5289-491b-adff-af7ebde7ddc1",
            },
          },
        },
      });
      const before = managed.codex.startSession.mock.calls.length;
      const rejected = yield* Effect.exit(provider.startSession(threadId, startInput));
      assert.isTrue(Exit.isFailure(rejected));
      assert.equal(managed.codex.startSession.mock.calls.length, before);
    }).pipe(
      Effect.provide(managed.rawLayer),
      Effect.ensuring(
        Effect.sync(() => {
          platform.mockRestore();
          fs.rmSync(baseDir, { recursive: true, force: true });
        }),
      ),
    );
  },
);
