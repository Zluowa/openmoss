import http from "node:http";
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import * as NodeServices from "@effect/platform-node/NodeServices";
import { ProjectId, ThreadId, TurnId, type OrchestrationThreadShell } from "@synara/contracts";
import { Effect, Exit, Layer, Option, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { describe, expect, it } from "vitest";

import { listAgentGatewayMcpTools } from "../agentGateway/mcpInjection.ts";
import { makeAgentGatewayInFlightRequestRegistry } from "../agentGateway/inFlightRequestRegistry.ts";
import { agentGatewayRouteLayer } from "../agentGateway/httpRoute.ts";
import { makeAgentGatewayMcpTransport } from "../agentGateway/mcpTransport.ts";
import type { AgentGatewayMcpBoundaryEvent } from "../agentGateway/mcpObservability.ts";
import { makeAgentGatewaySessionRegistry } from "../agentGateway/Layers/AgentGatewaySessionRegistry.ts";
import { AgentGateway } from "../agentGateway/Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { AgentGatewayCredentials } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MOSS_BUNDLED_CODEX_VERSION, resolveCodexRuntimeTarget } from "@synara/shared/codexRuntime";
import { acquireAgentGatewaySessionLease } from "../agentGateway/sessionLease.ts";
import type { AgentGatewayProviderInstances } from "../agentGateway/targetResolver.ts";
import type { ToolEntry } from "../agentGateway/toolRuntime.ts";
import { buildCodexMcpConfigToml } from "../agentGateway/mcpInjection.ts";

const NOW = "2026-08-27T00:00:00.000Z";
const LIVE = process.env.MOSS_AGENT_GATEWAY_LIVE === "1";

function makeThread(threadId: string): OrchestrationThreadShell {
  return {
    id: ThreadId.makeUnsafe(threadId),
    projectId: ProjectId.makeUnsafe("project-native-mcp-integration"),
    title: threadId,
    modelSelection: { provider: "codex", instanceId: "codex", model: "gpt-5.6-sol" },
    runtimeMode: "full-access",
    interactionMode: "default",
    envMode: "local",
    branch: null,
    worktreePath: null,
    workingDirectory: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    creationSource: null,
    sourceThreadId: null,
    sourceTurnId: null,
    gatewayOperationId: null,
    gatewayOperationIndex: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: TurnId.makeUnsafe(`turn-${threadId}`),
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: null,
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    settledAt: null,
    handoff: null,
    session: null,
  };
}

function resolveInstalledCodexRuntime(repoRoot: string): string {
  const target = resolveCodexRuntimeTarget({ platform: process.platform, arch: process.arch });
  if (!target) {
    throw new Error(
      `The test host ${process.platform}/${process.arch} has no pinned Codex target.`,
    );
  }
  const codexPackageRoot = Path.dirname(
    FS.realpathSync(Path.join(repoRoot, "apps/desktop/node_modules/@openai/codex/package.json")),
  );
  const packageLeaf = target.packageName.slice("@openai/".length);
  const runtimeRoots = [
    Path.join(Path.dirname(codexPackageRoot), packageLeaf),
    Path.join(codexPackageRoot, "node_modules", "@openai", packageLeaf),
  ];
  const runtimeRoot = runtimeRoots.find((candidate) =>
    FS.existsSync(Path.join(candidate, "vendor", target.targetTriple, "codex-package.json")),
  );
  if (!runtimeRoot) {
    throw new Error(`Pinned Codex ${MOSS_BUNDLED_CODEX_VERSION} runtime is not installed.`);
  }
  const manifestPath = Path.join(runtimeRoot, "vendor", target.targetTriple, "codex-package.json");
  const manifest = JSON.parse(FS.readFileSync(manifestPath, "utf8")) as {
    readonly version?: string;
  };
  if (manifest.version !== MOSS_BUNDLED_CODEX_VERSION) {
    throw new Error("The installed Codex runtime manifest does not match Moss's pinned version.");
  }
  return Path.join(runtimeRoot, "vendor", target.targetTriple, "bin", target.executableName);
}

function isolatedEnvironment(root: string, token: string): NodeJS.ProcessEnv {
  const home = Path.join(root, "home");
  const codexHome = Path.join(home, ".codex");
  FS.mkdirSync(codexHome, { recursive: true });
  return {
    ...process.env,
    CODEX_HOME: codexHome,
    HOME: home,
    PATH: "/usr/bin:/bin:/usr/sbin:/sbin",
    USERPROFILE: home,
    MOSS_AGENT_GATEWAY_TOKEN: token,
  };
}

interface JsonlMessage {
  readonly id?: unknown;
  readonly method?: unknown;
  readonly result?: unknown;
  readonly error?: unknown;
}

class JsonlClient {
  readonly child: ChildProcessWithoutNullStreams;
  readonly messages: JsonlMessage[] = [];
  #buffer = "";
  #waiters: Array<{
    readonly predicate: (message: JsonlMessage) => boolean;
    readonly resolve: (message: JsonlMessage) => void;
    readonly reject: (error: Error) => void;
    readonly timer: ReturnType<typeof setTimeout>;
  }> = [];

  constructor(binaryPath: string, cwd: string, env: NodeJS.ProcessEnv) {
    this.child = spawn(binaryPath, ["app-server"], {
      cwd,
      env,
      stdio: ["pipe", "pipe", "pipe"],
      windowsHide: true,
    });
    this.child.stdout.setEncoding("utf8");
    this.child.stdout.on("data", (chunk: string) => {
      this.#buffer += chunk;
      while (true) {
        const newline = this.#buffer.indexOf("\n");
        if (newline < 0) return;
        const line = this.#buffer.slice(0, newline).trim();
        this.#buffer = this.#buffer.slice(newline + 1);
        if (!line) continue;
        let message: JsonlMessage;
        try {
          message = JSON.parse(line) as JsonlMessage;
        } catch {
          continue;
        }
        this.messages.push(message);
        for (const waiter of [...this.#waiters]) {
          if (!waiter.predicate(message)) continue;
          this.#waiters = this.#waiters.filter((candidate) => candidate !== waiter);
          clearTimeout(waiter.timer);
          waiter.resolve(message);
        }
      }
    });
    const stopped = () => {
      for (const waiter of this.#waiters.splice(0)) {
        clearTimeout(waiter.timer);
        waiter.reject(new Error("Codex app-server stopped before the expected response."));
      }
    };
    this.child.once("error", stopped);
    this.child.once("exit", stopped);
  }

  send(message: Record<string, unknown>): void {
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  waitFor(predicate: (message: JsonlMessage) => boolean, timeoutMs: number): Promise<JsonlMessage> {
    const existing = this.messages.find(predicate);
    if (existing) return Promise.resolve(existing);
    return new Promise<JsonlMessage>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.#waiters = this.#waiters.filter((waiter) => waiter.resolve !== resolve);
        reject(new Error("Timed out waiting for the expected Codex app-server response."));
      }, timeoutMs);
      this.#waiters.push({ predicate, resolve, reject, timer });
    });
  }

  async stop(): Promise<void> {
    if (this.child.exitCode !== null || this.child.signalCode !== null) return;
    await new Promise<void>((resolve) => {
      const forceKill = setTimeout(() => {
        this.child.kill("SIGKILL");
      }, 2_000);
      this.child.once("exit", () => {
        clearTimeout(forceKill);
        resolve();
      });
      this.child.kill("SIGTERM");
    });
  }
}

async function waitForCondition(predicate: () => boolean, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      throw new Error("Timed out waiting for the native MCP readiness condition.");
    }
    await new Promise<void>((resolve) => setTimeout(resolve, 20));
  }
}

async function withGatewayServer(
  run: (input: {
    readonly port: number;
    readonly credentials: AgentGatewayCredentialsShape;
    readonly events: AgentGatewayMcpBoundaryEvent[];
    readonly projectionCallCount: () => number;
    readonly setProjectionBlocked: (blocked: boolean) => void;
    readonly setProjectedThread: (thread: OrchestrationThreadShell) => void;
  }) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  try {
    const threadId = ThreadId.makeUnsafe("thread-native-mcp-live");
    const sessionRegistry = makeAgentGatewaySessionRegistry();
    const inFlightRequests = makeAgentGatewayInFlightRequestRegistry();
    let port = 0;
    const credentials: AgentGatewayCredentialsShape = {
      mcpEndpointUrl: "http://127.0.0.1:0/mcp",
      setListeningPort: (listeningPort) => {
        port = listeningPort;
      },
      issueSessionToken: (issuedThreadId, provider) =>
        sessionRegistry.issue(issuedThreadId, provider).token,
      verifySessionToken: (token) => sessionRegistry.verify(token)?.threadId ?? null,
      verifySession: sessionRegistry.verify,
      issueStdioBootstrapToken: () => null,
      exchangeStdioBootstrapToken: () => null,
      bindWriteAuthority: sessionRegistry.bindWriteAuthority,
      verifyWriteAuthority: sessionRegistry.verifyWriteAuthority,
      registerInFlightRequest: inFlightRequests.register,
      cancelInFlightRequests: inFlightRequests.cancel,
      cancelSessionTurnRequests: (token, turnId) => {
        const session = sessionRegistry.verify(token);
        return session
          ? inFlightRequests.cancelTurn(session.sessionKey, turnId).settled
          : Promise.resolve();
      },
      retireSessionTurn: (token, turnId) => {
        const session = sessionRegistry.verify(token);
        if (!session) return Promise.resolve();
        sessionRegistry.retireWriteAuthority(token, turnId);
        return inFlightRequests.cancelTurn(session.sessionKey, turnId).settled;
      },
      revokeSessionToken: (token) => {
        const session = sessionRegistry.verify(token);
        sessionRegistry.revoke(token);
        if (session) inFlightRequests.revokeSession(session.sessionKey);
      },
      noteNativeMcpStartup: () => undefined,
      awaitNativeMcpStartup: () => Promise.resolve("inactive" as const),
      connectionForThread: (issuedThreadId, provider) => ({
        url: `http://127.0.0.1:${port}/mcp`,
        bearerToken: sessionRegistry.issue(issuedThreadId, provider).token,
      }),
      stdioProxy: { command: process.execPath, args: [] },
    };
    let projectedThread = makeThread(String(threadId));
    let projectionBlocked = false;
    let projectionCalls = 0;
    const snapshotQuery = {
      getThreadShellById: () => {
        projectionCalls += 1;
        return projectionBlocked ? Effect.never : Effect.succeed(Option.some(projectedThread));
      },
    } as unknown as ProjectionSnapshotQueryShape;
    const providerInstances: AgentGatewayProviderInstances = new Map([
      [
        "codex",
        {
          instanceId: "codex",
          provider: "codex",
          enabled: true,
          available: true,
          authStatus: "authenticated",
        },
      ],
    ]);
    const events: AgentGatewayMcpBoundaryEvent[] = [];
    const probeTool: ToolEntry = {
      definition: {
        name: "moss_probe",
        description: "Deterministic read-only live integration probe.",
        inputSchema: { type: "object", properties: {} },
      },
      requiredCapability: "thread:read",
      handler: () => Effect.succeed({ content: [{ type: "text", text: "ok" }] }),
    };
    const transport = makeAgentGatewayMcpTransport({
      credentials,
      snapshotQuery,
      tools: [probeTool],
      instructions: "live integration test",
      observeBoundary: (event) => events.push(event),
      requireThreadShell: () => Effect.succeed(projectedThread),
      loadProviderInstances: Effect.succeed(providerInstances),
    });
    const gatewayLayer = Layer.mergeAll(
      Layer.succeed(AgentGateway, { handleMcpPost: transport }),
      Layer.succeed(AgentGatewayCredentials, credentials),
      NodeServices.layer,
    );
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          const httpApp = yield* HttpRouter.toHttpEffect(agentGatewayRouteLayer);
          yield* httpServer.serve(httpApp);
        }).pipe(Effect.provide(gatewayLayer)),
        scope,
      ),
    );
    const listeningServer = nodeServer as http.Server | null;
    const address = listeningServer?.address();
    if (!address || typeof address !== "object") {
      throw new Error("Expected the live MCP route to expose a loopback port.");
    }
    credentials.setListeningPort(address.port);
    await run({
      port: address.port,
      credentials,
      events,
      projectionCallCount: () => projectionCalls,
      setProjectionBlocked: (blocked) => {
        projectionBlocked = blocked;
      },
      setProjectedThread: (thread) => {
        projectedThread = thread;
      },
    });
    expect(projectionCalls).toBeGreaterThan(0);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("installed Codex native MCP startup", () => {
  it.skipIf(!LIVE)(
    "accepts the real 0.150 initialize/initialized/tools-list sequence after dynamic prefetch",
    async () => {
      const repoRoot = Path.resolve(import.meta.dirname, "../../../..");
      const scratch = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-native-mcp-live-"));
      let client: JsonlClient | undefined;
      try {
        await withGatewayServer(
          async ({
            port,
            credentials,
            events,
            projectionCallCount,
            setProjectionBlocked,
            setProjectedThread,
          }) => {
            const lease = acquireAgentGatewaySessionLease(
              credentials,
              ThreadId.makeUnsafe("thread-native-mcp-live"),
              "codex",
              {},
            );
            if (!lease) throw new Error("Expected a live gateway session lease.");
            try {
              const catalog = await listAgentGatewayMcpTools({ connection: lease.connection });
              expect(catalog.map((tool) => tool.name)).toEqual(["moss_probe"]);
              const prefetchEventCount = events.length;
              const runtimeRoot = Path.join(scratch, "runtime");
              FS.mkdirSync(runtimeRoot, { recursive: true });
              const env = isolatedEnvironment(runtimeRoot, lease.connection.bearerToken);
              FS.writeFileSync(
                Path.join(env.CODEX_HOME!, "config.toml"),
                buildCodexMcpConfigToml(`http://127.0.0.1:${port}/mcp`),
                "utf8",
              );
              setProjectionBlocked(true);
              client = new JsonlClient(resolveInstalledCodexRuntime(repoRoot), runtimeRoot, env);
              client.send({
                id: 1,
                method: "initialize",
                params: {
                  clientInfo: { name: "moss-native-mcp-live", title: "Moss live", version: "1" },
                  capabilities: { experimentalApi: true },
                },
              });
              const initialize = await client.waitFor((message) => message.id === 1, 10_000);
              expect(initialize.error).toBeUndefined();
              client.send({ method: "initialized", params: {} });
              client.send({
                id: 2,
                method: "thread/start",
                params: {
                  model: null,
                  cwd: runtimeRoot,
                  approvalPolicy: "never",
                  approvalsReviewer: "user",
                  sandbox: "danger-full-access",
                  experimentalRawEvents: false,
                },
              });
              const threadStart = await client.waitFor((message) => message.id === 2, 20_000);
              expect(threadStart.error).toBeUndefined();
              await waitForCondition(() => {
                const nativeEvents = events
                  .slice(prefetchEventCount)
                  .filter((event) => event.phase === "response");
                const acceptedMethods = new Set(
                  nativeEvents
                    .filter((event) => event.outcome === "accepted")
                    .map((event) => event.methodClass),
                );
                return (
                  acceptedMethods.has("initialize") &&
                  acceptedMethods.has("initialized-notification") &&
                  acceptedMethods.has("tools-list")
                );
              }, 12_000);
              // Let the app-server finish any second native MCP connection it
              // opens while thread/start settles; this keeps the assertion
              // about the complete startup window rather than the first three
              // requests only.
              await new Promise<void>((resolve) => setTimeout(resolve, 500));
              const nativeBoundaryEvents = events.slice(prefetchEventCount);
              const nativeEvents = nativeBoundaryEvents.filter(
                (event) => event.phase === "response",
              );
              expect(nativeEvents).toEqual(
                expect.arrayContaining([
                  expect.objectContaining({
                    methodClass: "initialize",
                    httpStatus: 200,
                    outcome: "accepted",
                  }),
                  expect.objectContaining({
                    methodClass: "initialized-notification",
                    httpStatus: 202,
                    outcome: "accepted",
                  }),
                  expect.objectContaining({
                    methodClass: "tools-list",
                    httpStatus: 200,
                    outcome: "accepted",
                  }),
                ]),
              );
              expect(nativeEvents.every((event) => event.outcome === "accepted")).toBe(true);
              // One projection read belongs to the manager's dynamic-tools
              // prefetch; native startup must use its bounded read-only proof.
              expect(
                nativeBoundaryEvents.some(
                  (event) => event.phase === "request" && event.stage === "projection",
                ),
              ).toBe(false);
              expect(projectionCallCount()).toBe(1);

              // Revoke the original lease, then prove a fresh provider session
              // cannot cross a changed projection/provider ownership boundary.
              lease.release();
              const revokedResponse = await fetch(lease.connection.url, {
                method: "POST",
                headers: {
                  Authorization: `Bearer ${lease.connection.bearerToken}`,
                  "Content-Type": "application/json",
                },
                body: JSON.stringify({ jsonrpc: "2.0", id: "revoked", method: "initialize" }),
              });
              expect(revokedResponse.status).toBe(401);

              setProjectionBlocked(false);
              const mismatchThread = {
                ...makeThread("thread-native-mcp-live"),
                session: {
                  threadId: ThreadId.makeUnsafe("thread-native-mcp-live"),
                  status: "running" as const,
                  providerName: "claudeAgent",
                  runtimeMode: "full-access" as const,
                  activeTurnId: TurnId.makeUnsafe("turn-thread-native-mcp-live"),
                  lastError: null,
                  updatedAt: NOW,
                },
              };
              setProjectedThread(mismatchThread);
              const mismatchLease = acquireAgentGatewaySessionLease(
                credentials,
                ThreadId.makeUnsafe("thread-native-mcp-live"),
                "codex",
                {},
              );
              if (!mismatchLease) throw new Error("Expected a mismatch-session lease.");
              try {
                const mismatchResponse = await fetch(mismatchLease.connection.url, {
                  method: "POST",
                  headers: {
                    Authorization: `Bearer ${mismatchLease.connection.bearerToken}`,
                    "Content-Type": "application/json",
                  },
                  body: JSON.stringify({ jsonrpc: "2.0", id: "mismatch", method: "tools/list" }),
                });
                expect(mismatchResponse.status).toBe(401);
                expect(events.at(-1)?.reasonCode).toBe("provider-ownership-mismatch");
              } finally {
                mismatchLease.release();
              }
            } finally {
              lease.release();
              if (client) await client.stop();
            }
          },
        );
      } finally {
        if (client) await client.stop();
        FS.rmSync(scratch, { recursive: true, force: true });
      }
    },
    75_000,
  );
});
