// FILE: agentProgramOwnership.ts
// Purpose: Keeps one program epoch per provider/native source for a server lifetime.
// Layer: Provider process ownership; no persistent locks or external-process ownership.

import path from "node:path";
import { executableIdentity, resolveExecutable } from "@moss/shared/executable";
import { Effect, Exit } from "effect";
import { resolveCodexPathIdentity } from "../codexPathIdentity.ts";

type AgentProvider = "codex" | "claudeAgent";
export class AgentProgramOwnershipError extends Error {}
export interface OwnedAgentProcess {
  once(event: "close", listener: () => void): unknown;
}
interface ProgramInput {
  readonly binaryPath: string;
  readonly sourceHomePath: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly cwd?: string;
}
interface ProgramRecord {
  readonly binaryPath: string;
  readonly program: string;
  readonly owners: Set<symbol>;
  committed: boolean;
}

export function agentProgramSourceHome(
  provider: AgentProvider,
  env: NodeJS.ProcessEnv,
  fallbackHome: string,
): string {
  return provider === "codex"
    ? (env.CODEX_SQLITE_HOME ??
        env.CODEX_HOME ??
        path.join(env.HOME ?? env.USERPROFILE ?? fallbackHome, ".codex"))
    : (env.CLAUDE_CONFIG_DIR ?? path.join(env.HOME ?? env.USERPROFILE ?? fallbackHome, ".claude"));
}

export function agentProgramRestartMessage(provider: AgentProvider): string {
  return provider === "codex"
    ? "The Codex program changed. Restart Moss to apply it; accounts and history are preserved."
    : "The Claude program changed. Restart Moss to apply it; accounts and history are preserved.";
}

/** Every layer of one server receives this same ServerConfig object. */
const serverPrograms = new WeakMap<object, Map<AgentProvider, AgentProgramOwnership>>();
export function agentProgramsForServer(serverScope: object, provider: AgentProvider) {
  let providers = serverPrograms.get(serverScope);
  if (!providers) serverPrograms.set(serverScope, (providers = new Map()));
  let programs = providers.get(provider);
  if (!programs) providers.set(provider, (programs = makeAgentProgramOwnership(provider)));
  return programs;
}

export type AgentProgramOwnership = ReturnType<typeof makeAgentProgramOwnership>;

/**
 * Epochs survive close: changing programs requires restarting this server, even
 * for Effect/PTY entry points without Node's close event. Owners only protect
 * explicit updates. Native owners release at close; operations release after
 * their existing full exit/output collection succeeds. An interrupted operation
 * whose exit remains unconfirmed stays busy until restart.
 */
export function makeAgentProgramOwnership(provider: AgentProvider) {
  const sources = new Map<string, ProgramRecord>();
  const maintenance = new Set<string>();
  const changedPrograms = new Set<string>();
  const programPath = (binaryPath: string) => resolveCodexPathIdentity(binaryPath);
  const busyMessage = () =>
    provider === "codex"
      ? "Codex is still in use or its exit is unconfirmed. Finish running work, or restart Moss, before updating."
      : "Claude is still in use or its exit is unconfirmed. Finish running work, or restart Moss, before updating.";
  const beginSourceOperation = (input: ProgramInput) => {
    // Installed programs must already have been resolved by the shared resolver.
    // A runnable bare command here could be reinterpreted by an account's PATH.
    // Missing commands can reach the normal ENOENT path, but still get an epoch.
    if (
      !path.isAbsolute(input.binaryPath) &&
      resolveExecutable(input.binaryPath, {
        env: input.env,
        ...(input.cwd ? { cwd: input.cwd } : {}),
      })
    ) {
      throw new AgentProgramOwnershipError(
        "Select an absolute agent program path in Settings, then restart Moss.",
      );
    }
    const binaryPath = programPath(input.binaryPath);
    if (maintenance.has(binaryPath)) throw new AgentProgramOwnershipError(busyMessage());
    if (changedPrograms.has(binaryPath)) {
      throw new AgentProgramOwnershipError(agentProgramRestartMessage(provider));
    }
    const source = resolveCodexPathIdentity(input.sourceHomePath);
    const program = `${binaryPath}\0${executableIdentity(input.binaryPath) ?? "missing"}`;
    const previous = sources.get(source);
    if (previous && previous.program !== program) {
      throw new AgentProgramOwnershipError(agentProgramRestartMessage(provider));
    }
    const record: ProgramRecord = previous ?? {
      binaryPath,
      program,
      owners: new Set<symbol>(),
      committed: false,
    };
    const owner = Symbol(provider);
    record.owners.add(owner);
    sources.set(source, record);
    let released = false;
    const release = () => {
      if (released) return;
      released = true;
      record.owners.delete(owner);
      if (!record.committed && record.owners.size === 0 && sources.get(source) === record) {
        sources.delete(source);
      }
    };
    return {
      spawned: () => {
        record.committed = true;
      },
      complete: release,
      failedToSpawn: release,
    };
  };
  // Claude writes both its private config/cache and native projects. Resolving
  // the projects path also covers explicitly shared junctions without trusting
  // an environment flag or replacing the private-home epoch.
  const operationSources = (sourceHomePath: string) => [
    ...new Set(
      (provider === "claudeAgent"
        ? [sourceHomePath, path.join(sourceHomePath, "projects")]
        : [sourceHomePath]
      ).map(resolveCodexPathIdentity),
    ),
  ];
  const beginOperation = (input: ProgramInput) => {
    const operations: ReturnType<typeof beginSourceOperation>[] = [];
    try {
      for (const sourceHomePath of operationSources(input.sourceHomePath)) {
        operations.push(beginSourceOperation({ ...input, sourceHomePath }));
      }
    } catch (cause) {
      for (const operation of operations) operation.failedToSpawn();
      throw cause;
    }
    return {
      spawned: () => {
        for (const operation of operations) operation.spawned();
      },
      complete: () => {
        for (const operation of operations) operation.complete();
      },
      failedToSpawn: () => {
        for (const operation of operations) operation.failedToSpawn();
      },
    };
  };
  return {
    beginOperation,
    /** Cleanup gates the private root only, not another account's shared projects. */
    assertPrivateSourceIdle(sourceHomePath: string) {
      if ((sources.get(resolveCodexPathIdentity(sourceHomePath))?.owners.size ?? 0) > 0) {
        throw new AgentProgramOwnershipError(
          "Claude 私有账户进程尚未结束，请稍后重试退出；若仍无法结束，请重启 Moss。",
        );
      }
    },
    assertCompatible(input: ProgramInput) {
      beginOperation(input).failedToSpawn();
    },
    forgetCompletedTemporarySource(sourceHomePath: string) {
      for (const source of operationSources(sourceHomePath)) {
        const record = sources.get(source);
        if (record?.owners.size === 0) sources.delete(source);
      }
    },
    spawn<T extends OwnedAgentProcess>(input: ProgramInput & { readonly spawn: () => T }): T {
      const operation = beginOperation(input);
      let child: T;
      try {
        child = input.spawn();
      } catch (cause) {
        operation.failedToSpawn();
        throw cause;
      }
      operation.spawned();
      child.once("close", operation.complete);
      return child;
    },
    withOperation<A, E, R>(
      input: ProgramInput,
      run: (spawned: () => void) => Effect.Effect<A, E, R>,
    ) {
      return Effect.try({
        try: () => beginOperation(input),
        catch: (cause) => (cause instanceof Error ? cause : new Error(String(cause))),
      }).pipe(
        Effect.flatMap((operation) => {
          let spawned = false;
          return run(() => {
            spawned = true;
            operation.spawned();
          }).pipe(
            Effect.onExit((exit) =>
              Effect.sync(() => {
                if (Exit.isSuccess(exit)) operation.complete();
                else if (!spawned && !Exit.hasInterrupts(exit)) operation.failedToSpawn();
              }),
            ),
          );
        }),
      );
    },
    beginMaintenance(binary: string) {
      const binaryPath = programPath(binary);
      if (
        maintenance.has(binaryPath) ||
        [...sources.values()].some(
          (record) => record.binaryPath === binaryPath && record.owners.size > 0,
        )
      ) {
        throw new AgentProgramOwnershipError(busyMessage());
      }
      maintenance.add(binaryPath);
      let finished = false;
      return {
        finish: (changed: boolean, confirmed = true) => {
          if (finished) return;
          finished = true;
          if (!confirmed) return;
          if (changed) changedPrograms.add(binaryPath);
          maintenance.delete(binaryPath);
        },
      };
    },
  };
}
