// FILE: AcpAgentSpec.ts
// Purpose: Per-kind behavior table for the generic ACP agent drivers (Kimi Code, MiniMax Code, ZCode).
// Layer: Provider ACP support
// Exports: AcpAgentSpec types, the three specs, and pure failure classification helpers.

import nodePath from "node:path";

import type { ProviderListModelsResult } from "@moss/contracts";
import type { MossAccessLane } from "@moss/shared/mossRealmCatalog";
import type * as Acp from "@agentclientprotocol/sdk";

import { withMossManagedAcpAgentHooks } from "../mossManagedAcpAgentEnvironment.ts";
import { knownAgentDesktopInstall } from "../agentDesktopInstalls.ts";
import {
  commandExistsOnPath,
  directoriesContainingCommand,
  firstExistingPath,
  type ProviderBinaryResolutionOptions,
} from "../providerBinaryResolution.ts";
import type { AcpSessionModeAliases } from "./AcpAdapterSessionSupport.ts";
import type * as AcpErrors from "./AcpErrors.ts";
import { type AcpSessionStartupTimeouts, isAcpAuthRequiredError } from "./AcpSessionRuntime.ts";

export type AcpAgentKind = "kimi" | "minimax" | "zcode";

export interface AcpAgentRuntimeSettings {
  readonly binaryPath?: string | undefined;
  /** Private data root; only a Moss-managed instance sets it (see `homeEnvironment`). */
  readonly homePath?: string | undefined;
  readonly environment?: Readonly<Record<string, string>> | undefined;
}

/**
 * Moss-managed mode (`<kind>_moss` instances that inject a gateway key into a
 * private data dir). The hooks plug into a spec without touching the adapter;
 * `mossManagedAcpAgentEnvironment.ts` implements them per CLI:
 * - `readConfig` decodes the managed instance environment (and rejects a
 *   managed payload on a non-reserved instance id) or returns undefined for
 *   own-login;
 * - `prepareHome` materializes the private home (config files, 0600 secrets);
 * - `buildSpawnEnvironment` replaces the own-login child environment with the
 *   gateway catalog/token variables plus the MOSS_* keys the child may inherit;
 * - `listModels` returns the realm catalog without spawning the CLI;
 * - `modelId` maps a Moss model slug to the CLI's managed model value;
 * - `advertisedModelValue` picks a slug's value from what the running CLI
 *   advertises, for a CLI whose value format changes between releases.
 */
export interface AcpAgentManagedConfig {
  readonly realm: MossAccessLane;
  readonly gatewayBaseUrl: string;
  readonly homePath: string;
  readonly models: ReadonlyArray<string>;
}

export interface AcpAgentManagedSpawnEnvironment {
  /** Replaces the inherited process environment (minimal managed base env). */
  readonly baseEnv?: NodeJS.ProcessEnv | undefined;
  readonly environment: Readonly<Record<string, string | undefined>>;
  readonly inheritedMossKeys: ReadonlyArray<string>;
}

export interface AcpAgentManagedHooks<
  Config extends AcpAgentManagedConfig = AcpAgentManagedConfig,
> {
  readonly readConfig: (settings: AcpAgentRuntimeSettings) => Config | undefined;
  readonly prepareHome: (config: Config, settings: AcpAgentRuntimeSettings) => Promise<void>;
  readonly buildSpawnEnvironment: (
    config: Config,
    settings: AcpAgentRuntimeSettings,
  ) => AcpAgentManagedSpawnEnvironment;
  readonly listModels: (config: Config) => ProviderListModelsResult;
  readonly modelId?: (model: string, config: Config) => string;
  readonly advertisedModelValue?: (
    model: string,
    advertisedValues: ReadonlyArray<string>,
  ) => string | undefined;
}

export type AcpAgentAuthPolicy =
  /** `session/new` fails with -32000 while signed out; no authenticate round-trip is useful. */
  | { readonly policy: "on-demand" }
  /** `authenticate` is a readiness probe that fails fast before a lazy session hides the problem. */
  | { readonly policy: "upfront"; readonly methodId: string };

export interface AcpAgentFailure {
  readonly reason: "credentials_missing" | "backend_unavailable";
  readonly message: string;
}

export interface AcpAgentSpec<Kind extends AcpAgentKind = AcpAgentKind> {
  readonly kind: Kind;
  readonly displayName: string;
  /** Reserved Moss-managed instance id; only `managed` hooks may claim it. */
  readonly managedInstanceId: `${Kind}_moss`;
  /** Default executable; `binaryPath` overrides it. */
  readonly command: string;
  /** Arguments that start the stdio ACP server. */
  readonly args: ReadonlyArray<string>;
  readonly versionProbeArgs: ReadonlyArray<string>;
  readonly install: {
    readonly npmPackageName: string;
    /** Extra `npm install -g` flags; also applied to in-app updates. */
    readonly npmInstallArgs?: ReadonlyArray<string>;
    readonly hint: string;
  };
  readonly signIn: { readonly command: string; readonly hint: string };
  /** Child environment defaults; the instance environment overrides them. */
  readonly environmentDefaults: Readonly<Record<string, string>>;
  /** Variables that relocate the CLI's data root to `homePath`. */
  readonly homeEnvironment: (homePath: string) => Readonly<Record<string, string>>;
  /** Host-discovered variables the CLI cannot work out itself; explicit values win. */
  readonly hostEnvironment?: (env: NodeJS.ProcessEnv) => Readonly<Record<string, string>>;
  /**
   * What the CLI needs from the host beyond its own install. Returns what to tell the
   * user when that is missing, so a CLI that cannot run never reports "ready".
   */
  readonly hostRequirement?: (env: NodeJS.ProcessEnv) => string | undefined;
  readonly auth: AcpAgentAuthPolicy;
  readonly clientCapabilities?: Acp.InitializeRequest["clientCapabilities"];
  /** `session/set_config_option` ids; the category fallback covers renamed ids. */
  readonly modelConfigId: string;
  readonly thoughtLevelConfigId: string;
  /** Falls back to the legacy `session/set_model` request when no model option is advertised. */
  readonly legacySetModel: boolean;
  /**
   * Native mode aliases. `never` lists modes that bypass the CLI's own
   * permission prompts; Moss owns approvals, so those are refused even when
   * the CLI starts in one of them.
   */
  readonly modes: AcpSessionModeAliases & { readonly never: ReadonlyArray<string> };
  /** Process-wide permission option pinned so permission requests keep reaching Moss. */
  readonly permissionConfig?: { readonly id: string; readonly value: string };
  readonly startupTimeouts?: Partial<AcpSessionStartupTimeouts>;
  readonly turnIdleTimeoutEnvVar: string;
  readonly classifyFailure: (
    error: AcpErrors.AcpError,
    spec: AcpAgentSpec,
  ) => AcpAgentFailure | undefined;
  readonly managed?: AcpAgentManagedHooks;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Message plus any string detail the agent attached as JSON-RPC data. */
export function acpAgentErrorText(error: AcpErrors.AcpError): string {
  if (error._tag !== "AcpRequestError") {
    const cause = error.cause;
    const causeText =
      cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "";
    return [error.message, causeText].filter(Boolean).join(" ");
  }
  const data = error.data;
  const dataText =
    typeof data === "string"
      ? data
      : isRecord(data)
        ? [data.detail, data.details, data.message, data.reason, data.code]
            .filter((value): value is string => typeof value === "string")
            .join(" ")
        : "";
  return [error.errorMessage, dataText].filter(Boolean).join(" ");
}

/**
 * Kimi Code and MiniMax Code answer -32000 "Authentication required…" while
 * signed out; Moss's own auth-method resolution then fails with
 * `reason: "credentials_missing"`, which carries the same meaning.
 */
export function classifySignedOutFailure(
  error: AcpErrors.AcpError,
  spec: Pick<AcpAgentSpec, "displayName" | "signIn">,
): AcpAgentFailure | undefined {
  return error._tag === "AcpRequestError" &&
    (isAcpAuthRequiredError(error) ||
      (isRecord(error.data) && error.data.reason === "credentials_missing") ||
      (error.code === -32000 && /\b(?:auth|login|sign[ -]?in)/iu.test(acpAgentErrorText(error))))
    ? {
        reason: "credentials_missing",
        message: `${spec.displayName} is not signed in. ${spec.signIn.hint}`,
      }
    : undefined;
}

const KIMI_GIT_BASH_MISSING_MESSAGE =
  "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.";
const KIMI_GIT_BASH_MISSING_PATTERN = /Git Bash was not found/iu;

/** Kimi Code stops at startup on Windows without Git Bash; its own wording names the fix. */
export function classifyKimiFailure(
  error: AcpErrors.AcpError,
  spec: Pick<AcpAgentSpec, "displayName" | "signIn">,
): AcpAgentFailure | undefined {
  return KIMI_GIT_BASH_MISSING_PATTERN.test(acpAgentErrorText(error))
    ? { reason: "backend_unavailable", message: KIMI_GIT_BASH_MISSING_MESSAGE }
    : classifySignedOutFailure(error, spec);
}

/** Follows Kimi Code's own search: `KIMI_SHELL_PATH`, Git on PATH, then Git's usual folders. */
export function kimiHostRequirement(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  pathExists?: ProviderBinaryResolutionOptions["pathExists"],
): string | undefined {
  if (platform !== "win32") return undefined;
  const lookup = { env, platform, ...(pathExists ? { pathExists } : {}) };
  const override = env.KIMI_SHELL_PATH?.trim();
  const localAppData = env.LOCALAPPDATA?.trim();
  const candidates = [
    ...(override ? [override] : []),
    ...["C:\\Program Files\\Git", "C:\\Program Files (x86)\\Git"].flatMap((git) => [
      nodePath.win32.join(git, "bin", "bash.exe"),
      nodePath.win32.join(git, "usr", "bin", "bash.exe"),
    ]),
    ...(localAppData
      ? [
          nodePath.win32.join(localAppData, "Programs", "Git", "bin", "bash.exe"),
          nodePath.win32.join(localAppData, "Programs", "Git", "usr", "bin", "bash.exe"),
        ]
      : []),
  ];
  return commandExistsOnPath("git", lookup) || firstExistingPath(candidates, lookup) !== undefined
    ? undefined
    : KIMI_GIT_BASH_MISSING_MESSAGE;
}

const ZCODE_BACKEND_UNAVAILABLE_PATTERN =
  /spawn failed|ZCODE_BIN|backend reader exited|backend dead|backend pipe broken|install the ZCode CLI/iu;
const ZCODE_AUTH_FAILURE_PATTERN =
  /unauthori[sz]ed|invalid[ _-]?(?:api[ _-]?key|token)|authentication|credential|api key|login|未登录|鉴权|认证|凭据/iu;
const ZCODE_TURN_FAILED_PREFIX = /^ZCode turn failed\b/iu;
const ZCODE_BACKEND_UNAVAILABLE_MESSAGE =
  "The ZCode CLI could not be started. Install the ZCode desktop app (it bundles the CLI) or set ZCODE_BIN to the zcode CLI path, then retry.";

function zcodeTurnFailureStatusCode(error: AcpErrors.AcpRequestError): number | undefined {
  const data = error.data;
  const raw = isRecord(data) ? data.statusCode : undefined;
  return typeof raw === "number" ? raw : typeof raw === "string" ? Number(raw) : undefined;
}

/**
 * The bridge's `session/new` is lazy: the real ZCode backend only spawns on
 * the first prompt, so missing CLIs and rejected credentials surface as
 * -32603 "ZCode turn failed: …" (data: statusCode/providerCode/reason).
 */
export function classifyZcodeFailure(
  error: AcpErrors.AcpError,
  spec: Pick<AcpAgentSpec, "signIn">,
): AcpAgentFailure | undefined {
  const text = acpAgentErrorText(error);
  if (ZCODE_BACKEND_UNAVAILABLE_PATTERN.test(text)) {
    return { reason: "backend_unavailable", message: ZCODE_BACKEND_UNAVAILABLE_MESSAGE };
  }
  if (error._tag !== "AcpRequestError") return undefined;
  // `authenticate` is the only startup request that answers -32000.
  if (error.code === -32000) {
    return {
      reason: "credentials_missing",
      message: `No ZCode credentials found. ${spec.signIn.hint}`,
    };
  }
  if (error.code === -32603 && ZCODE_TURN_FAILED_PREFIX.test(error.errorMessage)) {
    const statusCode = zcodeTurnFailureStatusCode(error);
    if (statusCode === 401 || statusCode === 403 || ZCODE_AUTH_FAILURE_PATTERN.test(text)) {
      return {
        reason: "credentials_missing",
        message: `ZCode rejected the request as unauthenticated. ${spec.signIn.hint}`,
      };
    }
  }
  return undefined;
}

/**
 * The ZCode bridge looks for Node with POSIX `which`, which a normal Windows host
 * lacks, and then tries to execute `zcode.cjs` itself (`spawn EFTYPE`). Its npm
 * shim already runs on the PATH's Node, so hand that one over.
 */
export function zcodeHostEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  isExecutable?: (candidate: string) => boolean,
): Readonly<Record<string, string>> {
  const backend = zcodeDesktopBackendEnvironment(env, platform);
  if (platform !== "win32" || env.ZCODE_NODE?.trim()) return backend;
  const directories = (env.PATH ?? env.Path ?? "")
    .split(";")
    .map((directory) => directory.trim())
    .filter(Boolean);
  const [directory] = directoriesContainingCommand("node.exe", directories, {
    env,
    platform,
    ...(isExecutable ? { isExecutable } : {}),
  });
  return directory
    ? { ...backend, ZCODE_NODE: nodePath.win32.join(directory, "node.exe") }
    : backend;
}

/**
 * The bridge only searches the desktop app's default folders; an app installed elsewhere
 * (found through its uninstall entry) is handed over as ZCODE_BIN. A person's own
 * ZCODE_BIN or `zcode` on PATH still wins.
 */
function zcodeDesktopBackendEnvironment(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): Readonly<Record<string, string>> {
  const script = knownAgentDesktopInstall("zcode")?.cliScript;
  if (!script || env.ZCODE_BIN?.trim() || commandExistsOnPath("zcode", { env, platform })) {
    return {};
  }
  return { ZCODE_BIN: script };
}

/** The ZCode app found in a custom folder (through its uninstall entry), if any. */
function knownZcodeDesktopScript(): ReadonlyArray<string> {
  const script = knownAgentDesktopInstall("zcode")?.cliScript;
  return script ? [script] : [];
}

function zcodeDesktopCliPaths(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): ReadonlyArray<string> {
  if (platform === "win32") {
    const localAppData =
      env.LOCALAPPDATA?.trim() ||
      (env.USERPROFILE?.trim()
        ? nodePath.win32.join(env.USERPROFILE.trim(), "AppData", "Local")
        : undefined);
    return [
      ...(localAppData
        ? [nodePath.win32.join(localAppData, "Programs", "ZCode", "resources", "glm", "zcode.cjs")]
        : []),
      ...knownZcodeDesktopScript(),
    ];
  }
  const home = env.HOME?.trim();
  return [
    "/Applications/ZCode.app/Contents/Resources/glm/zcode.cjs",
    ...(home
      ? [nodePath.posix.join(home, "Applications/ZCode.app/Contents/Resources/glm/zcode.cjs")]
      : []),
    "/opt/ZCode/resources/glm/zcode.cjs",
    "/usr/share/zcode/resources/glm/zcode.cjs",
    ...knownZcodeDesktopScript(),
  ];
}

/**
 * The npm bridge does not include the CLI it drives. This follows the bridge's own
 * search: `ZCODE_BIN`, then `zcode` on PATH, then the desktop app's usual folders.
 */
export function zcodeHostRequirement(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
  pathExists?: ProviderBinaryResolutionOptions["pathExists"],
): string | undefined {
  const lookup = { env, platform, ...(pathExists ? { pathExists } : {}) };
  const explicit = env.ZCODE_BIN?.trim();
  const found = explicit
    ? firstExistingPath([explicit], lookup) !== undefined || commandExistsOnPath(explicit, lookup)
    : commandExistsOnPath("zcode", lookup) ||
      firstExistingPath(zcodeDesktopCliPaths(env, platform), lookup) !== undefined;
  return found ? undefined : ZCODE_BACKEND_UNAVAILABLE_MESSAGE;
}

const ACP_AGENT_CLIENT_CAPABILITIES = { elicitation: { form: {} } } as const;

export const KIMI_ACP_AGENT_SPEC: AcpAgentSpec<"kimi"> = withMossManagedAcpAgentHooks({
  kind: "kimi",
  displayName: "Kimi Code",
  managedInstanceId: "kimi_moss",
  command: "kimi",
  args: ["acp"],
  versionProbeArgs: ["--version"],
  install: {
    npmPackageName: "@moonshot-ai/kimi-code",
    hint: "Install it with `npm install -g @moonshot-ai/kimi-code`.",
  },
  signIn: {
    command: "kimi login",
    hint: "Run `kimi login` in a terminal (with the same KIMI_CODE_HOME, if set) and retry.",
  },
  environmentDefaults: {},
  homeEnvironment: (homePath) => ({ KIMI_CODE_HOME: homePath }),
  hostRequirement: kimiHostRequirement,
  // Signed-out `session/new` answers -32000 "Authentication required"; its
  // `authenticate` only re-checks the same state, so there is nothing to call.
  auth: { policy: "on-demand" },
  clientCapabilities: ACP_AGENT_CLIENT_CAPABILITIES,
  modelConfigId: "model",
  thoughtLevelConfigId: "thinking",
  legacySetModel: true,
  // default (manual approvals), plan (read-only), auto, yolo.
  modes: { plan: ["plan"], implement: ["default"], approval: ["default"], never: ["auto", "yolo"] },
  turnIdleTimeoutEnvVar: "MOSS_KIMI_TURN_IDLE_TIMEOUT_MS",
  classifyFailure: classifyKimiFailure,
});

export const MINIMAX_ACP_AGENT_SPEC: AcpAgentSpec<"minimax"> = withMossManagedAcpAgentHooks({
  kind: "minimax",
  displayName: "MiniMax Code",
  managedInstanceId: "minimax_moss",
  command: "mcode",
  args: ["acp"],
  versionProbeArgs: ["--version"],
  install: {
    npmPackageName: "@minimax-ai/code",
    // Its native better-sqlite3 dependency needs install scripts (MiniMax README).
    npmInstallArgs: ["--allow-scripts=@minimax-ai/code,better-sqlite3"],
    hint: "Install it with `npm install -g @minimax-ai/code --allow-scripts=@minimax-ai/code,better-sqlite3`.",
  },
  signIn: {
    command: "mcode login",
    hint: "Run `mcode login` in a terminal (add --region cn or --region global if needed) and retry.",
  },
  environmentDefaults: {},
  homeEnvironment: (homePath) => ({ MINIMAX_DATA_DIR: homePath }),
  // Signed-out `session/new` answers -32000 "Authentication required: Run `mcode login`…".
  auth: { policy: "on-demand" },
  clientCapabilities: ACP_AGENT_CLIENT_CAPABILITIES,
  modelConfigId: "model",
  thoughtLevelConfigId: "thinkingEffort",
  legacySetModel: false,
  // default plus plan (only advertised when plan entry is enabled).
  modes: { plan: ["plan"], implement: ["default"], approval: ["default"], never: [] },
  // Process-wide `permissionMode` (default | auto | bypassPermissions).
  permissionConfig: { id: "permissionMode", value: "default" },
  turnIdleTimeoutEnvVar: "MOSS_MINIMAX_TURN_IDLE_TIMEOUT_MS",
  classifyFailure: classifySignedOutFailure,
});

export const ZCODE_ACP_AGENT_SPEC: AcpAgentSpec<"zcode"> = withMossManagedAcpAgentHooks({
  kind: "zcode",
  displayName: "ZCode",
  managedInstanceId: "zcode_moss",
  // The `zcode-acp-server` bin alias always speaks stdio ACP with no subcommand.
  command: "zcode-acp-server",
  args: [],
  versionProbeArgs: ["--version"],
  install: {
    npmPackageName: "zcode-acp-server",
    hint: "Install it with `npm install -g zcode-acp-server`; the ZCode desktop app provides the GLM CLI it drives.",
  },
  signIn: {
    command: "zcode-acp setup --provider bigmodel",
    hint: "Sign in to the ZCode desktop app, or run `zcode-acp setup --provider bigmodel` (or `--provider zai`) to save a GLM Coding Plan key, then retry.",
  },
  environmentDefaults: {
    // The bridge defaults to `yolo`; Moss maps its own modes explicitly below.
    ZCODE_ACP_MODE: "build",
    // Keep the turn-end status line out of the assistant transcript.
    ZCODE_ACP_SHOW_COMPLETION_STATUS: "0",
  },
  // The backend only honors a home whose basename is `.zcode`; anything else
  // silently keeps using the real `~/.zcode`.
  homeEnvironment: (homePath) => ({
    ZCODE_HOME:
      nodePath.basename(homePath) === ".zcode" ? homePath : nodePath.join(homePath, ".zcode"),
  }),
  hostEnvironment: zcodeHostEnvironment,
  hostRequirement: zcodeHostRequirement,
  // `session/new` never fails on auth, so probe credentials up front.
  auth: { policy: "upfront", methodId: "zcode-credentials" },
  clientCapabilities: ACP_AGENT_CLIENT_CAPABILITIES,
  modelConfigId: "model",
  thoughtLevelConfigId: "thought",
  legacySetModel: false,
  // plan, build, edit, guarded, yolo; guarded/yolo auto-approve.
  modes: { plan: ["plan"], implement: ["build"], approval: ["build"], never: ["yolo", "guarded"] },
  // initialize is instant and authenticate only reads credential files, but
  // the bridge may re-exec itself under Bun first.
  startupTimeouts: { initializeMs: 20_000, authenticateMs: 10_000 },
  turnIdleTimeoutEnvVar: "MOSS_ZCODE_TURN_IDLE_TIMEOUT_MS",
  classifyFailure: classifyZcodeFailure,
});

export const ACP_AGENT_SPECS = {
  kimi: KIMI_ACP_AGENT_SPEC,
  minimax: MINIMAX_ACP_AGENT_SPEC,
  zcode: ZCODE_ACP_AGENT_SPEC,
} as const satisfies { readonly [Kind in AcpAgentKind]: AcpAgentSpec<Kind> };

export const ACP_AGENT_KINDS = Object.keys(ACP_AGENT_SPECS) as ReadonlyArray<AcpAgentKind>;

export function isAcpAgentKind(value: unknown): value is AcpAgentKind {
  return typeof value === "string" && Object.hasOwn(ACP_AGENT_SPECS, value);
}
