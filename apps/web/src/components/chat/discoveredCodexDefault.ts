import type {
  ModelSelection,
  ProviderInstanceId,
  ProviderModelDescriptor,
} from "@synara/contracts";
import { normalizeModelSlug, resolveSelectableModel } from "@synara/shared/model";
import { buildModelSelection, type ProviderModelOption } from "../../providerModelOptions";
import { resolveComposerAccountSourceKind } from "./providerAccountSources";

/** A personal-account preference, backed by this exact instance's discovery. */
export function discoveredCodexDefault(input: {
  instanceId: ProviderInstanceId;
  accountId?: string | null | undefined;
  models: ReadonlyArray<ProviderModelDescriptor> | null | undefined;
  availableModels: ReadonlyArray<Pick<ProviderModelOption, "slug" | "name">>;
}): ModelSelection | null {
  if (
    input.accountId === "moss" ||
    resolveComposerAccountSourceKind({ provider: "codex", instanceId: input.instanceId }) !==
      "personal"
  ) {
    return null;
  }
  const astra = input.models?.find(
    (model) => normalizeModelSlug(model.slug, "codex") === "gpt-6-astra",
  );
  if (!astra) return null;
  const model = resolveSelectableModel("codex", astra.slug, input.availableModels);
  if (!model) return null;
  // Prefer the desktop's Extra High, even when the account also offers Ultra.
  // Never infer a reasoning level that this account did not advertise.
  const effort = ["xhigh", "high"].find((value) =>
    astra.supportedReasoningEfforts?.some((option) => option.value === value),
  );
  return buildModelSelection("codex", model, effort ? { reasoningEffort: effort } : undefined, {
    instanceId: input.instanceId,
  });
}
