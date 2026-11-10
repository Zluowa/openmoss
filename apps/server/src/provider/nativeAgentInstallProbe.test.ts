import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";
import { Effect, Option } from "effect";
import { afterEach, expect, it, vi } from "vitest";
import { makeNativeAgentInstallProbe } from "./nativeAgentInstallProbe.ts";
import * as teardown from "../platform/supervisedProcessTeardown.ts";

function fakeChild(): ChildProcess {
  return Object.assign(new EventEmitter(), {
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    pid: 12345,
    exitCode: null,
    signalCode: null,
  }) as unknown as ChildProcess;
}
const input = { command: "synthetic-node", args: ["--version"], env: {} };
afterEach(() => vi.restoreAllMocks());

it("returns only after close with drained bounded output", async () => {
  const child = fakeChild();
  vi.spyOn(teardown, "spawnChildWithPreparedTree").mockImplementation(async (options) =>
    options.bind(child as never),
  );
  const stop = vi.spyOn(teardown, "teardownChildProcessTree");
  let settled = false;
  const pending = Effect.runPromise(makeNativeAgentInstallProbe(Effect.void)(input)).then(
    (value) => {
      settled = true;
      return value;
    },
  );
  await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
  child.stdout!.emit("data", Buffer.from("v".repeat(5000)));
  child.emit("exit", 0);
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 0);
  const result = await pending;
  expect(Option.isSome(result) && result.value.stdout.length).toBe(4096);
  expect(stop).not.toHaveBeenCalled();
});

it("waits for tree teardown and stdio close on timeout before returning", async () => {
  const child = fakeChild();
  vi.spyOn(teardown, "spawnChildWithPreparedTree").mockImplementation(async (options) =>
    options.bind(child as never),
  );
  let release!: () => void;
  const tree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.spyOn(teardown, "teardownChildProcessTree").mockImplementation(async () => {
    await tree;
    return { escalated: false, signalErrors: [] };
  });
  const unproven = vi.fn();
  let settled = false;
  const pending = Effect.runPromise(
    makeNativeAgentInstallProbe(Effect.sync(unproven), { timeoutMs: 10 })(input),
  ).then((value) => {
    settled = true;
    return value;
  });
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release();
  await Promise.resolve();
  expect(settled).toBe(false);
  child.emit("close", 0);
  expect(Option.isNone(await pending)).toBe(true);
  expect(unproven).not.toHaveBeenCalled();
});

it("marks cleanup unproven before releasing a failed teardown scope", async () => {
  const child = fakeChild();
  vi.spyOn(teardown, "spawnChildWithPreparedTree").mockImplementation(async (options) =>
    options.bind(child as never),
  );
  vi.spyOn(teardown, "teardownChildProcessTree").mockRejectedValue(
    new Error("tree proof unavailable"),
  );
  const unproven = vi.fn();
  const result = await Effect.runPromise(
    makeNativeAgentInstallProbe(Effect.sync(unproven), { timeoutMs: 10 })(input),
  );
  expect(Option.isNone(result)).toBe(true);
  expect(unproven).toHaveBeenCalledOnce();
  child.emit("close", 1);
});

it("finishes teardown before acknowledging cancellation", async () => {
  const child = fakeChild();
  vi.spyOn(teardown, "spawnChildWithPreparedTree").mockImplementation(async (options) =>
    options.bind(child as never),
  );
  let release!: () => void;
  const tree = new Promise<void>((resolve) => {
    release = resolve;
  });
  const stop = vi.spyOn(teardown, "teardownChildProcessTree").mockImplementation(async () => {
    await tree;
    return { escalated: false, signalErrors: [] };
  });
  const controller = new AbortController();
  let settled = false;
  const pending = Effect.runPromise(makeNativeAgentInstallProbe(Effect.void)(input), {
    signal: controller.signal,
  }).catch(() => {
    settled = true;
  });
  await vi.waitFor(() => expect(child.listenerCount("close")).toBe(1));
  controller.abort();
  await vi.waitFor(() => expect(stop).toHaveBeenCalledOnce());
  expect(settled).toBe(false);
  release();
  child.emit("close", 1);
  await pending;
  expect(settled).toBe(true);
});
