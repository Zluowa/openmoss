// FILE: ComposerPredictionService.ts (layer)
// Purpose: Composer predictions. Reads the thread from the projection, checks that the
//          expected turn is still the settled latest one, decides the generation route, and
//          asks the chat's own provider instance for one predicted next user message: through
//          the isolated text-generation path, or, for a Codex chat that path refuses on this
//          platform, through Codex's native prediction fork of the live thread. Decisions live
//          in `composerPrediction.ts`.
// Layer: Server service

import type {
  ComposerPredictionOutcome,
  OrchestrationThreadShell,
  ThreadId,
  TurnId,
} from "@moss/contracts";
import { Cause, Clock, Deferred, Duration, Effect, Fiber, Layer, Option, Schema } from "effect";

import { resolveThreadWorkspaceCwd } from "../../checkpointing/Utils.ts";
import { TextGenerationError } from "../../git/Errors.ts";
import {
  TextGeneration,
  type IsolatedTextGenerationSupport,
} from "../../git/Services/TextGeneration.ts";
import {
  buildComposerPredictionForkPrompt,
  COMPOSER_PREDICTION_CONTEXT_BUDGET,
  COMPOSER_PREDICTION_TIMEOUT_MS,
  parseComposerPredictionForkReply,
} from "../../git/textGenerationShared.ts";
import type { TextGenerationProviderInput } from "../../git/textGenerationSelection.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import type { ProviderNextUserMessagePredictionSupport } from "../../provider/Services/ProviderAdapter.ts";
import { ProviderService } from "../../provider/Services/ProviderService.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import {
  buildComposerPredictionConversation,
  formatComposerPredictionClosingQuestion,
  readComposerPredictionClosingQuestion,
  resolveComposerPredictionHedgeDelayMs,
  resolveComposerPredictionRoute,
  resolveComposerPredictionRoutingResult,
  resolveComposerPredictionTurnBlocker,
  type ComposerPredictionClosingQuestion,
  type ComposerPredictionNoRouteReason,
  type ComposerPredictionRoute,
  type ComposerPredictionRoutingFailure,
  type ComposerPredictionTurnBlocker,
} from "../composerPrediction.ts";
import {
  ComposerPredictionService,
  type ComposerPredictionServiceShape,
} from "../Services/ComposerPredictionService.ts";

/** A prediction that takes longer than this is no longer worth showing. */
export const COMPOSER_PREDICTION_TIMEOUT = Duration.millis(COMPOSER_PREDICTION_TIMEOUT_MS);

/**
 * How long a request waits before it reads the transcript and starts the provider CLI
 * (about 0.3 to 0.4 GB and 0.7 to 3 CPU seconds per run) or forks the live Codex thread. A
 * chat the user only passes through, or starts typing in, cancels the request inside this
 * window, so no process or fork starts; one that stays open gets its suggestion this much
 * later, after the work that opening the chat or settling the turn does.
 */
export const COMPOSER_PREDICTION_START_DELAY = Duration.seconds(1);

/** Answers kept so another window or device asking for the same turn starts no second CLI. */
const ANSWER_CACHE_LIMIT = 64;

/** Completed generation times kept per route to decide when a second attempt is worth it. */
const RECENT_DURATION_SAMPLES = 5;

interface ComposerPredictionAnswer {
  readonly suggestion: string | null;
  readonly outcome: ComposerPredictionOutcome;
}

/** Which route a request took, for its log line. */
type ComposerPredictionRouteKind = ComposerPredictionRoute["kind"];

/**
 * Why a request got no answer this time, one content-free code per miss. Routing is here
 * and not a `none` while it may still change for the same turn (settings, a session that
 * catches up with the chat), so a client must not remember it as the turn's answer.
 * The `native-*` codes are misses of Codex's native prediction fork.
 */
type ComposerPredictionUnavailableReason =
  | ComposerPredictionTurnBlocker
  | "no-routing"
  | "no-conversation"
  | "timeout"
  | "generation-failed"
  | "unexpected-failure"
  | "native-parent-busy"
  | "native-fork-unavailable"
  | "native-fork-rejected"
  | "native-invalid-reply";

/** Misses that point at the provider rather than at the thread's state. */
const FAILURE_REASONS: ReadonlySet<ComposerPredictionUnavailableReason> = new Set([
  "timeout",
  "generation-failed",
  "unexpected-failure",
  "native-fork-rejected",
  "native-invalid-reply",
]);

/** Why a request ended without a suggestion, when it is not the model's own `none`. */
type ComposerPredictionLogReason =
  | ComposerPredictionUnavailableReason
  | ComposerPredictionNoRouteReason
  | "cancelled";

/** A native-fork answer that is not a prediction, carried as its reason code. */
class NativePredictionMiss {
  readonly _tag = "NativePredictionMiss";
  constructor(readonly reason: ComposerPredictionUnavailableReason) {}
}

/** The model's own answer: a suggestion, or its decision that there is none. */
const modelAnswer = (suggestion: string | null): ComposerPredictionAnswer =>
  suggestion ? { suggestion, outcome: "suggested" } : { suggestion: null, outcome: "none" };

/**
 * The answer for a chat neither route can serve this turn. `none` settles the turn on the
 * client, so it does not ask again; see {@link ComposerPredictionNoRouteReason} for why the
 * reason holds for the rest of the turn. Never remembered here: the next request re-decides.
 */
const NO_ROUTE_ANSWER: ComposerPredictionAnswer = { suggestion: null, outcome: "none" };

/** The question of a turn whose box asked nothing, or whose wrap-up calls could not be read. */
const NO_CLOSING_QUESTION: ComposerPredictionClosingQuestion | null = null;

interface SharedPrediction {
  readonly result: Deferred.Deferred<ComposerPredictionAnswer>;
  fiber: Fiber.Fiber<void> | undefined;
  waiters: number;
}

const make = Effect.fnUntraced(function* (options: { readonly startDelay: Duration.Input }) {
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const serverSettings = yield* ServerSettingsService;
  const textGeneration = yield* TextGeneration;
  const providerService = yield* ProviderService;
  const layerScope = yield* Effect.scope;
  const pending = new Map<string, SharedPrediction>();
  // Keyed by provider instance and model: how long this route's generations usually take.
  const recentDurationsMs = new Map<string, ReadonlyArray<number>>();
  // Keyed by thread, turn and route, oldest first: the model's answer, including "none".
  const answers = new Map<string, string | null>();
  const rememberAnswer = (key: string, suggestion: string | null) => {
    answers.delete(key);
    answers.set(key, suggestion);
    for (const oldest of answers.keys()) {
      if (answers.size <= ANSWER_CACHE_LIMIT) break;
      answers.delete(oldest);
    }
  };
  const readThread = (threadId: ThreadId) =>
    snapshotQuery.getThreadShellById(threadId).pipe(Effect.map(Option.getOrUndefined));

  /** Everything the route decision needs, read without generating anything. */
  const decideRoute = (thread: OrchestrationThreadShell, cwd: string) =>
    Effect.gen(function* () {
      const routing = resolveComposerPredictionRoutingResult({
        thread,
        settings: yield* serverSettings.getSettings,
      });
      let isolatedSupport: IsolatedTextGenerationSupport | undefined;
      let nativeSupport: ProviderNextUserMessagePredictionSupport | undefined;
      if (routing.kind === "routed" && textGeneration.getComposerPredictionSupport) {
        isolatedSupport = yield* textGeneration.getComposerPredictionSupport({
          cwd,
          modelSelection: routing.routing.modelSelection,
          ...(routing.routing.providerOptions
            ? { providerOptions: routing.routing.providerOptions }
            : {}),
          ...(routing.routing.codexHomePath
            ? { codexHomePath: routing.routing.codexHomePath }
            : {}),
        });
      }
      if (
        routing.kind === "routed" &&
        isolatedSupport?.kind === "platform-blocked" &&
        routing.routing.modelSelection.provider === "codex"
      ) {
        nativeSupport = yield* providerService.getNextUserMessagePredictionSupport(thread.id).pipe(
          Effect.orElseSucceed(
            (): ProviderNextUserMessagePredictionSupport => ({
              kind: "unsupported",
              reason: "no_live_session",
            }),
          ),
        );
      }
      return resolveComposerPredictionRoute({
        routing,
        chatModel: thread.modelSelection.model,
        isolatedSupport,
        nativeSupport,
      });
    });

  const generateOnce = (
    threadId: ThreadId,
    expectedTurnId: TurnId,
  ): Effect.Effect<ComposerPredictionAnswer> => {
    // What the request's one log line reports. Ids, codes and a duration only: never the
    // conversation, the suggestion, or provider detail (a CLI or app-server error can echo
    // prompt or reply text).
    const facts: {
      route?: ComposerPredictionRouteKind;
      routingReason?: ComposerPredictionRoutingFailure;
      source?: string;
      closingQuestion?: true;
      cached?: true;
      generationRan?: true;
      fellBack?: true;
    } = {};
    let startedAtMs = 0;
    const log = (answer: ComposerPredictionAnswer, reason?: ComposerPredictionLogReason) =>
      Effect.gen(function* () {
        const durationMs = (yield* Clock.currentTimeMillis) - startedAtMs;
        const failed =
          reason !== undefined &&
          FAILURE_REASONS.has(reason as ComposerPredictionUnavailableReason);
        yield* (failed ? Effect.logWarning : Effect.logInfo)("Composer prediction", {
          threadId,
          expectedTurnId,
          route: facts.route ?? "none",
          outcome: reason === "cancelled" ? "cancelled" : answer.outcome,
          ...(reason !== undefined && reason !== "cancelled" ? { reason } : {}),
          ...(facts.routingReason ? { routingReason: facts.routingReason } : {}),
          ...(facts.source ? { source: facts.source } : {}),
          ...(facts.closingQuestion ? { closingQuestion: true } : {}),
          ...(facts.cached ? { cached: true } : {}),
          ...(facts.fellBack ? { fellBackToChatModel: true } : {}),
          durationMs,
        });
        return answer;
      });

    // A miss the client may ask again about. Once a generation ran (or may have: a timeout,
    // a provider failure), it asks fewer times, since every retry pays for the provider again.
    const unavailable = (reason: ComposerPredictionUnavailableReason) =>
      log(
        {
          suggestion: null,
          outcome:
            facts.generationRan || FAILURE_REASONS.has(reason)
              ? "generation-unavailable"
              : "unavailable",
        },
        reason,
      );

    // A setup fact for the rest of the turn, logged at Info like every other answer.
    const noRoute = (reason: ComposerPredictionNoRouteReason) => log(NO_ROUTE_ANSWER, reason);

    return Effect.gen(function* () {
      startedAtMs = yield* Clock.currentTimeMillis;
      const thread = yield* readThread(threadId);
      const blocker = resolveComposerPredictionTurnBlocker(thread, expectedTurnId);
      if (blocker !== null) return yield* unavailable(blocker);
      const finalReplyMessageId = thread?.latestTurn?.assistantMessageId;
      if (!thread || !finalReplyMessageId) return yield* unavailable("turn-incomplete");

      const project = yield* snapshotQuery.getProjectShellById(thread.projectId);
      const cwd =
        (Option.isSome(project)
          ? resolveThreadWorkspaceCwd({ thread, projects: [project.value] })
          : undefined) ?? process.cwd();
      const route = yield* decideRoute(thread, cwd);
      facts.route = route.kind;
      if (route.kind === "no-route") return yield* noRoute(route.reason);
      if (route.kind === "unrouted") {
        facts.routingReason = route.reason;
        return yield* unavailable("no-routing");
      }
      facts.source = route.routing.source;
      const routeKey = JSON.stringify([
        route.kind,
        route.routing.modelSelection.instanceId ?? route.routing.modelSelection.provider,
        route.kind === "native" ? thread.modelSelection.model : route.routing.modelSelection.model,
      ]);
      // The route is part of the key, so an answer from one route is never served for another.
      const answerKey = JSON.stringify([threadId, expectedTurnId, routeKey]);
      if (answers.has(answerKey)) {
        facts.cached = true;
        return yield* log(modelAnswer(answers.get(answerKey) ?? null));
      }

      yield* Effect.sleep(options.startDelay);
      const delayedBlocker = resolveComposerPredictionTurnBlocker(
        yield* readThread(threadId),
        expectedTurnId,
      );
      if (delayedBlocker !== null) return yield* unavailable(delayedBlocker);

      const context = yield* snapshotQuery.getThreadMentionContextById(threadId, {
        messageLimit: COMPOSER_PREDICTION_CONTEXT_BUDGET.messageLimit,
      });
      const closingQuestion = yield* snapshotQuery
        .listWrapUpActivitiesByTurn(threadId, expectedTurnId)
        .pipe(
          Effect.map(readComposerPredictionClosingQuestion),
          Effect.orElseSucceed(() => NO_CLOSING_QUESTION),
        );
      if (closingQuestion !== null) facts.closingQuestion = true;
      const conversation = Option.isSome(context)
        ? buildComposerPredictionConversation({
            messages: context.value.messages,
            finalReplyMessageId,
            closingQuestion,
          })
        : null;
      // The native fork reads the thread itself, but it predicts from the same settled reply.
      if (!conversation) return yield* unavailable("no-conversation");

      const generation: Effect.Effect<
        { readonly suggestion: string | null },
        NativePredictionMiss | TextGenerationError
      > =
        route.kind === "native"
          ? nativeGeneration(threadId, expectedTurnId, route.effort, closingQuestion)
          : isolatedGeneration(route.routing, routeKey, cwd, conversation, () => {
              facts.fellBack = true;
            });
      const generated = yield* generation.pipe(Effect.timeoutOption(COMPOSER_PREDICTION_TIMEOUT));
      if (Option.isNone(generated)) return yield* unavailable("timeout");
      facts.generationRan = true;

      // The thread may have moved on while the model was thinking.
      const settledBlocker = resolveComposerPredictionTurnBlocker(
        yield* readThread(threadId),
        expectedTurnId,
      );
      if (settledBlocker !== null) return yield* unavailable(settledBlocker);
      // Only a real answer from the model is remembered, "none" included.
      rememberAnswer(answerKey, generated.value.suggestion);
      return yield* log(modelAnswer(generated.value.suggestion));
    }).pipe(
      // Every caller left (the chat or turn changed) before an answer. Say so, or the log
      // reads as if no request came.
      Effect.onInterrupt(() =>
        log({ suggestion: null, outcome: "unavailable" }, "cancelled").pipe(Effect.asVoid),
      ),
      Effect.catchCause((cause) => {
        if (Cause.hasInterruptsOnly(cause)) return Effect.interrupt;
        const error = Cause.squash(cause);
        if (error instanceof NativePredictionMiss) return unavailable(error.reason);
        // No provider detail: a CLI failure message can echo prompt or reply text.
        return unavailable(
          Schema.is(TextGenerationError)(error) ? "generation-failed" : "unexpected-failure",
        );
      }),
    );
  };

  // One fork of the live thread at a time: unlike the isolated route, no second attempt races
  // the first, and the Codex manager refuses a second fork of a session while one runs.
  const nativeGeneration = (
    threadId: ThreadId,
    expectedTurnId: TurnId,
    effort: string | null,
    closingQuestion: ComposerPredictionClosingQuestion | null,
  ): Effect.Effect<{ readonly suggestion: string | null }, NativePredictionMiss> =>
    providerService
      .predictNextUserMessage(threadId, {
        prompt: buildComposerPredictionForkPrompt({
          closingQuestion:
            closingQuestion === null
              ? null
              : formatComposerPredictionClosingQuestion(closingQuestion),
        }),
        sourceTurnId: expectedTurnId,
        generationTrigger: "live",
        effort,
        timeoutMs: COMPOSER_PREDICTION_TIMEOUT_MS,
      })
      .pipe(
        // No provider detail: an app-server error can echo prompt or reply text.
        Effect.mapError(() => new NativePredictionMiss("generation-failed")),
        Effect.flatMap((result) => {
          if (result.kind === "skipped") {
            return Effect.fail(new NativePredictionMiss("native-parent-busy"));
          }
          if (result.kind === "unsupported") {
            return Effect.fail(
              new NativePredictionMiss(
                result.reason === "prediction_fork_rejected"
                  ? "native-fork-rejected"
                  : "native-fork-unavailable",
              ),
            );
          }
          const reply = parseComposerPredictionForkReply(result.text);
          return reply.ok
            ? Effect.succeed({ suggestion: reply.suggestion })
            : Effect.fail(new NativePredictionMiss("native-invalid-reply"));
        }),
      );

  const isolatedGeneration = (
    routing: Extract<ComposerPredictionRoute, { readonly kind: "isolated" }>["routing"],
    routeKey: string,
    cwd: string,
    conversation: string,
    onFallback: () => void,
  ) => {
    const generateWith = (input: TextGenerationProviderInput) =>
      textGeneration.generateComposerPrediction({
        cwd,
        conversation,
        modelSelection: input.modelSelection,
        ...(input.providerOptions ? { providerOptions: input.providerOptions } : {}),
        ...(input.codexHomePath ? { codexHomePath: input.codexHomePath } : {}),
      });
    const fallback = routing.fallback;
    const attempt = Effect.gen(function* () {
      const startedAt = yield* Clock.currentTimeMillis;
      // A smaller model the account does not serve fails; the chat's own model then gets one
      // try before the request answers `generation-unavailable`.
      const result = yield* generateWith(routing).pipe(
        Effect.catch((error) =>
          fallback
            ? Effect.sync(onFallback).pipe(Effect.andThen(generateWith(fallback)))
            : Effect.fail(error),
        ),
      );
      const elapsedMs = (yield* Clock.currentTimeMillis) - startedAt;
      recentDurationsMs.set(
        routeKey,
        [...(recentDurationsMs.get(routeKey) ?? []), elapsedMs].slice(-RECENT_DURATION_SAMPLES),
      );
      return result;
    });
    // A provider backend sometimes stalls for many seconds on a request that normally takes
    // three. Once the route's usual time has clearly passed, a second attempt races the
    // first. The first one keeps its normal outcome (a fast failure still fails fast); a
    // second attempt that fails is ignored, so it can never cancel a first one that is
    // still on its way. A route that is slow by nature gets no second attempt.
    const hedgeDelayMs = resolveComposerPredictionHedgeDelayMs({
      recentDurationsMs: recentDurationsMs.get(routeKey) ?? [],
      timeoutMs: Duration.toMillis(COMPOSER_PREDICTION_TIMEOUT),
    });
    return hedgeDelayMs === null
      ? attempt
      : Effect.raceFirst(
          attempt,
          Effect.delay(attempt, Duration.millis(hedgeDelayMs)).pipe(
            Effect.catchCause((cause) =>
              Cause.hasInterruptsOnly(cause) ? Effect.interrupt : Effect.never,
            ),
          ),
        );
  };

  // One generation per thread and turn. Every caller awaits the same result;
  // the generation is interrupted only once no caller is still waiting.
  const generateShared = (threadId: ThreadId, expectedTurnId: TurnId) =>
    Effect.uninterruptibleMask((restore) =>
      Effect.gen(function* () {
        const key = JSON.stringify([threadId, expectedTurnId]);
        let shared = pending.get(key);
        if (!shared) {
          const created: SharedPrediction = {
            result: Deferred.makeUnsafe<ComposerPredictionAnswer>(),
            fiber: undefined,
            waiters: 0,
          };
          pending.set(key, created);
          created.fiber = yield* generateOnce(threadId, expectedTurnId).pipe(
            // Leave the map before waking the waiters, so a request that arrives once this
            // one is answered starts afresh (or reads the remembered answer) instead of
            // joining a finished generation.
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (pending.get(key) === created) pending.delete(key);
              }).pipe(Effect.andThen(Deferred.done(created.result, exit))),
            ),
            Effect.asVoid,
            Effect.forkIn(layerScope),
          );
          shared = created;
        }
        const current = shared;
        current.waiters += 1;
        return yield* restore(Deferred.await(current.result)).pipe(
          Effect.onInterrupt(() =>
            Effect.suspend(() => {
              current.waiters -= 1;
              if (current.waiters > 0 || Deferred.isDoneUnsafe(current.result)) return Effect.void;
              if (pending.get(key) === current) pending.delete(key);
              return current.fiber ? Fiber.interrupt(current.fiber) : Effect.void;
            }),
          ),
        );
      }),
    );

  const generate: ComposerPredictionServiceShape["generate"] = (input) =>
    generateShared(input.threadId, input.expectedTurnId);

  return { generate } satisfies ComposerPredictionServiceShape;
});

export const makeComposerPredictionServiceLive = (
  options: { readonly startDelay?: Duration.Input } = {},
) =>
  Layer.effect(
    ComposerPredictionService,
    make({ startDelay: options.startDelay ?? COMPOSER_PREDICTION_START_DELAY }),
  );

export const ComposerPredictionServiceLive = makeComposerPredictionServiceLive();
