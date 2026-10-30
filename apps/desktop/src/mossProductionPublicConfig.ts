// FILE: mossProductionPublicConfig.ts
// Purpose: Loads the signed release's non-secret Moss service configuration for the backend.
// Layer: Electron main process helper

import * as FS from "node:fs";

import {
  applyMossProductionPublicConfigEnv,
  MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
  MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
  parseMossProductionPublicConfig,
  type MossProductionPublicConfig,
} from "@synara/shared/mossProductionPublicConfig";

export function loadMossProductionPublicConfig(input: {
  readonly isPackaged: boolean;
  readonly resourcePath: string | null;
}): MossProductionPublicConfig | null {
  if (!input.isPackaged || !input.resourcePath) {
    return null;
  }

  let contents: string;
  try {
    contents = FS.readFileSync(input.resourcePath, "utf8");
  } catch (cause) {
    if ((cause as NodeJS.ErrnoException | undefined)?.code === "ENOENT") {
      return null;
    }
    throw new Error(`Could not read Moss production public config at ${input.resourcePath}.`, {
      cause,
    });
  }

  try {
    return parseMossProductionPublicConfig(contents);
  } catch (cause) {
    throw new Error(`Moss production public config at ${input.resourcePath} is invalid.`, {
      cause,
    });
  }
}

export function mergeMossProductionPublicConfigIntoEnv(
  env: NodeJS.ProcessEnv,
  config: MossProductionPublicConfig | null,
  options: { readonly isPackaged: boolean },
): NodeJS.ProcessEnv {
  if (config) return applyMossProductionPublicConfigEnv(env, config);
  const merged = { ...env };
  if (options.isPackaged) {
    // A packaged process must never inherit v1's single-region aliases, including an internal QA
    // package with production-config=off. Missing v2 config therefore disables managed cloud
    // routing instead of silently reviving a legacy authority from the launch environment.
    for (const key of MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS) {
      delete merged[key];
    }
    for (const key of MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS) {
      delete merged[key];
    }
  }
  return merged;
}
