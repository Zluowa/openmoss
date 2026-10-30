import { randomBytes } from "node:crypto";

import {
  CommandId,
  EventId,
  SECRET_REQUEST_ACTIVITY_KIND,
  SECRET_REQUEST_ERROR_CODES,
  SECRET_REQUEST_FILE_TTL_MS,
  SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
  type SecretRequestActivityPayload,
  type SecretRequestOutcome,
  type ThreadId,
  type TurnId,
} from "@synara/contracts";
import { Clock, Deferred, Duration, Effect, Exit, FileSystem, Layer, Option, Path } from "effect";

import { ServerConfig } from "../../config.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import {
  SecretRequestError,
  SecretRequests,
  type SecretRequestFailureCode,
  type SecretRequestResult,
  type SecretRequestsShape,
} from "../Services/SecretRequests.ts";

/** A stuck turn must not crowd out every other chat's cards. */
export const SECRET_REQUEST_THREAD_PENDING_LIMIT = 4;
export const SECRET_REQUEST_GLOBAL_PENDING_LIMIT = 64;
const SWEEP_INTERVAL = Duration.hours(1);
const FILE_NAME_PATTERN = /^[0-9a-f]{32}(\.partial)?$/;

const TIMED_OUT: SecretRequestResult = { outcome: "timed_out" };
const CANCELLED: SecretRequestResult = { outcome: "cancelled" };
const DECLINED: SecretRequestResult = { outcome: "declined" };

const OUTCOME_SUMMARY: Record<SecretRequestOutcome, string> = {
  saved: "saved",
  declined: "declined",
  cancelled: "request ended",
  timed_out: "no answer in time",
};

interface PendingRequest {
  readonly threadId: ThreadId;
  readonly fileName: string;
  readonly deferred: Deferred.Deferred<SecretRequestResult>;
  /** Set while an answer is being stored, so a second answer cannot race it. */
  answering: boolean;
}

const failure = (code: SecretRequestFailureCode, message: string, cause?: unknown) =>
  new SecretRequestError({ code, message, ...(cause === undefined ? {} : { cause }) });

export const makeSecretRequests = Effect.gen(function* () {
  const fileSystem = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const serverConfig = yield* ServerConfig;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const layerScope = yield* Effect.scope;
  // Inside the secret store's owner-only directory, under the same cleanup rules.
  const directory = path.join(serverConfig.secretsDir, "requests");
  const pending = new Map<string, PendingRequest>();

  const publishCard = (
    threadId: ThreadId,
    turnId: TurnId | null,
    payload: SecretRequestActivityPayload,
  ) => {
    const key = `${payload.requestId}:${payload.outcome === undefined ? "requested" : "resolved"}`;
    const createdAt = new Date().toISOString();
    return orchestrationEngine.dispatch({
      type: "thread.activity.append",
      commandId: CommandId.makeUnsafe(key),
      threadId,
      activity: {
        id: EventId.makeUnsafe(key),
        tone: "info",
        kind:
          payload.outcome === undefined
            ? SECRET_REQUEST_ACTIVITY_KIND
            : SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
        summary:
          payload.outcome === undefined
            ? `Asking for a secret: ${payload.label}`
            : `Secret request for ${payload.label}: ${OUTCOME_SUMMARY[payload.outcome]}`,
        payload: {
          requestId: payload.requestId,
          label: payload.label,
          reason: payload.reason,
          ...(payload.placeholder === undefined ? {} : { placeholder: payload.placeholder }),
          ...(payload.outcome === undefined ? {} : { outcome: payload.outcome }),
        } satisfies SecretRequestActivityPayload,
        turnId,
        createdAt,
      },
      createdAt,
    });
  };

  const writeSecretFile = (fileName: string, value: string) =>
    Effect.gen(function* () {
      const file = path.join(directory, fileName);
      const partial = `${file}.partial`;
      yield* fileSystem.makeDirectory(directory, { recursive: true, mode: 0o700 });
      if (process.platform !== "win32") yield* fileSystem.chmod(directory, 0o700);
      yield* fileSystem.remove(partial, { force: true });
      // `wx` never follows or replaces an existing path; the rename publishes a complete file.
      yield* fileSystem.writeFile(partial, new TextEncoder().encode(value), {
        flag: "wx",
        mode: 0o600,
      });
      yield* fileSystem.rename(partial, file);
      return file;
    });

  const removeFile = (file: string) =>
    fileSystem
      .remove(file, { force: true })
      .pipe(
        Effect.catch((error) =>
          Effect.logWarning("Could not delete a secret request file", { error: error.message }),
        ),
      );

  // The answer landed after its caller stopped listening, so nobody will read the file.
  const discardUndelivered = (deferred: Deferred.Deferred<SecretRequestResult>) =>
    Deferred.await(deferred).pipe(
      Effect.flatMap((result) =>
        result.outcome === "saved" ? removeFile(result.file) : Effect.void,
      ),
    );

  const request: SecretRequestsShape["request"] = (input) =>
    Effect.gen(function* () {
      let threadPending = 0;
      for (const entry of pending.values()) {
        if (entry.threadId === input.threadId) threadPending += 1;
      }
      if (
        threadPending >= SECRET_REQUEST_THREAD_PENDING_LIMIT ||
        pending.size >= SECRET_REQUEST_GLOBAL_PENDING_LIMIT
      ) {
        return yield* failure(
          "queue_full",
          "Too many secret requests are already waiting. Ask again after the user answers one.",
        );
      }
      const fileName = randomBytes(16).toString("hex");
      const requestId = `secret-request:${fileName}`;
      const deferred = yield* Deferred.make<SecretRequestResult>();
      const card: SecretRequestActivityPayload = {
        requestId,
        label: input.label,
        reason: input.reason,
        ...(input.placeholder === undefined ? {} : { placeholder: input.placeholder }),
      };
      let shown = false;
      pending.set(requestId, { threadId: input.threadId, fileName, deferred, answering: false });

      return yield* Effect.gen(function* () {
        yield* publishCard(input.threadId, input.turnId, card).pipe(
          Effect.mapError((cause) =>
            failure("publish_failed", "Could not show the secret request in the thread.", cause),
          ),
        );
        shown = true;
        const answered = yield* Deferred.await(deferred).pipe(
          Effect.timeoutOption(Duration.millis(input.waitMs)),
        );
        if (Option.isSome(answered)) return answered.value;
        // An answer that lands as the wait ends still wins: its file is already written.
        return (yield* Deferred.succeed(deferred, TIMED_OUT))
          ? TIMED_OUT
          : yield* Deferred.await(deferred);
      }).pipe(
        Effect.onInterrupt(() =>
          Deferred.succeed(deferred, CANCELLED).pipe(
            Effect.flatMap((closed) => (closed ? Effect.void : discardUndelivered(deferred))),
          ),
        ),
        Effect.onExit((exit) => {
          pending.delete(requestId);
          if (!shown) return Effect.void;
          const outcome = Exit.isSuccess(exit) ? exit.value.outcome : "cancelled";
          // Closing the card is best effort and must never hold up a Stop.
          return publishCard(input.threadId, input.turnId, { ...card, outcome }).pipe(
            Effect.catch((error) =>
              Effect.logWarning("Could not close a secret request card", {
                requestId,
                error: error.message,
              }),
            ),
            Effect.forkIn(layerScope),
            Effect.asVoid,
          );
        }),
      );
    });

  const answer: SecretRequestsShape["answer"] = (input) =>
    Effect.gen(function* () {
      const claim = yield* Effect.sync(() => {
        const entry = pending.get(input.requestId);
        if (entry === undefined || entry.threadId !== input.threadId) return "missing" as const;
        if (entry.answering || Deferred.isDoneUnsafe(entry.deferred)) return "answered" as const;
        entry.answering = true;
        return entry;
      });
      if (claim === "missing") {
        return yield* failure(
          SECRET_REQUEST_ERROR_CODES.notFound,
          "This request is no longer waiting for an answer.",
        );
      }
      if (claim === "answered") {
        return yield* failure(
          SECRET_REQUEST_ERROR_CODES.alreadyAnswered,
          "This request was already answered.",
        );
      }
      if (input.answer.type === "decline") {
        if (yield* Deferred.succeed(claim.deferred, DECLINED)) return;
        return yield* failure(SECRET_REQUEST_ERROR_CODES.ended, "This request has already ended.");
      }
      const file = yield* writeSecretFile(claim.fileName, input.answer.secret).pipe(
        Effect.tapError(() =>
          Effect.sync(() => {
            claim.answering = false;
          }),
        ),
        Effect.mapError((cause) =>
          failure(SECRET_REQUEST_ERROR_CODES.storeFailed, "Could not store the secret.", cause),
        ),
      );
      const expiresAt = new Date(
        (yield* Clock.currentTimeMillis) + SECRET_REQUEST_FILE_TTL_MS,
      ).toISOString();
      if (yield* Deferred.succeed(claim.deferred, { outcome: "saved", file, expiresAt })) return;
      yield* removeFile(file);
      return yield* failure(
        SECRET_REQUEST_ERROR_CODES.ended,
        "The agent that asked has stopped, so the secret was not kept.",
      );
    }).pipe(
      // A dropped socket must not strand a half-stored answer or a claimed card.
      Effect.uninterruptible,
    );

  const sweepExpired = Effect.gen(function* () {
    if (!(yield* fileSystem.exists(directory))) return;
    const now = yield* Clock.currentTimeMillis;
    for (const name of yield* fileSystem.readDirectory(directory)) {
      if (!FILE_NAME_PATTERN.test(name)) continue;
      const file = path.join(directory, name);
      const { mtime } = yield* fileSystem.stat(file);
      if (mtime !== undefined && now - mtime.getTime() <= SECRET_REQUEST_FILE_TTL_MS) continue;
      yield* removeFile(file);
    }
  }).pipe(
    Effect.catch((error) =>
      Effect.logWarning("Could not sweep expired secret request files", { error: error.message }),
    ),
  );
  yield* Effect.forkScoped(
    sweepExpired.pipe(
      Effect.andThen(
        Effect.forever(Effect.sleep(SWEEP_INTERVAL).pipe(Effect.andThen(sweepExpired))),
      ),
    ),
  );

  return { request, answer } satisfies SecretRequestsShape;
});

export const SecretRequestsLive = Layer.effect(SecretRequests, makeSecretRequests);
