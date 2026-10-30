// FILE: desktop-signing-environment.ts
// Purpose: Keeps desktop release credentials inside the platform signing subprocess boundary.
// Layer: Release/build helper

import {
  APPLE_RELEASE_SIGNING_ENV_KEYS,
  type DesktopReleasePlatform,
  WINDOWS_SIGNING_PROVIDER_ENV_KEY,
  WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS,
} from "./desktop-release-build-policy.ts";

export const APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS = [
  ...APPLE_RELEASE_SIGNING_ENV_KEYS,
  "CSC_IDENTITY_AUTO_DISCOVERY",
] as const;

export const WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS = [
  ...WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS,
  WINDOWS_SIGNING_PROVIDER_ENV_KEY,
] as const;

export const DESKTOP_SIGNING_BOUNDARY_ENV_KEYS = [
  ...APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS,
  ...WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS,
] as const;

const DESKTOP_SIGNING_BOUNDARY_ENV_KEY_SET = new Set(
  DESKTOP_SIGNING_BOUNDARY_ENV_KEYS.map((key) => key.toUpperCase()),
);

const DESKTOP_EXECUTABLE_INJECTION_ENV_KEYS = new Set([
  "BUN_OPTIONS",
  "ELECTRON_RUN_AS_NODE",
  "NODE_OPTIONS",
  "NODE_PATH",
  "NPM_CONFIG_NODE_OPTIONS",
  "OPENSSL_CONF",
]);

const DESKTOP_BUILD_NODE_OPTIONS = "--max-old-space-size=8192";
const DESKTOP_BUILD_TURBO_CONCURRENCY = "1";

function signingKeysForPlatform(
  platform: DesktopReleasePlatform,
  signed: boolean,
): ReadonlyArray<string> {
  if (!signed) return [];
  return platform === "mac"
    ? APPLE_ELECTRON_BUILDER_SIGNING_ENV_KEYS
    : platform === "win"
      ? WINDOWS_ELECTRON_BUILDER_SIGNING_ENV_KEYS
      : [];
}

function copyEnvironmentWithoutSigningKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(env)) {
    const normalizedKey = key.toUpperCase();
    if (DESKTOP_SIGNING_BOUNDARY_ENV_KEY_SET.has(normalizedKey)) continue;
    result[key] = value;
  }
  return result;
}

function isDesktopExecutableInjectionEnvKey(key: string): boolean {
  const normalizedKey = key.toUpperCase();
  return (
    DESKTOP_EXECUTABLE_INJECTION_ENV_KEYS.has(normalizedKey) ||
    normalizedKey.startsWith("LD_") ||
    normalizedKey.startsWith("DYLD_")
  );
}

function copyEnvironmentWithoutExecutableInjectionKeys(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = copyEnvironmentWithoutSigningKeys(env);
  for (const key of Object.keys(result)) {
    if (isDesktopExecutableInjectionEnvKey(key)) delete result[key];
  }
  return result;
}

export function createNonSigningSubprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return copyEnvironmentWithoutSigningKeys(env);
}

export function createDesktopBuildSubprocessEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = copyEnvironmentWithoutExecutableInjectionKeys(env);
  return {
    ...result,
    NODE_OPTIONS: DESKTOP_BUILD_NODE_OPTIONS,
    TURBO_CONCURRENCY: DESKTOP_BUILD_TURBO_CONCURRENCY,
  };
}

export function createElectronBuilderEnvironment(input: {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: DesktopReleasePlatform;
  readonly signed: boolean;
}): NodeJS.ProcessEnv {
  // Do this before adding platform signing values so host-controlled runtime
  // injection cannot execute inside the signing boundary that receives them.
  const result = copyEnvironmentWithoutExecutableInjectionKeys(input.env);
  for (const key of signingKeysForPlatform(input.platform, input.signed)) {
    const value = input.env[key];
    if (value !== undefined) result[key] = value;
  }
  for (const [key, value] of Object.entries(result)) {
    if (value === "") {
      delete result[key];
    }
  }
  if (!input.signed || input.platform !== "mac") {
    result.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  }
  return result;
}

export function createMacBuildOnlySigningEnvironment(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result = createElectronBuilderEnvironment({ env, platform: "mac", signed: false });
  for (const key of Object.keys(result)) {
    if (/^(?:APPLE_|CSC_|WIN_CSC_)/iu.test(key) || key.toUpperCase() === "DEBUG") {
      delete result[key];
    }
  }
  result.CSC_IDENTITY_AUTO_DISCOVERY = "false";
  return result;
}
