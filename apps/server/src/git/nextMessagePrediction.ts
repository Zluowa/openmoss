import type {
  NextMessagePredictionGenerationTrigger,
  ProviderInteractionMode,
  ThreadId,
  TurnId,
} from "@synara/contracts";
import type { KeyedSingleFlightCache } from "@synara/shared/KeyedSingleFlightCache";
import {
  NEXT_MESSAGE_PREDICTION_TIMEOUT_MS,
  NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS,
} from "@synara/shared/nextMessagePrediction";
import { Effect } from "effect";

import type {
  ProviderNextUserMessagePrediction,
  ProviderPredictNextUserMessageInput,
} from "../provider/Services/ProviderAdapter.ts";
import {
  buildNextMessagePredictionForkPrompt,
  parseNextMessagePredictionResponse,
  sanitizeNextMessagePrediction,
} from "./textGenerationShared.ts";

export interface NextMessagePredictionRequest {
  readonly threadId: ThreadId;
  readonly latestTurnId: TurnId;
  readonly generationTrigger: NextMessagePredictionGenerationTrigger;
}

export interface NextMessagePredictionThread {
  readonly interactionMode: ProviderInteractionMode;
  readonly workingDirectory?: string | null | undefined;
  readonly messages: ReadonlyArray<{ readonly role: string; readonly text: string }>;
}

export type NextMessagePredictionCache = KeyedSingleFlightCache<{ readonly text: string }, unknown>;

interface NextMessagePredictionScope {
  readonly hostKey: string;
  readonly threadId: string;
  readonly latestTurnId: string;
}

/** The newest messages of the thread, bounded for the provider-neutral fallback prompt. */
export function buildNextMessagePredictionTranscript(
  messages: NextMessagePredictionThread["messages"],
): string {
  const parts: string[] = [];
  let length = 0;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (!message) continue;
    const remaining = NEXT_MESSAGE_PREDICTION_TRANSCRIPT_MAX_CHARS - length;
    if (remaining <= 0) break;
    const line = `${message.role}: ${message.text}`;
    parts.push(line.slice(-remaining));
    length += Math.min(line.length, remaining) + 1;
  }
  return parts.toReversed().join("\n");
}

/** Codex keys predictions by host, thread and latest turn; Moss adds the routed model. */
export function nextMessagePredictionCacheKey(
  scope: NextMessagePredictionScope & { readonly modelKey: string },
): string {
  return JSON.stringify([scope.hostKey, scope.threadId, scope.latestTurnId, scope.modelKey]);
}

/** Codex drops a thread's predictions for every older turn when a newer turn is requested. */
export function isSupersededNextMessagePredictionKey(
  key: string,
  scope: NextMessagePredictionScope,
): boolean {
  let parsed: unknown;
  try {
    parsed = JSON.parse(key);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  const [hostKey, threadId, latestTurnId] = parsed;
  return (
    hostKey === scope.hostKey && threadId === scope.threadId && latestTurnId !== scope.latestTurnId
  );
}

/**
 * Predicts the user's next message the way Codex desktop does: a plan-mode thread is ineligible,
 * one prediction is shared per host/thread/turn, and a native prediction fork of the live thread
 * is preferred. Runtimes without one use the bounded transcript prompt instead.
 */
export const predictNextMessage = <R>(input: {
  readonly request: NextMessagePredictionRequest;
  readonly thread: NextMessagePredictionThread;
  readonly modelKey: string;
  readonly cache: NextMessagePredictionCache;
  readonly predictNatively: (
    prediction: ProviderPredictNextUserMessageInput,
  ) => Effect.Effect<ProviderNextUserMessagePrediction, unknown, R>;
  readonly predictFromTranscript: (
    transcript: string,
  ) => Effect.Effect<{ readonly text: string }, unknown, R>;
}): Effect.Effect<string, unknown, R> =>
  Effect.gen(function* () {
    if (input.thread.interactionMode === "plan") return "";
    const scope: NextMessagePredictionScope = {
      hostKey: input.thread.workingDirectory ?? "default",
      threadId: input.request.threadId,
      latestTurnId: input.request.latestTurnId,
    };
    yield* input.cache.invalidateWhere((key) => isSupersededNextMessagePredictionKey(key, scope));
    const generated = yield* input.cache.get(
      nextMessagePredictionCacheKey({ ...scope, modelKey: input.modelKey }),
      Effect.gen(function* () {
        const native = yield* input.predictNatively({
          prompt: buildNextMessagePredictionForkPrompt(),
          sourceTurnId: input.request.latestTurnId,
          generationTrigger: input.request.generationTrigger,
          timeoutMs: NEXT_MESSAGE_PREDICTION_TIMEOUT_MS,
        });
        if (native.kind === "predicted") {
          const suggestion = parseNextMessagePredictionResponse(native.text);
          // Unlike an abstention, a malformed reply is not cached, so a later refresh retries.
          if (suggestion === null) {
            return yield* Effect.fail(new Error("The prediction reply was not {suggestion} JSON."));
          }
          return { text: suggestion };
        }
        if (native.kind === "skipped") return { text: "" };
        const fallback = yield* input.predictFromTranscript(
          buildNextMessagePredictionTranscript(input.thread.messages),
        );
        return { text: sanitizeNextMessagePrediction(fallback.text) };
      }),
    );
    return generated.text;
  });
