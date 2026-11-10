import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import { describe, expect, it, vi } from "vitest";

import {
  makeJsonlSplitter,
  PiRpcCommandError,
  PiRpcProcessError,
  startPiRpcClient,
} from "./PiRpcClient.ts";
import type { teardownProviderProcessTree } from "../supervisedProcessTeardown.ts";

class FakeChild extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid = 4242;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly written: Array<Record<string, unknown>> = [];

  constructor() {
    super();
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let index: number;
      while ((index = buffered.indexOf("\n")) >= 0) {
        this.written.push(JSON.parse(buffered.slice(0, index)) as Record<string, unknown>);
        buffered = buffered.slice(index + 1);
      }
    });
  }

  send(record: unknown) {
    this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  exit(code: number) {
    this.exitCode = code;
    this.emit("exit", code, null);
  }
}

function start(child: FakeChild, options: { commandTimeoutMs?: number } = {}) {
  const teardown = vi.fn<typeof teardownProviderProcessTree>(async (input) => {
    if (child.exitCode === null) child.exit(1);
    await input.rootExited;
    return { escalated: false, signalErrors: [] };
  });
  const client = startPiRpcClient({
    binaryPath: "pi",
    args: ["--mode", "rpc"],
    cwd: process.cwd(),
    env: {},
    spawnProcess: () => child as unknown as ChildProcess,
    teardownProcessTree: teardown,
    ...options,
  });
  return { client, teardown };
}

const flush = () => new Promise((resolve) => setImmediate(resolve));

describe("makeJsonlSplitter", () => {
  it("splits on LF only, keeps U+2028 inside strings and drops a CR before LF", () => {
    const lines: string[] = [];
    const split = makeJsonlSplitter((line) => lines.push(line));
    const record = JSON.stringify({ text: "a b c" });
    const bytes = Buffer.from(`${record}\r\n{"type":"x"}\n{"partial":`);
    split(bytes.subarray(0, 5));
    split(bytes.subarray(5));
    split(Buffer.from("1}\n"));
    expect(lines).toEqual([record, '{"type":"x"}', '{"partial":1}']);
    expect(JSON.parse(lines[0]!).text).toBe("a b c");
  });

  it("joins a multi-byte character split across chunks", () => {
    const lines: string[] = [];
    const split = makeJsonlSplitter((line) => lines.push(line));
    const bytes = Buffer.from('{"text":"中文"}\n');
    split(bytes.subarray(0, 11));
    split(bytes.subarray(11));
    expect(JSON.parse(lines[0]!).text).toBe("中文");
  });
});

describe("startPiRpcClient", () => {
  it("correlates responses by id and passes other records to listeners", async () => {
    const child = new FakeChild();
    const { client } = start(child);
    const records: unknown[] = [];
    client.onRecord((record) => records.push(record));

    const first = client.request<{ value: number }>({ type: "get_state" });
    const second = client.request({ type: "get_commands" });
    await flush();
    const [a, b] = child.written;
    expect(a).toMatchObject({ type: "get_state" });
    expect(b).toMatchObject({ type: "get_commands" });
    // Answered out of order.
    child.send({ type: "response", id: b!.id, command: "get_commands", success: true, data: {} });
    child.send({ type: "agent_start" });
    child.send({
      type: "response",
      id: a!.id,
      command: "get_state",
      success: true,
      data: { value: 1 },
    });
    await expect(first).resolves.toEqual({ value: 1 });
    await expect(second).resolves.toEqual({});
    expect(records).toEqual([{ type: "agent_start" }]);
  });

  it("rejects a refused command with Pi's own message", async () => {
    const child = new FakeChild();
    const { client } = start(child);
    const pending = client.request({ type: "set_model", provider: "x", modelId: "y" });
    await flush();
    child.send({
      type: "response",
      id: child.written[0]!.id,
      command: "set_model",
      success: false,
      error: "Model not found: x/y",
    });
    await expect(pending).rejects.toThrow(PiRpcCommandError);
    await expect(pending).rejects.toThrow("Model not found: x/y");
  });

  it("fails every pending command with stderr when Pi exits", async () => {
    const child = new FakeChild();
    const { client } = start(child);
    const pending = client.request({ type: "get_state" });
    child.stderr.write("Error: extension failed to load\n");
    await flush();
    child.exit(1);
    await expect(pending).rejects.toThrow(PiRpcProcessError);
    await expect(pending).rejects.toThrow("extension failed to load");
    await expect(client.exited).resolves.toMatchObject({ code: 1 });
    await expect(client.request({ type: "get_state" })).rejects.toThrow("Pi exited");
  });

  it("times out a command Pi never answers", async () => {
    const child = new FakeChild();
    const { client } = start(child, { commandTimeoutMs: 20 });
    await expect(client.request({ type: "get_state" })).rejects.toThrow(
      "Pi did not answer get_state",
    );
  });

  it("closes stdin first and still proves the process tree is gone", async () => {
    const child = new FakeChild();
    const { client, teardown } = start(child);
    child.stdin.on("finish", () => child.exit(0));
    await client.close();
    expect(child.exitCode).toBe(0);
    expect(teardown).toHaveBeenCalledOnce();
    // Idempotent.
    await client.close();
    expect(teardown).toHaveBeenCalledOnce();
  });

  it("tears the tree down when Pi ignores the closed stdin", async () => {
    const child = new FakeChild();
    const { client, teardown } = start(child);
    await client.close({ graceMs: 10 });
    expect(teardown).toHaveBeenCalledOnce();
    expect(child.exitCode).toBe(1);
  });

  it("reports a spawn failure without a process", async () => {
    const client = startPiRpcClient({
      binaryPath: "pi",
      args: [],
      cwd: process.cwd(),
      env: {},
      spawnProcess: () => {
        throw Object.assign(new Error("spawn pi ENOENT"), { code: "ENOENT" });
      },
    });
    await expect(client.exited).resolves.toMatchObject({ spawnError: expect.any(Error) });
    await expect(client.request({ type: "get_state" })).rejects.toThrow("Pi could not start");
  });
});
