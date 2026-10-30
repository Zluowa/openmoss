import type { ProviderKind, ProviderModelDescriptor } from "@synara/contracts";
import { MOSS_SOURCE_MODEL_IDS } from "@synara/shared/mossManagedModelCatalog";
import { getModelCapabilities, hasEffortLevel, trimOrNull } from "@synara/shared/model";

export type CodexReasoningEffortSupport = "supported" | "unsupported" | "unknown";

const MOSS_RUNTIME_FIRST_CODEX_MODEL_SET = new Set<string>(MOSS_SOURCE_MODEL_IDS);

// Runtime discovery is authoritative when present. Before it arrives, known static
// models can still validate built-in efforts; genuinely unknown models remain open
// to forward-compatible runtime-only values.
export function classifyProviderReasoningEffortSupport(input: {
  provider: ProviderKind;
  model: string | null | undefined;
  effort: string | null | undefined;
  runtimeModel?: ProviderModelDescriptor | undefined;
}): CodexReasoningEffortSupport {
  const effort = trimOrNull(input.effort);
  if (!effort) {
    return "unsupported";
  }

  const runtimeEfforts = input.runtimeModel?.supportedReasoningEfforts;
  if (runtimeEfforts && runtimeEfforts.length > 0) {
    return runtimeEfforts.some((candidate) => candidate.value === effort)
      ? "supported"
      : "unsupported";
  }

  // Moss source models are discovered from the running Codex account. Before
  // that descriptor arrives, keep a persisted runtime-only effort forward
  // compatible instead of applying an incomplete static ladder. Once runtime
  // discovery reports a descriptor, the branch above is authoritative.
  if (
    input.provider === "codex" &&
    input.runtimeModel === undefined &&
    MOSS_RUNTIME_FIRST_CODEX_MODEL_SET.has(input.model?.trim() ?? "")
  ) {
    return "unknown";
  }

  const staticCapabilities = getModelCapabilities(input.provider, input.model);
  if (staticCapabilities.reasoningEffortLevels.length === 0) {
    return "unknown";
  }
  return hasEffortLevel(staticCapabilities, effort) ? "supported" : "unsupported";
}

export function classifyCodexReasoningEffortSupport(
  input: Omit<Parameters<typeof classifyProviderReasoningEffortSupport>[0], "provider">,
): CodexReasoningEffortSupport {
  return classifyProviderReasoningEffortSupport({ ...input, provider: "codex" });
}
