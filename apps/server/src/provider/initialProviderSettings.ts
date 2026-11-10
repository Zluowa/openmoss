// FILE: initialProviderSettings.ts
// Purpose: Selects only bundled agents and actual local CLI installations on first launch.
// Layer: Server provider discovery
// Exports: initialProviderSettings

import type { ProviderKind, ServerSettings } from "@moss/contracts";
import { executableCandidates, isExecutableFile } from "@moss/shared/executable";
import { PROVIDER_CLI_COMMAND_BY_KIND } from "@moss/shared/providerCliProfiles";

import { ensureAgentCliPath } from "./agentCliPathFloor.ts";

export async function initialProviderSettings(
  defaults: ServerSettings,
  mossHomeDir: string,
  options: {
    readonly preparePath?: () => Promise<unknown>;
    readonly hasCommand?: (command: string) => Promise<boolean>;
  } = {},
): Promise<ServerSettings> {
  // Discovery is best-effort: a registry or directory scan must never prevent
  // a new user from opening Moss and using its bundled agents.
  await (options.preparePath ?? (() => ensureAgentCliPath(mossHomeDir)))().catch(() => undefined);
  const hasCommand =
    options.hasCommand ??
    (async (command: string) => {
      // Missing, inaccessible and non-executable candidates are not installations. The shared
      // platform rule decides what counts as executable (a launchable extension on Windows,
      // the execute bit elsewhere), the same rule a launch of the command uses.
      for (const candidate of executableCandidates(command)) {
        if (isExecutableFile(candidate.path)) return true;
      }
      return false;
    });
  const providers = Object.fromEntries(
    await Promise.all(
      Object.entries(defaults.providers).map(async ([provider, settings]) => [
        provider,
        {
          ...settings,
          enabled:
            provider === "codex" ||
            provider === "claudeAgent" ||
            (provider !== "droid" &&
              provider !== "kilo" &&
              (await hasCommand(PROVIDER_CLI_COMMAND_BY_KIND[provider as ProviderKind]))),
        },
      ]),
    ),
  ) as ServerSettings["providers"];
  return { ...defaults, providers };
}
