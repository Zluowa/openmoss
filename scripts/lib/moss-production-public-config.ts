// FILE: moss-production-public-config.ts
// Purpose: Creates the allowlisted public configuration resource for strict production builds.
// Layer: Release/build helper

import {
  MOSS_PRODUCTION_PUBLIC_CONFIG_FILE,
  MOSS_PUBLIC_MAP_KEY_PATTERN,
  MOSS_PUBLIC_MAPS_ENV,
  MossProductionPublicConfigError,
  resolveMossProductionPublicConfig,
  serializeMossProductionPublicConfig,
  type MossProductionPublicConfig,
  type MossPublicMapsEnvKey,
} from "@moss/shared/mossProductionPublicConfig";
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

/** The names in the operator's maps env file, and the build setting each one fills. */
export const MOSS_RELEASE_MAPS_ENV_FILE_KEYS = {
  MOSS_RELEASE_GOOGLE_MAPS_API_KEY: MOSS_PUBLIC_MAPS_ENV.googleApiKey,
  MOSS_RELEASE_AMAP_JS_KEY: MOSS_PUBLIC_MAPS_ENV.amapKey,
  MOSS_RELEASE_AMAP_SECURITY_CODE: MOSS_PUBLIC_MAPS_ENV.amapSecurityCode,
} as const;

export type MossPublicMapsEnvOverlay = Readonly<Record<MossPublicMapsEnvKey, string>>;

/**
 * Reads the operator's maps env file (NAME=value lines, # comments, blank lines) into the map
 * settings the strict build embeds. A name the file leaves out ships empty. Messages name the
 * line or setting, never a value.
 */
export function parseMossReleaseMapsEnvFile(text: string): MossPublicMapsEnvOverlay {
  const overlay: Record<MossPublicMapsEnvKey, string> = {
    [MOSS_PUBLIC_MAPS_ENV.googleApiKey]: "",
    [MOSS_PUBLIC_MAPS_ENV.amapKey]: "",
    [MOSS_PUBLIC_MAPS_ENV.amapSecurityCode]: "",
  };
  const seen = new Set<string>();
  const lines = text.replace(/^﻿/u, "").split(/\r?\n/u);
  for (const [index, line] of lines.entries()) {
    const entry = line.trim();
    if (!entry || entry.startsWith("#")) continue;
    const lineNumber = index + 1;
    const separator = entry.indexOf("=");
    const name = separator > 0 ? entry.slice(0, separator).trim() : "";
    if (!/^[A-Z][A-Z0-9_]*$/u.test(name)) {
      throw new MossProductionPublicConfigError(
        `Maps env file line ${lineNumber} must be NAME=value.`,
      );
    }
    if (!Object.hasOwn(MOSS_RELEASE_MAPS_ENV_FILE_KEYS, name)) {
      throw new MossProductionPublicConfigError(
        `Maps env file line ${lineNumber} sets unknown setting ${name}.`,
      );
    }
    if (seen.has(name)) {
      throw new MossProductionPublicConfigError(
        `Maps env file line ${lineNumber} sets ${name} a second time.`,
      );
    }
    seen.add(name);
    const value = entry.slice(separator + 1).trim();
    if (!MOSS_PUBLIC_MAP_KEY_PATTERN.test(value)) {
      throw new MossProductionPublicConfigError(
        `Maps env file line ${lineNumber}: ${name} must be a map key of letters, digits, _ and -.`,
      );
    }
    overlay[MOSS_RELEASE_MAPS_ENV_FILE_KEYS[name as keyof typeof MOSS_RELEASE_MAPS_ENV_FILE_KEYS]] =
      value;
  }
  return overlay;
}

/** Says which map keys are set, for the build log, without any value. */
export function describeMossPublicMapsEnvOverlay(overlay: MossPublicMapsEnvOverlay): string {
  const state = (key: MossPublicMapsEnvKey) => (overlay[key] ? "set" : "empty");
  return [
    `google ${state(MOSS_PUBLIC_MAPS_ENV.googleApiKey)}`,
    `amap key ${state(MOSS_PUBLIC_MAPS_ENV.amapKey)}`,
    `amap security code ${state(MOSS_PUBLIC_MAPS_ENV.amapSecurityCode)}`,
  ].join(", ");
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
