import type { ModelSelection } from "@synara/contracts";
import { getModelSelectionBooleanOptionValue } from "@synara/shared/model";

export function resolveCodexServiceTier(
  modelSelection: ModelSelection | undefined,
): "fast" | "default" | undefined {
  // Instance-less selections fall back to the provider id (legacy "codex" is
  // the default instance), matching the pre-instance-id contract.
  const instanceId = modelSelection?.instanceId ?? modelSelection?.provider;
  if (!modelSelection || !instanceId?.toLowerCase().startsWith("codex")) {
    return undefined;
  }

  const fastMode = getModelSelectionBooleanOptionValue(modelSelection, "fastMode");
  if (fastMode === undefined) return undefined;

  // Omitting the tier preserves Codex's previous value, including Fast mode.
  return fastMode ? "fast" : "default";
}
