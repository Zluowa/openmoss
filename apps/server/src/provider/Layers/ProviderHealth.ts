/**
 * ProviderHealthLive - Cache-backed provider health service.
 *
 * Seeds provider status from disk cache when available, then refreshes from
 * CLI probes without blocking the rest of server startup.
 *
 * Uses effect's ChildProcessSpawner to run CLI probes natively.
 *
 * @module ProviderHealthLive
 */
import * as OS from "node:os";
import nodePath from "node:path";
import type {
  ProviderInstanceId,
  ServerSettings,
  ServerProviderAuthStatus,
  ServerProviderLoginState,
  ServerProviderStatus,
  ServerProviderStatusState,
  ServerProviderInstallState,
  ServerProviderUpdateState,
  ProviderInstallationErrorCode,
} from "@moss/contracts";
import {
  PROVIDER_INSTALLATION_ERROR_CODES,
  ProviderKind,
  ServerProviderInstallError,
  ServerProviderLoginError,
  ServerProviderUpdateError,
} from "@moss/contracts";
import { parseCodexConfigModelProvider } from "@moss/shared/codexConfig";
import { envPathKeyFor, resolveExecutable } from "@moss/shared/executable";
import { resetLocalAgentPathLookupCache } from "@moss/shared/localAgentExecutable";
import { PROVIDER_CLI_COMMAND_BY_KIND } from "@moss/shared/providerCliProfiles";
import { isPathName, mergePathEntries } from "@moss/shared/shell";
import {
  deriveProviderInstances,
  deriveUnsupportedProviderInstances,
  providerStartOptionsFromInstance,
  providerRuntimeBinaryPath,
  providerRuntimeConfigurationIssue,
  type ResolvedProviderInstance,
  type UnsupportedProviderInstance,
} from "@moss/shared/providerInstances";
import { decodeJsonResult } from "@moss/shared/schemaJson";
import {
  formatBundledCodexExecutableVersionMismatch,
  MOSS_BUNDLED_CODEX_VERSION,
} from "@moss/shared/codexRuntime";
import { resolveCodexExecutable } from "@moss/shared/codexExecutable";
import { expandHomePath } from "@moss/shared/mossHome";
import type { SDKUserMessage } from "@anthropic-ai/claude-agent-sdk";
import {
  Array,
  DateTime,
  Duration,
  Effect,
  Exit,
  Fiber,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Ref,
  Result,
  Schema,
  Scope,
  Stream,
} from "effect";
import { ChildProcessSpawner } from "effect/unstable/process";
import { makeEffectProcessCommand } from "../../platform/effectProcessRuntime.ts";
import { decodeProviderCommandOutput, readWindowsAnsiEncoding } from "../providerCommandOutput.ts";

import {
  CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
  compareCodexCliVersions,
  formatCodexCliUpgradeMessage,
  isCodexCliVersionSupported,
  MINIMUM_CODEX_AUTO_REVIEW_CLI_VERSION,
  parseCodexCliVersion,
} from "../codexCliVersion";
import {
  buildClaudeInstanceProcessEnv,
  resolveClaudeCodeExecutablePath,
  resolveClaudeCodeRuntime,
} from "../claudeEnvironment";
import { ServerConfig } from "../../config";
import {
  agentProgramsForServer,
  agentProgramSourceHome,
  agentProgramRestartMessage,
  makeAgentProgramOwnership,
  type AgentProgramOwnership,
} from "../agentProgramOwnership.ts";
import {
  buildProviderChildEnvironment,
  explicitMossEnvironmentKeys,
  type ProviderChildKind,
} from "../../providerChildEnvironment.ts";
import {
  buildOpenCodeServerProcessEnv,
  resolveOpenCodeBinaryPath,
} from "../providerBinaryResolution.ts";
import { ServerSettingsService } from "../../serverSettings";
import {
  codexStateBindingAccountFromSettings,
  makeCodexStateBindingSelection,
} from "../codexStateBinding.ts";
import {
  claudeStateBindingAccountFromSettings,
  makeClaudeStateBindingSelection,
  readClaudeStateBinding,
} from "../claudeStateBinding.ts";
import {
  readCodexCredentialFence,
  type CodexCredentialScopeInput,
} from "../../codexHomeIdentity.ts";
import { isWindowsShellCommandMissingResult } from "../../shell-command-detection";
import {
  buildCursorAgentCommand,
  buildCursorAgentHeadlessEnv,
  DEFAULT_CURSOR_AGENT_BINARY,
  resolveCursorAgentBinaryPath,
} from "../acp/CursorAcpCommand";
import { hasDroidApiKeyEnv, resolveDroidCliBinaryPath } from "../acp/DroidAcpSupport";
import { hasGrokApiKeyEnv } from "../acp/GrokAcpSupport";
import { MOSS_MANAGED_GROK_CONFIG_ENV_KEY } from "../mossManagedGrokEnvironment";
import {
  type AcpAgentSpec,
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "../acp/AcpAgentSpec";
import { resolveOmpCliBinaryPath } from "../acp/OmpAcpSupport";
import {
  hasDevinApiKeyEnv,
  readDevinStoredCredentials,
  resolveDevinBinaryPath,
} from "../acp/DevinAcpSupport";
import {
  claudeAuthMetadata,
  isStructuredClaudeAuthFalseNegativeCandidate,
  parseClaudeAuthStatusFromOutput,
} from "../claudeAuthStatus";
import { acquireClaudeAuthStatusLock } from "../claudeAuthStatusLock";
import { loadClaudeAgentSdk, spawnOwnedClaudeCodeProcess } from "../claudeAgentSdk.ts";
import {
  buildClaudeProcessEnv,
  readClaudeCliCredentialsSummary,
  resolveClaudeCredentialsPaths,
} from "../claudeProcessEnv";
import {
  buildClaudeLoginEnvironment,
  buildCodexLoginEnvironment,
  makeProviderLoginManager,
  type ProviderLoginDriver,
} from "../providerLoginManager.ts";
import {
  buildGeminiProbeEnv,
  normalizeGeminiCapabilityProbeResult,
  probeGeminiCapabilities,
} from "../geminiAcpProbe";
import { readMossManagedAcpAgentCatalog } from "../mossManagedAcpAgentEnvironment";
import { readMossManagedHermesConfig } from "../mossManagedHermesEnvironment";
import {
  detailFromResult,
  extractAuthBoolean,
  extractAuthMethod,
  isCommandMissingCause,
  nonEmptyTrimmed,
  PROVIDER_COMMAND_TIMEOUT_DETAIL,
  toTitleCaseWords,
  type CommandResult,
} from "../providerCliOutput";
import { probeProviderCliVersion } from "../providerCliVersionProbe";
import { ProviderHealth, type ProviderHealthShape } from "../Services/ProviderHealth";
import {
  orderProviderStatuses,
  readProviderStatusCache,
  resolveProviderStatusCachePath,
  writeProviderStatusCache,
} from "../providerStatusCache";
import { makeProviderMaintenanceCommandCoordinator } from "../providerMaintenanceCommandCoordinator";
import {
  applyProviderPackageChannelEnv,
  resolveProviderPackageChannel,
  type ProviderPackageChannel,
} from "../providerPackageChannel";
import {
  enrichProviderStatusWithVersionAdvisory,
  compareSemverVersions,
  makeProviderMaintenanceCapabilities,
  normalizeCommandPath,
  parseGenericCliVersion,
  providerUpdateFailureReason,
  prepareProviderMaintenanceUpdate,
  PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE,
  PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE,
  providerUpdatePreparationFailure,
  resolveProviderMaintenanceCapabilitiesEffect,
  withOpenCodeMaintenanceVersion,
  type PackageManagedProviderMaintenanceDefinition,
} from "../providerMaintenance";
import { isClaudeAutoModeCliVersionSupported } from "../claudeCliVersion.ts";
import { collectUint8StreamText } from "../../stream/collectUint8StreamText";
import { PROVIDER_NOT_INSTALLED_READINESS, withProviderReadiness } from "../providerReadiness.ts";
import { ensureMossNpm, resolveMossNodeRuntime, writeNodeShim } from "../agentInstallRuntime.ts";
import {
  agentInstallRegistries,
  appendManagedAgentBinDirectoryToPath,
  managedAgentBinDirectory,
  managedAgentInstallPrefix,
  providerInstallStrategy,
  runOneClickAgentInstall,
  type AgentInstallCommandResult,
} from "../providerInstall.ts";
import {
  appendAgentCliDirectoriesToPath,
  ensureAgentCliPath,
  npmGlobalBinDirectory,
  parseNpmPrefixOutput,
} from "../agentCliPathFloor.ts";
import { buildCodexProcessEnv, prepareCodexAuthTracking } from "../../codexProcessEnv.ts";
import {
  readManagedCodexHomeAuthority,
  type ManagedCodexHomeAuthority,
} from "../../account/mossManagedHomeAuthority.ts";
import { readGrokCachedLogin } from "../../providerUsage/providers/grok";
import { buildProviderProcessEnv, type ProviderProcessEnvDriver } from "../providerProcessEnv.ts";
import {
  assertProviderInstallationRemovalAllowed,
  inspectProviderInstallation,
  ProviderInstallationError,
  removeManagedProviderInstallation,
} from "../managedProviderInstallation.ts";

/** Set to "1" in tests and rehearsals: one-click agent updates are refused. */
export const PROVIDER_UPDATES_DISABLED_ENV = "MOSS_DISABLE_PROVIDER_UPDATES";

export { parseClaudeAuthStatusFromOutput } from "../claudeAuthStatus";
export type { CommandResult } from "../providerCliOutput";

const DEFAULT_TIMEOUT_MS = 4_000;
const CLAUDE_HEALTH_TIMEOUT_MS = 20_000;
const OPENCODE_HEALTH_TIMEOUT_MS = 20_000;
const PI_HEALTH_TIMEOUT_MS = 20_000;
/** The oldest Pi CLI whose RPC protocol Moss speaks (prompt dispositions, settled runs). */
export const MINIMUM_PI_CLI_VERSION = "1.5.0";
const CODEX_AUTH_STATUS_ARGS = ["-c", "mcp_servers={}", "login", "status"] as const;
const CODEX_PROVIDER = "codex" as const;
const CLAUDE_AGENT_PROVIDER = "claudeAgent" as const;
const CURSOR_PROVIDER = "cursor" as const;
const GEMINI_PROVIDER = "gemini" as const;
const ANTIGRAVITY_PROVIDER = "antigravity" as const;
const GROK_PROVIDER = "grok" as const;
const DROID_PROVIDER = "droid" as const;
const DEVIN_PROVIDER = "devin" as const;
const OPENCODE_PROVIDER = "opencode" as const;
const PI_PROVIDER = "pi" as const;
const HERMES_PROVIDER = "hermes" as const;
const OMP_PROVIDER = "omp" as const;
type ProviderStatuses = ReadonlyArray<ServerProviderStatus>;
const DISABLED_PROVIDER_STATUS_MESSAGE = "Provider is disabled in Moss settings.";
const MINIMUM_ANTIGRAVITY_CLI_VERSION = "1.0.12";

const PROVIDERS = [
  CODEX_PROVIDER,
  CLAUDE_AGENT_PROVIDER,
  CURSOR_PROVIDER,
  GEMINI_PROVIDER,
  ANTIGRAVITY_PROVIDER,
  GROK_PROVIDER,
  DROID_PROVIDER,
  DEVIN_PROVIDER,
  OPENCODE_PROVIDER,
  PI_PROVIDER,
  HERMES_PROVIDER,
  OMP_PROVIDER,
  KIMI_ACP_AGENT_SPEC.kind,
  MINIMAX_ACP_AGENT_SPEC.kind,
  ZCODE_ACP_AGENT_SPEC.kind,
] as const satisfies ReadonlyArray<ProviderKind>;

/** Whether this Codex or Claude instance runs the copy packaged Moss ships. */
export function runsMossBundledAgentRuntime(
  provider: ProviderKind,
  configuredBinaryPath: string | undefined,
  instanceId: string,
  codexAccountId?: string,
): boolean {
  if (provider === CODEX_PROVIDER) {
    try {
      return (
        resolveCodexExecutable({
          configuredBinaryPath,
          accountId: codexAccountId,
          env: process.env,
        }).source === "bundled"
      );
    } catch {
      // A damaged bundle has nothing npm should touch either.
      return true;
    }
  }
  if (provider === CLAUDE_AGENT_PROVIDER) {
    return (
      resolveClaudeCodeRuntime({
        binaryPath: configuredBinaryPath,
        providerInstanceId: instanceId,
        env: process.env,
      }).source === "bundled"
    );
  }
  return false;
}

export function resolveCodexProviderLoginExecutable(input: {
  readonly configuredBinaryPath?: string | null | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
}): string {
  return resolveCodexExecutable({
    configuredBinaryPath: input.configuredBinaryPath,
    env: input.env,
  }).binaryPath;
}

const providerChildKind = (provider: ProviderKind): ProviderChildKind => {
  if (provider === "droid" || provider === "kilo") {
    throw new Error(`Provider '${provider}' is no longer supported by Moss.`);
  }
  return provider === CLAUDE_AGENT_PROVIDER ? "claude" : provider;
};

const providerCommandEnv = (
  provider: ProviderKind,
  environment?: Readonly<Record<string, string>>,
): NodeJS.ProcessEnv =>
  provider === OPENCODE_PROVIDER
    ? buildOpenCodeServerProcessEnv({})
    : buildProviderChildEnvironment({
        provider: providerChildKind(provider),
        ...(environment !== undefined
          ? {
              baseEnv: { ...process.env, ...environment },
              inheritedMossKeys: explicitMossEnvironmentKeys(environment),
            }
          : {}),
      });

// Windows spreads the inherited environment under its native "Path" key. Writing a
// literal `PATH` next to it makes Node's spawn keep only one casing, `PATH`, so the
// child sees just the prepended entry and CLIs such as opencode cannot find their
// package manager. Keep a single path key that carries the prepended entry followed
// by the inherited value.
export const prependPathEntry = (
  env: NodeJS.ProcessEnv,
  entry: string,
  platform: NodeJS.Platform = OS.platform(),
): NodeJS.ProcessEnv => {
  // Read own keys: `in` on Windows' process.env reports every casing as present.
  const pathKeys = Object.keys(env).filter((key) =>
    platform === "win32" ? isPathName(key) : key === "PATH",
  );
  const envPathKey = envPathKeyFor(Object.fromEntries(pathKeys.map((key) => [key, ""])), platform);
  const orderedKeys = [envPathKey, ...pathKeys.filter((key) => key !== envPathKey)];
  const inheritedPath = orderedKeys.reduce<string | undefined>(
    (merged, key) => mergePathEntries(merged, env[key], platform),
    undefined,
  );
  const nextEnv: NodeJS.ProcessEnv = { ...env };
  for (const key of pathKeys) delete nextEnv[key];
  nextEnv[envPathKey] = mergePathEntries(entry, inheritedPath, platform) ?? entry;
  return nextEnv;
};

const UPDATE_OUTPUT_MAX_BYTES = 10_000;
export const PROVIDER_HEALTH_PROBE_CONCURRENCY = 4;
const MAX_REFRESH_REVISION_RETRIES = 1;
const REFRESH_REVISION_RESCHEDULE_DELAY_MS = 100;
const PROVIDER_UPDATE_ENABLEMENT_POLL_MS = 100;
// Native CLI packages run to a few hundred MB, which takes minutes on a slow domestic line.
export const PROVIDER_UPDATE_TIMEOUT_MS = 5 * 60_000;
// Updates that run through a package manager follow the mirror; a vendor's own updater cannot.
const MIRRORED_UPDATE_LOCK_KEYS: ReadonlySet<string> = new Set([
  "npm-global",
  "bun-global",
  "pnpm-global",
  "homebrew",
]);
const PROVIDER_UPDATE_NO_MIRROR_HINT =
  "This install updates through the vendor's own servers, which have no domestic mirror. Reinstalling it with npm lets Moss update it through the mirror.";

export function runProviderHealthProbes<A, E, R>(
  probes: ReadonlyArray<Effect.Effect<A, E, R>>,
): Effect.Effect<ReadonlyArray<A>, E, R> {
  return Effect.all(probes, { concurrency: PROVIDER_HEALTH_PROBE_CONCURRENCY });
}

function formatProviderUpdateTimeout(timeoutMs: number): string {
  if (timeoutMs < 1_000) {
    return `${timeoutMs} ${timeoutMs === 1 ? "millisecond" : "milliseconds"}`;
  }
  if (timeoutMs % 60_000 === 0) {
    const minutes = timeoutMs / 60_000;
    return `${minutes} ${minutes === 1 ? "minute" : "minutes"}`;
  }
  const seconds = timeoutMs / 1_000;
  return `${seconds} ${seconds === 1 ? "second" : "seconds"}`;
}

function providerStatusInstanceKey(status: ServerProviderStatus): ProviderInstanceId {
  return status.instanceId ?? status.provider;
}

// Instance ids are editable settings keys, so driver identity must travel with
// them to prevent a reused id from inheriting another provider's auth/status.
function providerStatusIdentityKey(status: ServerProviderStatus): string {
  return `${status.driver ?? status.provider}\u0000${providerStatusInstanceKey(status)}`;
}

function providerStatusKey(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
}): ProviderInstanceId {
  return input.instanceId ?? input.provider;
}

function providerTargetIdentityKey(input: {
  readonly provider: ProviderKind;
  readonly instanceId?: ProviderInstanceId | undefined;
}): string {
  return `${input.provider}\u0000${providerStatusKey(input)}`;
}

function isClaudeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.local/bin/claude") ||
    normalized.endsWith("/.local/bin/claude.exe") ||
    normalized.includes("/.local/share/claude/")
  );
}

function isClaudeLatestHomebrewCommandPath(commandPath: string): boolean {
  return normalizeCommandPath(commandPath).includes("/caskroom/claude-code@latest/");
}

function isOpenCodeNativeCommandPath(commandPath: string): boolean {
  const normalized = normalizeCommandPath(commandPath);
  return (
    normalized.endsWith("/.opencode/bin/opencode") ||
    normalized.endsWith("/.opencode/bin/opencode.exe")
  );
}

export const PACKAGE_MANAGED_PROVIDER_UPDATES: Partial<
  Record<ProviderKind, PackageManagedProviderMaintenanceDefinition>
> = {
  codex: {
    provider: CODEX_PROVIDER,
    binaryName: "codex",
    npmPackageName: "@openai/codex",
    homebrew: { name: "codex", kind: "cask" },
    nativeUpdate: null,
  },
  claudeAgent: {
    provider: CLAUDE_AGENT_PROVIDER,
    binaryName: "claude",
    npmPackageName: "@anthropic-ai/claude-code",
    homebrew: {
      name: "claude-code",
      kind: "cask",
      variants: [
        {
          name: "claude-code@latest",
          kind: "cask",
          isCommandPath: isClaudeLatestHomebrewCommandPath,
        },
      ],
    },
    nativeUpdate: {
      executable: "claude",
      args: () => ["update"],
      lockKey: "claude-native",
      strategy: "matching-path",
      // Native Claude owns stable/latest channel selection. npm's latest tag cannot
      // tell whether the installed CLI is current for the user's configured channel.
      latestVersionSource: null,
      isCommandPath: isClaudeNativeCommandPath,
    },
  },
  gemini: {
    provider: GEMINI_PROVIDER,
    binaryName: "gemini",
    npmPackageName: "@google/gemini-cli",
    homebrew: { name: "gemini-cli", kind: "formula" },
    nativeUpdate: null,
  },
  antigravity: {
    provider: ANTIGRAVITY_PROVIDER,
    binaryName: "agy",
    // Antigravity is distributed as a native binary and owns its update channel.
    npmPackageName: null,
    homebrew: null,
    latestVersionSource: null,
    nativeUpdate: {
      executable: "agy",
      args: () => ["update"],
      lockKey: "antigravity-native",
      strategy: "always",
    },
  },
  droid: {
    provider: DROID_PROVIDER,
    binaryName: "droid",
    npmPackageName: "@factory/cli",
    homebrew: null,
    nativeUpdate: {
      executable: "droid",
      args: () => ["update"],
      lockKey: "droid-native",
      strategy: "always",
    },
  },
  opencode: {
    provider: OPENCODE_PROVIDER,
    binaryName: "opencode",
    npmPackageName: "opencode-ai",
    homebrew: { name: "anomalyco/tap/opencode", kind: "formula" },
    latestVersionSource: { kind: "npm", name: "opencode-ai" },
    nativeUpdate: {
      executable: "opencode",
      args: (installSource) =>
        installSource === "unknown" || installSource === "native"
          ? ["upgrade"]
          : ["upgrade", "--method", installSource],
      lockKey: "opencode-native",
      strategy: "always",
      excludedInstallSources: ["homebrew"],
      isCommandPath: isOpenCodeNativeCommandPath,
    },
  },
  grok: {
    provider: GROK_PROVIDER,
    binaryName: "grok",
    // xAI's official Grok Build CLI is distributed through npm as well as its
    // native installer. Keeping the package metadata here lets Settings offer
    // the same safe update path when a user installed Grok with npm.
    npmPackageName: "@xai-official/grok",
    homebrew: null,
    latestVersionSource: { kind: "npm", name: "@xai-official/grok" },
    nativeUpdate: null,
  },
  hermes: {
    provider: HERMES_PROVIDER,
    binaryName: "hermes",
    npmPackageName: null,
    homebrew: null,
    nativeUpdate: null,
  },
  // Moss drives this CLI, so it updates like any npm agent: `npm install --global --prefix
  // <the folder that owns it>`. Never `pi update`, Pi's self-updater, which reinstalls into
  // whatever global prefix npm resolves.
  pi: {
    provider: PI_PROVIDER,
    binaryName: "pi",
    npmPackageName: "@earendil-works/pi-coding-agent",
    homebrew: null,
    latestVersionSource: { kind: "npm", name: "@earendil-works/pi-coding-agent" },
    nativeUpdate: null,
  },
  omp: {
    provider: OMP_PROVIDER,
    binaryName: "omp",
    npmPackageName: null,
    homebrew: null,
    nativeUpdate: null,
  },
  kimi: acpAgentPackageMaintenance(KIMI_ACP_AGENT_SPEC),
  minimax: acpAgentPackageMaintenance(MINIMAX_ACP_AGENT_SPEC),
  zcode: acpAgentPackageMaintenance(ZCODE_ACP_AGENT_SPEC),
};

// The ACP agent CLIs are plain npm packages; the registry's latest tag is the
// update truth and `npm i -g <pkg>@latest` the safe update path.
function acpAgentPackageMaintenance(
  spec: AcpAgentSpec,
): PackageManagedProviderMaintenanceDefinition {
  return {
    provider: spec.kind,
    binaryName: spec.command,
    npmPackageName: spec.install.npmPackageName,
    ...(spec.install.npmInstallArgs ? { npmInstallArgs: spec.install.npmInstallArgs } : {}),
    homebrew: null,
    latestVersionSource: { kind: "npm", name: spec.install.npmPackageName },
    nativeUpdate: null,
  };
}

// ── Pure helpers ────────────────────────────────────────────────────
//
// Generic CLI-output parsing lives in ../providerCliOutput; Claude auth-status
// interpretation lives in ../claudeAuthStatus.

function resolveVoiceTranscriptionAvailability(
  authMethod: string | undefined,
): boolean | undefined {
  if (!authMethod) {
    return undefined;
  }
  return authMethod === "chatgpt" || authMethod === "chatgptAuthTokens";
}

// ── Subscription type detection ─────────────────────────────────────
//
// Walks arbitrary JSON output from `<provider> auth status` looking for a
// subscription/plan identifier. Used as a best-effort first pass; the SDK
// probe below is the reliable source when available.

const SUBSCRIPTION_TYPE_KEYS = [
  "subscriptionType",
  "subscription_type",
  "plan",
  "tier",
  "planType",
  "plan_type",
] as const;

const SUBSCRIPTION_CONTAINER_KEYS = ["account", "subscription", "user", "billing"] as const;
const AUTH_METHOD_KEYS = ["authMethod", "auth_method"] as const;
const AUTH_METHOD_CONTAINER_KEYS = ["auth", "account", "session"] as const;

const asNonEmptyString = (v: unknown): Option.Option<string> =>
  typeof v === "string" && v.length > 0 ? Option.some(v) : Option.none();

const asRecord = (v: unknown): Option.Option<Record<string, unknown>> =>
  typeof v === "object" && v !== null && !Array.isArray(v)
    ? Option.some(v as Record<string, unknown>)
    : Option.none();

function findSubscriptionType(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findSubscriptionType));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        SUBSCRIPTION_TYPE_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        SUBSCRIPTION_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findSubscriptionType)),
        ),
      );
    }),
  );
}

function findAuthMethodDeep(value: unknown): Option.Option<string> {
  if (Array.isArray(value)) {
    return Option.firstSomeOf(value.map(findAuthMethodDeep));
  }
  return asRecord(value).pipe(
    Option.flatMap((record) => {
      const direct = Option.firstSomeOf(
        AUTH_METHOD_KEYS.map((key) => asNonEmptyString(record[key])),
      );
      if (Option.isSome(direct)) return direct;
      return Option.firstSomeOf(
        AUTH_METHOD_CONTAINER_KEYS.map((key) =>
          asRecord(record[key]).pipe(Option.flatMap(findAuthMethodDeep)),
        ),
      );
    }),
  );
}

const decodeUnknownJson = decodeJsonResult(Schema.Unknown);

function extractSubscriptionTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findSubscriptionType(parsed.success));
}

function extractClaudeAuthMethodFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  return Option.getOrUndefined(findAuthMethodDeep(parsed.success));
}

// ── Codex subscription label ────────────────────────────────────────

type CodexPlanTypeLiteral =
  | "free"
  | "go"
  | "plus"
  | "pro"
  | "team"
  | "business"
  | "enterprise"
  | "edu"
  | "self_serve_business_usage_based"
  | "enterprise_cbp_usage_based"
  | "unknown";

function codexAccountAuthLabel(input: {
  readonly type: string | undefined;
  readonly planType: string | undefined;
}): string | undefined {
  if (input.type === "apiKey") return "OpenAI API Key";
  if (!input.planType) return undefined;
  switch (input.planType as CodexPlanTypeLiteral) {
    case "free":
      return "ChatGPT Free Subscription";
    case "go":
      return "ChatGPT Go Subscription";
    case "plus":
      return "ChatGPT Plus Subscription";
    case "pro":
      return "ChatGPT Pro Subscription";
    case "team":
      return "ChatGPT Team Subscription";
    case "self_serve_business_usage_based":
    case "business":
      return "ChatGPT Business Subscription";
    case "enterprise_cbp_usage_based":
    case "enterprise":
      return "ChatGPT Enterprise Subscription";
    case "edu":
      return "ChatGPT Edu Subscription";
    case "unknown":
      return "ChatGPT Subscription";
    default:
      return toTitleCaseWords(input.planType);
  }
}

function extractCodexAccountTypeFromOutput(result: CommandResult): string | undefined {
  const parsed = decodeUnknownJson(result.stdout.trim());
  if (Result.isFailure(parsed)) return undefined;
  const walk = (value: unknown): string | undefined => {
    if (Array.isArray(value)) {
      for (const entry of value) {
        const nested = walk(entry);
        if (nested) return nested;
      }
      return undefined;
    }
    const record = Option.getOrUndefined(asRecord(value));
    if (!record) return undefined;
    const direct = Option.getOrUndefined(
      Option.firstSomeOf(["type", "accountType"].map((key) => asNonEmptyString(record[key]))),
    );
    if (direct) return direct;
    for (const key of ["account", "session", "auth"] as const) {
      const nested = walk(record[key]);
      if (nested) return nested;
    }
    return undefined;
  };
  return walk(parsed.success);
}

// ── Claude SDK capability probe ─────────────────────────────────────
//
// Spawns a lightweight Claude Agent SDK session and reads the
// initialization result. The prompt is a never-yielding AsyncIterable so
// no user message reaches the Anthropic API — we get account metadata
// (including subscription type) from local IPC, then abort the
// subprocess. Used as a fallback when `claude auth status` output
// doesn't include subscription info.

const CAPABILITIES_PROBE_TIMEOUT_MS = 8_000;
const CLAUDE_SUBSCRIPTION_CACHE_TTL_MS = 5 * 60 * 1_000;

interface ClaudeSubscriptionProbeInput {
  readonly instanceId?: ProviderInstanceId;
  readonly binaryPath?: string | undefined;
  readonly homePath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
  readonly homeDir?: string | undefined;
  readonly isolationRootDir?: string;
  readonly assertStateBindingCurrent?: () => void;
}

function waitForAbortSignal(signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

function hashCacheComponent(value: string): string {
  let hash = 0x811c9dc5;
  for (let index = 0; index < value.length; index += 1) {
    hash ^= value.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(36);
}

function environmentFingerprint(
  environment: Readonly<Record<string, string>> | undefined,
): Record<string, string> | null {
  if (!environment || Object.keys(environment).length === 0) {
    return null;
  }
  return Object.fromEntries(
    Object.entries(environment)
      .toSorted(([left], [right]) => left.localeCompare(right))
      .map(([name, value]) => [name, hashCacheComponent(value)]),
  );
}

function claudeSubscriptionProbeKey(input: ClaudeSubscriptionProbeInput): string {
  return JSON.stringify({
    instanceId: input.instanceId?.trim() || null,
    binaryPath: input.binaryPath?.trim() || null,
    homeDir: input.homeDir?.trim() || null,
    homePath: input.homePath?.trim() || null,
    isolationRootDir: input.isolationRootDir?.trim() || null,
    environment: environmentFingerprint(input.environment),
  });
}

const probeClaudeSubscription = (
  input: ClaudeSubscriptionProbeInput,
  programs: AgentProgramOwnership,
) => {
  const abort = new AbortController();
  const env = makeClaudeProbeEnv(
    input.homePath,
    input.environment,
    input.homeDir,
    input.instanceId,
    input.isolationRootDir,
  );
  return Effect.tryPromise(async () => {
    const executable = resolveClaudeCodeExecutablePath({
      binaryPath: input.binaryPath,
      providerInstanceId: input.instanceId,
      env: process.env,
    });
    if (!executable) return undefined;
    const { query: claudeQuery } = await loadClaudeAgentSdk();
    input.assertStateBindingCurrent?.();
    const q = claudeQuery({
      // oxlint-disable-next-line require-yield
      prompt: (async function* (): AsyncGenerator<SDKUserMessage> {
        await waitForAbortSignal(abort.signal);
      })(),
      options: {
        persistSession: false,
        abortController: abort,
        pathToClaudeCodeExecutable: executable,
        spawnClaudeCodeProcess: (options) => {
          input.assertStateBindingCurrent?.();
          return programs.spawn({
            binaryPath: executable,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            env,
            sourceHomePath: agentProgramSourceHome(
              "claudeAgent",
              env,
              input.homeDir ?? OS.homedir(),
            ),
            spawn: () => spawnOwnedClaudeCodeProcess(options),
          });
        },
        settingSources: ["user", "project", "local"],
        allowedTools: [],
        env,
        stderr: () => {},
      },
    });
    const init = await q.initializationResult();
    return { subscriptionType: init.account?.subscriptionType };
  }).pipe(
    Effect.ensuring(
      Effect.sync(() => {
        if (!abort.signal.aborted) abort.abort();
      }),
    ),
    Effect.timeoutOption(CAPABILITIES_PROBE_TIMEOUT_MS),
    Effect.result,
    Effect.map((result) => {
      if (Result.isFailure(result)) return undefined;
      return Option.isSome(result.success) ? result.success.value : undefined;
    }),
  );
};

export function parseAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly voiceTranscriptionAvailable?: boolean;
  readonly message?: string;
} {
  const lowerOutput = `${result.stdout}\n${result.stderr}`.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Codex CLI authentication status command is unavailable in this Codex version.",
    };
  }

  if (
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("run `codex login`") ||
    lowerOutput.includes("run codex login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }

  const parsedAuth = (() => {
    const trimmed = result.stdout.trim();
    if (!trimmed || (!trimmed.startsWith("{") && !trimmed.startsWith("["))) {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
    try {
      const parsed = JSON.parse(trimmed);
      return {
        attemptedJsonParse: true as const,
        auth: extractAuthBoolean(parsed),
        authMethod: extractAuthMethod(parsed),
      };
    } catch {
      return {
        attemptedJsonParse: false as const,
        auth: undefined as boolean | undefined,
        authMethod: undefined as string | undefined,
      };
    }
  })();

  if (parsedAuth.auth === true) {
    const voiceTranscriptionAvailable = resolveVoiceTranscriptionAvailability(
      parsedAuth.authMethod,
    );
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(voiceTranscriptionAvailable !== undefined ? { voiceTranscriptionAvailable } : {}),
    };
  }
  if (parsedAuth.auth === false) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Codex CLI is not authenticated. Run `codex login` and try again.",
    };
  }
  if (parsedAuth.attemptedJsonParse) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Could not verify Codex authentication status from JSON output (missing auth marker).",
    };
  }
  if (result.code === 0) {
    // Current Codex CLI prints login status as plain text (on stderr), not JSON.
    // Only explicit login methods establish voice capability; unknown successful
    // output remains authenticated without advertising ChatGPT-only dictation.
    const voiceTranscriptionAvailable = /^logged in using chatgpt\s*$/m.test(lowerOutput)
      ? true
      : /^logged in using an api key\b/m.test(lowerOutput)
        ? false
        : undefined;
    return {
      status: "ready",
      authStatus: "authenticated",
      ...(voiceTranscriptionAvailable !== undefined ? { voiceTranscriptionAvailable } : {}),
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Codex authentication status. ${detail}`
      : "Could not verify Codex authentication status.",
  };
}

// ── Codex CLI config detection ──────────────────────────────────────

/**
 * Providers that use OpenAI-native authentication via `codex login`.
 * When the configured `model_provider` is one of these, the `codex login
 * status` probe still runs. For any other provider value the auth probe
 * is skipped because authentication is handled externally (e.g. via
 * environment variables like `PORTKEY_API_KEY` or `AZURE_API_KEY`).
 */
const OPENAI_AUTH_PROVIDERS = new Set(["openai"]);

// ── Effect-native command execution ─────────────────────────────────

const collectStreamAsString = <E>(
  stream: Stream.Stream<Uint8Array, E>,
  fallbackEncoding?: string,
): Effect.Effect<string, E> =>
  Stream.runFold(
    stream,
    () => [] as Uint8Array[],
    (chunks, chunk) => {
      chunks.push(chunk);
      return chunks;
    },
  ).pipe(Effect.map((chunks) => decodeProviderCommandOutput(chunks, fallbackEncoding)));

const runProviderCommand = (
  executable: string,
  args: ReadonlyArray<string>,
  options: {
    readonly env: NodeJS.ProcessEnv;
    readonly cwd?: string | undefined;
    readonly assertStateBindingCurrent?: () => void;
  },
  provider?: "codex" | "claudeAgent",
) =>
  Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const config = Option.getOrUndefined(yield* Effect.serviceOption(ServerConfig));
    const programs = provider
      ? config
        ? agentProgramsForServer(config, provider)
        : makeAgentProgramOwnership(provider)
      : undefined;
    const run = (spawned: () => void) =>
      Effect.gen(function* () {
        yield* Effect.try({
          try: () => options.assertStateBindingCurrent?.(),
          catch: (cause) => cause,
        });
        const command = makeEffectProcessCommand(executable, args, {
          env: options.env,
          ...(options.cwd ? { cwd: options.cwd } : {}),
          // Health probes are non-interactive. Leaving stdin as a pipe can keep CLIs
          // such as Antigravity waiting even after a read-only subcommand has finished.
          stdin: "ignore",
        });

        const child = yield* spawner.spawn(command);
        spawned();
        const fallbackEncoding = yield* Effect.promise(readWindowsAnsiEncoding);

        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectStreamAsString(child.stdout, fallbackEncoding),
            collectStreamAsString(child.stderr, fallbackEncoding),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );

        return { stdout, stderr, code: exitCode } satisfies CommandResult;
      }).pipe(Effect.scoped);
    return yield* programs && provider
      ? programs.withOperation(
          {
            binaryPath: executable,
            env: options.env,
            ...(options.cwd ? { cwd: options.cwd } : {}),
            sourceHomePath: agentProgramSourceHome(
              provider,
              options.env,
              config?.homeDir ?? OS.homedir(),
            ),
          },
          run,
        )
      : run(() => {});
  }).pipe(Effect.scoped);

const runCodexCommand = (
  args: ReadonlyArray<string>,
  executable = "codex",
  env: NodeJS.ProcessEnv = providerCommandEnv(CODEX_PROVIDER),
) =>
  // Account health must not merge project config from the desktop's working directory.
  runProviderCommand(executable, args, { env, cwd: env.CODEX_HOME }, "codex").pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runClaudeCommand = (
  args: ReadonlyArray<string>,
  executable = "claude",
  env: NodeJS.ProcessEnv = buildClaudeProcessEnv(),
  assertStateBindingCurrent?: () => void,
) =>
  runProviderCommand(
    executable,
    args,
    { env, ...(assertStateBindingCurrent ? { assertStateBindingCurrent } : {}) },
    "claudeAgent",
  ).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const makeProviderProbeEnv = (
  provider: ProviderChildKind,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): NodeJS.ProcessEnv =>
  buildProviderChildEnvironment({
    provider,
    baseEnv: isAccountIsolatedProviderDriver(provider)
      ? buildProviderProcessEnv({
          driver: provider,
          ...(environment !== undefined ? { environment } : {}),
          ...(instanceId !== undefined ? { instanceId } : {}),
          ...(paths?.homeDir !== undefined ? { homeDir: paths.homeDir } : {}),
          ...(paths?.isolationRootDir !== undefined
            ? { isolationRootDir: paths.isolationRootDir }
            : {}),
        })
      : environment !== undefined
        ? { ...process.env, ...environment }
        : process.env,
  });

const tryMakeProviderProbeEnv = (
  provider: Extract<ProviderProcessEnvDriver, ProviderChildKind>,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
):
  | { readonly ok: true; readonly env: NodeJS.ProcessEnv }
  | { readonly ok: false; readonly cause: unknown } => {
  try {
    return { ok: true, env: makeProviderProbeEnv(provider, environment, instanceId, paths) };
  } catch (cause) {
    return { ok: false, cause };
  }
};

function providerHomePreparationFailure(
  provider: Extract<ProviderProcessEnvDriver, ProviderChildKind>,
  checkedAt: string,
  cause: unknown,
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "error",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: `Failed to prepare the private provider account home. ${cause instanceof Error ? cause.message : String(cause)}`,
  };
}

function isAccountIsolatedProviderDriver(
  provider: ProviderChildKind,
): provider is Extract<ProviderProcessEnvDriver, ProviderChildKind> {
  return (
    provider === "cursor" ||
    provider === "grok" ||
    provider === "opencode" ||
    provider === "pi" ||
    provider === "omp"
  );
}

export const makeProviderUpdateEnv = (
  instance: ResolvedProviderInstance,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): NodeJS.ProcessEnv => {
  const environment =
    instance.raw.environment !== undefined || Object.keys(instance.environment).length > 0
      ? instance.environment
      : undefined;
  switch (instance.driver) {
    case "claudeAgent":
      return makeProviderProbeEnv("claude", environment);
    case "gemini":
    case "hermes":
      return makeProviderProbeEnv(instance.driver, environment, instance.instanceId, paths);
    case "kilo":
      throw new Error("Provider 'kilo' is no longer supported by Moss.");
    case "codex":
    case "cursor":
    case "devin":
    case "antigravity":
    case "grok":
    case "droid":
    case "opencode":
    case "pi":
    case "omp":
    case "kimi":
    case "minimax":
    case "zcode":
      return makeProviderProbeEnv(instance.driver, environment, instance.instanceId, paths);
  }
};

const runGrokCommand = (
  args: ReadonlyArray<string>,
  executable = "grok",
  env: NodeJS.ProcessEnv = providerCommandEnv(GROK_PROVIDER),
) =>
  runProviderCommand(executable, args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runGeminiCommand = (
  args: ReadonlyArray<string>,
  executable = "gemini",
  env: NodeJS.ProcessEnv = providerCommandEnv(GEMINI_PROVIDER),
) =>
  runProviderCommand(executable, args, { env: buildGeminiProbeEnv(env) }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOpenCodeCommand = (
  args: ReadonlyArray<string>,
  executable = "opencode",
  env: NodeJS.ProcessEnv = providerCommandEnv(OPENCODE_PROVIDER),
) =>
  runProviderCommand(executable, args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runCursorCommand = (
  args: ReadonlyArray<string>,
  executable = DEFAULT_CURSOR_AGENT_BINARY,
  env: NodeJS.ProcessEnv = buildCursorAgentHeadlessEnv(),
) => {
  const command = buildCursorAgentCommand(executable, args);
  return runProviderCommand(command.command, command.args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${command.command} ENOENT`))
        : Effect.succeed(result),
    ),
  );
};

function parseCursorAuthStatusFromOutput(result: CommandResult): {
  readonly status: ServerProviderStatusState;
  readonly authStatus: ServerProviderAuthStatus;
  readonly message?: string;
} {
  const output = `${result.stdout}\n${result.stderr}`;
  const lowerOutput = output.toLowerCase();

  if (
    lowerOutput.includes("unknown command") ||
    lowerOutput.includes("unrecognized command") ||
    lowerOutput.includes("unexpected argument")
  ) {
    return {
      status: "warning",
      authStatus: "unknown",
      message:
        "Cursor Agent authentication status command is unavailable in this Cursor Agent version.",
    };
  }

  if (
    lowerOutput.includes("authentication required") ||
    lowerOutput.includes("not logged in") ||
    lowerOutput.includes("not authenticated") ||
    lowerOutput.includes("unauthenticated") ||
    lowerOutput.includes("login required") ||
    lowerOutput.includes("run 'agent login'") ||
    lowerOutput.includes("run `agent login`") ||
    lowerOutput.includes("run cursor-agent login")
  ) {
    return {
      status: "error",
      authStatus: "unauthenticated",
      message: "Cursor Agent is not authenticated. Run `cursor-agent login` and try again.",
    };
  }

  if (
    lowerOutput.includes("logged in") ||
    lowerOutput.includes("login successful") ||
    lowerOutput.includes("authenticated")
  ) {
    return { status: "ready", authStatus: "authenticated" };
  }

  if (result.code === 0) {
    return {
      status: "warning",
      authStatus: "unknown",
      message: "Cursor Agent is installed, but Moss could not verify authentication status.",
    };
  }

  const detail = detailFromResult(result);
  return {
    status: "warning",
    authStatus: "unknown",
    message: detail
      ? `Could not verify Cursor Agent authentication status. ${detail}`
      : "Could not verify Cursor Agent authentication status.",
  };
}

function cursorModelsOutputHasModels(output: string): boolean {
  return output.split(/\r?\n/u).some((line) => line.trim().length > 0 && line.includes(" - "));
}

function cursorModelsOutputHasNoModels(output: string): boolean {
  return output.toLowerCase().includes("no models available");
}

const runPiCommand = (
  args: ReadonlyArray<string>,
  executable = "pi",
  env: NodeJS.ProcessEnv = providerCommandEnv(PI_PROVIDER),
) =>
  runProviderCommand(executable, args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runOmpCommand = (
  args: ReadonlyArray<string>,
  executable = "omp",
  env: NodeJS.ProcessEnv = providerCommandEnv(OMP_PROVIDER),
) =>
  runProviderCommand(executable, args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

const runAntigravityCommand = (
  args: ReadonlyArray<string>,
  executable = "agy",
  env: NodeJS.ProcessEnv = providerCommandEnv(ANTIGRAVITY_PROVIDER),
) =>
  runProviderCommand(executable, args, { env }).pipe(
    Effect.flatMap((result) =>
      isWindowsShellCommandMissingResult({ code: result.code, stderr: result.stderr })
        ? Effect.fail(new Error(`spawn ${executable} ENOENT`))
        : Effect.succeed(result),
    ),
  );

// ── Health check ────────────────────────────────────────────────────

async function makeCodexProbeEnv(
  homePath?: string,
  shadowHomePath?: string,
  accountId?: string,
  environment?: Readonly<Record<string, string>>,
  readManagedHomeAuthority?: () => Promise<ManagedCodexHomeAuthority | undefined>,
  credentialScope?: CodexCredentialScopeInput,
): Promise<NodeJS.ProcessEnv> {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  const normalizedShadowHomePath = nonEmptyTrimmed(shadowHomePath);
  const normalizedAccountId = nonEmptyTrimmed(accountId);
  const managedHomeAuthority = await readManagedHomeAuthority?.();
  return buildCodexProcessEnv({
    ...(credentialScope?.credentialFence
      ? { credentialFence: credentialScope.credentialFence }
      : {}),
    ...(credentialScope?.runtimeGeneration
      ? { runtimeGeneration: credentialScope.runtimeGeneration }
      : {}),
    ...(managedHomeAuthority ? { managedHomeAuthority } : {}),
    ...(environment ? { env: { ...process.env, ...environment } } : {}),
    ...(normalizedHomePath ? { homePath: normalizedHomePath } : {}),
    ...(normalizedShadowHomePath ? { shadowHomePath: normalizedShadowHomePath } : {}),
    ...(normalizedAccountId ? { accountId: normalizedAccountId } : {}),
  });
}

export function makeClaudeProbeEnv(
  homePath?: string,
  environment?: Readonly<Record<string, string>>,
  homeDir?: string,
  providerInstanceId?: ProviderInstanceId,
  isolationRootDir?: string,
): NodeJS.ProcessEnv {
  const normalizedHomePath = nonEmptyTrimmed(homePath);
  const baseHomeDir = nonEmptyTrimmed(homeDir) ?? OS.homedir();
  const resolvedHomePath =
    normalizedHomePath === "~"
      ? baseHomeDir
      : normalizedHomePath?.startsWith("~/")
        ? nodePath.join(baseHomeDir, normalizedHomePath.slice(2))
        : normalizedHomePath;
  return buildClaudeInstanceProcessEnv(resolvedHomePath, environment, {
    homeDir: baseHomeDir,
    ...(providerInstanceId ? { providerInstanceId } : {}),
    ...(isolationRootDir ? { isolationRootDir } : {}),
  });
}

export const readCodexConfigModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.gen(function* () {
    const fileSystem = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const codexHome = env.CODEX_HOME?.trim() || path.join(OS.homedir(), ".codex");
    const configPath = path.join(codexHome, "config.toml");

    const content = yield* fileSystem
      .readFileString(configPath)
      .pipe(Effect.orElseSucceed(() => undefined));
    if (content === undefined) {
      return undefined;
    }

    return parseCodexConfigModelProvider(content);
  });

const hasCustomModelProviderForEnv = (env: NodeJS.ProcessEnv) =>
  Effect.map(
    readCodexConfigModelProviderForEnv(env),
    (provider) => provider !== undefined && !OPENAI_AUTH_PROVIDERS.has(provider),
  );

export const makeCheckCodexProviderStatus = (
  binaryPath?: string,
  homePath?: string,
  shadowHomePath?: string,
  accountId?: string,
  environment?: Readonly<Record<string, string>>,
  readManagedHomeAuthority?: () => Promise<ManagedCodexHomeAuthority | undefined>,
  credentialScope?: CodexCredentialScopeInput,
): Effect.Effect<
  ServerProviderStatus,
  never,
  ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
> => {
  return Effect.suspend(() => {
    // Desktop runtime hints belong to the server, never to a provider's environment override.
    let resolution: ReturnType<typeof resolveCodexExecutable>;
    try {
      resolution = resolveCodexExecutable({
        configuredBinaryPath: binaryPath,
        accountId,
        env: process.env,
      });
    } catch (cause) {
      return Effect.succeed<ServerProviderStatus>({
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt: new Date().toISOString(),
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
    const executable = resolution.binaryPath;
    return Effect.gen(function* () {
      const checkedAt = new Date().toISOString();
      // Overlay materialization can reject misconfigured account homes (e.g. a
      // symlinked shadow auth.json); report that as this instance's status instead
      // of letting a defect take down the whole provider refresh.
      const probeEnvResult = yield* Effect.tryPromise({
        try: () =>
          makeCodexProbeEnv(
            homePath,
            shadowHomePath,
            accountId,
            environment,
            readManagedHomeAuthority,
            credentialScope,
          ),
        catch: (cause) => cause,
      }).pipe(Effect.result);
      if (Result.isFailure(probeEnvResult)) {
        const error = probeEnvResult.failure;
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: error instanceof Error ? error.message : String(error),
        } satisfies ServerProviderStatus;
      }
      const probeEnv = probeEnvResult.success;

      // Probe 1: `codex --version` — is the CLI reachable?
      const versionProbe = yield* probeProviderCliVersion(
        runCodexCommand(["--version"], executable, probeEnv),
        DEFAULT_TIMEOUT_MS,
      );

      if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
        const error = versionProbe.cause;
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          ...(versionProbe.outcome === "missing"
            ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
            : {}),
          message:
            versionProbe.outcome === "missing"
              ? "Codex CLI (`codex`) is not installed or not on PATH."
              : `Failed to execute Codex CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }

      if (versionProbe.outcome === "timeout") {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: "Codex CLI is installed but failed to run. Timed out while running command.",
        };
      }

      if (versionProbe.outcome === "nonzero") {
        const version = versionProbe.result;
        const detail = detailFromResult(version);
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: detail
            ? `Codex CLI is installed but failed to run. ${detail}`
            : "Codex CLI is installed but failed to run.",
        };
      }
      const version = versionProbe.result;

      const parsedVersion = parseCodexCliVersion(`${version.stdout}\n${version.stderr}`);
      if (!parsedVersion) {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: CODEX_CLI_UNPARSEABLE_VERSION_MESSAGE,
        } satisfies ServerProviderStatus;
      }
      if (resolution.source === "bundled" && parsedVersion !== MOSS_BUNDLED_CODEX_VERSION) {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: formatBundledCodexExecutableVersionMismatch(parsedVersion),
        };
      }
      if (!isCodexCliVersionSupported(parsedVersion)) {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: formatCodexCliUpgradeMessage(parsedVersion),
        };
      }
      const supportsAutoRuntimeMode =
        parsedVersion !== null &&
        compareCodexCliVersions(parsedVersion, MINIMUM_CODEX_AUTO_REVIEW_CLI_VERSION) >= 0;

      // Probe 2: `codex login status` — is the user authenticated?
      //
      // Custom model providers (e.g. Portkey, Azure OpenAI proxy) handle
      // authentication through their own environment variables, so `codex
      // login status` will report "not logged in" even when the CLI works
      // fine.  Skip the auth probe entirely for non-OpenAI providers.
      if (yield* hasCustomModelProviderForEnv(probeEnv)) {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "ready" as const,
          available: true,
          authStatus: "unknown" as const,
          version: parsedVersion,
          supportsAutoRuntimeMode,
          checkedAt,
          message: "Using a custom Codex model provider; OpenAI login check skipped.",
        } satisfies ServerProviderStatus;
      }

      const authProbe = yield* runCodexCommand(CODEX_AUTH_STATUS_ARGS, executable, probeEnv).pipe(
        Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
        Effect.result,
      );

      if (Result.isFailure(authProbe)) {
        const error = authProbe.failure;
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "warning" as const,
          available: true,
          authStatus: "unknown" as const,
          version: parsedVersion,
          supportsAutoRuntimeMode,
          checkedAt,
          message:
            error instanceof Error
              ? `Could not verify Codex authentication status: ${error.message}.`
              : "Could not verify Codex authentication status.",
        };
      }

      if (Option.isNone(authProbe.success)) {
        return {
          provider: CODEX_PROVIDER,
          instanceId: CODEX_PROVIDER,
          driver: CODEX_PROVIDER,
          status: "warning" as const,
          available: true,
          authStatus: "unknown" as const,
          version: parsedVersion,
          supportsAutoRuntimeMode,
          checkedAt,
          message: "Could not verify Codex authentication status. Timed out while running command.",
        };
      }

      const authOutput = authProbe.success.value;
      const parsed = parseAuthStatusFromOutput(authOutput);
      const codexPlanType = extractSubscriptionTypeFromOutput(authOutput);
      const codexAccountType = extractCodexAccountTypeFromOutput(authOutput);
      const codexLabel =
        parsed.authStatus === "authenticated"
          ? codexAccountAuthLabel({ type: codexAccountType, planType: codexPlanType })
          : undefined;
      const codexAuthType =
        parsed.authStatus === "authenticated"
          ? codexAccountType === "apiKey"
            ? "apiKey"
            : codexPlanType
          : undefined;

      return {
        provider: CODEX_PROVIDER,
        instanceId: CODEX_PROVIDER,
        driver: CODEX_PROVIDER,
        status: parsed.status,
        available: true,
        authStatus: parsed.authStatus,
        version: parsedVersion,
        supportsAutoRuntimeMode,
        ...(codexAuthType ? { authType: codexAuthType } : {}),
        ...(codexLabel ? { authLabel: codexLabel } : {}),
        ...(parsed.voiceTranscriptionAvailable !== undefined
          ? { voiceTranscriptionAvailable: parsed.voiceTranscriptionAvailable }
          : {}),
        checkedAt,
        ...(parsed.message ? { message: parsed.message } : {}),
      } satisfies ServerProviderStatus;
    }).pipe(
      Effect.map((status) => ({
        ...status,
        autoRuntimeModeBinaryPath: executable,
      })),
    );
  });
};

export const checkCodexProviderStatus = makeCheckCodexProviderStatus();

// ── Claude Agent health check ───────────────────────────────────────

const CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS = 1_000;

export const makeCheckClaudeProviderStatus = (
  resolveSubscriptionType?: Effect.Effect<string | undefined>,
  binaryPath?: string,
  homeDir?: string,
  options?: {
    readonly falseNegativeRetryDelayMs?: number;
    readonly providerInstanceId?: ProviderInstanceId;
    readonly isolationRootDir?: string;
    readonly fallbackHomeDir?: string;
    readonly assertStateBindingCurrent?: () => void;
  },
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> => {
  return Effect.suspend(() => {
    const executable = resolveClaudeCodeExecutablePath({
      binaryPath,
      providerInstanceId: options?.providerInstanceId,
      env: process.env,
    });
    if (!executable) {
      return Effect.succeed<ServerProviderStatus>({
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt: new Date().toISOString(),
        message:
          "Moss managed Claude runtime is unavailable. Reinstall Moss before using this provider.",
      });
    }
    return Effect.gen(function* () {
      const checkedAt = new Date().toISOString();
      const claudeEnv = makeClaudeProbeEnv(
        homeDir,
        environment,
        options?.fallbackHomeDir,
        options?.providerInstanceId,
        options?.isolationRootDir,
      );

      // Probe 1: `claude --version` — is the CLI reachable?
      const versionProbe = yield* probeProviderCliVersion(
        runClaudeCommand(["--version"], executable, claudeEnv, options?.assertStateBindingCurrent),
        CLAUDE_HEALTH_TIMEOUT_MS,
      );

      if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
        const error = versionProbe.cause;
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: CLAUDE_AGENT_PROVIDER,
          driver: CLAUDE_AGENT_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          ...(versionProbe.outcome === "missing"
            ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
            : {}),
          message:
            versionProbe.outcome === "missing"
              ? "Claude Agent CLI (`claude`) is not installed or not on PATH."
              : `Failed to execute Claude Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
        };
      }

      if (versionProbe.outcome === "timeout") {
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: CLAUDE_AGENT_PROVIDER,
          driver: CLAUDE_AGENT_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message:
            "Claude Agent CLI is installed but failed to run. Timed out while running command.",
        };
      }

      if (versionProbe.outcome === "nonzero") {
        const version = versionProbe.result;
        const detail = detailFromResult(version);
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: CLAUDE_AGENT_PROVIDER,
          driver: CLAUDE_AGENT_PROVIDER,
          status: "error" as const,
          available: false,
          authStatus: "unknown" as const,
          checkedAt,
          message: detail
            ? `Claude Agent CLI is installed but failed to run. ${detail}`
            : "Claude Agent CLI is installed but failed to run.",
        };
      }
      const version = versionProbe.result;
      const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
      const supportsAutoRuntimeMode = isClaudeAutoModeCliVersionSupported(parsedVersion);

      // Probe 2: `claude auth status` — is the user authenticated? The command can
      // redeem a single-use rotating OAuth refresh token, so it is serialized with
      // every other `claude auth status` invocation in this process (credential
      // keepalive, concurrent health probes) via the shared lock.
      const runAuthStatusProbe = Effect.acquireUseRelease(
        Effect.promise(() => acquireClaudeAuthStatusLock()),
        () =>
          runClaudeCommand(
            ["auth", "status"],
            executable,
            claudeEnv,
            options?.assertStateBindingCurrent,
          ).pipe(Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS)),
        (release) => Effect.sync(release),
      ).pipe(Effect.result);

      const authProbe = yield* runAuthStatusProbe;

      if (Result.isFailure(authProbe)) {
        const error = authProbe.failure;
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: CLAUDE_AGENT_PROVIDER,
          driver: CLAUDE_AGENT_PROVIDER,
          status: "warning" as const,
          available: true,
          authStatus: "unknown" as const,
          version: parsedVersion,
          supportsAutoRuntimeMode,
          checkedAt,
          message:
            error instanceof Error
              ? `Could not verify Claude authentication status: ${error.message}.`
              : "Could not verify Claude authentication status.",
        };
      }

      if (Option.isNone(authProbe.success)) {
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: CLAUDE_AGENT_PROVIDER,
          driver: CLAUDE_AGENT_PROVIDER,
          status: "warning" as const,
          available: true,
          authStatus: "unknown" as const,
          version: parsedVersion,
          supportsAutoRuntimeMode,
          checkedAt,
          message:
            "Could not verify Claude authentication status. Timed out while running command.",
        };
      }

      let authOutput = authProbe.success.value;
      let parsed = parseClaudeAuthStatusFromOutput(authOutput);
      const credentialsHome = nonEmptyTrimmed(claudeEnv.HOME) ?? homeDir;
      const credentialSummary = readClaudeCliCredentialsSummary(
        credentialsHome ? { env: claudeEnv, homeDir: credentialsHome } : { env: claudeEnv },
      );
      // A structured `loggedIn:false` with a clean exit and no local credential
      // record to rescue it (macOS keeps OAuth in the Keychain, not on disk) is
      // the signature of a lost refresh-token rotation race with a concurrent
      // `claude auth status` invocation. Re-probe once after the rotation settles.
      if (
        !credentialSummary.usable &&
        isStructuredClaudeAuthFalseNegativeCandidate(authOutput, parsed)
      ) {
        const retryDelayMs =
          options?.falseNegativeRetryDelayMs ?? CLAUDE_AUTH_FALSE_NEGATIVE_RETRY_DELAY_MS;
        if (retryDelayMs > 0) {
          yield* Effect.sleep(retryDelayMs);
        }
        const retryProbe = yield* runAuthStatusProbe;
        if (Result.isSuccess(retryProbe) && Option.isSome(retryProbe.success)) {
          authOutput = retryProbe.success.value;
          parsed = parseClaudeAuthStatusFromOutput(authOutput);
        }
      }
      const structuredFalseNegative = isStructuredClaudeAuthFalseNegativeCandidate(
        authOutput,
        parsed,
      );
      const credentialProbeSubscriptionType =
        credentialSummary.usable && structuredFalseNegative && resolveSubscriptionType
          ? yield* resolveSubscriptionType
          : undefined;
      // Claude 2.1.x can report `loggedIn:false` from `auth status` while a live
      // SDK init still reads account metadata. Token strings alone are not enough:
      // require the SDK probe before treating the credential file as authenticated.
      const effectiveParsed: ReturnType<typeof parseClaudeAuthStatusFromOutput> =
        credentialProbeSubscriptionType !== undefined
          ? { status: "ready", authStatus: "authenticated" }
          : parsed;
      const useCredentialMetadata = credentialProbeSubscriptionType !== undefined;

      // Determine subscription type from multiple sources (cheapest first):
      // 1. JSON output of `claude auth status` (may or may not contain it)
      // 2. Cached SDK probe (spawns a Claude process on miss, reads
      //    `initializationResult()` for account metadata, then aborts
      //    immediately — no API tokens are consumed)
      let subscriptionType =
        extractSubscriptionTypeFromOutput(authOutput) ??
        credentialProbeSubscriptionType ??
        (useCredentialMetadata ? credentialSummary.subscriptionType : undefined);
      const authMethod =
        extractClaudeAuthMethodFromOutput(authOutput) ??
        (useCredentialMetadata ? "claude.ai" : undefined);
      if (
        !subscriptionType &&
        resolveSubscriptionType &&
        effectiveParsed.authStatus === "authenticated"
      ) {
        subscriptionType = yield* resolveSubscriptionType;
      }
      const authMetadata = claudeAuthMetadata({ subscriptionType, authMethod });

      return {
        provider: CLAUDE_AGENT_PROVIDER,
        instanceId: CLAUDE_AGENT_PROVIDER,
        driver: CLAUDE_AGENT_PROVIDER,
        status: effectiveParsed.status,
        available: true,
        authStatus: effectiveParsed.authStatus,
        version: parsedVersion,
        supportsAutoRuntimeMode,
        ...(authMetadata ? { authType: authMetadata.type, authLabel: authMetadata.label } : {}),
        checkedAt,
        ...(effectiveParsed.message ? { message: effectiveParsed.message } : {}),
      } satisfies ServerProviderStatus;
    }).pipe(
      Effect.map((status) => ({
        ...status,
        autoRuntimeModeBinaryPath: executable,
      })),
    );
  });
};

export const checkClaudeProviderStatus = makeCheckClaudeProviderStatus();

// ── Grok health check ───────────────────────────────────────────────

export const makeCheckGrokProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
  readCachedLogin: typeof readGrokCachedLogin = readGrokCachedLogin,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "grok";
    const probeEnvResult = tryMakeProviderProbeEnv(GROK_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(GROK_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* probeProviderCliVersion(
      runGrokCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Grok CLI (`grok`) is not installed or not on PATH. Grok has no npm package for every platform, so use the installer at docs.x.ai/build/overview."
            : `Failed to execute Grok CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Grok CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Grok CLI is installed but failed to run. ${detail}`
          : "Grok CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const hasApiKey = hasGrokApiKeyEnv(probeEnv);
    // A Moss-managed Grok authenticates through its generated config, never a personal login.
    const managed = environment?.[MOSS_MANAGED_GROK_CONFIG_ENV_KEY] !== undefined;
    // Sessions authenticate with the API key when one is set, otherwise with the
    // cached `grok login` session (ACP `cached_token`), so report the same source.
    const hasCachedLogin =
      !hasApiKey &&
      !managed &&
      (yield* Effect.promise(() => readCachedLogin(probeEnv, paths?.homeDir))) !== null;
    if (!hasApiKey && !managed && !hasCachedLogin) {
      // Neither source a session could use exists, so a turn would fail at session
      // start. Say so up front: the composer then offers sign-in (or Moss) before
      // sending instead of showing "connected" and failing afterwards.
      return {
        provider: GROK_PROVIDER,
        instanceId: GROK_PROVIDER,
        driver: GROK_PROVIDER,
        status: "error" as const,
        available: true,
        authStatus: "unauthenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Grok is not signed in. Run `grok login` to sign in, or set XAI_API_KEY before starting a session.",
      } satisfies ServerProviderStatus;
    }

    return {
      provider: GROK_PROVIDER,
      instanceId: GROK_PROVIDER,
      driver: GROK_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey", authLabel: "xAI API Key" }
        : hasCachedLogin
          ? { authType: "grokLogin", authLabel: "Grok Account" }
          : {}),
    } satisfies ServerProviderStatus;
  });

export const checkGrokProviderStatus = makeCheckGrokProviderStatus();

// ── Droid health check ─────────────────────────────────────────────

const runDroidCommand = (
  args: ReadonlyArray<string>,
  executable = "droid",
  env: NodeJS.ProcessEnv = providerCommandEnv(DROID_PROVIDER),
) => runProviderCommand(executable, args, { env });

export const makeCheckDroidProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveDroidCliBinaryPath(nonEmptyTrimmed(binaryPath) ?? undefined);
    const probeEnv = makeProviderProbeEnv(DROID_PROVIDER, environment);

    const versionProbe = yield* probeProviderCliVersion(
      runDroidCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: DROID_PROVIDER,
        instanceId: DROID_PROVIDER,
        driver: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Droid CLI (`droid`) is not installed or not on PATH."
            : `Failed to execute Droid CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: DROID_PROVIDER,
        instanceId: DROID_PROVIDER,
        driver: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Droid CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: DROID_PROVIDER,
        instanceId: DROID_PROVIDER,
        driver: DROID_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Droid CLI is installed but failed to run. ${detail}`
          : "Droid CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const hasApiKey = hasDroidApiKeyEnv(probeEnv);

    return {
      provider: DROID_PROVIDER,
      instanceId: DROID_PROVIDER,
      driver: DROID_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: hasApiKey ? ("authenticated" as const) : ("unknown" as const),
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey", authLabel: "Factory API Key" }
        : {
            message:
              "Droid CLI is installed. Moss can use the CLI's cached device-pairing login; run `droid` to authenticate locally if needed, or set FACTORY_API_KEY.",
          }),
    } satisfies ServerProviderStatus;
  });

// ── OpenCode health check ───────────────────────────────────────────

function openCodeExternalServerStatus(input: {
  readonly checkedAt: string;
  readonly serverUrl: string;
  readonly hasServerPassword: boolean;
  readonly experimentalWebSockets?: boolean | undefined;
}): ServerProviderStatus {
  try {
    new URL(input.serverUrl);
  } catch {
    return {
      provider: OPENCODE_PROVIDER,
      instanceId: OPENCODE_PROVIDER,
      driver: OPENCODE_PROVIDER,
      status: "error",
      available: false,
      authStatus: "unknown",
      checkedAt: input.checkedAt,
      message: "Configured OpenCode server URL is invalid.",
    } satisfies ServerProviderStatus;
  }

  return {
    provider: OPENCODE_PROVIDER,
    instanceId: OPENCODE_PROVIDER,
    driver: OPENCODE_PROVIDER,
    status: "ready",
    available: true,
    authStatus: "unknown",
    checkedAt: input.checkedAt,
    ...(input.hasServerPassword
      ? { authType: "serverPassword", authLabel: "Configured server password" }
      : {}),
    message: `OpenCode will use the configured server at ${input.serverUrl}${input.experimentalWebSockets ? " with experimental WebSockets enabled" : ""}.`,
  } satisfies ServerProviderStatus;
}

export const makeCheckOpenCodeProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  connection?: {
    readonly serverUrl?: string | undefined;
    readonly serverPassword?: string | undefined;
    readonly experimentalWebSockets?: boolean | undefined;
  },
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const configuredServerUrl = nonEmptyTrimmed(connection?.serverUrl);
    if (configuredServerUrl) {
      return openCodeExternalServerStatus({
        checkedAt,
        serverUrl: configuredServerUrl,
        hasServerPassword: nonEmptyTrimmed(connection?.serverPassword) !== undefined,
        experimentalWebSockets: connection?.experimentalWebSockets,
      });
    }
    const executable = yield* Effect.promise(() =>
      resolveOpenCodeBinaryPath(expandHomePath(nonEmptyTrimmed(binaryPath) ?? "opencode")),
    );
    const probeEnvResult = tryMakeProviderProbeEnv(
      OPENCODE_PROVIDER,
      environment,
      instanceId,
      paths,
    );
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(OPENCODE_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* probeProviderCliVersion(
      runOpenCodeCommand(["--version"], executable, probeEnv),
      OPENCODE_HEALTH_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "OpenCode CLI (`opencode`) is not installed or not on PATH. Install it with `npm install -g opencode-ai`."
            : `Failed to execute OpenCode CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: `OpenCode CLI is installed but failed to run. ${PROVIDER_COMMAND_TIMEOUT_DETAIL}`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: OPENCODE_PROVIDER,
        instanceId: OPENCODE_PROVIDER,
        driver: OPENCODE_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `OpenCode CLI is installed but failed to run. ${detail}`
          : "OpenCode CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    return {
      provider: OPENCODE_PROVIDER,
      instanceId: OPENCODE_PROVIDER,
      driver: OPENCODE_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message:
        "OpenCode CLI is installed. Configure provider credentials inside OpenCode as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkOpenCodeProviderStatus = makeCheckOpenCodeProviderStatus();

// ── Hermes health check ───────────────────────────────────────────

export const checkHermesProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const probe = yield* probeProviderCliVersion(
      runProviderCommand(binaryPath || "hermes", ["acp", "--version"], {
        env: providerCommandEnv(HERMES_PROVIDER, environment),
      }),
      15_000,
    );
    const base = {
      provider: HERMES_PROVIDER,
      instanceId: HERMES_PROVIDER,
      driver: HERMES_PROVIDER,
      checkedAt,
    };
    if (probe.outcome !== "success")
      return {
        ...base,
        status: "error",
        available: false,
        authStatus: "unknown",
        ...(probe.outcome === "missing" ? { readiness: PROVIDER_NOT_INSTALLED_READINESS } : {}),
        message: "Hermes ACP is not available. Install Hermes with its ACP dependencies.",
      } satisfies ServerProviderStatus;
    let managed = false;
    try {
      managed =
        instanceId === "hermes_moss" && readMossManagedHermesConfig(environment) !== undefined;
    } catch {
      /* Invalid managed settings must not authenticate. */
    }
    return {
      ...base,
      status: "ready",
      available: true,
      authStatus: managed ? "authenticated" : "unknown",
      version: parseGenericCliVersion(probe.result.stdout),
      message: managed
        ? "Using the Moss managed gateway."
        : "Hermes ACP is installed. Run hermes setup to configure credentials.",
    } satisfies ServerProviderStatus;
  });

// ── Generic ACP agent health check (Kimi Code, MiniMax Code, ZCode) ──

export const checkAcpAgentProviderStatus = (
  spec: AcpAgentSpec,
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = binaryPath || spec.command;
    const probeEnv = providerCommandEnv(spec.kind, environment);
    // Node CLIs (and the Bun re-exec of zcode-acp-server) take a moment to boot.
    const probe = yield* probeProviderCliVersion(
      runProviderCommand(executable, spec.versionProbeArgs, { env: probeEnv }),
      15_000,
    );
    const base = {
      provider: spec.kind,
      instanceId: spec.kind,
      driver: spec.kind,
      checkedAt,
      status: "error" as const,
      available: false,
      authStatus: "unknown" as const,
    };
    switch (probe.outcome) {
      case "missing":
        return {
          ...base,
          readiness: PROVIDER_NOT_INSTALLED_READINESS,
          message: `${spec.displayName} CLI (\`${spec.command}\`) is not installed or not on PATH. ${spec.install.hint}`,
        } satisfies ServerProviderStatus;
      case "failure":
        return {
          ...base,
          message: `Failed to execute the ${spec.displayName} CLI health check: ${probe.cause instanceof Error ? probe.cause.message : String(probe.cause)}.`,
        } satisfies ServerProviderStatus;
      case "timeout":
        return {
          ...base,
          message: `${spec.displayName} CLI is installed but failed to run. ${PROVIDER_COMMAND_TIMEOUT_DETAIL}`,
        } satisfies ServerProviderStatus;
      case "nonzero": {
        const detail = detailFromResult(probe.result);
        return {
          ...base,
          message: detail
            ? `${spec.displayName} CLI is installed but failed to run. ${detail}`
            : `${spec.displayName} CLI is installed but failed to run.`,
        } satisfies ServerProviderStatus;
      }
      case "success": {
        const version = parseGenericCliVersion(`${probe.result.stdout}\n${probe.result.stderr}`);
        const hostProblem = spec.hostRequirement?.(probeEnv);
        if (hostProblem) {
          return { ...base, version, message: hostProblem } satisfies ServerProviderStatus;
        }
        let managed = false;
        try {
          managed =
            instanceId === spec.managedInstanceId &&
            readMossManagedAcpAgentCatalog(spec, environment) !== undefined;
        } catch {
          /* Invalid managed settings must not authenticate. */
        }
        // Own-login state lives in the CLI's own credential store; a session
        // start reports a missing login with the sign-in hint, so stay
        // "unknown" there.
        return {
          ...base,
          status: "ready",
          available: true,
          authStatus: managed ? "authenticated" : "unknown",
          version,
          message: managed
            ? "Using the Moss managed gateway."
            : `${spec.displayName} CLI is installed. ${spec.signIn.hint}`,
        } satisfies ServerProviderStatus;
      }
    }
  });

// ── Pi health check ─────────────────────────────────────────────

export const checkPiProviderStatus = (
  agentDir?: string,
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "pi";
    const probeEnvResult = tryMakeProviderProbeEnv(PI_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(PI_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;

    const versionProbe = yield* probeProviderCliVersion(
      runPiCommand(["--version"], executable, probeEnv),
      PI_HEALTH_TIMEOUT_MS,
    );

    // Moss drives the person's own Pi CLI (`pi --mode rpc`), so a missing CLI means Pi
    // cannot run: offer the one-click install, like every other agent CLI.
    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Pi CLI (`pi`) is not on PATH. Install it to use the Pi provider."
            : `Pi CLI health check failed: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Pi CLI health check timed out before Moss could verify the installed version.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const detail = detailFromResult(versionProbe.result);
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail ? `Pi CLI health check failed. ${detail}` : "Pi CLI health check failed.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (
      parsedVersion !== null &&
      compareSemverVersions(parsedVersion, MINIMUM_PI_CLI_VERSION) < 0
    ) {
      return {
        provider: PI_PROVIDER,
        instanceId: PI_PROVIDER,
        driver: PI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message: `Pi CLI ${parsedVersion} is too old for Moss. Upgrade to ${MINIMUM_PI_CLI_VERSION} or newer.`,
      } satisfies ServerProviderStatus;
    }
    const configuredAgentDir = nonEmptyTrimmed(agentDir);
    return {
      provider: PI_PROVIDER,
      instanceId: PI_PROVIDER,
      driver: PI_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: configuredAgentDir
        ? `Pi CLI is installed. Moss will use Pi agent dir ${configuredAgentDir}.`
        : "Pi CLI is installed. Configure provider credentials inside Pi as needed.",
    } satisfies ServerProviderStatus;
  });

export const checkOmpProviderStatus = (
  agentDir?: string,
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const probeEnvResult = tryMakeProviderProbeEnv(OMP_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(OMP_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = probeEnvResult.env;
    const executable = resolveOmpCliBinaryPath(nonEmptyTrimmed(binaryPath) ?? undefined, {
      env: probeEnv,
      ...(probeEnv.HOME ? { homeDir: probeEnv.HOME } : {}),
    });

    const versionProbe = yield* probeProviderCliVersion(
      runOmpCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: OMP_PROVIDER,
        instanceId: OMP_PROVIDER,
        driver: OMP_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "OMP CLI (`omp`) is not on PATH. Install it to use the OMP provider."
            : `OMP CLI health check failed: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: OMP_PROVIDER,
        instanceId: OMP_PROVIDER,
        driver: OMP_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "OMP CLI health check timed out before Moss could verify the installed version.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: OMP_PROVIDER,
        instanceId: OMP_PROVIDER,
        driver: OMP_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail ? `OMP CLI health check failed. ${detail}` : "OMP CLI health check failed.",
      } satisfies ServerProviderStatus;
    }

    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    const configuredAgentDir = nonEmptyTrimmed(agentDir);
    return {
      provider: OMP_PROVIDER,
      instanceId: OMP_PROVIDER,
      driver: OMP_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "unknown" as const,
      version: parsedVersion,
      checkedAt,
      message: configuredAgentDir
        ? `OMP CLI is installed. Moss will use the OMP agent dir ${configuredAgentDir}.`
        : "OMP CLI is installed. Configure provider credentials inside the OMP app as needed.",
    } satisfies ServerProviderStatus;
  });

// ── Gemini CLI health check ───────────────────────────────────────

export const makeCheckGeminiProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "gemini";
    const probeEnv = makeProviderProbeEnv(GEMINI_PROVIDER, environment);

    const versionProbe = yield* runGeminiCommand(["--version"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(versionProbe)) {
      const error = versionProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(isCommandMissingCause(error) ? { readiness: PROVIDER_NOT_INSTALLED_READINESS } : {}),
        message: isCommandMissingCause(error)
          ? "Gemini CLI (`gemini`) is not installed or not on PATH."
          : `Failed to execute Gemini CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      };
    }

    if (Option.isNone(versionProbe.success)) {
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Gemini CLI is installed but failed to run. Timed out while running command.",
      };
    }

    const version = versionProbe.success.value;
    if (version.code !== 0) {
      const detail = detailFromResult(version);
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Gemini CLI is installed but failed to run. ${detail}`
          : "Gemini CLI is installed but failed to run.",
      };
    }
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    const capabilityProbe = yield* probeGeminiCapabilities({
      binaryPath: executable,
      cwd: OS.homedir(),
      ...(environment !== undefined ? { environment } : {}),
    }).pipe(Effect.result);

    if (Result.isFailure(capabilityProbe)) {
      const error = capabilityProbe.failure;
      return {
        provider: GEMINI_PROVIDER,
        instanceId: GEMINI_PROVIDER,
        driver: GEMINI_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Gemini authentication status: ${error.message}.`
            : "Could not verify Gemini authentication status.",
      };
    }

    const parsed = normalizeGeminiCapabilityProbeResult(capabilityProbe.success);
    return {
      provider: GEMINI_PROVIDER,
      instanceId: GEMINI_PROVIDER,
      driver: GEMINI_PROVIDER,
      status: parsed.status,
      available: true,
      authStatus: parsed.auth.status,
      version: parsedVersion,
      checkedAt,
      ...(parsed.message ? { message: parsed.message } : {}),
    } satisfies ServerProviderStatus;
  });

export const checkGeminiProviderStatus = makeCheckGeminiProviderStatus();

// ── Antigravity CLI health check ──────────────────────────────────

export const checkAntigravityProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = nonEmptyTrimmed(binaryPath) ?? "agy";
    const probeEnv = {
      ...makeProviderProbeEnv(ANTIGRAVITY_PROVIDER, environment),
      NO_BROWSER: "true",
      // Health probes are read-only. Prevent Antigravity from starting its
      // detached updater, which can flash a console on Windows when Moss
      // refreshes provider status (#1029).
      AGY_CLI_DISABLE_AUTO_UPDATE: "true",
    };
    const versionProbe = yield* probeProviderCliVersion(
      runAntigravityCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );
    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        instanceId: ANTIGRAVITY_PROVIDER,
        driver: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Antigravity CLI (`agy`) is not installed or is not on PATH."
            : `Antigravity CLI health check failed: ${String(versionProbe.cause)}`,
      } satisfies ServerProviderStatus;
    }
    if (versionProbe.outcome === "timeout") {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        instanceId: ANTIGRAVITY_PROVIDER,
        driver: ANTIGRAVITY_PROVIDER,
        status: "warning",
        available: true,
        authStatus: "unknown",
        checkedAt,
        message: "Antigravity CLI version check timed out.",
      } satisfies ServerProviderStatus;
    }
    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      return {
        provider: ANTIGRAVITY_PROVIDER,
        instanceId: ANTIGRAVITY_PROVIDER,
        driver: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        checkedAt,
        message: detailFromResult(version) ?? "Antigravity CLI version check failed.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);
    if (
      parsedVersion !== null &&
      compareSemverVersions(parsedVersion, MINIMUM_ANTIGRAVITY_CLI_VERSION) < 0
    ) {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        instanceId: ANTIGRAVITY_PROVIDER,
        driver: ANTIGRAVITY_PROVIDER,
        status: "error",
        available: false,
        authStatus: "unknown",
        version: parsedVersion,
        checkedAt,
        message: `Antigravity CLI ${parsedVersion} is too old for Moss. Upgrade to ${MINIMUM_ANTIGRAVITY_CLI_VERSION} or newer.`,
      } satisfies ServerProviderStatus;
    }
    const models = yield* runAntigravityCommand(["models"], executable, probeEnv).pipe(
      Effect.timeoutOption(CLAUDE_HEALTH_TIMEOUT_MS),
      Effect.result,
    );
    if (
      Result.isSuccess(models) &&
      Option.isSome(models.success) &&
      models.success.value.code === 0 &&
      models.success.value.stdout.trim().length > 0
    ) {
      return {
        provider: ANTIGRAVITY_PROVIDER,
        instanceId: ANTIGRAVITY_PROVIDER,
        driver: ANTIGRAVITY_PROVIDER,
        status: "ready",
        available: true,
        authStatus: "authenticated",
        version: parsedVersion,
        checkedAt,
        message: "Antigravity CLI is installed, authenticated, and returned available models.",
      } satisfies ServerProviderStatus;
    }
    return {
      provider: ANTIGRAVITY_PROVIDER,
      instanceId: ANTIGRAVITY_PROVIDER,
      driver: ANTIGRAVITY_PROVIDER,
      status: "warning",
      available: true,
      authStatus: "unknown",
      version: parsedVersion,
      checkedAt,
      message: "Antigravity CLI is installed, but Moss could not verify login by listing models.",
    } satisfies ServerProviderStatus;
  });

// ── Cursor health check ─────────────────────────────────────────────

export const makeCheckCursorProviderStatus = (
  binaryPath?: string,
  environment?: Readonly<Record<string, string>>,
  instanceId?: string,
  paths?: { readonly homeDir: string; readonly isolationRootDir: string },
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveCursorAgentBinaryPath(nonEmptyTrimmed(binaryPath));
    const probeEnvResult = tryMakeProviderProbeEnv(CURSOR_PROVIDER, environment, instanceId, paths);
    if (!probeEnvResult.ok) {
      return providerHomePreparationFailure(CURSOR_PROVIDER, checkedAt, probeEnvResult.cause);
    }
    const probeEnv = buildCursorAgentHeadlessEnv(probeEnvResult.env);

    const versionProbe = yield* probeProviderCliVersion(
      runCursorCommand(["--version"], executable, probeEnv),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Cursor Agent CLI (`cursor-agent`) is not installed or not on PATH."
            : `Failed to execute Cursor Agent CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message:
          "Cursor Agent CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const version = versionProbe.result;
      const detail = detailFromResult(version);
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Cursor Agent CLI is installed but failed to run. ${detail}`
          : "Cursor Agent CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }
    const version = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(`${version.stdout}\n${version.stderr}`);

    const authProbe = yield* runCursorCommand(["status"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(authProbe)) {
      const error = authProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Could not verify Cursor Agent authentication status: ${error.message}.`
            : "Could not verify Cursor Agent authentication status.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(authProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "unknown" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Could not verify Cursor Agent authentication status. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    const parsedAuth = parseCursorAuthStatusFromOutput(authProbe.success.value);
    if (parsedAuth.authStatus !== "authenticated") {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: parsedAuth.status,
        available: true,
        authStatus: parsedAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(parsedAuth.message ? { message: parsedAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }

    const modelsProbe = yield* runCursorCommand(["models"], executable, probeEnv).pipe(
      Effect.timeoutOption(DEFAULT_TIMEOUT_MS),
      Effect.result,
    );

    if (Result.isFailure(modelsProbe)) {
      const error = modelsProbe.failure;
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          error instanceof Error
            ? `Cursor Agent is authenticated, but model discovery failed: ${error.message}.`
            : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }

    if (Option.isNone(modelsProbe.success)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery timed out before Moss could verify available models.",
      } satisfies ServerProviderStatus;
    }

    const modelsResult = modelsProbe.success.value;
    const modelsOutput = `${modelsResult.stdout}\n${modelsResult.stderr}`;
    const modelAuth = parseCursorAuthStatusFromOutput(modelsResult);
    if (modelAuth.authStatus === "unauthenticated") {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: modelAuth.status,
        available: true,
        authStatus: modelAuth.authStatus,
        version: parsedVersion,
        checkedAt,
        ...(modelAuth.message ? { message: modelAuth.message } : {}),
      } satisfies ServerProviderStatus;
    }
    if (cursorModelsOutputHasNoModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but it reports no models available for this account.",
      } satisfies ServerProviderStatus;
    }
    if (modelsResult.code !== 0) {
      const detail = detailFromResult(modelsResult);
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message: detail
          ? `Cursor Agent is authenticated, but model discovery failed. ${detail}`
          : "Cursor Agent is authenticated, but model discovery failed.",
      } satisfies ServerProviderStatus;
    }
    if (!cursorModelsOutputHasModels(modelsOutput)) {
      return {
        provider: CURSOR_PROVIDER,
        instanceId: CURSOR_PROVIDER,
        driver: CURSOR_PROVIDER,
        status: "warning" as const,
        available: true,
        authStatus: "authenticated" as const,
        version: parsedVersion,
        checkedAt,
        message:
          "Cursor Agent is authenticated, but model discovery returned no recognizable model rows.",
      } satisfies ServerProviderStatus;
    }

    return {
      provider: CURSOR_PROVIDER,
      instanceId: CURSOR_PROVIDER,
      driver: CURSOR_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: "authenticated" as const,
      version: parsedVersion,
      checkedAt,
    } satisfies ServerProviderStatus;
  });

export const checkCursorProviderStatus = makeCheckCursorProviderStatus();

// ── Devin health check ───────────────────────────────────────────────

export const makeCheckDevinProviderStatus = (
  binaryPath?: string,
  readStoredCredentials: typeof readDevinStoredCredentials = readDevinStoredCredentials,
  environment?: Readonly<Record<string, string>>,
): Effect.Effect<ServerProviderStatus, never, ChildProcessSpawner.ChildProcessSpawner> =>
  Effect.gen(function* () {
    const checkedAt = new Date().toISOString();
    const executable = resolveDevinBinaryPath(binaryPath);
    const env = makeProviderProbeEnv(DEVIN_PROVIDER, environment);

    const versionProbe = yield* probeProviderCliVersion(
      runProviderCommand(executable, ["--version"], { env }),
      DEFAULT_TIMEOUT_MS,
    );

    if (versionProbe.outcome === "missing" || versionProbe.outcome === "failure") {
      const error = versionProbe.cause;
      return {
        provider: DEVIN_PROVIDER,
        instanceId: DEVIN_PROVIDER,
        driver: DEVIN_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        ...(versionProbe.outcome === "missing"
          ? { readiness: PROVIDER_NOT_INSTALLED_READINESS }
          : {}),
        message:
          versionProbe.outcome === "missing"
            ? "Devin CLI (`devin`) is not installed or not on PATH."
            : `Failed to execute Devin CLI health check: ${error instanceof Error ? error.message : String(error)}.`,
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "timeout") {
      return {
        provider: DEVIN_PROVIDER,
        instanceId: DEVIN_PROVIDER,
        driver: DEVIN_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: "Devin CLI is installed but failed to run. Timed out while running command.",
      } satisfies ServerProviderStatus;
    }

    if (versionProbe.outcome === "nonzero") {
      const versionResult = versionProbe.result;
      const detail = detailFromResult(versionResult);
      return {
        provider: DEVIN_PROVIDER,
        instanceId: DEVIN_PROVIDER,
        driver: DEVIN_PROVIDER,
        status: "error" as const,
        available: false,
        authStatus: "unknown" as const,
        checkedAt,
        message: detail
          ? `Devin CLI is installed but failed to run. ${detail}`
          : "Devin CLI is installed but failed to run.",
      } satisfies ServerProviderStatus;
    }

    const versionResult = versionProbe.result;
    const parsedVersion = parseGenericCliVersion(
      `${versionResult.stdout}\n${versionResult.stderr}`,
    );
    const storedCredentials = yield* Effect.promise(() => readStoredCredentials(env));
    const hasApiKey = hasDevinApiKeyEnv(env) || storedCredentials?.apiKey !== undefined;

    return {
      provider: DEVIN_PROVIDER,
      instanceId: DEVIN_PROVIDER,
      driver: DEVIN_PROVIDER,
      status: "ready" as const,
      available: true,
      authStatus: hasApiKey ? ("authenticated" as const) : ("unknown" as const),
      version: parsedVersion,
      checkedAt,
      ...(hasApiKey
        ? { authType: "apiKey" as const, authLabel: "Devin API Key" }
        : {
            message:
              "Devin CLI is installed. Run `devin auth login` to authenticate locally, or set WINDSURF_API_KEY before starting a session.",
          }),
    } satisfies ServerProviderStatus;
  });

export const checkDevinProviderStatus = makeCheckDevinProviderStatus();

// ── Snapshot helpers ────────────────────────────────────────────────

function comparableProviderVersionAdvisory(
  advisory: ServerProviderStatus["versionAdvisory"] | undefined,
): Omit<NonNullable<ServerProviderStatus["versionAdvisory"]>, "checkedAt"> | null {
  if (!advisory) {
    return null;
  }
  const { checkedAt: _checkedAt, ...comparableAdvisory } = advisory;
  return comparableAdvisory;
}

export function providerStatusesEqual(
  left: ReadonlyArray<ServerProviderStatus>,
  right: ReadonlyArray<ServerProviderStatus>,
): boolean {
  if (left.length !== right.length) {
    return false;
  }
  return left.every((status, index) => {
    const next = right[index];
    return (
      next !== undefined &&
      status.provider === next.provider &&
      (status.instanceId ?? null) === (next.instanceId ?? null) &&
      (status.driver ?? null) === (next.driver ?? null) &&
      (status.displayName ?? null) === (next.displayName ?? null) &&
      (status.enabled ?? null) === (next.enabled ?? null) &&
      status.status === next.status &&
      status.available === next.available &&
      status.authStatus === next.authStatus &&
      (status.authType ?? null) === (next.authType ?? null) &&
      (status.authLabel ?? null) === (next.authLabel ?? null) &&
      status.voiceTranscriptionAvailable === next.voiceTranscriptionAvailable &&
      status.supportsAutoRuntimeMode === next.supportsAutoRuntimeMode &&
      (status.autoRuntimeModeBinaryPath ?? null) === (next.autoRuntimeModeBinaryPath ?? null) &&
      (status.version ?? null) === (next.version ?? null) &&
      (status.message ?? null) === (next.message ?? null) &&
      JSON.stringify(comparableProviderVersionAdvisory(status.versionAdvisory)) ===
        JSON.stringify(comparableProviderVersionAdvisory(next.versionAdvisory)) &&
      JSON.stringify(status.updateState ?? null) === JSON.stringify(next.updateState ?? null)
    );
  });
}

function isTransientProviderCommandTimeout(status: ServerProviderStatus): boolean {
  const message = status.message ?? "";
  // Most providers use the shared detail string, but Pi's advisory probe has
  // a provider-specific explanation. Keep a slow CLI probe from replacing an
  // already usable status just because its wording differs.
  const describesTimeout =
    message.includes(PROVIDER_COMMAND_TIMEOUT_DETAIL) || /\btimed out\b/i.test(message);
  return status.status !== "ready" && status.authStatus === "unknown" && describesTimeout;
}

function wasPreviouslyUsableProviderStatus(status: ServerProviderStatus): boolean {
  return status.available && status.status === "ready";
}

export function stabilizeProviderStatusesAgainstTransientTimeouts(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  nextStatuses: ReadonlyArray<ServerProviderStatus>,
): ReadonlyArray<ServerProviderStatus> {
  if (previousStatuses.length === 0) {
    return nextStatuses;
  }

  const previousByInstance = new Map(
    previousStatuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );

  return nextStatuses.map((status) => {
    const previous = previousByInstance.get(providerStatusIdentityKey(status));
    if (
      !previous ||
      !wasPreviouslyUsableProviderStatus(previous) ||
      !isTransientProviderCommandTimeout(status)
    ) {
      return status;
    }

    // A single slow CLI probe should not make an already usable provider look broken.
    // The previous update advisory is network-backed evidence, though, so it must
    // not survive a probe that could not confirm the installed version.
    const stabilizedStatus = {
      ...previous,
      checkedAt: status.checkedAt,
      ...(status.updateState !== undefined ? { updateState: status.updateState } : {}),
    };
    return previous.versionAdvisory
      ? suppressProviderVersionAdvisory(stabilizedStatus)
      : stabilizedStatus;
  });
}

export function isProviderEnabledForSettings(
  provider: ProviderKind,
  settings: ServerSettings,
): boolean {
  // Kilo is retired and has no settings entry; it decodes to opencode on read.
  if (provider === "kilo") {
    return false;
  }
  return (
    settings.providers[provider]?.enabled !== false && settings.providers[provider] !== undefined
  );
}

export function makeDisabledProviderStatus(
  provider: ProviderKind,
  checkedAt = new Date().toISOString(),
): ServerProviderStatus {
  return {
    provider,
    instanceId: provider,
    driver: provider,
    status: "warning" as const,
    available: false,
    authStatus: "unknown" as const,
    checkedAt,
    message: DISABLED_PROVIDER_STATUS_MESSAGE,
  } satisfies ServerProviderStatus;
}

function isDisabledProviderStatusOverlay(status: ServerProviderStatus): boolean {
  return status.message === DISABLED_PROVIDER_STATUS_MESSAGE && status.available === false;
}

interface ProviderStatusProjectionInstance {
  readonly instanceId: ProviderInstanceId;
  readonly driver: ProviderKind;
  readonly displayName: string;
  readonly enabled: boolean;
  readonly isDefault?: boolean;
}

function projectStatusForProviderInstance(
  status: ServerProviderStatus,
  instance: ProviderStatusProjectionInstance,
  enabled = instance.enabled,
): ServerProviderStatus {
  const projected = {
    ...status,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled,
  } satisfies ServerProviderStatus;
  const isExactInstanceStatus =
    providerStatusInstanceKey(status) === instance.instanceId &&
    (status.driver ?? status.provider) === instance.driver;
  if (isExactInstanceStatus || instance.isDefault || status.authStatus === "unknown") {
    return projected;
  }
  const { authType, authLabel, voiceTranscriptionAvailable, ...withoutAuthMetadata } = projected;
  void authType;
  void authLabel;
  void voiceTranscriptionAvailable;
  return {
    ...withoutAuthMetadata,
    status: projected.status === "ready" ? "warning" : projected.status,
    authStatus: "unknown",
    message: projected.message ?? "Authentication has not been checked for this provider instance.",
  } satisfies ServerProviderStatus;
}

function makeUncheckedProviderInstanceStatus(
  provider: ProviderKind,
  instance: ProviderStatusProjectionInstance,
  checkedAt: string,
): ServerProviderStatus {
  return {
    provider,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled: instance.enabled,
    status: "warning",
    available: false,
    authStatus: "unknown",
    checkedAt,
    message: "Provider instance has not been checked yet.",
  } satisfies ServerProviderStatus;
}

function makeUnsupportedProviderInstanceStatus(
  instance: UnsupportedProviderInstance,
  checkedAt: string,
): ServerProviderStatus {
  const unavailableReason = `Provider driver '${instance.driver}' is not supported by this Moss build.`;
  return {
    provider: instance.driver,
    instanceId: instance.instanceId,
    driver: instance.driver,
    displayName: instance.displayName,
    enabled: false,
    status: "error",
    available: false,
    availability: "unavailable",
    unavailableReason,
    authStatus: "unknown",
    checkedAt,
    message: unavailableReason,
  } satisfies ServerProviderStatus;
}

function mergeProviderStatusUpdates(
  previousStatuses: ReadonlyArray<ServerProviderStatus>,
  updatedStatuses: ReadonlyArray<ServerProviderStatus>,
): ProviderStatuses {
  const statusByInstance = new Map(
    previousStatuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );
  for (const status of updatedStatuses) {
    const instanceId = providerStatusInstanceKey(status);
    for (const [key, previous] of statusByInstance) {
      if (
        providerStatusInstanceKey(previous) === instanceId &&
        providerStatusIdentityKey(previous) !== providerStatusIdentityKey(status)
      ) {
        statusByInstance.delete(key);
      }
    }
    statusByInstance.set(providerStatusIdentityKey(status), status);
  }
  return orderProviderStatuses([...statusByInstance.values()]);
}

// Keeps local CLI version/status visible while removing network-backed update metadata.
function makeSuppressedProviderVersionAdvisory(
  status: ServerProviderStatus,
  currentVersion?: string | null,
): NonNullable<ServerProviderStatus["versionAdvisory"]> {
  return {
    status: "unknown",
    currentVersion: currentVersion ?? status.version ?? null,
    latestVersion: null,
    updateCommand: null,
    canUpdate: false,
    checkedAt: status.checkedAt,
    message: null,
  };
}

function suppressProviderVersionAdvisory(status: ServerProviderStatus): ServerProviderStatus {
  return {
    ...status,
    versionAdvisory: makeSuppressedProviderVersionAdvisory(status),
  };
}

// Disabled providers are a settings overlay, not a probe result. Keep the raw
// cached/probed status intact so re-enabling a provider can reuse it immediately.
export function projectProviderStatusesForSettings(
  statuses: ReadonlyArray<ServerProviderStatus>,
  settings: ServerSettings,
  checkedAt = new Date().toISOString(),
): ProviderStatuses {
  const statusByInstance = new Map(
    statuses.map((status) => [providerStatusIdentityKey(status), status] as const),
  );
  const legacyStatusByProvider = new Map(
    statuses
      .filter((status) => status.instanceId === undefined)
      .map((status) => [status.driver ?? status.provider, status] as const),
  );
  const instancesByProvider = new Map<ProviderKind, ReturnType<typeof deriveProviderInstances>>();
  for (const instance of deriveProviderInstances(settings)) {
    const entries = instancesByProvider.get(instance.driver) ?? [];
    instancesByProvider.set(instance.driver, [...entries, instance]);
  }
  const projected: ServerProviderStatus[] = [];

  for (const provider of PROVIDERS) {
    const providerInstances = instancesByProvider.get(provider) ?? [];
    const instances: ReadonlyArray<ResolvedProviderInstance> =
      providerInstances.length > 0
        ? providerInstances
        : [
            {
              instanceId: provider,
              driver: provider,
              displayName: provider,
              enabled: true,
              isDefault: true,
              config: {},
              environment: {},
              raw: { driver: provider },
            },
          ];
    const defaultStatus =
      statusByInstance.get(providerTargetIdentityKey({ provider, instanceId: provider })) ??
      legacyStatusByProvider.get(provider);

    if (instances.every((instance) => !instance.enabled)) {
      const disabledStatus = makeDisabledProviderStatus(
        provider,
        defaultStatus?.checkedAt ?? checkedAt,
      );
      const disabledStatusWithAdvisory = {
        ...disabledStatus,
        ...(defaultStatus?.version ? { version: defaultStatus.version } : {}),
        versionAdvisory: makeSuppressedProviderVersionAdvisory(
          disabledStatus,
          defaultStatus?.version,
        ),
        ...(defaultStatus?.updateState ? { updateState: defaultStatus.updateState } : {}),
      } satisfies ServerProviderStatus;
      for (const instance of instances) {
        projected.push(
          projectStatusForProviderInstance(disabledStatusWithAdvisory, instance, false),
        );
      }
      continue;
    }

    for (const instance of instances) {
      const exactStatus = statusByInstance.get(
        providerTargetIdentityKey({
          provider: instance.driver,
          instanceId: instance.instanceId,
        }),
      );
      const status = exactStatus ?? (instance.isDefault ? defaultStatus : undefined);
      if (!instance.enabled) {
        const disabledStatus = makeDisabledProviderStatus(
          provider,
          status?.checkedAt ?? defaultStatus?.checkedAt ?? checkedAt,
        );
        const updateState = status?.updateState ?? defaultStatus?.updateState;
        const disabledStatusWithAdvisory = {
          ...disabledStatus,
          ...((status?.version ?? defaultStatus?.version)
            ? { version: status?.version ?? defaultStatus?.version }
            : {}),
          versionAdvisory: makeSuppressedProviderVersionAdvisory(
            disabledStatus,
            status?.version ?? defaultStatus?.version,
          ),
          ...(updateState ? { updateState } : {}),
        } satisfies ServerProviderStatus;
        projected.push(
          projectStatusForProviderInstance(disabledStatusWithAdvisory, instance, false),
        );
        continue;
      }
      if (status && !isDisabledProviderStatusOverlay(status)) {
        const visibleStatus = settings.enableProviderUpdateChecks
          ? status
          : suppressProviderVersionAdvisory(status);
        projected.push(projectStatusForProviderInstance(visibleStatus, instance));
        continue;
      }
      if (!instance.isDefault || instances.length > 1) {
        projected.push(
          makeUncheckedProviderInstanceStatus(
            provider,
            instance,
            defaultStatus?.checkedAt ?? checkedAt,
          ),
        );
      }
    }
  }

  for (const instance of deriveUnsupportedProviderInstances(settings)) {
    projected.push(makeUnsupportedProviderInstanceStatus(instance, checkedAt));
  }

  const managedInstanceIds = new Set<string>();
  for (const providerInstances of instancesByProvider.values()) {
    for (const instance of providerInstances) {
      if (instance.config.managed === true) managedInstanceIds.add(instance.instanceId);
    }
  }
  return orderProviderStatuses(
    projected.map((status) =>
      withProviderReadiness(status, {
        managed: managedInstanceIds.has(providerStatusInstanceKey(status)),
      }),
    ),
  );
}

// ── Layer ───────────────────────────────────────────────────────────

export function makeProviderHealthLive(options?: {
  readonly providerUpdateTimeoutMs?: number;
  /**
   * Keep the server PATH holding the usual agent install folders: recheck them before each
   * provider check and ask npm once for its configured global folder. Only the server's own
   * instance does this; it changes `process.env.PATH`.
   */
  readonly maintainAgentCliPath?: boolean;
}) {
  const providerUpdateTimeoutMs = options?.providerUpdateTimeoutMs ?? PROVIDER_UPDATE_TIMEOUT_MS;
  return Layer.effect(
    ProviderHealth,
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
      const serverConfig = yield* ServerConfig;
      const serverSettings = yield* ServerSettingsService;
      const selectCodexState = yield* makeCodexStateBindingSelection({
        stateDir: serverConfig.stateDir,
        runtimeHomePath: serverConfig.baseDir,
        readSettings: () => Effect.runSync(serverSettings.getSettings),
      });
      const selectClaudeState = yield* makeClaudeStateBindingSelection({
        stateDir: serverConfig.stateDir,
        readSettings: () => Effect.runSync(serverSettings.getSettings),
      });
      const changesPubSub = yield* Effect.acquireRelease(
        PubSub.unbounded<ReadonlyArray<ServerProviderStatus>>(),
        PubSub.shutdown,
      );
      const refreshScope = yield* Scope.make("sequential");
      yield* Effect.addFinalizer(() => Scope.close(refreshScope, Exit.void));

      // Provider health is part of the server layer graph, which is acquired
      // before Server.start can run. Initialize settings here so waiting for
      // readiness below cannot deadlock layer acquisition. The start effect is
      // idempotent, so the server lifecycle can still call it explicitly.
      yield* serverSettings.start;

      const cachePathForProviderTarget = (input: {
        readonly provider: ServerProviderStatus["provider"];
        readonly instanceId?: ProviderInstanceId | undefined;
      }) =>
        resolveProviderStatusCachePath({
          stateDir: serverConfig.stateDir,
          provider: input.provider,
          ...(input.instanceId && input.instanceId !== input.provider
            ? { instanceId: input.instanceId }
            : {}),
        });

      const initialSettings = yield* serverSettings.ready.pipe(
        Effect.flatMap(() => serverSettings.getSettings),
      );
      const initialInstances = deriveProviderInstances(initialSettings);
      const cachedStatuses: ProviderStatuses = yield* Effect.forEach(
        initialInstances,
        (instance) =>
          readProviderStatusCache(
            cachePathForProviderTarget({
              provider: instance.driver,
              instanceId: instance.instanceId,
            }),
            {
              provider: instance.driver,
              instanceId: instance.instanceId,
            },
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem)),
        { concurrency: "unbounded" },
      ).pipe(
        Effect.map((statuses) =>
          orderProviderStatuses(
            statuses.filter(
              (status): status is ServerProviderStatus =>
                status !== undefined && !isDisabledProviderStatusOverlay(status),
            ),
          ),
        ),
      );

      const statusesRef = yield* Ref.make<ProviderStatuses>(cachedStatuses);
      const updateStatesRef = yield* Ref.make<ReadonlyMap<string, ServerProviderUpdateState>>(
        new Map(),
      );
      const loginStatesRef = yield* Ref.make<ReadonlyMap<string, ServerProviderLoginState>>(
        new Map(),
      );
      const installStatesRef = yield* Ref.make<ReadonlyMap<string, ServerProviderInstallState>>(
        new Map(),
      );
      const refreshFiberRef = yield* Ref.make<Fiber.Fiber<ProviderStatuses, never> | null>(null);
      const loginManager = makeProviderLoginManager({
        runtimePrograms: (provider) => agentProgramsForServer(serverConfig, provider),
      });
      yield* Effect.addFinalizer(() => Effect.sync(() => loginManager.cancelAll()));
      const refreshNeedsFollowUpRef = yield* Ref.make(false);
      const commandCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: (provider) =>
          new ServerProviderUpdateError({
            provider: provider as ProviderKind,
            reason: "An update is already running for this provider.",
          }),
      });
      // Install target keys are `install:<driver>:<instance>`.
      const installCoordinator = yield* makeProviderMaintenanceCommandCoordinator({
        makeAlreadyRunningError: (targetKey) =>
          new ServerProviderInstallError({
            provider: targetKey.split(":")[1] as ProviderKind,
            reason: "already-running",
          }),
      });

      const claudeSubscriptionCacheRef = yield* Ref.make(
        new Map<string, { readonly expiresAt: number; readonly subscriptionType?: string }>(),
      );
      const resolveClaudeSubscription = (input: ClaudeSubscriptionProbeInput) =>
        Effect.gen(function* () {
          const key = claudeSubscriptionProbeKey(input);
          const now = Date.now();
          const cached = (yield* Ref.get(claudeSubscriptionCacheRef)).get(key);
          if (cached && cached.expiresAt > now) {
            return cached.subscriptionType;
          }
          const probe = yield* probeClaudeSubscription(
            input,
            agentProgramsForServer(serverConfig, "claudeAgent"),
          );
          const subscriptionType = probe?.subscriptionType;
          yield* Ref.update(claudeSubscriptionCacheRef, (cache) => {
            const next = new Map(cache);
            next.set(key, {
              expiresAt: now + CLAUDE_SUBSCRIPTION_CACHE_TTL_MS,
              ...(subscriptionType !== undefined ? { subscriptionType } : {}),
            });
            return next;
          });
          return subscriptionType;
        });

      const readInstanceConfigString = (
        instance: ResolvedProviderInstance,
        key: string,
      ): string | undefined => {
        const value = instance.config[key];
        return typeof value === "string" ? nonEmptyTrimmed(value) : undefined;
      };
      const readInstanceConfigBoolean = (
        instance: ResolvedProviderInstance,
        key: string,
      ): boolean | undefined => {
        const value = instance.config[key];
        return typeof value === "boolean" ? value : undefined;
      };

      const resolveProviderInstanceTarget = (
        settings: ServerSettings,
        target: {
          readonly provider: ProviderKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
      ): ResolvedProviderInstance | null => {
        const instances = deriveProviderInstances(settings).filter(
          (instance) => instance.driver === target.provider,
        );
        if (target.instanceId !== undefined) {
          return instances.find((instance) => instance.instanceId === target.instanceId) ?? null;
        }
        return (
          instances.find((instance) => instance.instanceId === target.provider) ??
          instances.find((instance) => instance.isDefault) ??
          null
        );
      };

      const stampProviderStatusForInstance = (
        status: ServerProviderStatus,
        instance: ResolvedProviderInstance,
      ): ServerProviderStatus =>
        ({
          ...status,
          instanceId: instance.instanceId,
          driver: instance.driver,
          displayName: instance.displayName,
          enabled: instance.enabled,
        }) satisfies ServerProviderStatus;

      const makeManualProviderMaintenanceCapabilities = (provider: ProviderKind) =>
        makeProviderMaintenanceCapabilities({
          provider,
          packageName: null,
          latestVersionSource: null,
          updateExecutable: null,
          updateArgs: [],
          updateLockKey: null,
        });

      const getProviderMaintenanceCapabilities = Effect.fn("getProviderMaintenanceCapabilities")(
        function* (target: {
          readonly provider: ProviderKind;
          readonly instanceId?: ProviderInstanceId | undefined;
          readonly installedVersion?: string | null | undefined;
        }) {
          const settings = yield* serverSettings.getSettings;
          const instance = resolveProviderInstanceTarget(settings, target);
          if (!instance || !instance.enabled) {
            return makeManualProviderMaintenanceCapabilities(target.provider);
          }
          if (target.provider === "opencode" && readInstanceConfigString(instance, "serverUrl")) {
            return makeManualProviderMaintenanceCapabilities(target.provider);
          }
          const configuredBinaryPath =
            target.provider === "codex" || target.provider === "claudeAgent"
              ? providerRuntimeBinaryPath(instance)
              : readInstanceConfigString(instance, "binaryPath");
          const binaryPath =
            target.provider === "codex"
              ? resolveCodexExecutable({ configuredBinaryPath, env: process.env }).binaryPath
              : target.provider === "claudeAgent"
                ? resolveClaudeCodeRuntime({ binaryPath: configuredBinaryPath, env: process.env })
                    .binaryPath
                : target.provider === "opencode" && configuredBinaryPath
                  ? expandHomePath(configuredBinaryPath)
                  : configuredBinaryPath;
          if (target.provider === "cursor") {
            const command = buildCursorAgentCommand(binaryPath, ["update"]);
            return makeProviderMaintenanceCapabilities({
              provider: target.provider,
              packageName: null,
              updateExecutable: command.command,
              updateArgs: command.args,
              updateLockKey: "cursor-agent",
            });
          }
          // The Codex and Claude Code that ship inside Moss update with Moss, never through npm.
          if (
            runsMossBundledAgentRuntime(
              target.provider,
              binaryPath,
              instance.instanceId,
              providerStartOptionsFromInstance(instance)?.codex?.accountId,
            )
          ) {
            return makeManualProviderMaintenanceCapabilities(target.provider);
          }
          const definition = PACKAGE_MANAGED_PROVIDER_UPDATES[target.provider];
          if (!definition) {
            return makeManualProviderMaintenanceCapabilities(target.provider);
          }
          const updateEnv = yield* Effect.try({
            try: () =>
              makeProviderUpdateEnv(instance, {
                homeDir: serverConfig.homeDir,
                isolationRootDir: serverConfig.stateDir,
              }),
            catch: (cause) =>
              new Error(
                `Failed to prepare the private provider account home. ${cause instanceof Error ? cause.message : String(cause)}`,
                { cause },
              ),
          });
          let installedVersion = target.installedVersion;
          if (target.provider === "opencode" && installedVersion === undefined) {
            const openCodeBinary = yield* Effect.promise(() =>
              resolveOpenCodeBinaryPath(binaryPath),
            );
            const probe = yield* probeProviderCliVersion(
              runOpenCodeCommand(["--version"], openCodeBinary, updateEnv),
              OPENCODE_HEALTH_TIMEOUT_MS,
            ).pipe(Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner));
            if (probe.outcome !== "success")
              return makeManualProviderMaintenanceCapabilities(target.provider);
            installedVersion = parseGenericCliVersion(
              `${probe.result.stdout}\n${probe.result.stderr}`,
            );
          }
          return yield* resolveProviderMaintenanceCapabilitiesEffect(
            withOpenCodeMaintenanceVersion(definition, installedVersion),
            {
              binaryPath: binaryPath ?? null,
              env: updateEnv,
              platform: process.platform,
              packageChannel: resolveProviderPackageChannel({
                providerInstances: settings.providerInstances,
              }),
            },
          ).pipe(Effect.provideService(FileSystem.FileSystem, fileSystem));
        },
      );

      const applyVolatileProviderState = Effect.fn("applyVolatileProviderState")(function* (
        status: ServerProviderStatus,
      ) {
        const updateStates = yield* Ref.get(updateStatesRef);
        const loginStates = yield* Ref.get(loginStatesRef);
        const installStates = yield* Ref.get(installStatesRef);
        const updateState = updateStates.get(providerStatusIdentityKey(status));
        const loginState = loginStates.get(providerStatusIdentityKey(status));
        const installState = installStates.get(providerStatusIdentityKey(status));
        const {
          updateState: _updateState,
          loginState: _loginState,
          installState: _installState,
          ...statusWithoutVolatileState
        } = status;
        return {
          ...statusWithoutVolatileState,
          ...(updateState ? { updateState } : {}),
          ...(loginState ? { loginState } : {}),
          ...(installState ? { installState } : {}),
        };
      });

      const applyVolatileProviderStates = (
        statuses: ReadonlyArray<ServerProviderStatus>,
      ): Effect.Effect<ProviderStatuses> =>
        Effect.forEach(statuses, applyVolatileProviderState, {
          concurrency: "unbounded",
        });

      const projectStatusesForCurrentSettings = Effect.fn(
        "projectProviderStatusesForCurrentSettings",
      )(function* (statuses: ReadonlyArray<ServerProviderStatus>) {
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.catch(() => Effect.succeed(null)),
        );
        return yield* applyVolatileProviderStates(
          settings ? projectProviderStatusesForSettings(statuses, settings) : statuses,
        );
      });

      const publishProjectedStatuses = Effect.fn("publishProjectedProviderStatuses")(function* () {
        const rawStatuses = yield* Ref.get(statusesRef);
        const projectedStatuses = yield* projectStatusesForCurrentSettings(rawStatuses);
        yield* PubSub.publish(changesPubSub, projectedStatuses);
        return projectedStatuses;
      });

      const publishProjectedStatusesForSettings = Effect.fn(
        "publishProjectedProviderStatusesForSettings",
      )(function* (settings: ServerSettings) {
        const rawStatuses = yield* Ref.get(statusesRef);
        const projectedStatuses = yield* applyVolatileProviderStates(
          projectProviderStatusesForSettings(rawStatuses, settings),
        );
        yield* PubSub.publish(changesPubSub, projectedStatuses);
        return projectedStatuses;
      });

      const setProviderUpdateState = Effect.fn("setProviderUpdateState")(function* (
        target: {
          readonly provider: ProviderKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
        state: ServerProviderUpdateState | null,
      ) {
        const key = providerTargetIdentityKey(target);
        yield* Ref.update(updateStatesRef, (previous) => {
          const next = new Map(previous);
          if (!state || state.status === "idle") {
            next.delete(key);
          } else {
            next.set(key, state);
          }
          return next;
        });
        return yield* publishProjectedStatuses();
      });

      const setProviderLoginState = Effect.fn("setProviderLoginState")(function* (
        target: {
          readonly provider: ProviderKind;
          readonly instanceId: ProviderInstanceId;
        },
        state: ServerProviderLoginState | null,
      ) {
        const key = providerTargetIdentityKey(target);
        yield* Ref.update(loginStatesRef, (previous) => {
          const next = new Map(previous);
          if (state) {
            next.set(key, state);
          } else {
            next.delete(key);
          }
          return next;
        });
        return yield* publishProjectedStatuses();
      });

      const setProviderInstallState = Effect.fn("setProviderInstallState")(function* (
        target: {
          readonly provider: ProviderKind;
          readonly instanceId?: ProviderInstanceId | undefined;
        },
        state: ServerProviderInstallState,
      ) {
        const key = providerTargetIdentityKey(target);
        yield* Ref.update(installStatesRef, (previous) => new Map(previous).set(key, state));
        return yield* publishProjectedStatuses();
      });

      const enrichStatuses = Effect.fn("enrichProviderStatuses")(function* (
        statuses: ReadonlyArray<ServerProviderStatus>,
      ) {
        const settings = yield* serverSettings.ready.pipe(
          Effect.flatMap(() => serverSettings.getSettings),
          Effect.catch(() => Effect.succeed(null)),
        );
        if (settings?.enableProviderUpdateChecks === false) {
          return yield* Effect.forEach(
            statuses.map(suppressProviderVersionAdvisory),
            applyVolatileProviderState,
            { concurrency: "unbounded" },
          );
        }

        const enriched = yield* Effect.forEach(
          statuses,
          (status) => {
            const provider = status.driver ?? status.provider;
            if (!Schema.is(ProviderKind)(provider)) {
              return Effect.succeed(status);
            }
            return getProviderMaintenanceCapabilities({
              provider,
              instanceId: providerStatusInstanceKey(status),
              installedVersion: status.version ?? null,
            }).pipe(
              Effect.flatMap((capabilities) =>
                enrichProviderStatusWithVersionAdvisory(status, capabilities),
              ),
              Effect.catch(() =>
                Effect.succeed({
                  ...status,
                  versionAdvisory: {
                    status: "unknown" as const,
                    currentVersion: status.version ?? null,
                    latestVersion: null,
                    updateCommand: null,
                    canUpdate: false,
                    checkedAt: status.checkedAt,
                    message: null,
                  },
                }),
              ),
            );
          },
          { concurrency: "unbounded" },
        );
        return yield* Effect.forEach(enriched, applyVolatileProviderState, {
          concurrency: "unbounded",
        });
      });

      // These checks are shared with the user's own login, so their ready text is about signing
      // in to the CLI. A managed instance already carries its gateway credential; Hermes and the
      // ACP agents verify that themselves and say so.
      const withManagedReadyCopy = (
        status: ServerProviderStatus,
        instance: ResolvedProviderInstance,
      ): ServerProviderStatus =>
        instance.config.managed === true &&
        status.status === "ready" &&
        (instance.driver === "codex" ||
          instance.driver === "grok" ||
          instance.driver === "opencode" ||
          instance.driver === "pi")
          ? {
              ...status,
              authStatus: "authenticated",
              message: "Using the Moss managed gateway.",
            }
          : status;

      const checkProviderInstanceWhenEnabled = <R>(
        instance: ResolvedProviderInstance,
        check: Effect.Effect<ServerProviderStatus, never, R>,
      ): Effect.Effect<Option.Option<ServerProviderStatus>, never, R> =>
        instance.enabled
          ? check.pipe(
              Effect.provideService(ServerConfig, serverConfig),
              Effect.map((status) =>
                Option.some(
                  stampProviderStatusForInstance(withManagedReadyCopy(status, instance), instance),
                ),
              ),
            )
          : Effect.succeed(Option.none());

      const checkProviderInstanceStatus = (
        instance: ResolvedProviderInstance,
      ): Effect.Effect<
        Option.Option<ServerProviderStatus>,
        never,
        ChildProcessSpawner.ChildProcessSpawner | FileSystem.FileSystem | Path.Path
      > => {
        const runtimeIssue = providerRuntimeConfigurationIssue(instance);
        if (runtimeIssue) {
          return Effect.succeed(
            instance.enabled
              ? Option.some(
                  stampProviderStatusForInstance(
                    {
                      provider: instance.driver,
                      driver: instance.driver,
                      instanceId: instance.instanceId,
                      status: "error",
                      available: false,
                      authStatus: "unknown",
                      checkedAt: new Date().toISOString(),
                      message: runtimeIssue,
                    },
                    instance,
                  ),
                )
              : Option.none(),
          );
        }
        const binaryPath = readInstanceConfigString(instance, "binaryPath");
        switch (instance.driver) {
          case "codex": {
            // Launches derive their Codex homes and seeded account discriminator
            // from these start options, so probe the same isolated account.
            return checkProviderInstanceWhenEnabled(
              instance,
              Effect.tryPromise({
                try: () =>
                  selectCodexState(instance.instanceId, providerStartOptionsFromInstance(instance)),
                catch: (cause) => cause,
              }).pipe(
                Effect.flatMap((selected) => {
                  const codexOptions = selected?.codex;
                  return makeCheckCodexProviderStatus(
                    codexOptions?.binaryPath,
                    codexOptions?.homePath,
                    codexOptions?.shadowHomePath,
                    codexOptions?.accountId,
                    codexOptions?.environment,
                    () =>
                      readManagedCodexHomeAuthority({
                        stateDir: serverConfig.stateDir,
                        readSettings: () => Effect.runPromise(serverSettings.getSettings),
                        readSettingsSync: () => Effect.runSync(serverSettings.getSettings),
                        input: {
                          ...codexOptions,
                          env: { ...process.env, ...codexOptions?.environment },
                        },
                      }),
                    codexOptions,
                  );
                }),
                Effect.catch((cause) =>
                  Effect.succeed<ServerProviderStatus>({
                    provider: CODEX_PROVIDER,
                    driver: instance.driver,
                    instanceId: instance.instanceId,
                    status: "error",
                    available: false,
                    authStatus: "unknown",
                    checkedAt: new Date().toISOString(),
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Codex 历史与账户目录无法验证，请检查设置。",
                  }),
                ),
              ),
            );
          }
          case "claudeAgent": {
            return checkProviderInstanceWhenEnabled(
              instance,
              Effect.tryPromise({
                try: () =>
                  selectClaudeState(
                    instance.instanceId,
                    providerStartOptionsFromInstance(instance),
                  ),
                catch: (cause) => cause,
              }).pipe(
                Effect.flatMap((selected) => {
                  const claudeOptions = selected?.claudeAgent;
                  const homePath = claudeOptions?.homePath;
                  const claudeEnvironment = claudeOptions?.environment;
                  const assertStateBindingCurrent = () => {
                    readClaudeStateBinding(claudeOptions);
                  };
                  return makeCheckClaudeProviderStatus(
                    resolveClaudeSubscription({
                      instanceId: instance.instanceId,
                      binaryPath: claudeOptions?.binaryPath,
                      homePath,
                      environment: claudeEnvironment,
                      homeDir: serverConfig.homeDir,
                      isolationRootDir: serverConfig.stateDir,
                      assertStateBindingCurrent,
                    }),
                    claudeOptions?.binaryPath,
                    homePath,
                    {
                      providerInstanceId: instance.instanceId,
                      isolationRootDir: serverConfig.stateDir,
                      fallbackHomeDir: serverConfig.homeDir,
                      assertStateBindingCurrent,
                    },
                    claudeEnvironment,
                  );
                }),
                Effect.catch((cause) =>
                  Effect.succeed<ServerProviderStatus>({
                    provider: CLAUDE_AGENT_PROVIDER,
                    driver: instance.driver,
                    instanceId: instance.instanceId,
                    status: "error",
                    available: false,
                    authStatus: "unknown",
                    checkedAt: new Date().toISOString(),
                    message:
                      cause instanceof Error
                        ? cause.message
                        : "Claude 历史与账户目录无法验证，请检查设置。",
                  }),
                ),
              ),
            );
          }
          case "gemini":
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckGeminiProviderStatus(binaryPath, instance.environment),
            );
          case "hermes":
            return checkProviderInstanceWhenEnabled(
              instance,
              checkHermesProviderStatus(binaryPath, instance.environment, instance.instanceId),
            );
          case "kimi":
            return checkProviderInstanceWhenEnabled(
              instance,
              checkAcpAgentProviderStatus(
                KIMI_ACP_AGENT_SPEC,
                binaryPath,
                instance.environment,
                instance.instanceId,
              ),
            );
          case "minimax":
            return checkProviderInstanceWhenEnabled(
              instance,
              checkAcpAgentProviderStatus(
                MINIMAX_ACP_AGENT_SPEC,
                binaryPath,
                instance.environment,
                instance.instanceId,
              ),
            );
          case "zcode":
            return checkProviderInstanceWhenEnabled(
              instance,
              checkAcpAgentProviderStatus(
                ZCODE_ACP_AGENT_SPEC,
                binaryPath,
                instance.environment,
                instance.instanceId,
              ),
            );
          case "kilo":
            // Kilo is retired; legacy instances migrate to opencode at decode time.
            return Effect.succeed(Option.none());
          case "cursor": {
            const cursorOptions = providerStartOptionsFromInstance(instance)?.cursor;
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckCursorProviderStatus(
                binaryPath,
                cursorOptions?.environment,
                instance.instanceId,
                { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
              ),
            );
          }
          case "devin":
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckDevinProviderStatus(
                binaryPath,
                readDevinStoredCredentials,
                instance.environment,
              ),
            );
          case "antigravity":
            return checkProviderInstanceWhenEnabled(
              instance,
              checkAntigravityProviderStatus(binaryPath, instance.environment),
            );
          case "grok": {
            const grokOptions = providerStartOptionsFromInstance(instance)?.grok;
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckGrokProviderStatus(
                binaryPath,
                grokOptions?.environment,
                instance.instanceId,
                { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
              ),
            );
          }
          case "droid":
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckDroidProviderStatus(binaryPath, instance.environment),
            );
          case "opencode": {
            const openCodeOptions = providerStartOptionsFromInstance(instance)?.opencode;
            return checkProviderInstanceWhenEnabled(
              instance,
              makeCheckOpenCodeProviderStatus(
                binaryPath,
                openCodeOptions?.environment,
                {
                  serverUrl: readInstanceConfigString(instance, "serverUrl"),
                  serverPassword: readInstanceConfigString(instance, "serverPassword"),
                  experimentalWebSockets: readInstanceConfigBoolean(
                    instance,
                    "experimentalWebSockets",
                  ),
                },
                instance.instanceId,
                { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
              ),
            );
          }
          case "pi": {
            const piOptions = providerStartOptionsFromInstance(instance)?.pi;
            return checkProviderInstanceWhenEnabled(
              instance,
              checkPiProviderStatus(
                readInstanceConfigString(instance, "agentDir"),
                binaryPath,
                piOptions?.environment,
                instance.instanceId,
                { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
              ),
            );
          }
          case "omp": {
            const ompOptions = providerStartOptionsFromInstance(instance)?.omp;
            return checkProviderInstanceWhenEnabled(
              instance,
              checkOmpProviderStatus(
                readInstanceConfigString(instance, "agentDir"),
                binaryPath,
                ompOptions?.environment,
                instance.instanceId,
                { homeDir: serverConfig.homeDir, isolationRootDir: serverConfig.stateDir },
              ),
            );
          }
        }
      };

      const loadProviderStatuses = serverSettings.ready
        .pipe(
          // An agent installed in one of the usual folders since the last check joins PATH.
          Effect.tap(() =>
            options?.maintainAgentCliPath === true
              ? Effect.promise(() => ensureAgentCliPath(serverConfig.baseDir))
              : Effect.void,
          ),
          Effect.flatMap(() => serverSettings.getSettings),
          Effect.flatMap((settings) =>
            runProviderHealthProbes(
              deriveProviderInstances(settings).map((instance) =>
                checkProviderInstanceStatus(instance),
              ),
            ),
          ),
        )
        .pipe(
          Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
          Effect.provideService(FileSystem.FileSystem, fileSystem),
          Effect.provideService(Path.Path, path),
          Effect.map((statuses) =>
            orderProviderStatuses(
              statuses.flatMap((status) => (Option.isSome(status) ? [status.value] : [])),
            ),
          ),
          Effect.flatMap(enrichStatuses),
        );

      const persistStatuses = (statuses: ProviderStatuses) =>
        Effect.forEach(
          statuses,
          (status) => {
            const { updateState: _updateState, ...statusToPersist } = status;
            return writeProviderStatusCache({
              filePath: cachePathForProviderTarget({
                provider: status.provider,
                instanceId: providerStatusInstanceKey(status),
              }),
              provider: statusToPersist,
            }).pipe(
              Effect.provideService(FileSystem.FileSystem, fileSystem),
              Effect.provideService(Path.Path, path),
              Effect.tapError(Effect.logError),
              Effect.ignore,
            );
          },
          { concurrency: "unbounded", discard: true },
        );

      const refreshNow = Effect.gen(function* () {
        const hasStartingLogin = [...(yield* Ref.get(loginStatesRef)).values()].some(
          (state) => state.status === "starting",
        );
        if (hasStartingLogin || loginManager.hasRunning()) {
          const rawStatuses = yield* Ref.get(statusesRef);
          return yield* projectStatusesForCurrentSettings(rawStatuses);
        }
        let revisionRetries = 0;
        while (true) {
          const refreshRevision = (yield* serverSettings.getSnapshot).revision;
          // Drop the cached Claude subscription probe so switching accounts (login
          // / logout / add account outside the app) is reflected on the next
          // refresh instead of being pinned to the old account for up to 5 minutes.
          yield* Ref.set(claudeSubscriptionCacheRef, new Map());
          const loadedStatuses = yield* loadProviderStatuses;
          if ((yield* serverSettings.getSnapshot).revision !== refreshRevision) {
            // A caller that joined this refresh expects the settings mutation it
            // just made to be reflected. Retry in the same shared fiber so an
            // enable cannot resolve with the stale pre-mutation probe.
            if (revisionRetries < MAX_REFRESH_REVISION_RETRIES) {
              revisionRetries += 1;
              continue;
            }
            // Keep the joined refresh bounded, but queue one final cycle so a
            // second settings mutation cannot leave the newest provider state
            // waiting for an unrelated future refresh.
            yield* Ref.set(refreshNeedsFollowUpRef, true);
            const currentStatuses = yield* Ref.get(statusesRef);
            return yield* projectStatusesForCurrentSettings(currentStatuses);
          }
          const previousRawStatuses = yield* Ref.get(statusesRef);
          const previousStatuses = yield* projectStatusesForCurrentSettings(previousRawStatuses);
          const stabilizedLoadedStatuses = stabilizeProviderStatusesAgainstTransientTimeouts(
            previousRawStatuses,
            loadedStatuses,
          );
          const nextRawStatuses = mergeProviderStatusUpdates(
            previousRawStatuses,
            stabilizedLoadedStatuses,
          );
          const nextStatuses = yield* projectStatusesForCurrentSettings(nextRawStatuses);
          yield* Ref.set(statusesRef, nextRawStatuses);
          if (providerStatusesEqual(previousStatuses, nextStatuses)) {
            return nextStatuses;
          }
          yield* persistStatuses(nextRawStatuses);
          yield* PubSub.publish(changesPubSub, nextStatuses);
          return nextStatuses;
        }
      });

      // Keep a single refresh in flight so repeated config reads do not spawn
      // overlapping CLI probes while the cache already gives us a usable answer.
      function ensureRefreshFiber(): Effect.Effect<Fiber.Fiber<ProviderStatuses, never>> {
        return Effect.gen(function* () {
          const inFlight = yield* Ref.get(refreshFiberRef);
          if (inFlight) {
            return inFlight;
          }
          const refreshFiber = yield* Effect.gen(function* () {
            const refreshExit = yield* Effect.exit(
              Effect.gen(function* () {
                const statuses = yield* refreshNow;
                if (!(yield* Ref.getAndSet(refreshNeedsFollowUpRef, false))) {
                  return statuses;
                }
                return yield* refreshNow;
              }),
            );
            if (Exit.isSuccess(refreshExit)) {
              return refreshExit.value;
            }
            // Keep the current in-memory snapshot as the source of truth if a
            // foreground refresh fails after startup.
            const rawStatuses = yield* Ref.get(statusesRef);
            return yield* projectStatusesForCurrentSettings(rawStatuses);
          }).pipe(
            Effect.ensuring(
              Effect.gen(function* () {
                yield* Ref.set(refreshFiberRef, null);
                if (!(yield* Ref.getAndSet(refreshNeedsFollowUpRef, false))) {
                  return;
                }
                // The bounded follow-up was dirtied too. Debounce one more
                // shared refresh so a sustained settings burst cannot keep the
                // current callers stuck or spin CLI probes without a pause.
                yield* Effect.sleep(Duration.millis(REFRESH_REVISION_RESCHEDULE_DELAY_MS)).pipe(
                  Effect.andThen(ensureRefreshFiber().pipe(Effect.asVoid)),
                  Effect.forkIn(refreshScope),
                  Effect.asVoid,
                );
              }),
            ),
            Effect.forkIn(refreshScope),
          );
          yield* Ref.set(refreshFiberRef, refreshFiber);
          return refreshFiber;
        });
      }

      yield* serverSettings.streamChanges.pipe(
        Stream.runForEach((settings) =>
          Effect.gen(function* () {
            // Publish settings-only projection changes immediately from the
            // cached raw probes; a CLI refresh can finish in the background.
            yield* publishProjectedStatusesForSettings(settings).pipe(Effect.asVoid);
            // If this settings change lands during a CLI probe, make the shared
            // refresh fiber run (or schedule) one more pass after the current
            // snapshot so the change cannot be hidden by the in-flight result.
            if (yield* Ref.get(refreshFiberRef)) {
              yield* Ref.set(refreshNeedsFollowUpRef, true);
            }
            yield* ensureRefreshFiber().pipe(
              Effect.flatMap(Fiber.join),
              Effect.forkIn(refreshScope),
              Effect.asVoid,
            );
          }),
        ),
        Effect.forkIn(refreshScope),
      );

      const refresh: Effect.Effect<ProviderStatuses> = Effect.gen(function* () {
        if (options?.maintainAgentCliPath === true) {
          // A person's Re-detect must see a CLI installed moments ago, including
          // one placed in a directory already on PATH with a cached lookup miss.
          yield* Effect.promise(() => ensureAgentCliPath(serverConfig.baseDir, { force: true }));
          if (yield* Ref.get(refreshFiberRef)) {
            // A probe already past discovery may still contain the old answer.
            yield* Ref.set(refreshNeedsFollowUpRef, true);
          }
        }
        return yield* ensureRefreshFiber().pipe(Effect.flatMap(Fiber.join));
      });

      // npm's own answer for its global folder catches a prefix set anywhere the PATH floor
      // cannot read (a global npmrc, a Node installer's built-in config). Asked once, in the
      // background; a new folder holding an agent CLI joins PATH and gets checked.
      yield* Effect.gen(function* () {
        if (options?.maintainAgentCliPath !== true) return;
        const npm = resolveExecutable("npm", { env: process.env });
        if (!npm) return;
        const output = yield* Effect.gen(function* () {
          const child = yield* spawner.spawn(
            makeEffectProcessCommand(npm, ["config", "get", "prefix"], {
              env: { ...process.env, npm_config_update_notifier: "false" },
              stdin: "ignore",
            }),
          );
          const [stdout, , exitCode] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: 4_096 }),
              collectUint8StreamText({ stream: child.stderr, maxBytes: 4_096 }),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          return exitCode === 0 ? stdout.text : "";
        }).pipe(Effect.scoped, Effect.timeoutOption(Duration.seconds(15)));
        const prefix = Option.isSome(output) ? parseNpmPrefixOutput(output.value) : undefined;
        if (!prefix) return;
        const added = yield* Effect.promise(() =>
          appendAgentCliDirectoriesToPath([npmGlobalBinDirectory(prefix)], {
            keepLast: [managedAgentBinDirectory(managedAgentInstallPrefix(serverConfig.baseDir))],
          }),
        );
        if (added.length > 0) yield* refresh;
      }).pipe(Effect.ignoreCause({ log: true }), Effect.forkIn(refreshScope));

      const nowIso = Effect.map(DateTime.now, DateTime.formatIso);

      const makeUpdateState = (input: {
        readonly status: ServerProviderUpdateState["status"];
        readonly startedAt: string | null;
        readonly finishedAt: string | null;
        readonly message: string | null;
        readonly output?: string | null;
      }): ServerProviderUpdateState => ({
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        message: input.message,
        output: input.output ?? null,
      });

      const describeUpdateCommandError = (error: unknown): string => {
        if (error instanceof Error && error.message.trim().length > 0) {
          if (error.message.includes("initial is not a function")) {
            return "Update command failed before producing output. Try running the provider update command from a terminal.";
          }
          return error.message;
        }
        if (typeof error === "string" && error.trim().length > 0) {
          return error;
        }
        return "Update command could not be started.";
      };

      const runUpdateCommand = Effect.fn("runProviderUpdateCommand")(function* (input: {
        readonly instance: ResolvedProviderInstance;
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly pathPrepend?: string;
        readonly packageChannel?: ProviderPackageChannel;
        readonly onSpawn?: () => void;
        readonly onComplete?: () => void;
        readonly assertSettingsCurrent?: () => void;
      }) {
        const baseEnv = yield* Effect.try({
          try: () =>
            makeProviderUpdateEnv(input.instance, {
              homeDir: serverConfig.homeDir,
              isolationRootDir: serverConfig.stateDir,
            }),
          catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
        });
        const updateEnv = applyProviderPackageChannelEnv(
          input.pathPrepend ? prependPathEntry(baseEnv, input.pathPrepend) : baseEnv,
          input.packageChannel,
        );
        const command = makeEffectProcessCommand(input.command, input.args, {
          env: updateEnv,
          // Update commands are non-interactive. An open stdin pipe lets CLIs such as
          // `opencode upgrade` block on a confirmation prompt until the update timeout.
          stdin: "ignore",
        });
        const child = yield* Effect.suspend(() => {
          try {
            // No asynchronous work between the final settings guard and spawn.
            input.assertSettingsCurrent?.();
          } catch (cause) {
            return Effect.fail(cause instanceof Error ? cause : new Error(String(cause)));
          }
          return spawner.spawn(command);
        });
        input.onSpawn?.();
        yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
        const [stdout, stderr, exitCode] = yield* Effect.all(
          [
            collectUint8StreamText({
              stream: child.stdout,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            collectUint8StreamText({
              stream: child.stderr,
              maxBytes: UPDATE_OUTPUT_MAX_BYTES,
            }),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );
        input.onComplete?.();
        return {
          stdout: stdout.text,
          stderr: stderr.text,
          exitCode,
          stdoutTruncated: stdout.truncated,
          stderrTruncated: stderr.truncated,
        };
      });

      const makeLoginState = (input: {
        readonly status: ServerProviderLoginState["status"];
        readonly startedAt: string | null;
        readonly finishedAt: string | null;
        readonly message: string | null;
      }): ServerProviderLoginState => ({
        status: input.status,
        startedAt: input.startedAt,
        finishedAt: input.finishedAt,
        message: input.message,
      });

      const describeLoginError = (cause: unknown): string => {
        if (cause instanceof Error && cause.message.trim().length > 0) return cause.message;
        if (typeof cause === "string" && cause.trim().length > 0) return cause.trim();
        return "Provider sign-in could not be started.";
      };

      const makeLoginError = (
        input: { readonly provider: ProviderKind; readonly instanceId: ProviderInstanceId },
        cause: unknown,
      ) =>
        new ServerProviderLoginError({
          provider: input.provider,
          instanceId: input.instanceId,
          reason: describeLoginError(cause),
        });

      const prepareProviderLoginTarget = Effect.fn("prepareProviderLoginTarget")(function* (input: {
        readonly provider: ProviderKind;
        readonly instanceId: ProviderInstanceId;
      }) {
        if (input.provider !== CODEX_PROVIDER && input.provider !== CLAUDE_AGENT_PROVIDER) {
          return yield* makeLoginError(
            input,
            "Only Codex and Claude support account sign-in from Moss.",
          );
        }
        const settings = yield* serverSettings.getSettings.pipe(
          Effect.mapError((cause) => makeLoginError(input, cause)),
        );
        const instance = resolveProviderInstanceTarget(settings, input);
        if (!instance) {
          return yield* makeLoginError(input, "Provider account is not configured.");
        }
        if (!instance.enabled) {
          return yield* makeLoginError(input, "Provider account is disabled in Moss settings.");
        }
        const instanceId = String(instance.instanceId);
        if (
          instance.config.managed === true ||
          instance.config.byok === true ||
          instanceId === "codex_moss" ||
          instanceId === "codex_byok" ||
          instanceId === "claude_moss"
        ) {
          return yield* makeLoginError(
            input,
            "Moss managed and API-key accounts do not use provider sign-in.",
          );
        }

        const startOptions = providerStartOptionsFromInstance(instance);
        const configuredExecutable = providerRuntimeBinaryPath(instance);

        if (input.provider === CODEX_PROVIDER) {
          const executable = yield* Effect.try({
            try: () =>
              resolveCodexProviderLoginExecutable({
                configuredBinaryPath: configuredExecutable,
                env: process.env,
              }),
            catch: (cause) => makeLoginError(input, cause),
          });
          // Sign-in may create the explicitly selected private directory. It
          // must never infer an account home from the shared history source.
          if (settings.providers.codex.shareStateAcrossAccounts) {
            const privateHome = codexStateBindingAccountFromSettings(
              settings,
              instanceId,
            )?.privateHomePath;
            if (!privateHome || !nodePath.isAbsolute(privateHome)) {
              return yield* makeLoginError(input, "请选择此 Codex 账户的独立私有目录后再登录。");
            }
            yield* fileSystem
              .makeDirectory(privateHome, { recursive: true })
              .pipe(Effect.mapError((cause) => makeLoginError(input, cause)));
          }
          const selected = yield* Effect.tryPromise({
            try: () => selectCodexState(instanceId, startOptions),
            catch: (cause) => makeLoginError(input, cause),
          });
          const options = selected?.codex;
          const credentialFence = yield* Effect.try({
            try: () => readCodexCredentialFence(options),
            catch: (cause) => makeLoginError(input, cause),
          });
          const environment = {
            ...process.env,
            ...(options?.environment ?? instance.environment),
          };
          const authTracking = yield* Effect.try({
            try: () =>
              prepareCodexAuthTracking({
                ...options,
                env: environment,
              }),
            catch: (cause) => makeLoginError(input, cause),
          });
          const authoritativeAuthHomePath = nodePath.dirname(
            authTracking.authoritativeAuthFilePath,
          );
          yield* fileSystem
            .makeDirectory(authoritativeAuthHomePath, { recursive: true })
            .pipe(Effect.mapError((cause) => makeLoginError(input, cause)));
          return {
            provider: CODEX_PROVIDER,
            instanceId: input.instanceId,
            executable,
            cwd: serverConfig.cwd,
            env: buildCodexLoginEnvironment({
              environment,
              authoritativeAuthHomePath,
            }),
            credentialPaths: [authTracking.authoritativeAuthFilePath],
            ...(credentialFence
              ? { programSourceHomePath: credentialFence.sourceHomeIdentity }
              : {}),
          };
        }

        if (settings.providers.claudeAgent.shareStateAcrossAccounts) {
          const account = yield* Effect.try({
            try: () => claudeStateBindingAccountFromSettings(settings, instanceId),
            catch: (cause) => makeLoginError(input, cause),
          });
          if (!account)
            return yield* makeLoginError(input, "请选择此 Claude 账户的独立私有目录后再登录。");
          for (const directory of [
            account.homePath,
            account.configPath,
            account.environment?.CLAUDE_SECURESTORAGE_CONFIG_DIR,
          ]) {
            if (directory)
              yield* fileSystem
                .makeDirectory(directory, { recursive: true })
                .pipe(Effect.mapError((cause) => makeLoginError(input, cause)));
          }
        }
        const selected = yield* Effect.tryPromise({
          try: () => selectClaudeState(instanceId, startOptions),
          catch: (cause) => makeLoginError(input, cause),
        });
        const options = selected?.claudeAgent;
        const isolatedEnvironment = yield* Effect.try({
          try: () =>
            // The same account home the health check and chats use. Falling back to the
            // instance's (empty) environment would count as a custom environment and send
            // the person's own Claude sign-in into an isolated home nothing else reads.
            buildClaudeInstanceProcessEnv(options?.homePath, options?.environment, {
              baseEnvironment: process.env,
              homeDir: serverConfig.homeDir,
              providerInstanceId: instance.instanceId,
              isolationRootDir: serverConfig.stateDir,
            }),
          catch: (cause) => makeLoginError(input, cause),
        });
        const environment = buildClaudeLoginEnvironment(isolatedEnvironment);
        const loginDirectories = new Set(
          [environment.HOME, environment.CLAUDE_CONFIG_DIR].filter(
            (directory): directory is string =>
              typeof directory === "string" && directory.length > 0,
          ),
        );
        yield* Effect.forEach(
          loginDirectories,
          (directory) =>
            fileSystem
              .makeDirectory(directory, { recursive: true })
              .pipe(Effect.mapError((cause) => makeLoginError(input, cause))),
          { concurrency: "unbounded", discard: true },
        );
        return {
          provider: CLAUDE_AGENT_PROVIDER,
          instanceId: input.instanceId,
          // Sign in with the same CLI the chat runs: own install, else the one Moss ships.
          executable:
            resolveClaudeCodeExecutablePath({
              binaryPath: configuredExecutable,
              providerInstanceId: instanceId,
              env: process.env,
            }) ?? "claude",
          cwd: serverConfig.cwd,
          env: environment,
          // macOS keeps Claude's sign-in in the Keychain; there the CLI's exit decides.
          credentialPaths: resolveClaudeCredentialsPaths({ env: environment }),
          assertStateBindingCurrent: () => {
            readClaudeStateBinding(options);
          },
        };
      });

      const completeProviderLogin = Effect.fn("completeProviderLogin")(function* (input: {
        readonly provider: ProviderLoginDriver;
        readonly instanceId: ProviderInstanceId;
        readonly startedAt: string;
        readonly completion: ReturnType<typeof loginManager.start>["completion"];
      }) {
        const target = { provider: input.provider, instanceId: input.instanceId };
        const completion = yield* Effect.promise(() => input.completion);
        if (completion.status === "cancelled") {
          const finishedAt = yield* nowIso;
          yield* setProviderLoginState(
            target,
            makeLoginState({
              status: "cancelled",
              startedAt: input.startedAt,
              finishedAt,
              message: "Sign-in cancelled.",
            }),
          );
          return;
        }
        if (completion.status === "failed") {
          const finishedAt = yield* nowIso;
          yield* setProviderLoginState(
            target,
            makeLoginState({
              status: "failed",
              startedAt: input.startedAt,
              finishedAt,
              message: completion.message,
            }),
          );
          return;
        }

        yield* setProviderLoginState(
          target,
          makeLoginState({
            status: "verifying",
            startedAt: input.startedAt,
            finishedAt: null,
            message: "Checking the signed-in account.",
          }),
        );
        const providers = yield* refreshNow;
        const refreshed = providers.find(
          (status) =>
            (status.driver ?? status.provider) === input.provider &&
            providerStatusInstanceKey(status) === input.instanceId,
        );
        const authenticated = refreshed?.authStatus === "authenticated";
        const finishedAt = yield* nowIso;
        yield* setProviderLoginState(
          target,
          makeLoginState({
            status: authenticated ? "succeeded" : "failed",
            startedAt: input.startedAt,
            finishedAt,
            message: authenticated
              ? "Signed in."
              : "Sign-in finished, but the provider did not confirm the account.",
          }),
        );
      });

      const startLogin: ProviderHealthShape["startLogin"] = Effect.fn("ProviderHealth.startLogin")(
        function* (input) {
          const target = yield* prepareProviderLoginTarget(input);
          const startedAt = yield* nowIso;
          yield* setProviderLoginState(
            input,
            makeLoginState({
              status: "starting",
              startedAt,
              finishedAt: null,
              message: "Starting sign-in.",
            }),
          );
          const inFlightRefresh = yield* Ref.get(refreshFiberRef);
          if (inFlightRefresh) {
            yield* Fiber.join(inFlightRefresh);
          }
          const handle = yield* Effect.try({
            try: () => loginManager.start(target),
            catch: (cause) => makeLoginError(input, cause),
          }).pipe(
            Effect.tapError((error) =>
              Effect.gen(function* () {
                const finishedAt = yield* nowIso;
                yield* setProviderLoginState(
                  input,
                  makeLoginState({
                    status: "failed",
                    startedAt,
                    finishedAt,
                    message: error.reason,
                  }),
                );
              }),
            ),
          );
          const providers = yield* setProviderLoginState(
            input,
            makeLoginState({
              status: "waiting_browser",
              startedAt,
              finishedAt: null,
              message: "Finish sign-in in your browser.",
            }),
          );
          yield* completeProviderLogin({
            provider: target.provider,
            instanceId: target.instanceId,
            startedAt,
            completion: handle.completion,
          }).pipe(
            Effect.catchCause((cause) =>
              Effect.gen(function* () {
                const finishedAt = yield* nowIso;
                yield* setProviderLoginState(
                  input,
                  makeLoginState({
                    status: "failed",
                    startedAt,
                    finishedAt,
                    message: describeLoginError(cause),
                  }),
                );
              }),
            ),
            Effect.forkIn(refreshScope),
            Effect.asVoid,
          );
          return { providers };
        },
      );

      const cancelLogin: ProviderHealthShape["cancelLogin"] = Effect.fn(
        "ProviderHealth.cancelLogin",
      )(function* (input) {
        if (input.provider !== CODEX_PROVIDER && input.provider !== CLAUDE_AGENT_PROVIDER) {
          return yield* makeLoginError(
            input,
            "Only Codex and Claude support account sign-in from Moss.",
          );
        }
        const target = {
          provider: input.provider as ProviderLoginDriver,
          instanceId: input.instanceId,
        };
        yield* Effect.try({
          try: () => loginManager.cancel(target),
          catch: (cause) => makeLoginError(input, cause),
        });
        const current = (yield* Ref.get(loginStatesRef)).get(providerTargetIdentityKey(input));
        const finishedAt = yield* nowIso;
        const providers = yield* setProviderLoginState(
          input,
          makeLoginState({
            status: "cancelled",
            startedAt: current?.startedAt ?? null,
            finishedAt,
            message: "Sign-in cancelled.",
          }),
        );
        return { providers };
      });

      const updateProvider: ProviderHealthShape["updateProvider"] = Effect.fn(
        "ProviderHealth.updateProvider",
      )(function* (input) {
        const provider = input.provider;
        const instanceId = input.instanceId;
        const target = { provider, ...(instanceId ? { instanceId } : {}) };
        const toUpdateError = (reason: unknown) =>
          new ServerProviderUpdateError({
            provider,
            ...(instanceId ? { instanceId } : {}),
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        const resolveEnabledInstance = serverSettings.getSettings.pipe(
          Effect.mapError(toUpdateError),
          Effect.map((settings) => resolveProviderInstanceTarget(settings, target)),
        );
        const unavailableError = (instance: ResolvedProviderInstance | null) =>
          new ServerProviderUpdateError({
            provider,
            ...(instanceId ? { instanceId } : {}),
            reason: instance
              ? instanceId
                ? "Provider instance is disabled in Moss settings."
                : "Provider is disabled in Moss settings."
              : "Provider instance is not configured.",
          });
        // Test and rehearsal runs set this so a click on 更新 can never reach an install outside
        // their isolated profile: the update writes to the npm prefix that owns the detected CLI,
        // which is the person's real global folder whenever it is still on PATH.
        if (process.env[PROVIDER_UPDATES_DISABLED_ENV] === "1") {
          return yield* new ServerProviderUpdateError({
            provider,
            ...(instanceId ? { instanceId } : {}),
            reason: `Agent updates are turned off in this environment (${PROVIDER_UPDATES_DISABLED_ENV}=1).`,
          });
        }
        const initialInstance = yield* resolveEnabledInstance;
        if (!initialInstance || !initialInstance.enabled) {
          return yield* unavailableError(initialInstance);
        }
        const capabilities = yield* getProviderMaintenanceCapabilities(target).pipe(
          Effect.mapError(toUpdateError),
        );
        const update = capabilities.update;
        if (!update) {
          return yield* new ServerProviderUpdateError({
            provider,
            ...(instanceId ? { instanceId } : {}),
            reason: "This provider does not support one-click updates.",
          });
        }

        const run = Effect.gen(function* () {
          const currentSnapshot = yield* serverSettings.getSnapshot.pipe(
            Effect.mapError(toUpdateError),
          );
          const currentInstance = resolveProviderInstanceTarget(currentSnapshot.settings, target);
          if (!currentInstance || !currentInstance.enabled) {
            const finishedAt = yield* nowIso;
            yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "failed",
                startedAt: null,
                finishedAt,
                message:
                  "Provider instance was disabled or removed before its queued update could start.",
              }),
            );
            return yield* unavailableError(currentInstance);
          }
          const startedAt = yield* nowIso;
          // Resolve the installed floor from this exact account/instance inside
          // the maintenance queue. A different account's cached version cannot
          // authorize a package update, and a queued binary override may change.
          const checked = yield* checkProviderInstanceStatus(currentInstance).pipe(
            Effect.provideService(ChildProcessSpawner.ChildProcessSpawner, spawner),
            Effect.provideService(FileSystem.FileSystem, fileSystem),
            Effect.provideService(Path.Path, path),
          );
          const currentVersion = Option.isSome(checked) ? (checked.value.version ?? null) : null;
          const effectiveCapabilities = yield* getProviderMaintenanceCapabilities({
            ...target,
            installedVersion: currentVersion,
          }).pipe(
            Effect.flatMap((currentCapabilities) =>
              prepareProviderMaintenanceUpdate(currentCapabilities, currentVersion),
            ),
            Effect.mapError(toUpdateError),
          );
          const verifiedUpdate = effectiveCapabilities.update;
          const currentRevision = (yield* serverSettings.getSnapshot.pipe(
            Effect.mapError(toUpdateError),
          )).revision;
          const preparationFailure = providerUpdatePreparationFailure({
            settingsChanged: currentRevision !== currentSnapshot.revision,
            expectedLockKey: update.lockKey,
            verifiedUpdate,
          });
          if (preparationFailure || !verifiedUpdate) {
            const reason = preparationFailure ?? PROVIDER_UPDATE_VERSION_UNCONFIRMED_MESSAGE;
            yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt: new Date().toISOString(),
                message: reason,
              }),
            );
            return yield* new ServerProviderUpdateError({
              provider,
              ...(instanceId ? { instanceId } : {}),
              reason,
            });
          }
          yield* setProviderUpdateState(
            target,
            makeUpdateState({
              status: "running",
              startedAt,
              finishedAt: null,
              message: "Updating provider.",
            }),
          );

          const waitForProviderDisablement = Effect.gen(function* () {
            while (
              yield* resolveEnabledInstance.pipe(
                Effect.map((instance) => Boolean(instance?.enabled)),
                Effect.catch(() => Effect.succeed(true)),
              )
            ) {
              yield* Effect.sleep(Duration.millis(PROVIDER_UPDATE_ENABLEMENT_POLL_MS));
            }
          });
          // The package coordinator serializes updates; this same epoch record
          // also excludes every chat/probe/login using the program, across accounts.
          const runtimePrograms =
            provider === "codex" || provider === "claudeAgent"
              ? agentProgramsForServer(serverConfig, provider)
              : undefined;
          let updateSpawned = false;
          let updateCompleted = false;
          const commandOutcome = yield* Effect.acquireUseRelease(
            Effect.try({
              try: () => {
                if (!runtimePrograms) return undefined;
                const configuredBinaryPath = providerRuntimeBinaryPath(currentInstance);
                const binaryPath =
                  provider === "codex"
                    ? resolveCodexExecutable({ configuredBinaryPath, env: process.env }).binaryPath
                    : resolveClaudeCodeRuntime({
                        binaryPath: configuredBinaryPath,
                        env: process.env,
                      }).binaryPath;
                return runtimePrograms.beginMaintenance(binaryPath);
              },
              catch: toUpdateError,
            }),
            () =>
              Effect.raceFirst(
                runUpdateCommand({
                  instance: currentInstance,
                  command: verifiedUpdate.executable,
                  args: verifiedUpdate.args,
                  onSpawn: () => {
                    updateSpawned = true;
                  },
                  onComplete: () => {
                    updateCompleted = true;
                  },
                  assertSettingsCurrent: () => {
                    if (
                      Effect.runSync(serverSettings.getSnapshot).revision !==
                      currentSnapshot.revision
                    ) {
                      throw new Error(PROVIDER_UPDATE_SETTINGS_CHANGED_MESSAGE);
                    }
                  },
                  ...(verifiedUpdate.pathPrepend
                    ? { pathPrepend: verifiedUpdate.pathPrepend }
                    : {}),
                  ...(effectiveCapabilities.packageChannel
                    ? { packageChannel: effectiveCapabilities.packageChannel }
                    : {}),
                }).pipe(
                  Effect.scoped,
                  Effect.timeoutOption(Duration.millis(providerUpdateTimeoutMs)),
                  Effect.result,
                  Effect.map((result) => ({ _tag: "completed" as const, result })),
                ),
                waitForProviderDisablement.pipe(Effect.as({ _tag: "disabled" as const })),
              ),
            (maintenance) =>
              Effect.sync(() =>
                maintenance?.finish(updateSpawned, !updateSpawned || updateCompleted),
              ),
          ).pipe(
            Effect.tapError((error) =>
              setProviderUpdateState(
                target,
                makeUpdateState({
                  status: "failed",
                  startedAt,
                  finishedAt: new Date().toISOString(),
                  message: error.reason,
                }),
              ).pipe(Effect.asVoid),
            ),
          );
          const finishedAt = yield* nowIso;
          if (commandOutcome._tag === "disabled") {
            const providers = yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt,
                message: instanceId
                  ? "Update stopped because the provider instance was disabled or removed."
                  : "Update stopped because the provider was disabled.",
              }),
            );
            return { providers };
          }
          const commandResult = commandOutcome.result;
          if (Result.isFailure(commandResult)) {
            const providers = yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt,
                message: describeUpdateCommandError(commandResult.failure),
              }),
            );
            return { providers };
          }
          const result = commandResult.success;
          const output = Option.isSome(result)
            ? [result.value.stderr, result.value.stdout].filter(Boolean).join("\n\n").trim() || null
            : null;
          const failed = Option.isNone(result) || result.value.exitCode !== 0;
          if (failed) {
            const reason = Option.isSome(result) ? providerUpdateFailureReason(result.value) : null;
            const message = Option.isNone(result)
              ? `Update timed out after ${formatProviderUpdateTimeout(providerUpdateTimeoutMs)}. The provider process was stopped.`
              : reason
                ? `Update command exited with code ${result.value.exitCode}: ${reason}`
                : `Update command exited with code ${result.value.exitCode}.`;
            const lacksMirror =
              effectiveCapabilities.packageChannel === "cn-mirror" &&
              !MIRRORED_UPDATE_LOCK_KEYS.has(verifiedUpdate.lockKey);
            const providers = yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "failed",
                startedAt,
                finishedAt,
                message: lacksMirror ? `${message} ${PROVIDER_UPDATE_NO_MIRROR_HINT}` : message,
                output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
              }),
            );
            return { providers };
          }

          const providers = yield* refreshNow.pipe(Effect.mapError(toUpdateError));
          if (provider === "codex" || provider === "claudeAgent") {
            const finalProviders = yield* setProviderUpdateState(
              target,
              makeUpdateState({
                status: "succeeded",
                startedAt,
                finishedAt,
                message: agentProgramRestartMessage(provider),
                output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
              }),
            );
            return { providers: finalProviders };
          }
          const refreshed = providers.find(
            (status) =>
              (status.driver ?? status.provider) === provider &&
              providerStatusInstanceKey(status) === providerStatusKey(target),
          );
          const refreshedAdvisory = refreshed?.versionAdvisory;
          const targetVersionUnknown = Boolean(verifiedUpdate.targetVersion && !refreshed?.version);
          const targetVersionNotReached = Boolean(
            verifiedUpdate.targetVersion &&
            refreshed?.version &&
            compareSemverVersions(refreshed.version, verifiedUpdate.targetVersion) < 0,
          );
          const stillOutdated =
            refreshedAdvisory?.status === "behind_latest" || targetVersionNotReached;
          const stillOutdatedVersions =
            refreshedAdvisory?.currentVersion && refreshedAdvisory.latestVersion
              ? ` (installed ${refreshedAdvisory.currentVersion}, latest ${refreshedAdvisory.latestVersion})`
              : "";
          const finalProviders = yield* setProviderUpdateState(
            target,
            makeUpdateState({
              status: targetVersionUnknown ? "failed" : stillOutdated ? "unchanged" : "succeeded",
              startedAt,
              finishedAt,
              message: targetVersionUnknown
                ? "Update command completed, but Moss could not verify the requested provider version."
                : stillOutdated
                  ? `Update command completed, but Moss still detects an outdated provider version${stillOutdatedVersions}.`
                  : "Provider updated.",
              output: output ? output.slice(0, UPDATE_OUTPUT_MAX_BYTES) : null,
            }),
          );
          return { providers: finalProviders };
        });

        return yield* commandCoordinator.withCommandLock({
          targetKey: `instance:${providerStatusKey(target)}`,
          lockKey: update.lockKey,
          onQueued: setProviderUpdateState(
            target,
            makeUpdateState({
              status: "queued",
              startedAt: null,
              finishedAt: null,
              message: "Waiting for another provider update to finish.",
            }),
          ).pipe(Effect.asVoid),
          run,
        });
      });

      const runInstallCommand = (input: {
        readonly command: string;
        readonly args: ReadonlyArray<string>;
        readonly env: NodeJS.ProcessEnv;
      }) =>
        Effect.gen(function* () {
          const child = yield* spawner.spawn(
            makeEffectProcessCommand(input.command, input.args, {
              env: input.env,
              stdin: "ignore",
            }),
          );
          yield* Effect.addFinalizer(() => child.kill().pipe(Effect.ignore));
          const [stdout, stderr, exitCode] = yield* Effect.all(
            [
              collectUint8StreamText({ stream: child.stdout, maxBytes: UPDATE_OUTPUT_MAX_BYTES }),
              collectUint8StreamText({ stream: child.stderr, maxBytes: UPDATE_OUTPUT_MAX_BYTES }),
              child.exitCode.pipe(Effect.map(Number)),
            ],
            { concurrency: "unbounded" },
          );
          return {
            stdout: stdout.text,
            stderr: stderr.text,
            exitCode,
          } satisfies AgentInstallCommandResult;
        }).pipe(Effect.scoped, Effect.timeoutOption(Duration.millis(providerUpdateTimeoutMs)));

      const resolveFallbackNpmCommand = (channel: ProviderPackageChannel | undefined) =>
        Effect.gen(function* () {
          if (resolveExecutable("npm", { env: process.env })) return undefined;
          const runtime = resolveMossNodeRuntime();
          if (!runtime) return undefined;
          const npmCli = yield* Effect.tryPromise(() =>
            ensureMossNpm({
              mossHomeDir: serverConfig.baseDir,
              registries: agentInstallRegistries(channel).map((entry) => entry.registry),
            }),
          ).pipe(
            Effect.tapError((cause) =>
              Effect.logWarning("Could not fetch npm for Moss's own runtime", {
                detail: cause instanceof Error ? cause.message : String(cause),
              }),
            ),
            Effect.orElseSucceed(() => null),
          );
          if (!npmCli) return undefined;
          yield* Effect.promise(() =>
            writeNodeShim({
              binDirectory: managedAgentBinDirectory(
                managedAgentInstallPrefix(serverConfig.baseDir),
              ),
              runtime,
            }),
          );
          return { command: runtime.command, prefixArgs: [npmCli], env: runtime.env };
        });

      const installProvider: ProviderHealthShape["installProvider"] = Effect.fn(
        "ProviderHealth.installProvider",
      )(function* (input) {
        const provider = input.provider;
        const instanceId = input.instanceId;
        const target = { provider, ...(instanceId ? { instanceId } : {}) };
        const toInstallError = (reason: unknown) =>
          new ServerProviderInstallError({
            provider,
            ...(instanceId ? { instanceId } : {}),
            reason: reason instanceof Error ? reason.message : String(reason),
          });
        const installStrategy = providerInstallStrategy(provider);
        if (!installStrategy) {
          return yield* toInstallError("not-installable");
        }
        // Test and rehearsal runs never install agents either: the same switch as updates.
        if (process.env[PROVIDER_UPDATES_DISABLED_ENV] === "1") {
          return yield* toInstallError(
            `Agent installs are turned off in this environment (${PROVIDER_UPDATES_DISABLED_ENV}=1).`,
          );
        }
        const settings = yield* serverSettings.getSettings.pipe(Effect.mapError(toInstallError));
        const instance = resolveProviderInstanceTarget(settings, target);
        if (instance && !instance.enabled) {
          return yield* toInstallError("disabled");
        }
        const makeInstallState = (
          state: Partial<ServerProviderInstallState> & Pick<ServerProviderInstallState, "status">,
        ): ServerProviderInstallState => ({
          phase: null,
          source: null,
          startedAt: null,
          finishedAt: null,
          version: null,
          reason: null,
          ...state,
        });

        const run = Effect.gen(function* () {
          const startedAt = yield* nowIso;
          yield* setProviderInstallState(
            target,
            makeInstallState({ status: "running", phase: "installing", startedAt }),
          );
          const channel = resolveProviderPackageChannel({
            providerInstances: settings.providerInstances,
          });
          // No npm of the person's own: run npm on Moss's own runtime instead of sending
          // them to a web page. npm is fetched once, from the same registry as the agent.
          const npmCommand =
            installStrategy === "npm" ? yield* resolveFallbackNpmCommand(channel) : undefined;
          const outcome = yield* runOneClickAgentInstall({
            provider,
            mossHomeDir: serverConfig.baseDir,
            channel,
            env: { ...process.env },
            ...(npmCommand ? { npmCommand } : {}),
            run: runInstallCommand,
            onCleanupUnproven: Effect.gen(function* () {
              yield* installCoordinator.blockCommandLock(
                "moss-agent-install",
                toInstallError(
                  "A previous agent install could not confirm process cleanup. Restart Moss before retrying.",
                ),
              );
              yield* setProviderInstallState(
                target,
                makeInstallState({
                  status: "failed",
                  startedAt,
                  finishedAt: yield* nowIso,
                  reason: "cleanup-unproven",
                }),
              );
            }),
            onProgress: (progress) =>
              setProviderInstallState(
                target,
                makeInstallState({
                  status: "running",
                  phase: progress.phase,
                  source: progress.source,
                  startedAt,
                }),
              ).pipe(Effect.asVoid),
          });
          const finishedAt = yield* nowIso;
          if (!outcome.ok) {
            yield* Effect.logWarning("Agent install failed", {
              provider,
              reason: outcome.reason,
              detail: outcome.detail,
            });
            const providers = yield* setProviderInstallState(
              target,
              makeInstallState({ status: "failed", startedAt, finishedAt, reason: outcome.reason }),
            );
            return { providers };
          }
          // Agents Moss installed live in one folder at the end of PATH, after the person's own.
          appendManagedAgentBinDirectoryToPath(serverConfig.baseDir);
          yield* refreshNow.pipe(Effect.mapError(toInstallError));
          const providers = yield* setProviderInstallState(
            target,
            makeInstallState({
              status: "succeeded",
              source: outcome.source,
              startedAt,
              finishedAt,
              version: outcome.version,
            }),
          );
          return { providers };
        });

        return yield* installCoordinator.withCommandLock({
          targetKey: `install:${provider}:${providerStatusKey(target)}`,
          // One agent install at a time into the shared Moss-managed prefix.
          lockKey: "moss-agent-install",
          onQueued: setProviderInstallState(target, makeInstallState({ status: "queued" })).pipe(
            Effect.asVoid,
          ),
          run,
        });
      });

      const manageProviderInstallation: NonNullable<
        ProviderHealthShape["manageProviderInstallation"]
      > = (input) => {
        const toError = (reason: unknown, code?: ProviderInstallationErrorCode) =>
          new ServerProviderInstallError({
            provider: input.provider,
            reason: reason instanceof Error ? reason.message : String(reason),
            ...(reason instanceof ProviderInstallationError
              ? { code: reason.code }
              : code
                ? { code }
                : {}),
          });
        const run = Effect.gen(function* () {
          const settings = yield* serverSettings.getSettings.pipe(
            Effect.mapError((cause) => toError(cause)),
          );
          const instance = resolveProviderInstanceTarget(settings, { provider: input.provider });
          const configured = yield* Effect.try({
            try: () => (instance ? providerRuntimeBinaryPath(instance) : undefined),
            catch: toError,
          });
          const command =
            input.provider === "codex"
              ? resolveCodexExecutable({ configuredBinaryPath: configured, env: process.env })
                  .binaryPath
              : input.provider === "claudeAgent"
                ? resolveClaudeCodeRuntime({ binaryPath: configured, env: process.env }).binaryPath
                : configured || PROVIDER_CLI_COMMAND_BY_KIND[input.provider];
          const bundled = runsMossBundledAgentRuntime(input.provider, command, input.provider);
          const binaryPath =
            bundled && (yield* fileSystem.exists(command).pipe(Effect.orElseSucceed(() => false)))
              ? command
              : resolveExecutable(command, { env: process.env });
          const target = {
            provider: input.provider,
            mossHomeDir: serverConfig.baseDir,
            binaryPath,
            bundled,
          };
          if (input.action === "uninstall") {
            if (process.env[PROVIDER_UPDATES_DISABLED_ENV] === "1")
              return yield* toError(
                `Agent changes are disabled in this environment (${PROVIDER_UPDATES_DISABLED_ENV}=1).`,
                PROVIDER_INSTALLATION_ERROR_CODES.changesDisabled,
              );
            yield* Effect.try({
              try: () =>
                assertProviderInstallationRemovalAllowed(input.provider, {
                  instances: deriveProviderInstances(settings),
                }),
              catch: toError,
            });
            const current = yield* Ref.get(statusesRef);
            if (
              current.some(
                (entry) =>
                  (entry.driver ?? entry.provider) === input.provider &&
                  (entry.updateState?.status === "running" ||
                    entry.updateState?.status === "queued" ||
                    entry.installState?.status === "running" ||
                    entry.installState?.status === "queued"),
              )
            )
              return yield* toError(
                "This agent is still being installed or updated.",
                PROVIDER_INSTALLATION_ERROR_CODES.busy,
              );
            const selectedProgramMoved = yield* Effect.acquireUseRelease(
              Effect.try({
                try: () =>
                  (input.provider === "codex" || input.provider === "claudeAgent") && binaryPath
                    ? agentProgramsForServer(serverConfig, input.provider).beginMaintenance(
                        binaryPath,
                      )
                    : undefined,
                catch: toError,
              }),
              () =>
                Effect.tryPromise({
                  try: () => removeManagedProviderInstallation(target),
                  catch: toError,
                }),
              (maintenance, exit) =>
                Effect.sync(() =>
                  maintenance?.finish(Exit.isSuccess(exit) && exit.value, Exit.isSuccess(exit)),
                ),
            );
            resetLocalAgentPathLookupCache();
            if (selectedProgramMoved) {
              const cleared = deriveProviderInstances(settings)
                .filter((entry) => entry.driver === input.provider)
                .map((entry) => ({
                  ...makeDisabledProviderStatus(input.provider),
                  instanceId: entry.instanceId,
                  ...(entry.displayName ? { displayName: entry.displayName } : {}),
                }));
              yield* Ref.update(statusesRef, (current) =>
                orderProviderStatuses([
                  ...current.filter((entry) => (entry.driver ?? entry.provider) !== input.provider),
                  ...cleared,
                ]),
              );
              yield* persistStatuses(cleared);
            }
            yield* refreshNow.pipe(Effect.mapError(toError));
          }
          const result = yield* Effect.tryPromise({
            try: () =>
              inspectProviderInstallation({
                ...target,
                binaryPath:
                  input.action === "uninstall"
                    ? resolveExecutable(command, { env: process.env })
                    : binaryPath,
              }),
            catch: toError,
          });
          return { ...result, removed: input.action === "uninstall" };
        });
        return input.action === "inspect"
          ? run
          : installCoordinator.withCommandLock({
              targetKey: `remove:${input.provider}`,
              lockKey: "moss-agent-install",
              run,
            });
      };

      return {
        // Mirror upstream's behavior here: reads consume the latest stable
        // snapshot, while refreshes happen explicitly or from provider streams.
        getStatuses: Ref.get(statusesRef).pipe(Effect.flatMap(projectStatusesForCurrentSettings)),
        refresh,
        startLogin,
        cancelLogin,
        updateProvider,
        installProvider,
        manageProviderInstallation,
        get streamChanges() {
          return Stream.fromPubSub(changesPubSub);
        },
      } satisfies ProviderHealthShape;
    }),
  );
}

export const ProviderHealthLive = makeProviderHealthLive();

/** The server's own provider health: also finds agents in npm's configured global folder. */
export const ServerProviderHealthLive = makeProviderHealthLive({ maintainAgentCliPath: true });
