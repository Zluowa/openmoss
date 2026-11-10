// FILE: codexExecutable.ts
// Purpose: Decides which Codex executable a launch runs: a configured path, the person's own
//          `codex`, or the runtime packaged Moss ships.
// Layer: Shared provider runtime policy

import {
  BundledCodexRuntimeUnavailableError,
  MOSS_BUNDLED_CODEX_ERROR_ENV_KEY,
  MOSS_BUNDLED_CODEX_PATH_ENV_KEY,
} from "./codexRuntime";
import { isCommandOnPath, resolveLocalAgentExecutable } from "./localAgentExecutable";

export interface CodexExecutableResolution {
  readonly binaryPath: string;
  readonly source: "configured" | "bundled" | "path";
}

/**
 * Resolves the executable without mutating persisted provider settings.
 *
 * A non-default configured path is user intent and always wins. The literal
 * `codex` (the settings schema default) means "use Moss's best available Codex":
 * the person's own `codex` on PATH when they have one, otherwise the verified
 * runtime a packaged build ships. A damaged packaged runtime is reported rather
 * than hidden only when there is no own install to fall back to.
 */
export function resolveCodexExecutable(input: {
  readonly configuredBinaryPath?: string | null | undefined;
  readonly env?: NodeJS.ProcessEnv | undefined;
  /**
   * Account identity is accepted for existing callers, but never selects a program.
   * Every account uses the provider's shared configured/PATH/bundled preference.
   */
  readonly accountId?: string | null | undefined;
  /** Test seam for the PATH lookup. */
  readonly isOnPath?: ((command: string) => boolean) | undefined;
}): CodexExecutableResolution {
  const env = input.env ?? process.env;
  const bundled = env[MOSS_BUNDLED_CODEX_PATH_ENV_KEY]?.trim() ?? "";
  const configured = input.configuredBinaryPath?.trim() ?? "";
  const bundledError = env[MOSS_BUNDLED_CODEX_ERROR_ENV_KEY]?.trim() ?? "";
  const resolution = resolveLocalAgentExecutable({
    command: "codex",
    configuredBinaryPath: configured,
    bundledBinaryPath: bundled,
    env,
    ...(input.isOnPath ? { isOnPath: input.isOnPath } : {}),
  });
  if (resolution.source !== "path" || resolution.bundledAvailable) {
    return { binaryPath: resolution.binaryPath, source: resolution.source };
  }
  const onPath = input.isOnPath ?? ((command: string) => isCommandOnPath(command, { env }));
  if (bundledError && !onPath("codex")) {
    // A packaged build whose runtime is damaged and with no own Codex to use says so,
    // instead of failing later with a confusing "not installed".
    throw new BundledCodexRuntimeUnavailableError(bundledError);
  }
  return { binaryPath: resolution.binaryPath, source: "path" };
}
