import { assert, it } from "@effect/vitest";
import { Effect, Schema } from "effect";

import {
  DEFAULT_PROJECT_AGENT_LIMITS,
  ProjectAgentConfigureInput,
  ProjectAgentListSummariesInput,
  ProjectAgentSummary,
  ProjectTaskStatus,
} from "./projectAgent";

const decode = <S extends Schema.Top>(schema: S, input: unknown) =>
  Schema.decodeUnknownEffect(schema as never)(input) as Effect.Effect<
    Schema.Schema.Type<S>,
    Schema.SchemaError,
    never
  >;

it.effect("defaults coordinator limits and capture", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentConfigureInput, {
      requestId: "req-1",
      projectId: "project-1",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    });
    assert.deepStrictEqual(parsed.limits, { ...DEFAULT_PROJECT_AGENT_LIMITS });
    assert.strictEqual(parsed.captureEnabled, true);
    assert.strictEqual(parsed.userLocale, undefined);
  }),
);

it.effect("accepts the app's languages for the hub's first message", () =>
  Effect.gen(function* () {
    const input = {
      requestId: "req-1",
      projectId: "project-1",
      coordinatorModelSelection: { provider: "codex", model: "gpt-5-codex" },
    };
    const parsed = yield* decode(ProjectAgentConfigureInput, { ...input, userLocale: "zh-CN" });
    assert.strictEqual(parsed.userLocale, "zh-CN");
    const unknown = yield* Effect.exit(
      decode(ProjectAgentConfigureInput, { ...input, userLocale: "fr" }),
    );
    assert.strictEqual(unknown._tag, "Failure");
  }),
);

it.effect("keeps review distinct from done", () =>
  Effect.gen(function* () {
    const review = yield* decode(ProjectTaskStatus, "review");
    const done = yield* decode(ProjectTaskStatus, "done");
    assert.notStrictEqual(review, done);
  }),
);

it.effect("accepts an empty listSummaries payload", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentListSummariesInput, {});
    assert.deepStrictEqual(parsed, {});
  }),
);

it.effect("decodes a configured project agent summary", () =>
  Effect.gen(function* () {
    const parsed = yield* decode(ProjectAgentSummary, {
      projectId: "project-1",
      configured: true,
      coordinatorName: "Moss Coordinator",
      coordinatorThreadId: "thread-coordinator",
      coordinatorIcon: null,
      coordinatorColor: null,
      coordinatorStatus: "idle",
      revision: 1,
    });
    assert.strictEqual(parsed.configured, true);
    assert.strictEqual(parsed.coordinatorName, "Moss Coordinator");
    assert.strictEqual(parsed.revision, 1);
  }),
);
