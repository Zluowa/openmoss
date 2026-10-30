// FILE: claudeEnvironment.ts
// Purpose: Builds Claude CLI environments for account-isolated provider instances.
// Layer: Provider runtime utility
// Exports: claudeHomeEnvironment, buildClaudeInstanceProcessEnv

import * as NodePath from "node:path";
import { homedir } from "node:os";

import { defaultInstanceIdForDriver } from "@synara/contracts";

import * as FS from "node:fs";
import { createRequire } from "node:module";

import { type ProviderInstanceConfig } from "@synara/contracts";
import { MOSS_ACCESS_LANES, mossLaneEngineLineup } from "@synara/shared/mossRealmCatalog";
import {
  MANAGED_GATEWAY_CLAUDE_DEFAULT_MODEL,
  MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS,
} from "@synara/shared/mossManagedModelCatalog";

import { expandProviderAccountHomePath } from "../providerAccountHomePath.ts";
import { buildProviderChildEnvironment } from "../providerChildEnvironment.ts";
import {
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  CLAUDE_MODEL_ROUTING_ENV_KEYS,
  CLAUDE_TOOL_SEARCH_ENV_KEY,
  buildClaudeProcessEnv as buildUpstreamClaudeProcessEnv,
  hasClaudeExternalAuthEnv,
  hasUsableClaudeCliCredentials,
  isClaudeAccountIsolationEnvKey,
} from "./claudeProcessEnv.ts";
import { isTrustedMossManagedGatewayUrl } from "./mossManagedGatewayTrust.ts";

const DEFAULT_CLAUDE_INSTANCE_ID = defaultInstanceIdForDriver("claudeAgent");
const FALLBACK_CLAUDE_INSTANCE_SCOPE = "environment-only";
const WINDOWS_PROFILE_ENV_KEYS = [
  "USERPROFILE",
  "APPDATA",
  "LOCALAPPDATA",
  "HOMEDRIVE",
  "HOMEPATH",
] as const;

function normalizeEnvironmentKeys(
  environment: Readonly<NodeJS.ProcessEnv>,
  platform: NodeJS.Platform,
): NodeJS.ProcessEnv {
  if (platform !== "win32") {
    return { ...environment };
  }
  const normalized: NodeJS.ProcessEnv = {};
  for (const [name, value] of Object.entries(environment)) {
    normalized[name.toUpperCase()] = value;
  }
  return normalized;
}

function claudeInstanceHomeScope(providerInstanceId: string | undefined): string {
  const normalizedInstanceId = providerInstanceId?.trim();
  return normalizedInstanceId
    ? `instance-${Buffer.from(normalizedInstanceId, "utf8").toString("hex")}`
    : FALLBACK_CLAUDE_INSTANCE_SCOPE;
}

export function claudeIsolatedHomePath(input: {
  readonly isolationRootDir?: string;
  readonly homeDir?: string;
  readonly providerInstanceId?: string;
}): string {
  const isolationRoot =
    input.isolationRootDir?.trim() ||
    NodePath.join(input.homeDir?.trim() || homedir(), ".moss", "userdata");
  return NodePath.resolve(
    isolationRoot,
    "provider-homes",
    "claude",
    claudeInstanceHomeScope(input.providerInstanceId),
  );
}

export function claudeHomeEnvironment(
  homePath: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const homeEnvironment: NodeJS.ProcessEnv = { HOME: homePath };
  if (platform !== "win32") {
    return homeEnvironment;
  }

  // Claude can read Windows profile directories outside HOME, so mirror the
  // selected provider-instance home across the profile environment variables.
  const appDataRoot = NodePath.win32.join(homePath, "AppData");
  const parsed = NodePath.win32.parse(homePath);
  return {
    ...homeEnvironment,
    USERPROFILE: homePath,
    APPDATA: NodePath.win32.join(appDataRoot, "Roaming"),
    LOCALAPPDATA: NodePath.win32.join(appDataRoot, "Local"),
    ...(parsed.root.match(/^[A-Za-z]:\\$/)
      ? {
          HOMEDRIVE: parsed.root.slice(0, 2),
          HOMEPATH: homePath.slice(2) || "\\",
        }
      : {}),
  };
}

export function buildClaudeInstanceProcessEnv(
  homePath: string | null | undefined,
  environment?: Readonly<Record<string, string>> | undefined,
  options?: {
    readonly homeDir?: string;
    readonly isolationRootDir?: string;
    readonly providerInstanceId?: string;
    readonly platform?: NodeJS.Platform;
    /** Deterministic test seam; production callers inherit process.env. */
    readonly baseEnvironment?: NodeJS.ProcessEnv;
  },
): NodeJS.ProcessEnv {
  const platform = options?.platform ?? process.platform;
  const selectedEnvironment =
    environment === undefined ? undefined : normalizeEnvironmentKeys(environment, platform);
  const env = normalizeEnvironmentKeys(options?.baseEnvironment ?? process.env, platform);
  const trimmedHomePath = homePath?.trim();
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath, options?.homeDir ?? homedir())
    : undefined;
  const explicitEnvironmentHome =
    selectedEnvironment?.HOME?.trim() ||
    (platform === "win32" ? selectedEnvironment?.USERPROFILE?.trim() : undefined);
  const resolvedEnvironmentHomePath = explicitEnvironmentHome
    ? expandProviderAccountHomePath(explicitEnvironmentHome, options?.homeDir ?? homedir())
    : undefined;
  const providerInstanceId = options?.providerInstanceId?.trim();
  const needsIsolatedInstanceHome =
    resolvedHomePath === undefined &&
    resolvedEnvironmentHomePath === undefined &&
    (selectedEnvironment !== undefined ||
      (providerInstanceId !== undefined && providerInstanceId !== DEFAULT_CLAUDE_INSTANCE_ID));
  const isolatedHomePath = needsIsolatedInstanceHome
    ? claudeIsolatedHomePath({
        ...(options?.isolationRootDir ? { isolationRootDir: options.isolationRootDir } : {}),
        ...(options?.homeDir ? { homeDir: options.homeDir } : {}),
        ...(providerInstanceId ? { providerInstanceId } : {}),
      })
    : undefined;
  const useMacOSConfigIsolation = platform === "darwin" && isolatedHomePath !== undefined;
  const effectiveHomePath =
    resolvedHomePath ??
    resolvedEnvironmentHomePath ??
    (useMacOSConfigIsolation ? undefined : isolatedHomePath);
  if (!effectiveHomePath && options?.homeDir) {
    env.HOME = options.homeDir;
  }
  // An explicit provider home or environment selects a distinct account
  // boundary. Remove account-scoped ambient values first, then overlay only
  // values deliberately supplied by the selected instance.
  if (effectiveHomePath || isolatedHomePath || selectedEnvironment !== undefined) {
    for (const key of Object.keys(env)) {
      if (
        isClaudeAccountIsolationEnvKey(key) ||
        key === "CLAUDE_CONFIG_DIR" ||
        key === "CLAUDE_SECURESTORAGE_CONFIG_DIR"
      ) {
        delete env[key];
      }
    }
  }
  if (selectedEnvironment) {
    Object.assign(env, selectedEnvironment);
  }
  if (useMacOSConfigIsolation) {
    // Keep the system Keychain reachable, retaining existing account files in place.
    env.HOME = options?.homeDir ?? env.HOME ?? homedir();
    env.CLAUDE_CONFIG_DIR =
      selectedEnvironment?.CLAUDE_CONFIG_DIR?.trim() || NodePath.join(isolatedHomePath, ".claude");
    env.CLAUDE_SECURESTORAGE_CONFIG_DIR =
      selectedEnvironment?.CLAUDE_SECURESTORAGE_CONFIG_DIR?.trim() || env.CLAUDE_CONFIG_DIR;
  }
  if (effectiveHomePath) {
    Object.assign(env, claudeHomeEnvironment(effectiveHomePath, platform));
    if (!resolvedHomePath && selectedEnvironment) {
      if (selectedEnvironment.HOME?.trim()) {
        env.HOME = resolvedEnvironmentHomePath;
      }
      if (platform === "win32") {
        for (const key of WINDOWS_PROFILE_ENV_KEYS) {
          if (!(key in selectedEnvironment)) continue;
          const profileValue = selectedEnvironment[key];
          if (key === "USERPROFILE" && profileValue?.trim()) {
            env[key] = expandProviderAccountHomePath(profileValue, options?.homeDir ?? homedir());
          } else {
            env[key] = profileValue;
          }
        }
      }
    }
  }
  if (effectiveHomePath) {
    if (!selectedEnvironment || !("CLAUDE_CONFIG_DIR" in selectedEnvironment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }
  return buildUpstreamClaudeProcessEnv({
    env,
    ...(effectiveHomePath
      ? { homeDir: effectiveHomePath }
      : options?.homeDir
        ? { homeDir: options.homeDir }
        : {}),
    preserveDirectCredentialKeys: new Set(Object.keys(selectedEnvironment ?? {})),
  });
}

// ── Moss managed Claude (claude_moss) ─────────────────────────────────────
// Server-owned managed channel constants and launch verification. Ported from
// Moss's pre-merge claudeEnvironment; the upstream account-instance helpers
// above stay untouched.

export const MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID = "claude_moss";
export const MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY = "MOSS_BUNDLED_CLAUDE_PATH";
export const MOSS_MANAGED_CLAUDE_GATEWAY_API_KEY_ENV_KEY = "MOSS_MODEL_GATEWAY_CLAUDE_API_KEY";
const MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY = "MOSS_MODEL_GATEWAY_API_KEY";
export const MOSS_MANAGED_CLAUDE_MAX_RETRIES_ENV_KEY = "CLAUDE_CODE_MAX_RETRIES";
export const MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY = CLAUDE_TOOL_SEARCH_ENV_KEY;
export const MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_VALUE = "true";

const explicitMossEnvironmentKeys = (
  environment: Readonly<Record<string, string | undefined>> | undefined,
): ReadonlyArray<string> =>
  environment ? Object.keys(environment).filter((key) => key.startsWith("MOSS_")) : [];

function claudeSdkNativePackageSubpaths(input: {
  readonly platform: NodeJS.Platform;
  readonly arch: string;
}): ReadonlyArray<string> {
  const executable = input.platform === "win32" ? "claude.exe" : "claude";
  if (input.platform === "linux") {
    return [
      `@anthropic-ai/claude-agent-sdk-linux-${input.arch}/${executable}`,
      `@anthropic-ai/claude-agent-sdk-linux-${input.arch}-musl/${executable}`,
    ];
  }
  return [`@anthropic-ai/claude-agent-sdk-${input.platform}-${input.arch}/${executable}`];
}

export function resolveClaudeAgentSdkExecutable(input?: {
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  readonly resolveModule?: (specifier: string) => string;
  readonly existsSync?: (path: string) => boolean;
}): string | undefined {
  const platform = input?.platform ?? process.platform;
  const arch = input?.arch ?? process.arch;
  let resolveModule = input?.resolveModule;
  if (!resolveModule) {
    try {
      const localRequire = createRequire(import.meta.url);
      const sdkEntrypoint = localRequire.resolve("@anthropic-ai/claude-agent-sdk");
      const sdkRequire = createRequire(sdkEntrypoint);
      resolveModule = (specifier) => sdkRequire.resolve(specifier);
    } catch {
      return undefined;
    }
  }
  const existsSync = input?.existsSync ?? FS.existsSync;
  for (const specifier of claudeSdkNativePackageSubpaths({ platform, arch })) {
    try {
      const candidate = resolveModule(specifier);
      if (existsSync(candidate)) return candidate;
    } catch {
      // Try the next libc/platform candidate.
    }
  }
  return undefined;
}

export function resolveClaudeCodeExecutablePath(input?: {
  readonly binaryPath?: string | null | undefined;
  readonly providerInstanceId?: string | null | undefined;
  readonly env?: Readonly<Record<string, string | undefined>> | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly arch?: string | undefined;
  /** Test seam; undefined resolves the installed SDK package, null forces absence. */
  readonly sdkExecutablePath?: string | null | undefined;
}): string | undefined {
  const explicitPath = input?.binaryPath?.trim();
  const providerInstanceId = input?.providerInstanceId?.trim();
  if (providerInstanceId !== MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID) {
    return explicitPath || "claude";
  }

  // The managed Claude surface is tied to the packaged runtime receipt. A
  // caller or stale settings record must never replace it with an arbitrary
  // executable path.
  const packagedPath = (input?.env ?? process.env)[MOSS_BUNDLED_CLAUDE_PATH_ENV_KEY]?.trim();
  if (packagedPath) return packagedPath;
  if (input?.sdkExecutablePath !== undefined) {
    return input.sdkExecutablePath?.trim() || undefined;
  }
  return resolveClaudeAgentSdkExecutable({ platform: input?.platform, arch: input?.arch });
}

function normalizeManagedClaudeRelayBaseUrl(value: string | undefined): string | undefined {
  const trimmed = value?.trim();
  if (!trimmed) return undefined;
  try {
    const url = new URL(trimmed);
    if (url.username || url.password || url.search || url.hash) return undefined;
    const pathname = url.pathname.replace(/\/+$/, "").replace(/(?:\/v1)+$/, "");
    url.pathname = pathname || "/";
    return url.toString().replace(/\/+$/, "");
  } catch {
    return undefined;
  }
}

function isTrustedMossManagedClaudeRelay(
  value: string | undefined,
  env: Readonly<Record<string, string | undefined>> = process.env,
): boolean {
  const normalized = normalizeManagedClaudeRelayBaseUrl(value);
  if (!normalized) return false;
  return isTrustedMossManagedGatewayUrl(normalized, env);
}

function managedClaudeModels(): ReadonlyArray<string> {
  const defaultModel = MANAGED_GATEWAY_CLAUDE_DEFAULT_MODEL;
  if (!defaultModel || !MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS.includes(defaultModel)) return [];
  return [
    defaultModel,
    ...MANAGED_GATEWAY_CLAUDE_ENABLED_MODELS.filter((model) => model !== defaultModel),
  ];
}

/**
 * Every Messages lineup the server may legitimately provision: the historical
 * managed list plus each access lane's gateway lineup. The verifier has no lane
 * context at launch, so an instance is trusted when it matches any one exactly.
 */
function managedClaudeModelLineups(): ReadonlyArray<ReadonlyArray<string>> {
  return [
    managedClaudeModels(),
    ...MOSS_ACCESS_LANES.map((lane) => mossLaneEngineLineup(lane, "claude-code")),
  ].filter((lineup) => lineup.length > 0);
}

function jsonConfigRecord(config: ProviderInstanceConfig["config"]): Record<string, unknown> {
  return config && typeof config === "object" && !Array.isArray(config)
    ? (config as Record<string, unknown>)
    : {};
}

function exactStringArray(value: unknown, expected: ReadonlyArray<string>): boolean {
  return (
    Array.isArray(value) &&
    value.length === expected.length &&
    value.every((entry, index) => entry === expected[index])
  );
}

/**
 * A provisioned lineup is the realm lineup narrowed to the account's database
 * entitlement: a non-empty, duplicate-free, order-preserving subsequence.
 */
function entitledSubsequence(value: unknown, lineup: ReadonlyArray<string>): value is string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > lineup.length) return false;
  let cursor = 0;
  for (const entry of value) {
    if (typeof entry !== "string") return false;
    const index = lineup.indexOf(entry, cursor);
    if (index === -1) return false;
    cursor = index + 1;
  }
  return true;
}

/** Single launch/provision verifier for the fixed server-owned Claude surface. */
export function isVerifiedMossManagedClaudeProviderInstance(input: {
  readonly instanceId: string;
  readonly instance: ProviderInstanceConfig | undefined;
  readonly env?: Readonly<Record<string, string | undefined>>;
}): boolean {
  const instance = input.instance;
  const config = jsonConfigRecord(instance?.config);
  const allowlist = config.modelAllowlist;
  const models =
    managedClaudeModelLineups().some(
      (lineup) =>
        entitledSubsequence(allowlist, lineup) &&
        config.defaultModel === allowlist[0] &&
        exactStringArray(config.customModels, allowlist),
    ) && Array.isArray(allowlist)
      ? (allowlist as string[])
      : [];
  const gatewayBaseUrl =
    typeof config.gatewayBaseUrl === "string"
      ? normalizeManagedClaudeRelayBaseUrl(config.gatewayBaseUrl)
      : undefined;
  if (
    input.instanceId !== MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID ||
    instance?.driver !== "claudeAgent" ||
    instance.displayName !== "Moss Claude" ||
    config.managed !== true ||
    config.credentialEnvKey !== "ANTHROPIC_AUTH_TOKEN" ||
    !gatewayBaseUrl ||
    !isTrustedMossManagedClaudeRelay(gatewayBaseUrl, input.env) ||
    models.length === 0 ||
    config.defaultModel !== models[0] ||
    !exactStringArray(config.modelAllowlist, models) ||
    !exactStringArray(config.customModels, models) ||
    typeof config.runtimeGeneration !== "string" ||
    config.runtimeGeneration.trim().length === 0 ||
    config.binaryPath !== undefined
  ) {
    return false;
  }
  if (instance.enabled === false) return (instance.environment?.length ?? 0) === 0;
  const environment = instance.environment ?? [];
  if (environment.length !== 3) return false;
  const baseUrlEntry = environment.find((entry) => entry.name === "ANTHROPIC_BASE_URL");
  const tokenEntry = environment.find((entry) => entry.name === "ANTHROPIC_AUTH_TOKEN");
  const toolSearchEntry = environment.find(
    (entry) => entry.name === MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY,
  );
  return (
    baseUrlEntry?.sensitive !== true &&
    baseUrlEntry?.valueRedacted !== true &&
    normalizeManagedClaudeRelayBaseUrl(baseUrlEntry?.value) === gatewayBaseUrl &&
    tokenEntry?.sensitive === true &&
    tokenEntry.valueRedacted !== true &&
    typeof tokenEntry.value === "string" &&
    tokenEntry.value.trim().length > 0 &&
    toolSearchEntry?.sensitive !== true &&
    toolSearchEntry?.valueRedacted !== true &&
    toolSearchEntry?.value === MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_VALUE
  );
}

export function buildClaudeProcessEnv(input?: {
  readonly homePath?: string | null | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly env?: NodeJS.ProcessEnv;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string | undefined;
  readonly providerInstanceId?: string | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly hasClaudeCliCredentials?: boolean;
}): NodeJS.ProcessEnv {
  const platform = input?.platform ?? process.platform;
  const selectedEnvironment =
    input?.environment === undefined
      ? undefined
      : normalizeEnvironmentKeys(input.environment, platform);
  const env = normalizeEnvironmentKeys(input?.env ?? process.env, platform);
  // The control plane may inject the managed credential at process scope while
  // the persisted provider environment contains an empty/redacted placeholder.
  // Capture it before stripping Moss-only variables; it is translated below
  // only after the selected managed gateway has passed trust validation.
  const inheritedManagedGatewayKey =
    env[MOSS_MANAGED_CLAUDE_GATEWAY_API_KEY_ENV_KEY]?.trim() ||
    env[MOSS_MANAGED_GATEWAY_API_KEY_ENV_KEY]?.trim();
  // Legacy builds accepted an upstream Claude key in the desktop/server
  // process. Never inherit or translate that secret into a child process.
  delete env[MOSS_MANAGED_CLAUDE_GATEWAY_API_KEY_ENV_KEY];
  const trimmedHomePath = input?.homePath?.trim();
  const resolvedHomePath = trimmedHomePath
    ? expandProviderAccountHomePath(trimmedHomePath, input?.homeDir ?? homedir())
    : undefined;
  const explicitEnvironmentHome =
    selectedEnvironment?.HOME?.trim() ||
    (platform === "win32" ? selectedEnvironment?.USERPROFILE?.trim() : undefined);
  const resolvedEnvironmentHomePath = explicitEnvironmentHome
    ? expandProviderAccountHomePath(explicitEnvironmentHome, input?.homeDir ?? homedir())
    : undefined;
  const providerInstanceId = input?.providerInstanceId?.trim();
  const needsIsolatedInstanceHome =
    resolvedHomePath === undefined &&
    resolvedEnvironmentHomePath === undefined &&
    (selectedEnvironment !== undefined ||
      (providerInstanceId !== undefined && providerInstanceId !== DEFAULT_CLAUDE_INSTANCE_ID));
  const effectiveHomePath =
    resolvedHomePath ??
    resolvedEnvironmentHomePath ??
    (needsIsolatedInstanceHome
      ? claudeIsolatedHomePath({
          ...(input?.isolationRootDir !== undefined
            ? { isolationRootDir: input.isolationRootDir }
            : {}),
          ...(input?.homeDir !== undefined ? { homeDir: input.homeDir } : {}),
          ...(providerInstanceId !== undefined ? { providerInstanceId } : {}),
        })
      : undefined);
  // Align the subprocess HOME with the credential home being checked so Claude
  // reads the same login state the health/session gate validated. Instance
  // environment overrides and instance homes still win below.
  if (input?.homeDir) {
    env.HOME = input.homeDir;
  }

  // An explicit provider home, environment, or non-default instance selects a
  // distinct account boundary. Remove ambient account values first, then
  // overlay only values deliberately supplied by the selected instance below.
  if (effectiveHomePath || selectedEnvironment !== undefined) {
    for (const key of Object.keys(env)) {
      if (isClaudeAccountIsolationEnvKey(key)) {
        delete env[key];
      }
    }
  }
  if (selectedEnvironment) {
    Object.assign(env, selectedEnvironment);
  }
  delete env[MOSS_MANAGED_CLAUDE_GATEWAY_API_KEY_ENV_KEY];
  if (effectiveHomePath) {
    Object.assign(env, claudeHomeEnvironment(effectiveHomePath, platform));
    if (!resolvedHomePath && selectedEnvironment) {
      // HOME/USERPROFILE can themselves be the deliberate external account
      // boundary. Normalize the selected root, while retaining any other
      // explicitly supplied Windows profile routes instead of replacing them
      // with generated defaults for the synthetic home.
      if (selectedEnvironment.HOME?.trim()) {
        env.HOME = resolvedEnvironmentHomePath;
      }
      if (platform === "win32") {
        for (const key of WINDOWS_PROFILE_ENV_KEYS) {
          if (!(key in selectedEnvironment)) {
            continue;
          }
          const profileValue = selectedEnvironment[key];
          if (key === "USERPROFILE" && profileValue?.trim()) {
            env[key] = expandProviderAccountHomePath(profileValue, input?.homeDir ?? homedir());
            continue;
          }
          env[key] = profileValue;
        }
      }
    }
    // An inherited config directory takes precedence over HOME in Claude's
    // credential lookup. Do not let the server account leak into an instance
    // with an explicit home unless that instance deliberately configured it.
    if (!selectedEnvironment || !("CLAUDE_CONFIG_DIR" in selectedEnvironment)) {
      delete env.CLAUDE_CONFIG_DIR;
    }
  }

  if (providerInstanceId === MOSS_MANAGED_CLAUDE_PROVIDER_INSTANCE_ID) {
    // CC Switch and older Moss builds may leave model-routing hints in the
    // persisted managed instance. They are deliberately scrubbed below and
    // must not make an otherwise valid Moss relay fail closed before the
    // scrub. Unknown keys still invalidate the managed boundary.
    const selectedKeys = Object.keys(selectedEnvironment ?? {})
      .filter(
        (key) =>
          key !== "ANTHROPIC_API_KEY" &&
          key !== MOSS_MANAGED_CLAUDE_MAX_RETRIES_ENV_KEY &&
          !CLAUDE_MODEL_ROUTING_ENV_KEYS.includes(
            key as (typeof CLAUDE_MODEL_ROUTING_ENV_KEYS)[number],
          ) &&
          !key.startsWith("ANTHROPIC_DEFAULT_"),
      )
      .toSorted();
    const managedToken =
      selectedEnvironment?.ANTHROPIC_AUTH_TOKEN?.trim() || inheritedManagedGatewayKey;
    const verifiedManagedEnvironment =
      selectedKeys.length === 3 &&
      selectedKeys[0] === "ANTHROPIC_AUTH_TOKEN" &&
      selectedKeys[1] === "ANTHROPIC_BASE_URL" &&
      selectedKeys[2] === MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY &&
      Boolean(managedToken) &&
      selectedEnvironment?.[MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_KEY] ===
        MOSS_MANAGED_CLAUDE_TOOL_SEARCH_ENV_VALUE &&
      isTrustedMossManagedClaudeRelay(selectedEnvironment?.ANTHROPIC_BASE_URL, input?.env);
    // Only the exact server-selected Moss Edge environment survives. Ambient,
    // stale, direct-relay, attacker, or partial credentials remain fail-closed.
    // The Agent SDK receives the selected model from ClaudeAdapter. Claude Code
    // also honors model routing environment variables, so clear both inherited
    // and selected-instance values here; otherwise a stale ANTHROPIC_MODEL
    // (for example `stealth/ox-alpha`) wins before the SDK request is sent.
    for (const key of CLAUDE_MODEL_ROUTING_ENV_KEYS) {
      delete env[key];
    }
    // Keep the boundary forward-compatible with new Claude Code role names
    // such as ANTHROPIC_DEFAULT_<ROLE>_MODEL: all of them are routing hints,
    // never credentials that a managed Moss child should inherit.
    for (const key of Object.keys(env)) {
      if (key.startsWith("ANTHROPIC_DEFAULT_")) delete env[key];
    }
    for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
      if (verifiedManagedEnvironment && key === "ANTHROPIC_AUTH_TOKEN") continue;
      delete env[key];
    }
    if (!verifiedManagedEnvironment) {
      delete env.ANTHROPIC_BASE_URL;
    } else {
      // Claude speaks Anthropic's protocol, so expose the Moss credential under
      // the name Claude expects. Never pass the Moss control-plane key itself
      // to the child process.
      env.ANTHROPIC_AUTH_TOKEN = managedToken!;
      // Claude Code checks API_KEY before AUTH_TOKEN in some releases. An
      // explicitly empty API key prevents an inherited account key from
      // winning that precedence check while retaining the managed token.
      env.ANTHROPIC_API_KEY = "";
      // One UI send must map to one paid Gateway POST. Claude Code otherwise
      // retries transport failures internally while the Gateway deliberately
      // refuses to replay an ambiguous paid operation.
      env[MOSS_MANAGED_CLAUDE_MAX_RETRIES_ENV_KEY] = "0";
    }
  }

  // Credentials live in the selected instance home when one is configured;
  // otherwise use the final overlaid HOME before the caller's server home.
  const credentialsHomeDir = effectiveHomePath ?? env.HOME ?? input?.homeDir;
  const hasLocalClaudeAuth =
    input?.hasClaudeCliCredentials ??
    hasUsableClaudeCliCredentials(
      credentialsHomeDir ? { env, homeDir: credentialsHomeDir } : { env },
    );

  if (!hasLocalClaudeAuth || hasClaudeExternalAuthEnv(env)) {
    return buildProviderChildEnvironment({
      provider: "claude",
      baseEnv: env,
      inheritedMossKeys: explicitMossEnvironmentKeys(selectedEnvironment),
    });
  }

  // Claude gives direct request credentials precedence over local OAuth. Drop stale
  // inherited keys when a real Claude CLI login can satisfy the subprocess, but keep
  // credentials the provider instance sets explicitly.
  for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) {
    if (selectedEnvironment && key in selectedEnvironment) {
      continue;
    }
    delete env[key];
  }
  return buildProviderChildEnvironment({
    provider: "claude",
    baseEnv: env,
    inheritedMossKeys: explicitMossEnvironmentKeys(selectedEnvironment),
  });
}
