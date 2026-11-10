// FILE: providerInstall.ts
// Purpose: One-click install of agent CLIs into a Moss-managed folder, and the official page
//          for agents that cannot be installed unattended.
// Layer: Provider maintenance (server).
//
// The install never touches the person's own setup: npm runs with `--global --prefix` pointed
// at `<Moss home>/agents`, which needs no admin rights and leaves npm's own global prefix alone.
// That folder is appended to the server PATH, so the person's own installs still win.

import * as NodePath from "node:path";

import type {
  ProviderKind,
  ServerProviderInstallMode,
  ServerProviderInstallState,
} from "@moss/contracts";
import { envPathKeyFor, resolveExecutable } from "@moss/shared/executable";
import { isCommandOnPath } from "@moss/shared/localAgentExecutable";
import { mergePathEntries } from "@moss/shared/shell";
import { Effect, Option } from "effect";

import {
  KIMI_ACP_AGENT_SPEC,
  MINIMAX_ACP_AGENT_SPEC,
  ZCODE_ACP_AGENT_SPEC,
} from "./acp/AcpAgentSpec.ts";
import {
  applyProviderPackageChannelEnv,
  CN_NPM_MIRROR_REGISTRY,
  NPM_OFFICIAL_REGISTRY,
  type ProviderPackageChannel,
} from "./providerPackageChannel.ts";
import { resolveMossNodeRuntime } from "./agentInstallRuntime.ts";
import { parseGenericCliVersion } from "./providerMaintenance.ts";
import { runCursorWindowsInstall, supportsCursorWindowsInstall } from "./cursorWindowsInstall.ts";
import { managedAgentBinDirectory, managedAgentInstallPrefix } from "./managedAgentPaths.ts";

// Kept here for existing callers; the definitions live in a leaf module (see managedAgentPaths.ts).
export {
  appendManagedAgentBinDirectoryToPath,
  managedAgentBinDirectory,
  managedAgentInstallPrefix,
} from "./managedAgentPaths.ts";

/** An npm-published CLI Moss can install by itself. */
export interface OneClickAgentInstall {
  readonly packageName: string;
  /** Extra `npm install` flags the package needs, e.g. install-script allowlists. */
  readonly npmInstallArgs?: ReadonlyArray<string>;
  /** The command the package puts on PATH. */
  readonly command: string;
  readonly versionArgs: ReadonlyArray<string>;
  /** Where to send the person when Moss cannot run npm on this computer. */
  readonly officialPage: string;
}

/**
 * Agents whose CLI is a plain npm package. Codex and Claude Code also ship inside packaged
 * Moss, so this matters for them only in builds without the bundled runtime.
 */
export const ONE_CLICK_AGENT_INSTALLS: Partial<Record<ProviderKind, OneClickAgentInstall>> = {
  codex: {
    packageName: "@openai/codex",
    command: "codex",
    versionArgs: ["--version"],
    officialPage: "https://help.openai.com/en/articles/11096431",
  },
  claudeAgent: {
    packageName: "@anthropic-ai/claude-code",
    command: "claude",
    versionArgs: ["--version"],
    officialPage: "https://code.claude.com/docs/en/installation",
  },
  opencode: {
    packageName: "opencode-ai",
    command: "opencode",
    versionArgs: ["--version"],
    officialPage: "https://opencode.ai/docs/",
  },
  gemini: {
    packageName: "@google/gemini-cli",
    command: "gemini",
    versionArgs: ["--version"],
    officialPage: "https://github.com/google-gemini/gemini-cli",
  },
  kimi: {
    packageName: KIMI_ACP_AGENT_SPEC.install.npmPackageName,
    command: KIMI_ACP_AGENT_SPEC.command,
    versionArgs: KIMI_ACP_AGENT_SPEC.versionProbeArgs,
    officialPage: "https://www.kimi.com/code",
  },
  minimax: {
    packageName: MINIMAX_ACP_AGENT_SPEC.install.npmPackageName,
    ...(MINIMAX_ACP_AGENT_SPEC.install.npmInstallArgs
      ? { npmInstallArgs: MINIMAX_ACP_AGENT_SPEC.install.npmInstallArgs }
      : {}),
    command: MINIMAX_ACP_AGENT_SPEC.command,
    versionArgs: MINIMAX_ACP_AGENT_SPEC.versionProbeArgs,
    officialPage: "https://platform.minimax.io/docs/coding-plan",
  },
  zcode: {
    packageName: ZCODE_ACP_AGENT_SPEC.install.npmPackageName,
    command: ZCODE_ACP_AGENT_SPEC.command,
    versionArgs: ZCODE_ACP_AGENT_SPEC.versionProbeArgs,
    officialPage: "https://docs.bigmodel.cn/cn/coding-plan",
  },
  pi: {
    packageName: "@earendil-works/pi-coding-agent",
    command: "pi",
    versionArgs: ["--version"],
    officialPage: "https://pi.dev/docs/latest",
  },
};

/**
 * Agents with their own installer (native binaries, shell scripts, Python): the official
 * install page, opened in the system browser.
 */
export const EXTERNAL_AGENT_INSTALL_PAGES: Partial<Record<ProviderKind, string>> = {
  cursor: "https://docs.cursor.com/en/cli/installation",
  antigravity: "https://antigravity.google/docs/cli-using",
  grok: "https://docs.x.ai/build/overview",
  devin: "https://docs.devin.ai/cli",
  hermes: "https://hermes-agent.nousresearch.com",
  omp: "https://omp.sh/docs/quickstart",
};

export function providerInstallStrategy(
  provider: ProviderKind,
  platform: NodeJS.Platform = process.platform,
  architecture: string = process.arch,
): "npm" | "cursor-windows" | null {
  if (provider === "cursor" && supportsCursorWindowsInstall(platform, architecture))
    return "cursor-windows";
  return ONE_CLICK_AGENT_INSTALLS[provider] ? "npm" : null;
}

/** The one action behind the 安装 button for an agent that is not installed. */
export function resolveProviderInstallAction(
  provider: ProviderKind,
  options: {
    readonly npmAvailable?: boolean;
    readonly platform?: NodeJS.Platform;
    readonly architecture?: string;
  } = {},
): { readonly install: ServerProviderInstallMode; readonly installUrl?: string } | null {
  if (
    providerInstallStrategy(provider, options.platform, options.architecture) === "cursor-windows"
  ) {
    return { install: "oneClick" };
  }
  const oneClick = ONE_CLICK_AGENT_INSTALLS[provider];
  if (oneClick) {
    // Without the person's own npm, Moss runs npm on its own runtime.
    const npmAvailable =
      options.npmAvailable ?? (isCommandOnPath("npm") || resolveMossNodeRuntime() !== null);
    return npmAvailable
      ? { install: "oneClick" }
      : { install: "externalPage", installUrl: oneClick.officialPage };
  }
  const page = EXTERNAL_AGENT_INSTALL_PAGES[provider];
  return page ? { install: "externalPage", installUrl: page } : null;
}

/** Mainland first from the mirror, everyone else from npm; each falls back to the other. */
export function agentInstallRegistries(
  channel: ProviderPackageChannel | undefined,
): ReadonlyArray<{ readonly source: "cn-mirror" | "official"; readonly registry: string }> {
  const mirror = { source: "cn-mirror" as const, registry: CN_NPM_MIRROR_REGISTRY };
  const official = { source: "official" as const, registry: NPM_OFFICIAL_REGISTRY };
  return channel === "cn-mirror" ? [mirror, official] : [official, mirror];
}

export function buildAgentInstallArgs(input: {
  readonly install: OneClickAgentInstall;
  readonly prefix: string;
  readonly registry: string;
}): ReadonlyArray<string> {
  return [
    "install",
    "--global",
    "--prefix",
    input.prefix,
    `--registry=${input.registry}`,
    "--no-audit",
    "--no-fund",
    "--loglevel=error",
    ...(input.install.npmInstallArgs ?? []),
    `${input.install.packageName}@latest`,
  ];
}

export interface AgentInstallCommandResult {
  readonly exitCode: number;
  readonly stdout: string;
  readonly stderr: string;
}

/** Runs one command; `None` means it hit the timeout and was stopped. */
export type AgentInstallCommandRunner = (input: {
  readonly command: string;
  readonly args: ReadonlyArray<string>;
  readonly env: NodeJS.ProcessEnv;
}) => Effect.Effect<Option.Option<AgentInstallCommandResult>, unknown>;

export type AgentInstallFailureReason = NonNullable<ServerProviderInstallState["reason"]>;

export type AgentInstallOutcome =
  | {
      readonly ok: true;
      readonly version: string;
      readonly source: "cn-mirror" | "official";
      readonly binDirectory: string;
    }
  | {
      readonly ok: false;
      readonly reason: AgentInstallFailureReason;
      /** Short diagnostic for the server log only; never shown to a person. */
      readonly detail: string;
    };

function lastOutputLine(result: AgentInstallCommandResult): string {
  const lines = `${result.stderr}\n${result.stdout}`
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean);
  return (lines.at(-1) ?? `exit ${result.exitCode}`).slice(0, 300);
}

/**
 * Installs `provider` with npm into the Moss-managed prefix, trying the registry for the
 * person's region first and the other one second, then proves the installed command runs.
 */
export const runOneClickAgentInstall = Effect.fn("runOneClickAgentInstall")(function* (input: {
  readonly provider: ProviderKind;
  readonly mossHomeDir: string;
  readonly channel: ProviderPackageChannel | undefined;
  readonly env: NodeJS.ProcessEnv;
  readonly platform?: NodeJS.Platform;
  readonly architecture?: string;
  /** Resolved npm; undefined looks it up on the env's PATH. */
  readonly npmExecutable?: string | null;
  /**
   * npm run some other way (Moss's own runtime and the npm it fetched): the command, the
   * arguments before npm's own, and environment it needs. Wins over `npmExecutable`.
   */
  readonly npmCommand?: {
    readonly command: string;
    readonly prefixArgs: ReadonlyArray<string>;
    readonly env: Readonly<Record<string, string>>;
  };
  readonly run: AgentInstallCommandRunner;
  readonly onCleanupUnproven?: Effect.Effect<void>;
  readonly onProgress?: (progress: {
    readonly phase: "installing" | "verifying";
    readonly source: "cn-mirror" | "official";
  }) => Effect.Effect<void>;
}) {
  if (
    providerInstallStrategy(input.provider, input.platform, input.architecture) === "cursor-windows"
  ) {
    return yield* runCursorWindowsInstall({
      mossHomeDir: input.mossHomeDir,
      env: input.env,
      ...(input.onProgress ? { onProgress: input.onProgress } : {}),
      ...(input.onCleanupUnproven ? { onCleanupUnproven: input.onCleanupUnproven } : {}),
    });
  }
  const install = ONE_CLICK_AGENT_INSTALLS[input.provider];
  if (!install) {
    return {
      ok: false,
      reason: "not-installable",
      detail: `${input.provider} has no one-click install.`,
    } satisfies AgentInstallOutcome as AgentInstallOutcome;
  }
  const platform = input.platform ?? process.platform;
  const npm =
    input.npmCommand?.command ??
    (input.npmExecutable === undefined
      ? resolveExecutable("npm", { env: input.env, platform })
      : input.npmExecutable);
  if (!npm) {
    return {
      ok: false,
      reason: "npm-unavailable",
      detail: "npm is not on PATH.",
    } satisfies AgentInstallOutcome as AgentInstallOutcome;
  }
  const prefix = managedAgentInstallPrefix(input.mossHomeDir);
  const binDirectory = managedAgentBinDirectory(prefix, platform);
  const pathKey = envPathKeyFor(input.env, platform);
  const quietEnv: NodeJS.ProcessEnv = {
    ...input.env,
    ...input.npmCommand?.env,
    // A package's install script that runs `node` finds Moss's `node` shim there.
    ...(input.npmCommand
      ? { [pathKey]: mergePathEntries(input.env[pathKey], binDirectory, platform) ?? binDirectory }
      : {}),
    npm_config_update_notifier: "false",
    npm_config_fund: "false",
    npm_config_audit: "false",
  };

  let failure: AgentInstallOutcome | null = null;
  for (const { source, registry } of agentInstallRegistries(input.channel)) {
    yield* input.onProgress?.({ phase: "installing", source }) ?? Effect.void;
    const result = yield* input
      .run({
        command: npm,
        args: [
          ...(input.npmCommand?.prefixArgs ?? []),
          ...buildAgentInstallArgs({ install, prefix, registry }),
        ],
        // The mirror env also points native-addon downloads (better-sqlite3) at the mirror.
        env: applyProviderPackageChannelEnv(
          quietEnv,
          source === "cn-mirror" ? "cn-mirror" : "official",
        ),
      })
      .pipe(Effect.result);
    if (result._tag === "Failure") {
      failure = { ok: false, reason: "download-failed", detail: String(result.failure) };
      continue;
    }
    if (Option.isNone(result.success)) {
      failure = { ok: false, reason: "timed-out", detail: `npm timed out on ${registry}.` };
      continue;
    }
    if (result.success.value.exitCode !== 0) {
      failure = {
        ok: false,
        reason: "download-failed",
        detail: `npm on ${registry}: ${lastOutputLine(result.success.value)}`,
      };
      continue;
    }

    yield* input.onProgress?.({ phase: "verifying", source }) ?? Effect.void;
    const verifyEnv: NodeJS.ProcessEnv = {
      ...input.env,
      [pathKey]: mergePathEntries(binDirectory, input.env[pathKey], platform) ?? binDirectory,
    };
    const installed = resolveExecutable(install.command, { env: verifyEnv, platform });
    const verify =
      installed && NodePath.dirname(installed) === binDirectory
        ? yield* input
            .run({ command: installed, args: install.versionArgs, env: verifyEnv })
            .pipe(Effect.result)
        : null;
    const verified =
      verify && verify._tag === "Success" && Option.isSome(verify.success)
        ? verify.success.value
        : null;
    const version =
      verified && verified.exitCode === 0
        ? parseGenericCliVersion(`${verified.stdout}\n${verified.stderr}`)
        : null;
    if (!version) {
      return {
        ok: false,
        reason: "verify-failed",
        detail: installed
          ? `${install.command} did not report a version after install.`
          : `${install.command} was not found in ${binDirectory} after install.`,
      } satisfies AgentInstallOutcome as AgentInstallOutcome;
    }
    return {
      ok: true,
      version,
      source,
      binDirectory,
    } satisfies AgentInstallOutcome as AgentInstallOutcome;
  }
  return (
    failure ?? ({ ok: false, reason: "download-failed", detail: "No registry was tried." } as const)
  );
});
