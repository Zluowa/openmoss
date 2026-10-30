// FILE: desktop-release-build-policy.ts
// Purpose: Enforces fail-closed desktop artifact requirements for public releases.
// Layer: Release/build helper
// Depends on: Explicit release intent, platform signing state, and public config mode.

export const DESKTOP_RELEASE_MODES = ["build-only", "publish"] as const;

export type DesktopReleaseMode = (typeof DESKTOP_RELEASE_MODES)[number];
export type DesktopReleasePlatform = "linux" | "mac" | "win";
export type DesktopProductionConfigMode = "off" | "strict";

export const WINDOWS_SIGNING_PROVIDERS = ["sslcom"] as const;
export type WindowsSigningProvider = (typeof WINDOWS_SIGNING_PROVIDERS)[number];
export const WINDOWS_SIGNING_PROVIDER_ENV_KEY = "WINDOWS_SIGNING_PROVIDER";

export const APPLE_RELEASE_SIGNING_ENV_KEYS = [
  "CSC_LINK",
  "CSC_KEY_PASSWORD",
  "APPLE_API_KEY",
  "APPLE_API_KEY_ID",
  "APPLE_API_ISSUER",
] as const;

export const WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS = [
  "SSL_COM_ES_USERNAME",
  "SSL_COM_ES_PASSWORD",
  "SSL_COM_CREDENTIAL_ID",
  "SSL_COM_TOTP_SECRET",
  "SSL_COM_PUBLISHER_NAME",
  "SSL_COM_CERTIFICATE_THUMBPRINT",
  "CODE_SIGN_TOOL_PATH",
] as const;

export interface DesktopReleaseBuildPolicyInput {
  readonly env: NodeJS.ProcessEnv;
  readonly platform: DesktopReleasePlatform;
  readonly productionConfigMode: DesktopProductionConfigMode;
  readonly releaseMode: DesktopReleaseMode;
  readonly signed: boolean;
}

export function requiresMacUpdateManifest(releaseMode: DesktopReleaseMode): boolean {
  return releaseMode === "publish";
}

function findMissingEnvKeys(
  env: NodeJS.ProcessEnv,
  keys: ReadonlyArray<string>,
): ReadonlyArray<string> {
  return keys.filter((key) => !env[key]?.trim());
}

export function resolveWindowsSigningProvider(env: NodeJS.ProcessEnv): WindowsSigningProvider {
  const rawProvider = env[WINDOWS_SIGNING_PROVIDER_ENV_KEY]?.trim().toLowerCase();
  if (!rawProvider) {
    throw new Error(`Windows signing requires ${WINDOWS_SIGNING_PROVIDER_ENV_KEY}=sslcom.`);
  }
  if (rawProvider === "azure") {
    throw new Error(
      `Windows Azure Trusted Signing is disabled because electron-builder applies it before the afterPack audit and would modify reviewed vendor payload bytes. Use ${WINDOWS_SIGNING_PROVIDER_ENV_KEY}=sslcom.`,
    );
  }
  if (!WINDOWS_SIGNING_PROVIDERS.includes(rawProvider as WindowsSigningProvider)) {
    throw new Error(
      `Unsupported Windows signing provider '${rawProvider}'. Expected one of: ${WINDOWS_SIGNING_PROVIDERS.join(", ")}.`,
    );
  }
  return rawProvider as WindowsSigningProvider;
}

export function validateWindowsSigningEnvironment(env: NodeJS.ProcessEnv): WindowsSigningProvider {
  const provider = resolveWindowsSigningProvider(env);
  const requiredKeys = WINDOWS_SSL_COM_RELEASE_SIGNING_ENV_KEYS;
  const missingKeys = findMissingEnvKeys(env, requiredKeys);
  if (missingKeys.length > 0) {
    throw new Error(
      `Windows ${provider} signing is missing required environment values: ${missingKeys.join(", ")}.`,
    );
  }
  const publisherName = env.SSL_COM_PUBLISHER_NAME?.trim() ?? "";
  if (!/(^|,)\s*CN\s*=/i.test(publisherName)) {
    throw new Error(
      "Windows sslcom signing requires SSL_COM_PUBLISHER_NAME to contain the certificate's full distinguished subject, including CN=.",
    );
  }
  const normalizedThumbprint = (env.SSL_COM_CERTIFICATE_THUMBPRINT ?? "").replace(/[\s:-]/g, "");
  if (!/^[0-9a-f]{40}$/i.test(normalizedThumbprint)) {
    throw new Error(
      "Windows sslcom signing requires SSL_COM_CERTIFICATE_THUMBPRINT to contain exactly 40 hexadecimal characters.",
    );
  }
  return provider;
}

export function validateDesktopReleaseBuildPolicy(input: DesktopReleaseBuildPolicyInput): void {
  if (input.releaseMode === "build-only") return;

  if (input.productionConfigMode !== "strict") {
    throw new Error(
      "Public desktop releases require --production-config-mode strict so the allowlisted production endpoints are validated and embedded.",
    );
  }

  if (input.platform === "linux") return;

  if (!input.signed) {
    throw new Error(
      `Public ${input.platform} desktop releases require --signed; unsigned artifacts are limited to build-only/internal QA runs.`,
    );
  }

  if (input.platform === "win") {
    validateWindowsSigningEnvironment(input.env);
    return;
  }

  const requiredKeys = APPLE_RELEASE_SIGNING_ENV_KEYS;
  const missingKeys = findMissingEnvKeys(input.env, requiredKeys);
  if (missingKeys.length > 0) {
    throw new Error(
      `Public ${input.platform} desktop release signing is missing required environment values: ${missingKeys.join(", ")}.`,
    );
  }
}
