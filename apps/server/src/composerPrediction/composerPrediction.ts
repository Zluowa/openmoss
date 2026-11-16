// FILE: composerPrediction.ts
// Purpose: The pure decisions behind composer predictions: which turn may be predicted,
//          which conversation text the model reads, and which provider instance, model,
//          and effort generate it.
// Layer: Server domain logic (no IO)
// Exports: resolveComposerPredictionTurnBlocker, isComposerPredictionTurnCurrent,
//          buildComposerPredictionConversation, resolveComposerPredictionRouting,
//          lowestSupportedEffort, resolveMossManagedPredictionModel,
//          resolveComposerPredictionHedgeDelayMs

import type {
  GitTextGenerationProvider,
  MessageId,
  ModelSelection,
  OrchestrationMessage,
  OrchestrationThreadShell,
  ProviderKind,
  ServerSettings,
  TurnId,
} from "@moss/contracts";
import { MOSS_MANAGED_PROVIDER_INSTANCE_IDS } from "@moss/shared/mossDownloadChannel";
import {
  getMossManagedModelDefinition,
  MOSS_REASONING_EFFORTS,
  type MossModelFamily,
} from "@moss/shared/mossRealmCatalog";
import { getModelCapabilities } from "@moss/shared/model";
import {
  providerStartOptionsFromInstance,
  resolveModelSelectionInstanceId,
  resolveProviderInstance,
} from "@moss/shared/providerInstances";

import { COMPOSER_PREDICTION_CONTEXT_BUDGET } from "../git/textGenerationShared.ts";
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
  const replyBudget =
    budget.maxChars -
    joinedLength(requestLines) -
    MESSAGE_SEPARATOR.length -
    ASSISTANT_LABEL.length;
  const latestLines = [...requestLines, `${ASSISTANT_LABEL}${keepTail(latest.reply, replyBudget)}`];

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
  readonly source: "git-writing-model" | "chat-model" | "moss-managed-cheapest";
};

/**
 * Routes a prediction to the chat's own provider instance (its account). On a Moss-managed
 * instance it runs the cheapest model of the chat model's family at that model's lowest
 * effort. Elsewhere the configured Git-writing model is used only when it resolves to that
 * same instance, otherwise the chat's model; either one at its lowest catalog effort. Null
 * when the instance is missing or disabled, its driver has no dedicated text generation,
 * or the session and the thread disagree about the instance. Never another account.
 */
export function resolveComposerPredictionRouting(input: {
  readonly thread: Pick<OrchestrationThreadShell, "modelSelection" | "session">;
  readonly settings: ServerSettings;
}): ComposerPredictionRouting | null {
  const chatSelection = input.thread.modelSelection;
  const chatInstanceId = resolveModelSelectionInstanceId(chatSelection);
  const sessionInstanceId = input.thread.session?.providerInstanceId;
  if (sessionInstanceId !== undefined && sessionInstanceId !== chatInstanceId) return null;

  const instance = resolveProviderInstance(input.settings, { instanceId: chatInstanceId });
  if (!instance || !instance.enabled) return null;
  const driver = instance.driver;
  if (!hasDedicatedTextGenerationProvider(driver) || driver !== chatSelection.provider) return null;

  const managedModel = resolveMossManagedPredictionModel({
    instanceId: instance.instanceId,
    chatModel: chatSelection.model,
  });
  const configured = input.settings.textGenerationModelSelection;
  const useConfigured =
    managedModel === null &&
    configured.provider === driver &&
    resolveModelSelectionInstanceId(configured) === instance.instanceId;
  // Lowest effort on every path: a short prediction gains nothing from reasoning, and a
  // Git-writing selection without an effort would otherwise run at the Git-writing default.
  // A managed route drops the chat's other options too: fast mode, for one, bills the
  // priority tier.
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
      : withLowestEffort(useConfigured ? configured : chatSelection, driver);
  // Only the instance's own options: global defaults could name another account.
  const routed = resolveTextGenerationInputForSelection(
    { ...selection, provider: driver, instanceId: instance.instanceId } as ModelSelection,
    providerStartOptionsFromInstance(instance),
  );
  if (!routed) return null;
  return {
    ...routed,
    source:
      managedModel !== null
        ? "moss-managed-cheapest"
        : useConfigured
          ? "git-writing-model"
          : "chat-model",
  };
}
