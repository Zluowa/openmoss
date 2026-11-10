// FILE: modelImageInput.ts
// Purpose: Whether the model a chat runs on can look at images. One answer for
//          the composer's warning, the model picker and a provider handoff.
// Layer: Shared runtime policy (no I/O).
// Exports: modelImageInputSupport, ModelImageInputSupport

import { MOSS_MANAGED_PROVIDER_INSTANCE_IDS } from "./mossDownloadChannel";
import { getMossManagedModelDefinition } from "./mossRealmCatalog";

/**
 * - `supported` / `unsupported`: Moss knows, from its model catalog.
 * - `unknown`: the person's own account; its CLI decides, and Moss does not
 *   guess, so nothing is blocked or warned about.
 */
export type ModelImageInputSupport = "supported" | "unsupported" | "unknown";

const MOSS_INSTANCE_IDS: ReadonlySet<string> = new Set(MOSS_MANAGED_PROVIDER_INSTANCE_IDS);

/** A Moss model id as each agent spells it: `deepseek-v4-flash`, `moss/deepseek-v4-flash`. */
function mossCatalogModelId(model: string): string {
  const trimmed = model.trim();
  return trimmed.startsWith("moss/") ? trimmed.slice("moss/".length) : trimmed;
}

export function modelImageInputSupport(input: {
  readonly instanceId: string | null | undefined;
  readonly model: string | null | undefined;
}): ModelImageInputSupport {
  if (!input.instanceId || !input.model || !MOSS_INSTANCE_IDS.has(input.instanceId)) {
    return "unknown";
  }
  const definition = getMossManagedModelDefinition(mossCatalogModelId(input.model));
  if (!definition) return "unknown";
  return definition.inputModalities.includes("image") ? "supported" : "unsupported";
}
