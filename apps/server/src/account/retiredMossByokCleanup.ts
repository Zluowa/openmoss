// FILE: retiredMossByokCleanup.ts
// Purpose: Remove the retired single-model "Moss Key" (BYOK) provider surface
// from settings. It stored a raw provider key in the `codex_byok` instance
// environment; enterprise API keys replace it as a full sign-in lane.
// Layer: account (server startup maintenance).
import {
  DEFAULT_CODEX_ACCOUNT_ID,
  DEFAULT_GIT_TEXT_GENERATION_MODEL,
  type ProviderInstanceConfigMap,
  type ServerSettings,
  type ServerSettingsPatch,
} from "@synara/contracts";
import { Effect } from "effect";

import type { ServerSettingsShape } from "../serverSettings";

const RETIRED_INSTANCE_ID = "codex_byok";
const RETIRED_ACCOUNT_ID = "byok";

/** Settings patch that removes the retired surface, or null when none remains. */
export function buildRetiredMossByokCleanupPatch(
  settings: ServerSettings,
): ServerSettingsPatch | null {
  const codex = settings.providers.codex;
  const hasInstance = Object.hasOwn(settings.providerInstances, RETIRED_INSTANCE_ID);
  const hasAccount = codex.accounts.some((account) => account.id === RETIRED_ACCOUNT_ID);
  if (!hasInstance && !hasAccount) return null;

  const providerInstances = Object.fromEntries(
    Object.entries(settings.providerInstances).filter(
      ([instanceId]) => instanceId !== RETIRED_INSTANCE_ID,
    ),
  ) as ProviderInstanceConfigMap;
  return {
    providers: {
      codex: {
        accounts: codex.accounts.filter((account) => account.id !== RETIRED_ACCOUNT_ID),
        ...(codex.selectedAccountId === RETIRED_ACCOUNT_ID
          ? { selectedAccountId: DEFAULT_CODEX_ACCOUNT_ID }
          : {}),
      },
    },
    providerInstances,
    ...(settings.textGenerationModelSelection.instanceId === RETIRED_INSTANCE_ID
      ? {
          textGenerationModelSelection: {
            provider: "codex",
            instanceId: "codex",
            model: DEFAULT_GIT_TEXT_GENERATION_MODEL,
          },
        }
      : {}),
  };
}

export const retireMossByokSettings = (settingsService: ServerSettingsShape) =>
  Effect.gen(function* () {
    const settings = yield* settingsService.getSettings;
    if (!buildRetiredMossByokCleanupPatch(settings)) return false;
    // Re-derive inside the write lock so concurrent edits are preserved.
    yield* settingsService.updateSettings(
      {},
      (current) => buildRetiredMossByokCleanupPatch(current) ?? {},
    );
    return true;
  });
