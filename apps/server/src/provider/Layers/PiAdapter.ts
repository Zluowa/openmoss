/**
 * PiAdapter - drives the person's own Pi CLI (`pi --mode rpc`), one child process per thread.
 *
 * Moss no longer embeds the Pi SDK. Pi runs as the person installed it (or as Moss installed it
 * with one click) and Moss speaks Pi's documented RPC protocol. A small Moss extension
 * (`pi -e <file>`) registers the Moss account models and the Moss gateway tools; gateway calls
 * come back to Moss over the RPC extension UI channel, so Moss keeps its per-turn leases.
 *
 * @module PiAdapter
 */
import crypto from "node:crypto";
import os from "node:os";
import { rm } from "node:fs/promises";
import path from "node:path";

import {
  ApprovalRequestId,
  type ChatAttachment,
  EventId,
  type PiModelSelection,
  type ProviderComposerCapabilities,
  type ProviderListCommandsResult,
  type ProviderListModelsResult,
  type ProviderListSkillsResult,
  ProviderItemId,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  RuntimeItemId,
  RuntimeRequestId,
  ThreadId,
  type ThreadTokenUsageSnapshot,
  TurnId,
  type UserInputQuestion,
} from "@moss/contracts";
import { Effect, FileSystem, Layer, Option, Queue, Stream } from "effect";

import {
  type MossHarnessPolicyDeliveryState,
  takeMossHarnessPolicyForProviderSession,
} from "../../agentGateway/harnessPolicy.ts";
import {
  callAgentGatewayMcpTool,
  listAgentGatewayMcpTools,
  type AgentGatewayMcpFetch,
} from "../../agentGateway/mcpInjection.ts";
import {
  AgentGatewayCredentials,
  type AgentGatewayMcpConnection,
} from "../../agentGateway/Services/AgentGatewayCredentials.ts";
import { MOSS_COMPUTER_TOOL_NAMES } from "../../agentGateway/computerToolPermission.ts";
import {
  acquireAgentGatewaySessionLease,
  cancelAgentGatewayTurn,
  captureAgentGatewayCapabilityInput,
  releaseAgentGatewaySessionLeaseOnInterrupt,
  type AgentGatewayCapabilityInput,
  type AgentGatewaySessionLease,
  withAgentGatewayTurnCancellation,
} from "../../agentGateway/sessionLease.ts";
import { ServerConfig } from "../../config.ts";
import { buildProviderChildEnvironment } from "../../providerChildEnvironment.ts";
import { providerProcessPriorityEnabled } from "../../providerProcessPriority.ts";
import { appendFileAttachmentsPromptBlock } from "../attachmentProjection.ts";
import { makeBoundedCallbackIngress } from "../boundedCallbackIngress.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import { makeKeyedLock } from "../keyedLock.ts";
import {
  MOSS_MANAGED_PI_CONFIG_ENV_KEY,
  MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY,
  readMossManagedPiConfig,
} from "../mossManagedPiEnvironment.ts";
import {
  ensureMossPiExtensionFile,
  isMossPiBridgeTitle,
  MOSS_PI_BRIDGE_ENV_KEY,
  MOSS_PI_GATEWAY_SYNC_COMMAND,
  MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY,
  MOSS_PI_INTERNAL_COMMANDS,
  MOSS_PI_RELOAD_COMMAND,
  type MossPiBridgeResponse,
  type MossPiGatewayToolDescriptor,
  parseMossPiBridgeRequest,
  writeMossPiGatewayToolsFile,
} from "../pi/mossPiExtension.ts";
import {
  classifyPiRuntimeError,
  findPiModel,
  isPiReloadCommand,
  isRecord,
  makePiStoragePaths,
  mapPiMessageHistory,
  normalizePiThinkingLevel,
  normalizePiTokenUsage,
  parsePiModelReference,
  piModelSlug,
  type PiRpcModel,
  type PiRpcSessionState,
  type PiRpcSessionStats,
  piToolItemType,
  piToolLifecycleData,
  piToolTitle,
  textFromToolResult,
  toPiProviderModelDescriptor,
  trimPiDisplayText,
  trimToUndefined,
} from "../pi/piProtocolMapping.ts";
import {
  type PiRpcClient,
  type PiRpcExit,
  type PiRpcRecord,
  type PiRpcSpawn,
  startPiRpcClient,
} from "../pi/PiRpcClient.ts";
import { readPiSettingsDefaultModel } from "../piCliModels.ts";
import { classifyPiTurnFailure, piMissingModelSignInIssue } from "../piTurnFailure.ts";
import { resolveProviderAttachmentPath } from "../providerAttachmentPaths.ts";
import { buildProviderProcessEnv } from "../providerProcessEnv.ts";
import {
  compactProviderRuntimeEventForIngress,
  isTerminalProviderRuntimeEvent,
  PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
  PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
  type SizedProviderRuntimeEvent,
} from "../providerRuntimeEventIngress.ts";
import { PiAdapter, type PiAdapterShape } from "../Services/PiAdapter.ts";
import {
  PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
  resolveProviderSessionInstanceId,
  type ProviderThreadSnapshot,
} from "../Services/ProviderAdapter.ts";
import { settleConcurrentTeardowns } from "../settleConcurrentTeardowns.ts";
import type { teardownProviderProcessTree } from "../supervisedProcessTeardown.ts";
import { type EventNdjsonLogger, makeEventNdjsonLogger } from "./EventNdjsonLogger.ts";

export {
  getPiSupportedThinkingOptions,
  makePiStoragePaths,
  toPiProviderModelDescriptor,
} from "../pi/piProtocolMapping.ts";

const PROVIDER = "pi" as const;

/** The config folder a Pi with this environment reads: `PI_CODING_AGENT_DIR` or `~/.pi/agent`. */
function piAgentDirOf(env: NodeJS.ProcessEnv): string {
  const configured = env.PI_CODING_AGENT_DIR?.trim();
  if (configured) return configured;
  const home = env.USERPROFILE?.trim() || env.HOME?.trim() || os.homedir();
  return path.join(home, ".pi", "agent");
}
const DEFAULT_PI_BINARY = "pi";
/** First command after spawn: Pi loads extensions, skills and MCP config before it answers. */
const PI_STARTUP_TIMEOUT_MS = 90_000;
/** Pi answers `prompt` once preflight passes; preflight can wait for MCP servers or compact. */
const PI_PROMPT_ACCEPT_TIMEOUT_MS = 10 * 60_000;
const PI_ABORT_TIMEOUT_MS = 60_000;
const PI_COMPACT_TIMEOUT_MS = 15 * 60_000;
const PI_BOOKKEEPING_TIMEOUT_MS = 15_000;

export function buildPiTurnPrompt(
  state: MossHarnessPolicyDeliveryState,
  input: { readonly text: string; readonly gatewayControlAvailable: boolean },
): string {
  const harnessPolicy = takeMossHarnessPolicyForProviderSession(state, {
    provider: PROVIDER,
    scopedGatewayConnectionAvailable: input.gatewayControlAvailable,
  });
  return [harnessPolicy, input.text].filter(Boolean).join("\n\n");
}

export const resolvePiStartInstanceId = resolveProviderSessionInstanceId;

/**
 * Enabled sessions retain direct routes to the hidden Computer specialists. Use this same
 * projection when comparing a rotated catalog with installed tools; sessions without an
 * advertised Computer tool get no family stubs.
 */
export function piInstalledGatewayToolNames(freshNames: Iterable<string>): Set<string> {
  const installed = new Set(freshNames);
  if (MOSS_COMPUTER_TOOL_NAMES.some((name) => installed.has(name))) {
    for (const name of MOSS_COMPUTER_TOOL_NAMES) installed.add(name);
  }
  return installed;
}

/**
 * Project the canonical MCP catalog into the descriptors the Moss Pi extension registers.
 * Schemas and execution both stay with the gateway; Pi only adapts the provider boundary.
 */
export async function buildPiAgentGatewayToolDescriptors(input: {
  readonly connection: AgentGatewayMcpConnection;
  readonly enableComputerControl?: boolean;
  readonly fetch?: AgentGatewayMcpFetch;
}): Promise<ReadonlyArray<MossPiGatewayToolDescriptor>> {
  const tools = await listAgentGatewayMcpTools({
    connection: input.connection,
    ...(input.fetch === undefined ? {} : { fetch: input.fetch }),
  });
  if (tools.length === 0) throw new Error("Moss MCP returned an empty tool catalog.");
  const catalog = new Map(tools.map((tool) => [tool.name, tool]));
  if (input.enableComputerControl === true) {
    // Always advertised by the shared Computer catalog. A help-only catalog must not
    // masquerade as observation and action support.
    const missing = [
      "computer_get_state",
      "computer_click",
      "computer_press_key",
      "computer_run",
    ].filter((name) => !catalog.has(name));
    if (missing.length > 0) {
      throw new Error(
        `Moss MCP catalog is missing required Computer tools: ${missing.join(", ")}.`,
      );
    }
  }
  return [...piInstalledGatewayToolNames(catalog.keys())].map((name) => {
    const tool = catalog.get(name);
    return {
      name,
      description:
        tool?.description ??
        (name.startsWith("computer_browser_")
          ? 'Read computer_help({topic:"browser"}) before calling. Gateway permissions apply.'
          : `Read computer_help({tool:"${name}"}) for arguments. Gateway permissions apply.`),
      inputSchema: tool?.inputSchema ?? { type: "object", properties: {} },
    };
  });
}

type PiBridgeContent =
  | { readonly type: "text"; readonly text: string }
  | { readonly type: "image"; readonly data: string; readonly mimeType: string };

/** Gateway `tools/call` result → the answer the extension returns to Pi. */
export function piGatewayBridgeResponse(result: unknown): MossPiBridgeResponse {
  if (isRecord(result) && result.isError === true) {
    const message = Array.isArray(result.content)
      ? result.content
          .flatMap((item) =>
            isRecord(item) && item.type === "text" && typeof item.text === "string"
              ? [item.text]
              : [],
          )
          .join("\n")
      : "";
    return { ok: false, error: message || "Moss gateway tool failed." };
  }
  const content =
    isRecord(result) && Array.isArray(result.content)
      ? result.content.flatMap((item): PiBridgeContent[] => {
          if (isRecord(item) && item.type === "text" && typeof item.text === "string") {
            return [{ type: "text", text: item.text }];
          }
          if (
            isRecord(item) &&
            item.type === "image" &&
            typeof item.data === "string" &&
            typeof item.mimeType === "string"
          ) {
            return [{ type: "image", data: item.data, mimeType: item.mimeType }];
          }
          return [];
        })
      : [];
  return {
    ok: true,
    content:
      content.length > 0 ? content : [{ type: "text", text: JSON.stringify(result ?? null) }],
    details: result,
  };
}

export function makePiRuntimeEventBase(
  context: {
    readonly lifecycleGeneration?: string;
    readonly session: Pick<ProviderSession, "threadId" | "providerInstanceId">;
    readonly activeTurnId: TurnId | undefined;
  },
  options?: { readonly includeTurnId?: boolean },
) {
  return {
    eventId: EventId.makeUnsafe(crypto.randomUUID()),
    provider: PROVIDER,
    ...(context.session.providerInstanceId !== undefined
      ? { providerInstanceId: context.session.providerInstanceId }
      : {}),
    threadId: context.session.threadId,
    createdAt: new Date().toISOString(),
    ...(context.lifecycleGeneration !== undefined
      ? { lifecycleGeneration: context.lifecycleGeneration }
      : {}),
    ...(options?.includeTurnId !== false && context.activeTurnId
      ? { turnId: context.activeTurnId }
      : {}),
  };
}

export interface PiUserInputOptionMapping {
  readonly value: string;
  readonly option: UserInputQuestion["options"][number];
}

function makePiUserInputOption(label: string): UserInputQuestion["options"][number] {
  const normalizedLabel = trimPiDisplayText(label) ?? "Option";
  return { label: normalizedLabel, description: normalizedLabel };
}

export function makePiUserInputOptions(
  labels: ReadonlyArray<string>,
): ReadonlyArray<PiUserInputOptionMapping> {
  const labelCounts = new Map<string, number>();
  return labels.map((label, index) => {
    const baseLabel = trimPiDisplayText(label) ?? `Option ${index + 1}`;
    const count = (labelCounts.get(baseLabel) ?? 0) + 1;
    labelCounts.set(baseLabel, count);
    const displayLabel = count === 1 ? baseLabel : `${baseLabel} (${count})`;
    return { value: label, option: { label: displayLabel, description: baseLabel } };
  });
}

function firstPiUserInputAnswer(
  answers: ProviderUserInputAnswers,
  questionId: string,
): string | undefined {
  const answer = answers[questionId];
  if (typeof answer === "string") return trimToUndefined(answer);
  if (Array.isArray(answer)) {
    return trimToUndefined(answer.find((entry) => typeof entry === "string"));
  }
  return undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
  return fallback;
}

function runtimeErrorDetail(cause: unknown): unknown {
  if (cause instanceof Error) {
    return {
      name: cause.name,
      message: cause.message,
      ...(cause.stack ? { stack: cause.stack } : {}),
    };
  }
  return cause;
}

/** The assistant outcome of one run: an error message, `undefined` for success, `null` unknown. */
export function piRunOutcome(messages: unknown): string | undefined | null {
  if (!Array.isArray(messages)) return null;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message: unknown = messages[index];
    if (!isRecord(message) || message.role !== "assistant") continue;
    if (message.stopReason === "error") {
      return (
        trimToUndefined(
          typeof message.errorMessage === "string" ? message.errorMessage : undefined,
        ) ?? "Pi turn failed."
      );
    }
    if (message.stopReason === "aborted") return "Request was aborted.";
    return undefined;
  }
  return null;
}

interface PiImage {
  readonly type: "image";
  readonly data: string;
  readonly mimeType: string;
}

interface PiStoredTurn {
  readonly id: TurnId;
  readonly items: unknown[];
  readonly toolItemIndexes: Map<string, number>;
  /** Entry id of this turn's first user message, the fork point for a rollback. */
  firstUserEntryId?: string;
}

interface PiTrackedToolCall {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly itemId: RuntimeItemId;
  readonly itemType: ReturnType<typeof piToolItemType>;
}

interface PiPendingUserInput {
  readonly resolve: (answers: ProviderUserInputAnswers) => void;
}

interface PiSessionContext extends MossHarnessPolicyDeliveryState {
  harnessPolicyDelivered?: boolean;
  readonly enableComputerControl?: boolean;
  /** Whether the CURRENT gateway rotation exposes Moss control; recomputed on rotation. */
  gatewayControlAvailable: boolean;
  /** Capability facts stashed at dispatch time; credential rotation consumes these. */
  gatewayCapabilityInput: AgentGatewayCapabilityInput;
  gatewaySessionLease?: AgentGatewaySessionLease;
  gatewayConnection?: AgentGatewayMcpConnection;
  gatewayToolNames: Set<string>;
  readonly gatewayToolsFile: string | undefined;
  readonly bridgeNonce: string | undefined;
  readonly lifecycleGeneration?: string;
  readonly rpc: PiRpcClient;
  readonly managed: boolean;
  session: ProviderSession;
  sessionFile: string | undefined;
  sessionId: string | undefined;
  model: PiRpcModel | undefined;
  thinkingLevel: string | undefined;
  turns: PiStoredTurn[];
  activeTurnId: TurnId | undefined;
  /** Prompts sent to Pi whose acceptance response has not arrived yet. */
  promptsInFlight: number;
  /** Between a "started" prompt response and the run's `agent_settled`. */
  runActive: boolean;
  /** An interrupt that landed before Pi committed the run; fired once it starts. */
  pendingAbortTurnId: TurnId | undefined;
  completingTurn: Promise<void> | undefined;
  activeTurnErrorMessage?: string;
  activeAssistantItemId: RuntimeItemId | undefined;
  activeReasoningItemId: RuntimeItemId | undefined;
  /** Role of the message being streamed: wire `message_update` records omit the message. */
  streamingMessageRole: string | undefined;
  activeToolItems: Map<string, PiTrackedToolCall>;
  pendingUserInputs: Map<ApprovalRequestId, PiPendingUserInput>;
  /** Last session entry Moss has seen; `get_entries` cursor. */
  lastEntryId: string | undefined;
  stopped: boolean;
  lastKnownTokenUsage: ThreadTokenUsageSnapshot | undefined;
  unsubscribe: (() => void) | undefined;
}

export interface PiAdapterLiveOptions {
  readonly nativeEventLogPath?: string;
  readonly nativeEventLogger?: EventNdjsonLogger;
  /** Test seam: replaces the platform spawn of the Pi CLI. */
  readonly spawnProcess?: PiRpcSpawn;
  readonly teardownProcessTree?: typeof teardownProviderProcessTree;
  readonly agentGatewayFetch?: AgentGatewayMcpFetch;
}

interface PiLaunchInput {
  readonly binaryPath?: string | undefined;
  readonly agentDir?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly cwd: string;
}

interface PiRpcSlashCommand {
  readonly name: string;
  readonly description?: string;
  readonly source: "extension" | "prompt" | "skill";
  readonly sourceInfo?: {
    readonly path?: string;
    readonly source?: string;
    readonly scope?: string;
  };
}

function resumeSessionFile(resumeCursor: unknown): string | undefined {
  if (typeof resumeCursor === "string") return trimToUndefined(resumeCursor);
  if (!isRecord(resumeCursor)) return undefined;
  for (const key of ["sessionFile", "sessionFilePath", "nativeHandle", "path"]) {
    const value = resumeCursor[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

const makePiAdapter = (options?: PiAdapterLiveOptions) =>
  Effect.gen(function* () {
    const serverConfig = yield* ServerConfig;
    const fileSystem = yield* FileSystem.FileSystem;
    const agentGatewayCredentials = Option.getOrUndefined(
      yield* Effect.serviceOption(AgentGatewayCredentials),
    );
    const runtimeEventQueue = yield* Queue.bounded<ProviderRuntimeEvent>(
      PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
    );
    const sessions = new Map<ThreadId, PiSessionContext>();
    /** Short-lived `pi --mode rpc --no-session` processes for model, skill and command lists. */
    const discoveryProcesses = new Set<PiRpcClient>();
    let adapterClosing = false;
    // Serializes session lifecycle and turn dispatch per thread.
    const dispatchLock = makeKeyedLock<ThreadId>();
    const ownsNativeEventLogger = options?.nativeEventLogger === undefined;
    const nativeEventLogger =
      options?.nativeEventLogger ??
      (options?.nativeEventLogPath !== undefined
        ? yield* makeEventNdjsonLogger(options.nativeEventLogPath, { stream: "native" })
        : undefined);
    const runtimeEventIngress = yield* makeBoundedCallbackIngress<
      SizedProviderRuntimeEvent,
      never,
      never
    >(
      (item) =>
        (nativeEventLogger && item.event.raw
          ? nativeEventLogger.write(item.event.raw, item.event.threadId).pipe(Effect.ignore)
          : Effect.void
        ).pipe(Effect.andThen(Queue.offer(runtimeEventQueue, item.event)), Effect.asVoid),
      {
        capacity: PROVIDER_ADAPTER_RUNTIME_EVENT_BUFFER_CAPACITY,
        maxBufferedBytes: PROVIDER_RUNTIME_CALLBACK_BUFFER_MAX_BYTES,
        terminalReserve: PROVIDER_RUNTIME_CALLBACK_TERMINAL_RESERVE,
        isTerminal: (item) => isTerminalProviderRuntimeEvent(item.event),
        sizeOf: (item) => item.bytes,
      },
    );

    const makeEventBase = makePiRuntimeEventBase;
    const offerRuntimeEvent = (event: ProviderRuntimeEvent) => {
      runtimeEventIngress.offer(compactProviderRuntimeEventForIngress(event));
    };

    const offerRuntimeError = (
      context: PiSessionContext,
      input: {
        readonly message: string;
        readonly cause?: unknown;
        readonly method: string;
        readonly messageType?: string;
      },
    ) => {
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: false }),
        type: "runtime.error",
        payload: {
          message: input.message,
          class: classifyPiRuntimeError(input.message),
          ...(input.cause !== undefined ? { detail: runtimeErrorDetail(input.cause) } : {}),
        },
        raw: {
          source: "pi.rpc.event",
          method: input.method,
          ...(input.messageType ? { messageType: input.messageType } : {}),
          payload: input.cause ?? { message: input.message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const offerRuntimeWarning = (
      context: PiSessionContext,
      input: {
        readonly message: string;
        readonly method: string;
        readonly messageType?: string;
        readonly detail?: unknown;
        readonly includeTurnId?: boolean;
      },
    ) => {
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: input.includeTurnId ?? true }),
        type: "runtime.warning",
        payload: { message: input.message, detail: input.detail ?? { method: input.method } },
        raw: {
          source: "pi.rpc.event",
          method: input.method,
          ...(input.messageType ? { messageType: input.messageType } : {}),
          payload: input.detail ?? { message: input.message },
        },
      } satisfies ProviderRuntimeEvent);
    };

    const extensionFile = () => ensureMossPiExtensionFile(serverConfig.stateDir);

    /**
     * The environment one Pi process runs with: the instance account boundary, Pi's config
     * folder, the managed Moss catalog, and the per-session bridge values. Everything Moss
     * adds under MOSS_ is read once by the Moss extension and removed from Pi's environment.
     */
    const buildPiEnvironment = (
      input: PiLaunchInput,
      extra: Readonly<Record<string, string>> = {},
    ): {
      readonly env: NodeJS.ProcessEnv;
      readonly managed: boolean;
      readonly sessionDir?: string;
    } => {
      const managedConfig = readMossManagedPiConfig(input.environment);
      const storage = makePiStoragePaths({
        agentDir: input.agentDir,
        environment: input.environment,
        instanceId: input.instanceId,
        stateDir: serverConfig.stateDir,
        homeDir: serverConfig.homeDir,
      });
      const baseEnv = buildProviderProcessEnv({
        driver: PROVIDER,
        env: process.env,
        ...(input.environment !== undefined ? { environment: input.environment } : {}),
        ...(input.instanceId !== undefined ? { instanceId: input.instanceId } : {}),
        homeDir: serverConfig.homeDir,
        isolationRootDir: serverConfig.stateDir,
      });
      const managedToken = managedConfig
        ? input.environment?.[MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY]?.trim()
        : undefined;
      const overrides: Record<string, string> = {
        // Moss shows Pi updates itself; Pi's own check would only reach pi.dev.
        PI_SKIP_VERSION_CHECK: "1",
        ...(storage.agentDir ? { PI_CODING_AGENT_DIR: storage.agentDir } : {}),
        ...(managedConfig && managedToken
          ? {
              PI_OFFLINE: "1",
              [MOSS_MANAGED_PI_CONFIG_ENV_KEY]: JSON.stringify(managedConfig),
              [MOSS_MANAGED_PI_CREDENTIAL_ENV_KEY]: managedToken,
            }
          : {}),
        ...extra,
      };
      const env = buildProviderChildEnvironment({
        provider: PROVIDER,
        baseEnv,
        overrides,
        inheritedMossKeys: Object.keys(overrides).filter((key) => key.startsWith("MOSS_")),
      });
      return {
        env,
        managed: managedConfig !== undefined,
        ...(storage.sessionDir ? { sessionDir: storage.sessionDir } : {}),
      };
    };

    const spawnPi = (input: {
      readonly launch: PiLaunchInput;
      readonly args: ReadonlyArray<string>;
      readonly env: NodeJS.ProcessEnv;
      readonly lowerPriority: boolean;
    }) =>
      startPiRpcClient({
        binaryPath: trimToUndefined(input.launch.binaryPath) ?? DEFAULT_PI_BINARY,
        args: input.args,
        cwd: input.launch.cwd,
        env: input.env,
        lowerPriority: input.lowerPriority,
        ...(options?.spawnProcess ? { spawnProcess: options.spawnProcess } : {}),
        ...(options?.teardownProcessTree
          ? { teardownProcessTree: options.teardownProcessTree }
          : {}),
      });

    /** A short-lived `pi --mode rpc --no-session` for model, skill and command discovery. */
    const withPiDiscoveryProcess = async <A>(
      launch: PiLaunchInput,
      run: (rpc: PiRpcClient, managed: boolean, env: NodeJS.ProcessEnv) => Promise<A>,
    ): Promise<A> => {
      const extension = await extensionFile();
      const { env, managed } = buildPiEnvironment(launch);
      if (adapterClosing) throw new Error("Moss is shutting down.");
      const rpc = spawnPi({
        launch,
        args: ["--mode", "rpc", "--no-session", "-e", extension],
        env,
        lowerPriority: true,
      });
      // Tracked so a listing still running when Moss exits cannot keep the backend alive.
      discoveryProcesses.add(rpc);
      try {
        await rpc.request({ type: "get_state" }, { timeoutMs: PI_STARTUP_TIMEOUT_MS });
        return await run(rpc, managed, env);
      } finally {
        await rpc.close({ graceMs: 1_000 }).catch(() => undefined);
        discoveryProcesses.delete(rpc);
      }
    };

    const closeDiscoveryProcesses = Effect.promise(async () => {
      adapterClosing = true;
      await Promise.all(
        Array.from(discoveryProcesses, (rpc) => rpc.close({ graceMs: 0 }).catch(() => undefined)),
      );
    });

    const listAvailableModels = async (
      rpc: PiRpcClient,
      managed: boolean,
    ): Promise<ReadonlyArray<PiRpcModel>> => {
      const data = await rpc.request<{ models?: ReadonlyArray<unknown> }>({
        type: "get_available_models",
      });
      const models = (Array.isArray(data?.models) ? data.models : []).filter(
        (model): model is PiRpcModel =>
          isRecord(model) && typeof model.id === "string" && typeof model.provider === "string",
      );
      // The Moss account lane offers only the Moss catalog.
      return models.filter((model) => !managed || model.provider === "moss");
    };

    // ── User input (Pi extension dialogs) ─────────────────────────

    const requestPiUserInput = (
      context: PiSessionContext,
      input: {
        readonly method: string;
        readonly question: UserInputQuestion;
        readonly timeoutMs?: number;
        readonly rawPayload?: Record<string, unknown>;
      },
    ): Promise<ProviderUserInputAnswers> => {
      if (context.stopped) return Promise.resolve({});
      const requestId = ApprovalRequestId.makeUnsafe(crypto.randomUUID());
      const runtimeRequestId = RuntimeRequestId.makeUnsafe(requestId);
      return new Promise((resolve) => {
        let settled = false;
        let timeoutId: ReturnType<typeof setTimeout> | undefined;
        const finish = (answers: ProviderUserInputAnswers) => {
          if (settled) return;
          settled = true;
          if (timeoutId !== undefined) clearTimeout(timeoutId);
          context.pendingUserInputs.delete(requestId);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "user-input.resolved",
            requestId: runtimeRequestId,
            payload: { answers },
            raw: {
              source: "pi.rpc.event",
              method: `${input.method}/answered`,
              payload: { requestId, answers },
            },
          } satisfies ProviderRuntimeEvent);
          resolve(answers);
        };
        context.pendingUserInputs.set(requestId, { resolve: finish });
        // Pi resolves a timed dialog itself; close Moss's question at the same moment.
        if (typeof input.timeoutMs === "number" && input.timeoutMs > 0) {
          timeoutId = setTimeout(() => finish({}), input.timeoutMs);
        }
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "user-input.requested",
          requestId: runtimeRequestId,
          payload: { questions: [input.question] },
          raw: {
            source: "pi.rpc.event",
            method: input.method,
            payload: input.rawPayload ?? { requestId, question: input.question },
          },
        } satisfies ProviderRuntimeEvent);
      });
    };

    const answerPiDialog = (
      context: PiSessionContext,
      id: string,
      response: Record<string, unknown>,
    ) => context.rpc.write({ type: "extension_ui_response", id, ...response });

    const runGatewayBridgeCall = async (
      context: PiSessionContext,
      id: string,
      title: unknown,
      payload: unknown,
    ) => {
      const request = parseMossPiBridgeRequest(title, payload, context.bridgeNonce);
      const connection = context.gatewayConnection;
      let response: MossPiBridgeResponse;
      if (!request) {
        response = { ok: false, error: "Moss could not read this tool call." };
      } else if (!connection || !context.gatewayToolNames.has(request.name)) {
        response = { ok: false, error: "Moss tools are not available in this session." };
      } else {
        try {
          response = piGatewayBridgeResponse(
            await callAgentGatewayMcpTool({
              connection,
              name: request.name,
              arguments: request.arguments,
              ...(options?.agentGatewayFetch === undefined
                ? {}
                : { fetch: options.agentGatewayFetch }),
            }),
          );
        } catch (cause) {
          response = { ok: false, error: toMessage(cause, "Moss gateway tool failed.") };
        }
      }
      answerPiDialog(context, id, { value: JSON.stringify(response) });
    };

    const handleExtensionUiRequest = (context: PiSessionContext, record: PiRpcRecord) => {
      const id = typeof record.id === "string" ? record.id : undefined;
      const method = typeof record.method === "string" ? record.method : "";
      if (!id) return;
      if (isMossPiBridgeTitle(record.title)) {
        if (method === "input") {
          void runGatewayBridgeCall(context, id, record.title, record.placeholder);
        } else {
          answerPiDialog(context, id, { cancelled: true });
        }
        return;
      }
      const title = typeof record.title === "string" ? record.title : undefined;
      const timeoutMs = typeof record.timeout === "number" ? record.timeout : undefined;
      switch (method) {
        case "select": {
          const labels = Array.isArray(record.options)
            ? record.options.filter((option): option is string => typeof option === "string")
            : [];
          const mappings = makePiUserInputOptions(labels);
          void requestPiUserInput(context, {
            method: "extension/ui/select",
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            question: {
              id: "selection",
              header: trimPiDisplayText(title) ?? "Pi plugin",
              question: trimPiDisplayText(title) ?? "Choose an option.",
              options: mappings.map((mapping) => mapping.option),
            },
            rawPayload: { title, options: labels },
          }).then((answers) => {
            const answer = firstPiUserInputAnswer(answers, "selection");
            const value = mappings.find((mapping) => mapping.option.label === answer)?.value;
            answerPiDialog(context, id, value === undefined ? { cancelled: true } : { value });
          });
          return;
        }
        case "confirm": {
          const message = typeof record.message === "string" ? record.message : undefined;
          void requestPiUserInput(context, {
            method: "extension/ui/confirm",
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            question: {
              id: "confirmation",
              header: trimPiDisplayText(title) ?? "Pi plugin",
              question:
                trimPiDisplayText(message) ?? trimPiDisplayText(title) ?? "Confirm this action?",
              options: [makePiUserInputOption("Yes"), makePiUserInputOption("No")],
            },
            rawPayload: { title, message },
          }).then((answers) =>
            answerPiDialog(context, id, {
              confirmed: firstPiUserInputAnswer(answers, "confirmation") === "Yes",
            }),
          );
          return;
        }
        case "input":
        case "editor": {
          const hint =
            typeof record.placeholder === "string"
              ? record.placeholder
              : typeof record.prefill === "string"
                ? record.prefill
                : undefined;
          void requestPiUserInput(context, {
            method: `extension/ui/${method}`,
            ...(timeoutMs !== undefined ? { timeoutMs } : {}),
            question: {
              id: "input",
              header: trimPiDisplayText(title) ?? "Pi plugin",
              question: trimPiDisplayText(hint) ?? trimPiDisplayText(title) ?? "Type a response.",
              options: [],
            },
            rawPayload: { title, placeholder: hint },
          }).then((answers) => {
            const value = firstPiUserInputAnswer(answers, "input");
            answerPiDialog(context, id, value === undefined ? { cancelled: true } : { value });
          });
          return;
        }
        case "notify": {
          const normalized = trimPiDisplayText(
            typeof record.message === "string" ? record.message : undefined,
          );
          if (!normalized) return;
          offerRuntimeWarning(context, {
            message: normalized,
            method: "extension/ui/notify",
            detail: { type: record.notifyType ?? "info" },
          });
          return;
        }
        // Terminal chrome (status, widgets, titles, editor text) has no place in Moss.
        default:
          return;
      }
    };

    // ── Turn lifecycle ────────────────────────────────────────────

    const completeMessageItems = (
      context: PiSessionContext,
      failed: boolean,
      raw: ProviderRuntimeEvent["raw"],
    ) => {
      if (context.activeAssistantItemId) {
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "item.completed",
          payload: {
            itemType: "assistant_message",
            status: failed ? "failed" : "completed",
            title: "Assistant",
          },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
      if (context.activeReasoningItemId) {
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "item.completed",
          payload: {
            itemType: "reasoning",
            status: failed ? "failed" : "completed",
            title: "Reasoning",
          },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
      context.activeAssistantItemId = undefined;
      context.activeReasoningItemId = undefined;
    };

    const makeSessionSnapshot = (context: PiSessionContext): ProviderSession => {
      const model = piModelSlug(context.model);
      return {
        provider: PROVIDER,
        ...(context.session.providerInstanceId
          ? { providerInstanceId: context.session.providerInstanceId }
          : {}),
        status: context.stopped ? "closed" : context.activeTurnId ? "running" : "ready",
        runtimeMode: context.session.runtimeMode,
        threadId: context.session.threadId,
        createdAt: context.session.createdAt,
        updatedAt: new Date().toISOString(),
        ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
        ...(model ? { model } : {}),
        ...(context.sessionFile ? { resumeCursor: context.sessionFile } : {}),
        ...(context.activeTurnId ? { activeTurnId: context.activeTurnId } : {}),
        ...(context.session.lastError ? { lastError: context.session.lastError } : {}),
      };
    };

    const turnStartedPayload = (context: PiSessionContext) => {
      const model = piModelSlug(context.model);
      return {
        ...(model ? { model } : {}),
        ...(context.thinkingLevel ? { effort: context.thinkingLevel } : {}),
      };
    };

    const readSessionStats = async (context: PiSessionContext) =>
      context.rpc
        .request<PiRpcSessionStats>(
          { type: "get_session_stats" },
          { timeoutMs: PI_BOOKKEEPING_TIMEOUT_MS },
        )
        .catch(() => undefined);

    /** Advances the entry cursor; returns the first user message entry since the last read. */
    const readNewEntries = async (context: PiSessionContext) => {
      const data = await context.rpc
        .request<{ entries?: ReadonlyArray<unknown> }>(
          { type: "get_entries", ...(context.lastEntryId ? { since: context.lastEntryId } : {}) },
          { timeoutMs: PI_BOOKKEEPING_TIMEOUT_MS },
        )
        .catch(() => undefined);
      const entries = (Array.isArray(data?.entries) ? data.entries : []).filter(isRecord);
      const last = entries.at(-1);
      if (last && typeof last.id === "string") context.lastEntryId = last.id;
      const firstUser = entries.find(
        (entry) =>
          entry.type === "message" && isRecord(entry.message) && entry.message.role === "user",
      );
      return typeof firstUser?.id === "string" ? firstUser.id : undefined;
    };

    /**
     * Reinstall the Moss gateway tools against the rotated credential when the per-rotation
     * catalog differs. The extension re-reads the catalog file on its sync command: added
     * tools register at once and removed ones are withdrawn.
     */
    const resyncPiGatewayTools = (context: PiSessionContext): void => {
      const lease = context.gatewaySessionLease;
      const connection = context.gatewayConnection;
      const toolsFile = context.gatewayToolsFile;
      if (!lease || !connection || !toolsFile) return;
      const threadId = context.session.threadId;
      const current = () =>
        !context.stopped &&
        sessions.get(threadId) === context &&
        context.gatewaySessionLease === lease &&
        context.gatewayConnection === connection;
      Effect.runFork(
        Effect.promise(async () => {
          if (!current()) return;
          const fetchOptions =
            options?.agentGatewayFetch === undefined ? {} : { fetch: options.agentGatewayFetch };
          let freshNames: Set<string>;
          try {
            const catalog = await listAgentGatewayMcpTools({ connection, ...fetchOptions });
            freshNames = piInstalledGatewayToolNames(catalog.map((tool) => tool.name));
          } catch {
            // Catalog unreadable: the installed tools stay valid through the rotated bearer.
            return;
          }
          const installed = context.gatewayToolNames;
          if (
            installed.size === freshNames.size &&
            [...freshNames].every((name) => installed.has(name))
          ) {
            return;
          }
          let descriptors: ReadonlyArray<MossPiGatewayToolDescriptor>;
          try {
            descriptors = await buildPiAgentGatewayToolDescriptors({
              connection,
              enableComputerControl: context.enableComputerControl === true,
              ...fetchOptions,
            });
          } catch (cause) {
            // Rotation must never silently drop computer:*: keep the installed tools.
            offerRuntimeWarning(context, {
              message:
                "Pi could not refresh the Moss gateway tool catalog after rotation; keeping the previous tools.",
              method: "gateway/rotate",
              includeTurnId: false,
              detail: { method: "gateway/rotate", cause: toMessage(cause, "refresh failed") },
            });
            return;
          }
          if (!current()) return;
          await writeMossPiGatewayToolsFile(toolsFile, descriptors);
          // Applied only while Pi is idle; the next turn picks the file up otherwise.
          if (context.activeTurnId !== undefined) return;
          await context.rpc.request({
            type: "prompt",
            message: `/${MOSS_PI_GATEWAY_SYNC_COMMAND}`,
          });
          context.gatewayToolNames = new Set(descriptors.map((tool) => tool.name));
          context.gatewayControlAvailable = context.gatewayToolNames.size > 0;
        }).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("pi.agent_gateway.tool_resync_failed", { threadId, cause }),
          ),
        ),
      );
    };

    const finishTurn = (
      context: PiSessionContext,
      turnId: TurnId,
      errorMessage: string | undefined,
      cause?: unknown,
    ): Promise<void> => {
      if (context.stopped || context.activeTurnId !== turnId) return Promise.resolve();
      if (context.completingTurn) return context.completingTurn;
      const completion = (async () => {
        if (context.pendingAbortTurnId === turnId) context.pendingAbortTurnId = undefined;
        const raw = { source: "pi.rpc.event" as const, method: "prompt", payload: cause ?? {} };
        const [stats, firstUserEntryId] = await Promise.all([
          readSessionStats(context),
          readNewEntries(context),
        ]);
        if (context.stopped || context.activeTurnId !== turnId) return;
        const turn = context.turns.find((candidate) => candidate.id === turnId);
        if (turn && firstUserEntryId && !turn.firstUserEntryId) {
          turn.firstUserEntryId = firstUserEntryId;
        }
        const usage = stats
          ? normalizePiTokenUsage(stats, context.model?.contextWindow)
          : undefined;
        if (usage) context.lastKnownTokenUsage = usage;
        const failure = errorMessage ? classifyPiTurnFailure(errorMessage) : undefined;
        completeMessageItems(context, Boolean(errorMessage), raw);
        if (usage) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.token-usage.updated",
            payload: { usage },
            raw,
          } satisfies ProviderRuntimeEvent);
        }
        if (errorMessage && failure?.state === "failed") {
          offerRuntimeError(context, { message: errorMessage, method: "prompt", cause });
        }
        const completionBase = makeEventBase(context);
        if (context.gatewaySessionLease && context.gatewayConnection) {
          const outgoingLease = context.gatewaySessionLease;
          const drainage = outgoingLease.retireTurn(turnId);
          outgoingLease.release();
          // The replacement derives from the facts stashed at dispatch time, not the start
          // snapshot and not a fresh derivation.
          const replacementLease = acquireAgentGatewaySessionLease(
            agentGatewayCredentials,
            context.session.threadId,
            PROVIDER,
            context.gatewayCapabilityInput,
          );
          if (replacementLease) {
            context.gatewaySessionLease = replacementLease;
            // Bridge calls read this object, so the rotated bearer applies at once.
            Object.assign(context.gatewayConnection, replacementLease.connection);
            context.gatewayControlAvailable = true;
          } else {
            delete context.gatewaySessionLease;
            delete context.gatewayConnection;
            context.gatewayControlAvailable = false;
            offerRuntimeEvent({
              ...makeEventBase(context, { includeTurnId: false }),
              turnId: TurnId.makeUnsafe(crypto.randomUUID()),
              type: "runtime.error",
              payload: {
                message:
                  "Pi could not rotate the Moss gateway credential after the turn; Moss tools are unavailable until the session restarts.",
                class: classifyPiRuntimeError("gateway credential rotation failed"),
              },
              raw: { source: "pi.rpc.event", method: "gateway/rotate", payload: { turnId } },
            } satisfies ProviderRuntimeEvent);
          }
          Effect.runFork(
            Effect.promise(() => drainage).pipe(
              Effect.catchCause((drainCause) =>
                Effect.logWarning("pi.agent_gateway.turn_retirement_failed", {
                  turnId,
                  cause: drainCause,
                }),
              ),
            ),
          );
        }
        context.activeTurnId = undefined;
        delete context.activeTurnErrorMessage;
        context.activeAssistantItemId = undefined;
        context.activeReasoningItemId = undefined;
        context.activeToolItems.clear();
        context.session = makeSessionSnapshot(context);
        offerRuntimeEvent({
          ...completionBase,
          type: "turn.completed",
          payload:
            errorMessage && failure
              ? {
                  state: failure.state,
                  stopReason: failure.stopReason,
                  errorMessage,
                  ...(stats ? { usage: stats } : {}),
                }
              : { state: "completed", stopReason: null, ...(stats ? { usage: stats } : {}) },
          raw,
        } satisfies ProviderRuntimeEvent);
        if (context.gatewaySessionLease) resyncPiGatewayTools(context);
      })().finally(() => {
        if (context.completingTurn === completion) context.completingTurn = undefined;
      });
      context.completingTurn = completion;
      return completion;
    };

    /** Settles the active turn once Pi has no run and no prompt awaiting its answer. */
    const maybeFinishActiveTurn = (context: PiSessionContext) => {
      const turnId = context.activeTurnId;
      if (turnId === undefined || context.runActive || context.promptsInFlight > 0) return;
      void finishTurn(context, turnId, context.activeTurnErrorMessage);
    };

    const missingSignInMessage = (context: PiSessionContext, message: string) =>
      (context.model ? piMissingModelSignInIssue(message, context.model) : null) ?? message;

    const abortPiRun = async (context: PiSessionContext) => {
      // Otherwise Pi starts a queued continuation after the abort.
      await context.rpc.request({ type: "clear_queue" }, { timeoutMs: PI_BOOKKEEPING_TIMEOUT_MS });
      await context.rpc.request({ type: "abort" }, { timeoutMs: PI_ABORT_TIMEOUT_MS });
    };

    /**
     * Sends one prompt. `behavior` queues it into a running run (Pi starts a run when idle).
     * Pi answers once preflight passes and before that run's first event.
     */
    const sendPiPrompt = (
      context: PiSessionContext,
      turnId: TurnId,
      text: string,
      images: ReadonlyArray<PiImage>,
      behavior?: "steer" | "followUp",
    ) => {
      context.promptsInFlight += 1;
      void context.rpc
        .request<{ disposition?: string }>(
          {
            type: "prompt",
            message: text,
            ...(images.length > 0 ? { images } : {}),
            ...(behavior ? { streamingBehavior: behavior } : {}),
          },
          { timeoutMs: PI_PROMPT_ACCEPT_TIMEOUT_MS },
        )
        .then(
          (data) => {
            context.promptsInFlight -= 1;
            if (data?.disposition === "started") {
              context.runActive = true;
              if (context.pendingAbortTurnId === turnId) {
                void abortPiRun(context).catch((cause) =>
                  offerRuntimeError(context, {
                    message: toMessage(cause, "Failed to interrupt Pi turn."),
                    method: "turn/interrupt",
                    cause,
                  }),
                );
              }
            }
            maybeFinishActiveTurn(context);
          },
          (cause) => {
            context.promptsInFlight -= 1;
            const message = missingSignInMessage(context, toMessage(cause, "Pi turn failed."));
            if (behavior && context.runActive) {
              // A queued message Pi refused; the running turn continues.
              offerRuntimeWarning(context, {
                message,
                method: `turn/${behavior}`,
                detail: { message },
              });
              return;
            }
            context.activeTurnErrorMessage ??= message;
            maybeFinishActiveTurn(context);
          },
        );
    };

    const recordItem = (context: PiSessionContext, item: unknown, toolCallId?: string) => {
      const turn = context.activeTurnId
        ? context.turns.find((candidate) => candidate.id === context.activeTurnId)
        : context.turns.at(-1);
      if (!turn) return;
      if (toolCallId !== undefined) {
        const index = turn.toolItemIndexes.get(toolCallId);
        if (index !== undefined) {
          const previous = turn.items[index];
          turn.items[index] =
            isRecord(previous) && isRecord(item) ? { ...previous, ...item } : item;
          return;
        }
        turn.toolItemIndexes.set(toolCallId, turn.items.length);
      }
      turn.items.push(item);
    };

    const handleMessageUpdate = (context: PiSessionContext, record: PiRpcRecord) => {
      if (context.streamingMessageRole !== "assistant") return;
      const update = isRecord(record.assistantMessageEvent)
        ? record.assistantMessageEvent
        : undefined;
      if (!update || typeof update.delta !== "string") return;
      const delta = update.delta;
      const contentIndex = typeof update.contentIndex === "number" ? update.contentIndex : 0;
      const raw = { source: "pi.rpc.event" as const, messageType: record.type, payload: record };
      if (update.type === "text_delta") {
        if (!context.activeAssistantItemId) {
          context.activeAssistantItemId = RuntimeItemId.makeUnsafe(
            `pi-assistant-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeAssistantItemId,
            type: "item.started",
            payload: { itemType: "assistant_message", status: "inProgress", title: "Assistant" },
            raw,
          } satisfies ProviderRuntimeEvent);
        }
        recordItem(context, { type: "assistant_message", delta });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeAssistantItemId,
          type: "content.delta",
          payload: { streamKind: "assistant_text", delta, contentIndex },
          raw,
        } satisfies ProviderRuntimeEvent);
        return;
      }
      if (update.type === "thinking_delta") {
        if (!context.activeReasoningItemId) {
          context.activeReasoningItemId = RuntimeItemId.makeUnsafe(
            `pi-reasoning-${crypto.randomUUID()}`,
          );
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: context.activeReasoningItemId,
            type: "item.started",
            payload: { itemType: "reasoning", status: "inProgress", title: "Reasoning" },
            raw,
          } satisfies ProviderRuntimeEvent);
        }
        recordItem(context, { type: "reasoning", delta });
        offerRuntimeEvent({
          ...makeEventBase(context),
          itemId: context.activeReasoningItemId,
          type: "content.delta",
          payload: { streamKind: "reasoning_text", delta, contentIndex },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
    };

    const handleToolStart = (context: PiSessionContext, record: PiRpcRecord) => {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      // Nested calls (codemode scripts) are reported by their calling tool.
      if (!toolCallId || typeof record.parentToolCallId === "string") return;
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const tracked: PiTrackedToolCall = {
        toolCallId,
        toolName,
        args: record.args,
        itemId: RuntimeItemId.makeUnsafe(`pi-tool-${toolCallId}`),
        itemType: piToolItemType(toolName),
      };
      context.activeToolItems.set(toolCallId, tracked);
      recordItem(
        context,
        { type: "tool_call", callId: toolCallId, status: "started", toolName, args: record.args },
        toolCallId,
      );
      offerRuntimeEvent({
        ...makeEventBase(context),
        itemId: tracked.itemId,
        providerRefs: { providerItemId: ProviderItemId.makeUnsafe(toolCallId) },
        type: "item.started",
        payload: {
          itemType: tracked.itemType,
          status: "inProgress",
          title: piToolTitle(toolName, record.args),
          data: piToolLifecycleData({ toolCallId, toolName, args: record.args }),
        },
        raw: { source: "pi.rpc.event", messageType: record.type, payload: record },
      } satisfies ProviderRuntimeEvent);
    };

    const handleToolUpdate = (context: PiSessionContext, record: PiRpcRecord) => {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      const tracked = toolCallId ? context.activeToolItems.get(toolCallId) : undefined;
      if (!toolCallId || !tracked) return;
      const detail = textFromToolResult(record.partialResult);
      recordItem(
        context,
        {
          type: "tool_call",
          callId: toolCallId,
          status: "updated",
          toolName: tracked.toolName,
          args: tracked.args,
          output: detail,
        },
        toolCallId,
      );
      offerRuntimeEvent({
        ...makeEventBase(context),
        itemId: tracked.itemId,
        providerRefs: { providerItemId: ProviderItemId.makeUnsafe(toolCallId) },
        type: "item.updated",
        payload: {
          itemType: tracked.itemType,
          status: "inProgress",
          title: piToolTitle(tracked.toolName, tracked.args),
          ...(detail ? { detail } : {}),
          data: piToolLifecycleData({
            toolCallId,
            toolName: tracked.toolName,
            args: tracked.args,
            partialResult: record.partialResult,
          }),
        },
        raw: { source: "pi.rpc.event", messageType: record.type, payload: record },
      } satisfies ProviderRuntimeEvent);
    };

    const handleToolEnd = (context: PiSessionContext, record: PiRpcRecord) => {
      const toolCallId = typeof record.toolCallId === "string" ? record.toolCallId : undefined;
      if (!toolCallId || typeof record.parentToolCallId === "string") return;
      const toolName = typeof record.toolName === "string" ? record.toolName : "tool";
      const tracked = context.activeToolItems.get(toolCallId) ?? {
        toolCallId,
        toolName,
        args: undefined,
        itemId: RuntimeItemId.makeUnsafe(`pi-tool-${toolCallId}`),
        itemType: piToolItemType(toolName),
      };
      context.activeToolItems.delete(toolCallId);
      const isError = record.isError === true;
      const detail = textFromToolResult(record.result);
      recordItem(
        context,
        {
          type: "tool_call",
          callId: toolCallId,
          status: isError ? "failed" : "completed",
          toolName: tracked.toolName,
          ...(tracked.args !== undefined ? { args: tracked.args } : {}),
          output: detail,
          result: record.result,
        },
        toolCallId,
      );
      offerRuntimeEvent({
        ...makeEventBase(context),
        itemId: tracked.itemId,
        providerRefs: { providerItemId: ProviderItemId.makeUnsafe(toolCallId) },
        type: "item.completed",
        payload: {
          itemType: tracked.itemType,
          status: isError ? "failed" : "completed",
          title: piToolTitle(tracked.toolName, tracked.args),
          ...(detail ? { detail } : {}),
          data: piToolLifecycleData({
            toolCallId,
            toolName: tracked.toolName,
            args: tracked.args,
            result: record.result,
            isError,
          }),
        },
        raw: { source: "pi.rpc.event", messageType: record.type, payload: record },
      } satisfies ProviderRuntimeEvent);
    };

    const handleRecord = (context: PiSessionContext, record: PiRpcRecord) => {
      if (context.stopped) return;
      const raw = { source: "pi.rpc.event" as const, messageType: record.type, payload: record };
      switch (record.type) {
        case "extension_ui_request":
          handleExtensionUiRequest(context, record);
          return;
        case "agent_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.state.changed",
            payload: { state: "active" },
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        case "turn_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "turn.started",
            payload: turnStartedPayload(context),
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        case "message_start": {
          const message = isRecord(record.message) ? record.message : undefined;
          context.streamingMessageRole =
            typeof message?.role === "string" ? message.role : undefined;
          return;
        }
        case "message_update":
          handleMessageUpdate(context, record);
          return;
        case "message_end": {
          const message = isRecord(record.message) ? record.message : undefined;
          context.streamingMessageRole = undefined;
          if (message?.role === "assistant") {
            completeMessageItems(
              context,
              message.stopReason === "error" || message.stopReason === "aborted",
              raw,
            );
          }
          return;
        }
        case "thinking_level_changed":
          if (typeof record.level === "string") context.thinkingLevel = record.level;
          return;
        case "tool_execution_start":
          handleToolStart(context, record);
          return;
        case "tool_execution_update":
          handleToolUpdate(context, record);
          return;
        case "tool_execution_end":
          handleToolEnd(context, record);
          return;
        case "compaction_start":
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`),
            type: "item.updated",
            payload: {
              itemType: "context_compaction",
              status: "inProgress",
              title: "Compacting context",
            },
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        case "compaction_end":
          offerRuntimeEvent({
            ...makeEventBase(context),
            itemId: RuntimeItemId.makeUnsafe(`pi-compaction-${crypto.randomUUID()}`),
            type: "item.completed",
            payload: {
              itemType: "context_compaction",
              status: record.aborted === true || !record.result ? "failed" : "completed",
              title: "Context compacted",
              data: record,
            },
            raw,
          } satisfies ProviderRuntimeEvent);
          return;
        case "agent_end": {
          // This run's outcome; retries and queued continuations may still follow.
          const outcome = piRunOutcome(record.messages);
          if (outcome === undefined) delete context.activeTurnErrorMessage;
          else if (outcome !== null) context.activeTurnErrorMessage = outcome;
          return;
        }
        case "auto_retry_start": {
          const delayMs = typeof record.delayMs === "number" ? record.delayMs : 0;
          const delaySecs = delayMs / 1000;
          offerRuntimeWarning(context, {
            message: `Pi retrying after provider error (attempt ${String(record.attempt)}/${String(record.maxAttempts)}, retrying in ${delaySecs.toFixed(delaySecs < 10 ? 1 : 0)}s): ${String(record.errorMessage ?? "")}`,
            method: "prompt/retry",
            messageType: record.type,
            detail: record,
          });
          return;
        }
        case "auto_retry_end":
          if (record.success !== true && typeof record.finalError === "string") {
            context.activeTurnErrorMessage = record.finalError;
          }
          return;
        case "agent_settled":
          context.runActive = false;
          if (record.aborted === true && !context.activeTurnErrorMessage) {
            context.activeTurnErrorMessage = "Request was aborted.";
          }
          maybeFinishActiveTurn(context);
          return;
        case "extension_error":
          offerRuntimeWarning(context, {
            message: `A Pi extension failed: ${String(record.error ?? "unknown error")}`,
            method: "extension/error",
            messageType: record.type,
            detail: record,
          });
          return;
        default:
          return;
      }
    };

    const handleUnexpectedExit = (context: PiSessionContext, exit: PiRpcExit) => {
      if (context.stopped) return;
      const stderr = context.rpc.stderrTail().trim().slice(-2_000);
      const message = exit.spawnError
        ? `Pi could not start: ${exit.spawnError.message}`
        : `Pi stopped unexpectedly${exit.code !== null ? ` (exit code ${exit.code})` : ""}.${stderr ? ` ${stderr}` : ""}`;
      const turnId = context.activeTurnId;
      context.stopped = true;
      context.unsubscribe?.();
      for (const pending of Array.from(context.pendingUserInputs.values())) pending.resolve({});
      context.pendingUserInputs.clear();
      const raw = { source: "pi.rpc.event" as const, method: "exit", payload: exit };
      completeMessageItems(context, true, raw);
      if (turnId) {
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.completed",
          payload: { state: "failed", stopReason: "error", errorMessage: message },
          raw,
        } satisfies ProviderRuntimeEvent);
      }
      offerRuntimeError(context, { message, method: "process/exit", cause: exit });
      context.activeTurnId = undefined;
      void Effect.runPromise(cancelAgentGatewayTurn(context.gatewaySessionLease, turnId)).finally(
        () => {
          context.gatewaySessionLease?.release();
          delete context.gatewaySessionLease;
        },
      );
      if (sessions.get(context.session.threadId) === context) {
        sessions.delete(context.session.threadId);
      }
      // Pi's own children must not outlive it.
      void context.rpc.close({ graceMs: 0 }).catch(() => undefined);
      offerRuntimeEvent({
        ...makeEventBase(context, { includeTurnId: false }),
        type: "session.exited",
        payload: { reason: message, exitKind: "error", recoverable: true },
      } satisfies ProviderRuntimeEvent);
    };

    const removeSessionFiles = async (toolsFile: string | undefined) => {
      if (!toolsFile) return;
      await rm(path.dirname(toolsFile), { recursive: true, force: true }).catch(() => undefined);
    };

    const disposeSessionContext = async (context: PiSessionContext) => {
      try {
        await Effect.runPromise(
          cancelAgentGatewayTurn(context.gatewaySessionLease, context.activeTurnId),
        );
        context.unsubscribe?.();
        context.unsubscribe = undefined;
        for (const pending of Array.from(context.pendingUserInputs.values())) pending.resolve({});
        context.pendingUserInputs.clear();
        context.stopped = true;
        // Closing stdin asks Pi to dispose its runtime; the tree teardown proves it is gone.
        await context.rpc.close();
      } finally {
        context.gatewaySessionLease?.release();
        delete context.gatewaySessionLease;
        await removeSessionFiles(context.gatewayToolsFile);
      }
    };

    const requireSession = Effect.fn("PiAdapter.requireSession")(function* (threadId: ThreadId) {
      const context = sessions.get(threadId);
      if (!context) {
        return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
      }
      if (context.stopped) {
        return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
      }
      return context;
    });

    const piRequest = <T>(
      context: PiSessionContext,
      method: string,
      command: { readonly type: string } & Readonly<Record<string, unknown>>,
      requestOptions?: { readonly timeoutMs?: number },
    ) =>
      Effect.tryPromise({
        try: () => context.rpc.request<T>(command, requestOptions),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method,
            detail: toMessage(cause, `Pi could not ${command.type}.`),
            cause,
          }),
      });

    const resolveModelForSelection = (context: PiSessionContext, modelId: string) =>
      Effect.gen(function* () {
        const parsed = parsePiModelReference(modelId);
        if (!parsed) return undefined;
        if (parsed.provider) return { provider: parsed.provider, id: parsed.id };
        const models = yield* Effect.tryPromise({
          try: () => listAvailableModels(context.rpc, context.managed),
          catch: (cause) =>
            new ProviderAdapterRequestError({
              provider: PROVIDER,
              method: "model/list",
              detail: toMessage(cause, "Failed to list Pi models."),
              cause,
            }),
        });
        const found = findPiModel(models, modelId);
        return found ? { provider: found.provider, id: found.id } : undefined;
      });

    const applyPiModelSelection = (
      context: PiSessionContext,
      selection: {
        readonly model?: string | undefined;
        readonly thinkingLevel?: string | undefined;
      },
    ) =>
      Effect.gen(function* () {
        const requested = trimToUndefined(selection.model);
        if (requested && requested !== piModelSlug(context.model)) {
          const target = yield* resolveModelForSelection(context, requested);
          if (!target) {
            return yield* new ProviderAdapterValidationError({
              provider: PROVIDER,
              operation: "model/set",
              issue: `Pi model '${requested}' is not available. Use a model Pi lists, or add it to Pi's models.json.`,
            });
          }
          const model = yield* Effect.tryPromise({
            try: () =>
              context.rpc.request<unknown>({
                type: "set_model",
                provider: target.provider,
                modelId: target.id,
              }),
            catch: (cause) => {
              const message = toMessage(cause, "Failed to set Pi model.");
              const missingSignIn = piMissingModelSignInIssue(message, { id: target.id });
              // Pi refused before anything was sent: a validation error keeps the chat usable.
              return missingSignIn || /model not found/iu.test(message)
                ? new ProviderAdapterValidationError({
                    provider: PROVIDER,
                    operation: "model/set",
                    issue: missingSignIn ?? `Pi model '${requested}' is not available: ${message}`,
                    cause,
                  })
                : new ProviderAdapterRequestError({
                    provider: PROVIDER,
                    method: "model/set",
                    detail: message,
                    cause,
                  });
            },
          });
          context.model =
            isRecord(model) && typeof model.id === "string" && typeof model.provider === "string"
              ? (model as unknown as PiRpcModel)
              : { provider: target.provider, id: target.id };
        }
        const thinkingLevel = normalizePiThinkingLevel(selection.thinkingLevel);
        if (thinkingLevel && thinkingLevel !== context.thinkingLevel) {
          yield* piRequest(context, "thinking/set", {
            type: "set_thinking_level",
            level: thinkingLevel,
          });
          context.thinkingLevel = thinkingLevel;
        }
        context.session = makeSessionSnapshot(context);
      });

    const buildPromptPayload = (input: {
      readonly input?: string | undefined;
      readonly attachments?: ReadonlyArray<ChatAttachment> | undefined;
    }) =>
      Effect.gen(function* () {
        const text =
          appendFileAttachmentsPromptBlock({
            text: input.input,
            attachments: input.attachments,
            attachmentsDir: serverConfig.attachmentsDir,
            include: "all-files",
          }) ?? "";
        const images = yield* Effect.forEach(
          input.attachments ?? [],
          (attachment) =>
            Effect.gen(function* () {
              if (attachment.type !== "image" || !attachment.mimeType) return undefined;
              const attachmentPath = resolveProviderAttachmentPath({
                attachmentsDir: serverConfig.attachmentsDir,
                attachment,
              });
              if (!attachmentPath) {
                return yield* new ProviderAdapterValidationError({
                  provider: PROVIDER,
                  operation: "turn/start",
                  issue: `Invalid attachment id '${attachment.id}'.`,
                });
              }
              const bytes = yield* fileSystem.readFile(attachmentPath).pipe(
                Effect.mapError(
                  (cause) =>
                    new ProviderAdapterRequestError({
                      provider: PROVIDER,
                      method: "turn/start",
                      detail: toMessage(cause, "Failed to read attachment file."),
                      cause,
                    }),
                ),
              );
              return {
                type: "image" as const,
                data: Buffer.from(bytes).toString("base64"),
                mimeType: attachment.mimeType,
              };
            }),
          { concurrency: 1 },
        );
        return {
          text,
          images: images.filter((image): image is PiImage => image !== undefined),
        };
      });

    const buildProviderText = (context: PiSessionContext, text: string) =>
      buildPiTurnPrompt(context, {
        text,
        gatewayControlAvailable: context.gatewayControlAvailable,
      });

    const busyError = (operation: string) =>
      new ProviderAdapterValidationError({
        provider: PROVIDER,
        operation,
        issue: "A Pi turn is already active for this thread.",
      });

    const dispatchResult = (context: PiSessionContext, turnId: TurnId) => ({
      threadId: context.session.threadId,
      turnId,
      ...(context.sessionFile ? { resumeCursor: context.sessionFile } : {}),
    });

    /** A turn whose run settled but whose bookkeeping is still running finishes first. */
    const awaitTurnBookkeeping = (context: PiSessionContext) => {
      const pending = context.completingTurn;
      return pending === undefined
        ? Effect.void
        : Effect.promise(() => pending).pipe(Effect.uninterruptible);
    };

    const beginTurn = (context: PiSessionContext) => {
      const turnId = TurnId.makeUnsafe(crypto.randomUUID());
      context.activeTurnId = turnId;
      delete context.activeTurnErrorMessage;
      context.turns.push({ id: turnId, items: [], toolItemIndexes: new Map() });
      context.session = makeSessionSnapshot(context);
      return turnId;
    };

    const runPiReload = (context: PiSessionContext, turnId: TurnId, command: string) =>
      Effect.gen(function* () {
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.started",
          payload: turnStartedPayload(context),
          raw: { source: "pi.rpc.event", method: "reload", payload: { command } },
        } satisfies ProviderRuntimeEvent);
        const failed = yield* piRequest(context, "session/reload", {
          type: "prompt",
          message: `/${MOSS_PI_RELOAD_COMMAND}`,
        }).pipe(
          Effect.as(undefined),
          Effect.catch((error) => Effect.succeed(error)),
        );
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "turn.completed",
          payload: failed
            ? { state: "failed", stopReason: "error", errorMessage: failed.message }
            : { state: "completed", stopReason: "reload" },
          raw: { source: "pi.rpc.event", method: "reload", payload: failed ?? { command } },
        } satisfies ProviderRuntimeEvent);
        if (failed) {
          offerRuntimeError(context, {
            message: failed.message,
            method: "session/reload",
            cause: failed,
          });
        }
        yield* cancelAgentGatewayTurn(context.gatewaySessionLease, turnId);
        if (context.activeTurnId === turnId) context.activeTurnId = undefined;
        context.session = makeSessionSnapshot(context);
        if (failed) return yield* Effect.fail(failed);
      });

    // ── Session start ─────────────────────────────────────────────

    const startSessionUnlocked = (
      input: Parameters<PiAdapterShape["startSession"]>[0],
      providerInstanceId: ProviderSession["providerInstanceId"],
    ) =>
      Effect.gen(function* () {
        if (adapterClosing) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/start",
            detail: "Moss is shutting down.",
          });
        }
        const cwd = trimToUndefined(input.cwd) ?? serverConfig.cwd;
        const piOptions = input.providerOptions?.pi;
        const launch: PiLaunchInput = {
          binaryPath: piOptions?.binaryPath,
          agentDir: piOptions?.agentDir,
          environment: piOptions?.environment,
          instanceId: providerInstanceId,
          cwd,
        };
        const requestedSessionFile = resumeSessionFile(input.resumeCursor);
        // A session file that no longer exists starts a fresh Pi session.
        const sessionFileExists = requestedSessionFile
          ? yield* fileSystem
              .exists(requestedSessionFile)
              .pipe(Effect.catch(() => Effect.succeed(false)))
          : false;
        const sessionFile = sessionFileExists ? requestedSessionFile : undefined;
        const modelSelection =
          input.modelSelection?.provider === "pi" ? input.modelSelection : undefined;

        const existingContext = sessions.get(input.threadId);
        if (existingContext) {
          yield* Effect.tryPromise({
            try: () => disposeSessionContext(existingContext),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/restart",
                detail: toMessage(cause, "Failed to stop the previous Pi session."),
                cause,
              }),
          });
          if (sessions.get(input.threadId) === existingContext) sessions.delete(input.threadId);
        }

        const startFailure = (detail: string, cause?: unknown) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "session/start",
            detail,
            ...(cause !== undefined ? { cause } : {}),
          });

        const agentGatewaySessionLease = acquireAgentGatewaySessionLease(
          agentGatewayCredentials,
          input.threadId,
          PROVIDER,
          input,
        );
        const agentGatewayConnection = agentGatewaySessionLease?.connection;
        if (input.enableComputerControl === true && !agentGatewayConnection) {
          return yield* startFailure(
            "Computer Use could not start because Pi did not receive a thread-scoped Moss gateway connection.",
          );
        }
        const gatewayTools: ReadonlyArray<MossPiGatewayToolDescriptor> = agentGatewayConnection
          ? yield* releaseAgentGatewaySessionLeaseOnInterrupt(
              agentGatewaySessionLease,
              Effect.tryPromise({
                try: () =>
                  buildPiAgentGatewayToolDescriptors({
                    connection: agentGatewayConnection,
                    enableComputerControl: input.enableComputerControl === true,
                    ...(options?.agentGatewayFetch === undefined
                      ? {}
                      : { fetch: options.agentGatewayFetch }),
                  }),
                catch: (cause) => cause,
              }),
            ).pipe(
              Effect.catch((cause) =>
                Effect.sync(() => agentGatewaySessionLease?.release()).pipe(
                  Effect.andThen(
                    input.enableComputerControl === true
                      ? Effect.fail(
                          startFailure(
                            `Computer Use could not start because Pi could not install Moss gateway tools: ${toMessage(cause, "Gateway setup failed.")}`,
                            cause,
                          ),
                        )
                      : Effect.logWarning(
                          "Pi could not install thread-scoped Moss gateway tools",
                          cause,
                        ),
                  ),
                  Effect.as([] as ReadonlyArray<MossPiGatewayToolDescriptor>),
                ),
              ),
            )
          : [];
        const gatewayControlAvailable = gatewayTools.length > 0;
        if (!gatewayControlAvailable) agentGatewaySessionLease?.release();
        const releaseLease = Effect.sync(() => agentGatewaySessionLease?.release());

        const sessionKey = crypto.randomUUID();
        const bridgeNonce = gatewayControlAvailable ? crypto.randomUUID() : undefined;
        const gatewayToolsFile = gatewayControlAvailable
          ? path.join(serverConfig.stateDir, "pi-sessions", sessionKey, "gateway-tools.json")
          : undefined;
        const lowerPriority = yield* providerProcessPriorityEnabled;

        const prepared = yield* Effect.tryPromise({
          try: async () => {
            const extension = await extensionFile();
            if (gatewayToolsFile) await writeMossPiGatewayToolsFile(gatewayToolsFile, gatewayTools);
            const { env, managed, sessionDir } = buildPiEnvironment(launch, {
              ...(bridgeNonce ? { [MOSS_PI_BRIDGE_ENV_KEY]: bridgeNonce } : {}),
              ...(gatewayToolsFile
                ? { [MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY]: gatewayToolsFile }
                : {}),
            });
            const sessionArgs = sessionFile
              ? ["--session", sessionFile]
              : sessionDir
                ? ["--session-dir", sessionDir]
                : [];
            return { env, managed, args: ["--mode", "rpc", "-e", extension, ...sessionArgs] };
          },
          catch: (cause) =>
            startFailure(toMessage(cause, "Failed to prepare the Pi session."), cause),
        }).pipe(
          Effect.tapError(() =>
            releaseLease.pipe(
              Effect.andThen(Effect.promise(() => removeSessionFiles(gatewayToolsFile))),
            ),
          ),
        );

        const rpc = spawnPi({ launch, args: prepared.args, env: prepared.env, lowerPriority });
        const now = new Date().toISOString();
        const context: PiSessionContext = {
          enableComputerControl: input.enableComputerControl === true,
          gatewayCapabilityInput: captureAgentGatewayCapabilityInput(input),
          ...(input.lifecycleGeneration !== undefined
            ? { lifecycleGeneration: input.lifecycleGeneration }
            : {}),
          gatewayControlAvailable,
          ...(gatewayControlAvailable && agentGatewaySessionLease && agentGatewayConnection
            ? {
                gatewaySessionLease: agentGatewaySessionLease,
                gatewayConnection: agentGatewayConnection,
              }
            : {}),
          gatewayToolNames: new Set(gatewayTools.map((tool) => tool.name)),
          gatewayToolsFile,
          bridgeNonce,
          rpc,
          managed: prepared.managed,
          session: {
            provider: PROVIDER,
            ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
            status: "ready",
            runtimeMode: input.runtimeMode,
            cwd,
            threadId: input.threadId,
            createdAt: now,
            updatedAt: now,
          },
          sessionFile,
          sessionId: undefined,
          model: undefined,
          thinkingLevel: undefined,
          turns: [],
          activeTurnId: undefined,
          promptsInFlight: 0,
          runActive: false,
          pendingAbortTurnId: undefined,
          completingTurn: undefined,
          activeAssistantItemId: undefined,
          activeReasoningItemId: undefined,
          streamingMessageRole: undefined,
          activeToolItems: new Map(),
          pendingUserInputs: new Map(),
          lastEntryId: undefined,
          stopped: false,
          lastKnownTokenUsage: undefined,
          unsubscribe: undefined,
        };
        context.unsubscribe = rpc.onRecord((record) => handleRecord(context, record));

        const startup = Effect.gen(function* () {
          const state = yield* Effect.tryPromise({
            try: () =>
              rpc.request<PiRpcSessionState>(
                { type: "get_state" },
                { timeoutMs: PI_STARTUP_TIMEOUT_MS },
              ),
            catch: (cause) =>
              startFailure(
                toMessage(cause, "Pi did not start. Check that Pi runs from a terminal."),
                cause,
              ),
          });
          context.sessionFile = trimToUndefined(state?.sessionFile) ?? context.sessionFile;
          context.sessionId = trimToUndefined(state?.sessionId);
          context.model =
            state?.model && isRecord(state.model) && typeof state.model.id === "string"
              ? state.model
              : undefined;
          context.thinkingLevel = trimToUndefined(state?.thinkingLevel);
          // Resumed history is not a new turn's first user message.
          yield* Effect.promise(() => readNewEntries(context));
          if (modelSelection) {
            yield* applyPiModelSelection(context, {
              model: modelSelection.model,
              thinkingLevel: modelSelection.options?.thinkingLevel,
            });
          } else if (context.managed && context.model?.provider !== "moss") {
            const models = yield* Effect.tryPromise({
              try: () => listAvailableModels(rpc, true),
              catch: (cause) =>
                startFailure(toMessage(cause, "Pi could not list Moss models."), cause),
            });
            const first = piModelSlug(models[0]);
            if (first) yield* applyPiModelSelection(context, { model: first });
          }
        });
        yield* startup.pipe(
          Effect.tapError(() =>
            Effect.promise(async () => {
              context.stopped = true;
              context.unsubscribe?.();
              await rpc.close({ graceMs: 0 }).catch(() => undefined);
              await removeSessionFiles(gatewayToolsFile);
            }).pipe(Effect.andThen(releaseLease)),
          ),
        );

        sessions.set(input.threadId, context);
        void rpc.exited.then((exit) => handleUnexpectedExit(context, exit));
        context.session = makeSessionSnapshot(context);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "session.started",
          payload: {
            message: "Pi session started",
            ...(context.sessionFile ? { resume: context.sessionFile } : {}),
          },
        } satisfies ProviderRuntimeEvent);
        offerRuntimeEvent({
          ...makeEventBase(context),
          type: "thread.started",
          payload: { providerThreadId: context.sessionId ?? sessionKey },
        } satisfies ProviderRuntimeEvent);
        const stats = yield* Effect.promise(() => readSessionStats(context));
        const initialUsage = stats
          ? normalizePiTokenUsage(stats, context.model?.contextWindow)
          : undefined;
        context.lastKnownTokenUsage = initialUsage;
        if (initialUsage) {
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.token-usage.updated",
            payload: { usage: initialUsage },
          } satisfies ProviderRuntimeEvent);
        }
        return context.session;
      });

    const startSession: PiAdapterShape["startSession"] = (input) =>
      dispatchLock.withLock(
        input.threadId,
        startSessionUnlocked(input, resolvePiStartInstanceId(input)),
      );

    // ── Turns ─────────────────────────────────────────────────────

    const sendTurn: PiAdapterShape["sendTurn"] = (input) =>
      dispatchLock.withLock(
        input.threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          // Snapshot the session's computer-control fact for the turn being dispatched.
          context.gatewayCapabilityInput = captureAgentGatewayCapabilityInput({
            enableComputerControl: context.enableComputerControl === true,
          });
          if (
            context.pendingAbortTurnId !== undefined &&
            context.pendingAbortTurnId === context.activeTurnId
          ) {
            return yield* busyError("sendTurn");
          }
          yield* awaitTurnBookkeeping(context);
          if (input.modelSelection?.provider === "pi") {
            const selection: PiModelSelection = input.modelSelection;
            yield* applyPiModelSelection(context, {
              model: selection.model,
              thinkingLevel: selection.options?.thinkingLevel,
            });
          }
          const payload = yield* buildPromptPayload(input);
          if (context.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          const isReload = payload.images.length === 0 && isPiReloadCommand(payload.text);
          const liveTurnId = context.activeTurnId;
          if (liveTurnId !== undefined) {
            // A turn is active: queue the message into its run as a follow-up.
            if (context.pendingAbortTurnId === liveTurnId || isReload) {
              return yield* busyError("sendTurn");
            }
            sendPiPrompt(
              context,
              liveTurnId,
              buildProviderText(context, payload.text),
              payload.images,
              "followUp",
            );
            return dispatchResult(context, liveTurnId);
          }
          const turnId = beginTurn(context);
          if (isReload) {
            yield* runPiReload(context, turnId, payload.text);
            return dispatchResult(context, turnId);
          }
          sendPiPrompt(context, turnId, buildProviderText(context, payload.text), payload.images);
          return dispatchResult(context, turnId);
        }),
      );

    const steerTurn: NonNullable<PiAdapterShape["steerTurn"]> = (input) =>
      dispatchLock.withLock(
        input.threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(input.threadId);
          context.gatewayCapabilityInput = captureAgentGatewayCapabilityInput({
            enableComputerControl: context.enableComputerControl === true,
          });
          if (
            context.pendingAbortTurnId !== undefined &&
            context.pendingAbortTurnId === context.activeTurnId
          ) {
            return yield* busyError("steerTurn");
          }
          yield* awaitTurnBookkeeping(context);
          const payload = yield* buildPromptPayload(input);
          if (context.stopped) {
            return yield* new ProviderAdapterSessionClosedError({
              provider: PROVIDER,
              threadId: input.threadId,
            });
          }
          const providerText = buildProviderText(context, payload.text);
          const joinedTurnId = context.activeTurnId;
          if (joinedTurnId !== undefined) {
            sendPiPrompt(context, joinedTurnId, providerText, payload.images, "steer");
            return dispatchResult(context, joinedTurnId);
          }
          const turnId = beginTurn(context);
          sendPiPrompt(context, turnId, providerText, payload.images);
          return dispatchResult(context, turnId);
        }),
      );

    const interruptTurn: PiAdapterShape["interruptTurn"] = (threadId, turnId) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        if (turnId !== undefined && turnId !== context.activeTurnId) {
          yield* Effect.logWarning("pi.stale_interrupt_ignored", {
            threadId,
            requestedTurnId: turnId,
            activeTurnId: context.activeTurnId,
          });
          return;
        }
        const activeTurnId = turnId ?? context.activeTurnId;
        // Before Pi commits the run there is nothing for abort to reach: defer it to the
        // prompt's acceptance, and abort now anyway in case preflight is compacting.
        if (activeTurnId !== undefined && !context.runActive && context.promptsInFlight > 0) {
          context.pendingAbortTurnId = activeTurnId;
        }
        yield* withAgentGatewayTurnCancellation(
          context.gatewaySessionLease,
          activeTurnId,
          Effect.tryPromise({
            try: () => abortPiRun(context),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "turn/interrupt",
                detail: toMessage(cause, "Failed to interrupt Pi turn."),
                cause,
              }),
          }),
        );
      });

    const respondToUserInput: PiAdapterShape["respondToUserInput"] = (
      threadId,
      requestId,
      answers,
    ) =>
      Effect.gen(function* () {
        const context = yield* requireSession(threadId);
        const pending = context.pendingUserInputs.get(requestId);
        if (!pending) {
          return yield* new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "user-input/respond",
            detail: `Unknown pending Pi user-input request: ${requestId}`,
          });
        }
        pending.resolve(answers);
      });

    const stopSession: PiAdapterShape["stopSession"] = (threadId) =>
      dispatchLock.withLock(
        threadId,
        Effect.gen(function* () {
          const context = sessions.get(threadId);
          if (!context) return;
          yield* Effect.tryPromise({
            try: () => disposeSessionContext(context),
            catch: (cause) =>
              new ProviderAdapterRequestError({
                provider: PROVIDER,
                method: "session/stop",
                detail: toMessage(cause, "Failed to stop Pi session."),
                cause,
              }),
          });
          if (sessions.get(threadId) === context) sessions.delete(threadId);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "thread.state.changed",
            payload: { state: "closed", detail: { reason: "stopped" } },
          } satisfies ProviderRuntimeEvent);
          offerRuntimeEvent({
            ...makeEventBase(context),
            type: "session.exited",
            payload: { reason: "stopped", exitKind: "graceful" },
          } satisfies ProviderRuntimeEvent);
        }),
      );

    const listSessions: PiAdapterShape["listSessions"] = () =>
      Effect.sync(() => Array.from(sessions.values()).map(makeSessionSnapshot));

    const hasSession: PiAdapterShape["hasSession"] = (threadId) =>
      Effect.sync(() => sessions.has(threadId));

    const snapshotThread = (context: PiSessionContext) =>
      Effect.gen(function* () {
        const data = yield* piRequest<{ messages?: ReadonlyArray<unknown> }>(
          context,
          "thread/read",
          { type: "get_messages" },
        ).pipe(Effect.catch(() => Effect.succeed(undefined)));
        const historyItems = mapPiMessageHistory(
          Array.isArray(data?.messages) ? data.messages : [],
        );
        const activeTurn = context.activeTurnId
          ? context.turns.find((turn) => turn.id === context.activeTurnId)
          : undefined;
        const turns = [
          ...(historyItems.length > 0
            ? [
                {
                  id: TurnId.makeUnsafe(
                    `pi-history-${context.sessionId ?? context.session.threadId}`,
                  ),
                  items: historyItems,
                },
              ]
            : []),
          ...(activeTurn ? [{ id: activeTurn.id, items: [...activeTurn.items] }] : []),
        ];
        return {
          threadId: context.session.threadId,
          ...(context.session.cwd ? { cwd: context.session.cwd } : {}),
          turns:
            turns.length > 0
              ? turns
              : context.turns.map((turn) => ({ id: turn.id, items: [...turn.items] })),
        } satisfies ProviderThreadSnapshot;
      });

    const readThread: PiAdapterShape["readThread"] = (threadId) =>
      requireSession(threadId).pipe(Effect.flatMap(snapshotThread));

    const rollbackThread: PiAdapterShape["rollbackThread"] = (threadId, numTurns) =>
      dispatchLock.withLock(
        threadId,
        Effect.gen(function* () {
          const context = yield* requireSession(threadId);
          if (context.activeTurnId !== undefined) return yield* busyError("rollbackThread");
          const nextLength = Math.max(0, context.turns.length - Math.max(0, numTurns));
          if (nextLength < context.turns.length) {
            const forkPoint = context.turns[nextLength]?.firstUserEntryId;
            if (forkPoint) {
              // A fork from the first removed turn's user message keeps everything before it.
              yield* piRequest(context, "thread/rollback", { type: "fork", entryId: forkPoint });
            } else if (nextLength === 0) {
              yield* piRequest(context, "thread/rollback", { type: "new_session" });
            }
            const state = yield* piRequest<PiRpcSessionState>(context, "thread/rollback", {
              type: "get_state",
            });
            context.sessionFile = trimToUndefined(state?.sessionFile) ?? context.sessionFile;
            context.sessionId = trimToUndefined(state?.sessionId) ?? context.sessionId;
            context.lastEntryId = undefined;
            yield* Effect.promise(() => readNewEntries(context));
          }
          context.turns.splice(nextLength);
          context.session = makeSessionSnapshot(context);
          return yield* snapshotThread(context);
        }),
      );

    const compactThread: NonNullable<PiAdapterShape["compactThread"]> = (threadId) =>
      requireSession(threadId).pipe(
        Effect.flatMap((context) =>
          piRequest(
            context,
            "thread/compact",
            { type: "compact" },
            { timeoutMs: PI_COMPACT_TIMEOUT_MS },
          ),
        ),
        Effect.asVoid,
      );

    const stopAll: PiAdapterShape["stopAll"] = () =>
      settleConcurrentTeardowns(sessions.keys(), stopSession);

    // ── Discovery ─────────────────────────────────────────────────

    const discoveryLaunch = (input: {
      readonly binaryPath?: string | undefined;
      readonly agentDir?: string | undefined;
      readonly environment?: Readonly<Record<string, string>> | undefined;
      readonly instanceId?: string | undefined;
      readonly cwd?: string | undefined;
    }): PiLaunchInput => ({
      binaryPath: input.binaryPath,
      agentDir: input.agentDir,
      environment: input.environment,
      instanceId: input.instanceId,
      cwd: trimToUndefined(input.cwd) ?? serverConfig.cwd,
    });

    const listModels: NonNullable<PiAdapterShape["listModels"]> = (input) =>
      Effect.tryPromise({
        try: () =>
          withPiDiscoveryProcess(discoveryLaunch(input), async (rpc, managed, env) => {
            const models = (await listAvailableModels(rpc, managed)).flatMap((model) => {
              const descriptor = toPiProviderModelDescriptor(model);
              return descriptor ? [descriptor] : [];
            });
            // Only a default the person chose in Pi's settings; the Moss lane has none.
            const defaultModel = managed
              ? undefined
              : await readPiSettingsDefaultModel(piAgentDirOf(env));
            // A models.json Pi could not read is the person's setup, not an empty catalog.
            const loadError = models.length === 0 && rpc.stderrTail().trim().length > 0;
            return {
              models,
              ...(defaultModel && models.some((model) => model.slug === defaultModel)
                ? { defaultModel }
                : {}),
              source: "pi.rpc",
              cached: false,
              ...(loadError ? { error: "Pi could not read its model settings." } : {}),
            } satisfies ProviderListModelsResult;
          }),
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "model/list",
            detail: toMessage(cause, "Failed to list Pi models."),
            cause,
          }),
      });

    /** `get_commands` on the thread's live Pi when it has one, else on a discovery process. */
    const readPiCommands = async (input: {
      readonly threadId?: string | undefined;
      readonly forceReload?: boolean | undefined;
      readonly launch: PiLaunchInput;
    }): Promise<ReadonlyArray<PiRpcSlashCommand>> => {
      const active = input.threadId ? sessions.get(ThreadId.makeUnsafe(input.threadId)) : undefined;
      const read = async (rpc: PiRpcClient) => {
        const data = await rpc.request<{ commands?: ReadonlyArray<unknown> }>({
          type: "get_commands",
        });
        return (Array.isArray(data?.commands) ? data.commands : []).filter(
          (command): command is PiRpcSlashCommand =>
            isRecord(command) &&
            typeof command.name === "string" &&
            !MOSS_PI_INTERNAL_COMMANDS.has(command.name),
        );
      };
      if (active && !active.stopped) {
        if (input.forceReload && active.activeTurnId === undefined) {
          await active.rpc.request({ type: "prompt", message: `/${MOSS_PI_RELOAD_COMMAND}` });
        }
        return read(active.rpc);
      }
      return withPiDiscoveryProcess(input.launch, (rpc) => read(rpc));
    };

    const listSkills: NonNullable<PiAdapterShape["listSkills"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const commands = await readPiCommands({
            threadId: input.threadId,
            forceReload: input.forceReload,
            launch: discoveryLaunch(input),
          });
          return {
            skills: commands
              .filter((command) => command.source === "skill")
              .map((command) => {
                const description = trimToUndefined(command.description);
                const scope = trimToUndefined(command.sourceInfo?.source);
                return {
                  name: command.name.replace(/^skill:/u, ""),
                  ...(description ? { description } : {}),
                  path: trimToUndefined(command.sourceInfo?.path) ?? command.name,
                  enabled: true,
                  ...(scope ? { scope } : {}),
                };
              }),
            source: "pi.rpc",
            cached: false,
          } satisfies ProviderListSkillsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "skill/list",
            detail: toMessage(cause, "Failed to list Pi skills."),
            cause,
          }),
      });

    const listCommands: NonNullable<PiAdapterShape["listCommands"]> = (input) =>
      Effect.tryPromise({
        try: async () => {
          const commands = await readPiCommands({
            threadId: input.threadId,
            forceReload: input.forceReload,
            launch: discoveryLaunch(input),
          });
          const fallback: Record<PiRpcSlashCommand["source"], string> = {
            extension: "Extension command",
            prompt: "Prompt template",
            skill: "Skill",
          };
          return {
            commands: [
              {
                name: "reload",
                description: "Reload Pi extensions, skills, prompts, themes, tools, and settings",
              },
              ...commands.map((command) => ({
                name: command.name,
                description:
                  trimToUndefined(command.description) ?? fallback[command.source] ?? "Command",
              })),
            ],
            source: "pi.rpc",
            cached: false,
          } satisfies ProviderListCommandsResult;
        },
        catch: (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "command/list",
            detail: toMessage(cause, "Failed to list Pi commands."),
            cause,
          }),
      });

    const getComposerCapabilities: NonNullable<PiAdapterShape["getComposerCapabilities"]> = () =>
      Effect.succeed({
        provider: PROVIDER,
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsThreadCompaction: true,
        supportsThreadImport: false,
      } satisfies ProviderComposerCapabilities);

    yield* Effect.addFinalizer(() =>
      closeDiscoveryProcesses.pipe(
        Effect.andThen(stopAll()),
        Effect.orDie,
        Effect.andThen(runtimeEventIngress.stop),
        Effect.ensuring(
          ownsNativeEventLogger && nativeEventLogger
            ? nativeEventLogger.close().pipe(Effect.ignore)
            : Effect.void,
        ),
        Effect.ensuring(Queue.shutdown(runtimeEventQueue)),
      ),
    );

    return {
      provider: PROVIDER,
      capabilities: {
        sessionModelSwitch: "in-session",
        supportsSkillMentions: true,
        supportsSkillDiscovery: true,
        supportsNativeSlashCommandDiscovery: true,
        supportsPluginMentions: false,
        supportsPluginDiscovery: false,
        supportsRuntimeModelList: true,
        supportsTurnSteering: true,
      },
      startSession,
      sendTurn,
      steerTurn,
      interruptTurn,
      respondToRequest: (threadId) =>
        Effect.fail(
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "request/respond",
            detail: `Pi does not expose Moss approval requests for thread ${threadId}.`,
          }),
        ),
      respondToUserInput,
      stopSession,
      listSessions,
      hasSession,
      readThread,
      rollbackThread,
      compactThread,
      stopAll,
      listModels,
      listSkills,
      listCommands,
      getComposerCapabilities,
      get streamEvents() {
        return Stream.fromQueue(runtimeEventQueue);
      },
    } satisfies PiAdapterShape;
  });

export function makePiAdapterLive(options?: PiAdapterLiveOptions) {
  return Layer.effect(PiAdapter, makePiAdapter(options));
}
