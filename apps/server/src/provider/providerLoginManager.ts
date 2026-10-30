// FILE: providerLoginManager.ts
// Purpose: Owns single-flight, cancellable provider OAuth CLI processes.
// Layer: Provider infrastructure used by ProviderHealth.

import type { ChildProcess } from "node:child_process";

import type { ProviderInstanceId } from "@synara/contracts";
import {
  MOSS_LEGACY_PRODUCTION_PUBLIC_CONFIG_KEYS,
  MOSS_PRODUCTION_PUBLIC_CONFIG_ENV_KEYS,
} from "@synara/shared/mossProductionPublicConfig";
import { spawnProcess } from "@synara/shared/processRuntime";
import { prepareProcess } from "@synara/shared/platformProcess";
import { embeddedTerminalName } from "@synara/shared/platformEnvironment";
import { signalOwnedChildProcess } from "../platform/processTreeController";

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
  readonly runCodex?: ProviderLoginProcessRunner;
  readonly runClaude?: ProviderLoginProcessRunner;
}

interface ActiveProviderLogin {
  readonly cancel: () => void;
  cancelRequested: boolean;
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

function makeChildProcessLoginRunner(): ProviderLoginProcessRunner {
  return (input) => {
    let child: ChildProcess | null = null;
    let cancelRequested = false;
    const completion = new Promise<ProviderLoginCompletion>((resolve) => {
      try {
        child = spawnProcess(input.executable, input.args, {
          cwd: input.cwd,
          env: copyDefinedEnvironment(input.env),
          stdio: "ignore",
        });
      } catch {
        resolve({
          status: "failed",
          message: "Codex sign-in could not be started.",
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
        if (child) signalOwnedChildProcess(child, "SIGTERM");
      },
    };
  };
}

function makeNodePtyLoginRunner(): ProviderLoginProcessRunner {
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
              const prepared = prepareProcess(input.executable, input.args, {
                env: input.env,
                cwd: input.cwd,
              });
              ptyProcess = nodePty.spawn(prepared.command, prepared.args, {
                cwd: input.cwd,
                cols: 100,
                rows: 30,
                env: copyDefinedEnvironment(input.env) as Record<string, string>,
                name: embeddedTerminalName(),
              });
              ptyProcess.onData(
                createClaudeBrowserPromptResponder((data) => ptyProcess?.write(data)),
              );
            } catch {
              resolve({
                status: "failed",
                message: "Claude sign-in could not be started.",
              });
              return;
            }
            ptyProcess.onExit(({ exitCode }) => {
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
        ptyProcess?.kill();
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
  const runCodex = dependencies.runCodex ?? makeChildProcessLoginRunner();
  const runClaude = dependencies.runClaude ?? makeNodePtyLoginRunner();

  return {
    start(target) {
      const key = providerLoginKey(target);
      if (active.size > 0) {
        throw new ProviderLoginAlreadyRunningError("Another provider sign-in is already running.");
      }
      const process = (target.provider === "codex" ? runCodex : runClaude)({
        ...target,
        args: target.provider === "codex" ? CODEX_LOGIN_ARGS : CLAUDE_LOGIN_ARGS,
      });
      const activeLogin: ActiveProviderLogin = {
        cancel: process.cancel,
        cancelRequested: false,
      };
      active.set(key, activeLogin);
      const completion = process.completion
        .then(
          (result): ProviderLoginCompletion =>
            activeLogin.cancelRequested ? { status: "cancelled" } : result,
        )
        .finally(() => {
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
