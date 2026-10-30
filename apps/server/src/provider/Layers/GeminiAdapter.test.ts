// FILE: GeminiAdapter.test.ts
// Purpose: SY9 — proves GeminiAdapter injects the canonical Moss MCP config
//   (<cwd>/.moss/mcp/config.json) into the ACP session/new + session/load
//   handshake through the REAL startSession -> bootstrapSessionContext path,
//   closing the SY8-refuted gap where this bespoke --acp path hardcoded
//   mcpServers: []. Drives the real adapter against a Gemini `--acp` mock agent
//   subprocess and reads back the session/new + session/load request payloads
//   the adapter wrote to the agent's stdin.
// Layer: Provider adapter tests
// Depends on: makeGeminiAdapterLive, gemini-acp-mock-agent.ts, ServerConfig test layer.
import {
  appendFileSync,
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { ThreadId, type ProviderSession } from "@synara/contracts";
import { deriveMossAcpMcpServers } from "@synara/shared/mossAcpMcpServers";
import * as mossAcpMcpServers from "@synara/shared/mossAcpMcpServers";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { it } from "@effect/vitest";
import { Cause, Effect, Exit, Fiber, Layer, Stream, type Scope } from "effect";
import { afterAll, afterEach, describe, expect, vi } from "vitest";

import {
  buildAcpMossMcpServers,
  type AcpInitializeCapabilitiesView,
} from "../../agentGateway/mcpInjection.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayCredentialsShape,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { ServerConfig } from "../../config.ts";
import { GeminiAdapter } from "../Services/GeminiAdapter.ts";
import { createMossPluginApprovalStore, discoverMossPluginRuntime } from "../mossPluginRuntime.ts";
import { makeGeminiAdapterLive, type GeminiAdapterLiveOptions } from "./GeminiAdapter.ts";
import { writeNativeNodeCliFixture } from "../../testing/nativeNodeCliFixtures.ts";
import { createWindowsTeardownProcessSnapshotObserver } from "../../platform/windowsProcessSnapshot.ts";
import { teardownProviderProcessTree } from "../../platform/supervisedProcessTeardown.ts";

const ownedGeminiHome = vi.hoisted(() => ({ path: undefined as string | undefined }));
vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  const fs = await import("node:fs");
  const paths = await import("node:path");
  const home = fs.mkdtempSync(paths.join(actual.tmpdir(), "moss-gemini-owned-home-"));
  ownedGeminiHome.path = home;
  return { ...actual, homedir: () => home, default: { ...actual, homedir: () => home } };
});

afterAll(() => {
  if (ownedGeminiHome.path) rmSync(ownedGeminiHome.path, { recursive: true, force: true });
});

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const mockAgentPath = path.join(__dirname, "../../../scripts/gemini-acp-mock-agent.ts");

const MOSS_MCP_CONFIG = {
  mcpServers: {
    "moss-probe": {
      command: "moss-probe-bin",
      args: ["--stdio"],
      env: { MOSS_MCP: "1" },
    },
    remote: { type: "http", url: "https://mcp.example.com" },
  },
} as const;

const tempDirs: string[] = [];

function makeGatewayCredentialsFixture(options?: { readonly distinctSessionTokens?: boolean }) {
  const distinctSessionTokens = options?.distinctSessionTokens === true;
  const revokedTokens: string[] = [];
  const issuedBootstrapTokens: string[] = [];
  const issuedBootstrapSessionTokens: string[] = [];
  const sessionTokens: string[] = [];
  const cancelledTurns: Array<{ readonly token: string; readonly turnId: string }> = [];
  const retiredTurns: Array<{ readonly token: string; readonly turnId: string }> = [];
  const lifecycle: string[] = [];
  let sessionTokenSequence = 0;
  const issueStdioBootstrapToken = vi.fn<(sessionToken: string) => string | null>(
    (sessionToken) => {
      if (distinctSessionTokens && !sessionTokens.includes(sessionToken)) {
        return null;
      }
      const token = distinctSessionTokens
        ? `gemini-bootstrap-${sessionToken}-${issuedBootstrapTokens.length + 1}`
        : `gemini-bootstrap-${issuedBootstrapTokens.length + 1}`;
      issuedBootstrapTokens.push(token);
      issuedBootstrapSessionTokens.push(sessionToken);
      return token;
    },
  );
  const credentials: AgentGatewayCredentialsShape = {
    mcpEndpointUrl: "http://127.0.0.1:48123/mcp",
    setListeningPort: vi.fn(),
    issueSessionToken: vi.fn(() => "gemini-gateway-token"),
    verifySessionToken: vi.fn(() => null),
    verifySession: vi.fn(() => null),
    issueStdioBootstrapToken,
    exchangeStdioBootstrapToken: vi.fn(() => null),
    bindWriteAuthority: vi.fn(() => null),
    verifyWriteAuthority: vi.fn(() => false),
    registerInFlightRequest: vi.fn(() => () => undefined),
    cancelInFlightRequests: vi.fn(() => ({ count: 0, settled: Promise.resolve() })),
    cancelSessionTurnRequests: (token, turnId) => {
      lifecycle.push(`gateway.cancel:${turnId}`);
      cancelledTurns.push({ token, turnId });
      return Promise.resolve();
    },
    retireSessionTurn: (token, turnId) => {
      lifecycle.push(`gateway.retire:${turnId}`);
      retiredTurns.push({ token, turnId });
      return Promise.resolve();
    },
    revokeSessionToken: (token) => {
      lifecycle.push(`gateway.revoke:${token}`);
      revokedTokens.push(token);
    },
    noteNativeMcpStartup: () => undefined,
    awaitNativeMcpStartup: () => Promise.resolve("inactive" as const),
    connectionForThread: vi.fn(() => {
      const bearerToken = distinctSessionTokens
        ? `gemini-gateway-token-${++sessionTokenSequence}`
        : "gemini-gateway-token";
      sessionTokens.push(bearerToken);
      return {
        url: "http://127.0.0.1:48123/mcp",
        bearerToken,
      };
    }),
    stdioProxy: {
      command: process.execPath,
      args: ["/tmp/moss-agent-gateway-stdio-proxy.mjs"],
    },
  };
  return {
    credentials,
    revokedTokens,
    issuedBootstrapTokens,
    issuedBootstrapSessionTokens,
    sessionTokens,
    cancelledTurns,
    retiredTurns,
    lifecycle,
    issueStdioBootstrapToken,
  };
}

function makeTempDir(prefix: string): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

async function observeOwnedNativeProcess(recordPath: string, cwd: string, moduleUrl: string) {
  const deadline = Date.now() + 5_000;
  // Start the real observer while the owned child starts. Its readiness work
  // and the fresh targeted identity query share the same absolute 5s bound.
  const observer = createWindowsTeardownProcessSnapshotObserver({
    startImmediately: true,
    probeTimeoutMs: 5_000,
  });
  try {
    while (!existsSync(recordPath)) {
      if (Date.now() >= deadline)
        throw new Error("Owned native Gemini process record was not written");
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    const record = JSON.parse(readFileSync(recordPath, "utf8")) as {
      pid: number;
      cwd: string;
      moduleUrl: string;
    };
    expect(Number.isSafeInteger(record.pid) && record.pid > 1 && record.pid !== process.pid).toBe(
      true,
    );
    expect(path.resolve(record.cwd).toLowerCase()).toBe(path.resolve(cwd).toLowerCase());
    expect(record.moduleUrl).toBe(moduleUrl);
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error("Owned native Gemini observation deadline expired");
    const capture = observer.capturePidsWithin;
    if (!capture) throw new Error("Bounded native identity capture is required");
    const snapshot = await capture([record.pid], remaining);
    expect(snapshot, JSON.stringify(observer.lastFailure?.())).not.toBeNull();
    const identity =
      snapshot &&
      Array.from(snapshot.values())
        .flat()
        .find((entry) => entry.pid === record.pid);
    expect(identity?.identityKind).toBe("windows-start-time");
    expect(identity?.startedAt).toEqual(expect.any(String));
    return { pid: record.pid, startedAt: identity!.startedAt! };
  } finally {
    observer.dispose();
  }
}

function expectOwnedNativeProcessExited(pid: number): void {
  try {
    process.kill(pid, 0);
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
    return;
  }
  throw new Error(`Owned native Gemini process ${pid} still exists after cleanup`);
}

function causeRetainsError<E>(cause: Cause.Cause<E>, expected: unknown): boolean {
  const seen = new Set<unknown>();
  const retains = (value: unknown): boolean => {
    if (value === expected) return true;
    if (seen.has(value)) return false;
    seen.add(value);
    if (value instanceof AggregateError && value.errors.some(retains)) return true;
    return value instanceof Error && retains(value.cause);
  };
  return cause.reasons.some((reason) =>
    reason._tag === "Fail"
      ? retains(reason.error)
      : reason._tag === "Die"
        ? retains(reason.defect)
        : false,
  );
}

function makeGeminiSessionFileFixture(): string {
  const tempRoot = path.join(os.homedir(), ".gemini", "tmp");
  mkdirSync(tempRoot, { recursive: true });
  const root = mkdtempSync(path.join(tempRoot, "hel39-rollback-"));
  tempDirs.push(root);
  const chatsDir = path.join(root, "chats");
  mkdirSync(chatsDir, { recursive: true });
  const filePath = path.join(chatsDir, "session-gemini-m-hel39-rollback.json");
  writeFileSync(
    filePath,
    `${JSON.stringify({
      sessionId: "gemini-mock-session-1",
      messages: [],
      startTime: new Date().toISOString(),
      lastUpdated: new Date().toISOString(),
    })}\n`,
    "utf8",
  );
  return filePath;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop();
    if (dir) {
      rmSync(dir, { recursive: true, force: true });
    }
  }
});

interface HarnessResult {
  readonly requestLog: string;
  readonly requestLogPath: string;
  readonly startup: Exit.Exit<ProviderSession, unknown>;
  readonly threadId: ThreadId;
}

/**
 * Write a fake `gemini` binary (an executable wrapper that execs the mock ACP
 * agent), then drive the REAL GeminiAdapter.startSession against it with the
 * given cwd + resume cursor. Returns the raw incoming JSON-RPC request log the
 * agent captured (one line per request the adapter wrote to stdin), so tests
 * can assert on the session/new + session/load payloads.
 */
function runStartSession(input: {
  readonly cwd: string;
  readonly failLoad?: boolean;
  readonly failNew?: boolean;
  readonly httpMcp?: boolean;
  readonly promptHang?: boolean;
  readonly exitDuringPrompt?: boolean;
  readonly keepSession?: boolean;
  readonly resumeSessionId?: string;
  readonly resumeSnapshots?: ReadonlyArray<{
    readonly turnId: string;
    readonly sessionId: string;
    readonly items: ReadonlyArray<unknown>;
  }>;
  readonly runtimeMode?: "approval-required" | "full-access";
  readonly requireTrustForPrivilegedMode?: boolean;
  readonly observeNativeLifecycle?: boolean;
}): Effect.Effect<HarnessResult, unknown, GeminiAdapter | Scope.Scope> {
  return Effect.gen(function* () {
    const runtimeDir = makeTempDir("sy9-gemini-runtime-");
    const requestLog = path.join(runtimeDir, "requests.ndjson");
    writeFileSync(requestLog, "", "utf8");
    const nativeRecordPath = path.join(runtimeDir, "native-process.json");
    let modulePath = mockAgentPath;
    if (process.platform === "win32" && input.observeNativeLifecycle) {
      modulePath = path.join(runtimeDir, "observed-gemini.mjs");
      writeFileSync(
        modulePath,
        [
          'import { writeFileSync } from "node:fs";',
          `writeFileSync(${JSON.stringify(nativeRecordPath)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), moduleUrl: ${JSON.stringify(pathToFileURL(mockAgentPath).href)} }), { flag: "wx" });`,
          `await import(${JSON.stringify(pathToFileURL(mockAgentPath).href)});`,
        ].join("\n"),
        { encoding: "utf8", flag: "wx" },
      );
    }

    // Fake `gemini` binary: an executable shell wrapper that runs the mock ACP
    // agent. spawnGeminiProcess appends `--acp`, which the agent ignores.
    const binaryPath =
      process.platform === "win32"
        ? writeNativeNodeCliFixture({
            directory: runtimeDir,
            name: "gemini-fake",
            modulePath,
          })
        : path.join(runtimeDir, "gemini-fake");
    if (process.platform !== "win32") {
      writeFileSync(
        binaryPath,
        `#!/bin/sh\nexec bun ${JSON.stringify(mockAgentPath)} "$@"\n`,
        "utf8",
      );
      chmodSync(binaryPath, 0o755);
    }

    const previousLogEnv = process.env.T3_GEMINI_ACP_REQUEST_LOG_PATH;
    const previousFailLoadEnv = process.env.T3_GEMINI_ACP_FAIL_LOAD;
    const previousFailNewEnv = process.env.T3_GEMINI_ACP_FAIL_NEW;
    const previousHttpMcpEnv = process.env.T3_GEMINI_ACP_HTTP_MCP;
    const previousPromptHangEnv = process.env.T3_GEMINI_ACP_PROMPT_HANG;
    const previousExitDuringPromptEnv = process.env.T3_GEMINI_ACP_EXIT_DURING_PROMPT;
    process.env.T3_GEMINI_ACP_REQUEST_LOG_PATH = requestLog;
    if (input.failLoad) {
      process.env.T3_GEMINI_ACP_FAIL_LOAD = "1";
    } else {
      delete process.env.T3_GEMINI_ACP_FAIL_LOAD;
    }
    if (input.failNew) {
      process.env.T3_GEMINI_ACP_FAIL_NEW = "1";
    } else {
      delete process.env.T3_GEMINI_ACP_FAIL_NEW;
    }
    if (input.httpMcp) {
      process.env.T3_GEMINI_ACP_HTTP_MCP = "1";
    } else {
      delete process.env.T3_GEMINI_ACP_HTTP_MCP;
    }
    if (input.promptHang) {
      process.env.T3_GEMINI_ACP_PROMPT_HANG = "1";
    } else {
      delete process.env.T3_GEMINI_ACP_PROMPT_HANG;
    }
    if (input.exitDuringPrompt) {
      process.env.T3_GEMINI_ACP_EXIT_DURING_PROMPT = "1";
    } else {
      delete process.env.T3_GEMINI_ACP_EXIT_DURING_PROMPT;
    }

    const adapter = yield* GeminiAdapter;
    const threadId = ThreadId.makeUnsafe(`sy9-${path.basename(runtimeDir)}`);

    const restoreEnvironment = () => {
      const restore = (key: string, value: string | undefined) => {
        if (value === undefined) {
          delete process.env[key];
        } else {
          process.env[key] = value;
        }
      };
      restore("T3_GEMINI_ACP_REQUEST_LOG_PATH", previousLogEnv);
      restore("T3_GEMINI_ACP_FAIL_LOAD", previousFailLoadEnv);
      restore("T3_GEMINI_ACP_FAIL_NEW", previousFailNewEnv);
      restore("T3_GEMINI_ACP_HTTP_MCP", previousHttpMcpEnv);
      restore("T3_GEMINI_ACP_PROMPT_HANG", previousPromptHangEnv);
      restore("T3_GEMINI_ACP_EXIT_DURING_PROMPT", previousExitDuringPromptEnv);
    };

    const startup = yield* Effect.exit(
      adapter.startSession({
        provider: "gemini",
        threadId,
        cwd: input.cwd,
        runtimeMode: input.runtimeMode ?? "approval-required",
        ...(input.resumeSessionId
          ? {
              resumeCursor: {
                sessionId: input.resumeSessionId,
                ...(input.resumeSnapshots ? { snapshots: input.resumeSnapshots } : {}),
              },
            }
          : {}),
        providerOptions: {
          gemini: {
            binaryPath,
            ...(input.requireTrustForPrivilegedMode
              ? {
                  environment: {
                    T3_GEMINI_ACP_REQUIRE_TRUST_FOR_PRIVILEGED: "1",
                  },
                }
              : {}),
          },
        },
      }),
    );
    yield* Effect.gen(function* () {
      let nativeIdentity: { readonly pid: number; readonly startedAt: string } | undefined;
      if (
        startup._tag === "Success" &&
        process.platform === "win32" &&
        input.observeNativeLifecycle
      ) {
        nativeIdentity = yield* Effect.promise(() =>
          observeOwnedNativeProcess(nativeRecordPath, input.cwd, pathToFileURL(mockAgentPath).href),
        );
      }
      if (startup._tag === "Success" && !input.keepSession) {
        yield* adapter.stopSession(threadId);
      }
      if (nativeIdentity && !input.keepSession) {
        let stillRunning = true;
        try {
          process.kill(nativeIdentity.pid, 0);
        } catch (cause) {
          if ((cause as NodeJS.ErrnoException).code !== "ESRCH") throw cause;
          stillRunning = false;
        }
        console.info("Owned Gemini native stop observation", {
          ...nativeIdentity,
          cwd: input.cwd,
          stillRunning,
        });
        expect(stillRunning, "stopSession must settle the witnessed owned native process").toBe(
          false,
        );
      }
    }).pipe(Effect.ensuring(Effect.sync(restoreEnvironment)));

    const captured = readFileSync(requestLog, "utf8");
    const dumpPath = process.env.SY9_DUMP_REQUESTS_PATH;
    if (dumpPath) {
      // Evidence hook: append the raw JSON-RPC the adapter wrote to the mock
      // agent's stdin so .moss/program/evidence/SY9 can capture the real
      // session/new + session/load payloads.
      appendFileSync(
        dumpPath,
        `===SY9-REQUESTS cwd=${input.cwd} resume=${
          input.resumeSessionId ?? "-"
        }===\n${captured}===SY9-REQUESTS-END===\n`,
        "utf8",
      );
    }
    return {
      requestLog: captured,
      requestLogPath: requestLog,
      startup,
      threadId,
    } satisfies HarnessResult;
  });
}

interface LoggedRequest {
  readonly method: string;
  readonly params: Record<string, unknown>;
}

function parseRequests(requestLog: string): LoggedRequest[] {
  return requestLog
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => JSON.parse(line) as Record<string, unknown>)
    .filter(
      (message): message is { method: string; params: Record<string, unknown> } =>
        typeof message.method === "string",
    )
    .map((message) => ({
      method: message.method,
      params: (message.params ?? {}) as Record<string, unknown>,
    }));
}

function findRequest(requests: LoggedRequest[], method: string): LoggedRequest | undefined {
  return requests.find((request) => request.method === method);
}

async function waitForRequestMethod(
  requestLogPath: string,
  method: string,
  timeoutMs = 3_000,
): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const requestLog = readFileSync(requestLogPath, "utf8");
    if (parseRequests(requestLog).some((request) => request.method === method)) {
      return requestLog;
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 10));
  }
  return readFileSync(requestLogPath, "utf8");
}

function makeWorkspaceWithMossConfig(): string {
  const cwd = makeTempDir("sy9-gemini-ws-");
  mkdirSync(path.join(cwd, ".moss", "mcp"), { recursive: true });
  writeFileSync(
    path.join(cwd, ".moss", "mcp", "config.json"),
    `${JSON.stringify(MOSS_MCP_CONFIG)}\n`,
    "utf8",
  );
  return cwd;
}

function makeWorkspaceWithApprovedPluginFixture(): string {
  const cwd = makeTempDir("sy9-gemini-plugin-ws-");
  const pluginRoot = path.join(cwd, ".moss", "plugins", "gemini-kit");
  mkdirSync(path.join(pluginRoot, ".codex-plugin"), { recursive: true });
  writeFileSync(
    path.join(pluginRoot, ".mcp.json"),
    JSON.stringify({
      mcpServers: { "gemini-plugin": { command: "gemini-plugin-mcp", args: ["--stdio"] } },
    }),
    "utf8",
  );
  writeFileSync(
    path.join(pluginRoot, ".codex-plugin", "plugin.json"),
    `${JSON.stringify({
      name: "gemini-kit",
      version: "1.0.0",
      description: "Gemini plugin read-back fixture.",
      author: { name: "Moss" },
      interface: {
        displayName: "Gemini Kit",
        shortDescription: "Gemini plugin",
        longDescription: "Gemini plugin read-back fixture.",
        developerName: "Moss",
        category: "Productivity",
        capabilities: ["MCP"],
        defaultPrompt: ["Use the Gemini plugin"],
      },
      mcpServers: "./.mcp.json",
    })}\n`,
    "utf8",
  );
  return cwd;
}

function provide<A, E>(
  effect: Effect.Effect<A, E, GeminiAdapter | Scope.Scope>,
  pluginApprovalStore?: GeminiAdapterLiveOptions["pluginApprovalStore"],
  gatewayCredentials?: AgentGatewayCredentialsShape,
  adapterOverrides?: GeminiAdapterLiveOptions,
): Effect.Effect<A, E, never> {
  const configDir = makeTempDir("sy9-gemini-cfg-");
  const adapterOptions = {
    ...adapterOverrides,
    ...(pluginApprovalStore ? { pluginApprovalStore } : {}),
  };
  const adapterLayer = gatewayCredentials
    ? makeGeminiAdapterLive(adapterOptions).pipe(
        Layer.provide(Layer.succeed(AgentGatewayCredentials, gatewayCredentials)),
      )
    : makeGeminiAdapterLive(adapterOptions);
  return effect.pipe(
    Effect.provide(adapterLayer),
    Effect.provide(ServerConfig.layerTest(configDir, configDir)),
    Effect.scoped,
    Effect.provide(NodeServices.layer),
  ) as Effect.Effect<A, E, never>;
}

describe("GeminiAdapter Moss MCP injection (SY9)", () => {
  it.effect.runIf(process.platform === "win32")(
    "retires an owned native Gemini startup when its bootstrap is interrupted",
    () => {
      const fixture = makeGatewayCredentialsFixture();
      const teardown = vi.fn<typeof teardownProviderProcessTree>((input, dependencies) =>
        teardownProviderProcessTree(input, dependencies),
      );
      return Effect.gen(function* () {
        const root = makeTempDir("moss-gemini-interrupted-start-");
        const cwd = makeTempDir("moss-gemini-interrupted-workspace-");
        const recordPath = path.join(root, "native-process.json");
        const modulePath = path.join(root, "waiting-bootstrap.mjs");
        const moduleUrl = pathToFileURL(modulePath).href;
        writeFileSync(
          modulePath,
          [
            'import { writeFileSync } from "node:fs";',
            `writeFileSync(${JSON.stringify(recordPath)}, JSON.stringify({ pid: process.pid, cwd: process.cwd(), moduleUrl: import.meta.url }), { flag: "wx" });`,
            "setInterval(() => {}, 1000);",
            "await new Promise(() => {});",
          ].join("\n"),
          { encoding: "utf8", flag: "wx" },
        );
        const binaryPath = writeNativeNodeCliFixture({
          directory: root,
          name: "waiting-gemini",
          modulePath,
        });
        const adapter = yield* GeminiAdapter;
        yield* Effect.acquireUseRelease(
          Effect.forkScoped(
            adapter.startSession({
              provider: "gemini",
              threadId: ThreadId.makeUnsafe("owned-interrupted-start"),
              cwd,
              runtimeMode: "approval-required",
              providerOptions: { gemini: { binaryPath } },
            }),
          ),
          (fiber) =>
            Effect.gen(function* () {
              const identity = yield* Effect.promise(() =>
                observeOwnedNativeProcess(recordPath, cwd, moduleUrl),
              );
              yield* Fiber.interrupt(fiber);
              const exit = yield* Fiber.await(fiber);
              expect(Exit.isFailure(exit)).toBe(true);
              if (Exit.isFailure(exit)) expect(Cause.hasInterrupts(exit.cause)).toBe(true);
              expectOwnedNativeProcessExited(identity.pid);
              expect(yield* adapter.listSessions()).toEqual([]);
              expect(teardown).toHaveBeenCalledTimes(1);
              expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
            }),
          (fiber) => Fiber.interrupt(fiber),
        );
      }).pipe((effect) =>
        provide(effect, undefined, fixture.credentials, { teardownProcessTree: teardown }),
      );
    },
  );

  it.effect.runIf(process.platform === "win32")(
    "retains an unpublished rollback candidate after cleanup proof fails and reports it at adapter finalization",
    () => {
      const fixture = makeGatewayCredentialsFixture({ distinctSessionTokens: true });
      const withheldProof = new Error(
        "Owned rollback candidate proof withheld after real native exit",
      );
      const retiredPids: number[] = [];
      const teardown = vi.fn<typeof teardownProviderProcessTree>(async (input, dependencies) => {
        const result = await teardownProviderProcessTree(input, dependencies);
        retiredPids.push(input.rootPid);
        if (retiredPids.length === 1) throw withheldProof;
        return result;
      });
      return Effect.gen(function* () {
        const closed = yield* Effect.exit(
          Effect.gen(function* () {
            const cwd = makeTempDir("moss-gemini-owned-rollback-candidate-");
            const initial = yield* runStartSession({
              cwd,
              keepSession: true,
              resumeSessionId: "owned-snapshot-session",
              resumeSnapshots: [
                { turnId: "owned-snapshot-turn", sessionId: "owned-snapshot-session", items: [] },
              ],
            });
            expect(Exit.isSuccess(initial.startup)).toBe(true);
            const adapter = yield* GeminiAdapter;
            expect((yield* adapter.readThread(initial.threadId)).turns).toHaveLength(1);
            fixture.issueStdioBootstrapToken.mockReturnValueOnce(null);
            const rolled = yield* Effect.exit(adapter.rollbackThread(initial.threadId, 1));
            expect(Exit.isFailure(rolled)).toBe(true);
            if (Exit.isFailure(rolled))
              expect(causeRetainsError(rolled.cause, withheldProof)).toBe(true);
            expect(yield* adapter.listSessions()).toHaveLength(1);
            expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-2"]);
            yield* adapter.stopSession(initial.threadId);
            expect(yield* adapter.listSessions()).toEqual([]);
            expect(retiredPids).toHaveLength(2);
          }).pipe((effect) =>
            provide(effect, undefined, fixture.credentials, { teardownProcessTree: teardown }),
          ),
        );
        expect(Exit.isFailure(closed)).toBe(true);
        if (Exit.isFailure(closed))
          expect(causeRetainsError(closed.cause, withheldProof)).toBe(true);
        expect(teardown).toHaveBeenCalledTimes(2);
        retiredPids.forEach(expectOwnedNativeProcessExited);
        expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-2", "gemini-gateway-token-1"]);
      });
    },
  );

  it.effect.runIf(process.platform === "win32")(
    "preserves an original bootstrap defect together with a cleanup proof failure",
    () => {
      const originalDefect = new Error("Owned bootstrap defect");
      const withheldProof = new Error("Owned startup proof withheld after real native exit");
      const derivation = vi
        .spyOn(mossAcpMcpServers, "deriveMossAcpMcpServers")
        .mockRejectedValueOnce(originalDefect);
      const retiredPids: number[] = [];
      const teardown = vi.fn<typeof teardownProviderProcessTree>(async (input, dependencies) => {
        await teardownProviderProcessTree(input, dependencies);
        retiredPids.push(input.rootPid);
        throw withheldProof;
      });
      return Effect.gen(function* () {
        const closed = yield* Effect.exit(
          Effect.gen(function* () {
            const cwd = makeTempDir("moss-gemini-owned-bootstrap-defect-");
            const result = yield* runStartSession({ cwd });
            expect(Exit.isFailure(result.startup)).toBe(true);
            if (Exit.isFailure(result.startup)) {
              expect(Cause.hasDies(result.startup.cause)).toBe(true);
              expect(causeRetainsError(result.startup.cause, originalDefect)).toBe(true);
              expect(causeRetainsError(result.startup.cause, withheldProof)).toBe(true);
            }
          }).pipe((effect) =>
            provide(effect, undefined, undefined, { teardownProcessTree: teardown }),
          ),
        );
        expect(Exit.isFailure(closed)).toBe(true);
        if (Exit.isFailure(closed))
          expect(causeRetainsError(closed.cause, withheldProof)).toBe(true);
        expect(teardown).toHaveBeenCalledTimes(1);
        retiredPids.forEach(expectOwnedNativeProcessExited);
      }).pipe(Effect.ensuring(Effect.sync(() => derivation.mockRestore())));
    },
  );

  it.effect("trusts the workspace only when full access requires Gemini's privileged mode", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-full-access-");
      const { requestLog } = yield* runStartSession({
        cwd,
        runtimeMode: "full-access",
        requireTrustForPrivilegedMode: true,
        observeNativeLifecycle: true,
      });

      expect(findRequest(parseRequests(requestLog), "session/set_mode")?.params).toMatchObject({
        modeId: "yolo",
      });
    }).pipe(provide),
  );
  it.effect(
    "installs the thread-scoped gateway after initialize and keeps project/plugin names unique",
    () => {
      const fixture = makeGatewayCredentialsFixture();
      return Effect.gen(function* () {
        const cwd = makeTempDir("sy9-gemini-gateway-ws-");
        mkdirSync(path.join(cwd, ".moss", "mcp"), { recursive: true });
        writeFileSync(
          path.join(cwd, ".moss", "mcp", "config.json"),
          `${JSON.stringify({
            mcpServers: {
              // A workspace cannot shadow the canonical gateway name once the
              // credentials layer is present.
              moss: { command: "shadow-moss", args: [] },
              ...MOSS_MCP_CONFIG.mcpServers,
            },
          })}\n`,
          "utf8",
        );

        const { requestLog } = yield* runStartSession({ cwd });
        const sessionNew = findRequest(parseRequests(requestLog), "session/new");
        const servers =
          (sessionNew?.params.mcpServers as ReadonlyArray<Record<string, unknown>> | undefined) ??
          [];
        const names = servers.map((server) => server.name);

        expect(names).toEqual(["moss-probe", "remote", "moss"]);
        expect(new Set(names).size).toBe(names.length);
        expect(servers.at(-1)).toMatchObject({
          name: "moss",
          command: process.execPath,
          args: ["/tmp/moss-agent-gateway-stdio-proxy.mjs"],
          env: [
            { name: "MOSS_AGENT_GATEWAY_URL", value: "http://127.0.0.1:48123/mcp" },
            {
              name: "MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
              value: "gemini-bootstrap-1",
            },
            { name: "ELECTRON_RUN_AS_NODE", value: "1" },
          ],
        });
        expect(JSON.stringify(requestLog)).not.toContain("gemini-gateway-token");
        expect(fixture.issuedBootstrapTokens).toEqual(["gemini-bootstrap-1"]);
        expect(fixture.credentials.connectionForThread).toHaveBeenCalledWith(
          expect.anything(),
          "gemini",
        );
      })
        .pipe((effect) => provide(effect, undefined, fixture.credentials))
        .pipe(
          Effect.tap(() =>
            Effect.sync(() => {
              expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
            }),
          ),
        );
    },
  );

  it.effect("mints a fresh bootstrap token for Gemini load fallback to session/new", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-gateway-fallback-ws-");
      const { requestLog } = yield* runStartSession({
        cwd,
        failLoad: true,
        resumeSessionId: "gemini-mock-session-1",
      });
      const requests = parseRequests(requestLog);
      const load = findRequest(requests, "session/load");
      const fresh = findRequest(requests, "session/new");
      const bootstrapFrom = (request: LoggedRequest | undefined): string | undefined => {
        const server = (
          (request?.params.mcpServers as ReadonlyArray<Record<string, unknown>> | undefined) ?? []
        ).find((entry) => entry.name === "moss");
        const env = (server?.env as ReadonlyArray<Record<string, unknown>> | undefined) ?? [];
        return env.find((entry) => entry.name === "MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN")?.value as
          | string
          | undefined;
      };
      const loadBootstrap = bootstrapFrom(load);
      const freshBootstrap = bootstrapFrom(fresh);
      expect(loadBootstrap).toBe("gemini-bootstrap-1");
      expect(freshBootstrap).toBe("gemini-bootstrap-2");
      expect(freshBootstrap).not.toBe(loadBootstrap);
      expect(requestLog).not.toContain("gemini-gateway-token");
      expect(fixture.issuedBootstrapTokens).toEqual(["gemini-bootstrap-1", "gemini-bootstrap-2"]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("fails closed when bootstrap construction fails without load/new fallback", () => {
    const fixture = makeGatewayCredentialsFixture();
    fixture.issueStdioBootstrapToken.mockImplementationOnce(() => null);
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-gateway-bootstrap-fail-ws-");
      const result = yield* runStartSession({
        cwd,
        resumeSessionId: "gemini-mock-session-1",
      });

      expect(Exit.isFailure(result.startup)).toBe(true);
      const methods = parseRequests(result.requestLog).map((request) => request.method);
      expect(methods).toContain("initialize");
      expect(methods).not.toContain("session/load");
      expect(methods).not.toContain("session/new");
      expect(fixture.issueStdioBootstrapToken).toHaveBeenCalledTimes(1);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
      const adapter = yield* GeminiAdapter;
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("reclaims the gateway lease on Gemini startup failure with no residual session", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-gateway-start-fail-ws-");
      const result = yield* runStartSession({ cwd, failNew: true });

      expect(Exit.isFailure(result.startup)).toBe(true);
      expect(parseRequests(result.requestLog).map((request) => request.method)).toContain(
        "session/new",
      );
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
      const adapter = yield* GeminiAdapter;
      expect(yield* adapter.hasSession(result.threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("revokes the idle Gemini session lease exactly once on explicit stop", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-gateway-idle-stop-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);
      expect(fixture.revokedTokens).toEqual([]);

      const adapter = yield* GeminiAdapter;
      expect(yield* adapter.hasSession(result.threadId)).toBe(true);
      yield* adapter.stopSession(result.threadId);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
      expect(yield* adapter.hasSession(result.threadId)).toBe(false);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("settles a real Gemini turn before publishing the terminal event", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-turn-complete-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      const startupEvents = Array.from(
        yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4)),
      );
      expect(startupEvents.map((event) => event.type)).toEqual([
        "session.started",
        "session.configured",
        "session.state.changed",
        "thread.started",
      ]);

      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) => Effect.sync(() => fixture.lifecycle.push(`event:${event.type}`))),
        // No assistant/update frames are emitted by the deterministic mock:
        // running state, turn.started, and turn.completed are the exact
        // terminal prefix we need to observe the gateway ordering.
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turn = yield* adapter.sendTurn({
        threadId: result.threadId,
        input: "complete this deterministic Gemini turn",
        attachments: [],
      });
      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("5 seconds")));
      const completed = events.find((event) => event.type === "turn.completed");

      expect(completed?.turnId).toBe(turn.turnId);
      expect(completed?.payload.state).toBe("completed");
      expect(fixture.cancelledTurns).toEqual([
        { token: "gemini-gateway-token", turnId: turn.turnId },
      ]);
      expect(fixture.retiredTurns).toEqual([
        { token: "gemini-gateway-token", turnId: turn.turnId },
      ]);
      expect(fixture.revokedTokens).toEqual([]);

      const cancelIndex = fixture.lifecycle.indexOf(`gateway.cancel:${turn.turnId}`);
      const retireIndex = fixture.lifecycle.indexOf(`gateway.retire:${turn.turnId}`);
      const completedIndex = fixture.lifecycle.indexOf("event:turn.completed");
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(retireIndex).toBeGreaterThan(cancelIndex);
      expect(completedIndex).toBeGreaterThan(retireIndex);

      const active = (yield* adapter.listSessions()).find(
        (session) => session.threadId === result.threadId,
      );
      expect(active?.threadId).toBe(result.threadId);
      expect(yield* adapter.hasSession(result.threadId)).toBe(true);

      yield* adapter.stopSession(result.threadId);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("interrupts an active real Gemini turn and releases its authority once", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-turn-interrupt-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true, promptHang: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4));
      const eventsFiber = yield* adapter.streamEvents.pipe(
        Stream.tap((event) => Effect.sync(() => fixture.lifecycle.push(`event:${event.type}`))),
        Stream.take(3),
        Stream.runCollect,
        Effect.forkChild,
      );
      const turn = yield* adapter.sendTurn({
        threadId: result.threadId,
        input: "hold this deterministic Gemini turn",
        attachments: [],
      });
      const running = (yield* adapter.listSessions()).find(
        (session) => session.threadId === result.threadId,
      );
      expect(running?.status).toBe("running");
      expect(running?.activeTurnId).toBe(turn.turnId);

      yield* adapter.interruptTurn(result.threadId, turn.turnId);
      const requestLog = yield* Effect.promise(() =>
        waitForRequestMethod(result.requestLogPath, "session/cancel"),
      );
      const cancelRequest = findRequest(parseRequests(requestLog), "session/cancel");
      expect(cancelRequest?.params).toEqual({ sessionId: "gemini-mock-session-1" });

      const events = Array.from(yield* Fiber.join(eventsFiber).pipe(Effect.timeout("5 seconds")));
      const completed = events.find((event) => event.type === "turn.completed");
      expect(completed?.turnId).toBe(turn.turnId);
      expect(completed?.payload.state).toBe("cancelled");
      expect(fixture.cancelledTurns).toEqual([
        { token: "gemini-gateway-token", turnId: turn.turnId },
      ]);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
      expect(new Set(fixture.revokedTokens).size).toBe(1);
      expect(fixture.retiredTurns).toEqual([]);

      const cancelIndex = fixture.lifecycle.indexOf(`gateway.cancel:${turn.turnId}`);
      const revokeIndex = fixture.lifecycle.indexOf("gateway.revoke:gemini-gateway-token");
      const completedIndex = fixture.lifecycle.indexOf("event:turn.completed");
      expect(cancelIndex).toBeGreaterThanOrEqual(0);
      expect(revokeIndex).toBeGreaterThan(cancelIndex);
      expect(completedIndex).toBeGreaterThan(revokeIndex);

      const active = (yield* adapter.listSessions()).find(
        (session) => session.threadId === result.threadId,
      );
      expect(active?.threadId).toBe(result.threadId);
      expect(yield* adapter.hasSession(result.threadId)).toBe(true);
      yield* adapter.stopSession(result.threadId);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("reclaims a Gemini lease when the provider exits during an active turn", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-turn-exit-ws-");
      const result = yield* runStartSession({
        cwd,
        keepSession: true,
        exitDuringPrompt: true,
      });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4));
      const turn = yield* adapter.sendTurn({
        threadId: result.threadId,
        input: "exit while this deterministic Gemini turn is active",
        attachments: [],
      });
      const requestLog = yield* Effect.promise(() =>
        waitForRequestMethod(result.requestLogPath, "session/prompt"),
      );
      expect(findRequest(parseRequests(requestLog), "session/prompt")).toBeDefined();

      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const hasSession = await Effect.runPromise(adapter.hasSession(result.threadId));
          if (!hasSession) {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
      });
      expect(yield* adapter.hasSession(result.threadId)).toBe(false);
      expect(
        (yield* adapter.listSessions()).some((session) => session.threadId === result.threadId),
      ).toBe(false);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token"]);
      expect(new Set(fixture.revokedTokens).size).toBe(1);
      expect(fixture.cancelledTurns.length).toBeLessThanOrEqual(1);
      expect(fixture.retiredTurns.length).toBeLessThanOrEqual(1);
      expect(turn.turnId).toBeDefined();
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("delivers the Moss host policy once on the first Gemini gateway turn", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      makeGeminiSessionFileFixture();
      const cwd = makeTempDir("sy9-gemini-harness-policy-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4));
      const waitForReady = Effect.promise(async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = await Effect.runPromise(adapter.listSessions());
          if (
            sessions.some(
              (session) =>
                session.threadId === result.threadId &&
                session.status === "ready" &&
                session.activeTurnId === undefined,
            )
          ) {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Gemini deterministic turn did not settle");
      });
      for (const input of ["first Gemini gateway turn", "second Gemini gateway turn"]) {
        yield* adapter.sendTurn({ threadId: result.threadId, input, attachments: [] });
        yield* adapter.streamEvents.pipe(Stream.take(3), Stream.runCollect);
        yield* waitForReady;
      }

      const prompts = parseRequests(readFileSync(result.requestLogPath, "utf8"))
        .filter((request) => request.method === "session/prompt")
        .map((request) => request.params.prompt as ReadonlyArray<{ type: string; text?: string }>);
      expect(prompts).toHaveLength(2);
      const [first, second] = prompts;
      expect(first?.[0]?.type).toBe("text");
      expect(first?.[0]?.text).toContain("<moss_host_context>");
      expect(first?.[0]?.text).toContain("Use the moss_* tools for Moss threads, projects, pages");
      expect(first?.some((block) => block.text?.includes("first Gemini gateway turn"))).toBe(true);
      expect(second?.some((block) => block.text?.includes("<moss_host_context>"))).toBe(false);
      expect(second?.some((block) => block.text?.includes("second Gemini gateway turn"))).toBe(
        true,
      );

      yield* adapter.stopSession(result.threadId);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("rotates gateway ownership only after a successful Gemini rollback replacement", () => {
    const fixture = makeGatewayCredentialsFixture({ distinctSessionTokens: true });
    return Effect.gen(function* () {
      makeGeminiSessionFileFixture();
      const cwd = makeTempDir("sy9-gemini-rollback-success-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4));
      yield* adapter.sendTurn({
        threadId: result.threadId,
        input: "create one deterministic Gemini turn for rollback",
        attachments: [],
      });
      const turnEvents = Array.from(
        yield* adapter.streamEvents.pipe(Stream.take(3), Stream.runCollect),
      );
      expect(turnEvents.some((event) => event.type === "turn.completed")).toBe(true);
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = await Effect.runPromise(adapter.listSessions());
          if (
            sessions.some(
              (session) =>
                session.threadId === result.threadId &&
                session.status === "ready" &&
                session.activeTurnId === undefined,
            )
          ) {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Gemini deterministic turn did not settle before rollback");
      });

      const sessionsBeforeRollback = yield* adapter.listSessions();
      expect(sessionsBeforeRollback).toHaveLength(1);
      const rollback = yield* adapter.rollbackThread(result.threadId, 1);

      expect(rollback.turns).toHaveLength(0);
      const replacementSessions = yield* adapter.listSessions();
      expect(replacementSessions).toHaveLength(1);
      expect(replacementSessions[0]?.threadId).toBe(result.threadId);
      expect(replacementSessions[0]).not.toBe(sessionsBeforeRollback[0]);
      expect(fixture.sessionTokens).toEqual(["gemini-gateway-token-1", "gemini-gateway-token-2"]);
      expect(fixture.issuedBootstrapSessionTokens).toEqual([
        "gemini-gateway-token-1",
        "gemini-gateway-token-2",
      ]);
      expect(fixture.issuedBootstrapTokens).toEqual([
        "gemini-bootstrap-gemini-gateway-token-1-1",
        "gemini-bootstrap-gemini-gateway-token-2-2",
      ]);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-1"]);
      expect(
        fixture.revokedTokens.filter((token) => token === "gemini-gateway-token-2"),
      ).toHaveLength(0);

      yield* adapter.stopSession(result.threadId);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-1", "gemini-gateway-token-2"]);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("keeps the old Gemini lease when a rollback replacement bootstrap fails", () => {
    const fixture = makeGatewayCredentialsFixture({ distinctSessionTokens: true });
    return Effect.gen(function* () {
      makeGeminiSessionFileFixture();
      const cwd = makeTempDir("sy9-gemini-rollback-failure-ws-");
      const result = yield* runStartSession({ cwd, keepSession: true });
      expect(Exit.isSuccess(result.startup)).toBe(true);

      const adapter = yield* GeminiAdapter;
      yield* Stream.runCollect(Stream.take(adapter.streamEvents, 4));
      yield* adapter.sendTurn({
        threadId: result.threadId,
        input: "create one deterministic Gemini turn for failed rollback",
        attachments: [],
      });
      const turnEvents = Array.from(
        yield* adapter.streamEvents.pipe(Stream.take(3), Stream.runCollect),
      );
      expect(turnEvents.some((event) => event.type === "turn.completed")).toBe(true);
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          const sessions = await Effect.runPromise(adapter.listSessions());
          if (
            sessions.some(
              (session) =>
                session.threadId === result.threadId &&
                session.status === "ready" &&
                session.activeTurnId === undefined,
            )
          ) {
            return;
          }
          await new Promise<void>((resolve) => setTimeout(resolve, 10));
        }
        throw new Error("Gemini deterministic turn did not settle before rollback");
      });

      const previousFailNewEnv = process.env.T3_GEMINI_ACP_FAIL_NEW;
      process.env.T3_GEMINI_ACP_FAIL_NEW = "1";
      const rollback = yield* Effect.exit(
        adapter.rollbackThread(result.threadId, 1).pipe(
          Effect.ensuring(
            Effect.sync(() => {
              if (previousFailNewEnv === undefined) {
                delete process.env.T3_GEMINI_ACP_FAIL_NEW;
              } else {
                process.env.T3_GEMINI_ACP_FAIL_NEW = previousFailNewEnv;
              }
            }),
          ),
        ),
      );

      expect(Exit.isFailure(rollback)).toBe(true);
      expect(fixture.sessionTokens).toEqual(["gemini-gateway-token-1", "gemini-gateway-token-2"]);
      expect(fixture.issuedBootstrapSessionTokens).toEqual([
        "gemini-gateway-token-1",
        "gemini-gateway-token-2",
      ]);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-2"]);
      expect(
        fixture.revokedTokens.filter((token) => token === "gemini-gateway-token-2"),
      ).toHaveLength(1);
      expect(
        fixture.revokedTokens.filter((token) => token === "gemini-gateway-token-1"),
      ).toHaveLength(0);

      expect(yield* adapter.hasSession(result.threadId)).toBe(true);
      const survivingSessions = yield* adapter.listSessions();
      expect(survivingSessions).toHaveLength(1);
      expect(survivingSessions[0]?.threadId).toBe(result.threadId);

      yield* adapter.stopSession(result.threadId);
      expect(fixture.revokedTokens).toEqual(["gemini-gateway-token-2", "gemini-gateway-token-1"]);
      expect(yield* adapter.hasSession(result.threadId)).toBe(false);
      expect(yield* adapter.listSessions()).toEqual([]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it.effect("uses HTTP MCP in the real Gemini session/new payload when advertised", () => {
    const fixture = makeGatewayCredentialsFixture();
    return Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-gateway-http-ws-");
      const { requestLog } = yield* runStartSession({ cwd, httpMcp: true });
      const sessionNew = findRequest(parseRequests(requestLog), "session/new");
      const gatewayServer = (
        (sessionNew?.params.mcpServers as ReadonlyArray<Record<string, unknown>> | undefined) ?? []
      ).find((server) => server.name === "moss");

      expect(gatewayServer).toMatchObject({
        type: "http",
        name: "moss",
        url: "http://127.0.0.1:48123/mcp",
        headers: [{ name: "Authorization", value: "Bearer gemini-gateway-token" }],
      });
      expect(gatewayServer).not.toHaveProperty("env");
      expect(fixture.issuedBootstrapTokens).toEqual([]);
    }).pipe((effect) => provide(effect, undefined, fixture.credentials));
  });

  it("uses advertised HTTP and stdio fallback transports through the canonical ACP builder", () => {
    const connection = {
      url: "http://127.0.0.1:48123/mcp",
      bearerToken: "gemini-gateway-token",
    };
    const stdioProxy = {
      command: process.execPath,
      args: ["/tmp/moss-agent-gateway-stdio-proxy.mjs"],
    };
    expect(
      buildAcpMossMcpServers({
        connection,
        stdioProxy,
        issueStdioBootstrapToken: () => "gemini-bootstrap-test",
        initializeResult: {
          agentCapabilities: { mcpCapabilities: { http: true } },
        } satisfies AcpInitializeCapabilitiesView,
      }),
    ).toEqual([
      {
        type: "http",
        name: "moss",
        url: connection.url,
        headers: [{ name: "Authorization", value: "Bearer gemini-gateway-token" }],
      },
    ]);
    expect(
      buildAcpMossMcpServers({
        connection,
        stdioProxy,
        issueStdioBootstrapToken: () => "gemini-bootstrap-test",
        initializeResult: {
          agentCapabilities: { mcpCapabilities: { http: false } },
        } satisfies AcpInitializeCapabilitiesView,
      }),
    ).toEqual([
      {
        name: "moss",
        command: process.execPath,
        args: stdioProxy.args,
        env: [
          { name: "MOSS_AGENT_GATEWAY_URL", value: connection.url },
          {
            name: "MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
            value: "gemini-bootstrap-test",
          },
          { name: "ELECTRON_RUN_AS_NODE", value: "1" },
        ],
      },
    ]);
  });

  // A1 (forward, real path): session/new params.mcpServers == derived.servers.
  it.effect("injects Moss MCP servers into session/new via the real startSession path", () =>
    Effect.gen(function* () {
      const cwd = makeWorkspaceWithMossConfig();
      const { requestLog } = yield* runStartSession({ cwd });

      const requests = parseRequests(requestLog);
      const sessionNew = findRequest(requests, "session/new");
      expect(sessionNew, "session/new was sent on a fresh session").toBeDefined();

      const derived = yield* Effect.promise(() => deriveMossAcpMcpServers(cwd));
      expect(derived.serverNames).toEqual(["moss-probe", "remote"]);

      // A1: payload mcpServers is a non-empty array equal, item-for-item, to
      // deriveMossAcpMcpServers(cwd).servers.
      expect(sessionNew?.params.mcpServers).toEqual(derived.servers);
      expect(sessionNew?.params.mcpServers).toEqual([
        {
          name: "moss-probe",
          command: "moss-probe-bin",
          args: ["--stdio"],
          env: [{ name: "MOSS_MCP", value: "1" }],
        },
        {
          type: "http",
          name: "remote",
          url: "https://mcp.example.com",
          headers: [],
        },
      ]);
    }).pipe(provide),
  );

  // A5 (single source — no split brain): the name set inside the session/new
  // payload equals the independently recomputed deriveMossAcpMcpServers names.
  it.effect(
    "session/new mcpServer names match an independent deriveMossAcpMcpServers recompute",
    () =>
      Effect.gen(function* () {
        const cwd = makeWorkspaceWithMossConfig();
        const { requestLog } = yield* runStartSession({ cwd });

        const sessionNew = findRequest(parseRequests(requestLog), "session/new");
        const payloadNames = (
          (sessionNew?.params.mcpServers as ReadonlyArray<{ name?: string }>) ?? []
        ).map((server) => server.name);

        const recomputed = yield* Effect.promise(() => deriveMossAcpMcpServers(cwd));
        expect(payloadNames).toEqual(recomputed.serverNames);
      }).pipe(provide),
  );

  // A4 (governance <-> runtime): adding a new server to the same config makes it
  // appear in the session/new payload (the gemini adapter-inject governance row
  // is honored at runtime).
  it.effect("a newly added Moss MCP server surfaces in the session/new payload", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-ws-");
      mkdirSync(path.join(cwd, ".moss", "mcp"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".moss", "mcp", "config.json"),
        `${JSON.stringify({
          mcpServers: {
            ...MOSS_MCP_CONFIG.mcpServers,
            "new-server": { command: "brand-new-bin", args: [] },
          },
        })}\n`,
        "utf8",
      );

      const { requestLog } = yield* runStartSession({ cwd });
      const sessionNew = findRequest(parseRequests(requestLog), "session/new");
      const names = ((sessionNew?.params.mcpServers as ReadonlyArray<{ name?: string }>) ?? []).map(
        (server) => server.name,
      );
      expect(names).toContain("new-server");
    }).pipe(provide),
  );

  // A2 (resume/load path parity): resuming sends session/load with the same
  // non-empty mcpServers array as session/new would.
  it.effect("injects Moss MCP servers into session/load on the resume path", () =>
    Effect.gen(function* () {
      const cwd = makeWorkspaceWithMossConfig();
      const { requestLog } = yield* runStartSession({
        cwd,
        resumeSessionId: "gemini-mock-session-1",
      });

      const requests = parseRequests(requestLog);
      const sessionLoad = findRequest(requests, "session/load");
      expect(sessionLoad, "session/load was sent on the resume path").toBeDefined();

      const derived = yield* Effect.promise(() => deriveMossAcpMcpServers(cwd));
      expect(sessionLoad?.params.mcpServers).toEqual(derived.servers);
      // No fresh session/new when session/load succeeds.
      expect(findRequest(requests, "session/new")).toBeUndefined();
    }).pipe(provide),
  );

  it.effect("reads back an approved plugin MCP on fresh, load, and load-fallback paths", () => {
    const approval = createMossPluginApprovalStore();
    return Effect.gen(function* () {
      const cwd = makeWorkspaceWithApprovedPluginFixture();
      const plugin = (yield* Effect.promise(() => discoverMossPluginRuntime({ cwd }))).plugins[0]!;
      yield* Effect.promise(() =>
        approval.issuer.approve({
          cwd,
          plugin,
          componentIds: plugin.components.map((component) => component.id),
        }),
      );

      const expectedPluginServer = {
        name: "gemini-plugin",
        command: "gemini-plugin-mcp",
        args: ["--stdio"],
        env: [],
      };
      const fresh = parseRequests((yield* runStartSession({ cwd })).requestLog);
      expect(findRequest(fresh, "session/new")?.params.mcpServers).toContainEqual(
        expectedPluginServer,
      );

      const loaded = parseRequests(
        (yield* runStartSession({ cwd, resumeSessionId: "gemini-mock-session-1" })).requestLog,
      );
      expect(findRequest(loaded, "session/load")?.params.mcpServers).toContainEqual(
        expectedPluginServer,
      );
      expect(findRequest(loaded, "session/new")).toBeUndefined();

      const fallback = parseRequests(
        (yield* runStartSession({
          cwd,
          failLoad: true,
          resumeSessionId: "gemini-mock-session-1",
        })).requestLog,
      );
      expect(findRequest(fallback, "session/load")?.params.mcpServers).toContainEqual(
        expectedPluginServer,
      );
      expect(findRequest(fallback, "session/new")?.params.mcpServers).toContainEqual(
        expectedPluginServer,
      );
    }).pipe((effect) => provide(effect, approval.store));
  });

  // A3 (reverse / degrade): no .moss/mcp/config.json -> session/new mcpServers
  // stays [] (unconfigured project sees zero behavior change).
  it.effect("keeps session/new mcpServers empty when no Moss MCP config exists", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-ws-empty-");
      const { requestLog } = yield* runStartSession({ cwd });

      const sessionNew = findRequest(parseRequests(requestLog), "session/new");
      expect(sessionNew?.params.mcpServers).toEqual([]);
    }).pipe(provide),
  );

  // A3 (reverse / degrade — malformed): malformed config JSON does not throw,
  // the session still bootstraps, and session/new mcpServers stays [].
  it.effect("degrades to empty mcpServers (not a throw) on malformed Moss MCP config", () =>
    Effect.gen(function* () {
      const cwd = makeTempDir("sy9-gemini-ws-malformed-");
      mkdirSync(path.join(cwd, ".moss", "mcp"), { recursive: true });
      writeFileSync(
        path.join(cwd, ".moss", "mcp", "config.json"),
        "{ this is not valid json",
        "utf8",
      );

      // startSession must not throw despite the malformed config.
      const { requestLog, startup } = yield* runStartSession({ cwd });
      expect(
        Exit.isSuccess(startup),
        Exit.isFailure(startup)
          ? JSON.stringify({
              failure: Cause.pretty(startup.cause),
              mockMethods: parseRequests(requestLog).map((request) => request.method),
            })
          : "Malformed config startup succeeded",
      ).toBe(true);
      const sessionNew = findRequest(parseRequests(requestLog), "session/new");
      expect(sessionNew, "session still bootstrapped past session/new").toBeDefined();
      expect(sessionNew?.params.mcpServers).toEqual([]);

      // deriveMossAcpMcpServers surfaces exactly one degrade warning (which
      // GeminiAdapter logs with the 'moss.acp.mcp:' prefix), never throwing.
      const derived = yield* Effect.promise(() => deriveMossAcpMcpServers(cwd));
      expect(derived.servers).toEqual([]);
      expect(derived.warnings.length).toBe(1);
    }).pipe(provide),
  );
});
