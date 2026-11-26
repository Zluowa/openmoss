// FILE: SteeringStress.test.ts
// Purpose: High-concurrency stress tests for mid-run steering parity across Claude,
//          Codex, OpenCode, and non-native interrupt-and-steer providers.
// Layer: Orchestration & provider integration stress tests

import { randomUUID } from "node:crypto";

import type {
  SDKControlGetContextUsageResponse,
  SDKMessage,
  SDKUserMessage,
} from "@anthropic-ai/claude-agent-sdk";
import type { OpencodeClient } from "@opencode-ai/sdk/v2";
import {
  CommandId,
  DEFAULT_PROVIDER_INTERACTION_MODE,
  EventId,
  MessageId,
  ProjectId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  ThreadId,
  TurnId,
} from "@moss/contracts";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Exit, Fiber, Layer, ManagedRuntime, PubSub, Scope, Stream } from "effect";
import { describe, expect, it, vi } from "vitest";

import { ServerConfig } from "../../config.ts";
import { CodexAppServerManager } from "../../codexAppServerManager.ts";
import { OrchestrationCommandReceiptRepositoryLive } from "../../persistence/Layers/OrchestrationCommandReceipts.ts";
import { OrchestrationEventStoreLive } from "../../persistence/Layers/OrchestrationEventStore.ts";
import { ProviderRuntimeEventRepositoryLive } from "../../persistence/Layers/ProviderRuntimeEvents.ts";
import { SqlitePersistenceMemory } from "../../persistence/Layers/Sqlite.ts";
import { makeClaudeAdapterLive } from "../../provider/Layers/ClaudeAdapter.ts";
import { makeOpenCodeAdapterLive } from "../../provider/Layers/OpenCodeAdapter.ts";
import { OpenCodeRuntimeError, type OpenCodeRuntimeShape } from "../../provider/opencodeRuntime.ts";
import { ClaudeAdapter } from "../../provider/Services/ClaudeAdapter.ts";
import { OpenCodeAdapter } from "../../provider/Services/OpenCodeAdapter.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { OrchestrationEngineLive } from "./OrchestrationEngine.ts";
import { OrchestrationProjectionPipelineLive } from "./ProjectionPipeline.ts";
import { OrchestrationProjectionSnapshotQueryLive } from "./ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionLive } from "./ProviderRuntimeIngestion.ts";
import { OrchestrationEngineService } from "../Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../Services/ProjectionSnapshotQuery.ts";
import { ProviderRuntimeIngestionService } from "../Services/ProviderRuntimeIngestion.ts";
import { ServerSettingsService } from "../../serverSettings.ts";

class StressClaudeQuery implements AsyncIterable<SDKMessage> {
  private readonly queue: Array<SDKMessage> = [];
  private readonly waiters: Array<(result: IteratorResult<SDKMessage>) => void> = [];
  private done = false;
  readonly backgroundTasksCalls: Array<string | undefined> = [];
  readonly setPermissionModeCalls: Array<string> = [];

  emit(message: SDKMessage): void {
    if (this.done) return;
    const waiter = this.waiters.shift();
    if (waiter) {
      waiter({ done: false, value: message });
      return;
    }
    this.queue.push(message);
  }

  finish(): void {
    if (this.done) return;
    this.done = true;
    for (const waiter of this.waiters.splice(0)) {
      waiter({ done: true, value: undefined });
    }
  }

  readonly interrupt = async (): Promise<void> => {};
  readonly stopTask = async (): Promise<void> => {};
  readonly backgroundTasks = async (toolUseId?: string): Promise<boolean> => {
    this.backgroundTasksCalls.push(toolUseId);
    return true;
  };
  readonly setModel = async (): Promise<void> => {};
  readonly setPermissionMode = async (mode: string): Promise<void> => {
    this.setPermissionModeCalls.push(mode);
  };
  readonly setMaxThinkingTokens = async (): Promise<void> => {};
  readonly applyFlagSettings = async (): Promise<void> => {};
  readonly getContextUsage = async (): Promise<SDKControlGetContextUsageResponse> => {
    throw new Error("unused");
  };
  readonly supportedCommands = async () => [];
  readonly supportedModels = async () => [];
  readonly supportedAgents = async () => [];
  readonly close = (): void => {
    this.finish();
  };

  [Symbol.asyncIterator](): AsyncIterator<SDKMessage> {
    return {
      next: () => {
        const queued = this.queue.shift();
        if (queued) return Promise.resolve({ done: false, value: queued });
        if (this.done) return Promise.resolve({ done: true, value: undefined });
        return new Promise<IteratorResult<SDKMessage>>((resolve) => {
          this.waiters.push(resolve);
        });
      },
    };
  }
}

describe("Steering parity stress tests", () => {
  it("Claude stress: absorbs 30 rapid steers + 20 interleaved aborted_streaming/aborted_tools results with zero false errors", async () => {
    const query = new StressClaudeQuery();
    let capturedPromptStream: AsyncIterable<SDKUserMessage> | undefined;
    const layer = makeClaudeAdapterLive({
      createQuery: (input) => {
        capturedPromptStream = input.prompt;
        return query as never;
      },
    }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/moss-steer-stress", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    const STEER_COUNT = 30;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* ClaudeAdapter;
        const threadId = ThreadId.makeUnsafe("thread-claude-stress");
        const collector = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => event.type === "turn.completed"),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          threadId,
          provider: "claudeAgent",
          runtimeMode: "full-access",
        });

        const initialTurn = yield* adapter.sendTurn({
          threadId,
          input: "Initial long-running task",
          attachments: [],
        });

        // Fire 30 rapid steers interleaved with 20 aborted_streaming/aborted_tools results.
        const permissionCallsBeforeSteer = query.setPermissionModeCalls.length;
        const steerTurnIds: Array<string> = [];
        for (let i = 1; i <= STEER_COUNT; i += 1) {
          const steered = yield* adapter.steerTurn({
            threadId,
            input: `Steer directive #${i}`,
            attachments: [],
          });
          steerTurnIds.push(String(steered.turnId));

          if (i <= 20) {
            query.emit({
              type: "result",
              subtype: "error_during_execution",
              terminal_reason: i % 2 === 0 ? "aborted_tools" : "aborted_streaming",
              uuid: `steer-abort-${i}`,
              session_id: "claude-stress-session",
              errors: [`Intermediate abort #${i}`],
            } as unknown as SDKMessage);
          }
        }
        const permissionCallsDuringSteer =
          query.setPermissionModeCalls.length - permissionCallsBeforeSteer;

        // Drain prompt stream to verify exact FIFO ordering & priority.
        const iterator = capturedPromptStream![Symbol.asyncIterator]();
        const deliveredTexts: Array<string> = [];
        const deliveredPriorities: Array<unknown> = [];
        for (let i = 0; i < STEER_COUNT + 1; i += 1) {
          const next = yield* Effect.promise(() => iterator.next());
          expect(next.done).toBe(false);
          if (!next.done) {
            const block = next.value.message.content[0];
            deliveredTexts.push(
              typeof block === "object" && block && "text" in block ? String(block.text) : "",
            );
            deliveredPriorities.push((next.value as unknown as { priority?: unknown }).priority);
          }
        }

        // Emit single final success result after all 30 steers.
        query.emit({
          type: "result",
          subtype: "success",
          uuid: "steer-final-success",
          session_id: "claude-stress-session",
          result: "All 30 steers integrated cleanly",
        } as unknown as SDKMessage);

        const events = Array.from(yield* Fiber.join(collector));
        yield* adapter.stopSession(threadId);

        return {
          initialTurnId: String(initialTurn.turnId),
          steerTurnIds,
          permissionCallsDuringSteer,
          deliveredTexts,
          deliveredPriorities,
          events,
        };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.steerTurnIds).toHaveLength(STEER_COUNT);
    expect(result.steerTurnIds.every((id) => id === result.initialTurnId)).toBe(true);
    // Speed optimization check: zero redundant setPermissionMode stdio RPCs
    // across 30 consecutive steers.
    expect(result.permissionCallsDuringSteer).toBe(0);
    expect(result.deliveredTexts[0]).toBe("Initial long-running task");
    for (let i = 1; i <= STEER_COUNT; i += 1) {
      expect(result.deliveredTexts[i]).toBe(`Steer directive #${i}`);
      expect(result.deliveredPriorities[i]).toBe("now");
    }
    expect(result.events.filter((event) => event.type === "runtime.error")).toHaveLength(0);
    expect(result.events.filter((event) => event.type === "turn.steered")).toHaveLength(
      STEER_COUNT,
    );
    const completed = result.events.filter((event) => event.type === "turn.completed");
    expect(completed).toHaveLength(1);
    expect(completed[0]?.type === "turn.completed" ? completed[0].payload.state : null).toBe(
      "completed",
    );
  });

  it("Codex stress: survives 25 rapid steers with alternating turnId drift auto-retries", async () => {
    const manager = new CodexAppServerManager();
    const threadId = ThreadId.makeUnsafe("thread-codex-stress");
    const sendRequest = vi.fn();
    const context = {
      session: {
        provider: "codex" as const,
        status: "running" as const,
        runtimeMode: "full-access" as const,
        threadId,
        activeTurnId: TurnId.makeUnsafe("turn-0"),
        resumeCursor: { threadId: "provider-thread-stress" },
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
      },
      stopping: false,
      child: {
        killed: false,
        exitCode: null,
        signalCode: null,
        stdin: { writable: true, writableEnded: false, destroyed: false },
      },
      collabReceiverTurns: new Map<string, TurnId>(),
    };
    (manager as unknown as { sessions: Map<ThreadId, unknown> }).sessions.set(threadId, context);
    (manager as unknown as { sendRequest: typeof sendRequest }).sendRequest = sendRequest;

    const STEER_COUNT = 25;
    for (let i = 1; i <= STEER_COUNT; i += 1) {
      const driftedTurnId = `turn-drifted-${i}`;
      if (i % 2 === 1) {
        // Odd steers experience turnId drift and auto-recover via 1 retry.
        sendRequest
          .mockRejectedValueOnce(
            new Error(
              `expectedTurnId mismatch: expected ${context.session.activeTurnId}, actual ${driftedTurnId}`,
            ),
          )
          .mockResolvedValueOnce({ turnId: driftedTurnId });
      } else {
        sendRequest.mockResolvedValueOnce({ turnId: context.session.activeTurnId });
      }

      const result = await manager.steerTurn({
        threadId,
        input: `Codex steer burst #${i}`,
      });
      expect(result.threadId).toBe(threadId);
      if (i % 2 === 1) {
        expect(String(result.turnId)).toBe(driftedTurnId);
        expect(String(context.session.activeTurnId)).toBe(driftedTurnId);
      }
    }

    // 13 odd steers x 2 RPCs + 12 even steers x 1 RPC = 38 total RPCs, 0 failures.
    expect(sendRequest).toHaveBeenCalledTimes(38);
  });

  it("OpenCode stress: handles 20 rapid native steers on one live turn with zero restarts or errors", async () => {
    const promptCalls: Array<Record<string, unknown>> = [];
    const client = {
      event: {
        subscribe: async (_params?: unknown, requestOptions?: { signal?: AbortSignal }) => ({
          stream: (async function* () {
            if (requestOptions?.signal?.aborted) return;
            await new Promise<void>((resolve) => {
              if (!requestOptions?.signal) {
                resolve();
                return;
              }
              requestOptions.signal.addEventListener("abort", () => resolve(), { once: true });
            });
          })(),
        }),
      },
      session: {
        create: async () => ({ data: { id: "opencode-stress-session" } }),
        update: async () => ({ data: null }),
        promptAsync: async (promptInput: Record<string, unknown>) => {
          promptCalls.push(promptInput);
          return { data: null };
        },
        prompt: async () => ({ data: null }),
        abort: async () => ({ data: null }),
        messages: async () => ({ data: [] }),
        children: async () => ({ data: [] }),
        get: async () => ({ data: { directory: process.cwd() } }),
      },
      permission: {
        list: async () => ({ data: [] }),
        reply: async () => ({ data: null }),
      },
      question: {
        list: async () => ({ data: [] }),
        reply: async () => ({ data: true }),
        reject: async () => ({ data: true }),
      },
      command: { list: async () => ({ data: [] }) },
      provider: { list: async () => ({ data: { all: [], connected: [], default: {} } }) },
      app: { agents: async () => ({ data: [] }) },
    } as unknown as OpencodeClient;

    const unexpected = (operation: string) =>
      Effect.fail(
        new OpenCodeRuntimeError({
          operation,
          detail: `Unexpected runtime operation: ${operation}`,
        }),
      );
    const runtime: OpenCodeRuntimeShape = {
      startOpenCodeServerProcess: () => unexpected("startOpenCodeServerProcess"),
      connectToOpenCodeServer: (input) =>
        Effect.succeed({
          url: input.serverUrl ?? "http://127.0.0.1:4096",
          exitCode: null,
          external: Boolean(input.serverUrl),
        }),
      runOpenCodeCommand: () => unexpected("runOpenCodeCommand"),
      createOpenCodeSdkClient: () => client,
      loadOpenCodeInventory: () =>
        Effect.succeed({
          providers: [],
          models: [],
          agents: [],
          commands: [],
          defaultModel: null,
        } as never),
      loadOpenCodeCredentialProviderIDs: () => Effect.succeed([]),
      listOpenCodeCliModels: () => Effect.succeed([]),
    };

    const layer = makeOpenCodeAdapterLive({ runtime }).pipe(
      Layer.provideMerge(ServerConfig.layerTest("/tmp/moss-opencode-stress", "/tmp")),
      Layer.provideMerge(NodeServices.layer),
    );

    const STEER_COUNT = 20;
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const adapter = yield* OpenCodeAdapter;
        const threadId = ThreadId.makeUnsafe("thread-opencode-stress");
        let steeredEventsSeen = 0;
        const collector = yield* adapter.streamEvents.pipe(
          Stream.takeUntil((event) => {
            if (event.type === "turn.steered") {
              steeredEventsSeen += 1;
            }
            return steeredEventsSeen >= STEER_COUNT;
          }),
          Stream.runCollect,
          Effect.forkChild,
        );

        yield* adapter.startSession({
          provider: "opencode",
          threadId,
          runtimeMode: "full-access",
        });

        const initial = yield* adapter.sendTurn({
          threadId,
          input: "Start OpenCode stress run",
          attachments: [],
          modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
        });

        const steeredIds: Array<string> = [];
        for (let i = 1; i <= STEER_COUNT; i += 1) {
          const steered = yield* adapter.steerTurn!({
            threadId,
            input: `OpenCode steer #${i}`,
            attachments: [],
            modelSelection: { provider: "opencode", model: "openai/gpt-5.4" },
          });
          steeredIds.push(String(steered.turnId));
        }

        const events = Array.from(yield* Fiber.join(collector));
        yield* adapter.stopSession(threadId);
        return { initialTurnId: String(initial.turnId), steeredIds, events };
      }).pipe(Effect.provide(layer)),
    );

    expect(result.steeredIds).toHaveLength(STEER_COUNT);
    expect(result.steeredIds.every((id) => id === result.initialTurnId)).toBe(true);
    expect(promptCalls).toHaveLength(STEER_COUNT + 1);
    expect(result.events.filter((e) => e.type === "turn.started")).toHaveLength(1);
    expect(result.events.filter((e) => e.type === "turn.steered")).toHaveLength(STEER_COUNT);
    expect(result.events.filter((e) => e.type === "runtime.error")).toHaveLength(0);
  });

  it("Non-native steer stress: suppresses noisy cancellation errors across 20 back-to-back Antigravity steer cycles", async () => {
    const runtimeEventPubSub = Effect.runSync(PubSub.unbounded<ProviderRuntimeEvent>());
    const runtimeSessions: Array<ProviderSession> = [];
    const unsupported = () => Effect.die(new Error("unused")) as never;
    const providerService: ProviderServiceShape = {
      getLaunchPlan: () => unsupported(),
      getLoopLedgerDashboardSnapshot: () => unsupported(),
      submitPermissionAction: () => unsupported(),
      streamNormalizedEvents: Stream.empty,
      getNormalizedEvents: () => Effect.succeed([]),
      streamNormalizedEventsWithReplay: () => Stream.empty,
      streamEvents: Stream.fromPubSub(runtimeEventPubSub),
      closeRuntimeEvents: Effect.void,
      startSession: () => unsupported(),
      sendTurn: () => unsupported(),
      steerTurn: () => unsupported(),
      startReview: () => unsupported(),
      forkThread: () => Effect.succeed(null),
      interruptTurn: () => unsupported(),
      stopTask: () => unsupported(),
      backgroundTask: () => unsupported(),
      steerSubagent: () => unsupported(),
      respondToRequest: () => unsupported(),
      respondToUserInput: () => unsupported(),
      stopSession: () => unsupported(),
      listSessions: () => Effect.succeed(runtimeSessions),
      getPersistedSessionProfile: () => Effect.succeed(undefined),
      getCapabilities: () => Effect.succeed({ sessionModelSwitch: "in-session" }),
      rollbackConversation: () => unsupported(),
      compactThread: () => unsupported(),
      getNextUserMessagePredictionSupport: () => unsupported(),
      predictNextUserMessage: () => unsupported(),
    };

    const orchestrationLayer = OrchestrationEngineLive.pipe(
      Layer.provide(OrchestrationProjectionPipelineLive),
      Layer.provide(OrchestrationProjectionSnapshotQueryLive),
      Layer.provide(OrchestrationEventStoreLive),
      Layer.provide(OrchestrationCommandReceiptRepositoryLive),
    );
    const runtimeEventRepositoryLayer = ProviderRuntimeEventRepositoryLive.pipe(
      Layer.provideMerge(SqlitePersistenceMemory),
    );
    const fullLayer = ProviderRuntimeIngestionLive.pipe(
      Layer.provideMerge(orchestrationLayer),
      Layer.provideMerge(OrchestrationProjectionSnapshotQueryLive),
      Layer.provideMerge(SqlitePersistenceMemory),
      Layer.provideMerge(runtimeEventRepositoryLayer),
      Layer.provideMerge(Layer.succeed(ProviderService, providerService)),
      Layer.provideMerge(ServerConfig.layerTest(process.cwd(), process.cwd())),
      Layer.provideMerge(ServerSettingsService.layerTest()),
      Layer.provideMerge(NodeServices.layer),
    );

    const runtime = ManagedRuntime.make(fullLayer);
    const scope = await Effect.runPromise(Scope.make("sequential"));
    const CYCLES = 20;
    try {
      const threadId = ThreadId.makeUnsafe("thread-antigravity-stress");
      const projectId = ProjectId.makeUnsafe("project-stress");
      const now = new Date().toISOString();

      await runtime.runPromise(
        Effect.gen(function* () {
          const engine = yield* OrchestrationEngineService;
          const ingestion = yield* ProviderRuntimeIngestionService;
          const snapshotQuery = yield* ProjectionSnapshotQuery;

          yield* ingestion.start.pipe(Scope.provide(scope));
          yield* engine.dispatch({
            type: "project.create",
            commandId: CommandId.makeUnsafe("cmd-project-create-stress"),
            projectId,
            title: "Stress Project",
            workspaceRoot: "/tmp/stress",
            defaultModelSelection: { provider: "antigravity", model: "gemini-3-pro" },
            createdAt: now,
          });
          yield* engine.dispatch({
            type: "thread.create",
            commandId: CommandId.makeUnsafe("cmd-thread-create-stress"),
            threadId,
            projectId,
            title: "Antigravity Steer Stress",
            modelSelection: { provider: "antigravity", model: "gemini-3-pro" },
            runtimeMode: "full-access",
            interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
            branch: null,
            worktreePath: null,
            createdAt: now,
          });

          for (let cycle = 1; cycle <= CYCLES; cycle += 1) {
            const turnId = TurnId.makeUnsafe(`turn-stress-${cycle}`);
            const stepNow = new Date(Date.now() + cycle * 1000).toISOString();

            // Start running turn.
            yield* PubSub.publish(runtimeEventPubSub, {
              type: "turn.started",
              eventId: EventId.makeUnsafe(`evt-start-${cycle}-${randomUUID()}`),
              provider: "antigravity",
              createdAt: stepNow,
              threadId,
              turnId,
              payload: {},
            });
            yield* ingestion.drain;

            // User steers mid-run on non-native provider -> decider queues + emits
            // thread.turn-interrupt-requested with requestedBy: "steer".
            yield* engine.dispatch({
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`cmd-steer-${cycle}`),
              threadId,
              message: {
                messageId: MessageId.makeUnsafe(`msg-steer-${cycle}`),
                role: "user",
                text: `Redirect task cycle #${cycle}`,
                attachments: [],
              },
              dispatchMode: "steer",
              runtimeMode: "full-access",
              interactionMode: DEFAULT_PROVIDER_INTERACTION_MODE,
              createdAt: stepNow,
            });
            yield* ingestion.drain;

            // Interrupted provider emits noisy red-box runtime.error + failed completion!
            yield* PubSub.publish(runtimeEventPubSub, {
              type: "runtime.error",
              eventId: EventId.makeUnsafe(`evt-err-${cycle}-${randomUUID()}`),
              provider: "antigravity",
              createdAt: stepNow,
              threadId,
              turnId,
              payload: { message: "The provider could not complete this request. Try again." },
            });
            yield* PubSub.publish(runtimeEventPubSub, {
              type: "turn.completed",
              eventId: EventId.makeUnsafe(`evt-done-${cycle}-${randomUUID()}`),
              provider: "antigravity",
              createdAt: stepNow,
              threadId,
              turnId,
              payload: {
                state: "failed",
                errorMessage: "The provider could not complete this request. Try again.",
              },
            });
            yield* ingestion.drain;
          }

          const thread = (yield* snapshotQuery.getSnapshot()).threads.find(
            (candidate) => candidate.id === threadId,
          );
          expect(thread).toBeDefined();
          expect(thread!.session?.status).toBe("interrupted");
          expect(thread!.session?.lastError).toBeNull();
          expect(
            thread!.activities.filter((activity) => activity.kind === "runtime.error"),
          ).toHaveLength(0);
          const steerStops = thread!.activities.filter(
            (activity) =>
              activity.kind === "turn.stop-requested" &&
              (activity.payload as Record<string, unknown> | undefined)?.requestedBy === "steer",
          );
          expect(steerStops).toHaveLength(CYCLES);
          const completed = thread!.activities.filter(
            (activity) => activity.kind === "turn.completed",
          );
          expect(completed).toHaveLength(CYCLES);
          expect(
            completed.every(
              (activity) =>
                activity.tone !== "error" &&
                (activity.payload as Record<string, unknown> | undefined)?.state === "interrupted",
            ),
          ).toBe(true);
          expect(
            thread!.messages.filter(
              (msg) =>
                msg.role === "user" && msg.dispatchMode === "steer" && msg.startsNewTurn === true,
            ),
          ).toHaveLength(CYCLES);
        }),
      );
    } finally {
      await Effect.runPromise(Scope.close(scope, Exit.void));
      await runtime.dispose();
    }
  });
});
