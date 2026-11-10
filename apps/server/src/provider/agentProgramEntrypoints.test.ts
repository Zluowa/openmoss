// The public health, auxiliary-generation and login entry points must use the
// same server epoch. All processes below are local, injected fixtures.
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, FileSystem, Layer, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { describe, it, assert } from "@effect/vitest";
import { vi } from "vitest";
import path from "node:path";
import { ServerConfig } from "../config.ts";
import { ServerSettingsService } from "../serverSettings.ts";
import { ClaudeTextGeneration } from "../git/Services/TextGeneration.ts";
import { ClaudeTextGenerationServiceLive } from "../git/Layers/ClaudeTextGeneration.ts";
import { makeCheckClaudeProviderStatus, makeClaudeProbeEnv } from "./Layers/ProviderHealth.ts";
import { agentProgramsForServer } from "./agentProgramOwnership.ts";
import { makeProviderLoginManager } from "./providerLoginManager.ts";

describe("server program epoch across real service entry points", () => {
  it.effect(
    "a completed health probe gates auxiliary generation and login without preventing an explicit update",
    () =>
      Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        const config = yield* ServerConfig;
        const first = path.join(config.baseDir, "first.exe");
        const second = path.join(config.baseDir, "second.exe");
        const home = path.join(config.baseDir, "account");
        yield* fs.makeDirectory(home, { recursive: true });
        yield* fs.writeFileString(first, "fixture one");
        yield* fs.writeFileString(second, "fixture two");
        let spawns = 0;
        const spawner = ChildProcessSpawner.make((command) => {
          spawns++;
          const args = (command as unknown as { args: string[] }).args;
          const stdout = args.includes("--version")
            ? "2.1.147"
            : args.includes("status")
              ? JSON.stringify({ loggedIn: true, authMethod: "claude.ai" })
              : JSON.stringify({
                  structured_output: { summary: "Fixture summary", focusItems: [] },
                });
          return Effect.succeed(
            ChildProcessSpawner.makeHandle({
              pid: ChildProcessSpawner.ProcessId(0x7fff_fffe),
              exitCode: Effect.succeed(ChildProcessSpawner.ExitCode(0)),
              isRunning: Effect.succeed(false),
              kill: () => Effect.void,
              stdin: Sink.drain,
              stdout: Stream.make(new TextEncoder().encode(stdout)),
              stderr: Stream.empty,
              all: Stream.empty,
              getInputFd: () => Sink.drain,
              getOutputFd: () => Stream.empty,
            }),
          );
        });
        yield* Effect.gen(function* () {
          const health = yield* makeCheckClaudeProviderStatus(undefined, first, home, {
            fallbackHomeDir: config.homeDir,
          });
          assert.strictEqual(health.status, "ready");
          const text = yield* ClaudeTextGeneration;
          const request = (binaryPath: string) =>
            text.generateProjectDigest({
              cwd: config.cwd,
              activity: "fixture",
              coverage: "one",
              previousSummary: "",
              pinnedFocus: "",
              modelSelection: { provider: "claudeAgent", model: "fixture-model" },
              providerOptions: { claudeAgent: { binaryPath, homePath: home } },
            });
          const afterHealth = spawns;
          const rejected = yield* Effect.result(request(second));
          assert.strictEqual(rejected._tag, "Failure");
          assert.strictEqual(spawns, afterHealth);
          const success = yield* request(first);
          assert.strictEqual(success.summary, "Fixture summary");
          const healthChanged = yield* makeCheckClaudeProviderStatus(undefined, second, home, {
            fallbackHomeDir: config.homeDir,
          });
          assert.include(healthChanged.message ?? "", "Restart Moss");
          const runClaude = vi.fn(() => ({
            completion: Promise.resolve({ status: "succeeded" as const }),
            cancel: () => {},
          }));
          const login = makeProviderLoginManager({
            runtimePrograms: (provider) => agentProgramsForServer(config, provider),
            runClaude,
          });
          assert.throws(
            () =>
              login.start({
                provider: "claudeAgent",
                instanceId: "claudeAgent",
                executable: second,
                cwd: config.cwd,
                env: makeClaudeProbeEnv(home, undefined, config.homeDir),
              }),
            /Restart Moss/,
          );
          assert.strictEqual(runClaude.mock.calls.length, 0);
          const update = agentProgramsForServer(config, "claudeAgent").beginMaintenance(first);
          update.finish(true);
          const blockedAfterUpdate = yield* Effect.result(request(first));
          assert.strictEqual(blockedAfterUpdate._tag, "Failure");
        }).pipe(
          Effect.provide(ClaudeTextGenerationServiceLive),
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provide(ServerSettingsService.layerTest({ lowerProviderProcessPriority: false })),
        );
      }).pipe(
        Effect.provide(ServerConfig.layerTest(process.cwd(), { prefix: "moss-epoch-entries-" })),
        Effect.provide(NodeServices.layer),
        Effect.scoped,
      ),
  );
});
