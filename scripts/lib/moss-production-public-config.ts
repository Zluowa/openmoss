// FILE: moss-production-public-config.ts
// Purpose: Creates the allowlisted public configuration resource for strict production builds.
// Layer: Release/build helper

import {
  MOSS_PRODUCTION_PUBLIC_CONFIG_FILE,
  resolveMossProductionPublicConfig,
  serializeMossProductionPublicConfig,
  type MossProductionPublicConfig,
} from "@synara/shared/mossProductionPublicConfig";
import { Effect, FileSystem, Path } from "effect";

export const MOSS_PRODUCTION_CONFIG_MODES = ["off", "strict"] as const;
export type MossProductionConfigMode = (typeof MOSS_PRODUCTION_CONFIG_MODES)[number];

export interface MossProductionPublicConfigResource {
  readonly config: MossProductionPublicConfig;
  readonly contents: string;
  readonly fileName: typeof MOSS_PRODUCTION_PUBLIC_CONFIG_FILE;
}

export interface MossProductionPublicConfigExtraResource {
  readonly from: string;
  readonly to: typeof MOSS_PRODUCTION_PUBLIC_CONFIG_FILE;
}

export function createMossProductionPublicConfigExtraResource(): MossProductionPublicConfigExtraResource {
  return {
    from: `apps/desktop/resources/${MOSS_PRODUCTION_PUBLIC_CONFIG_FILE}`,
    to: MOSS_PRODUCTION_PUBLIC_CONFIG_FILE,
  };
}

export function createMossProductionPublicConfigResource(input: {
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly mode: MossProductionConfigMode;
}): MossProductionPublicConfigResource | null {
  if (input.mode === "off") {
    return null;
  }

  const config = resolveMossProductionPublicConfig(input.env);
  return {
    config,
    contents: serializeMossProductionPublicConfig(config),
    fileName: MOSS_PRODUCTION_PUBLIC_CONFIG_FILE,
  };
}

/** Applies public routing policy only to an already-copied artifact stage. */
export const stageMossProductionPublicConfigResource = Effect.fn(
  "stageMossProductionPublicConfigResource",
)(function* (stageResourcesDir: string, resource: MossProductionPublicConfigResource | null) {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const resourcePath = path.join(stageResourcesDir, MOSS_PRODUCTION_PUBLIC_CONFIG_FILE);
  if (resource) yield* fs.writeFileString(resourcePath, resource.contents);
  else yield* fs.remove(resourcePath, { force: true });
});
