import { ThreadId, TurnId } from "@synara/contracts";
import { makeKeyedSingleFlightCache } from "@synara/shared/KeyedSingleFlightCache";
import { NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS } from "@synara/shared/nextMessagePrediction";
import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type {
  ProviderNextUserMessagePrediction,
  ProviderPredictNextUserMessageInput,
} from "../provider/Services/ProviderAdapter.ts";
import {
  buildNextMessagePredictionTranscript,
  isSupersededNextMessagePredictionKey,
  nextMessagePredictionCacheKey,
  predictNextMessage,
  type NextMessagePredictionThread,
} from "./nextMessagePrediction";
import {
  buildNextMessagePredictionForkPrompt,
  parseNextMessagePredictionResponse,
  sanitizeNextMessagePrediction,
} from "./textGenerationShared";

describe("sanitizeNextMessagePrediction", () => {
  it("keeps plain text", () => expect(sanitizeNextMessagePrediction(" 继续 ")).toBe("继续"));
  it("unwraps an echoed JSON envelope", () =>
    expect(sanitizeNextMessagePrediction('{"suggestion":"跑一下测试"}')).toBe("跑一下测试"));
  it("accepts the legacy text envelope during transition", () =>
    expect(sanitizeNextMessagePrediction('{"text":"跑一下测试"}')).toBe("跑一下测试"));
  it("treats an empty envelope as no prediction", () =>
    expect(sanitizeNextMessagePrediction('{"suggestion":null}')).toBe(""));
});

describe("parseNextMessagePredictionResponse", () => {
  it("reads Codex's {suggestion} response and trims it", () =>
    expect(parseNextMessagePredictionResponse(' {"suggestion":" 跑一下测试 "} ')).toBe(
      "跑一下测试",
    ));
  it("treats a null suggestion as the model abstaining", () =>
    expect(parseNextMessagePredictionResponse('{"suggestion":null}')).toBe(""));
  it("rejects anything but Codex's {suggestion} JSON", () => {
    expect(parseNextMessagePredictionResponse("跑一下测试")).toBeNull();
    expect(parseNextMessagePredictionResponse('{"text":"跑一下测试"}')).toBeNull();
    expect(parseNextMessagePredictionResponse('{"suggestion":42}')).toBeNull();
    expect(parseNextMessagePredictionResponse(null)).toBeNull();
  });
});

const threadId = ThreadId.makeUnsafe("thread_1");
const turnA = TurnId.makeUnsafe("turn_a");
const turnB = TurnId.makeUnsafe("turn_b");

const thread = (overrides?: Partial<NextMessagePredictionThread>): NextMessagePredictionThread => ({
  interactionMode: "default",
  workingDirectory: "C:\\work\\repo",
  messages: [
    { role: "user", text: "fix the flaky test" },
    { role: "assistant", text: "Fixed and pushed." },
  ],
  ...overrides,
});

function runPrediction(input: {
  readonly native: ProviderNextUserMessagePrediction;
  readonly thread?: NextMessagePredictionThread;
  readonly latestTurnId?: TurnId;
  readonly fallbackText?: string;
}) {
  const nativeCalls: ProviderPredictNextUserMessageInput[] = [];
  const transcripts: string[] = [];
  const program = Effect.gen(function* () {
    const cache = yield* makeKeyedSingleFlightCache<{ readonly text: string }, unknown>({
      maxEntries: 64,
      ttlMs: Number.POSITIVE_INFINITY,
    });
    const predict = (latestTurnId: TurnId) =>
      predictNextMessage({
        request: { threadId, latestTurnId, generationTrigger: "live" },
        thread: input.thread ?? thread(),
        modelKey: "gpt-5.3-codex",
        cache,
        predictNatively: (prediction) =>
          Effect.sync(() => {
            nativeCalls.push(prediction);
            return input.native;
          }),
        predictFromTranscript: (transcript) =>
          Effect.sync(() => {
            transcripts.push(transcript);
            return { text: input.fallbackText ?? '{"suggestion":"跑一下测试"}' };
          }),
      });
    const first = yield* predict(input.latestTurnId ?? turnA);
    const repeated = yield* predict(input.latestTurnId ?? turnA);
    const size = yield* cache.size;
    return { first, repeated, size };
  }).pipe(Effect.scoped);
  return Effect.runPromise(program).then((result) => ({ ...result, nativeCalls, transcripts }));
}

describe("predictNextMessage", () => {
  it("prefers the native fork with Codex's prompt and shares it per turn", async () => {
    const result = await runPrediction({
      native: { kind: "predicted", text: '{"suggestion":"再跑一遍"}' },
    });
    expect(result.first).toBe("再跑一遍");
    expect(result.repeated).toBe("再跑一遍");
    expect(result.nativeCalls).toEqual([
      {
        prompt: buildNextMessagePredictionForkPrompt(),
        sourceTurnId: turnA,
        generationTrigger: "live",
        timeoutMs: 30_000,
      },
    ]);
    expect(result.transcripts).toEqual([]);
  });

  it("uses the transcript fallback only when the runtime has no native prediction", async () => {
    const result = await runPrediction({
      native: { kind: "unsupported", reason: "provider_without_native_prediction" },
    });
    expect(result.first).toBe("跑一下测试");
    expect(result.transcripts).toEqual(["user: fix the flaky test\nassistant: Fixed and pushed."]);
  });

  it("fails a malformed native reply without caching it, so a refresh retries", async () => {
    const program = Effect.gen(function* () {
      const cache = yield* makeKeyedSingleFlightCache<{ readonly text: string }, unknown>({
        maxEntries: 64,
        ttlMs: Number.POSITIVE_INFINITY,
      });
      let calls = 0;
      const predict = predictNextMessage({
        request: { threadId, latestTurnId: turnA, generationTrigger: "live" },
        thread: thread(),
        modelKey: "gpt-5.3-codex",
        cache,
        predictNatively: () =>
          Effect.sync(() => {
            calls += 1;
            return { kind: "predicted", text: "Sure, run the tests." } as const;
          }),
        predictFromTranscript: () => Effect.die("unused"),
      });
      const first = yield* Effect.flip(predict);
      yield* Effect.flip(predict);
      return { message: (first as Error).message, calls, size: yield* cache.size };
    }).pipe(Effect.scoped);

    await expect(Effect.runPromise(program)).resolves.toEqual({
      message: "The prediction reply was not {suggestion} JSON.",
      calls: 2,
      size: { cached: 0, inFlight: 0 },
    });
  });

  it("shows nothing while the native thread is busy", async () => {
    const result = await runPrediction({
      native: { kind: "skipped", reason: "parent_turn_active" },
    });
    expect(result.first).toBe("");
    expect(result.transcripts).toEqual([]);
  });

  it("never predicts for a plan-mode thread, as Codex marks it ineligible", async () => {
    const result = await runPrediction({
      native: { kind: "predicted", text: '{"suggestion":"approve"}' },
      thread: thread({ interactionMode: "plan" }),
    });
    expect(result.first).toBe("");
    expect(result.nativeCalls).toEqual([]);
    expect(result.size).toEqual({ cached: 0, inFlight: 0 });
  });

  it("drops a thread's older-turn predictions when a newer turn is requested", async () => {
    const program = Effect.gen(function* () {
      const cache = yield* makeKeyedSingleFlightCache<{ readonly text: string }, unknown>({
        maxEntries: 64,
        ttlMs: Number.POSITIVE_INFINITY,
      });
      const predict = (latestTurnId: TurnId, target = thread()) =>
        predictNextMessage({
          request: { threadId, latestTurnId, generationTrigger: "catch_up" },
          thread: target,
          modelKey: "gpt-5.3-codex",
          cache,
          predictNatively: () =>
            Effect.succeed({
              kind: "predicted",
              text: `{"suggestion":"${latestTurnId}"}`,
            } as const),
          predictFromTranscript: () => Effect.die("unused"),
        });
      yield* predict(turnA);
      yield* predict(turnA, thread({ workingDirectory: "/other/checkout" }));
      const beforeNewTurn = yield* cache.size;
      yield* predict(turnB);
      const afterNewTurn = yield* cache.size;
      return { beforeNewTurn, afterNewTurn };
    }).pipe(Effect.scoped);

    // The other checkout's prediction for turn_a survives; only this host's older turn goes.
    await expect(Effect.runPromise(program)).resolves.toEqual({
      beforeNewTurn: { cached: 2, inFlight: 0 },
      afterNewTurn: { cached: 2, inFlight: 0 },
    });
  });
});

describe("next message prediction cache keys", () => {
  it("survive working directories that contain the old separator", () => {
    const scope = { hostKey: "C:\\work\\repo", threadId: "thread_1", latestTurnId: "turn_a" };
    const key = nextMessagePredictionCacheKey({ ...scope, modelKey: "gpt-5.3-codex" });
    expect(isSupersededNextMessagePredictionKey(key, scope)).toBe(false);
    expect(isSupersededNextMessagePredictionKey(key, { ...scope, latestTurnId: "turn_b" })).toBe(
      true,
    );
    expect(isSupersededNextMessagePredictionKey(key, { ...scope, threadId: "thread_2" })).toBe(
      false,
    );
    expect(isSupersededNextMessagePredictionKey("not json", scope)).toBe(false);
  });
});

describe("buildNextMessagePredictionTranscript", () => {
  it("keeps the newest messages within the fallback bound", () => {
    const transcript = buildNextMessagePredictionTranscript([
      { role: "user", text: "x".repeat(NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS) },
      { role: "assistant", text: "done" },
    ]);
    expect(transcript.endsWith("\nassistant: done")).toBe(true);
    expect(transcript.length).toBeLessThanOrEqual(NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS);
  });
});
