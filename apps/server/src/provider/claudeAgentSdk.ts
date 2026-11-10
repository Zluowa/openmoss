// FILE: claudeAgentSdk.ts
// Purpose: Single memoized loader for the Claude Agent SDK runtime values.
// Layer: Provider shared helper
// Exports: ClaudeAgentSdkModule, loadClaudeAgentSdk

import { promises as fsPromises } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import nodePath from "node:path";
import { pathToFileURL } from "node:url";
import { selectClaudeHistoryPage, type ClaudeHistoryPage } from "./claudeHistoryPage.ts";
import { lazyModule } from "../lazyModule.ts";
import type {
  SDKSessionInfo,
  SessionMessage,
  SpawnOptions,
  SpawnedProcess,
} from "@anthropic-ai/claude-agent-sdk";
import { execProcessFile, spawnProcess } from "@moss/shared/processRuntime";
import { spawnGuardedProviderChild } from "../platform/windowsProviderProcessGuard.ts";
import type { ProcessExitHandle } from "./supervisedProcessTeardown.ts";
import {
  agentProgramSourceHome,
  type AgentProgramOwnership,
  type OwnedAgentProcess,
} from "./agentProgramOwnership.ts";

export type ClaudeOwnedProcess = SpawnedProcess & ProcessExitHandle & OwnedAgentProcess;

/** Shared native spawn boundary for chats, discovery and subscription probes. */
export function spawnOwnedClaudeCodeProcess(
  options: SpawnOptions,
  lowerPriority = false,
): ClaudeOwnedProcess {
  return spawnGuardedProviderChild(() =>
    spawnProcess(options.command, options.args, {
      lowerPriority,
      requireExecutable: true,
      ...(options.cwd ? { cwd: options.cwd } : {}),
      env: options.env,
      signal: options.signal,
      stdio: ["pipe", "pipe", "inherit"],
    }),
  ) as unknown as ClaudeOwnedProcess;
}

export type ClaudeAgentSdkModule = typeof import("@anthropic-ai/claude-agent-sdk");

/**
 * Loads `@anthropic-ai/claude-agent-sdk` on first use. Importing it eagerly
 * costs ~26ms on every server boot, including boots that never touch a Claude
 * session, so every consumer (adapter, health probe, thread import) shares this
 * one loader instead of a top-level import.
 *
 * Types must keep using `import type` — they are erased and cost nothing.
 */
export const loadClaudeAgentSdk: () => Promise<ClaudeAgentSdkModule> = lazyModule(
  () => import("@anthropic-ai/claude-agent-sdk"),
);

// The Claude agent SDK resolves its config dir from the process environment
// (HOME/CLAUDE_CONFIG_DIR). Imports for instances with a custom home must not
// mutate the server's process.env — concurrent health checks, text generation,
// or session startups would observe the wrong Claude account — so the session
// query runs in a short-lived child process that gets the custom environment.
const CLAUDE_SESSION_QUERY_SCRIPT = `const [moduleUrl, method, sessionId, optionsJson] = process.argv.slice(2);
const sdk = await import(moduleUrl);
const options = JSON.parse(optionsJson);
const selectPage = ${selectClaudeHistoryPage.toString()};
const result =
  method === "listSessions"
    ? await sdk.listSessions(options ?? undefined)
    : method === "getSessionMessagePage"
      ? selectPage(await sdk.getSessionMessages(sessionId, options?.dir ? { dir: options.dir } : undefined), options?.before)
    : await sdk[method](sessionId, options ?? undefined);
process.stdout.write(JSON.stringify(result ?? null));
`;

type ClaudeSessionQueryMethod =
  | "forkSession"
  | "getSessionInfo"
  | "getSessionMessages"
  | "listSessions"
  | "getSessionMessagePage";

export function claudeHistoricalSessionChildEnvironment(
  environment: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv {
  return environment;
}

async function runClaudeSessionQueryInChildProcess<T>(input: {
  readonly method: ClaudeSessionQueryMethod;
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly before?: string;
  readonly upToMessageId?: string;
  readonly assertStateBindingCurrent?: () => void;
  readonly runtimeProgram?: {
    readonly programs: AgentProgramOwnership;
    readonly binaryPath: string;
  };
}): Promise<T> {
  const moduleUrl = pathToFileURL(
    createRequire(import.meta.url).resolve("@anthropic-ai/claude-agent-sdk"),
  ).href;
  const scriptDir = await fsPromises.mkdtemp(nodePath.join(tmpdir(), "moss-claude-import-"));
  const scriptPath = nodePath.join(scriptDir, "claudeSessionQuery.mjs");
  try {
    await fsPromises.writeFile(scriptPath, CLAUDE_SESSION_QUERY_SCRIPT, "utf8");
    input.assertStateBindingCurrent?.();
    const stdout = await new Promise<string>((resolve, reject) => {
      const spawn = () =>
        execProcessFile(
          process.execPath,
          [
            scriptPath,
            moduleUrl,
            input.method,
            input.sessionId,
            JSON.stringify({
              ...(input.dir ? { dir: input.dir } : {}),
              ...(input.before ? { before: input.before } : {}),
              ...(input.upToMessageId ? { upToMessageId: input.upToMessageId } : {}),
            }),
          ],
          {
            env: claudeHistoricalSessionChildEnvironment(input.environment),
            maxBuffer: 64 * 1024 * 1024,
            timeout: 30_000,
            killSignal: "SIGKILL",
          },
          (error, childStdout, childStderr) => {
            if (error) {
              const detail = childStderr.toString().trim();
              reject(detail.length > 0 ? new Error(detail) : error);
              return;
            }
            resolve(childStdout.toString());
          },
        );
      if (input.runtimeProgram) {
        input.runtimeProgram.programs.spawn({
          binaryPath: input.runtimeProgram.binaryPath,
          env: input.environment,
          sourceHomePath: agentProgramSourceHome("claudeAgent", input.environment, process.cwd()),
          spawn,
        });
      } else {
        spawn();
      }
    });
    return JSON.parse(stdout) as T;
  } finally {
    await fsPromises.rm(scriptDir, { recursive: true, force: true }).catch(() => {});
  }
}

export function readClaudeSessionMessagePageInEnvironment(input: {
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly before?: string;
}): Promise<ClaudeHistoryPage> {
  return queryClaudeHistoricalSession<ClaudeHistoryPage>({
    method: "getSessionMessagePage",
    ...input,
  });
}

/** Lists one Claude account's sessions without touching the server's process.env. */
export function listClaudeSessionsInEnvironment(
  environment: NodeJS.ProcessEnv,
): Promise<ReadonlyArray<SDKSessionInfo>> {
  return runClaudeSessionQueryInChildProcess<ReadonlyArray<SDKSessionInfo>>({
    method: "listSessions",
    sessionId: "",
    dir: undefined,
    environment,
  });
}

/** Reads one Claude account's session messages, in a child process when needed. */
export function readClaudeSessionMessagesInEnvironment(input: {
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly assertStateBindingCurrent?: () => void;
}): Promise<ReadonlyArray<SessionMessage>> {
  return queryClaudeHistoricalSession<ReadonlyArray<SessionMessage>>({
    method: "getSessionMessages",
    ...input,
  });
}

/** Forks only the explicitly selected account's store, never the parent SDK store. */
export function forkClaudeSessionInEnvironment(input: {
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv;
  readonly upToMessageId?: string;
  readonly assertStateBindingCurrent?: () => void;
  readonly runtimeProgram: {
    readonly programs: AgentProgramOwnership;
    readonly binaryPath: string;
  };
}): Promise<{ sessionId: string }> {
  return runClaudeSessionQueryInChildProcess({ method: "forkSession", ...input });
}

export async function queryClaudeHistoricalSession<T>(input: {
  readonly method: Exclude<ClaudeSessionQueryMethod, "forkSession">;
  readonly sessionId: string;
  readonly dir: string | undefined;
  readonly environment: NodeJS.ProcessEnv | undefined;
  readonly before?: string;
  readonly assertStateBindingCurrent?: () => void;
}): Promise<T> {
  if (input.environment && Object.keys(input.environment).length > 0) {
    return runClaudeSessionQueryInChildProcess<T>({
      method: input.method,
      sessionId: input.sessionId,
      dir: input.dir,
      environment: input.environment,
      ...(input.before ? { before: input.before } : {}),
      ...(input.assertStateBindingCurrent
        ? { assertStateBindingCurrent: input.assertStateBindingCurrent }
        : {}),
    });
  }
  const options = input.dir ? { dir: input.dir } : undefined;
  const sdk = await loadClaudeAgentSdk();
  input.assertStateBindingCurrent?.();
  return (
    input.method === "listSessions"
      ? sdk.listSessions(options)
      : input.method === "getSessionInfo"
        ? sdk.getSessionInfo(input.sessionId, options)
        : input.method === "getSessionMessagePage"
          ? sdk
              .getSessionMessages(input.sessionId, options)
              .then((messages) => selectClaudeHistoryPage(messages, input.before))
          : sdk.getSessionMessages(input.sessionId, options)
  ) as Promise<T>;
}
