import { promises as fs } from "node:fs";
import path from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  SECRET_REQUEST_ACTIVITY_KIND,
  SECRET_REQUEST_ERROR_CODES,
  SECRET_REQUEST_FILE_TTL_MS,
  SECRET_REQUEST_RESOLVED_ACTIVITY_KIND,
  ThreadId,
  TurnId,
  type OrchestrationCommand,
  type SecretRequestActivityPayload,
} from "@synara/contracts";
import { assert, describe, it } from "@effect/vitest";
import { Effect, Fiber, Layer, Queue } from "effect";
import { TestClock } from "effect/testing";

import { ServerConfig } from "../../config.ts";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine.ts";
import { SecretRequestError, SecretRequests } from "../Services/SecretRequests.ts";
import { SECRET_REQUEST_THREAD_PENDING_LIMIT, SecretRequestsLive } from "./SecretRequests.ts";

const THREAD = ThreadId.makeUnsafe("thread-secret");
const TURN = TurnId.makeUnsafe("turn-secret");
const VALUE = "ghp_secret-value-that-must-stay-private";

type ActivityCommand = Extract<OrchestrationCommand, { readonly type: "thread.activity.append" }>;

const makeEngine = Effect.gen(function* () {
  const cards = yield* Queue.unbounded<ActivityCommand>();
  const dispatched: Array<OrchestrationCommand> = [];
  const engine = {
    dispatch: (command: OrchestrationCommand) =>
      Effect.gen(function* () {
        dispatched.push(command);
        if (command.type === "thread.activity.append") yield* Queue.offer(cards, command);
        return { sequence: dispatched.length };
      }),
  } as unknown as OrchestrationEngineShape;
  return { cards, dispatched, layer: Layer.succeed(OrchestrationEngineService, engine) };
});

const configLayer = Layer.provideMerge(
  ServerConfig.layerTest(process.cwd(), { prefix: "moss-secret-requests-test-" }),
  NodeServices.layer,
);

/** Runs `body` against a live service whose cards land in `cards`. */
const withSecretRequests = <A, E>(
  body: (input: {
    readonly cards: Queue.Queue<ActivityCommand>;
    readonly dispatched: ReadonlyArray<OrchestrationCommand>;
  }) => Effect.Effect<A, E, SecretRequests | ServerConfig>,
) =>
  Effect.gen(function* () {
    const engine = yield* makeEngine;
    return yield* body(engine).pipe(
      Effect.provide(SecretRequestsLive.pipe(Layer.provideMerge(engine.layer))),
    );
  }).pipe(Effect.provide(configLayer));

const nextCard = (cards: Queue.Queue<ActivityCommand>) =>
  Queue.take(cards).pipe(
    Effect.map((command) => ({
      kind: command.activity.kind,
      turnId: command.activity.turnId,
      payload: command.activity.payload as SecretRequestActivityPayload,
    })),
  );

const ask = (waitMs = 60_000) =>
  Effect.gen(function* () {
    const secrets = yield* SecretRequests;
    return yield* secrets
      .request({
        threadId: THREAD,
        turnId: TURN,
        label: "GitHub token",
        reason: "Push the release branch. Create one at github.com/settings/tokens.",
        placeholder: "ghp_...",
        waitMs,
      })
      .pipe(Effect.forkChild);
  });

const answerError = (effect: Effect.Effect<void, SecretRequestError, SecretRequests>) =>
  effect.pipe(
    Effect.flip,
    Effect.map((error) => error.code),
  );

describe("SecretRequestsLive", () => {
  it.effect("a saved answer reaches the agent as an owner-only file and never as an event", () =>
    withSecretRequests(({ cards, dispatched }) =>
      Effect.gen(function* () {
        const secrets = yield* SecretRequests;
        const fiber = yield* ask();
        const requested = yield* nextCard(cards);
        assert.strictEqual(requested.kind, SECRET_REQUEST_ACTIVITY_KIND);
        assert.strictEqual(requested.turnId, TURN);
        assert.deepStrictEqual(
          { ...requested.payload, requestId: "-" },
          {
            requestId: "-",
            label: "GitHub token",
            reason: "Push the release branch. Create one at github.com/settings/tokens.",
            placeholder: "ghp_...",
          },
        );

        yield* secrets.answer({
          threadId: THREAD,
          requestId: requested.payload.requestId,
          answer: { type: "save", secret: VALUE },
        });
        const result = yield* Fiber.join(fiber);
        assert.strictEqual(result.outcome, "saved");
        if (result.outcome !== "saved") return;
        const config = yield* ServerConfig;
        assert.strictEqual(path.dirname(result.file), path.join(config.secretsDir, "requests"));
        assert.strictEqual(yield* Effect.promise(() => fs.readFile(result.file, "utf8")), VALUE);
        if (process.platform !== "win32") {
          const file = yield* Effect.promise(() => fs.stat(result.file));
          const directory = yield* Effect.promise(() => fs.stat(path.dirname(result.file)));
          assert.strictEqual(file.mode & 0o777, 0o600);
          assert.strictEqual(directory.mode & 0o777, 0o700);
        }

        const resolved = yield* nextCard(cards);
        assert.strictEqual(resolved.kind, SECRET_REQUEST_RESOLVED_ACTIVITY_KIND);
        assert.strictEqual(resolved.payload.outcome, "saved");
        assert.strictEqual(resolved.payload.requestId, requested.payload.requestId);
        assert.notInclude(JSON.stringify(dispatched), VALUE);
      }),
    ),
  );

  it.effect("declining stores nothing, and a settled card refuses later answers", () =>
    withSecretRequests(({ cards }) =>
      Effect.gen(function* () {
        const secrets = yield* SecretRequests;
        const fiber = yield* ask();
        const { payload } = yield* nextCard(cards);
        yield* secrets.answer({
          threadId: THREAD,
          requestId: payload.requestId,
          answer: { type: "decline" },
        });
        assert.deepStrictEqual(yield* Fiber.join(fiber), { outcome: "declined" });
        assert.strictEqual((yield* nextCard(cards)).payload.outcome, "declined");

        const code = yield* answerError(
          secrets.answer({
            threadId: THREAD,
            requestId: payload.requestId,
            answer: { type: "save", secret: VALUE },
          }),
        );
        assert.strictEqual(code, SECRET_REQUEST_ERROR_CODES.notFound);
        const config = yield* ServerConfig;
        const entries = yield* Effect.promise(() =>
          fs.readdir(path.join(config.secretsDir, "requests")).catch(() => []),
        );
        assert.deepStrictEqual(entries, []);
      }),
    ),
  );

  it.effect("an answer from another thread is refused and leaves the card waiting", () =>
    withSecretRequests(({ cards }) =>
      Effect.gen(function* () {
        const secrets = yield* SecretRequests;
        const fiber = yield* ask();
        const { payload } = yield* nextCard(cards);
        const code = yield* answerError(
          secrets.answer({
            threadId: ThreadId.makeUnsafe("thread-other"),
            requestId: payload.requestId,
            answer: { type: "save", secret: VALUE },
          }),
        );
        assert.strictEqual(code, SECRET_REQUEST_ERROR_CODES.notFound);
        yield* secrets.answer({
          threadId: THREAD,
          requestId: payload.requestId,
          answer: { type: "decline" },
        });
        assert.deepStrictEqual(yield* Fiber.join(fiber), { outcome: "declined" });
      }),
    ),
  );

  it.effect("a card nobody answers times out, closes, and refuses late answers", () =>
    withSecretRequests(({ cards }) =>
      Effect.gen(function* () {
        const secrets = yield* SecretRequests;
        const fiber = yield* ask(5_000);
        const { payload } = yield* nextCard(cards);
        yield* TestClock.adjust("5001 millis");
        assert.deepStrictEqual(yield* Fiber.join(fiber), { outcome: "timed_out" });
        assert.strictEqual((yield* nextCard(cards)).payload.outcome, "timed_out");
        const code = yield* answerError(
          secrets.answer({
            threadId: THREAD,
            requestId: payload.requestId,
            answer: { type: "save", secret: VALUE },
          }),
        );
        assert.strictEqual(code, SECRET_REQUEST_ERROR_CODES.notFound);
      }),
    ),
  );

  it.effect("stopping the agent closes its card as cancelled", () =>
    withSecretRequests(({ cards }) =>
      Effect.gen(function* () {
        const secrets = yield* SecretRequests;
        const fiber = yield* ask();
        const { payload } = yield* nextCard(cards);
        yield* Fiber.interrupt(fiber);
        assert.strictEqual((yield* nextCard(cards)).payload.outcome, "cancelled");
        const code = yield* answerError(
          secrets.answer({
            threadId: THREAD,
            requestId: payload.requestId,
            answer: { type: "save", secret: VALUE },
          }),
        );
        assert.strictEqual(code, SECRET_REQUEST_ERROR_CODES.notFound);
      }),
    ),
  );

  it.effect("caps the cards one thread can keep waiting", () =>
    withSecretRequests(({ cards }) =>
      Effect.gen(function* () {
        const fibers = [];
        for (let index = 0; index < SECRET_REQUEST_THREAD_PENDING_LIMIT; index += 1) {
          fibers.push(yield* ask());
          yield* nextCard(cards);
        }
        const overflow = yield* ask();
        const error = yield* Fiber.join(overflow).pipe(Effect.flip);
        assert.strictEqual(error.code, "queue_full");
        for (const fiber of fibers) yield* Fiber.interrupt(fiber);
      }),
    ),
  );

  it.live("deletes saved secrets once they are a day old", () =>
    Effect.gen(function* () {
      const config = yield* ServerConfig;
      const directory = path.join(config.secretsDir, "requests");
      const expired = path.join(directory, "a".repeat(32));
      const fresh = path.join(directory, "b".repeat(32));
      const unrelated = path.join(directory, "notes.txt");
      yield* Effect.promise(async () => {
        await fs.mkdir(directory, { recursive: true, mode: 0o700 });
        for (const file of [expired, fresh, unrelated]) await fs.writeFile(file, "x");
        const old = new Date(Date.now() - SECRET_REQUEST_FILE_TTL_MS - 60_000);
        await fs.utimes(expired, old, old);
        await fs.utimes(unrelated, old, old);
      });
      const engine = yield* makeEngine;
      yield* Effect.gen(function* () {
        yield* SecretRequests;
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const entries = yield* Effect.promise(() => fs.readdir(directory));
          if (!entries.includes(path.basename(expired))) break;
          yield* Effect.sleep("10 millis");
        }
      }).pipe(Effect.provide(SecretRequestsLive.pipe(Layer.provideMerge(engine.layer))));
      const entries = yield* Effect.promise(() => fs.readdir(directory));
      assert.deepStrictEqual(entries.toSorted(), [path.basename(fresh), "notes.txt"].toSorted());
    }).pipe(Effect.provide(configLayer)),
  );
});
