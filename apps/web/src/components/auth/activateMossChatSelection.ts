import type { QueryClient } from "@tanstack/react-query";
import type { ThreadId } from "@synara/contracts";
import { ProviderInstanceId, type ModelSelection, type ServerSettings } from "@synara/contracts";
import type { JsonObject } from "effect/Schema";
import {
  MANAGED_GATEWAY_CODEX_DEFAULT_MODEL,
  MANAGED_GATEWAY_CODEX_ENABLED_MODELS,
} from "@synara/shared/mossManagedModelCatalog";
import { mossLaneEngineDefaultModel } from "@synara/shared/mossRealmCatalog";

import { useComposerDraftStore } from "~/composerDraftStore";
import { serverQueryKeys } from "~/lib/serverReactQuery";

const immediateManagedCodexModel = MANAGED_GATEWAY_CODEX_DEFAULT_MODEL;
const immediateCnManagedCodexModel = mossLaneEngineDefaultModel("cn", "codex");
if (!immediateManagedCodexModel) {
  throw new Error("The managed Codex default model is required for login-to-chat.");
}

function isJsonObject(value: unknown): value is JsonObject {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}
if (!immediateCnManagedCodexModel) {
  throw new Error("The CN managed Codex default model is required for phone login-to-chat.");
}

const MOSS_MANAGED_CODEX_INSTANCE_ID = ProviderInstanceId.makeUnsafe("codex_moss");

export const MOSS_IMMEDIATE_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  instanceId: MOSS_MANAGED_CODEX_INSTANCE_ID,
  model: immediateManagedCodexModel,
};

export const MOSS_CN_IMMEDIATE_MODEL_SELECTION: ModelSelection = {
  provider: "codex",
  instanceId: MOSS_MANAGED_CODEX_INSTANCE_ID,
  model: immediateCnManagedCodexModel,
};

function resolveManagedLoginSelection(
  selection: ModelSelection,
  settings: ServerSettings | undefined,
): ModelSelection | null {
  if (selection.instanceId !== "codex_moss") return selection;
  const config = settings?.providerInstances?.codex_moss?.config;
  if (isJsonObject(config) && Array.isArray(config.modelAllowlist)) {
    const allowlist = config.modelAllowlist.filter(
      (entry): entry is string => typeof entry === "string" && entry.trim().length > 0,
    );
    if (allowlist.includes(selection.model)) return selection;
    const configuredDefault = config.defaultModel;
    const defaultModel =
      typeof configuredDefault === "string" && allowlist.includes(configuredDefault)
        ? configuredDefault
        : allowlist[0];
    return defaultModel
      ? { provider: "codex", instanceId: MOSS_MANAGED_CODEX_INSTANCE_ID, model: defaultModel }
      : null;
  }
  if (MANAGED_GATEWAY_CODEX_ENABLED_MODELS.includes(selection.model)) return selection;
  return MOSS_IMMEDIATE_MODEL_SELECTION;
}

/**
 * Applies the exact managed-model selection synchronized by the login mutation.
 * A fallback is only used for an already-selected login method whose settings
 * cache has not been mounted yet. The server allowlist and default take priority
 * over the static managed catalog once authoritative settings are available.
 */
export function activateMossChatSelection(
  queryClient: QueryClient,
  fallback?: ModelSelection,
): boolean {
  const settings = queryClient.getQueryData<ServerSettings>(serverQueryKeys.settings());
  const selection = settings?.textGenerationModelSelection ?? fallback;
  if (!selection) return false;
  const resolvedSelection = resolveManagedLoginSelection(selection, settings);
  if (!resolvedSelection) return false;
  activateModelSelectionForLocalDrafts(resolvedSelection);
  return true;
}

/**
 * Mirrors the pre-merge composer draft store action using the public store
 * API: make the selection sticky, then apply it to every local (not yet
 * promoted) draft thread so login-to-chat lands on the managed model.
 */
function activateModelSelectionForLocalDrafts(selection: ModelSelection): void {
  const store = useComposerDraftStore.getState();
  store.setStickyModelSelection(selection);
  const localDraftThreadIds = Object.entries(store.draftThreadsByThreadId)
    .filter(([, draftThread]) => draftThread.promotedTo === undefined)
    .map(([threadId]) => threadId as ThreadId);
  for (const threadId of localDraftThreadIds) {
    useComposerDraftStore.getState().setModelSelection(threadId, selection);
  }
}
