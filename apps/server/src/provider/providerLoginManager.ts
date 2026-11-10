// FILE: providerLoginManager.ts
// Purpose: Owns single-flight, cancellable provider OAuth CLI processes.
// Layer: Provider infrastructure used by ProviderHealth.

import type { ChildProcess } from "node:child_process";
import { stat } from "node:fs/promises";

import type { ProviderInstanceId } from "@moss/contracts";
import {
  MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
  MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
} from "@moss/shared/mossProductionPublicConfig";
import { spawnProcess } from "@moss/shared/processRuntime";
import { prepareProcess, processArgumentsForPty } from "@moss/shared/platformProcess";
import { embeddedTerminalName } from "@moss/shared/platformEnvironment";
import { signalOwnedChildProcess, closeProviderLoginPty } from "../platform/processTreeController";
import {
  AgentProgramOwnershipError,
  agentProgramSourceHome,
  makeAgentProgramOwnership,
  type AgentProgramOwnership,
} from "./agentProgramOwnership.ts";

import {
  CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS,
  CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS,
  CLAUDE_EXTERNAL_AUTH_ENV_KEYS,
} from "./claudeProcessEnv.ts";

export type ProviderLoginDriver = "codex" | "claudeAgent";

export interface ProviderLoginTarget {
  readonly provider: ProviderLoginDriver;
  readonly instanceId: ProviderInstanceId;
  readonly executable: string;
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
  /** Server-verified shared source for the program epoch; never changes login writes. */
  readonly programSourceHomePath?: string;
  /** Internal server binding check; not accepted by a public RPC schema. */
  readonly assertStateBindingCurrent?: () => void;
  /**
   * The agent's own credential files. When one appears or changes the sign-in is done,
   * even if the CLI lingers (waiting on a browser tab, a key press): it is stopped and
   * the sign-in reports success for the health check to confirm. Only file metadata is
   * read, never the contents.
   */
  readonly credentialPaths?: ReadonlyArray<string>;
}

export type ProviderLoginCompletion =
  | { readonly status: "succeeded" }
  | { readonly status: "failed"; readonly message: string }
  | { readonly status: "cancelled" };

export interface ProviderLoginProcess {
  readonly completion: Promise<ProviderLoginCompletion>;
  readonly cancel: () => void;
}

export interface ProviderLoginHandle {
  readonly completion: Promise<ProviderLoginCompletion>;
}

export interface ProviderLoginProcessRunnerInput extends ProviderLoginTarget {
  readonly args: ReadonlyArray<string>;
}

export type ProviderLoginProcessRunner = (
  input: ProviderLoginProcessRunnerInput,
) => ProviderLoginProcess;

export interface ProviderLoginManagerDependencies {
  readonly runtimePrograms?: (provider: ProviderLoginDriver) => AgentProgramOwnership;
  readonly runCodex?: ProviderLoginProcessRunner;
  readonly runClaude?: ProviderLoginProcessRunner;
  /** Test seams for the credential watch. */
  readonly credentialFingerprint?: (paths: ReadonlyArray<string>) => Promise<string> | string;
  readonly credentialPollMs?: number;
  readonly credentialExitGraceMs?: number;
}

interface ActiveProviderLogin {
  readonly cancel: () => void;
  cancelRequested: boolean;
}

const CREDENTIAL_POLL_MS = 1_000;
// After the credential lands, the CLI usually prints a line and exits on its own.
const CREDENTIAL_EXIT_GRACE_MS = 3_000;

/** Size and modification time of each credential file; never the contents. */
export async function credentialFilesFingerprint(paths: ReadonlyArray<string>): Promise<string> {
  const parts = await Promise.all(
    paths.map(async (path) => {
      try {
        const stats = await stat(path);
        return stats.isFile() ? `${stats.size}:${stats.mtimeMs}` : "-";
      } catch {
        return "-";
      }
    }),
  );
  return parts.join("|");
}

const CODEX_LOGIN_ARGS = ["login", "-c", 'cli_auth_credentials_store="file"'] as const;
const CLAUDE_LOGIN_ARGS = ["auth", "login", "--claudeai"] as const;

// Moss relay credentials are deliberately server-only. Keep this list explicit
// so a new non-secret MOSS_* process-control variable is not accidentally lost.
const MOSS_SERVER_ONLY_LOGIN_ENV_KEYS = [
  "MOSS_ACCESS_TOKEN",
  "MOSS_BYOK_API_KEY",
  "MOSS_MODEL_GATEWAY_API_KEY",
  "MOSS_MODEL_GATEWAY_CLAUDE_API_KEY",
  "MOSS_SUPABASE_ANON_KEY",
  "MOSS_SUPABASE_PUBLISHABLE_KEY",
  ...MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
  ...MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
] as const;

const CODEX_DIRECT_CREDENTIAL_ENV_KEYS = [
  "OPENAI_API_KEY",
  "OPENAI_ACCESS_TOKEN",
  "OPENAI_ORG_ID",
  "OPENAI_ORGANIZATION",
  "OPENAI_PROJECT_ID",
  "OPENAI_BASE_URL",
  "AZURE_OPENAI_API_KEY",
  "AZURE_OPENAI_ENDPOINT",
  "CODEX_API_KEY",
  "CODEX_ACCESS_TOKEN",
  "CODEX_REFRESH_TOKEN",
] as const;

function copyDefinedEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const result: NodeJS.ProcessEnv = {};
  for (const [key, value] of Object.entries(environment)) {
    if (typeof value === "string") {
      result[key] = value;
    }
  }
  return result;
}

function stripAnsiControlSequences(value: string): string {
  let result = "";
  for (let index = 0; index < value.length; index += 1) {
    if (value.codePointAt(index) !== 0x1b || value[index + 1] !== "[") {
      result += value[index];
      continue;
    }
    index += 2;
    while (index < value.length) {
      const codePoint = value.codePointAt(index) ?? 0;
      if (codePoint >= 0x40 && codePoint <= 0x7e) break;
      index += 1;
    }
  }
  return result;
}

function isCredentialEnvironmentName(name: string): boolean {
  return /(?:^|_)(?:API_?KEY|ACCESS_?TOKEN|AUTH_?TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?|PRIVATE_?KEY)(?:_|$)/iu.test(
    name,
  );
}

/**
 * Removes every direct request credential/routing override from an OAuth
 * subprocess. Provider-instance HOME/CODEX_HOME routing is retained, but Moss
 * gateway keys and API-key auth can never be mistaken for an official login.
 */
export function sanitizeProviderLoginEnvironment(
  provider: ProviderLoginDriver,
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  const result = copyDefinedEnvironment(environment);
  const keysToDelete = new Set<string>(MOSS_SERVER_ONLY_LOGIN_ENV_KEYS);
  if (provider === "codex") {
    for (const key of CODEX_DIRECT_CREDENTIAL_ENV_KEYS) keysToDelete.add(key);
  } else {
    for (const key of CLAUDE_ACCOUNT_ISOLATION_ENV_KEYS) keysToDelete.add(key);
    for (const key of CLAUDE_DIRECT_CREDENTIAL_ENV_KEYS) keysToDelete.add(key);
    for (const key of CLAUDE_EXTERNAL_AUTH_ENV_KEYS) keysToDelete.add(key);
  }
  for (const key of keysToDelete) {
    delete result[key];
  }
  for (const key of Object.keys(result)) {
    if (isCredentialEnvironmentName(key)) delete result[key];
  }
  return result;
}

export function buildCodexLoginEnvironment(input: {
  readonly environment: NodeJS.ProcessEnv;
  readonly authoritativeAuthHomePath: string;
}): NodeJS.ProcessEnv {
  return {
    ...sanitizeProviderLoginEnvironment("codex", input.environment),
    CODEX_HOME: input.authoritativeAuthHomePath,
    CODEX_SQLITE_HOME: input.authoritativeAuthHomePath,
  };
}

export function buildClaudeLoginEnvironment(environment: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  return sanitizeProviderLoginEnvironment("claudeAgent", environment);
}

function providerLoginKey(input: {
  readonly provider: ProviderLoginDriver;
  readonly instanceId: ProviderInstanceId;
}): string {
  return `${input.provider}\u0000${input.instanceId}`;
}

function makeChildProcessLoginRunner(programs: AgentProgramOwnership): ProviderLoginProcessRunner {
  return (input) => {
    let child: ChildProcess | null = null;
    let cancelRequested = false;
    const completion = new Promise<ProviderLoginCompletion>((resolve) => {
      try {
        child = programs.spawn({
          binaryPath: input.executable,
          cwd: input.cwd,
          env: input.env,
          sourceHomePath:
            input.programSourceHomePath ?? agentProgramSourceHome("codex", input.env, input.cwd),
          spawn: () =>
            spawnProcess(input.executable, input.args, {
              cwd: input.cwd,
              env: copyDefinedEnvironment(input.env),
              stdio: "ignore",
            }),
        });
      } catch (cause) {
        resolve({
          status: "failed",
          message:
            cause instanceof AgentProgramOwnershipError
              ? cause.message
              : "Codex sign-in could not be started.",
        });
        return;
      }
      child.once("error", () => {
        resolve(
          cancelRequested
            ? { status: "cancelled" }
            : { status: "failed", message: "Codex sign-in could not be started." },
        );
      });
      child.once("exit", (code) => {
        if (cancelRequested) {
          resolve({ status: "cancelled" });
          return;
        }
        resolve(
          code === 0
            ? { status: "succeeded" }
            : {
                status: "failed",
                message: `Codex sign-in exited with code ${code ?? "unknown"}.`,
              },
        );
      });
    });
    return {
      completion,
      cancel: () => {
        cancelRequested = true;
        // On Windows this ends the whole tree (`.cmd` shim, node, the CLI) with taskkill.
        if (child) signalOwnedChildProcess(child, "SIGTERM");
      },
    };
  };
}

function makeNodePtyLoginRunner(programs: AgentProgramOwnership): ProviderLoginProcessRunner {
  return (input) => {
    let ptyProcess: import("node-pty").IPty | null = null;
    let cancelRequested = false;
    const completion = import("node-pty")
      .then(
        (nodePty) =>
          new Promise<ProviderLoginCompletion>((resolve) => {
            if (cancelRequested) {
              resolve({ status: "cancelled" });
              return;
            }
            try {
              input.assertStateBindingCurrent?.();
            } catch (cause) {
              resolve({
                status: "failed",
                message:
                  cause instanceof Error
                    ? cause.message
                    : "Claude 账户绑定已失效，请重新选择账户。",
              });
              return;
            }
            let operation: ReturnType<AgentProgramOwnership["beginOperation"]> | undefined;
            try {
              operation = programs.beginOperation({
                binaryPath: input.executable,
                cwd: input.cwd,
                env: input.env,
                sourceHomePath: agentProgramSourceHome("claudeAgent", input.env, input.cwd),
              });
              const prepared = prepareProcess(input.executable, input.args, {
                env: input.env,
                cwd: input.cwd,
              });
              ptyProcess = nodePty.spawn(prepared.command, processArgumentsForPty(prepared), {
                cwd: input.cwd,
                cols: 100,
                rows: 30,
                env: copyDefinedEnvironment(input.env) as Record<string, string>,
                name: embeddedTerminalName(),
              });
              operation.spawned();
              ptyProcess.onData(
                createClaudeBrowserPromptResponder((data) => ptyProcess?.write(data)),
              );
            } catch (cause) {
              if (!ptyProcess) operation?.failedToSpawn();
              resolve({
                status: "failed",
                message:
                  cause instanceof AgentProgramOwnershipError
                    ? cause.message
                    : "Claude sign-in could not be started.",
              });
              return;
            }
            ptyProcess.onExit(({ exitCode }) => {
              // PTY completion is its native lifecycle event, not Node's close.
              operation?.complete();
              if (cancelRequested) {
                resolve({ status: "cancelled" });
                return;
              }
              resolve(
                exitCode === 0
                  ? { status: "succeeded" }
                  : {
                      status: "failed",
                      message: `Claude sign-in exited with code ${exitCode}.`,
                    },
              );
            });
          }),
      )
      .catch(
        (): ProviderLoginCompletion => ({
          status: "failed",
          message: "Claude sign-in could not load its terminal support.",
        }),
      );
    return {
      completion,
      cancel: () => {
        cancelRequested = true;
        const pty = ptyProcess;
        if (!pty) return;
        closeProviderLoginPty(pty);
      },
    };
  };
}

/**
 * Claude's interactive login waits for an Enter key before opening claude.ai.
 * Keep only a short in-memory prompt tail, submit once, and never expose PTY
 * output (which may later contain authorization details) to logs or callers.
 */
export function createClaudeBrowserPromptResponder(write: (data: string) => void) {
  let promptTail = "";
  let submitted = false;
  return (data: string): void => {
    if (submitted) return;
    const withoutAnsi = stripAnsiControlSequences(data);
    promptTail = `${promptTail}${withoutAnsi}`.slice(-2_048);
    if (!/press\s+(?:enter|return)\s+to\s+open[\s\S]{0,160}browser/iu.test(promptTail)) {
      return;
    }
    submitted = true;
    promptTail = "";
    write("\r");
  };
}

export class ProviderLoginAlreadyRunningError extends Error {
  override readonly name = "ProviderLoginAlreadyRunningError";
}

export class ProviderLoginNotRunningError extends Error {
  override readonly name = "ProviderLoginNotRunningError";
}

export interface ProviderLoginManager {
  readonly start: (target: ProviderLoginTarget) => ProviderLoginHandle;
  readonly cancel: (target: Pick<ProviderLoginTarget, "provider" | "instanceId">) => void;
  readonly isRunning: (target: Pick<ProviderLoginTarget, "provider" | "instanceId">) => boolean;
  readonly hasRunning: () => boolean;
  readonly cancelAll: () => void;
}

export function makeProviderLoginManager(
  dependencies: ProviderLoginManagerDependencies = {},
): ProviderLoginManager {
  const active = new Map<string, ActiveProviderLogin>();
  const programs =
    dependencies.runtimePrograms ??
    ((provider: ProviderLoginDriver) => makeAgentProgramOwnership(provider));
  const codexPrograms = programs("codex");
  const claudePrograms = programs("claudeAgent");
  const runCodex = dependencies.runCodex ?? makeChildProcessLoginRunner(codexPrograms);
  const runClaude = dependencies.runClaude ?? makeNodePtyLoginRunner(claudePrograms);
  const fingerprint = dependencies.credentialFingerprint ?? credentialFilesFingerprint;
  const pollMs = dependencies.credentialPollMs ?? CREDENTIAL_POLL_MS;
  const exitGraceMs = dependencies.credentialExitGraceMs ?? CREDENTIAL_EXIT_GRACE_MS;

  return {
    start(target) {
      const key = providerLoginKey(target);
      if (active.size > 0) {
        throw new ProviderLoginAlreadyRunningError("Another provider sign-in is already running.");
      }
      target.assertStateBindingCurrent?.();
      (target.provider === "codex" ? codexPrograms : claudePrograms).assertCompatible({
        binaryPath: target.executable,
        cwd: target.cwd,
        env: target.env,
        sourceHomePath:
          target.programSourceHomePath ??
          agentProgramSourceHome(target.provider, target.env, target.cwd),
      });
      const loginProcess = (target.provider === "codex" ? runCodex : runClaude)({
        ...target,
        args: target.provider === "codex" ? CODEX_LOGIN_ARGS : CLAUDE_LOGIN_ARGS,
      });
      const activeLogin: ActiveProviderLogin = {
        cancel: loginProcess.cancel,
        cancelRequested: false,
      };
      active.set(key, activeLogin);

      // Watch the agent's own credential store: a new or rewritten credential file means
      // the browser sign-in finished, whatever the CLI does next.
      let credentialSeen = false;
      let watchTimer: ReturnType<typeof setInterval> | undefined;
      const credentialDone = new Promise<ProviderLoginCompletion>((resolve) => {
        const paths = target.credentialPaths ?? [];
        if (paths.length === 0) return;
        // Taken before the browser could have finished, so a credential that appears or
        // changes afterwards belongs to this sign-in.
        const initial = Promise.resolve(fingerprint(paths)).catch(() => "");
        let seenAt: number | null = null;
        let polling = false;
        const poll = async () => {
          if (seenAt === null) {
            if ((await fingerprint(paths)) === (await initial)) return;
            seenAt = Date.now();
            credentialSeen = true;
          }
          if (Date.now() - seenAt < exitGraceMs) return;
          clearInterval(timer);
          // The CLI did not exit on its own: stop it, the sign-in itself is done.
          loginProcess.cancel();
          resolve({ status: "succeeded" });
        };
        const timer = setInterval(() => {
          if (activeLogin.cancelRequested || polling) return;
          polling = true;
          void poll()
            .catch(() => undefined)
            .finally(() => {
              polling = false;
            });
        }, pollMs);
        timer.unref?.();
        watchTimer = timer;
      });

      const completion = Promise.race([
        loginProcess.completion.then((result): ProviderLoginCompletion => {
          if (activeLogin.cancelRequested) return { status: "cancelled" };
          // A CLI that wrote its credential and then failed on the way out still signed
          // in; the health check that follows has the final word.
          return credentialSeen && result.status === "failed" ? { status: "succeeded" } : result;
        }),
        credentialDone,
      ]).finally(() => {
        clearInterval(watchTimer);
        if (active.get(key) === activeLogin) active.delete(key);
      });
      return { completion };
    },

    cancel(target) {
      const key = providerLoginKey(target);
      const running = active.get(key);
      if (!running) {
        throw new ProviderLoginNotRunningError("No sign-in is running for this provider account.");
      }
      running.cancelRequested = true;
      running.cancel();
    },

    isRunning(target) {
      return active.has(providerLoginKey(target));
    },

    hasRunning() {
      return active.size > 0;
    },

    cancelAll() {
      for (const running of active.values()) {
        running.cancelRequested = true;
        running.cancel();
      }
    },
  };
}
