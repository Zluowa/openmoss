import { spawn, type ChildProcessByStdio } from "node:child_process";
import { createRequire } from "node:module";
import { createServer } from "node:net";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { mkdirSync, writeFileSync } from "node:fs";
import type { Readable } from "node:stream";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const DEFAULT_PORT_START = 56_900;
const THREAD_ID = "thread-moss-served-smoke";
const SECONDARY_THREAD_ID = "thread-moss-served-smoke-secondary";
const PROJECT_ID = "project-moss-served-smoke";
const NOW_ISO = "2026-07-02T00:08:00.000Z";
const DEFAULT_TIMEOUT_MS = 90_000;
const LOG_TAIL_LIMIT = 80;

function buildServedProductRoute(baseUrl: string): string {
  // This smoke injects nativeApi to exercise the local-app shell path; that makes
  // the Web app choose Electron-style hash history even though Vite serves it.
  return `${baseUrl}/#/${THREAD_ID}?mossShell=1`;
}

function normalizeMossShellRouteHref(href: string): string {
  return href.replace(/([?&]mossShell=)(?:"|%22)?1(?:"|%22)?/g, (_match, prefix: string) => {
    return `${prefix}1`;
  });
}

interface CliOptions {
  readonly createdAt: string;
  readonly port?: number;
  readonly reportPath?: string;
  readonly screenshotPath?: string;
  readonly dumpInitScriptPath?: string;
  readonly timeoutMs: number;
}

interface SmokeReport {
  readonly createdAt: string;
  readonly route: string;
  readonly baseUrl: string;
  readonly assertions: ReadonlyArray<string>;
  readonly interactionContinuity?: MossShellInteractionContinuity | undefined;
  readonly screenshotPath?: string;
  readonly viteLogTail: ReadonlyArray<string>;
  readonly browserLogTail: ReadonlyArray<string>;
}

interface MossShellInteractionContinuity {
  readonly routeBeforeSwitches: string;
  readonly routeAfterSwitches: string;
  readonly composerThreadIdAfterSwitches: string | null;
  readonly visitedSurfaces: ReadonlyArray<"events" | "sessions" | "launch-plan" | "ledger">;
  readonly selectedSessionThreadId: string;
  readonly selectedSessionEventCount: number;
  readonly permissionActionStatus: string | null;
  readonly launchPlanHashVisible: string;
}

function parseArgs(argv: ReadonlyArray<string>): CliOptions {
  const options: {
    createdAt: string;
    port?: number;
    reportPath?: string;
    screenshotPath?: string;
    dumpInitScriptPath?: string;
    timeoutMs: number;
  } = {
    createdAt: NOW_ISO,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--created-at" && next) {
      options.createdAt = next;
      index += 1;
      continue;
    }
    if (arg === "--port" && next) {
      options.port = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--report" && next) {
      options.reportPath = next;
      index += 1;
      continue;
    }
    if (arg === "--screenshot" && next) {
      options.screenshotPath = next;
      index += 1;
      continue;
    }
    if (arg === "--dump-init-script" && next) {
      options.dumpInitScriptPath = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
  }

  if (options.port !== undefined && (!Number.isInteger(options.port) || options.port <= 0)) {
    throw new Error(`Invalid --port: ${String(options.port)}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
  }

  return options;
}

async function isPortAvailable(port: number): Promise<boolean> {
  return await new Promise((resolveAvailable) => {
    const server = createServer();
    server.once("error", () => {
      resolveAvailable(false);
    });
    server.once("listening", () => {
      server.close(() => resolveAvailable(true));
    });
    server.listen(port, "127.0.0.1");
  });
}

async function resolvePort(preferredPort: number | undefined): Promise<number> {
  if (preferredPort !== undefined) {
    if (!(await isPortAvailable(preferredPort))) {
      throw new Error(`Port ${preferredPort} is not available.`);
    }
    return preferredPort;
  }

  for (let port = DEFAULT_PORT_START; port < DEFAULT_PORT_START + 50; port += 1) {
    if (await isPortAvailable(port)) {
      return port;
    }
  }
  throw new Error(`No available port found from ${DEFAULT_PORT_START}.`);
}

function appendBounded(lines: string[], chunk: Buffer | string, prefix: string): void {
  const text = String(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(`${prefix}${line}`);
  }
  if (lines.length > LOG_TAIL_LIMIT) {
    lines.splice(0, lines.length - LOG_TAIL_LIMIT);
  }
}

export interface BrowserDiagnostics {
  readonly failureTail: string[];
  readonly logTail: string[];
}

export function recordBrowserConsole(
  diagnostics: BrowserDiagnostics,
  type: string,
  text: string,
): void {
  const line = `[${type}] ${text}`;
  appendBounded(diagnostics.logTail, line, "");
  if (type === "error") {
    appendBounded(diagnostics.failureTail, line, "");
  }
}

export function recordBrowserFailure(
  diagnostics: BrowserDiagnostics,
  kind: "pageerror" | "requestfailed",
  detail: string,
): void {
  const prefix = `[${kind}] `;
  appendBounded(diagnostics.logTail, detail, prefix);
  appendBounded(diagnostics.failureTail, detail, prefix);
}

async function waitForHttp(url: string, timeoutMs: number): Promise<void> {
  const startedAt = Date.now();
  let lastError: unknown;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(url, { redirect: "manual" });
      if (response.status >= 200 && response.status < 500) {
        return;
      }
      lastError = new Error(`HTTP ${response.status}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 250));
  }
  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  throw new Error(`Timed out waiting for ${url}: ${detail}`);
}

type ViteProcess = ChildProcessByStdio<null, Readable, Readable>;

function startVite(port: number, logs: string[]): ViteProcess {
  const wsPort = port + 1;
  const child = spawn(
    "bun",
    [
      "scripts/dev-runner.ts",
      "dev",
      "--host",
      "127.0.0.1",
      "--dev-url",
      `http://127.0.0.1:${port}`,
    ],
    {
      cwd: REPO_ROOT,
      env: {
        ...process.env,
        PATH: `${join(REPO_ROOT, "node_modules/.bin")}:${process.env.PATH ?? ""}`,
        PORT: String(port),
        VITE_DEV_SERVER_URL: `http://127.0.0.1:${port}`,
        VITE_WS_URL: `ws://127.0.0.1:${wsPort}`,
      },
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  child.stdout.on("data", (chunk) => appendBounded(logs, chunk, "[vite] "));
  child.stderr.on("data", (chunk) => appendBounded(logs, chunk, "[vite:err] "));
  return child;
}

async function stopProcess(child: ViteProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }

  await new Promise<void>((resolveStop) => {
    const done = () => resolveStop();
    child.once("exit", done);
    try {
      if (process.platform !== "win32" && child.pid) {
        process.kill(-child.pid, "SIGTERM");
      } else {
        child.kill("SIGTERM");
      }
    } catch {
      child.kill("SIGTERM");
    }
    setTimeout(() => {
      if (child.exitCode === null && child.signalCode === null) {
        try {
          if (process.platform !== "win32" && child.pid) {
            process.kill(-child.pid, "SIGKILL");
          } else {
            child.kill("SIGKILL");
          }
        } catch {
          child.kill("SIGKILL");
        }
      }
      resolveStop();
    }, 2_000).unref();
  });
}

function resolvePlaywrightModuleUrl(): string {
  const requireFromHere = createRequire(import.meta.url);
  const resolvedPath = requireFromHere.resolve("playwright", { paths: [WEB_ROOT] });
  return pathToFileURL(resolvedPath).href;
}

function buildInitScript(createdAt: string): string {
  return `
(() => {
  const THREAD_ID = ${JSON.stringify(THREAD_ID)};
  const SECONDARY_THREAD_ID = ${JSON.stringify(SECONDARY_THREAD_ID)};
  const PROJECT_ID = ${JSON.stringify(PROJECT_ID)};
  const SESSION_ID = "runtime-session-moss-served-smoke";
  const SECONDARY_SESSION_ID = "runtime-session-moss-served-smoke-secondary";
  const TURN_ID = "turn-moss-served-smoke";
  const SECONDARY_TURN_ID = "turn-moss-served-smoke-secondary";
  const NOW = ${JSON.stringify(createdAt)};
  const featureFlags = {
    "moss-product-shell-default": false,
    "persist-action-failed-debug-toasts": false,
    "pin-git-progress-toast-preview": false,
    "show-moss-control-plane": false,
    "show-debug-task-banner": false,
    "show-expanded-cursor-model-variants": false
  };
  window.localStorage.setItem("moss:feature-flags", JSON.stringify(featureFlags));
  window.localStorage.setItem(
    "moss:split-view-state:v1",
    JSON.stringify({
      state: { splitViewsById: {}, splitViewIdBySourceThreadId: {} },
      version: 2
    })
  );
  window.localStorage.setItem(
    "moss:workspace-paths:v1",
    JSON.stringify({
      state: {
        homeDir: "/Users/moss",
        chatWorkspaceRoot: "/Users/moss/Documents/Moss",
        studioWorkspaceRoot: null
      },
      version: 1
    })
  );
  window.localStorage.setItem(
    "moss:appsnap-welcome:v1",
    JSON.stringify({ acknowledged: true })
  );
  window.localStorage.setItem(
    "moss:sidebar-ui:v1",
    JSON.stringify({
      chatSectionExpanded: true,
      chatThreadListExpanded: true,
      expandedProjectThreadListCwds: ["/Users/moss/Codex/tools/moss"],
      dismissedThreadStatusKeyByThreadId: {},
      lastThreadRoute: { threadId: THREAD_ID }
    })
  );
  const defaultServerSettings = {
    enableAssistantStreaming: true,
    enableProviderUpdateChecks: false,
    defaultThreadEnvMode: "local",
    addProjectBaseDirectory: "",
    textGenerationModelSelection: { instanceId: "codex", model: "gpt-5.3-codex" },
    providers: {
      codex: {
        enabled: true,
        binaryPath: "codex",
        homePath: "",
        accounts: [],
        selectedAccountId: "default",
        customModels: []
      },
      claudeAgent: {
        enabled: true,
        binaryPath: "claude",
        homePath: "",
        launchArgs: "",
        customModels: []
      },
      cursor: {
        enabled: true,
        binaryPath: "cursor-agent",
        apiEndpoint: "",
        customModels: []
      },
      gemini: { enabled: true, binaryPath: "gemini", customModels: [] },
      antigravity: { enabled: true, binaryPath: "agy", customModels: [] },
      grok: { enabled: true, binaryPath: "grok", customModels: [] },
      opencode: {
        enabled: true,
        binaryPath: "opencode",
        serverUrl: "",
        serverPassword: "",
        experimentalWebSockets: false,
        customModels: []
      },
      pi: { enabled: true, binaryPath: "pi", agentDir: "", customModels: [] }
    },
    providerInstances: {},
    skills: { disabled: [] }
  };
  const authenticatedMossCloudAccount = {
    configured: true,
    authenticated: true,
    account: {
      id: "moss-served-smoke-account",
      email: "served-smoke@moss.local",
      emailVerified: true,
      displayName: "Moss Served Smoke",
      status: "active",
      createdAt: NOW,
      updatedAt: NOW,
      lastLoginAt: NOW
    },
    session: {
      accountId: "moss-served-smoke-account",
      expiresAt: "2026-07-03T00:08:00.000Z",
      refreshedAt: NOW
    },
    emailVerificationRequired: false,
    modelGatewayConfigured: true,
    authProvider: "supabase_google",
    lastAuthFlow: null
  };
  const authenticatedMossPhoneAccount = {
    configured: true,
    authenticated: true,
    session: {
      id: "moss-served-smoke-phone-session",
      user: {
        id: "moss-served-smoke-phone-user",
        phoneNumber: "+8613800000000",
        displayName: "Moss Served Smoke",
        role: "owner",
        status: "active",
        createdAt: NOW,
        updatedAt: NOW,
        lastLoginAt: NOW
      },
      createdAt: NOW,
      expiresAt: "2026-08-03T00:08:00.000Z",
      lastSeenAt: NOW
    },
    smsProvider: "development",
    aliyunSmsConfigured: true
  };
  const unconfiguredMossByokProvider = {
    configured: false,
    selected: false,
    providerInstanceId: "codex_byok",
    baseUrl: "https://api.apimart.ai/v1",
    model: "gpt-5.5",
    verifiedAt: null
  };

  const project = {
    id: PROJECT_ID,
    kind: "project",
    title: "Moss Served Smoke",
    workspaceRoot: "/Users/moss/Codex/tools/moss",
    defaultModelSelection: { instanceId: "codex", model: "gpt-5.3-codex" },
    scripts: [],
    createdAt: NOW,
    updatedAt: NOW,
    deletedAt: null
  };
  const thread = {
    id: THREAD_ID,
    projectId: PROJECT_ID,
    title: "Moss promoted shell served smoke",
    modelSelection: { provider: "codex", model: "gpt-5.3-codex" },
    interactionMode: "default",
    runtimeMode: "full-access",
    envMode: "local",
    branch: "moss/control-plane-v1",
    worktreePath: null,
    associatedWorktreePath: null,
    associatedWorktreeBranch: null,
    associatedWorktreeRef: null,
    createBranchFlowCompleted: false,
    isPinned: false,
    parentThreadId: null,
    subagentAgentId: null,
    subagentNickname: null,
    subagentRole: null,
    forkSourceThreadId: null,
    sidechatSourceThreadId: null,
    lastKnownPr: null,
    latestTurn: {
      turnId: TURN_ID,
      state: "running",
      requestedAt: NOW,
      startedAt: NOW,
      completedAt: null,
      assistantMessageId: "msg-assistant-moss-served-smoke",
      sourceProposedPlan: null
    },
    latestUserMessageAt: NOW,
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    hasActionableProposedPlan: false,
    createdAt: NOW,
    updatedAt: NOW,
    archivedAt: null,
    deletedAt: null,
    handoff: null,
    pinnedMessages: [],
    threadMarkers: [],
    notes: "Served smoke fixture for Moss promoted shell.",
    messages: [
      {
        id: "msg-user-moss-served-smoke",
        role: "user",
        text: "Verify Moss promoted shell from a served Moss route.",
        turnId: TURN_ID,
        streaming: false,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW
      },
      {
        id: "msg-assistant-moss-served-smoke",
        role: "assistant",
        text: "Running served app smoke for normalized events, launch plan, and loop ledger.",
        turnId: TURN_ID,
        streaming: true,
        source: "native",
        createdAt: NOW,
        updatedAt: NOW
      }
    ],
    activities: [],
    proposedPlans: [],
    checkpoints: [],
    session: {
      threadId: THREAD_ID,
      status: "running",
      providerName: "codex",
      runtimeMode: "full-access",
      activeTurnId: TURN_ID,
      lastError: null,
      updatedAt: NOW
    }
  };
  const readModel = {
    snapshotSequence: 1,
    projects: [project],
    threads: [thread],
    updatedAt: NOW
  };
  const shellSnapshot = {
    snapshotSequence: readModel.snapshotSequence,
    projects: readModel.projects.map((entry) => ({
      id: entry.id,
      kind: entry.kind,
      title: entry.title,
      workspaceRoot: entry.workspaceRoot,
      defaultModelSelection: entry.defaultModelSelection,
      scripts: entry.scripts,
      isPinned: false,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt
    })),
    threads: readModel.threads.map((entry) => ({
      id: entry.id,
      projectId: entry.projectId,
      title: entry.title,
      modelSelection: entry.modelSelection,
      interactionMode: entry.interactionMode,
      runtimeMode: entry.runtimeMode,
      envMode: entry.envMode,
      branch: entry.branch,
      worktreePath: entry.worktreePath,
      associatedWorktreePath: entry.associatedWorktreePath,
      associatedWorktreeBranch: entry.associatedWorktreeBranch,
      associatedWorktreeRef: entry.associatedWorktreeRef,
      createBranchFlowCompleted: entry.createBranchFlowCompleted,
      isPinned: entry.isPinned,
      parentThreadId: entry.parentThreadId,
      subagentAgentId: entry.subagentAgentId,
      subagentNickname: entry.subagentNickname,
      subagentRole: entry.subagentRole,
      forkSourceThreadId: entry.forkSourceThreadId,
      sidechatSourceThreadId: entry.sidechatSourceThreadId,
      lastKnownPr: entry.lastKnownPr,
      latestTurn: entry.latestTurn,
      latestUserMessageAt: entry.latestUserMessageAt,
      hasPendingApprovals: entry.hasPendingApprovals,
      hasPendingUserInput: entry.hasPendingUserInput,
      hasActionableProposedPlan: entry.hasActionableProposedPlan,
      createdAt: entry.createdAt,
      updatedAt: entry.updatedAt,
      archivedAt: entry.archivedAt,
      handoff: entry.handoff,
      session: entry.session
    })),
    updatedAt: readModel.updatedAt
  };
  const normalizedEvents = [
    {
      eventId: "moss-served-smoke-normalized-1",
      type: "text",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-1",
      payload: {
        text: "moss served smoke assistant text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:moss-served-smoke",
        rawSource: "codex.raw.served.text"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-2",
      type: "tool-call",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-2",
      payload: {
        status: "running",
        title: "Inspect launch plan",
        itemId: "moss-served-smoke-tool",
        toolName: "exec_command",
        rawSource: "codex.raw.served.tool-call"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-3",
      type: "tool-result",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-3",
      payload: {
        status: "completed",
        title: "Inspect launch plan",
        itemId: "moss-served-smoke-tool",
        toolName: "exec_command",
        detail: "served smoke tool lifecycle completed",
        rawSource: "codex.raw.served.tool-result"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-4",
      type: "permission-request",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-4",
      payload: {
        status: "pending",
        requestType: "exec_command_approval",
        detail: "Approve served smoke command",
        rawSource: "codex.raw.served.approval"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-5",
      type: "text",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-5",
      payload: {
        text: "Compiled redacted launch plan before starting the provider session.",
        streamKind: "reasoning_summary_text",
        launchPlanHash: "sha256:moss-served-smoke",
        rawSource: "codex.raw.served.launch-summary"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-6",
      type: "usage",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-6",
      payload: {
        usage: { inputTokens: 500, outputTokens: 125, totalTokens: 625 },
        model: "gpt-5.3-codex",
        rawSource: "codex.raw.served.usage"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-7",
      type: "text",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-7",
      payload: {
        text: "Recorded smoke evidence for normalized event replay and product shell layout.",
        streamKind: "command_output",
        launchPlanHash: "sha256:moss-served-smoke",
        rawSource: "codex.raw.served.evidence"
      }
    },
    {
      eventId: "moss-served-smoke-normalized-8",
      type: "finish",
      provider: "codex",
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      turnId: TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-raw-8",
      payload: {
        state: "completed",
        stopReason: "stop",
        rawSource: "codex.raw.served.finish"
      }
    },
    {
      eventId: "moss-served-smoke-secondary-normalized-1",
      type: "text",
      provider: "claudeAgent",
      sessionId: SECONDARY_SESSION_ID,
      threadId: SECONDARY_THREAD_ID,
      turnId: SECONDARY_TURN_ID,
      createdAt: NOW,
      rawEventId: "moss-served-smoke-secondary-raw-1",
      payload: {
        text: "moss served smoke secondary session text",
        streamKind: "assistant_text",
        launchPlanHash: "sha256:moss-served-smoke-secondary",
        rawSource: "claude.raw.served.secondary"
      }
    }
  ];
  const shellListeners = new Set();
  const threadListeners = new Set();
  const normalizedSubscriptions = new Set();
  const emptyAsync = async () => undefined;
  function noOpUnsubscribe() {}
  const inactiveRealtimeVoiceState = {
    phase: "inactive",
    sessionId: null,
    threadId: null,
    ownerClaimId: null,
    source: null,
    voice: null,
    requestedModel: null,
    actualModel: null,
    activity: null,
    barrier: {
      requestAccepted: false,
      backendStarted: false,
      webRtcConnected: false,
      dataSessionInitialized: false
    },
    inputMuted: false,
    outputMuted: false,
    error: null
  };
  async function rejectUnexpectedRealtimeVoiceMutation() {
    throw new Error("Realtime Voice mutation was not expected during the served shell smoke");
  }
  function terminalSnapshot(input) {
    return {
      threadId: String(input.threadId),
      terminalId: String(input.terminalId ?? "default"),
      cwd: String(input.cwd ?? "/Users/moss/Codex/tools/moss"),
      status: "running",
      pid: 4242,
      history: "",
      exitCode: null,
      exitSignal: null,
      updatedAt: NOW
    };
  }
  function deepFallback(path = []) {
    const fallback = function () {
      return Promise.resolve(undefined);
    };
    return new Proxy(fallback, {
      get(_target, key) {
        if (key === "then") return undefined;
        if (key === Symbol.toStringTag) return "MossSmokeFallback";
        return deepFallback([...path, String(key)]);
      },
      apply() {
        return Promise.resolve(undefined);
      }
    });
  }
  function withFallback(target) {
    return new Proxy(target, {
      get(object, key) {
        if (key in object) return object[key];
        if (key === "then") return undefined;
        return deepFallback([String(key)]);
      }
    });
  }
  const providerApi = withFallback({
    getComposerCapabilities: async () => ({
      supportsSkillDiscovery: true,
      supportsPluginDiscovery: true,
      supportsNativeSlashCommandDiscovery: true,
      supportsThreadCompaction: true,
      supportsThreadImport: false
    }),
    getLaunchPlan: async (input) => {
      const isSecondary = String(input.threadId) === SECONDARY_THREAD_ID;
      const planHash = isSecondary ? "sha256:moss-served-smoke-secondary" : "sha256:moss-served-smoke";
      return {
      threadId: input.threadId,
      planHash,
      launchPlan: {
        version: 1,
        planId: isSecondary
          ? "moss-launch-thread-moss-served-smoke-secondary-2026-07-02"
          : "moss-launch-thread-moss-served-smoke-2026-07-02",
        planHash,
        createdAt: NOW,
        provider: isSecondary ? "claudeAgent" : "codex",
        model: isSecondary ? "claude-sonnet-5" : "gpt-5.3-codex",
        workspace: {
          cwd: isSecondary ? "/Users/moss/Codex/tools/other-agent" : "/Users/moss/Codex/tools/moss",
          projectId: PROJECT_ID,
          threadId: input.threadId
        },
        environment: {
          variables: [
            {
              key: "OPENAI_API_KEY",
              redacted: true,
              valueHash: "sha256:redacted",
              source: "process.env"
            }
          ]
        },
        permissions: {
          runtimeMode: "full-access",
          approvalPolicy: "never",
          sandboxMode: "danger-full-access"
        },
        mcp: [{ name: "moss", source: ".moss/config.json", enabled: true }],
        skills: [{ name: "continuous-agent-loop", source: ".moss", enabled: true }],
        memory: [{ name: "current-context", source: ".moss/context/current.md", enabled: true }],
        hooks: [{ name: "Stop", source: "/Users/moss/.codex/hooks.json", enabled: true }],
        tools: { allow: ["exec_command"], deny: ["destructive-git-reset"] },
        providerStartOptions: {
          [isSecondary ? "claudeAgent" : "codex"]: {
            model: isSecondary ? "claude-sonnet-5" : "gpt-5.3-codex",
            cwd: isSecondary ? "/Users/moss/Codex/tools/other-agent" : "/Users/moss/Codex/tools/moss"
          }
        },
        configSources: [
          { kind: "canonical", path: ".moss/mission.md", required: true },
          { kind: "project", path: ".moss/context/current.md", required: true }
        ],
        projectionWarnings: []
      }
    };
    },
    getLoopLedgerDashboardSnapshot: async () => ({
      threadId: THREAD_ID,
      snapshot: {
        version: 1,
        generatedAt: NOW,
        mission: {
          title: "Moss Shell v1",
          currentGoal: "Gate production-ready GUI smoke for promoted Moss shell",
          branch: "moss/control-plane-v1",
          status: "active"
        },
        tasks: {
          total: 81,
          counts: {
            active: 1,
            done: 80,
            blocked: 0
          },
          active: [
            {
              taskId: "moss-task-0081",
              title: "Gate production-ready GUI smoke for promoted Moss shell",
              owner: "QA Gatekeeper",
              status: "active",
              acceptanceCount: 5,
              evidenceCount: 1
            }
          ],
          next: ["Gate all-provider launch plan startup coverage."]
        },
        reviews: {
          recent: []
        },
        evidence: {
          indexedArtifacts: 1,
          taskEvidenceReferences: 1,
          commandReferences: 1,
          missingCompletedTaskEvidence: 0,
          recent: [
            {
              label: ".moss/ledger/evidence/moss-promoted-shell-served-smoke-2026-07-02.json",
              kind: "smoke",
              status: "pass"
            }
          ]
        },
        roles: [
          {
            role: "QA Gatekeeper",
            activeTaskCount: 1,
            responsibility: "Maintain smoke gates and evidence discipline.",
            status: "assigned"
          },
          {
            role: "UI Parity Engineer",
            activeTaskCount: 0,
            responsibility: "Maintain Codex-like promoted shell parity.",
            status: "idle"
          }
        ],
        releaseGate: {
          status: "blocked",
          issueCount: 1,
          summary: "Full Codex parity claim remains false until all-provider launch coverage lands.",
          checks: [
            {
              id: "all-provider-launch-coverage",
              label: "All-provider launch coverage",
              status: "blocked",
              summary: "Next loop must cover provider launch plan startup across supported providers.",
              issueCount: 1
            }
          ]
        }
      }
    }),
    listAgents: async () => ({ agents: [], source: "served-smoke", cached: true }),
    listCommands: async () => ({ commands: [], source: "served-smoke", cached: true }),
    listModels: async (input) => {
      const modelByProvider = {
        claudeAgent: { slug: "claude-sonnet-5", name: "Claude Sonnet 5" },
        codex: { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        cursor: { slug: "gpt-5.3-codex", name: "GPT-5.3 Codex" },
        gemini: { slug: "gemini-3-pro", name: "Gemini 3 Pro" },
        antigravity: { slug: "gemini-3-pro", name: "Gemini 3 Pro" },
        grok: { slug: "grok-4", name: "Grok 4" },
        opencode: { slug: "openai/gpt-5.3-codex", name: "GPT-5.3 Codex" },
        pi: { slug: "anthropic/claude-sonnet-5", name: "Claude Sonnet 5" }
      };
      const provider = String(input?.provider ?? input?.instanceId ?? "codex");
      const model = modelByProvider[provider] ?? modelByProvider.codex;
      return {
        models: [model],
        source: provider + ".served-smoke",
        cached: true
      };
    },
    listPlugins: async () => ({
      marketplaces: [],
      marketplaceLoadErrors: [],
      remoteSyncError: null,
      featuredPluginIds: [],
      source: "served-smoke",
      cached: true
    }),
    listSessions: async () => ({
      sessions: [
        {
          provider: "codex",
          status: "running",
          runtimeMode: "full-access",
          cwd: "/Users/moss/Codex/tools/moss",
          model: "gpt-5.3-codex",
          threadId: THREAD_ID,
          activeTurnId: TURN_ID,
          createdAt: NOW,
          updatedAt: NOW
        },
        {
          provider: "claudeAgent",
          status: "ready",
          runtimeMode: "read-only",
          cwd: "/Users/moss/Codex/tools/other-agent",
          model: "claude-sonnet-5",
          threadId: SECONDARY_THREAD_ID,
          activeTurnId: SECONDARY_TURN_ID,
          createdAt: NOW,
          updatedAt: NOW
        }
      ]
    }),
    listSkills: async () => ({ skills: [], source: "served-smoke", cached: true }),
    listSkillsCatalog: async () => ({ providers: [], source: "served-smoke", cached: true }),
    readPlugin: async () => ({ plugin: null }),
    submitPermissionAction: async (input) => ({
      ...input,
      status: "accepted",
      message: "Served smoke permission accepted."
    }),
    subscribeNormalizedSessionEvents: (input, listener) => {
      const record = { input, listener, closed: false };
      normalizedSubscriptions.add(record);
      for (const event of normalizedEvents) {
        if (String(event.threadId) === String(input.threadId)) {
          queueMicrotask(() => {
            if (!record.closed) listener(event);
          });
        }
      }
      return () => {
        record.closed = true;
        normalizedSubscriptions.delete(record);
      };
    }
  });
  const orchestrationApi = withFallback({
    dispatchCommand: async () => readModel,
    getShellSnapshot: async () => shellSnapshot,
    getSnapshot: async () => readModel,
    onDomainEvent: () => noOpUnsubscribe,
    onShellEvent: (listener) => {
      shellListeners.add(listener);
      return () => shellListeners.delete(listener);
    },
    onThreadEvent: (listener) => {
      threadListeners.add(listener);
      return () => threadListeners.delete(listener);
    },
    repairState: async () => readModel,
    replayEvents: async () => [],
    subscribeShell: async () => {
      queueMicrotask(() => {
        for (const listener of shellListeners) {
          listener({ kind: "snapshot", snapshot: shellSnapshot });
        }
      });
    },
    subscribeThread: async (input) => {
      const detail = readModel.threads.find((entry) => String(entry.id) === String(input.threadId));
      if (!detail) return;
      queueMicrotask(() => {
        for (const listener of threadListeners) {
          listener({ kind: "snapshot", snapshot: { snapshotSequence: readModel.snapshotSequence, thread: detail } });
        }
      });
    },
    unsubscribeShell: emptyAsync,
    unsubscribeThread: emptyAsync
  });
  window.nativeApi = withFallback({
    automation: withFallback({ list: async () => ({ definitions: [], runs: [] }), onEvent: () => noOpUnsubscribe }),
    dialogs: withFallback({ confirm: async () => true, openFile: async () => null, saveFile: async () => null }),
    git: withFallback({
      checkout: async () => undefined,
      createBranch: async () => undefined,
      githubRepository: async () => null,
      listBranches: async () => ({ branches: [], currentBranch: "moss/control-plane-v1" }),
      onActionProgress: () => noOpUnsubscribe,
      readWorkingTreeDiff: async () => ({ files: [], summary: null }),
      workingTreeDiffStats: async () => ({ additions: 0, deletions: 0, fileCount: 0 }),
      status: async () => ({ isGitRepo: true, branch: "moss/control-plane-v1", status: "clean", files: [] })
    }),
    orchestration: orchestrationApi,
    pullRequests: withFallback({
      reviewRequestCount: async () => ({ count: 0, incomplete: false })
    }),
    provider: providerApi,
    projects: withFallback({
      createLocalFilePreviewGrant: async () => ({ token: "served-smoke", expiresAt: "2026-07-02T01:08:00.000Z" }),
      discoverScripts: async () => ({ targets: [] }),
      listDirectories: async () => ({ entries: [] }),
      listDevServers: async () => ({ servers: [] }),
      // Event subscriptions return synchronous unsubscribe callbacks. Keep
      // those methods explicit in the harness so deepFallback cannot hand
      // React a Promise as an effect cleanup.
      onFileChange: () => noOpUnsubscribe,
      onDevServerEvent: () => noOpUnsubscribe,
      readFile: async () => ({ content: "", encoding: "utf8" }),
      searchEntries: async () => ({ entries: [], truncated: false }),
      searchLocalEntries: async () => ({ entries: [], truncated: false })
    }),
    realtimeVoice: withFallback({
      listVoices: async () => ({
        defaultVoice: "maple",
        preferredTransport: "webrtc",
        voices: [
          {
            id: "maple",
            displayName: "Maple",
            description: "Warm and conversational"
          }
        ]
      }),
      claim: rejectUnexpectedRealtimeVoiceMutation,
      releaseClaim: rejectUnexpectedRealtimeVoiceMutation,
      start: rejectUnexpectedRealtimeVoiceMutation,
      reportClientState: rejectUnexpectedRealtimeVoiceMutation,
      resolveScreenContext: rejectUnexpectedRealtimeVoiceMutation,
      appendText: rejectUnexpectedRealtimeVoiceMutation,
      appendSpeech: rejectUnexpectedRealtimeVoiceMutation,
      stop: rejectUnexpectedRealtimeVoiceMutation,
      getState: async () => inactiveRealtimeVoiceState,
      onEvent: () => noOpUnsubscribe
    }),
    device: withFallback({
      onEvent: () => noOpUnsubscribe,
      list: async () => ({ devices: [] })
    }),
    server: withFallback({
      getAuthSession: async () => ({
        authenticated: true,
        auth: {
          policy: "desktop-managed-local",
          bootstrapMethods: ["desktop-bootstrap"],
          sessionMethods: ["browser-session-cookie"],
          sessionCookieName: "moss_served_smoke"
        },
        role: "owner",
        sessionMethod: "browser-session-cookie",
        expiresAt: "2026-07-03T00:08:00.000Z"
      }),
      getConfig: async () => ({
        cwd: "/Users/moss/Codex/tools/moss",
        homeDir: "/Users/moss",
        chatWorkspaceRoot: "/Users/moss",
        worktreesDir: "/Users/moss/Codex/tools/moss/.moss/worktrees",
        keybindingsConfigPath: "/Users/moss/Codex/tools/moss/.moss/keybindings.json",
        keybindings: [],
        issues: [],
        providers: [
          {
            provider: "codex",
            status: "ready",
            available: true,
            authStatus: "authenticated",
            checkedAt: NOW,
            voiceTranscriptionAvailable: false,
            version: "served-smoke"
          }
        ],
        availableEditors: []
      }),
      getEnvironment: async () => ({ environments: [] }),
      getMossByokProviderState: async () => unconfiguredMossByokProvider,
      getMossCloudAccountState: async () => authenticatedMossCloudAccount,
      getMossAccountSession: async () => authenticatedMossPhoneAccount,
      getProviderUsageSnapshot: async () => null,
      getSettings: async () => defaultServerSettings,
      listLocalServers: async () => ({ servers: [] }),
      listMossCloudAccounts: async () => ({ accounts: [] }),
      listProviderUsage: async () => [],
      listWorktrees: async () => ({ worktrees: [] })
    }),
    shell: withFallback({ openExternal: emptyAsync, showInFolder: emptyAsync }),
    stats: withFallback({
      getProfileStats: async () => ({}),
      getProfileTokenStats: async () => ({})
    }),
    terminal: withFallback({
      open: async (input) => terminalSnapshot(input),
      write: emptyAsync,
      ackOutput: emptyAsync,
      resize: emptyAsync,
      clear: emptyAsync,
      restart: async (input) => terminalSnapshot(input),
      close: emptyAsync,
      onEvent: () => noOpUnsubscribe,
      subscribe: () => noOpUnsubscribe
    })
  });
})();
`;
}

async function assertSelector(
  page: {
    waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
  },
  selector: string,
  label: string,
  assertions: string[],
  timeoutMs = 45_000,
): Promise<void> {
  await page.waitForSelector(selector, { timeout: timeoutMs });
  assertions.push(label);
}

async function navigateToServedRoute(
  page: {
    goto: (
      url: string,
      options?: { waitUntil?: "domcontentloaded"; timeout?: number },
    ) => Promise<unknown>;
    waitForTimeout?: (timeoutMs: number) => Promise<void>;
  },
  route: string,
  browserLogs: string[],
): Promise<void> {
  const attempts = 2;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      await page.goto(route, { waitUntil: "domcontentloaded", timeout: 60_000 });
      return;
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendBounded(browserLogs, detail, `[goto:attempt-${attempt}:error] `);
      if (attempt === attempts) {
        throw error;
      }
      await page.waitForTimeout?.(1_000);
    }
  }
}

async function recordBodySnapshot(
  page: {
    locator: (selector: string) => { innerText: () => Promise<string> };
    evaluate?: <T>(pageFunction: () => T) => Promise<T>;
    url?: () => string;
  },
  browserLogs: string[],
  label: string,
): Promise<void> {
  if (typeof page.url === "function") {
    appendBounded(browserLogs, page.url(), `[url:${label}] `);
  }
  try {
    const bodyText = await page.locator("body").innerText();
    appendBounded(browserLogs, bodyText.slice(0, 2_000), `[body:${label}] `);
  } catch (error) {
    const detail = error instanceof Error ? error.message : String(error);
    appendBounded(browserLogs, detail, `[body:${label}:error] `);
  }
  if (typeof page.evaluate === "function") {
    try {
      const selectorCounts = await page.evaluate(() => {
        const doc = (
          globalThis as unknown as {
            document: {
              querySelector: (selector: string) => { children: { length: number } } | null;
              querySelectorAll: (selector: string) => { length: number };
            };
          }
        ).document;
        const root = doc.querySelector("#root");
        return {
          chatComposerForm: doc.querySelectorAll("[data-chat-composer-form]").length,
          chatComposerVisible: doc.querySelectorAll(
            "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
          ).length,
          deferredComposer: doc.querySelectorAll("[data-chat-composer-form='deferred']").length,
          mossAccessStrip: doc.querySelectorAll("[data-moss-native-shell-access]").length,
          mossControlPlaneEvents: doc.querySelectorAll("[data-moss-control-plane-events]").length,
          routeMainViewport: doc.querySelectorAll(".chat-main-viewport-shell").length,
          rootChildren: root?.children.length ?? null,
        };
      });
      appendBounded(browserLogs, JSON.stringify(selectorCounts), `[selectors:${label}] `);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      appendBounded(browserLogs, detail, `[selectors:${label}:error] `);
    }
  }
}

async function runBrowserSmoke(input: {
  readonly baseUrl: string;
  readonly browserFailures: string[];
  readonly createdAt: string;
  readonly screenshotPath?: string;
  readonly browserLogs: string[];
  readonly timeoutMs: number;
}): Promise<{
  readonly assertions: ReadonlyArray<string>;
  readonly interactionContinuity: MossShellInteractionContinuity;
}> {
  const playwrightUrl = resolvePlaywrightModuleUrl();
  const importedPlaywright = (await import(playwrightUrl)) as {
    chromium?: {
      launch: (options: { headless: boolean }) => Promise<{
        close: () => Promise<void>;
        newContext: (options: { viewport: { width: number; height: number } }) => Promise<{
          addInitScript: (options: { content: string }) => Promise<void>;
          newPage: () => Promise<{
            goto: (url: string, options?: { waitUntil?: "domcontentloaded" }) => Promise<unknown>;
            locator: (selector: string) => {
              click: () => Promise<void>;
              getAttribute: (name: string) => Promise<string | null>;
              innerText: () => Promise<string>;
            };
            on: (event: string, listener: (...args: any[]) => void) => void;
            screenshot: (options: { path: string; fullPage: boolean }) => Promise<Buffer>;
            url: () => string;
            waitForSelector: (selector: string, options?: { timeout?: number }) => Promise<unknown>;
          }>;
        }>;
      }>;
    };
    default?: {
      chromium?: {
        launch: (options: { headless: boolean }) => Promise<{
          close: () => Promise<void>;
          newContext: (options: { viewport: { width: number; height: number } }) => Promise<{
            addInitScript: (options: { content: string }) => Promise<void>;
            newPage: () => Promise<{
              goto: (
                url: string,
                options?: { waitUntil?: "domcontentloaded"; timeout?: number },
              ) => Promise<unknown>;
              locator: (selector: string) => {
                click: () => Promise<void>;
                getAttribute: (name: string) => Promise<string | null>;
                innerText: () => Promise<string>;
              };
              on: (event: string, listener: (...args: any[]) => void) => void;
              screenshot: (options: { path: string; fullPage: boolean }) => Promise<Buffer>;
              url: () => string;
              waitForTimeout: (timeoutMs: number) => Promise<void>;
              waitForSelector: (
                selector: string,
                options?: { timeout?: number },
              ) => Promise<unknown>;
            }>;
          }>;
        }>;
      };
    };
  };
  const chromium = importedPlaywright.chromium ?? importedPlaywright.default?.chromium;
  if (!chromium) {
    throw new Error("Unable to load Playwright chromium from apps/web workspace.");
  }
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext({ viewport: { width: 1_440, height: 1_000 } });
    await context.addInitScript({ content: buildInitScript(input.createdAt) });
    const page = await context.newPage();
    const routeCapablePage = page as unknown as {
      route: (
        url: string,
        handler: (route: {
          fulfill: (response: { status: number }) => Promise<void>;
        }) => Promise<void>,
      ) => Promise<void>;
    };
    await routeCapablePage.route("**/api/project-favicon?*", async (route) => {
      await route.fulfill({ status: 204 });
    });
    const browserDiagnostics: BrowserDiagnostics = {
      failureTail: input.browserFailures,
      logTail: input.browserLogs,
    };
    page.on("console", (message: { type: () => string; text: () => string }) => {
      recordBrowserConsole(browserDiagnostics, message.type(), message.text());
    });
    page.on("pageerror", (error: Error) => {
      recordBrowserFailure(browserDiagnostics, "pageerror", error.stack ?? error.message);
    });
    page.on(
      "requestfailed",
      (request: { failure: () => { errorText: string } | null; url: () => string }) => {
        recordBrowserFailure(
          browserDiagnostics,
          "requestfailed",
          `${request.failure()?.errorText ?? "unknown failure"} ${request.url()}`,
        );
      },
    );

    const assertions: string[] = [];
    const visitedSurfaces: Array<"events" | "sessions" | "launch-plan" | "ledger"> = ["events"];
    const route = buildServedProductRoute(input.baseUrl);
    await navigateToServedRoute(page, route, input.browserLogs);
    try {
      await assertSelector(
        page,
        "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
        "composer shell mounted from served app route",
        assertions,
        input.timeoutMs,
      );
    } catch (error) {
      await recordBodySnapshot(page, input.browserLogs, "composer-timeout");
      throw error;
    }
    await assertSelector(
      page,
      "[data-moss-native-shell-access='true'][data-moss-native-shell-provider='codex'][data-moss-native-shell-session-status='running']",
      "native Moss shell access strip reflects active codex running session",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-native-shell-access='true'][data-moss-shell-productization-source='route-toggle'][data-moss-shell-productization-mode='explicit-toggle']",
      "native Moss shell is enabled by explicit harness route",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-visible-stop-control='true']",
      "running-session stop control is visible",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-control-plane-events]",
      "default normalized event surface is visible",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-event-count='8']",
      "normalized event subscription is live with fixture events",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-normalized-row][data-event-type='tool-result'][data-tool-lifecycle-state='succeeded']",
      "tool-call and tool-result lifecycle is normalized",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-normalized-row][data-event-type='usage'][data-usage-model='gpt-5.3-codex']",
      "usage event renders from normalized timeline",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-normalized-row][data-event-type='permission-request'] [data-moss-normalized-permission-action-shell]",
      "permission request action shell is available from normalized event",
      assertions,
    );
    const bodyAfterEvents = await page.locator("body").innerText();
    if (bodyAfterEvents.includes("codex.raw.served")) {
      throw new Error("Raw provider event source leaked into visible served shell.");
    }
    assertions.push("raw provider event source is not rendered");
    const routeBeforeSwitches = normalizeMossShellRouteHref(page.url());

    await page
      .locator(
        "[data-event-id='moss-served-smoke-normalized-4'] [data-permission-action-intent='approve']",
      )
      .click();
    await assertSelector(
      page,
      "[data-event-id='moss-served-smoke-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='accepted'][data-permission-action-enabled='false']",
      "permission request approve action transitions to accepted",
      assertions,
    );
    const permissionActionStatus = await page
      .locator(
        "[data-event-id='moss-served-smoke-normalized-4'] [data-moss-normalized-permission-action-shell]",
      )
      .getAttribute("data-permission-action-status");

    await page.locator("[data-moss-native-session-list-access='true']").click();
    visitedSurfaces.push("sessions");
    await assertSelector(
      page,
      "[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='thread-moss-served-smoke'][data-session-status='running']",
      "session list surface shows served runtime session",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='thread-moss-served-smoke-secondary'][data-provider='Claude'][data-session-status='ready']",
      "session list surface shows secondary provider session",
      assertions,
    );
    await page
      .locator(
        "[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='thread-moss-served-smoke-secondary']",
      )
      .click();
    await assertSelector(
      page,
      "[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='thread-moss-served-smoke-secondary'][data-selected-session='true'][data-active-thread='false']",
      "secondary provider session can be selected without changing the active thread",
      assertions,
    );

    await page.locator("[data-moss-native-normalized-event-timeline-access='true']").click();
    visitedSurfaces.push("events");
    await assertSelector(
      page,
      "[data-moss-control-plane-events] [data-moss-normalized-session-scope][data-scope-thread-id='thread-moss-served-smoke-secondary'][data-scope-active-thread='false']",
      "normalized event surface scopes to selected secondary session",
      assertions,
    );
    const selectedSessionSubscription = page.locator(
      "[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='thread-moss-served-smoke-secondary']",
    );
    await assertSelector(
      page,
      "[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='thread-moss-served-smoke-secondary'][data-subscription-event-count='1']",
      "selected secondary session normalized timeline renders without active-thread event bleed",
      assertions,
    );
    await assertSelector(
      page,
      "[data-moss-control-plane-events] [data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text']",
      "selected secondary session normalized row is visible",
      assertions,
    );
    const selectedEventSurfaceText = await page
      .locator("[data-moss-control-plane-events]")
      .innerText();
    if (!selectedEventSurfaceText.includes("moss served smoke secondary session text")) {
      throw new Error("Selected secondary session text did not render in the served shell.");
    }
    if (
      selectedEventSurfaceText.includes("moss served smoke assistant text") ||
      selectedEventSurfaceText.includes("claude.raw.served")
    ) {
      throw new Error(
        "Selected secondary session timeline leaked active-thread or raw event text.",
      );
    }
    assertions.push(
      "selected secondary session timeline hides active-thread and raw provider text",
    );

    await page.locator("[data-moss-native-launch-plan-access='true']").click();
    visitedSurfaces.push("launch-plan");
    await assertSelector(
      page,
      "[data-moss-control-plane-launch-plan]",
      "launch plan inspector surface is visible",
      assertions,
    );
    const launchText = await page.locator("[data-moss-control-plane-launch-plan]").innerText();
    if (!launchText.includes("sha256:moss-served-smoke-secondary")) {
      throw new Error("Launch plan inspector did not render the selected secondary plan hash.");
    }
    assertions.push("launch plan inspector renders selected secondary redacted plan hash");

    await page.locator("[data-moss-native-loop-ledger-access='true']").click();
    visitedSurfaces.push("ledger");
    await assertSelector(
      page,
      "[data-moss-control-plane-ledger]",
      "loop ledger dashboard surface is visible",
      assertions,
    );
    const ledgerText = await page.locator("[data-moss-control-plane-ledger]").innerText();
    if (!ledgerText.includes("moss-task-0081")) {
      throw new Error("Loop ledger dashboard did not render active 0081 task.");
    }
    assertions.push("loop ledger dashboard renders 0081 task context");

    await page.locator("[data-moss-native-normalized-event-timeline-access='true']").click();
    visitedSurfaces.push("events");
    await assertSelector(
      page,
      "[data-moss-control-plane-events] [data-moss-normalized-subscription-state][data-subscription-scope='selected-session'][data-subscription-thread-id='thread-moss-served-smoke-secondary'][data-subscription-event-count='1']",
      "selected-session event surface remains available after surface switches",
      assertions,
    );
    const composerThreadIdAfterSwitches = await page
      .locator("form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']")
      .getAttribute("data-moss-visible-thread-id");
    if (composerThreadIdAfterSwitches !== THREAD_ID) {
      throw new Error("Composer thread changed during Moss surface switching.");
    }
    const routeAfterSwitches = normalizeMossShellRouteHref(page.url());
    if (routeAfterSwitches !== routeBeforeSwitches) {
      throw new Error(
        `Moss surface switching changed the active route: ${routeBeforeSwitches} -> ${routeAfterSwitches}`,
      );
    }
    assertions.push("composer and active route remain stable across Moss surface switches");

    const selectedSessionEventCount = Number(
      (await selectedSessionSubscription.getAttribute("data-subscription-event-count")) ?? "0",
    );
    const interactionContinuity: MossShellInteractionContinuity = {
      routeBeforeSwitches,
      routeAfterSwitches,
      composerThreadIdAfterSwitches,
      visitedSurfaces,
      selectedSessionThreadId: SECONDARY_THREAD_ID,
      selectedSessionEventCount,
      permissionActionStatus,
      launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
    };

    if (input.screenshotPath) {
      mkdirSync(dirname(resolve(REPO_ROOT, input.screenshotPath)), { recursive: true });
      await page.screenshot({ path: resolve(REPO_ROOT, input.screenshotPath), fullPage: true });
    }

    if (input.browserFailures.length > 0) {
      throw new Error(
        `Served shell emitted unexpected browser failures: ${input.browserFailures.join(" | ")}`,
      );
    }

    return { assertions, interactionContinuity };
  } finally {
    await browser.close();
  }
}

async function main(argv: ReadonlyArray<string>): Promise<number> {
  const options = parseArgs(argv);
  if (options.dumpInitScriptPath) {
    const absoluteInitScriptPath = resolve(REPO_ROOT, options.dumpInitScriptPath);
    mkdirSync(dirname(absoluteInitScriptPath), { recursive: true });
    writeFileSync(absoluteInitScriptPath, buildInitScript(options.createdAt));
    console.log(
      JSON.stringify(
        {
          createdAt: options.createdAt,
          initScriptPath: options.dumpInitScriptPath,
        },
        null,
        2,
      ),
    );
    return 0;
  }

  const viteLogs: string[] = [];
  const browserLogs: string[] = [];
  const browserFailures: string[] = [];
  const port = await resolvePort(options.port);
  const baseUrl = `http://127.0.0.1:${port}`;
  const child = startVite(port, viteLogs);

  try {
    await waitForHttp(baseUrl, Math.min(options.timeoutMs, 45_000));
    const smoke = await runBrowserSmoke({
      baseUrl,
      browserFailures,
      browserLogs,
      createdAt: options.createdAt,
      timeoutMs: options.timeoutMs,
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    });
    const report: SmokeReport = {
      createdAt: options.createdAt,
      route: buildServedProductRoute(baseUrl),
      baseUrl,
      assertions: smoke.assertions,
      interactionContinuity: smoke.interactionContinuity,
      ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
      viteLogTail: viteLogs,
      browserLogTail: browserLogs,
    };
    if (options.reportPath) {
      const absoluteReportPath = resolve(REPO_ROOT, options.reportPath);
      mkdirSync(dirname(absoluteReportPath), { recursive: true });
      writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
    }
    console.log(JSON.stringify(report, null, 2));
    return 0;
  } catch (error) {
    if (viteLogs.length > 0) {
      console.error("[moss-promoted-shell-served-smoke] vite log tail:");
      for (const line of viteLogs) {
        console.error(line);
      }
    }
    if (browserLogs.length > 0) {
      console.error("[moss-promoted-shell-served-smoke] browser log tail:");
      for (const line of browserLogs) {
        console.error(line);
      }
    }
    throw error;
  } finally {
    await stopProcess(child);
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main(process.argv.slice(2)).then(
    (status) => {
      process.exitCode = status;
    },
    async (error: unknown) => {
      console.error(error instanceof Error ? error.stack : String(error));
      process.exitCode = 1;
    },
  );
}
