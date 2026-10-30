import { mkdir, mkdtemp, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import type { ComputerHistoryObservation, ComputerHistorySemanticSummary } from "@synara/contracts";

import {
  COMPUTER_HISTORY_SIX_HOUR_MS,
  COMPUTER_HISTORY_SUMMARY_RETRY_DELAY_MS,
  COMPUTER_HISTORY_TEN_MINUTE_MS,
  ComputerHistoryNonRetryableSummaryError,
  ComputerHistoryRetryableSummaryError,
  createComputerHistorySummaryJobEngine,
  toComputerHistorySafeSummaryInput,
  type ComputerHistoryRecursiveSummary,
  type ComputerHistorySummaryBackend,
} from "./summaryJobs.ts";

const semantic = (
  title: string,
  description = `${title} safely summarized`,
): ComputerHistorySemanticSummary => ({
  title,
  description,
  source: "apple_on_device",
});

const input = (capturedAtMs: number, title = "Working safely") => ({
  capturedAtMs,
  app: { bundleIdentifier: "com.example.editor", name: "Editor" },
  semanticSummary: semantic(title),
});

const backendSummary = (
  kind: "10min" | "6h",
  startMs: number,
  endMs: number,
  title: string,
  children: readonly ComputerHistoryRecursiveSummary[] = [],
): ComputerHistoryRecursiveSummary => ({
  logicalJobKey: `${kind}:${startMs}`,
  kind,
  startMs,
  endMs,
  title,
  description: `${title} description`,
  summaryText: `${title}. ${title} description`,
  applications: ["Editor"],
  applicationBundleIdentifiers: ["com.example.editor"],
  childJobKeys: children.map((child) => child.logicalJobKey),
});

describe("Computer History recursive summary jobs", () => {
  it("uses UTC minute buckets and deterministic duplicate/ordering semantics", async () => {
    const engine = createComputerHistorySummaryJobEngine();
    await engine.start({ catchUp: false });
    expect(engine.addInput(input(61_000, "Second"))).toBe(true);
    expect(engine.addInput(input(1_000, "First"))).toBe(true);
    expect(engine.addInput(input(1_000, "First"))).toBe(false);
    const result = await engine.runPending(120_000);
    expect(result.changed).toBe(true);
    expect(engine.snapshot()).toHaveLength(1);
    expect(engine.snapshot()[0]).toMatchObject({
      kind: "10min",
      startMs: 0,
      applications: ["Editor"],
    });
    expect(engine.minuteInputs().map((item) => item.capturedAtMs)).toEqual([1_000, 61_000]);
    await engine.stop();
  });

  it("recomputes only dirty ten-minute jobs and reaches a fixed point without duplicate work", async () => {
    const starts: number[] = [];
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        starts.push(input.startMs);
        return backendSummary(
          input.kind,
          input.startMs,
          input.endMs,
          "Stable",
          input.childSummaries,
        );
      },
    };
    const engine = createComputerHistorySummaryJobEngine({ backend });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "First"));
    engine.addInput(input(COMPUTER_HISTORY_TEN_MINUTE_MS + 1_000, "Second"));
    await engine.runPending(1_000);
    const initialCalls = starts.length;
    expect(initialCalls).toBe(2); // one backend call per dirty node
    await engine.runPending(2_000);
    expect(starts.length).toBe(initialCalls);
    engine.addInput(input(2_000, "Changed first bucket"));
    await engine.runPending(3_000);
    expect(starts.slice(initialCalls)).toEqual([0]);
    await engine.stop();
  });

  it("preserves the committed resource index for identical hydration and prunes removed inputs atomically", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-prune-"));
    const engine = createComputerHistorySummaryJobEngine({ rootDir });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "Old"));
    await engine.runPending(1_000);
    const committedPath = engine.resourcePaths().get("10min:0");
    expect(committedPath).toBeDefined();
    engine.replaceInputs([input(1_000, "Old")]);
    expect(engine.hasPendingInputReplacement()).toBe(false);
    expect(engine.resourcePaths().get("10min:0")).toBe(committedPath);

    engine.replaceInputs([]);
    expect(engine.hasPendingInputReplacement()).toBe(true);
    expect(engine.resourcePaths().get("10min:0")).toBe(committedPath);
    await engine.runPending(2_000);
    expect(engine.minuteInputs()).toEqual([]);
    expect(engine.snapshot()).toEqual([]);
    expect(engine.resourcePaths()).toEqual(new Map());
    await engine.stop();
  });

  it("retains a later input staged while a replacement run is awaiting its backend", async () => {
    let calls = 0;
    let releaseFirst: (() => void) | undefined;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        if (calls === 1) {
          await new Promise<void>((resolve) => {
            releaseFirst = resolve;
          });
        }
        const title = input.minuteInputs[0]?.description.includes("Second") ? "Second" : "First";
        return backendSummary(input.kind, input.startMs, input.endMs, title, input.childSummaries);
      },
    };
    const engine = createComputerHistorySummaryJobEngine({ backend });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "First"));
    const pending = engine.runPending(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    engine.addInput(input(2_000, "Second"));
    releaseFirst?.();
    await pending;
    expect(calls).toBe(2);
    expect(engine.minuteInputs().map((item) => item.capturedAtMs)).toEqual([1_000, 2_000]);
    expect(engine.snapshot()[0]?.title).toBe("Second");
    await engine.stop();
  });

  it("rejects a malformed replacement without discarding the committed snapshot", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-malformed-"));
    const engine = createComputerHistorySummaryJobEngine({ rootDir });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "Good"));
    await engine.runPending(1_000);
    const snapshot = engine.snapshot();
    const paths = engine.resourcePaths();
    expect(() =>
      engine.replaceInputs([
        {
          capturedAtMs: -1,
          app: { bundleIdentifier: "com.example.editor", name: "Editor" },
        },
      ]),
    ).toThrow(/timestamp/u);
    expect(engine.snapshot()).toEqual(snapshot);
    expect(engine.resourcePaths()).toEqual(paths);
    await engine.stop();
  });

  it("aggregates ten-minute children into a complete six-hour parent", async () => {
    const engine = createComputerHistorySummaryJobEngine();
    await engine.start({ catchUp: false });
    for (let minute = 0; minute < 360; minute += 1) {
      expect(engine.addInput(input(minute * 60_000 + 1, `Minute ${minute}`))).toBe(true);
    }
    const result = await engine.runPending(COMPUTER_HISTORY_SIX_HOUR_MS);
    expect(result.failedJobKeys).toEqual([]);
    expect(engine.snapshot().filter((summary) => summary.kind === "10min")).toHaveLength(36);
    expect(engine.snapshot().filter((summary) => summary.kind === "6h")).toHaveLength(1);
    expect(engine.snapshot().find((summary) => summary.kind === "6h")).toMatchObject({
      startMs: 0,
      endMs: COMPUTER_HISTORY_SIX_HOUR_MS,
      childJobKeys: expect.arrayContaining(["10min:0", `10min:${COMPUTER_HISTORY_TEN_MINUTE_MS}`]),
    });
    await engine.stop();
  });

  it("retries only retryable failures at a fixed two-second interval", async () => {
    const sleeps: number[] = [];
    let calls = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        if (calls <= 2) throw new ComputerHistoryRetryableSummaryError("temporary");
        return backendSummary(
          input.kind,
          input.startMs,
          input.endMs,
          "Stable",
          input.childSummaries,
        );
      },
    };
    const engine = createComputerHistorySummaryJobEngine({
      backend,
      sleep: async (milliseconds) => {
        sleeps.push(milliseconds);
      },
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const result = await engine.runPending(1_000);
    expect(result.failedJobKeys).toEqual([]);
    expect(calls).toBe(3); // two retry attempts, then one successful attempt
    expect(sleeps).toEqual([
      COMPUTER_HISTORY_SUMMARY_RETRY_DELAY_MS,
      COMPUTER_HISTORY_SUMMARY_RETRY_DELAY_MS,
    ]);
    await engine.stop();
  });

  it("does not retry non-retryable errors and keeps last-known-good", async () => {
    let fail = false;
    let calls = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        if (fail) throw new ComputerHistoryNonRetryableSummaryError("bad input");
        return backendSummary(input.kind, input.startMs, input.endMs, "Good");
      },
    };
    const engine = createComputerHistorySummaryJobEngine({ backend });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    await engine.runPending(1_000);
    expect(engine.snapshot()).toHaveLength(1);
    fail = true;
    engine.addInput(input(2_000, "Another"));
    const result = await engine.runPending(2_000);
    expect(result.failedJobKeys).toEqual(["10min:0"]);
    expect(calls).toBe(2); // one initial run plus one failed dirty update
    expect(engine.snapshot()[0]?.title).toBe("Good");
    await engine.stop();
  });

  it("keeps the convergence loop bounded while processing a new node once", async () => {
    let calls = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        return backendSummary(input.kind, input.startMs, input.endMs, "Stable");
      },
    };
    const engine = createComputerHistorySummaryJobEngine({ backend });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const result = await engine.runPending(1_000);
    expect(result.failedJobKeys).toEqual([]);
    expect(engine.snapshot()).toHaveLength(1);
    expect(calls).toBe(1);
    await engine.stop();
  });

  it("fails closed after eight explicitly requeued dependency passes", async () => {
    let calls = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        return backendSummary(input.kind, input.startMs, input.endMs, `Pass ${calls}`);
      },
      needsAnotherPass: () => true,
    };
    const engine = createComputerHistorySummaryJobEngine({ backend });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const result = await engine.runPending(1_000);
    expect(result.failedJobKeys).toEqual(["non_convergent"]);
    expect(engine.snapshot()).toEqual([]);
    expect(calls).toBe(8);
    await engine.stop();
  });

  it("does not allow raw observation fields into the job input", () => {
    const safe = toComputerHistorySafeSummaryInput({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: { title: "secret /Users/moss/private.txt", url: "https://example.test" },
      activityText: "raw message must not survive",
      semanticSummary: semantic("Safe title", "Safe description"),
    } as unknown as ComputerHistoryObservation);
    expect(safe).toEqual({
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      semanticSummary: semantic("Safe title", "Safe description"),
    });
    expect(JSON.stringify(safe)).not.toContain("private.txt");
    expect(JSON.stringify(safe)).not.toContain("raw message");
  });

  it("keeps valid hydrated records when one legacy record is malformed", () => {
    const validObservation: ComputerHistoryObservation = {
      capturedAtMs: 1_000,
      app: { bundleIdentifier: "com.example.editor", name: "Editor" },
      window: {},
    };
    const malformedObservation = {
      capturedAtMs: -1,
      app: { bundleIdentifier: "com.example.broken", name: "Broken" },
      window: {},
    } as unknown as ComputerHistoryObservation;
    const hydratedInputs = [validObservation, malformedObservation].flatMap((observation) => {
      try {
        return [toComputerHistorySafeSummaryInput(observation)];
      } catch {
        return [];
      }
    });
    const engine = createComputerHistorySummaryJobEngine();
    expect(engine.replaceInputs(hydratedInputs)).toBe(1);
    expect(engine.minuteInputs().map((item) => item.capturedAtMs)).toEqual([1_000]);
  });

  it("materializes atomic, private, slugged resources and keeps one file per logical job", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-jobs-"));
    const sequence = ["abcd", "efgh", "ijkl"];
    const engine = createComputerHistorySummaryJobEngine({
      rootDir,
      randomAlpha: () => sequence.shift() ?? "mnop",
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "A safe title"));
    await engine.runPending(1_000);
    const firstFiles = await readdir(join(rootDir, "resources"));
    expect(firstFiles).toContain("summary-jobs-manifest.json");
    const firstResource = firstFiles.find((name) => name.endsWith(".md"));
    expect(firstResource).toMatch(/^1970-01-01T00-00-00-abcd-10min-a-safe-title\.md$/u);
    const resourceStat = await stat(join(rootDir, "resources", firstResource!));
    expect(resourceStat.isFile()).toBe(true);
    if (process.platform !== "win32") expect(resourceStat.mode & 0o777).toBe(0o600);
    const manifest = await readFile(
      join(rootDir, "resources", "summary-jobs-manifest.json"),
      "utf8",
    );
    expect(manifest).toContain(firstResource!);
    engine.addInput(input(2_000, "B title"));
    await engine.runPending(2_000);
    const secondFiles = await readdir(join(rootDir, "resources"));
    expect(secondFiles.some((name) => name.includes("-efgh-10min-"))).toBe(true);
    expect(secondFiles.some((name) => name === firstResource)).toBe(false);
    await engine.stop();
  });

  it("preserves LKG summaries, signatures, paths, and manifest on replacement writer failure", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-lkg-"));
    const randomValues = ["abcd", "efgh"];
    const engine = createComputerHistorySummaryJobEngine({
      rootDir,
      randomAlpha: () => randomValues.shift() ?? "ijkl",
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000, "Old title"));
    await engine.runPending(1_000);
    const oldSnapshot = engine.snapshot();
    const oldPaths = engine.resourcePaths();
    const oldPath = oldPaths.get("10min:0")!;
    const oldManifestPath = join(rootDir, "resources", "summary-jobs-manifest.json");
    const oldManifest = await readFile(oldManifestPath, "utf8");
    const oldContents = await readFile(oldPath, "utf8");

    engine.replaceInputs([input(2_000, "New title")]);
    const blockedPath = join(rootDir, "resources", "1970-01-01T00-00-00-efgh-10min-new-title.md");
    await mkdir(join(rootDir, "resources"), { recursive: true, mode: 0o700 });
    if (process.platform === "win32") await mkdir(join(rootDir, "outside"));
    await symlink(
      join(rootDir, "outside"),
      blockedPath,
      process.platform === "win32" ? "junction" : "file",
    );
    await expect(engine.runPending(2_000)).rejects.toThrow(/regular file/u);
    expect(engine.snapshot()).toEqual(oldSnapshot);
    expect(engine.resourcePaths()).toEqual(oldPaths);
    expect(await readFile(oldManifestPath, "utf8")).toBe(oldManifest);
    expect(await readFile(oldPath, "utf8")).toBe(oldContents);
    await engine.stop();
  });

  it("passes AbortSignal to the backend and stops without overlapping a hung call", async () => {
    let receivedSignal: AbortSignal | undefined;
    let calls = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(_input, signal) {
        calls += 1;
        receivedSignal = signal;
        return new Promise<never>(() => undefined);
      },
    };
    const engine = createComputerHistorySummaryJobEngine({
      backend,
      backendTimeoutMs: 10,
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const pending = engine.runPending(1_000);
    await new Promise((resolve) => setTimeout(resolve, 0));
    const stoppedAt = Date.now();
    await engine.stop();
    expect(Date.now() - stoppedAt).toBeLessThan(100);
    expect(engine.state()).toBe("stopped");
    expect(calls).toBe(1);
    expect(receivedSignal).toBeDefined();
    expect(receivedSignal?.aborted).toBe(true);
    await expect(pending).rejects.toThrow(/cancelled/u);
    expect(calls).toBe(1);
  });

  it("does not retry or start another job after an uncancelled backend deadline", async () => {
    let calls = 0;
    let resolveLate: ((summary: ComputerHistoryRecursiveSummary) => void) | undefined;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        return new Promise((resolve) => {
          resolveLate = () =>
            resolve(backendSummary(input.kind, input.startMs, input.endMs, "Late"));
        });
      },
    };
    const engine = createComputerHistorySummaryJobEngine({ backend, backendTimeoutMs: 10 });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const first = await engine.runPending(1_000);
    expect(first.failedJobKeys).toEqual(["10min:0"]);
    expect(calls).toBe(1);
    const refused = await engine.runPending(2_000);
    expect(refused.failedJobKeys).toEqual(["cancelled"]);
    expect(calls).toBe(1);
    resolveLate?.(backendSummary("10min", 0, COMPUTER_HISTORY_TEN_MINUTE_MS, "Late"));
    await new Promise((resolve) => setTimeout(resolve, 0));
    const afterSettlement = await engine.runPending(3_000);
    expect(afterSettlement.failedJobKeys).toEqual(["10min:0"]);
    expect(calls).toBe(2);
    await engine.stop();
  });

  it("queues observations until the injected per-minute scheduler boundary", async () => {
    let calls = 0;
    const timers: Array<() => void> = [];
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        calls += 1;
        return backendSummary(input.kind, input.startMs, input.endMs, "Boundary");
      },
    };
    const engine = createComputerHistorySummaryJobEngine({
      now: () => 0,
      backend,
      setTimer: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimer: () => undefined,
    });
    await engine.start({ catchUp: false });
    expect(timers).toHaveLength(2);
    engine.addInput(input(1_000));
    expect(calls).toBe(0);
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(calls).toBe(1);
    await engine.stop();
  });

  it("recovers after a failed catch-up instead of remaining running without timers", async () => {
    let shouldFail = true;
    let timerCount = 0;
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        if (shouldFail) throw new ComputerHistoryNonRetryableSummaryError("temporary");
        return backendSummary(input.kind, input.startMs, input.endMs, "Recovered");
      },
    };
    const engine = createComputerHistorySummaryJobEngine({
      backend,
      setTimer: (handler) => {
        timerCount += 1;
        return handler;
      },
      clearTimer: () => undefined,
    });
    engine.addInput(input(1_000));
    await expect(engine.start()).rejects.toThrow(/catch-up failed/u);
    expect(engine.state()).toBe("stopped");
    expect(timerCount).toBe(1); // backend deadline only; no scheduler timers
    shouldFail = false;
    await engine.start();
    expect(engine.state()).toBe("running");
    expect(timerCount).toBe(4); // two catch-up deadlines plus minute/hour schedulers
    await engine.stop();
  });

  it("surfaces scheduled failures and clears the health signal after the next good boundary", async () => {
    let shouldFail = true;
    const timers: Array<() => void> = [];
    const results: string[] = [];
    const backend: ComputerHistorySummaryBackend = {
      async summarize(input) {
        if (shouldFail) throw new ComputerHistoryNonRetryableSummaryError("boundary failure");
        return backendSummary(input.kind, input.startMs, input.endMs, "Recovered");
      },
    };
    const engine = createComputerHistorySummaryJobEngine({
      backend,
      now: () => 0,
      setTimer: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimer: () => undefined,
      onRunResult: (result) => results.push(result.failedJobKeys.join(",")),
      onRunError: () => results.push("thrown"),
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results).toContain("10min:0");
    shouldFail = false;
    const nextMinuteTimer = timers.at(-1);
    expect(nextMinuteTimer).toBeDefined();
    nextMinuteTimer!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(results.at(-1)).toBe("");
    await engine.stop();
  });

  it("observes a scheduled resource rejection without an unhandled promise", async () => {
    const rootDir = await mkdtemp(join(tmpdir(), "moss-history-summary-timer-rejection-"));
    await writeFile(join(rootDir, "resources"), "not a directory", { mode: 0o600 });
    const timers: Array<() => void> = [];
    const engine = createComputerHistorySummaryJobEngine({
      rootDir,
      now: () => 0,
      setTimer: (handler) => {
        timers.push(handler);
        return handler;
      },
      clearTimer: () => undefined,
    });
    await engine.start({ catchUp: false });
    engine.addInput(input(1_000));
    const unhandled: unknown[] = [];
    const onUnhandled = (reason: unknown): void => {
      unhandled.push(reason);
    };
    process.on("unhandledRejection", onUnhandled);
    timers[0]!();
    await new Promise((resolve) => setTimeout(resolve, 0));
    process.off("unhandledRejection", onUnhandled);
    expect(unhandled).toEqual([]);
    await engine.stop();
  });
});
