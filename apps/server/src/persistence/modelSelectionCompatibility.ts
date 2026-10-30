// FILE: modelSelectionCompatibility.ts
// Purpose: Normalizes persisted model-selection JSON from older/newer app builds.
// Layer: Persistence compatibility helper
// Exports: normalizeLegacyModelSelection, normalizePersistedModelSelection

import { ProviderInstanceId, type ServerSettings } from "@synara/contracts";
import { isDroidExclusiveModelSlug, isProviderKind } from "@synara/shared/providerInstances";
import { Schema } from "effect";

type ModelProviderKind =
  | "codex"
  | "claudeAgent"
  | "cursor"
  | "gemini"
  | "antigravity"
  | "grok"
  | "droid"
  | "opencode"
  | "hermes"
  | "pi"
  | "devin"
  | "omp"
  | "kimi"
  | "minimax"
  | "zcode";

// Factory-exclusive slugs stay an explicit list (shared/providerInstances):
// deriving them by diffing static catalogs steals slugs another catalog also
// lists (e.g. minimax-m3 in both droid and opencode).
const isProviderInstanceId = Schema.is(ProviderInstanceId);

const LEGACY_GEMINI_MODEL_LABELS: Readonly<Record<string, string>> = {
  "gemini-3.1-pro-preview": "Gemini 3.1 Pro",
  "gemini-3-flash-preview": "Gemini 3.5 Flash",
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function readTrimmedString(record: Record<string, unknown>, key: string): string | undefined {
  const value = record[key];
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : undefined;
}

// Imported instance ids may be runtime names rather than Moss provider literals.
function inferProviderFromLabel(label: string): ModelProviderKind | undefined {
  const lowerLabel = label.toLowerCase();
  // OMP must win over the `pi` token check: "Oh My Pi" and "OMP" labels would
  // otherwise attribute to Pi.
  if (
    /(^|[^a-z0-9])omp([^a-z0-9]|$)/u.test(lowerLabel) ||
    lowerLabel.includes("oh-my-pi") ||
    lowerLabel.includes("oh my pi")
  ) {
    return "omp";
  }
  if (/(^|[^a-z0-9])pi([^a-z0-9]|$)/u.test(lowerLabel)) {
    return "pi";
  }
  if (lowerLabel.includes("devin")) {
    return "devin";
  }
  if (lowerLabel.includes("opencode")) {
    return "opencode";
  }
  if (lowerLabel.includes("kilo")) {
    return "opencode";
  }
  if (lowerLabel.includes("cursor")) {
    return "cursor";
  }
  if (lowerLabel.includes("antigravity")) {
    return "antigravity";
  }
  if (lowerLabel.includes("claude") || lowerLabel.includes("anthropic")) {
    return "claudeAgent";
  }
  if (lowerLabel.includes("gemini") || lowerLabel.includes("google")) {
    return "antigravity";
  }
  if (lowerLabel.includes("grok") || lowerLabel.includes("xai") || lowerLabel.includes("x.ai")) {
    return "grok";
  }
  // Windsurf shares Devin credentials, so its labels attribute to the Devin provider.
  if (lowerLabel.includes("windsurf")) {
    return "devin";
  }
  if (lowerLabel.includes("hermes")) {
    return "hermes";
  }
  // Checked after Claude: the `claude_kimi` channel is Claude Code on Kimi's plan.
  if (lowerLabel.includes("kimi")) {
    return "kimi";
  }
  if (lowerLabel.includes("minimax") || lowerLabel.includes("mcode")) {
    return "minimax";
  }
  if (lowerLabel.includes("zcode")) {
    return "zcode";
  }
  if (lowerLabel.includes("droid") || lowerLabel.includes("factory")) {
    return "droid";
  }
  // Word-boundary match only: a bare substring would also catch unrelated
  // labels like "speech recognition".
  if (/(^|[^a-z0-9])cognition([^a-z0-9]|$)/u.test(lowerLabel)) {
    return "devin";
  }
  if (lowerLabel.includes("codex")) {
    return "codex";
  }
  return undefined;
}

function inferLegacyModelProvider(provider: unknown, model: string): ModelProviderKind {
  if (
    provider === "codex" ||
    provider === "claudeAgent" ||
    provider === "cursor" ||
    provider === "antigravity" ||
    provider === "grok" ||
    provider === "droid" ||
    provider === "opencode" ||
    provider === "hermes" ||
    provider === "pi" ||
    provider === "devin" ||
    provider === "omp" ||
    provider === "kimi" ||
    provider === "minimax" ||
    provider === "zcode"
  ) {
    return provider;
  }
  if (provider === "gemini") {
    return "antigravity";
  }
  if (provider === "kilo") {
    return "opencode";
  }
  if (typeof provider === "string") {
    const providerFromLabel = inferProviderFromLabel(provider);
    if (providerFromLabel !== undefined) {
      return providerFromLabel;
    }
  }
  return inferSpecificModelProvider(model) ?? "codex";
}

function inferSpecificModelProvider(model: string): ModelProviderKind | undefined {
  const lowerModel = model.toLowerCase();
  // Shared Claude/Gemini/OpenAI slugs remain ambiguous without an instance label;
  // only Factory-exclusive built-ins are safe to attribute to Droid.
  if (isDroidExclusiveModelSlug(lowerModel)) {
    return "droid";
  }
  if (lowerModel.includes("claude")) {
    return "claudeAgent";
  }
  if (lowerModel.includes("gemini")) {
    return "antigravity";
  }
  if (lowerModel.includes("grok")) {
    return "grok";
  }
  if (lowerModel.includes("devin")) {
    return "devin";
  }
  return undefined;
}

function readLegacyProviderOptions(
  options: unknown,
  provider: ModelProviderKind,
  legacyProvider?: string,
): unknown {
  if (!isRecord(options)) {
    return options;
  }
  // Selections migrated from a renamed provider (e.g. kilo → opencode) keep
  // their options scoped under the original provider key.
  const providerScopedOptions =
    options[provider] ?? (legacyProvider === undefined ? undefined : options[legacyProvider]);
  return providerScopedOptions === undefined ? options : providerScopedOptions;
}

function normalizeModelOptions(input: unknown): unknown {
  if (!Array.isArray(input)) {
    return input;
  }

  const entries: Array<readonly [string, unknown]> = [];
  for (const option of input) {
    if (!isRecord(option)) {
      return input;
    }
    const id = readTrimmedString(option, "id");
    if (id === undefined) {
      return input;
    }
    entries.push([id, option.value]);
  }
  return Object.fromEntries(entries);
}

function splitLegacyAntigravityModelLabel(model: string): {
  model: string;
  reasoningEffort?: string;
} {
  const match = model.trim().match(/^(.*?)\s+\(([^()]+)\)$/u);
  if (!match?.[1] || !match[2]) {
    return { model };
  }
  const reasoningEffort = match[2].trim().toLowerCase();
  if (!new Set(["low", "medium", "high", "thinking"]).has(reasoningEffort)) {
    return { model };
  }
  return {
    model: match[1].trim(),
    reasoningEffort,
  };
}

function migrateLegacyGeminiModel(model: string): string {
  const trimmed = model.trim();
  return LEGACY_GEMINI_MODEL_LABELS[trimmed.toLowerCase()] ?? trimmed;
}

export function normalizeLegacyModelSelection(input: {
  readonly provider: unknown;
  readonly instanceId?: unknown;
  readonly model: string;
  readonly options: unknown;
}): Record<string, unknown> {
  const provider = inferLegacyModelProvider(input.provider, input.model);
  const migratedGeminiSelection = input.provider === "gemini";
  const normalizedOptions = migratedGeminiSelection
    ? undefined
    : normalizeModelOptions(
        readLegacyProviderOptions(
          input.options,
          provider,
          typeof input.provider === "string" ? input.provider : undefined,
        ),
      );
  const antigravityModel =
    provider === "antigravity"
      ? splitLegacyAntigravityModelLabel(
          migratedGeminiSelection ? migrateLegacyGeminiModel(input.model) : input.model,
        )
      : null;
  const options =
    antigravityModel?.reasoningEffort &&
    (normalizedOptions === undefined || isRecord(normalizedOptions))
      ? {
          ...(isRecord(normalizedOptions) ? normalizedOptions : {}),
          reasoningEffort: antigravityModel.reasoningEffort,
        }
      : normalizedOptions;
  const instanceId =
    typeof input.instanceId === "string" && isProviderInstanceId(input.instanceId.trim())
      ? input.instanceId.trim()
      : undefined;
  return {
    provider,
    ...(instanceId !== undefined ? { instanceId } : {}),
    model: antigravityModel?.model ?? input.model,
    ...(options === undefined ? {} : { options }),
  };
}

function resolveProviderFromSettings(
  settings: ServerSettings | undefined,
  instanceId: string | undefined,
): ModelProviderKind | undefined {
  if (!settings || instanceId === undefined) {
    return undefined;
  }
  const raw = settings.providerInstances[instanceId];
  if (!raw || !isProviderKind(raw.driver)) {
    return undefined;
  }
  // Kilo is retired; legacy instances decode to the opencode driver.
  const driver = raw.driver === "kilo" ? "opencode" : raw.driver;
  return driver;
}

export function normalizePersistedModelSelection(
  input: unknown,
  settings?: ServerSettings,
): unknown {
  if (!isRecord(input)) {
    return input;
  }

  const model = readTrimmedString(input, "model");
  if (model === undefined) {
    return input;
  }

  // Newer Moss writes provider-less selections as { instanceId, model } and
  // option rows as [{ id, value }]; Moss stores canonical provider/options objects.
  const instanceId = readTrimmedString(input, "instanceId");
  const providerFromSettings = resolveProviderFromSettings(settings, instanceId);
  if (
    input.provider === undefined &&
    providerFromSettings === undefined &&
    instanceId !== undefined &&
    inferProviderFromLabel(instanceId) === undefined &&
    inferSpecificModelProvider(model) === undefined
  ) {
    return input;
  }
  return normalizeLegacyModelSelection({
    provider: input.provider ?? providerFromSettings ?? instanceId,
    instanceId,
    model,
    options: input.options,
  });
}
