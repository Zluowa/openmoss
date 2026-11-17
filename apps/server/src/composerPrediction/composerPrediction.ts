// FILE: composerPrediction.ts
// Purpose: The pure decisions behind composer predictions: which turn may be predicted,
//          which conversation text the model reads, and which provider instance, model,
//          and effort generate it.
// Layer: Server domain logic (no IO)
// Exports: resolveComposerPredictionTurnBlocker, isComposerPredictionTurnCurrent,
//          buildComposerPredictionConversation, resolveComposerPredictionRouting,
//          resolveComposerPredictionRoutingResult, resolveComposerPredictionRoute,
//          lowestSupportedEffort, resolveMossManagedPredictionModel,
//          resolveComposerPredictionHedgeDelayMs, readComposerPredictionClosingQuestion

import {
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  type GitTextGenerationProvider,
  type MessageId,
  type ModelSelection,
  type OrchestrationMessage,
  type OrchestrationThreadShell,
  type ProviderKind,
  type ServerSettings,
  type TurnId,
} from "@moss/contracts";
import { MOSS_MANAGED_PROVIDER_INSTANCE_IDS } from "@moss/shared/mossDownloadChannel";
import {
  getMossManagedModelDefinition,
  MOSS_REASONING_EFFORTS,
  type MossModelFamily,
} from "@moss/shared/mossRealmCatalog";
import { EMPTY_MODEL_CAPABILITIES, getModelCapabilities } from "@moss/shared/model";
import { isWrapUpToolName, parseWrapUp } from "@moss/shared/wrapUp";
import {
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@moss/shared/providerInstances";

import type { IsolatedTextGenerationSupport } from "../git/Services/TextGeneration.ts";
import { COMPOSER_PREDICTION_CONTEXT_BUDGET } from "../git/textGenerationShared.ts";
import type { ProviderNextUserMessagePredictionSupport } from "../provider/Services/ProviderAdapter.ts";
import {
  hasDedicatedTextGenerationProvider,
  resolveTextGenerationInputForSelection,
  type TextGenerationProviderInput,
} from "../git/textGenerationSelection.ts";

type ComposerPredictionThread = Pick<
  OrchestrationThreadShell,
  "archivedAt" | "latestTurn" | "session" | "hasPendingApprovals" | "hasPendingUserInput"
>;

/** Why a turn cannot be predicted right now; a content-free code for logs. */
export type ComposerPredictionTurnBlocker =
  | "thread-missing"
  | "thread-archived"
  | "turn-not-latest"
  | "turn-incomplete"
  | "session-busy"
  | "pending-approval"
  | "pending-user-input";

/**
 * Null while `expectedTurnId` is still the thread's latest turn, that turn completed with a
 * final assistant reply, and nothing is running or waiting on the user; otherwise the first
 * reason it is not. Checked before and again after generation.
 */
export function resolveComposerPredictionTurnBlocker(
  thread: ComposerPredictionThread | undefined,
  expectedTurnId: TurnId,
): ComposerPredictionTurnBlocker | null {
  if (!thread) return "thread-missing";
  if (thread.archivedAt != null) return "thread-archived";
  const turn = thread.latestTurn;
  if (!turn || turn.turnId !== expectedTurnId) return "turn-not-latest";
  if (turn.state !== "completed" || turn.completedAt === null || turn.assistantMessageId === null) {
    return "turn-incomplete";
  }
  const sessionStatus = thread.session?.status;
  if (sessionStatus === "running" || sessionStatus === "starting") return "session-busy";
  if (thread.hasPendingApprovals === true) return "pending-approval";
  if (thread.hasPendingUserInput === true) return "pending-user-input";
  return null;
}

/** True when {@link resolveComposerPredictionTurnBlocker} finds nothing in the way. */
export function isComposerPredictionTurnCurrent(
  thread: ComposerPredictionThread | undefined,
  expectedTurnId: TurnId,
): boolean {
  return resolveComposerPredictionTurnBlocker(thread, expectedTurnId) === null;
}

type ComposerPredictionMessage = Pick<OrchestrationMessage, "id" | "role" | "text" | "streaming"> &
  Partial<Pick<OrchestrationMessage, "dispatchOrigin" | "dispatchSourceThreadId">>;

/**
 * A user-role message the person did not write: an automation run, another agent's
 * `moss_send_message`, or a delegated task's completion notice. A model that reads it as the
 * person's voice predicts more notices (T3 Code #37292), so it is left out of the transcript.
 */
function isWrittenByPerson(message: ComposerPredictionMessage): boolean {
  return (
    message.dispatchSourceThreadId === undefined &&
    (message.dispatchOrigin === undefined || message.dispatchOrigin === "user")
  );
}

interface ComposerPredictionExchange {
  readonly requests: string[];
  reply: string | null;
}

/**
 * The question an agent left for the person in its turn-end box (`moss_wrap_up`), with the
 * answers it offered as buttons. The agent is told not to repeat it in its closing message,
 * so the reply alone often reads as finished work; without it a prediction answers "none"
 * exactly where a suggestion helps most.
 */
export interface ComposerPredictionClosingQuestion {
  readonly ask: string;
  readonly actions: ReadonlyArray<string>;
}

/** A turn's tool activity as stored: its kind and payload. */
export interface ComposerPredictionToolActivity {
  readonly kind: string;
  readonly payload: unknown;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * The tool input of a stored `moss_wrap_up` call in either provider shape: Codex keeps the
 * tool name and arguments in `data` (`codex.mcp_tool_call`); Claude writes a `detail` of
 * `ToolName: {json}`.
 */
function wrapUpToolInput(payload: unknown): unknown {
  const record = asRecord(payload);
  const data = asRecord(record?.data);
  if (typeof data?.tool === "string" && isWrapUpToolName(data.tool)) return data.arguments;
  const detail = typeof record?.detail === "string" ? record.detail : "";
  const separator = detail.indexOf(":");
  if (separator <= 0 || !isWrapUpToolName(detail.slice(0, separator).trim())) return undefined;
  return detail.slice(separator + 1).trim();
}

/**
 * The question of the turn's last completed `moss_wrap_up` call, or null when the turn ended
 * without one or its last box asks nothing. Records are read oldest first.
 */
export function readComposerPredictionClosingQuestion(
  records: ReadonlyArray<ComposerPredictionToolActivity>,
): ComposerPredictionClosingQuestion | null {
  for (const record of records.toReversed()) {
    if (record.kind !== "tool.completed") continue;
    const input = wrapUpToolInput(record.payload);
    if (input === undefined) continue;
    const box = parseWrapUp(input);
    if (box === null) continue;
    return box.ask === null ? null : { ask: box.ask, actions: box.actions };
  }
  return null;
}

/** How a closing question reads at the end of the final reply in a prediction transcript. */
export function formatComposerPredictionClosingQuestion(
  question: ComposerPredictionClosingQuestion,
): string {
  const answers =
    question.actions.length > 0
      ? ` Answer buttons offered: ${question.actions.map((label) => `"${label}"`).join(", ")}.`
      : "";
  return `[The assistant then asked the user: "${question.ask}"${answers}]`;
}

const OMITTED_MARKER = "[...]";
const USER_LABEL = "User: ";
const ASSISTANT_LABEL = "Assistant: ";
const MESSAGE_SEPARATOR = "\n\n";

function keepTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const tailLength = Math.max(0, maxChars - OMITTED_MARKER.length - 1);
  return `${OMITTED_MARKER}\n${text.slice(text.length - tailLength)}`;
}

function keepHeadAndTail(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text;
  const available = Math.max(0, maxChars - OMITTED_MARKER.length - 2);
  const headLength = Math.ceil(available / 2);
  const tailLength = available - headLength;
  return `${text.slice(0, headLength)}\n${OMITTED_MARKER}\n${text.slice(text.length - tailLength)}`;
}

function joinedLength(lines: ReadonlyArray<string>): number {
  return lines.reduce(
    (total, line, index) => total + line.length + (index > 0 ? MESSAGE_SEPARATOR.length : 0),
    0,
  );
}

/**
 * The transcript a prediction reads: visible text the person wrote and the assistant's
 * replies only (no tool output, attachments, activities, or user-role messages sent by an
 * automation or another agent) from the newest exchanges, oldest
 * first. The latest request and the final reply always come first in the
 * budget; older exchanges are dropped whole, and an oversized final reply keeps
 * its end. Returns null when the final reply is missing, empty, or streaming, or
 * when the user already wrote after it.
 */
export function buildComposerPredictionConversation(input: {
  readonly messages: ReadonlyArray<ComposerPredictionMessage>;
  readonly finalReplyMessageId: MessageId;
  /** The turn-end box's question, read after the final reply; it always fits the budget. */
  readonly closingQuestion?: ComposerPredictionClosingQuestion | null | undefined;
}): string | null {
  const budget = COMPOSER_PREDICTION_CONTEXT_BUDGET;
  const finalIndex = input.messages.findIndex(
    (message) => message.id === input.finalReplyMessageId,
  );
  const finalReply = finalIndex >= 0 ? input.messages[finalIndex] : undefined;
  if (
    !finalReply ||
    finalReply.role !== "assistant" ||
    finalReply.streaming ||
    finalReply.text.trim().length === 0
  ) {
    return null;
  }
  if (input.messages.slice(finalIndex + 1).some((message) => message.role === "user")) {
    return null;
  }

  const exchanges: ComposerPredictionExchange[] = [];
  for (const message of input.messages.slice(0, finalIndex + 1)) {
    const text = message.text.trim();
    if (message.streaming || text.length === 0) continue;
    const current = exchanges.at(-1);
    if (message.role === "user") {
      if (!isWrittenByPerson(message)) continue;
      if (current && current.reply === null) current.requests.push(text);
      else exchanges.push({ requests: [text], reply: null });
    } else if (message.role === "assistant" && current) {
      // The last assistant message of an exchange is the reply that closed it.
      current.reply = text;
    }
  }
  const latest = exchanges.at(-1);
  if (!latest || latest.reply === null) return null;

  // The latest request (newest message first) gets its own share of the budget.
  const requestLines: string[] = [];
  for (const request of latest.requests.toReversed()) {
    const line =
      requestLines.length === 0
        ? `${USER_LABEL}${keepHeadAndTail(request, budget.maxLatestRequestChars - USER_LABEL.length)}`
        : `${USER_LABEL}${request}`;
    if (joinedLength([line, ...requestLines]) > budget.maxLatestRequestChars) break;
    requestLines.unshift(line);
  }
  const closingLine = input.closingQuestion
    ? formatComposerPredictionClosingQuestion(input.closingQuestion)
    : null;
  const replyBudget =
    budget.maxChars -
    joinedLength(requestLines) -
    MESSAGE_SEPARATOR.length -
    ASSISTANT_LABEL.length -
    (closingLine === null ? 0 : closingLine.length + MESSAGE_SEPARATOR.length);
  const latestLines = [
    ...requestLines,
    `${ASSISTANT_LABEL}${keepTail(latest.reply, replyBudget)}`,
    ...(closingLine === null ? [] : [closingLine]),
  ];

  // Older exchanges fill what is left, newest first, and only whole.
  const olderBlocks: string[][] = [];
  let used = joinedLength(latestLines);
  for (const exchange of exchanges.slice(-budget.maxExchanges, -1).toReversed()) {
    const lines = [
      ...exchange.requests.map((request) => `${USER_LABEL}${request}`),
      ...(exchange.reply === null ? [] : [`${ASSISTANT_LABEL}${exchange.reply}`]),
    ];
    const nextUsed = used + joinedLength(lines) + MESSAGE_SEPARATOR.length;
    if (nextUsed > budget.maxChars) break;
    olderBlocks.unshift(lines);
    used = nextUsed;
  }
  return [...olderBlocks.flat(), ...latestLines].join(MESSAGE_SEPARATOR);
}

/** Option key each dedicated text-generation provider reads its effort from. */
const EFFORT_OPTION_KEY: Readonly<Record<GitTextGenerationProvider, string>> = {
  claudeAgent: "effort",
  codex: "reasoningEffort",
  cursor: "reasoningEffort",
  droid: "reasoningEffort",
  opencode: "variant",
};

/** Ladder order across providers; a level outside it ranks after every known one. */
const EFFORT_ORDER = ["none", "off", "minimal", "low", "medium", "high", "xhigh", "max", "ultra"];

/** The managed OpenCode lane names its models `moss/<id>`. */
const MOSS_OPENCODE_MODEL_PREFIX = "moss/";

/**
 * The least effort the model's capability data lists, ignoring prompt-prefix and
 * provider-setting modes. Null when the catalog lists no effort for the model.
 */
export function lowestSupportedEffort(provider: ProviderKind, model: string): string | null {
  const capabilities = getModelCapabilities(provider, model);
  const levels = (
    provider === "opencode"
      ? (capabilities.variantOptions ?? [])
      : capabilities.reasoningEffortLevels.filter(
          (level) => level.controlSource === undefined || level.controlSource === "api-effort",
        )
  ).map((level, index) => {
    const rank = EFFORT_ORDER.indexOf(level.value);
    return { value: level.value, rank: rank >= 0 ? rank : EFFORT_ORDER.length + index };
  });
  if (levels.length === 0) return null;
  return levels.reduce((lowest, level) => (level.rank < lowest.rank ? level : lowest)).value;
}

/**
 * The lowest rung of a Moss gateway model's own reasoning ladder (the gateway snaps any
 * other value onto it). Null when the vendor exposes no reasoning control.
 */
function lowestMossManagedEffort(model: string): string | null {
  const levels = getMossManagedModelDefinition(model)?.reasoning?.levels ?? [];
  const sorted = levels.toSorted(
    (left, right) => MOSS_REASONING_EFFORTS.indexOf(left) - MOSS_REASONING_EFFORTS.indexOf(right),
  );
  return sorted[0] ?? null;
}

function withEffort(
  selection: ModelSelection,
  provider: GitTextGenerationProvider,
  effort: string | null,
): ModelSelection {
  const key = EFFORT_OPTION_KEY[provider];
  const options: unknown = selection.options;
  // Options travel either as a record or as a list of `{ id, value }` selections.
  if (Array.isArray(options)) {
    return {
      ...selection,
      options: [
        ...options.filter((option: { readonly id?: unknown }) => option?.id !== key),
        ...(effort === null ? [] : [{ id: key, value: effort }]),
      ],
    } as ModelSelection;
  }
  const record = { ...(options as Record<string, unknown> | undefined) };
  if (effort === null) delete record[key];
  else record[key] = effort;
  return { ...selection, options: record } as ModelSelection;
}

function withLowestEffort(selection: ModelSelection, provider: GitTextGenerationProvider) {
  const lowest = lowestSupportedEffort(provider, selection.model);
  // Without catalog data the chat keeps its own effort rather than an invented one.
  if (lowest === null) return selection;
  return withEffort(selection, provider, lowest);
}

/**
 * The cheapest model of each vendor family on the Moss gateway, by the reviewed text cost
 * cards (input / output nano-USD per token, 2026-11-01): GPT-5.6 Luna 200/1,200, Claude
 * Haiku 4.5 1,000/5,000, DeepSeek V4 Flash 172/515, GLM-5.3 Flash 150/500. Kimi, Qwen and
 * MiniMax have one model each. A prediction stays with the vendor the chat already uses, so
 * the conversation never goes to a vendor the person did not pick, and every lane that
 * serves the chat's model serves this one on the same engine.
 */
const MOSS_PREDICTION_MODEL_BY_FAMILY: Readonly<Record<MossModelFamily, string>> = {
  openai: "gpt-5.6-luna",
  claude: "claude-haiku-4-5-20251001",
  deepseek: "deepseek-v4-flash",
  glm: "glm-5.3-flash",
  kimi: "kimi-k3",
  qwen: "qwen3.8-max",
  minimax: "minimax-m3",
};

const MOSS_MANAGED_INSTANCE_IDS: ReadonlySet<string> = new Set(MOSS_MANAGED_PROVIDER_INSTANCE_IDS);

/**
 * The model a prediction runs on for a chat on a Moss-managed instance (the signed-in Moss
 * account, phone / Google / enterprise key through the Moss gateway), where every prediction
 * spends the person's paid quota: the cheapest model of the chat model's vendor family. Null
 * when the instance is not Moss-managed or the chat's model is not a Moss gateway model.
 */
export function resolveMossManagedPredictionModel(input: {
  readonly instanceId: string;
  readonly chatModel: string;
}): string | null {
  if (!MOSS_MANAGED_INSTANCE_IDS.has(input.instanceId)) return null;
  const prefix = input.chatModel.startsWith(MOSS_OPENCODE_MODEL_PREFIX)
    ? MOSS_OPENCODE_MODEL_PREFIX
    : "";
  const family = getMossManagedModelDefinition(input.chatModel.slice(prefix.length))?.family;
  return family ? `${prefix}${MOSS_PREDICTION_MODEL_BY_FAMILY[family]}` : null;
}

/** Earliest a second attempt may start, once a route has shown how fast it usually is. */
export const COMPOSER_PREDICTION_MIN_HEDGE_DELAY_MS = 6_000;
/** Second-attempt delay for a route that has not completed a generation yet. */
export const COMPOSER_PREDICTION_DEFAULT_HEDGE_DELAY_MS = 10_000;

/**
 * When a still-running generation should be raced by a second attempt: after twice the
 * route's usual time (never sooner than the minimum), or after the default when the route
 * has no history. Null when a second attempt could not finish inside the timeout anyway,
 * which is the case for a route that is slow by nature.
 */
export function resolveComposerPredictionHedgeDelayMs(input: {
  readonly recentDurationsMs: ReadonlyArray<number>;
  readonly timeoutMs: number;
}): number | null {
  if (input.recentDurationsMs.length === 0) return COMPOSER_PREDICTION_DEFAULT_HEDGE_DELAY_MS;
  const sorted = input.recentDurationsMs.toSorted((left, right) => left - right);
  const median = sorted[Math.floor(sorted.length / 2)] ?? 0;
  const delayMs = Math.max(COMPOSER_PREDICTION_MIN_HEDGE_DELAY_MS, median * 2);
  return delayMs + median <= input.timeoutMs ? delayMs : null;
}

export type ComposerPredictionRouting = TextGenerationProviderInput & {
  readonly source:
    | "git-writing-model"
    | "prediction-model"
    | "chat-model"
    | "moss-managed-cheapest";
};

/**
 * Smaller model a provider predicts with on a person's own account when the Git-writing model
 * belongs to another instance, so a chat on a frontier model does not pay frontier rates for a
 * one-line guess after every turn. Used only when the chat runs a model from
 * the provider's own catalog: an account on a custom gateway may not serve this one, so a chat
 * on an unknown model keeps its own.
 */
const COMPOSER_PREDICTION_MODEL: Partial<Record<GitTextGenerationProvider, string>> = {
  claudeAgent: "claude-sonnet-5-5",
  codex: DEFAULT_GIT_TEXT_GENERATION_MODEL,
};

function isCatalogModel(provider: ProviderKind, model: string): boolean {
  return getModelCapabilities(provider, model) !== EMPTY_MODEL_CAPABILITIES;
}

/**
 * Why a chat has no prediction routing. `no-dedicated-provider` holds for the turn (the
 * chat's provider has no text generation at all); the others follow settings, or a session
 * that may still catch up with the chat, so a later request may route.
 */
export type ComposerPredictionRoutingFailure =
  | "session-instance-mismatch"
  | "instance-unavailable"
  | "selection-mismatch"
  | "no-dedicated-provider"
  | "selection-unresolved";

export type ComposerPredictionRoutingResult =
  | { readonly kind: "routed"; readonly routing: ComposerPredictionRouting }
  | { readonly kind: "unrouted"; readonly reason: ComposerPredictionRoutingFailure };

const unrouted = (reason: ComposerPredictionRoutingFailure): ComposerPredictionRoutingResult => ({
  kind: "unrouted",
  reason,
});

/**
 * Routes a prediction to the chat's own provider instance (its account). On a Moss-managed
 * instance it runs the cheapest model of the chat model's family at that model's lowest
 * effort. Elsewhere the configured Git-writing model is used only when it resolves to that
 * same instance, otherwise the chat's model; either one at its lowest catalog effort.
 * `unrouted` when the instance is missing or disabled, its driver has no dedicated text
 * generation, or the session and the thread disagree about the instance. Never another
 * account.
 */
export function resolveComposerPredictionRoutingResult(input: {
  readonly thread: Pick<OrchestrationThreadShell, "modelSelection" | "session">;
  readonly settings: ServerSettings;
}): ComposerPredictionRoutingResult {
  const chatSelection = input.thread.modelSelection;
  const chatInstanceId = resolveModelSelectionInstanceId(chatSelection);
  const sessionInstanceId = input.thread.session?.providerInstanceId;
  if (sessionInstanceId !== undefined && sessionInstanceId !== chatInstanceId) {
    return unrouted("session-instance-mismatch");
  }

  const instance = resolveProviderInstance(input.settings, { instanceId: chatInstanceId });
  if (!instance || !instance.enabled) return unrouted("instance-unavailable");
  const driver = instance.driver;
  if (driver !== chatSelection.provider) return unrouted("selection-mismatch");
  if (!hasDedicatedTextGenerationProvider(driver)) return unrouted("no-dedicated-provider");

  const managedModel = resolveMossManagedPredictionModel({
    instanceId: instance.instanceId,
    chatModel: chatSelection.model,
  });
  const configured = input.settings.textGenerationModelSelection;
  const useConfigured =
    managedModel === null &&
    configured.provider === driver &&
    resolveModelSelectionInstanceId(configured) === instance.instanceId;
  const predictionModel =
    managedModel === null && !useConfigured && isCatalogModel(driver, chatSelection.model)
      ? (COMPOSER_PREDICTION_MODEL[driver] ?? null)
      : null;
  // Lowest effort on every path: a short prediction gains nothing from reasoning, and a
  // Git-writing selection without an effort would otherwise run at the Git-writing default.
  // A managed route and the prediction model drop the chat's other options too: they belong
  // to another model, and fast mode, for one, bills the priority tier.
  const selection =
    managedModel !== null
      ? withEffort(
          {
            provider: driver,
            instanceId: instance.instanceId,
            model: managedModel,
          } as ModelSelection,
          driver,
          lowestSupportedEffort(driver, managedModel) ??
            // OpenCode names its own variants; never invent one.
            (driver === "opencode" ? null : lowestMossManagedEffort(managedModel)),
        )
      : withLowestEffort(
          useConfigured
            ? configured
            : predictionModel !== null
              ? ({ provider: driver, model: predictionModel } as ModelSelection)
              : chatSelection,
          driver,
        );
  // Only the instance's own options: global defaults could name another account.
  const routed = resolveTextGenerationInputForSelection(
    { ...selection, provider: driver, instanceId: instance.instanceId } as ModelSelection,
    providerStartOptionsFromInstance(instance),
  );
  if (!routed) return unrouted("selection-unresolved");
  return {
    kind: "routed",
    routing: {
      ...routed,
      source:
        managedModel !== null
          ? "moss-managed-cheapest"
          : useConfigured
            ? "git-writing-model"
            : predictionModel !== null
              ? "prediction-model"
              : "chat-model",
    },
  };
}

/** {@link resolveComposerPredictionRoutingResult}, or null when the chat is unrouted. */
export function resolveComposerPredictionRouting(input: {
  readonly thread: Pick<OrchestrationThreadShell, "modelSelection" | "session">;
  readonly settings: ServerSettings;
}): ComposerPredictionRouting | null {
  const result = resolveComposerPredictionRoutingResult(input);
  return result.kind === "routed" ? result.routing : null;
}

/**
 * Why neither generation route can serve a chat, for a reason that holds for the rest of the
 * turn: the provider has no text generation, or the isolated route is refused on this
 * platform and the live thread offers no native prediction fork (no live session, a Codex
 * build below the fork floor, no persisted provider thread, or a runtime without one).
 */
export type ComposerPredictionNoRouteReason =
  | "no-dedicated-provider"
  | "isolated-platform-blocked"
  | "native-no-live-session"
  | "native-cli-too-old"
  | "native-missing-thread"
  | "native-not-offered";

/**
 * - `isolated`: the isolated text-generation path on the chat's own instance (first choice).
 * - `native`: Codex's prediction fork of the live thread, at the chat model's lowest catalog
 *   effort (null keeps the thread's own); only for a `codex` chat the isolated path refuses.
 * - `no-route`: nothing can serve the chat this turn, for a reason that will not change.
 * - `unrouted`: no routing right now, for a reason that may change within the turn.
 */
export type ComposerPredictionRoute =
  | { readonly kind: "isolated"; readonly routing: ComposerPredictionRouting }
  | {
      readonly kind: "native";
      readonly routing: ComposerPredictionRouting;
      readonly effort: string | null;
    }
  | { readonly kind: "no-route"; readonly reason: ComposerPredictionNoRouteReason }
  | { readonly kind: "unrouted"; readonly reason: ComposerPredictionRoutingFailure };

/**
 * Every Codex reasoning model takes this effort. A fork otherwise inherits the chat's own,
 * which for a person's newest model (one Moss's catalog does not list yet) is often the
 * maximum: a one-line guess then thinks for longer than the prediction may take.
 */
const NATIVE_PREDICTION_FALLBACK_EFFORT = "low";

/**
 * The effort of a prediction on Codex's native fork: the lowest one the catalog lists for the
 * chat's model; `low` for a model the catalog does not know; null (the thread's own) for a
 * known model that takes no effort.
 */
export function resolveNativePredictionEffort(chatModel: string): string | null {
  if (!isCatalogModel("codex", chatModel)) return NATIVE_PREDICTION_FALLBACK_EFFORT;
  return lowestSupportedEffort("codex", chatModel);
}

const NATIVE_UNSUPPORTED_REASONS: Readonly<Record<string, ComposerPredictionNoRouteReason>> = {
  no_live_session: "native-no-live-session",
  app_server_without_prediction_fork: "native-cli-too-old",
  missing_provider_thread: "native-missing-thread",
};

/**
 * Which route generates a prediction, decided up front from what is known before anything
 * is generated. The isolated path stays first wherever it can serve the chat's own instance;
 * Codex's native fork is used only for a `codex` chat that the isolated path refuses on this
 * platform, and only when the thread's live session offers the fork. `isolatedSupport` is read
 * only for a routed chat and `nativeSupport` only for a refused `codex` one, so a caller may
 * leave out what the decision does not need.
 */
export function resolveComposerPredictionRoute(input: {
  readonly routing: ComposerPredictionRoutingResult;
  readonly chatModel: string;
  readonly isolatedSupport?: IsolatedTextGenerationSupport | undefined;
  readonly nativeSupport?: ProviderNextUserMessagePredictionSupport | undefined;
}): ComposerPredictionRoute {
  if (input.routing.kind === "unrouted") {
    return input.routing.reason === "no-dedicated-provider"
      ? { kind: "no-route", reason: "no-dedicated-provider" }
      : input.routing;
  }
  const routing = input.routing.routing;
  if (input.isolatedSupport?.kind !== "platform-blocked") return { kind: "isolated", routing };
  if (routing.modelSelection.provider !== "codex") {
    return { kind: "no-route", reason: "isolated-platform-blocked" };
  }
  const native = input.nativeSupport;
  if (native?.kind === "supported") {
    return { kind: "native", routing, effort: resolveNativePredictionEffort(input.chatModel) };
  }
  return {
    kind: "no-route",
    reason:
      (native ? NATIVE_UNSUPPORTED_REASONS[native.reason] : undefined) ?? "native-not-offered",
  };
}
