// FILE: piProtocolMapping.ts
// Purpose: Pure mappings from Pi RPC records (models, messages, tool events, session stats)
//          onto Moss's provider contract. No process or Effect code lives here.
// Layer: Provider (Pi)

import path from "node:path";

import type { ProviderListModelsResult, ThreadTokenUsageSnapshot } from "@moss/contracts";
import { stripTerminalControlSequences } from "@moss/shared/text";

import { providerIsolatedHomePath } from "../providerProcessEnv.ts";
import { clampUsagePercent, nonNegativeFiniteNumber, positiveFiniteNumber } from "../tokenUsage.ts";

const PROVIDER = "pi" as const;

export type PiThinkingLevel = "off" | "minimal" | "low" | "medium" | "high" | "xhigh" | "max";

export const DEFAULT_PI_THINKING_LEVEL: PiThinkingLevel = "medium";

const PI_THINKING_OPTIONS: ReadonlyArray<{
  readonly value: PiThinkingLevel;
  readonly label: string;
  readonly description: string;
}> = [
  { value: "off", label: "Off", description: "No extra reasoning" },
  { value: "minimal", label: "Minimal", description: "Light reasoning" },
  { value: "low", label: "Low", description: "Faster reasoning" },
  { value: "medium", label: "Medium", description: "Balanced reasoning" },
  { value: "high", label: "High", description: "Deeper reasoning" },
  { value: "xhigh", label: "Extra High", description: "Extra-high reasoning" },
  { value: "max", label: "Max", description: "Maximum reasoning" },
];
const PI_DEFAULT_SUPPORTED_THINKING_LEVELS = new Set<PiThinkingLevel>([
  "off",
  "minimal",
  "low",
  "medium",
  "high",
]);

/** The part of Pi's `Model` object Moss reads. Pi returns the full configured definition. */
export interface PiRpcModel {
  readonly id: string;
  readonly name?: string;
  readonly provider: string;
  readonly reasoning?: boolean;
  readonly thinkingLevelMap?: Readonly<Record<string, string | null | undefined>>;
  readonly contextWindow?: number;
  readonly input?: ReadonlyArray<string>;
}

/** `get_session_stats` data. */
export interface PiRpcSessionStats {
  readonly sessionFile?: string;
  readonly sessionId?: string;
  readonly tokens: {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
    readonly total: number;
  };
  readonly cost?: number;
  readonly contextUsage?: {
    readonly tokens: number | null;
    readonly contextWindow: number;
    readonly percent: number | null;
  };
}

/** `get_state` data. */
export interface PiRpcSessionState {
  readonly model?: PiRpcModel;
  readonly thinkingLevel?: string;
  readonly isStreaming?: boolean;
  readonly sessionFile?: string;
  readonly sessionId?: string;
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

export function trimToUndefined(value: string | null | undefined): string | undefined {
  const trimmed = typeof value === "string" ? value.trim() : "";
  return trimmed.length > 0 ? trimmed : undefined;
}

export function trimPiDisplayText(value: string | undefined): string | undefined {
  return value === undefined ? undefined : trimToUndefined(stripTerminalControlSequences(value));
}

export function isPiThinkingLevel(value: string | null | undefined): value is PiThinkingLevel {
  return PI_THINKING_OPTIONS.some((option) => option.value === value);
}

export function normalizePiThinkingLevel(
  value: string | null | undefined,
): PiThinkingLevel | undefined {
  return isPiThinkingLevel(value) ? value : undefined;
}

// Mirrors Pi's clamping so discovery does not advertise levels Pi would ignore.
export function getPiSupportedThinkingOptions(
  model: Pick<PiRpcModel, "reasoning" | "thinkingLevelMap">,
): ReadonlyArray<(typeof PI_THINKING_OPTIONS)[number]> {
  if (!model.reasoning) return [];
  const map = model.thinkingLevelMap;
  if (map && Object.keys(map).length > 0) {
    return PI_THINKING_OPTIONS.filter((option) => {
      const mapped = map[option.value];
      if (mapped === null) return false;
      return mapped !== undefined || PI_DEFAULT_SUPPORTED_THINKING_LEVELS.has(option.value);
    });
  }
  return PI_THINKING_OPTIONS.filter((option) =>
    PI_DEFAULT_SUPPORTED_THINKING_LEVELS.has(option.value),
  );
}

/** "google-vertex" → "Google Vertex"; Moss's own lane keeps its name. */
export function piProviderDisplayName(provider: string): string {
  if (provider === "moss") return "Moss";
  return provider
    .split(/[-_]/u)
    .filter(Boolean)
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * Pi extensions own their provider catalogs, so normalize their display metadata before it
 * crosses Moss's trimmed-string RPC contract. One malformed model must not hide the catalog.
 */
export function toPiProviderModelDescriptor(
  model: PiRpcModel,
): ProviderListModelsResult["models"][number] | null {
  if (typeof model.provider !== "string" || typeof model.id !== "string") return null;
  const provider = trimToUndefined(model.provider);
  const modelId = trimToUndefined(model.id);
  if (!provider || !modelId || provider !== model.provider || modelId !== model.id) return null;
  const slug = `${provider}/${modelId}`;
  const supportedThinkingOptions = getPiSupportedThinkingOptions(model);
  return {
    slug,
    name: trimToUndefined(model.name) ?? slug,
    upstreamProviderId: provider,
    upstreamProviderName: piProviderDisplayName(provider),
    ...(supportedThinkingOptions.length > 0
      ? {
          supportedReasoningEfforts: supportedThinkingOptions.map((option) => ({
            value: option.value,
            label: option.label,
            description: option.description,
          })),
          ...(supportedThinkingOptions.some((option) => option.value === DEFAULT_PI_THINKING_LEVEL)
            ? { defaultReasoningEffort: DEFAULT_PI_THINKING_LEVEL }
            : {}),
        }
      : {}),
  };
}

export function parsePiModelReference(
  modelId: string | null | undefined,
): { readonly provider?: string; readonly id: string } | undefined {
  const trimmed = trimToUndefined(modelId);
  if (!trimmed) return undefined;
  for (const separator of ["/", ":"]) {
    if (!trimmed.includes(separator)) continue;
    const [provider, ...rest] = trimmed.split(separator);
    const id = rest.join(separator);
    if (provider && id) return { provider, id };
  }
  return { id: trimmed };
}

/** Finds a model Pi offers for a Moss slug (`provider/id`, `provider:id` or a bare id). */
export function findPiModel(
  models: ReadonlyArray<PiRpcModel>,
  modelId: string | null | undefined,
): PiRpcModel | undefined {
  const parsed = parsePiModelReference(modelId);
  if (!parsed) return undefined;
  if (parsed.provider) {
    return models.find((model) => model.provider === parsed.provider && model.id === parsed.id);
  }
  return models.find(
    (model) => model.id === parsed.id || `${model.provider}/${model.id}` === parsed.id,
  );
}

export function piModelSlug(model: Pick<PiRpcModel, "provider" | "id"> | undefined) {
  return model ? `${model.provider}/${model.id}` : undefined;
}

export function normalizePiTokenUsage(
  stats: PiRpcSessionStats,
  contextWindow?: number | null,
): ThreadTokenUsageSnapshot | undefined {
  const inputTokens = stats.tokens.input;
  const cachedInputTokens = stats.tokens.cacheRead;
  const outputTokens = stats.tokens.output;
  const totalProcessedTokens = stats.tokens.total;
  const contextUsage = stats.contextUsage;
  const contextUsageWindowValue = positiveFiniteNumber(contextUsage?.contextWindow);
  const contextUsageWindow =
    contextUsageWindowValue !== undefined ? Math.floor(contextUsageWindowValue) : undefined;
  const fallbackWindowValue = positiveFiniteNumber(contextWindow);
  const fallbackWindow =
    fallbackWindowValue !== undefined ? Math.floor(fallbackWindowValue) : undefined;
  const maxTokens = contextUsageWindow ?? fallbackWindow;
  const contextUsageTokenValue = nonNegativeFiniteNumber(contextUsage?.tokens);
  const contextUsageTokens =
    contextUsageTokenValue !== undefined ? Math.round(contextUsageTokenValue) : undefined;
  const usedPercent = clampUsagePercent(contextUsage?.percent);
  const usedTokensFromPercent =
    contextUsageTokens === undefined && usedPercent !== undefined && maxTokens !== undefined
      ? Math.round((usedPercent / 100) * maxTokens)
      : undefined;
  const usedTokens =
    contextUsageTokens ??
    usedTokensFromPercent ??
    (contextUsage
      ? 0
      : maxTokens !== undefined
        ? Math.min(totalProcessedTokens, maxTokens)
        : totalProcessedTokens);
  if (
    usedTokens <= 0 &&
    inputTokens <= 0 &&
    cachedInputTokens <= 0 &&
    outputTokens <= 0 &&
    maxTokens === undefined &&
    usedPercent === undefined
  ) {
    return undefined;
  }
  return {
    usedTokens,
    ...(usedPercent !== undefined ? { usedPercent } : {}),
    ...(totalProcessedTokens > usedTokens ? { totalProcessedTokens } : {}),
    inputTokens,
    cachedInputTokens,
    outputTokens,
    ...(maxTokens !== undefined ? { maxTokens } : {}),
    lastUsedTokens: usedTokens,
    lastInputTokens: inputTokens,
    lastCachedInputTokens: cachedInputTokens,
    lastOutputTokens: outputTokens,
  };
}

export function classifyPiRuntimeError(
  message: string,
): "provider_error" | "transport_error" | "permission_error" | "validation_error" | "unknown" {
  const normalized = message.toLowerCase();
  if (
    normalized.includes("network") ||
    normalized.includes("connection") ||
    normalized.includes("timeout") ||
    normalized.includes("econn") ||
    normalized.includes("fetch failed")
  ) {
    return "transport_error";
  }
  if (
    normalized.includes("api key") ||
    normalized.includes("auth") ||
    normalized.includes("unauthorized") ||
    normalized.includes("forbidden") ||
    normalized.includes("permission")
  ) {
    return "permission_error";
  }
  if (
    normalized.includes("invalid") ||
    normalized.includes("validation") ||
    normalized.includes("not available") ||
    normalized.includes("not found")
  ) {
    return "validation_error";
  }
  if (
    normalized.includes("rate limit") ||
    normalized.includes("quota") ||
    normalized.includes("usage limit") ||
    normalized.includes("overloaded") ||
    normalized.includes("provider")
  ) {
    return "provider_error";
  }
  return "unknown";
}

export function isPiReloadCommand(text: string): boolean {
  return /^\/reload(?:\s|$)/iu.test(text.trim());
}

// ── Tool calls ─────────────────────────────────────────────────

export type PiToolItemType =
  | "command_execution"
  | "file_change"
  | "dynamic_tool_call"
  | "web_search";

function firstStringValue(
  record: Record<string, unknown> | undefined,
  keys: readonly string[],
): string | undefined {
  if (!record) return undefined;
  for (const key of keys) {
    const value = record[key];
    if (typeof value === "string" && value.trim().length > 0) return value;
  }
  return undefined;
}

function toolRecord(value: unknown): Record<string, unknown> | undefined {
  return isRecord(value) ? value : undefined;
}

export function textFromPiContent(content: unknown): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .flatMap((block) =>
      isRecord(block) && block.type === "text" && typeof block.text === "string"
        ? [block.text]
        : [],
    )
    .join("\n\n");
}

export function textFromToolResult(result: unknown): string | undefined {
  if (typeof result === "string") return result;
  const record = toolRecord(result);
  if (!record) return undefined;
  const directText = firstStringValue(record, [
    "output",
    "stdout",
    "stderr",
    "text",
    "summary",
    "message",
    "error",
  ]);
  if (directText) return directText;
  const content = Array.isArray(record.content) ? record.content : [];
  const parts = content.flatMap((block) => {
    const blockRecord = toolRecord(block);
    return blockRecord?.type === "text" && typeof blockRecord.text === "string"
      ? [blockRecord.text]
      : [];
  });
  return parts.length > 0 ? parts.join("\n") : undefined;
}

function toolExitCode(result: unknown): number | null | undefined {
  const record = toolRecord(result);
  if (!record) return undefined;
  const exitCode = record.exitCode;
  if (typeof exitCode === "number" && Number.isFinite(exitCode)) return exitCode;
  const code = record.code;
  if (typeof code === "number" && Number.isFinite(code)) return code;
  return null;
}

function toolRawOutput(result: unknown): Record<string, unknown> | undefined {
  if (result === undefined) return undefined;
  const text = textFromToolResult(result);
  const exitCode = toolExitCode(result);
  if (typeof result === "string") return { stdout: result, content: result };
  if (result === null) return {};
  const record = toolRecord(result);
  if (!record) return text ? { stdout: text, content: text } : undefined;
  return {
    ...record,
    ...(text ? { stdout: text, content: text } : {}),
    ...(exitCode !== undefined ? { exitCode } : {}),
  };
}

function toolPath(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["path", "filePath", "file", "relativePath"]);
}

function toolCommand(args: unknown): string | undefined {
  return firstStringValue(toolRecord(args), ["command", "cmd"]);
}

function toolSearchQuery(toolName: string, args: unknown): string | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (toolName === "grep" || toolName === "find") {
    return firstStringValue(record, ["pattern", "query"]);
  }
  return firstStringValue(record, ["query", "pattern"]);
}

function toolEditEntries(args: unknown): ReadonlyArray<Record<string, unknown>> | undefined {
  const record = toolRecord(args);
  if (!record) return undefined;
  if (Array.isArray(record.edits)) {
    return record.edits.flatMap((edit) => {
      const editRecord = toolRecord(edit);
      return editRecord ? [editRecord] : [];
    });
  }
  const oldText = firstStringValue(record, ["oldText", "old_string", "oldString"]);
  const newText = firstStringValue(record, ["newText", "new_string", "newString"]);
  if (oldText !== undefined || newText !== undefined) {
    return [
      {
        ...(oldText !== undefined ? { oldText } : {}),
        ...(newText !== undefined ? { newText } : {}),
      },
    ];
  }
  return undefined;
}

export function piToolItemType(toolName: string): PiToolItemType {
  switch (toolName) {
    case "bash":
    case "powershell":
      return "command_execution";
    case "edit":
    case "write":
      return "file_change";
    case "grep":
    case "find":
      return "web_search";
    default:
      return "dynamic_tool_call";
  }
}

export function piToolTitle(toolName: string, args: unknown): string {
  const command =
    toolName === "bash" || toolName === "powershell"
      ? trimPiDisplayText(toolCommand(args))
      : undefined;
  if (command) return command;
  const filePath = trimPiDisplayText(toolPath(args));
  if (
    filePath &&
    (toolName === "read" || toolName === "edit" || toolName === "write" || toolName === "ls")
  ) {
    return `${toolName} ${filePath}`;
  }
  const query = trimPiDisplayText(toolSearchQuery(toolName, args));
  if (query && (toolName === "find" || toolName === "grep")) return `${toolName} ${query}`;
  return toolName.trim() || "Tool";
}

export function piToolLifecycleData(input: {
  readonly toolCallId: string;
  readonly toolName: string;
  readonly args: unknown;
  readonly result?: unknown;
  readonly partialResult?: unknown;
  readonly isError?: boolean;
}): Record<string, unknown> {
  const { toolCallId, toolName, args } = input;
  const rawOutput = toolRawOutput(input.result ?? input.partialResult);
  const filePath = toolPath(args);
  const query = toolSearchQuery(toolName, args);
  const command = toolCommand(args);
  const edits = toolEditEntries(args);
  const content = toolRecord(args)?.content;
  const outputDetails = toolRecord(rawOutput?.details);
  const unifiedDiff = firstStringValue(outputDetails, ["diff"]);
  const base: Record<string, unknown> = {
    toolCallId,
    callId: toolCallId,
    toolName,
    name: toolName,
    tool: toolName,
    kind: toolName,
    args,
    input: args,
    rawInput: args,
    ...(rawOutput ? { rawOutput } : {}),
    ...(input.partialResult !== undefined ? { partialResult: input.partialResult } : {}),
    ...(input.result !== undefined ? { result: input.result } : {}),
    ...(input.isError !== undefined ? { isError: input.isError } : {}),
  };

  switch (toolName) {
    case "bash":
    case "powershell":
      return {
        ...base,
        kind: "execute",
        ...(command ? { command } : {}),
        ...(rawOutput?.exitCode !== undefined ? { exitCode: rawOutput.exitCode } : {}),
      };
    case "read":
      return {
        ...base,
        kind: "read",
        ...(filePath
          ? {
              path: filePath,
              filePath,
              files: [{ path: filePath }],
              commandActions: [{ type: "read", name: "read", path: filePath }],
            }
          : {}),
      };
    case "edit":
      return {
        ...base,
        kind: "edit",
        ...(filePath
          ? {
              path: filePath,
              filePath,
              files: [{ path: filePath }],
              changes: [{ path: filePath }],
            }
          : {}),
        ...(edits
          ? { edits: edits.map((edit) => ({ ...edit, ...(filePath ? { path: filePath } : {}) })) }
          : {}),
        ...(unifiedDiff ? { unifiedDiff } : {}),
      };
    case "write":
      return {
        ...base,
        kind: "write",
        ...(filePath
          ? {
              path: filePath,
              filePath,
              files: [{ path: filePath }],
              changes: [{ path: filePath }],
            }
          : {}),
        ...(typeof content === "string" ? { content } : {}),
      };
    case "find":
    case "grep":
      return {
        ...base,
        kind: "search",
        searchKind: toolName,
        ...(query ? { query } : {}),
        ...(filePath ? { path: filePath } : {}),
        ...(query || filePath
          ? { commandActions: [{ type: "search", name: toolName, query, path: filePath }] }
          : {}),
      };
    case "ls":
      return {
        ...base,
        kind: "listFiles",
        ...(filePath
          ? {
              path: filePath,
              query: filePath,
              commandActions: [{ type: "listFiles", name: "ls", path: filePath }],
            }
          : {}),
      };
    default:
      return base;
  }
}

/** Rebuilds Moss transcript items from `get_messages`. */
export function mapPiMessageHistory(messages: ReadonlyArray<unknown>): unknown[] {
  const items: unknown[] = [];
  const pendingTools = new Map<string, { toolName: string; args: unknown }>();
  for (const message of messages) {
    if (!isRecord(message)) continue;
    if (message.role === "user") {
      const text = textFromPiContent(message.content);
      if (text) items.push({ type: "user_message", text });
      continue;
    }
    if (message.role === "assistant" && Array.isArray(message.content)) {
      for (const content of message.content) {
        if (!isRecord(content)) continue;
        if (content.type === "text" && typeof content.text === "string" && content.text) {
          items.push({ type: "assistant_message", text: content.text });
          continue;
        }
        if (
          content.type === "thinking" &&
          typeof content.thinking === "string" &&
          content.thinking
        ) {
          items.push({ type: "reasoning", text: content.thinking });
          continue;
        }
        if (
          content.type === "toolCall" &&
          typeof content.id === "string" &&
          typeof content.name === "string"
        ) {
          pendingTools.set(content.id, { toolName: content.name, args: content.arguments });
          items.push({
            type: "tool_call",
            status: "started",
            callId: content.id,
            toolName: content.name,
            itemType: piToolItemType(content.name),
            title: piToolTitle(content.name, content.arguments),
            args: content.arguments,
            data: piToolLifecycleData({
              toolCallId: content.id,
              toolName: content.name,
              args: content.arguments,
            }),
          });
        }
      }
      continue;
    }
    if (message.role === "toolResult" && typeof message.toolCallId === "string") {
      const pending = pendingTools.get(message.toolCallId);
      pendingTools.delete(message.toolCallId);
      const toolName =
        pending?.toolName ?? (typeof message.toolName === "string" ? message.toolName : "tool");
      const args = pending?.args;
      const isError = message.isError === true;
      const result = { content: message.content };
      items.push({
        type: "tool_call",
        status: isError ? "failed" : "completed",
        callId: message.toolCallId,
        toolName,
        itemType: piToolItemType(toolName),
        title: piToolTitle(toolName, args),
        output: textFromPiContent(message.content),
        isError,
        data: piToolLifecycleData({
          toolCallId: message.toolCallId,
          toolName,
          args,
          result,
          isError,
        }),
      });
    }
  }
  return items;
}

// ── Storage ────────────────────────────────────────────────────

/**
 * Where Pi keeps its config and sessions for one Moss instance. `agentDir` undefined means
 * Pi's own default (`~/.pi/agent`, or the person's `PI_CODING_AGENT_DIR`).
 */
export function makePiStoragePaths(input: {
  readonly agentDir?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly instanceId?: string | undefined;
  readonly stateDir: string;
  readonly homeDir: string;
}): { readonly agentDir?: string; readonly sessionDir?: string } {
  const boundary =
    input.environment !== undefined ||
    (input.instanceId !== undefined && input.instanceId !== PROVIDER);
  const selectedAbsolutePath = (value: string | undefined) => {
    const selected = trimToUndefined(value);
    return selected && path.isAbsolute(selected) ? selected : undefined;
  };
  const selectedEnvironmentValue = (name: string) =>
    Object.entries(input.environment ?? {}).find(
      ([candidate]) => candidate.toUpperCase() === name,
    )?.[1];
  const selectedHome = selectedAbsolutePath(
    selectedEnvironmentValue("HOME") ?? selectedEnvironmentValue("USERPROFILE"),
  );
  const isolatedHome = providerIsolatedHomePath({
    driver: PROVIDER,
    instanceId: input.instanceId,
    homeDir: input.homeDir,
    isolationRootDir: input.stateDir,
  });
  const expansionHome = boundary ? (selectedHome ?? isolatedHome) : (selectedHome ?? input.homeDir);
  const expandHome = (value: string) =>
    value === "~" || value.startsWith("~/")
      ? path.join(expansionHome, value.slice(value === "~" ? 1 : 2))
      : value;
  const rawConfiguredAgentDir = trimToUndefined(input.agentDir);
  const configuredAgentDir = rawConfiguredAgentDir
    ? rawConfiguredAgentDir === "~" || rawConfiguredAgentDir.startsWith("~/")
      ? expandHome(rawConfiguredAgentDir)
      : !boundary || path.isAbsolute(rawConfiguredAgentDir)
        ? rawConfiguredAgentDir
        : undefined
    : undefined;
  const selectedAgentDir = selectedAbsolutePath(selectedEnvironmentValue("PI_CODING_AGENT_DIR"));
  if (!boundary && !configuredAgentDir && !selectedAgentDir) return {};
  const agentDir =
    configuredAgentDir ??
    selectedAgentDir ??
    path.join(selectedHome ?? isolatedHome, ".pi", "agent");
  if (!boundary) return { agentDir };
  const selectedSessionDir = selectedAbsolutePath(
    selectedEnvironmentValue("PI_CODING_AGENT_SESSION_DIR"),
  );
  return {
    agentDir,
    sessionDir: expandHome(selectedSessionDir ?? path.join(agentDir, "sessions")),
  };
}
