// FILE: composerProviderRegistry.tsx
// Purpose: Normalizes provider-specific composer state for display and dispatch.
// Layer: Chat composer orchestration
// Depends on: shared model helpers and runtime model discovery metadata.

import {
  type ModelSlug,
  type ThreadId,
  type ProviderAgentDescriptor,
  type ProviderInstanceId,
  type ProviderKind,
  type ProviderModelDescriptor,
  type ProviderModelOptions,
  GEMINI_THINKING_BUDGET_OPTIONS,
  GEMINI_THINKING_LEVEL_OPTIONS,
  type GeminiModelOptions,
  type GeminiThinkingBudget,
  type GeminiThinkingLevel,
  type ModelCapabilities,
} from "@synara/contracts";
import {
  getDefaultContextWindow,
  getDefaultEffort,
  hasContextWindowOption,
  hasEffortLevel,
  isClaudeUltrathinkPrompt,
  normalizeAntigravityModelOptions,
  normalizeClaudeModelOptions,
  normalizeCursorModelOptions,
  normalizeOmpModelOptions,
  normalizeOpenCodeModelOptions,
  normalizePiModelOptions,
  resolveDevinModelVariant,
  resolveLabeledOptionValue,
  trimOrNull,
  getModelCapabilities,
} from "@synara/shared/model";
import type { ReactNode } from "react";
import { TraitsMenuContent, TraitsPicker } from "./TraitsPicker";
import { getComposerTraitSelection, hasVisibleComposerTraitControls } from "./composerTraits";
import { classifyCodexReasoningEffortSupport } from "../../lib/codexReasoningEffort";
import { getRuntimeAwareModelCapabilities } from "./runtimeModelCapabilities";

export type ComposerProviderStateInput = {
  provider: ProviderKind;
  model: ModelSlug;
  runtimeModel?: ProviderModelDescriptor | undefined;
  prompt: string;
  modelOptions: ProviderModelOptions | null | undefined;
};

export type ComposerProviderState = {
  provider: ProviderKind;
  promptEffort: string | null;
  modelOptionsForDispatch: ProviderModelOptions[ProviderKind] | undefined;
  composerFrameClassName?: string;
  composerSurfaceClassName?: string;
  modelPickerIconClassName?: string;
};

type ProviderTraitRenderInput = {
  threadId: ThreadId;
  model: ModelSlug;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  selectedProviderInstanceId?: ProviderInstanceId | null | undefined;
  prompt: string;
  includeFastMode?: boolean;
  onPromptChange: (prompt: string) => void;
};

type ProviderTraitPickerRenderInput = ProviderTraitRenderInput & {
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
};

type ProviderRegistryEntry = {
  getState: (input: ComposerProviderStateInput) => ComposerProviderState;
  renderTraitsMenuContent: (input: ProviderTraitRenderInput) => ReactNode;
  renderTraitsPicker: (input: ProviderTraitPickerRenderInput) => ReactNode;
};

function renderTraitsMenuContentForProvider(
  provider: ProviderKind,
  input: ProviderTraitRenderInput,
): ReactNode {
  return (
    <TraitsMenuContent
      provider={provider}
      threadId={input.threadId}
      model={input.model}
      runtimeModel={input.runtimeModel}
      runtimeModels={input.runtimeModels}
      runtimeAgents={input.runtimeAgents}
      modelOptions={input.modelOptions}
      selectedProviderInstanceId={input.selectedProviderInstanceId}
      prompt={input.prompt}
      {...(input.includeFastMode === undefined ? {} : { includeFastMode: input.includeFastMode })}
      onPromptChange={input.onPromptChange}
    />
  );
}

function renderTraitsPickerForProvider(
  provider: ProviderKind,
  input: ProviderTraitPickerRenderInput,
): ReactNode {
  return (
    <TraitsPicker
      provider={provider}
      threadId={input.threadId}
      model={input.model}
      runtimeModel={input.runtimeModel}
      runtimeModels={input.runtimeModels}
      runtimeAgents={input.runtimeAgents}
      modelOptions={input.modelOptions}
      selectedProviderInstanceId={input.selectedProviderInstanceId}
      prompt={input.prompt}
      {...(input.open !== undefined ? { open: input.open } : {})}
      {...(input.onOpenChange ? { onOpenChange: input.onOpenChange } : {})}
      {...(input.shortcutLabel !== undefined ? { shortcutLabel: input.shortcutLabel } : {})}
      {...(input.includeFastMode === undefined ? {} : { includeFastMode: input.includeFastMode })}
      onPromptChange={input.onPromptChange}
    />
  );
}

function getProviderStateFromCapabilities(
  input: ComposerProviderStateInput,
): ComposerProviderState {
  const { provider, model, runtimeModel, prompt, modelOptions } = input;
  if (provider === "kilo") {
    // Kilo is retired; historical selections decode to OpenCode upstream.
    return {
      provider,
      promptEffort: null,
      modelOptionsForDispatch: undefined,
    };
  }
  const caps = getRuntimeAwareModelCapabilities({ provider, model, runtimeModel });

  let rawEffort: string | null = null;
  let normalizedOptions: ProviderModelOptions[ProviderKind] | undefined;

  switch (provider) {
    case "codex": {
      const providerOptions = modelOptions?.codex;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffortSupport = classifyCodexReasoningEffortSupport({
        model,
        effort: rawEffort,
        ...(runtimeModel ? { runtimeModel } : {}),
      });
      const reasoningEffort =
        rawEffort &&
        reasoningEffortSupport !== "unsupported" &&
        rawEffort !== defaultReasoningEffort
          ? rawEffort
          : undefined;
      const fastModeEnabled = caps.supportsFastMode && providerOptions?.fastMode === true;
      const nextOptions = {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fastModeEnabled || providerOptions?.fastMode === false
          ? { fastMode: fastModeEnabled }
          : {}),
      };
      normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
      break;
    }
    case "claudeAgent": {
      const providerOptions = modelOptions?.claudeAgent;
      rawEffort = trimOrNull(providerOptions?.effort);
      normalizedOptions = normalizeClaudeModelOptions(model, providerOptions, caps);
      break;
    }
    case "cursor": {
      const providerOptions = modelOptions?.cursor;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      normalizedOptions = normalizeCursorModelOptions(model, providerOptions, caps);
      break;
    }
    case "gemini": {
      const providerOptions = modelOptions?.gemini;
      rawEffort = getGeminiThinkingSelectionValue(caps, providerOptions);
      normalizedOptions = normalizeGeminiModelOptions(model, providerOptions);
      break;
    }
    case "antigravity": {
      const providerOptions = modelOptions?.antigravity;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      normalizedOptions = normalizeAntigravityModelOptions(model, providerOptions, caps);
      break;
    }
    case "grok": {
      const providerOptions = modelOptions?.grok;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) && rawEffort !== defaultReasoningEffort
          ? providerOptions?.reasoningEffort
          : undefined;
      normalizedOptions = reasoningEffort ? { reasoningEffort } : undefined;
      break;
    }
    case "droid": {
      const providerOptions = modelOptions?.droid;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      // Droid's advertised "default" is the mutable current CLI preference.
      // Once the user selects an effort, always dispatch it explicitly.
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) ? providerOptions?.reasoningEffort : undefined;
      normalizedOptions = reasoningEffort ? { reasoningEffort } : undefined;
      break;
    }
    case "opencode": {
      const providerOptions = modelOptions?.opencode;
      rawEffort = trimOrNull(providerOptions?.variant);
      const variantOptions = caps.variantOptions ?? [];
      const reasoningVariant =
        rawEffort && variantOptions.some((option) => option.value === rawEffort)
          ? rawEffort
          : undefined;
      const agent = trimOrNull(providerOptions?.agent);
      if (variantOptions.length > 0) {
        const nextOptions = {
          ...(reasoningVariant ? { variant: reasoningVariant } : {}),
          ...(agent ? { agent } : {}),
        };
        normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
        break;
      }
      normalizedOptions = normalizeOpenCodeModelOptions(providerOptions);
      break;
    }
    case "hermes": {
      normalizedOptions = undefined;
      break;
    }
    case "kimi":
    case "minimax":
    case "zcode": {
      // The ACP agents advertise a per-model thought level ladder at runtime;
      // only an explicit non-default pick is dispatched.
      const providerOptions = modelOptions?.[provider];
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) && rawEffort !== defaultReasoningEffort
          ? rawEffort
          : undefined;
      normalizedOptions = reasoningEffort ? { reasoningEffort } : undefined;
      break;
    }
    case "pi": {
      const providerOptions = modelOptions?.pi;
      rawEffort = trimOrNull(providerOptions?.thinkingLevel);
      normalizedOptions = normalizePiModelOptions(providerOptions);
      break;
    }
    case "devin": {
      const providerOptions = modelOptions?.devin;
      rawEffort = trimOrNull(providerOptions?.reasoningEffort);
      const defaultReasoningEffort = getDefaultEffort(caps);
      const reasoningEffort =
        rawEffort && hasEffortLevel(caps, rawEffort) && rawEffort !== defaultReasoningEffort
          ? rawEffort
          : undefined;
      const rawContextWindow = trimOrNull(providerOptions?.contextWindow);
      const defaultContextWindow = getDefaultContextWindow(caps);
      const contextWindow =
        rawContextWindow &&
        hasContextWindowOption(caps, rawContextWindow) &&
        rawContextWindow !== defaultContextWindow
          ? rawContextWindow
          : undefined;
      const fastModeEnabled = caps.supportsFastMode && providerOptions?.fastMode === true;
      const requestedThinking =
        caps.supportsThinkingToggle && providerOptions?.thinking !== undefined
          ? providerOptions.thinking
          : undefined;
      const modelVariant = resolveDevinModelVariant({
        model,
        runtimeModel,
        modelVariant: providerOptions?.modelVariant,
        reasoningEffort: rawEffort && hasEffortLevel(caps, rawEffort) ? rawEffort : undefined,
        fastMode: caps.supportsFastMode ? providerOptions?.fastMode : undefined,
        thinking: requestedThinking,
        contextWindow:
          rawContextWindow && hasContextWindowOption(caps, rawContextWindow)
            ? rawContextWindow
            : undefined,
      });
      const nextOptions = {
        ...(reasoningEffort ? { reasoningEffort } : {}),
        ...(fastModeEnabled ? { fastMode: true } : {}),
        ...(requestedThinking !== undefined ? { thinking: requestedThinking } : {}),
        ...(contextWindow ? { contextWindow } : {}),
        ...(modelVariant &&
        (Boolean(reasoningEffort) ||
          fastModeEnabled ||
          requestedThinking !== undefined ||
          Boolean(contextWindow) ||
          Boolean(providerOptions?.modelVariant))
          ? { modelVariant }
          : {}),
      };
      normalizedOptions = Object.keys(nextOptions).length > 0 ? nextOptions : undefined;
      break;
    }
    case "omp": {
      const providerOptions = modelOptions?.omp;
      rawEffort = trimOrNull(providerOptions?.thinkingLevel);
      normalizedOptions = normalizeOmpModelOptions(providerOptions);
      break;
    }
  }

  const draftEffort = trimOrNull(rawEffort);
  const defaultEffort = getDefaultEffort(caps);
  const isPromptInjected = draftEffort
    ? caps.promptInjectedEffortLevels.includes(draftEffort)
    : false;
  const promptEffort =
    provider === "opencode"
      ? resolveLabeledOptionValue(caps.variantOptions, draftEffort)
      : draftEffort &&
          !isPromptInjected &&
          (provider === "codex"
            ? classifyCodexReasoningEffortSupport({
                model,
                effort: draftEffort,
                ...(runtimeModel ? { runtimeModel } : {}),
              }) !== "unsupported"
            : hasEffortLevel(caps, draftEffort))
        ? draftEffort
        : defaultEffort && hasEffortLevel(caps, defaultEffort)
          ? defaultEffort
          : null;

  const ultrathinkActive =
    caps.promptInjectedEffortLevels.length > 0 && isClaudeUltrathinkPrompt(prompt);

  return {
    provider,
    promptEffort,
    modelOptionsForDispatch: normalizedOptions,
    ...(ultrathinkActive ? { composerFrameClassName: "ultrathink-frame" } : {}),
    ...(ultrathinkActive ? { modelPickerIconClassName: "ultrathink-chroma" } : {}),
  };
}

// Gemini thinking selection helpers live here because the merged shared model module
// dropped them; they mirror the Moss shared implementations exactly.
const GEMINI_THINKING_LEVEL_SET: ReadonlySet<string> = new Set(GEMINI_THINKING_LEVEL_OPTIONS);
const GEMINI_THINKING_BUDGET_MAP: ReadonlyMap<string, GeminiThinkingBudget> = new Map(
  GEMINI_THINKING_BUDGET_OPTIONS.map((budget) => [String(budget), budget] as const),
);

function isGeminiThinkingLevelValue(value: string): boolean {
  return GEMINI_THINKING_LEVEL_SET.has(value);
}

function getGeminiThinkingSelectionValue(
  caps: ModelCapabilities,
  modelOptions: GeminiModelOptions | null | undefined,
): string | null {
  const candidates = [
    trimOrNull(modelOptions?.thinkingLevel),
    modelOptions?.thinkingBudget !== undefined ? String(modelOptions.thinkingBudget) : null,
  ];

  return (
    candidates.find(
      (candidate): candidate is string => !!candidate && hasEffortLevel(caps, candidate),
    ) ??
    candidates.find((candidate): candidate is string => !!candidate) ??
    null
  );
}

function geminiModelOptionsFromEffortValue(
  value: string | null | undefined,
): GeminiModelOptions | undefined {
  const trimmed = trimOrNull(value);
  if (!trimmed) {
    return undefined;
  }
  if (isGeminiThinkingLevelValue(trimmed)) {
    return { thinkingLevel: trimmed as GeminiThinkingLevel };
  }
  const budget = GEMINI_THINKING_BUDGET_MAP.get(trimmed);
  if (budget !== undefined) {
    return { thinkingBudget: budget };
  }
  return undefined;
}

function normalizeGeminiModelOptions(
  model: string | null | undefined,
  modelOptions: GeminiModelOptions | null | undefined,
): GeminiModelOptions | undefined {
  const caps = getModelCapabilities("gemini", model);
  const effort = getGeminiThinkingSelectionValue(caps, modelOptions);
  if (!effort || !hasEffortLevel(caps, effort)) {
    return undefined;
  }
  const defaultEffort = getDefaultEffort(caps);
  const nextOptions = geminiModelOptionsFromEffortValue(effort);
  if (!nextOptions) {
    return undefined;
  }

  const normalizedEffort =
    nextOptions.thinkingLevel !== undefined
      ? nextOptions.thinkingLevel
      : String(nextOptions.thinkingBudget);
  if (normalizedEffort === defaultEffort) {
    return undefined;
  }

  return nextOptions;
}

const composerProviderRegistry: Record<ProviderKind, ProviderRegistryEntry> = {
  hermes: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
  codex: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("codex", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("codex", input),
  },
  claudeAgent: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("claudeAgent", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("claudeAgent", input),
  },
  cursor: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("cursor", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("cursor", input),
  },
  gemini: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("gemini", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("gemini", input),
  },
  antigravity: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("antigravity", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("antigravity", input),
  },
  grok: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("grok", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("grok", input),
  },
  devin: {
    // Devin is present in the registry for explicitly discovered instances;
    // availability remains gated by the model catalog, not this static entry.
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("devin", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("devin", input),
  },
  droid: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
  kilo: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
  opencode: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("opencode", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("opencode", input),
  },
  pi: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("pi", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("pi", input),
  },
  omp: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: () => null,
    renderTraitsPicker: () => null,
  },
  kimi: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("kimi", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("kimi", input),
  },
  minimax: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("minimax", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("minimax", input),
  },
  zcode: {
    getState: (input) => getProviderStateFromCapabilities(input),
    renderTraitsMenuContent: (input) => renderTraitsMenuContentForProvider("zcode", input),
    renderTraitsPicker: (input) => renderTraitsPickerForProvider("zcode", input),
  },
};

export function getComposerProviderState(input: ComposerProviderStateInput): ComposerProviderState {
  return composerProviderRegistry[input.provider].getState(input);
}

export function renderProviderTraitsMenuContent(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: ModelSlug;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  selectedProviderInstanceId?: ProviderInstanceId | null | undefined;
  prompt: string;
  includeFastMode?: boolean;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  const selection = getComposerTraitSelection(
    input.provider,
    input.model,
    input.prompt,
    input.modelOptions,
    input.runtimeModel,
  );
  if (
    !hasVisibleComposerTraitControls(
      selection,
      input.includeFastMode === undefined ? undefined : { includeFastMode: input.includeFastMode },
    ) &&
    (input.provider !== "opencode" || (input.runtimeAgents?.length ?? 0) === 0)
  ) {
    return null;
  }
  return composerProviderRegistry[input.provider].renderTraitsMenuContent(input);
}

export function renderProviderTraitsPicker(input: {
  provider: ProviderKind;
  threadId: ThreadId;
  model: ModelSlug;
  runtimeModel?: ProviderModelDescriptor | undefined;
  runtimeModels?: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  runtimeAgents?: ReadonlyArray<ProviderAgentDescriptor> | null | undefined;
  modelOptions: ProviderModelOptions[ProviderKind] | undefined;
  prompt: string;
  includeFastMode?: boolean;
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
  shortcutLabel?: string | null;
  onPromptChange: (prompt: string) => void;
}): ReactNode {
  const selection = getComposerTraitSelection(
    input.provider,
    input.model,
    input.prompt,
    input.modelOptions,
    input.runtimeModel,
  );
  if (
    !hasVisibleComposerTraitControls(
      selection,
      input.includeFastMode === undefined ? undefined : { includeFastMode: input.includeFastMode },
    ) &&
    (input.provider !== "opencode" || (input.runtimeAgents?.length ?? 0) === 0)
  ) {
    return null;
  }
  return composerProviderRegistry[input.provider].renderTraitsPicker(input);
}
