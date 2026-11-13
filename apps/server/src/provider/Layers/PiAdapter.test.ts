// FILE: PiAdapter.test.ts
// Purpose: Drives the Pi adapter against a scripted `pi --mode rpc` process: session start,
//          turns, steering, interrupts, extension dialogs, the Moss gateway bridge, the Moss
//          account lane, discovery, rollback and teardown.
// Layer: Provider adapter tests

import { EventEmitter } from "node:events";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { PassThrough } from "node:stream";
import type { ChildProcess } from "node:child_process";

import * as NodeServices from "@effect/platform-node/NodeServices";
import {
  ApprovalRequestId,
  type ProviderRuntimeEvent,
  ThreadId,
  type TurnId,
} from "@moss/contracts";
import { Effect, Layer, Stream } from "effect";
import { afterEach, describe, expect, it, vi } from "vitest";

import type { AgentGatewayMcpFetch } from "../../agentGateway/mcpInjection.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { buildMossManagedPiProviderInstance } from "../mossManagedPiEnvironment.ts";
import {
  MOSS_PI_BRIDGE_ENV_KEY,
  MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY,
  MOSS_PI_RELOAD_COMMAND,
} from "../pi/mossPiExtension.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  buildPiAgentGatewayToolDescriptors,
  makePiAdapterLive,
  makePiRuntimeEventBase,
  makePiUserInputOptions,
  piInstalledGatewayToolNames,
  piRunOutcome,
} from "./PiAdapter.ts";

type Command = { readonly id: string; readonly type: string } & Record<string, unknown>;

const MODELS = [
  {
    provider: "openai",
    id: "gpt-5.5",
    name: "GPT-5.5",
    reasoning: true,
    contextWindow: 400_000,
  },
  { provider: "moss", id: "glm-5.3-flash", name: "GLM 5.3 Flash", reasoning: false },
];

/** One scripted `pi --mode rpc` child. */
class FakePi extends EventEmitter {
  readonly stdin = new PassThrough();
  readonly stdout = new PassThrough();
  readonly stderr = new PassThrough();
  readonly pid: number;
  exitCode: number | null = null;
  signalCode: NodeJS.Signals | null = null;
  readonly commands: Command[] = [];
  readonly uiResponses: Array<Record<string, unknown>> = [];
  /** Return true to take over a command; otherwise the defaults below answer it. */
  intercept: ((command: Command) => boolean) | undefined;
  /** When false, a started run stays active until `finishRun`. */
  autoFinish = true;
  runActive = false;
  sessionFile: string;
  readonly entries: Array<Record<string, unknown>> = [];
  private entrySeq = 0;
  private model: Record<string, unknown> | undefined = MODELS[0];

  constructor(
    readonly binary: string,
    readonly args: ReadonlyArray<string>,
    readonly env: NodeJS.ProcessEnv,
    pid: number,
  ) {
    super();
    this.pid = pid;
    const index = args.indexOf("--session");
    this.sessionFile = index >= 0 ? args[index + 1]! : `session-${pid}.jsonl`;
    let buffered = "";
    this.stdin.on("data", (chunk: Buffer) => {
      buffered += chunk.toString();
      let newline: number;
      while ((newline = buffered.indexOf("\n")) >= 0) {
        const record = JSON.parse(buffered.slice(0, newline)) as Command;
        buffered = buffered.slice(newline + 1);
        if (record.type === "extension_ui_response") {
          this.uiResponses.push(record);
          continue;
        }
        this.commands.push(record);
        if (this.intercept?.(record)) continue;
        this.answer(record);
      }
    });
    this.stdin.on("finish", () => this.exit(0));
  }

  send(record: Record<string, unknown>) {
    if (this.exitCode === null) this.stdout.write(`${JSON.stringify(record)}\n`);
  }

  respond(command: Command, data?: unknown) {
    this.send({
      id: command.id,
      type: "response",
      command: command.type,
      success: true,
      ...(data !== undefined ? { data } : {}),
    });
  }

  refuse(command: Command, error: string) {
    this.send({ id: command.id, type: "response", command: command.type, success: false, error });
  }

  exit(code: number) {
    if (this.exitCode !== null) return;
    this.exitCode = code;
    this.emit("exit", code, null);
  }

  commandsOf(type: string) {
    return this.commands.filter((command) => command.type === type);
  }

  addEntry(entry: Record<string, unknown>) {
    const id = `e${++this.entrySeq}`;
    const previous = this.entries.at(-1);
    this.entries.push({ ...entry, id, parentId: previous?.id ?? null });
    return id;
  }

  startRun(text: string) {
    this.runActive = true;
    this.send({ type: "agent_start" });
    this.send({ type: "turn_start" });
    const user = { role: "user", content: [{ type: "text", text }] };
    this.send({ type: "message_start", message: user });
    this.send({ type: "message_end", message: user });
    this.addEntry({ type: "message", message: user });
    if (this.autoFinish) this.finishRun();
  }

  finishRun(outcome: { readonly aborted?: boolean; readonly error?: string } = {}) {
    const assistant = {
      role: "assistant",
      content: [{ type: "text", text: "Answer" }],
      stopReason: outcome.aborted ? "aborted" : outcome.error ? "error" : "stop",
      ...(outcome.error ? { errorMessage: outcome.error } : {}),
    };
    this.send({ type: "message_start", message: { role: "assistant", content: [] } });
    this.send({
      type: "message_update",
      assistantMessageEvent: { type: "thinking_delta", contentIndex: 0, delta: "Considered" },
    });
    this.send({
      type: "message_update",
      assistantMessageEvent: { type: "text_delta", contentIndex: 1, delta: "Answer" },
    });
    this.send({ type: "message_end", message: assistant });
    this.addEntry({ type: "message", message: assistant });
    this.send({ type: "turn_end", message: assistant, toolResults: [] });
    this.send({ type: "agent_end", messages: [assistant], willRetry: false });
    this.runActive = false;
    this.send({ type: "agent_settled", aborted: outcome.aborted === true });
  }

  private answer(command: Command) {
    switch (command.type) {
      case "get_state":
        return this.respond(command, {
          model: this.model,
          thinkingLevel: "medium",
          isStreaming: this.runActive,
          sessionFile: this.sessionFile,
          sessionId: `sid-${this.pid}`,
        });
      case "get_entries": {
        const since = typeof command.since === "string" ? command.since : undefined;
        const index = since ? this.entries.findIndex((entry) => entry.id === since) : -1;
        return this.respond(command, {
          entries: this.entries.slice(index + 1),
          leafId: this.entries.at(-1)?.id ?? null,
        });
      }
      case "get_session_stats":
        return this.respond(command, {
          tokens: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, total: 15 },
          contextUsage: { tokens: 15, contextWindow: 400_000, percent: 0 },
        });
      case "get_available_models":
        return this.respond(command, { models: MODELS });
      case "set_model": {
        const found = MODELS.find(
          (model) => model.provider === command.provider && model.id === command.modelId,
        );
        if (!found)
          return this.refuse(command, `Model not found: ${command.provider}/${command.modelId}`);
        this.model = found;
        return this.respond(command, found);
      }
      case "get_commands":
        return this.respond(command, {
          commands: [
            { name: MOSS_PI_RELOAD_COMMAND, source: "extension", sourceInfo: {} },
            { name: "review", description: "Review", source: "prompt", sourceInfo: {} },
            {
              name: "skill:release",
              description: "Release notes",
              source: "skill",
              sourceInfo: { path: "/skills/release/SKILL.md", source: "auto" },
            },
          ],
        });
      case "get_messages":
        return this.respond(command, {
          messages: this.entries.flatMap((entry) => (entry.message ? [entry.message] : [])),
        });
      case "prompt": {
        const message = String(command.message);
        if (message.startsWith("/")) return this.respond(command, { disposition: "handled" });
        if (command.streamingBehavior && this.runActive) {
          return this.respond(command, { disposition: "queued" });
        }
        this.respond(command, { disposition: "started" });
        setImmediate(() => this.startRun(message));
        return;
      }
      case "abort":
        if (this.runActive) this.finishRun({ aborted: true });
        return this.respond(command);
      case "clear_queue":
        return this.respond(command, { steering: [], followUp: [] });
      case "fork":
        this.sessionFile = `fork-of-${this.sessionFile}`;
        return this.respond(command, { text: "first", cancelled: false });
      case "new_session":
        this.sessionFile = `new-${this.sessionFile}`;
        return this.respond(command, { cancelled: false });
      default:
        return this.respond(command);
    }
  }
}

const threadId = ThreadId.makeUnsafe("pi-cli-test");
const dirs: string[] = [];
const waitFor = (assertion: () => void) => vi.waitFor(assertion, { interval: 5, timeout: 3_000 });
const completions = (events: ProviderRuntimeEvent[]) =>
  events.filter((event) => event.type === "turn.completed");

afterEach(() => {
  vi.unstubAllEnvs();
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

function gatewayCredentials() {
  let sequence = 0;
  return {
    mcpEndpointUrl: "http://127.0.0.1:3773/mcp",
    setListeningPort: () => undefined,
    issueSessionToken: () => `unused-${++sequence}`,
    verifySessionToken: () => null,
    noteNativeMcpStartup: () => undefined,
    awaitNativeMcpStartup: () => Promise.resolve("ready" as const),
    verifySession: () => null,
    issueStdioBootstrapToken: () => null,
    exchangeStdioBootstrapToken: () => null,
    bindWriteAuthority: () => null,
    verifyWriteAuthority: () => false,
    registerInFlightRequest: () => () => undefined,
    cancelInFlightRequests: () => ({ count: 0, settled: Promise.resolve() }),
    cancelSessionTurnRequests: vi.fn<AgentGatewayCredentialsShape["cancelSessionTurnRequests"]>(
      () => Promise.resolve(),
    ),
    retireSessionTurn: vi.fn<AgentGatewayCredentialsShape["retireSessionTurn"]>(() =>
      Promise.resolve(),
    ),
    revokeSessionToken: vi.fn((_token: string) => undefined),
    connectionForThread: vi.fn(() => ({
      url: "http://127.0.0.1:3773/mcp",
      bearerToken: `lease-${++sequence}`,
    })),
    stdioProxy: { command: process.execPath, args: [] },
  } satisfies AgentGatewayCredentialsShape;
}

const gatewayFetch: AgentGatewayMcpFetch = async (_input, init) => {
  const body = JSON.parse(String(init?.body)) as { id: string; method: string; params?: unknown };
  const headers = new Headers(init?.headers);
  if (body.method === "tools/list") {
    return Response.json({
      jsonrpc: "2.0",
      id: body.id,
      result: {
        tools: [
          {
            name: "moss_list_threads",
            description: "List threads",
            inputSchema: { type: "object", properties: {} },
          },
        ],
      },
    });
  }
  return Response.json({
    jsonrpc: "2.0",
    id: body.id,
    result: {
      content: [{ type: "text", text: `called with ${headers.get("authorization")}` }],
    },
  });
};

interface Harness {
  readonly adapter: PiAdapterShape;
  readonly events: ProviderRuntimeEvent[];
  readonly spawned: FakePi[];
  readonly cwd: string;
  readonly stateDir: string;
  readonly teardowns: number[];
  readonly pi: () => FakePi;
  readonly send: (input?: string) => Promise<{ turnId: TurnId }>;
}

async function withAdapter(
  run: (harness: Harness) => Promise<void>,
  options: {
    readonly credentials?: AgentGatewayCredentialsShape;
    readonly start?: false | Partial<Parameters<PiAdapterShape["startSession"]>[0]>;
    readonly prepare?: (pi: FakePi) => void;
  } = {},
) {
  const cwd = mkdtempSync(path.join(tmpdir(), "moss-pi-cli-"));
  dirs.push(cwd);
  const stateRoot = path.join(cwd, "server");
  const spawned: FakePi[] = [];
  const teardowns: number[] = [];
  let pid = 1000;
  let layer = makePiAdapterLive({
    agentGatewayFetch: gatewayFetch,
    spawnProcess: (command, args, spawnOptions) => {
      const pi = new FakePi(command, args, spawnOptions.env ?? {}, ++pid);
      options.prepare?.(pi);
      spawned.push(pi);
      return pi as unknown as ChildProcess;
    },
    teardownProcessTree: async (input) => {
      teardowns.push(input.rootPid);
      spawned.find((pi) => pi.pid === input.rootPid)?.exit(1);
      await input.rootExited;
      return { escalated: false, signalErrors: [] };
    },
  }).pipe(
    Layer.provideMerge(ServerConfig.layerTest(cwd, stateRoot)),
    Layer.provideMerge(NodeServices.layer),
  );
  if (options.credentials) {
    layer = layer.pipe(Layer.provide(Layer.succeed(AgentGatewayCredentials, options.credentials)));
  }
  await Effect.runPromise(
    Effect.gen(function* () {
      const adapter = yield* PiAdapter;
      const config = yield* ServerConfig;
      const events: ProviderRuntimeEvent[] = [];
      yield* adapter.streamEvents.pipe(
        Stream.runForEach((event) => Effect.sync(() => events.push(event))),
        Effect.forkChild,
      );
      if (options.start !== false) {
        yield* adapter.startSession({
          threadId,
          cwd,
          runtimeMode: "full-access",
          providerOptions: { pi: { binaryPath: "C:/tools/pi.cmd" } },
          modelSelection: {
            provider: "pi",
            model: "openai/gpt-5.5",
            options: { thinkingLevel: "high" },
          },
          ...options.start,
        });
      }
      const harness: Harness = {
        adapter,
        events,
        spawned,
        cwd,
        stateDir: config.stateDir,
        teardowns,
        pi: () => spawned.at(-1)!,
        send: (input = "Test this turn") =>
          Effect.runPromise(adapter.sendTurn({ threadId, input })),
      };
      yield* Effect.promise(() => run(harness));
    }).pipe(Effect.provide(layer), Effect.scoped),
  );
}

describe("PiAdapter session start", () => {
  it("starts the person's Pi in RPC mode with the Moss extension and selects the model", async () => {
    await withAdapter(async ({ pi, events }) => {
      const fake = pi();
      expect(fake.binary).toBe("C:/tools/pi.cmd");
      expect(fake.args.slice(0, 3)).toEqual(["--mode", "rpc", "-e"]);
      expect(readFileSync(fake.args[3]!, "utf8")).toContain("Moss for Pi");
      expect(fake.env.PI_SKIP_VERSION_CHECK).toBe("1");
      expect(fake.env.MOSS_ACCESS_TOKEN).toBeUndefined();
      expect(fake.env[MOSS_PI_BRIDGE_ENV_KEY]).toBeUndefined();
      // The model is already openai/gpt-5.5, so only the thinking level changes.
      expect(fake.commandsOf("set_model")).toHaveLength(0);
      expect(fake.commandsOf("set_thinking_level")).toEqual([
        expect.objectContaining({ level: "high" }),
      ]);
      await waitFor(() =>
        expect(events.map((event) => event.type)).toEqual(
          expect.arrayContaining(["session.started", "thread.started"]),
        ),
      );
    });
  });

  it("resumes an existing Pi session file and starts fresh when it is gone", async () => {
    const cwd = mkdtempSync(path.join(tmpdir(), "moss-pi-resume-"));
    dirs.push(cwd);
    const sessionFile = path.join(cwd, "session.jsonl");
    writeFileSync(sessionFile, "");
    await withAdapter(
      async ({ pi, adapter }) => {
        expect(pi().args).toEqual(expect.arrayContaining(["--session", sessionFile]));
        const [session] = await Effect.runPromise(adapter.listSessions());
        expect(session?.resumeCursor).toBe(sessionFile);
      },
      { start: { resumeCursor: { sessionFile } } },
    );
    await withAdapter(async ({ pi }) => expect(pi().args).not.toContain("--session"), {
      start: { resumeCursor: path.join(cwd, "deleted.jsonl") },
    });
  });

  it("fails the start with Pi's own words when the CLI cannot run", async () => {
    await expect(
      withAdapter(async () => undefined, {
        prepare: (pi) => {
          pi.intercept = () => {
            pi.stderr.write("Error: Cannot find module 'node:sqlite'\n");
            setImmediate(() => pi.exit(1));
            return true;
          };
        },
      }),
    ).rejects.toThrow("Cannot find module 'node:sqlite'");
  });

  it("rejects an unknown model before anything is sent", async () => {
    await expect(
      withAdapter(async () => undefined, {
        start: { modelSelection: { provider: "pi", model: "openai/not-a-model" } },
      }),
    ).rejects.toThrow("not available");
  });
});

describe("PiAdapter turns", () => {
  it("streams text and reasoning, then completes once with token usage", async () => {
    await withAdapter(async ({ send, events, pi }) => {
      const turn = await send();
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(completions(events)[0]).toMatchObject({
        turnId: turn.turnId,
        payload: { state: "completed" },
      });
      const deltas = events.filter((event) => event.type === "content.delta");
      expect(deltas.map((event) => (event.payload as { streamKind: string }).streamKind)).toEqual([
        "reasoning_text",
        "assistant_text",
      ]);
      expect(events.some((event) => event.type === "thread.token-usage.updated")).toBe(true);
      expect(pi().commandsOf("prompt")[0]).toMatchObject({
        message: expect.stringContaining("Test this turn"),
      });
    });
  });

  it("queues a send during an active turn as a follow-up inside the same turn", async () => {
    await withAdapter(async ({ send, events, pi }) => {
      pi().autoFinish = false;
      const first = await send("First");
      await waitFor(() => expect(pi().runActive).toBe(true));
      const second = await send("Second");
      expect(second.turnId).toBe(first.turnId);
      await waitFor(() => expect(pi().commandsOf("prompt")).toHaveLength(2));
      expect(pi().commandsOf("prompt")[1]).toMatchObject({ streamingBehavior: "followUp" });
      pi().finishRun();
      await waitFor(() => expect(completions(events)).toHaveLength(1));
    });
  });

  it("steers a running turn and starts a fresh one when idle", async () => {
    await withAdapter(async ({ adapter, events, pi }) => {
      pi().autoFinish = false;
      const started = await Effect.runPromise(
        adapter.steerTurn!({ threadId, input: "Start here" }),
      );
      await waitFor(() => expect(pi().runActive).toBe(true));
      const joined = await Effect.runPromise(adapter.steerTurn!({ threadId, input: "Go left" }));
      expect(joined.turnId).toBe(started.turnId);
      await waitFor(() =>
        expect(pi().commandsOf("prompt").at(-1)).toMatchObject({ streamingBehavior: "steer" }),
      );
      pi().finishRun();
      await waitFor(() => expect(completions(events)).toHaveLength(1));
    });
  });

  it("interrupts a running turn: clears the queue, aborts and reports it interrupted", async () => {
    await withAdapter(
      async ({ adapter, send, events, pi }) => {
        pi().autoFinish = false;
        const turn = await send();
        await waitFor(() => expect(pi().runActive).toBe(true));
        await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
        await waitFor(() => expect(completions(events)).toHaveLength(1));
        expect(completions(events)[0]?.payload).toMatchObject({
          state: "interrupted",
          stopReason: "aborted",
        });
        const types = pi().commands.map((command) => command.type);
        expect(types.indexOf("clear_queue")).toBeLessThan(types.indexOf("abort"));
      },
      { credentials: gatewayCredentials() },
    );
  });

  it("lands an interrupt that arrives before Pi accepts the prompt", async () => {
    await withAdapter(async ({ adapter, send, events, pi }) => {
      let heldPrompt: Command | undefined;
      pi().autoFinish = false;
      pi().intercept = (command) => {
        if (command.type !== "prompt" || heldPrompt) return false;
        heldPrompt = command;
        return true;
      };
      const turn = await send();
      await waitFor(() => expect(heldPrompt).toBeDefined());
      await Effect.runPromise(adapter.interruptTurn(threadId, turn.turnId));
      // Pi now accepts the prompt and starts the run; the deferred abort must reach it.
      pi().respond(heldPrompt!, { disposition: "started" });
      pi().startRun("Test this turn");
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(completions(events)[0]?.payload).toMatchObject({ state: "interrupted" });
      expect(pi().commandsOf("abort").length).toBeGreaterThanOrEqual(2);
    });
  });

  it("fails the turn with Pi's refusal and a sign-in hint for a missing key", async () => {
    await withAdapter(async ({ send, events, pi }) => {
      pi().intercept = (command) => {
        if (command.type !== "prompt") return false;
        pi().refuse(command, "No API key for openai/gpt-5.5");
        return true;
      };
      await send();
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(completions(events)[0]?.payload).toMatchObject({
        state: "failed",
        errorMessage: expect.stringContaining("has no sign-in for GPT-5.5"),
      });
    });
  });

  it("reports a provider error from the run", async () => {
    await withAdapter(async ({ send, events, pi }) => {
      pi().autoFinish = false;
      await send();
      await waitFor(() => expect(pi().runActive).toBe(true));
      pi().finishRun({ error: "[rate_limit_exceeded] Rate limit exceeded" });
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(completions(events)[0]?.payload).toMatchObject({
        state: "failed",
        errorMessage: "[rate_limit_exceeded] Rate limit exceeded",
      });
      expect(events.some((event) => event.type === "runtime.error")).toBe(true);
    });
  });

  it("completes a handled extension command without waiting for a run", async () => {
    await withAdapter(async ({ send, events }) => {
      await send("/review");
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      expect(completions(events)[0]?.payload).toMatchObject({ state: "completed" });
    });
  });

  it("runs /reload through the Moss reload command", async () => {
    await withAdapter(async ({ send, events, pi }) => {
      await send("/reload");
      expect(pi().commandsOf("prompt").at(-1)).toMatchObject({
        message: `/${MOSS_PI_RELOAD_COMMAND}`,
      });
      await waitFor(() =>
        expect(completions(events).at(-1)?.payload).toMatchObject({ stopReason: "reload" }),
      );
    });
  });

  it("asks the person through Moss for an extension dialog and answers Pi", async () => {
    await withAdapter(async ({ adapter, events, pi }) => {
      pi().send({
        type: "extension_ui_request",
        id: "ui-1",
        method: "select",
        title: "Pick a mode",
        options: ["  Fast  ", "Careful"],
      });
      await waitFor(() =>
        expect(events.some((event) => event.type === "user-input.requested")).toBe(true),
      );
      const requested = events.find((event) => event.type === "user-input.requested")!;
      await Effect.runPromise(
        adapter.respondToUserInput(
          threadId,
          ApprovalRequestId.makeUnsafe(String(requested.requestId)),
          { selection: "Fast" },
        ),
      );
      await waitFor(() =>
        expect(pi().uiResponses).toEqual([
          { type: "extension_ui_response", id: "ui-1", value: "  Fast  " },
        ]),
      );
    });
  });

  it("rolls back by forking Pi from the first removed turn's user message", async () => {
    await withAdapter(async ({ adapter, send, events, pi }) => {
      await send("First");
      await waitFor(() => expect(completions(events)).toHaveLength(1));
      await send("Second");
      await waitFor(() => expect(completions(events)).toHaveLength(2));
      const secondUserEntry = pi().entries.filter(
        (entry) => (entry.message as { role?: string } | undefined)?.role === "user",
      )[1]!;
      await Effect.runPromise(adapter.rollbackThread(threadId, 1));
      expect(pi().commandsOf("fork")).toEqual([
        expect.objectContaining({ entryId: secondUserEntry.id }),
      ]);
      const [session] = await Effect.runPromise(adapter.listSessions());
      expect(session?.resumeCursor).toMatch(/^fork-of-/);
    });
  });
});

describe("PiAdapter Moss gateway tools", () => {
  it("bridges gateway calls through Moss and rotates the credential after each turn", async () => {
    const credentials = gatewayCredentials();
    await withAdapter(
      async ({ send, events, pi }) => {
        const fake = pi();
        const nonce = fake.env[MOSS_PI_BRIDGE_ENV_KEY];
        const toolsFile = fake.env[MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY];
        expect(nonce).toBeTruthy();
        expect(JSON.parse(readFileSync(toolsFile!, "utf8"))).toEqual([
          expect.objectContaining({ name: "moss_list_threads" }),
        ]);
        // No bearer ever reaches Pi's environment.
        expect(JSON.stringify(fake.env)).not.toContain("lease-");

        fake.send({
          type: "extension_ui_request",
          id: "bridge-1",
          method: "input",
          title: `moss-bridge:${nonce}`,
          placeholder: JSON.stringify({
            op: "call",
            toolCallId: "c1",
            name: "moss_list_threads",
            arguments: {},
          }),
        });
        await waitFor(() => expect(fake.uiResponses).toHaveLength(1));
        expect(JSON.parse(String(fake.uiResponses[0]!.value))).toMatchObject({
          ok: true,
          content: [{ type: "text", text: "called with Bearer lease-1" }],
        });
        // A forged title never reaches the person or the gateway.
        fake.send({
          type: "extension_ui_request",
          id: "bridge-2",
          method: "input",
          title: "moss-bridge:wrong",
          placeholder: "{}",
        });
        await waitFor(() => expect(fake.uiResponses).toHaveLength(2));
        expect(JSON.parse(String(fake.uiResponses[1]!.value))).toMatchObject({ ok: false });
        expect(events.some((event) => event.type === "user-input.requested")).toBe(false);

        const turn = await send();
        await waitFor(() => expect(completions(events)).toHaveLength(1));
        expect(credentials.retireSessionTurn).toHaveBeenCalledExactlyOnceWith(
          "lease-1",
          turn.turnId,
        );
        expect(credentials.revokeSessionToken).toHaveBeenCalledWith("lease-1");
        expect(credentials.connectionForThread).toHaveBeenCalledTimes(2);

        fake.send({
          type: "extension_ui_request",
          id: "bridge-3",
          method: "input",
          title: `moss-bridge:${nonce}`,
          placeholder: JSON.stringify({
            op: "call",
            toolCallId: "c2",
            name: "moss_list_threads",
            arguments: {},
          }),
        });
        await waitFor(() => expect(fake.uiResponses).toHaveLength(3));
        expect(String(fake.uiResponses[2]!.value)).toContain("Bearer lease-2");
      },
      { credentials },
    );
  });

  it("rejects enabled Computer startup when no gateway credentials are available", async () => {
    await expect(
      withAdapter(async () => undefined, { start: { enableComputerControl: true } }),
    ).rejects.toThrow("Pi did not receive a thread-scoped Moss gateway connection");
  });

  it("requires the real Computer tools before a Computer session starts", async () => {
    await expect(
      buildPiAgentGatewayToolDescriptors({
        connection: { url: "http://127.0.0.1:1/mcp", bearerToken: "t" },
        enableComputerControl: true,
        fetch: gatewayFetch,
      }),
    ).rejects.toThrow("missing required Computer tools");
    expect(piInstalledGatewayToolNames(["moss_list_threads"])).toEqual(
      new Set(["moss_list_threads"]),
    );
  });
});

describe("PiAdapter process lifetime", () => {
  it("reports an unexpected Pi exit as a failed turn and an exited session", async () => {
    await withAdapter(async ({ adapter, send, events, pi }) => {
      pi().autoFinish = false;
      await send();
      await waitFor(() => expect(pi().runActive).toBe(true));
      pi().stderr.write("FATAL: out of memory\n");
      await new Promise((resolve) => setImmediate(resolve));
      pi().exit(134);
      await waitFor(() =>
        expect(events.some((event) => event.type === "session.exited")).toBe(true),
      );
      expect(completions(events)[0]?.payload).toMatchObject({
        state: "failed",
        errorMessage: expect.stringContaining("out of memory"),
      });
      expect(await Effect.runPromise(adapter.hasSession(threadId))).toBe(false);
    });
  });

  it("closes Pi's input on stop and proves its process tree is gone", async () => {
    await withAdapter(async ({ adapter, pi, teardowns, events }) => {
      const fake = pi();
      await Effect.runPromise(adapter.stopSession(threadId));
      expect(fake.exitCode).toBe(0);
      expect(teardowns).toEqual([fake.pid]);
      await waitFor(() =>
        expect(events.at(-1)).toMatchObject({
          type: "session.exited",
          payload: { exitKind: "graceful" },
        }),
      );
    });
  });
});

describe("PiAdapter discovery", () => {
  it("kills a listing Pi that is still running when Moss shuts down", async () => {
    let spawned: FakePi[] = [];
    let teardowns: number[] = [];
    await withAdapter(
      async (harness) => {
        spawned = harness.spawned;
        teardowns = harness.teardowns;
        const listing = Effect.runPromise(
          harness.adapter.listModels!({ provider: "pi", cwd: harness.cwd }),
        ).catch(() => undefined);
        void listing;
        await waitFor(() => expect(spawned[0]?.commandsOf("get_available_models")).toHaveLength(1));
      },
      {
        start: false,
        // Pi never answers the model list: only shutdown can end this listing.
        prepare: (pi) => {
          pi.intercept = (command) => command.type === "get_available_models";
        },
      },
    );
    expect(teardowns).toContain(spawned[0]!.pid);
    expect(spawned[0]!.exitCode).not.toBeNull();
  });

  it("offers the default model the person picked in Pi's settings", async () => {
    await withAdapter(
      async ({ adapter, cwd }) => {
        const agentDir = path.join(cwd, "pi-agent");
        mkdirSync(agentDir, { recursive: true });
        writeFileSync(
          path.join(agentDir, "settings.json"),
          JSON.stringify({ defaultProvider: "moss", defaultModel: "glm-5.3-flash" }),
        );
        const models = await Effect.runPromise(
          adapter.listModels!({ provider: "pi", cwd, agentDir }),
        );
        expect(models.defaultModel).toBe("moss/glm-5.3-flash");
        expect(models.error).toBeUndefined();
      },
      { start: false },
    );
  });

  it("lists models, skills and commands from a short-lived Pi", async () => {
    await withAdapter(
      async ({ adapter, spawned, cwd, teardowns }) => {
        const models = await Effect.runPromise(adapter.listModels!({ provider: "pi", cwd }));
        expect(models.models.map((model) => model.slug)).toEqual([
          "openai/gpt-5.5",
          "moss/glm-5.3-flash",
        ]);
        expect(spawned[0]!.args).toEqual(expect.arrayContaining(["--no-session"]));
        expect(teardowns).toContain(spawned[0]!.pid);
        const skills = await Effect.runPromise(adapter.listSkills!({ provider: "pi", cwd }));
        expect(skills.skills).toEqual([
          expect.objectContaining({ name: "release", path: "/skills/release/SKILL.md" }),
        ]);
        const commands = await Effect.runPromise(adapter.listCommands!({ provider: "pi", cwd }));
        expect(commands.commands.map((command) => command.name)).toEqual([
          "reload",
          "review",
          "skill:release",
        ]);
      },
      { start: false },
    );
  });
});

describe("PiAdapter Moss account lane", () => {
  const gatewayBaseUrl = "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1";
  const managedEnvironment = () => {
    const instance = buildMossManagedPiProviderInstance({
      accessToken: "moss_sk_fake_test_token",
      gatewayBaseUrl,
      runtimeGeneration: "generation",
      realm: "cn",
      agentDir: path.join(tmpdir(), "moss-pi-managed-agent"),
      env: { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: gatewayBaseUrl },
    });
    return Object.fromEntries(instance.environment!.map((entry) => [entry.name, entry.value!]));
  };

  it("hands the Moss catalog and token only to Pi and selects a Moss model", async () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gatewayBaseUrl);
    await withAdapter(
      async ({ pi }) => {
        const fake = pi();
        expect(fake.env.MOSS_ACCESS_TOKEN).toBe("moss_sk_fake_test_token");
        expect(JSON.parse(fake.env.MOSS_PI_CONFIG_CONTENT!)).toMatchObject({ realm: "cn" });
        expect(fake.env.PI_OFFLINE).toBe("1");
        expect(fake.env.PI_CODING_AGENT_DIR).toBeTruthy();
        expect(fake.commandsOf("set_model")).toEqual([
          expect.objectContaining({ provider: "moss", modelId: "glm-5.3-flash" }),
        ]);
      },
      {
        start: {
          providerInstanceId: "pi_moss" as never,
          providerOptions: { pi: { environment: managedEnvironment() } },
          modelSelection: undefined,
        },
      },
    );
  });

  it("offers only Moss models on the Moss lane", async () => {
    vi.stubEnv("MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL", gatewayBaseUrl);
    await withAdapter(
      async ({ adapter, cwd }) => {
        const models = await Effect.runPromise(
          adapter.listModels!({
            provider: "pi",
            cwd,
            instanceId: "pi_moss" as never,
            environment: managedEnvironment(),
          }),
        );
        expect(models.models.map((model) => model.slug)).toEqual(["moss/glm-5.3-flash"]);
      },
      { start: false },
    );
  });
});

describe("Pi adapter helpers", () => {
  it("stamps events from the lifecycle generation captured by the session context", () => {
    expect(
      makePiRuntimeEventBase({
        lifecycleGeneration: "generation-pi-7",
        session: { threadId: "thread-pi" as never },
        activeTurnId: "turn-pi" as never,
      }),
    ).toMatchObject({
      provider: "pi",
      threadId: "thread-pi",
      turnId: "turn-pi",
      lifecycleGeneration: "generation-pi-7",
    });
  });

  it("keeps original select values while showing normalized unique labels", () => {
    const mappings = makePiUserInputOptions(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.value)).toEqual(["  OpenRouter  ", "", "OpenRouter"]);
    expect(mappings.map((mapping) => mapping.option.label)).toEqual([
      "OpenRouter",
      "Option 2",
      "OpenRouter (2)",
    ]);
  });

  it("reads a run's outcome from its last assistant message", () => {
    expect(piRunOutcome([{ role: "assistant", stopReason: "stop" }])).toBeUndefined();
    expect(piRunOutcome([{ role: "assistant", stopReason: "aborted" }])).toBe(
      "Request was aborted.",
    );
    expect(
      piRunOutcome([
        { role: "assistant", stopReason: "error", errorMessage: "boom" },
        { role: "user" },
      ]),
    ).toBe("boom");
    expect(piRunOutcome([{ role: "user" }])).toBeNull();
  });
});
