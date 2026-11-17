import {
  MessageId,
  ProjectId,
  ThreadId,
  TurnId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
} from "@moss/contracts";
import { Deferred, Duration, Effect, Exit, Fiber, Layer, Logger, Option, Scope } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect, it, vi } from "vitest";

import { TextGenerationError } from "../../git/Errors.ts";
import {
  TextGeneration,
  type IsolatedTextGenerationSupport,
  type TextGenerationShape,
} from "../../git/Services/TextGeneration.ts";
import { buildComposerPredictionForkPrompt } from "../../git/textGenerationShared.ts";
import {
  ProjectionSnapshotQuery,
  type ProjectionSnapshotQueryShape,
} from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import { ProviderAdapterRequestError } from "../../provider/Errors.ts";
import type { ProviderNextUserMessagePredictionSupport } from "../../provider/Services/ProviderAdapter.ts";
import {
  ProviderService,
  type ProviderServiceShape,
} from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ComposerPredictionService } from "../Services/ComposerPredictionService.ts";
import {
  OWNER_CLAUDE_WRAP_UP_ACTIVITY,
  OWNER_CODEX_WRAP_UP_ACTIVITY,
  OWNER_FINAL_REPLY,
  OWNER_REQUEST,
} from "../testing/ownerWrapUpTurn.ts";
import {
  COMPOSER_PREDICTION_START_DELAY,
  makeComposerPredictionServiceLive,
} from "./ComposerPredictionService.ts";

const THREAD_ID = ThreadId.makeUnsafe("thread-1");
const TURN_ID = TurnId.makeUnsafe("turn-2");
const FINAL_REPLY = MessageId.makeUnsafe("assistant-final");
const NOW = "2026-11-10T10:00:00.000Z";
const INPUT = { threadId: THREAD_ID, expectedTurnId: TURN_ID };
const UNAVAILABLE = { suggestion: null, outcome: "unavailable" };
const GENERATION_UNAVAILABLE = { suggestion: null, outcome: "generation-unavailable" };

/** The one line a request logs; the test clock keeps durations at zero. */
function predictionLog(
  level: "Info" | "Warn",
  fields: { readonly route: string; readonly outcome: string } & Record<string, unknown>,
) {
  return {
    level,
    message: [
      "Composer prediction",
      { threadId: THREAD_ID, expectedTurnId: TURN_ID, ...fields, durationMs: 0 },
    ],
  };
}
const NONE = { suggestion: null, outcome: "none" };

function makeThread(modelSelection: ModelSelection, turnId = TURN_ID): OrchestrationThreadShell {
  return {
    id: THREAD_ID,
    projectId: ProjectId.makeUnsafe("project-1"),
    modelSelection,
    envMode: "local",
    worktreePath: null,
    workingDirectory: null,
    archivedAt: null,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    latestTurn: {
      turnId,
      state: "completed",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: NOW,
      assistantMessageId: FINAL_REPLY,
    },
    session: {
      threadId: THREAD_ID,
      status: "ready",
      providerName: modelSelection.provider,
      runtimeMode: "full-access",
      activeTurnId: null,
      lastError: null,
      updatedAt: NOW,
    },
  } as unknown as OrchestrationThreadShell;
}

const MESSAGES = [
  { id: "user-1", role: "user", text: "Investigate the red CI run", streaming: false },
  {
    id: FINAL_REPLY,
    role: "assistant",
    text: "A stale fixture breaks parser.test.ts.",
    streaming: false,
  },
] as unknown as OrchestrationMessage[];

const CLAUDE_CHAT = {
  provider: "claudeAgent",
  instanceId: "claudeAgent",
  model: "claude-sonnet-5-5",
} as ModelSelection;

function makeHarness(
  options: {
    readonly modelSelection?: ModelSelection;
    /** The production delay where a test is about it; none elsewhere, so timings stay exact. */
    readonly startDelay?: Duration.Input;
    /** What the isolated path says about the chat's instance; supported when left out. */
    readonly isolatedSupport?: IsolatedTextGenerationSupport;
    /** What the live thread says about a native prediction fork. */
    readonly nativeSupport?: ProviderNextUserMessagePredictionSupport;
    /** Per instance, what the isolated path says; falls back to `isolatedSupport`. */
    readonly isolatedSupportByInstance?: Readonly<Record<string, IsolatedTextGenerationSupport>>;
    readonly settings?: Parameters<typeof ServerSettingsService.layerTest>[0];
  } = {},
) {
  const state = {
    thread: makeThread(options.modelSelection ?? CLAUDE_CHAT) as OrchestrationThreadShell,
    messages: MESSAGES,
    missing: false,
    /** The turn's stored `moss_wrap_up` calls, oldest first. */
    wrapUps: [] as Array<{ readonly kind: string; readonly payload: unknown }>,
    wrapUpsFail: false,
  };
  const snapshotQuery = {
    getThreadShellById: () =>
      Effect.sync(() => (state.missing ? Option.none() : Option.some(state.thread))),
    getThreadMentionContextById: () =>
      Effect.succeed(
        Option.some({
          id: THREAD_ID,
          title: "Thread",
          modelSelection: state.thread.modelSelection,
          messages: state.messages,
          totalMessageCount: state.messages.length,
        }),
      ),
    listWrapUpActivitiesByTurn: () =>
      state.wrapUpsFail
        ? Effect.fail(new Error("projection read failed"))
        : Effect.sync(() => state.wrapUps),
    getProjectShellById: () =>
      Effect.succeed(
        Option.some({ id: ProjectId.makeUnsafe("project-1"), workspaceRoot: "/tmp/project-1" }),
      ),
  } as unknown as ProjectionSnapshotQueryShape;
  const generateComposerPrediction = vi.fn<TextGenerationShape["generateComposerPrediction"]>(() =>
    Effect.succeed({ suggestion: "Fix the fixture and rerun that test." }),
  );
  const getComposerPredictionSupport = vi.fn<
    NonNullable<TextGenerationShape["getComposerPredictionSupport"]>
  >((input) =>
    Effect.succeed(
      options.isolatedSupportByInstance?.[input.modelSelection?.instanceId ?? ""] ??
        options.isolatedSupport ?? { kind: "supported" },
    ),
  );
  const getNextUserMessagePredictionSupport = vi.fn<
    ProviderServiceShape["getNextUserMessagePredictionSupport"]
  >(() => Effect.succeed(options.nativeSupport ?? { kind: "supported" }));
  const predictNextUserMessage = vi.fn<ProviderServiceShape["predictNextUserMessage"]>(() =>
    Effect.succeed({
      kind: "predicted",
      text: '{"suggestion":"Fix the fixture and rerun that test."}',
    }),
  );
  // `logs` leaves out the model and effort fields, which tests about them read from `rawLogs`.
  const logs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const rawLogs: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    rawLogs.push({ level: logLevel, message });
    const parts = Array.isArray(message) ? message : [message];
    logs.push({
      level: logLevel,
      message: parts.map((part) => {
        if (part === null || typeof part !== "object" || Array.isArray(part)) return part;
        const { model: _model, effort: _effort, ...rest } = part as Record<string, unknown>;
        return rest;
      }),
    });
  });
  const layer = makeComposerPredictionServiceLive({
    startDelay: options.startDelay ?? Duration.zero,
  }).pipe(
    Layer.provide(Layer.succeed(ProjectionSnapshotQuery, snapshotQuery)),
    Layer.provide(
      Layer.succeed(TextGeneration, {
        generateComposerPrediction,
        getComposerPredictionSupport,
      } as unknown as TextGenerationShape),
    ),
    Layer.provide(
      Layer.succeed(ProviderService, {
        getNextUserMessagePredictionSupport,
        predictNextUserMessage,
      } as unknown as ProviderServiceShape),
    ),
    Layer.provide(ServerSettingsService.layerTest(options.settings ?? {})),
    Layer.provideMerge(TestClock.layer()),
    Layer.provideMerge(Logger.layer([logger], { mergeWithExisting: false })),
  );
  const run = <A, E>(
    effect: Effect.Effect<A, E, ComposerPredictionService | TestClock.TestClock | Scope.Scope>,
  ) => Effect.runPromise(effect.pipe(Effect.provide(layer), Effect.scoped));
  const generateFor = (expectedTurnId: TurnId) =>
    Effect.flatMap(ComposerPredictionService.asEffect(), (service) =>
      service.generate({ ...INPUT, expectedTurnId }),
    );
  const generate = generateFor(TURN_ID);
  /** Moves the chat on to a new settled turn and asks for that turn's prediction. */
  const generateForNextTurn = (turnId: string) => {
    const next = TurnId.makeUnsafe(turnId);
    state.thread = makeThread(state.thread.modelSelection, next);
    return generateFor(next);
  };
  return {
    state,
    logs,
    rawLogs,
    generateComposerPrediction,
    getComposerPredictionSupport,
    getNextUserMessagePredictionSupport,
    predictNextUserMessage,
    run,
    generate,
    generateFor,
    generateForNextTurn,
  };
}

describe("ComposerPredictionServiceLive", () => {
  it("predicts from the settled turn on the chat's own instance at its lowest effort", async () => {
    const harness = makeHarness();

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
    expect(harness.generateComposerPrediction).toHaveBeenCalledWith(
      expect.objectContaining({
        cwd: "/tmp/project-1",
        conversation:
          "User: Investigate the red CI run\n\nAssistant: A stale fixture breaks parser.test.ts.",
        modelSelection: expect.objectContaining({
          provider: "claudeAgent",
          instanceId: "claudeAgent",
          // The chat model: Sonnet has no smaller prediction model.
          model: "claude-sonnet-5-5",
          options: { effort: "low" },
        }),
      }),
    );
  });

  it("is unavailable without generating when the expected turn is no longer the latest", async () => {
    const harness = makeHarness();
    harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it.each([
    ["a pending approval", { hasPendingApprovals: true }],
    ["a pending user-input request", { hasPendingUserInput: true }],
  ])("is unavailable without generating while the thread has %s", async (_label, overrides) => {
    const harness = makeHarness();
    const thread = harness.state.thread;
    harness.state.thread = { ...thread, ...overrides } as OrchestrationThreadShell;

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("is unavailable when the thread is missing", async () => {
    const harness = makeHarness();
    harness.state.missing = true;

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  // The isolated route never uses the chat's session: a session that is starting (Moss
  // resuming the Codex thread when the chat is opened) or running background work does not
  // stop it. 2026-11-17, owner's PC: a finished suggestion was discarded as `session-busy`
  // while `thread/resume` took 13.6 s.
  it.each([
    ["starting", { session: { status: "starting" } }],
    ["running", { session: { status: "running" } }],
  ])("predicts on the isolated route while the chat's session is %s", async (_label, overrides) => {
    const harness = makeHarness();
    const thread = harness.state.thread;
    harness.state.thread = {
      ...thread,
      session: { ...thread.session, ...overrides.session },
    } as OrchestrationThreadShell;

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
  });

  it("keeps an isolated suggestion when the session starts resuming during generation", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockImplementationOnce(() =>
      Effect.sync(() => {
        const thread = harness.state.thread;
        harness.state.thread = {
          ...thread,
          session: { ...thread.session, status: "starting" },
        } as OrchestrationThreadShell;
        return { suggestion: "Keep it this way." };
      }),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Keep it this way.",
      outcome: "suggested",
    });
  });

  it("keeps going on the isolated route when the session turns busy during the start delay", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        const thread = harness.state.thread;
        harness.state.thread = {
          ...thread,
          session: { ...thread.session, status: "running" },
        } as OrchestrationThreadShell;
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("is unavailable when the final reply is not in the transcript yet", async () => {
    const harness = makeHarness();
    harness.state.messages = MESSAGES.slice(0, 1);

    await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("discards a suggestion when a new turn starts during generation, and keeps no answer", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockImplementationOnce(() =>
      Effect.sync(() => {
        harness.state.thread = makeThread(CLAUDE_CHAT, TurnId.makeUnsafe("turn-3"));
        return { suggestion: "Stale suggestion" };
      }),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const stale = yield* harness.generate;
        // Back on the first turn (a projection that briefly ran ahead): it asks again.
        harness.state.thread = makeThread(CLAUDE_CHAT);
        return [stale, yield* harness.generate];
      }),
    );

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("answers none once, and never falls back to the Git-writing model, for a chat provider without text generation", async () => {
    const harness = makeHarness({
      modelSelection: { provider: "grok", instanceId: "grok", model: "grok-4.6" } as ModelSelection,
    });

    await expect(harness.run(harness.generate)).resolves.toEqual(NONE);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
    expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
  });

  it("is none when the model answers without a suggestion", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: null,
      outcome: "none",
    });
  });

  it("is unavailable when generation fails", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
  });

  it("is unavailable when generation outlives its timeout, and asks again afterwards", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(Effect.never);

    const results = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("20 seconds");
        const timedOut = yield* Fiber.join(fiber);
        harness.generateComposerPrediction.mockReturnValue(
          Effect.succeed({ suggestion: "Fix the fixture and rerun that test." }),
        );
        return [timedOut, yield* harness.generate];
      }),
    );

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
  });

  it("races a stalled generation with a second attempt and takes the first to settle", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction
      .mockReturnValueOnce(Effect.never)
      .mockReturnValueOnce(Effect.succeed({ suggestion: "From the second attempt" }));

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("9 seconds");
        expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the second attempt", outcome: "suggested" });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("keeps waiting for the first attempt when the second one fails", async () => {
    const harness = makeHarness();
    const release = Deferred.makeUnsafe<void>();
    harness.generateComposerPrediction
      .mockReturnValueOnce(
        Deferred.await(release).pipe(Effect.as({ suggestion: "From the first attempt" })),
      )
      .mockReturnValueOnce(
        Effect.fail(
          new TextGenerationError({ operation: "generateComposerPrediction", detail: "busy" }),
        ),
      );

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("10 seconds");
        expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the first attempt", outcome: "suggested" });
  });

  it("starts the second attempt sooner once the route has proven fast", async () => {
    const harness = makeHarness();

    const result = await harness.run(
      Effect.gen(function* () {
        yield* harness.generate;
        harness.generateComposerPrediction
          .mockReturnValueOnce(Effect.never)
          .mockReturnValueOnce(Effect.succeed({ suggestion: "From the second attempt" }));
        const fiber = yield* Effect.forkChild(harness.generateForNextTurn("turn-3"));
        yield* TestClock.adjust("6 seconds");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({ suggestion: "From the second attempt", outcome: "suggested" });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(3);
  });

  it("starts no second attempt on a route that is slow by nature", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValueOnce(
      Effect.delay(Effect.succeed({ suggestion: "Slow but fine" }), "9 seconds"),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("9 seconds");
        const firstResult = yield* Fiber.join(first);
        harness.generateComposerPrediction.mockReturnValueOnce(Effect.never);
        const second = yield* Effect.forkChild(harness.generateForNextTurn("turn-3"));
        yield* TestClock.adjust("20 seconds");
        return [firstResult, yield* Fiber.join(second)];
      }),
    );

    expect(results).toEqual([
      { suggestion: "Slow but fine", outcome: "suggested" },
      GENERATION_UNAVAILABLE,
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("does not start a second attempt when the first one fails fast", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("shares one generation between concurrent requests for the same turn", async () => {
    const harness = makeHarness();
    const release = Deferred.makeUnsafe<void>();
    harness.generateComposerPrediction.mockReturnValue(
      Deferred.await(release).pipe(Effect.as({ suggestion: "Shared suggestion" })),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        const second = yield* Effect.forkChild(harness.generate);
        yield* Effect.yieldNow;
        yield* Deferred.succeed(release, undefined);
        return [yield* Fiber.join(first), yield* Fiber.join(second)];
      }),
    );

    expect(results).toEqual([
      { suggestion: "Shared suggestion", outcome: "suggested" },
      { suggestion: "Shared suggestion", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("keeps a shared generation for the remaining caller and stops it after the last one", async () => {
    const harness = makeHarness();
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    let interrupted = false;
    // Signal after a yield, like real provider IO, so the signal never runs the
    // waiting test fiber inline while the generation is still being set up.
    harness.generateComposerPrediction.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as({ suggestion: "Kept suggestion" }),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );

    const kept = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        const second = yield* Effect.forkChild(harness.generate);
        yield* Deferred.await(started);
        yield* Fiber.interrupt(first);
        yield* Deferred.succeed(release, undefined);
        return yield* Fiber.join(second);
      }),
    );
    expect(kept).toEqual({ suggestion: "Kept suggestion", outcome: "suggested" });
    expect(interrupted).toBe(false);

    const abandoned = makeHarness();
    const abandonedStarted = Deferred.makeUnsafe<void>();
    abandoned.generateComposerPrediction.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(abandonedStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const exit = await abandoned.run(
      Effect.gen(function* () {
        const only = yield* Effect.forkChild(abandoned.generate);
        yield* Deferred.await(abandonedStarted);
        yield* Fiber.interrupt(only);
        return yield* Fiber.await(only);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(interrupted).toBe(true);
  });

  it("starts no provider CLI for a request abandoned within the start delay", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const exit = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(COMPOSER_PREDICTION_START_DELAY);
        return yield* Fiber.await(fiber);
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
  });

  it("generates once the start delay has passed", async () => {
    const harness = makeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
        yield* TestClock.adjust("1 millis");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
  });

  it("returns a turn's answer again without a second generation, a null one too", async () => {
    const harness = makeHarness();

    const answered = await harness.run(
      Effect.gen(function* () {
        const first = yield* harness.generate;
        harness.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));
        const again = yield* harness.generate;
        const declined = yield* harness.generateForNextTurn("turn-3");
        const declinedAgain = yield* harness.generateFor(TurnId.makeUnsafe("turn-3"));
        return [first, again, declined, declinedAgain];
      }),
    );

    expect(answered).toEqual([
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
      { suggestion: null, outcome: "none" },
      { suggestion: null, outcome: "none" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });

  it("logs one content-free reason code per unavailable answer", async () => {
    const failing = makeHarness();
    failing.generateComposerPrediction.mockReturnValue(
      Effect.fail(
        new TextGenerationError({
          operation: "generateComposerPrediction",
          detail: "User: secret prompt text",
        }),
      ),
    );
    await failing.run(failing.generate);
    expect(failing.logs).toEqual([
      predictionLog("Warn", {
        route: "isolated",
        outcome: "generation-unavailable",
        reason: "generation-failed",
        source: "chat-model",
      }),
    ]);
    expect(JSON.stringify(failing.logs)).not.toContain("secret");

    const busy = makeHarness();
    busy.state.thread = { ...busy.state.thread, hasPendingApprovals: true };
    await busy.run(busy.generate);
    expect(busy.logs).toEqual([
      predictionLog("Info", { route: "none", outcome: "unavailable", reason: "pending-approval" }),
    ]);

    // The model's own answers are logged too, so a missing suggestion is never silent.
    const answered = makeHarness();
    answered.generateComposerPrediction.mockReturnValue(Effect.succeed({ suggestion: null }));
    await answered.run(Effect.all([answered.generate, answered.generate]));
    expect(answered.logs).toEqual([
      predictionLog("Info", { route: "isolated", outcome: "none", source: "chat-model" }),
      predictionLog("Info", {
        route: "isolated",
        outcome: "none",
        source: "chat-model",
        cached: true,
      }),
    ]);
    expect(JSON.stringify(answered.logs)).not.toContain("Fix the fixture");
  });

  it("asks again after a failed generation instead of reusing it", async () => {
    const harness = makeHarness();
    harness.generateComposerPrediction.mockReturnValueOnce(
      Effect.fail(
        new TextGenerationError({ operation: "generateComposerPrediction", detail: "bad output" }),
      ),
    );

    const results = await harness.run(Effect.all([harness.generate, harness.generate]));

    expect(results).toEqual([
      GENERATION_UNAVAILABLE,
      { suggestion: "Fix the fixture and rerun that test.", outcome: "suggested" },
    ]);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });
});

const CODEX_CHAT = {
  provider: "codex",
  instanceId: "codex",
  model: "gpt-6-astra",
  options: { reasoningEffort: "high" },
} as ModelSelection;
const WINDOWS_BLOCKED = { kind: "platform-blocked", platform: "win32" } as const;
const FORK_SUGGESTION = {
  suggestion: "Fix the fixture and rerun that test.",
  outcome: "suggested",
};

/** The person's own Codex account on Windows: the isolated path refuses it. */
const makeNativeHarness = (
  options: Omit<Parameters<typeof makeHarness>[0] & object, "modelSelection"> = {},
) => makeHarness({ modelSelection: CODEX_CHAT, isolatedSupport: WINDOWS_BLOCKED, ...options });

describe("ComposerPredictionServiceLive on Codex's native prediction fork", () => {
  it("forks the live thread with the shared rules at the lowest effort, never the isolated path", async () => {
    const harness = makeNativeHarness();

    await expect(harness.run(harness.generate)).resolves.toEqual(FORK_SUGGESTION);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
    expect(harness.getNextUserMessagePredictionSupport).toHaveBeenCalledWith(THREAD_ID);
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.predictNextUserMessage).toHaveBeenCalledWith(THREAD_ID, {
      prompt: buildComposerPredictionForkPrompt(),
      sourceTurnId: TURN_ID,
      generationTrigger: "live",
      effort: "low",
      timeoutMs: 20_000,
    });
  });

  it("keeps the isolated path first where it serves the chat's instance", async () => {
    const harness = makeHarness({ modelSelection: CODEX_CHAT });

    await expect(harness.run(harness.generate)).resolves.toEqual(FORK_SUGGESTION);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
    expect(harness.getNextUserMessagePredictionSupport).not.toHaveBeenCalled();
    expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
  });

  it("treats a fork reply that is not the JSON answer as a failed generation", async () => {
    const harness = makeNativeHarness();
    harness.predictNextUserMessage.mockReturnValue(
      Effect.succeed({ kind: "predicted", text: "Fix the fixture and rerun that test." }),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
    expect(harness.logs).toEqual([
      predictionLog("Warn", {
        route: "native",
        outcome: "generation-unavailable",
        reason: "native-invalid-reply",
        source: "git-writing-model",
      }),
    ]);
  });

  it("sanitizes the fork's suggestion and remembers its null answer for the turn", async () => {
    const harness = makeNativeHarness();
    harness.predictNextUserMessage
      .mockReturnValueOnce(Effect.succeed({ kind: "predicted", text: '{"suggestion":"/clear"}' }))
      .mockReturnValueOnce(Effect.succeed({ kind: "predicted", text: '{"suggestion":null}' }));

    const results = await harness.run(
      Effect.gen(function* () {
        const slash = yield* harness.generate;
        const declined = yield* harness.generateForNextTurn("turn-3");
        const declinedAgain = yield* harness.generateFor(TurnId.makeUnsafe("turn-3"));
        return [slash, declined, declinedAgain];
      }),
    );

    expect(results).toEqual([NONE, NONE, NONE]);
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(2);
  });

  it("logs a failed fork with its route and no provider detail", async () => {
    const harness = makeNativeHarness();
    harness.predictNextUserMessage.mockReturnValue(
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "thread/fork",
          detail: "User: secret prompt text",
        }),
      ),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
    expect(harness.logs).toEqual([
      predictionLog("Warn", {
        route: "native",
        outcome: "generation-unavailable",
        reason: "generation-failed",
        source: "git-writing-model",
      }),
    ]);
    expect(JSON.stringify(harness.logs)).not.toContain("secret");
  });

  it.each([
    [
      "native-parent-busy",
      "Info",
      "unavailable",
      { kind: "skipped", reason: "parent_turn_active" },
    ],
    [
      "native-parent-busy",
      "Info",
      "unavailable",
      { kind: "skipped", reason: "prediction_in_flight" },
    ],
    [
      "native-fork-unavailable",
      "Info",
      "unavailable",
      { kind: "unsupported", reason: "no_live_session" },
    ],
    // A rejected fork reached the provider: the client asks once more at most.
    [
      "native-fork-rejected",
      "Warn",
      "generation-unavailable",
      { kind: "unsupported", reason: "prediction_fork_rejected" },
    ],
  ] as const)(
    "is unavailable (%s) when the fork does not run",
    async (reason, level, outcome, result) => {
      const harness = makeNativeHarness();
      harness.predictNextUserMessage.mockReturnValue(Effect.succeed(result));

      await expect(harness.run(harness.generate)).resolves.toEqual({ suggestion: null, outcome });
      expect(harness.logs).toEqual([
        predictionLog(level, { route: "native", outcome, reason, source: "git-writing-model" }),
      ]);
    },
  );

  it("starts no second, racing fork and gives up at the timeout", async () => {
    const harness = makeNativeHarness();
    let interrupted = false;
    harness.predictNextUserMessage.mockReturnValue(
      Effect.never.pipe(
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust("19 seconds");
        expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(1);
        yield* TestClock.adjust("1 second");
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual(GENERATION_UNAVAILABLE);
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
    expect(interrupted).toBe(true);
  });

  it("shares one fork between concurrent requests and stops it after the last caller leaves", async () => {
    const harness = makeNativeHarness();
    const started = Deferred.makeUnsafe<void>();
    const release = Deferred.makeUnsafe<void>();
    harness.predictNextUserMessage.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(started, undefined)),
        Effect.andThen(Deferred.await(release)),
        Effect.as({ kind: "predicted" as const, text: '{"suggestion":"Shared fork"}' }),
      ),
    );

    const shared = await harness.run(
      Effect.gen(function* () {
        const first = yield* Effect.forkChild(harness.generate);
        const second = yield* Effect.forkChild(harness.generate);
        yield* Deferred.await(started);
        yield* Deferred.succeed(release, undefined);
        return [yield* Fiber.join(first), yield* Fiber.join(second)];
      }),
    );
    expect(shared).toEqual([
      { suggestion: "Shared fork", outcome: "suggested" },
      { suggestion: "Shared fork", outcome: "suggested" },
    ]);
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(1);

    const abandoned = makeNativeHarness();
    const abandonedStarted = Deferred.makeUnsafe<void>();
    let interrupted = false;
    abandoned.predictNextUserMessage.mockReturnValue(
      Effect.yieldNow.pipe(
        Effect.andThen(Deferred.succeed(abandonedStarted, undefined)),
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() =>
          Effect.sync(() => {
            interrupted = true;
          }),
        ),
      ),
    );
    const exit = await abandoned.run(
      Effect.gen(function* () {
        const only = yield* Effect.forkChild(abandoned.generate);
        yield* Deferred.await(abandonedStarted);
        yield* Fiber.interrupt(only);
        return yield* Fiber.await(only);
      }),
    );
    expect(Exit.isFailure(exit)).toBe(true);
    expect(interrupted).toBe(true);
    // Without this line a cancelled request looks like one that never came.
    expect(abandoned.logs).toEqual([
      predictionLog("Info", {
        route: "native",
        outcome: "cancelled",
        source: "git-writing-model",
      }),
    ]);
  });

  it("forks nothing for a request abandoned within the start delay", async () => {
    const harness = makeNativeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const exit = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        yield* TestClock.adjust(
          Duration.millis(Duration.toMillis(COMPOSER_PREDICTION_START_DELAY) - 1),
        );
        yield* Fiber.interrupt(fiber);
        yield* TestClock.adjust(COMPOSER_PREDICTION_START_DELAY);
        return yield* Fiber.await(fiber);
      }),
    );

    expect(Exit.isFailure(exit)).toBe(true);
    expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
  });

  it.each(["starting", "running"] as const)(
    "is unavailable without forking while the chat's session is %s",
    async (status) => {
      const harness = makeNativeHarness();
      const thread = harness.state.thread;
      harness.state.thread = {
        ...thread,
        session: { ...thread.session, status },
      } as OrchestrationThreadShell;

      await expect(harness.run(harness.generate)).resolves.toEqual(UNAVAILABLE);
      expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
    },
  );

  it("is unavailable when the session turns busy during the start delay, without forking", async () => {
    const harness = makeNativeHarness({ startDelay: COMPOSER_PREDICTION_START_DELAY });

    const result = await harness.run(
      Effect.gen(function* () {
        const fiber = yield* Effect.forkChild(harness.generate);
        const thread = harness.state.thread;
        harness.state.thread = {
          ...thread,
          session: { ...thread.session, status: "running" },
        } as OrchestrationThreadShell;
        yield* TestClock.adjust(COMPOSER_PREDICTION_START_DELAY);
        return yield* Fiber.join(fiber);
      }),
    );

    expect(result).toEqual(UNAVAILABLE);
    expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
  });

  it("discards a fork's suggestion when a new turn starts during generation, and keeps no answer", async () => {
    const harness = makeNativeHarness();
    harness.predictNextUserMessage.mockImplementationOnce(() =>
      Effect.sync(() => {
        harness.state.thread = makeThread(CODEX_CHAT, TurnId.makeUnsafe("turn-3"));
        return { kind: "predicted" as const, text: '{"suggestion":"Stale suggestion"}' };
      }),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const stale = yield* harness.generate;
        harness.state.thread = makeThread(CODEX_CHAT);
        return [stale, yield* harness.generate];
      }),
    );

    expect(results).toEqual([GENERATION_UNAVAILABLE, FORK_SUGGESTION]);
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(2);
  });

  it("does not serve a fork's answer once the isolated path can serve the chat", async () => {
    const support = { current: WINDOWS_BLOCKED as IsolatedTextGenerationSupport };
    const harness = makeNativeHarness();
    harness.getComposerPredictionSupport.mockImplementation(() =>
      Effect.sync(() => support.current),
    );
    harness.predictNextUserMessage.mockReturnValue(
      Effect.succeed({ kind: "predicted", text: '{"suggestion":"From the fork"}' }),
    );
    harness.generateComposerPrediction.mockReturnValue(
      Effect.succeed({ suggestion: "From the isolated path" }),
    );

    const results = await harness.run(
      Effect.gen(function* () {
        const fromFork = yield* harness.generate;
        support.current = { kind: "supported" };
        return [fromFork, yield* harness.generate];
      }),
    );

    expect(results).toEqual([
      { suggestion: "From the fork", outcome: "suggested" },
      { suggestion: "From the isolated path", outcome: "suggested" },
    ]);
  });

  it.each([
    ["native-no-live-session", { kind: "unsupported", reason: "no_live_session" }],
    ["native-cli-too-old", { kind: "unsupported", reason: "app_server_without_prediction_fork" }],
  ] as const)(
    "answers none at once and logs it at Info when no route can serve the chat (%s)",
    async (reason, nativeSupport) => {
      const harness = makeNativeHarness({
        nativeSupport,
        startDelay: COMPOSER_PREDICTION_START_DELAY,
      });

      // No start delay: the answer is known before anything would start.
      const results = await harness.run(Effect.all([harness.generate, harness.generate]));

      expect(results).toEqual([NONE, NONE]);
      expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
      expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
      expect(harness.logs).toEqual([
        predictionLog("Info", { route: "no-route", outcome: "none", reason }),
        predictionLog("Info", { route: "no-route", outcome: "none", reason }),
      ]);
    },
  );
});

describe("ComposerPredictionServiceLive after a turn that closed with a question", () => {
  const OWNER_MESSAGES = [
    { id: "user-1", role: "user", text: OWNER_REQUEST, streaming: false },
    { id: FINAL_REPLY, role: "assistant", text: OWNER_FINAL_REPLY, streaming: false },
  ] as unknown as OrchestrationMessage[];
  const OWNER_CLOSING_QUESTION =
    '[The assistant then asked the user: "现在的角色位置和大小合适吗？" Answer buttons offered: "保持这样", "调整位置".]';

  it("names the question to Codex's native fork on the owner's own account (Windows)", async () => {
    const harness = makeNativeHarness();
    harness.state.messages = OWNER_MESSAGES;
    harness.state.wrapUps = [OWNER_CODEX_WRAP_UP_ACTIVITY];
    harness.predictNextUserMessage.mockReturnValue(
      Effect.succeed({ kind: "predicted", text: '{"suggestion":"保持这样"}' }),
    );

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "保持这样",
      outcome: "suggested",
    });
    const prompt = harness.predictNextUserMessage.mock.calls[0]?.[1].prompt ?? "";
    expect(prompt).toBe(
      buildComposerPredictionForkPrompt({ closingQuestion: OWNER_CLOSING_QUESTION }),
    );
    expect(prompt).toContain(OWNER_CLOSING_QUESTION);
    expect(harness.logs).toEqual([
      predictionLog("Info", {
        route: "native",
        outcome: "suggested",
        source: "git-writing-model",
        closingQuestion: true,
      }),
    ]);
  });

  // Owner's decision 2026-11-17: on Windows the person's own Codex account cannot run the
  // isolated route, so a signed-in person's suggestion comes from Moss's own small model, a
  // direct HTTP request, before the slow native fork is tried.
  it("predicts the owner's own-Codex chat on Windows through the signed-in Moss model", async () => {
    const harness = makeHarness({
      modelSelection: {
        provider: "codex",
        instanceId: "codex",
        model: "gpt-6.1-terra",
        options: { reasoningEffort: "max" },
      } as ModelSelection,
      isolatedSupportByInstance: { codex: WINDOWS_BLOCKED, codex_moss: { kind: "supported" } },
      settings: {
        providerInstances: {
          codex_moss: {
            driver: "codex",
            enabled: true,
            displayName: "Moss",
            config: {
              managed: true,
              modelAllowlist: ["gpt-5.6-terra", "gpt-5.6-luna", "deepseek-v4-pro"],
              defaultModel: "gpt-5.6-terra",
            },
          },
        },
      } as Parameters<typeof ServerSettingsService.layerTest>[0],
    });
    harness.state.messages = OWNER_MESSAGES;
    harness.state.wrapUps = [OWNER_CODEX_WRAP_UP_ACTIVITY];

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Fix the fixture and rerun that test.",
      outcome: "suggested",
    });
    // The closing question from #646 reaches the Moss model's transcript.
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(1);
    expect(harness.generateComposerPrediction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: expect.stringContaining(OWNER_CLOSING_QUESTION),
        modelSelection: expect.objectContaining({
          provider: "codex",
          instanceId: "codex_moss",
          model: "gpt-5.6-luna",
        }),
      }),
    );
    // The fork is never asked once route 2 serves the chat.
    expect(harness.getNextUserMessagePredictionSupport).not.toHaveBeenCalled();
    expect(harness.predictNextUserMessage).not.toHaveBeenCalled();
    expect(harness.rawLogs).toEqual([
      predictionLog("Info", {
        route: "isolated",
        outcome: "suggested",
        source: "moss-model-for-own-account",
        model: "gpt-5.6-luna",
        effort: expect.any(String),
        closingQuestion: true,
      }),
    ]);
  });

  it("falls back to the native fork when the Moss route is not served (signed out)", async () => {
    const harness = makeHarness({
      modelSelection: CODEX_CHAT,
      isolatedSupportByInstance: { codex: WINDOWS_BLOCKED, codex_moss: WINDOWS_BLOCKED },
      settings: {
        providerInstances: {
          codex_moss: { driver: "codex", enabled: true, config: { managed: true } },
        },
      } as Parameters<typeof ServerSettingsService.layerTest>[0],
    });

    await harness.run(harness.generate);
    expect(harness.generateComposerPrediction).not.toHaveBeenCalled();
    expect(harness.predictNextUserMessage).toHaveBeenCalledTimes(1);
    expect(harness.rawLogs).toEqual([
      predictionLog("Info", {
        route: "native",
        outcome: "suggested",
        source: "prediction-model",
        model: "gpt-6-astra",
        effort: "low",
      }),
    ]);
  });

  it("closes the isolated transcript with the question in Claude's stored shape", async () => {
    const harness = makeHarness();
    harness.state.messages = OWNER_MESSAGES;
    harness.state.wrapUps = [OWNER_CLAUDE_WRAP_UP_ACTIVITY];

    await harness.run(harness.generate);

    expect(harness.generateComposerPrediction).toHaveBeenCalledWith(
      expect.objectContaining({
        conversation: [
          `User: ${OWNER_REQUEST}`,
          `Assistant: ${OWNER_FINAL_REPLY}`,
          OWNER_CLOSING_QUESTION,
        ].join("\n\n"),
      }),
    );
  });

  it("still predicts when the turn's wrap-up calls cannot be read", async () => {
    const harness = makeNativeHarness();
    harness.state.wrapUpsFail = true;

    await expect(harness.run(harness.generate)).resolves.toEqual(FORK_SUGGESTION);
    expect(harness.predictNextUserMessage.mock.calls[0]?.[1].prompt).toBe(
      buildComposerPredictionForkPrompt(),
    );
  });
});

describe("ComposerPredictionServiceLive when the smaller model is not served", () => {
  const OPUS_CHAT = {
    provider: "claudeAgent",
    instanceId: "claudeAgent",
    model: "claude-opus-5-5",
    options: { effort: "max" },
  } as ModelSelection;
  const notServed = () =>
    Effect.fail(
      new TextGenerationError({
        operation: "generateComposerPrediction",
        detail: "model claude-sonnet-5-5 is not available on this account",
      }),
    );

  it("asks the chat's own model once and answers from it", async () => {
    const harness = makeHarness({ modelSelection: OPUS_CHAT });
    harness.generateComposerPrediction
      .mockImplementationOnce(notServed)
      .mockImplementationOnce(() => Effect.succeed({ suggestion: "Ship the fix." }));

    await expect(harness.run(harness.generate)).resolves.toEqual({
      suggestion: "Ship the fix.",
      outcome: "suggested",
    });
    expect(
      harness.generateComposerPrediction.mock.calls.map(
        ([request]) => request.modelSelection?.model,
      ),
    ).toEqual(["claude-sonnet-5-5", "claude-opus-5-5"]);
    expect(harness.logs).toEqual([
      predictionLog("Info", {
        route: "isolated",
        outcome: "suggested",
        source: "prediction-model",
        fellBackToChatModel: true,
      }),
    ]);
  });

  it("answers generation-unavailable when the chat's own model fails too", async () => {
    const harness = makeHarness({ modelSelection: OPUS_CHAT });
    harness.generateComposerPrediction.mockImplementation(notServed);

    await expect(harness.run(harness.generate)).resolves.toEqual(GENERATION_UNAVAILABLE);
    expect(harness.generateComposerPrediction).toHaveBeenCalledTimes(2);
  });
});
