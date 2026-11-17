// FILE: CodexTextGeneration.runLog.test.ts
// Purpose: The one Info line every Codex text-generation run writes, on every platform.
// Layer: Git text generation, logging

import { Clock, Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { TextGenerationError } from "../Errors.ts";
import { withCodexTextGenerationRunLog } from "./CodexTextGeneration.ts";

function capture<A, E>(effect: Effect.Effect<A, E>) {
  const lines: Array<{ readonly level: string; readonly message: unknown }> = [];
  const logger = Logger.make(({ logLevel, message }) => {
    lines.push({ level: logLevel, message });
  });
  const run = effect.pipe(
    Effect.exit,
    Effect.provide(Logger.layer([logger], { mergeWithExisting: false })),
  );
  return { lines, run };
}

// A clock that does not move: a run on it lasts 0 ms however loaded the machine is.
const stillClock: Clock.Clock = {
  currentTimeMillisUnsafe: () => 5_000,
  currentTimeMillis: Effect.succeed(5_000),
  currentTimeNanosUnsafe: () => 0n,
  currentTimeNanos: Effect.succeed(0n),
  sleep: () => Effect.void,
};

const line = (fields: Record<string, unknown>) => ({
  level: "Info",
  message: ["Codex text generation", fields],
});

describe("withCodexTextGenerationRunLog", () => {
  it("writes the route, model, effort, duration and outcome of a run, never its text", async () => {
    // The run starts at 1,000 ms and ends at 3,300 ms on this clock.
    const readings = [1_000, 3_300];
    const read = () => readings.shift() ?? 0;
    const steppingClock: Clock.Clock = {
      currentTimeMillisUnsafe: read,
      currentTimeMillis: Effect.sync(read),
      currentTimeNanosUnsafe: () => 0n,
      currentTimeNanos: Effect.succeed(0n),
      sleep: () => Effect.void,
    };
    const run = {} as Parameters<typeof withCodexTextGenerationRunLog>[1];
    const program = withCodexTextGenerationRunLog(
      "generateThreadTitle",
      run,
      Effect.sync(() => {
        run.route = "windows-job";
        run.model = "gpt-6-astra";
        run.effort = "low";
        return { title: "a prompt-derived secret title" };
      }),
    ).pipe(Effect.provideService(Clock.Clock, steppingClock));
    const { lines, run: logged } = capture(program);
    await Effect.runPromise(logged);
    expect(lines).toEqual([
      line({
        operation: "generateThreadTitle",
        route: "windows-job",
        model: "gpt-6-astra",
        effort: "low",
        durationMs: 2300,
        outcome: "succeeded",
      }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("secret");
  });

  it.each([
    ["Codex CLI request timed out.", "timeout"],
    ["Codex CLI version probe timed out.", "timeout"],
    ["The model service timed out.", "timeout"],
    ["Codex CLI command failed: the prompt text echoed back", "failed"],
  ])("tells a timeout from another failure (%s)", async (detail, outcome) => {
    const run: Parameters<typeof withCodexTextGenerationRunLog>[1] = { route: "process-group" };
    const { lines, run: program } = capture(
      withCodexTextGenerationRunLog(
        "generateCommitMessage",
        run,
        Effect.fail(new TextGenerationError({ operation: "generateCommitMessage", detail })),
      ).pipe(Effect.provideService(Clock.Clock, stillClock)),
    );
    await Effect.runPromise(program);
    expect(lines).toEqual([
      line({ operation: "generateCommitMessage", route: "process-group", durationMs: 0, outcome }),
    ]);
    expect(JSON.stringify(lines)).not.toContain("echoed");
  });

  it("says when the caller stopped waiting", async () => {
    const run: Parameters<typeof withCodexTextGenerationRunLog>[1] = { route: "direct" };
    const { lines, run: program } = capture(
      withCodexTextGenerationRunLog("generateComposerPrediction", run, Effect.interrupt).pipe(
        Effect.provideService(Clock.Clock, stillClock),
      ),
    );
    await Effect.runPromise(program);
    expect(lines).toEqual([
      line({
        operation: "generateComposerPrediction",
        route: "direct",
        durationMs: 0,
        outcome: "interrupted",
      }),
    ]);
  });

  it("writes nothing for a request refused before it chose a route", async () => {
    const { lines, run } = capture(
      withCodexTextGenerationRunLog(
        "generateThreadTitle",
        {},
        Effect.fail(
          new TextGenerationError({
            operation: "generateThreadTitle",
            detail: "Auxiliary Codex text generation is unavailable on Windows.",
          }),
        ),
      ),
    );
    await Effect.runPromise(run);
    expect(lines).toEqual([]);
  });
});
