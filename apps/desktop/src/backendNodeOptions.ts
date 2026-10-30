// FILE: backendNodeOptions.ts
// Purpose: Builds Node runtime arguments for the packaged desktop backend child.
// Layer: Desktop process startup helper
// Exports: backend heap limit and process-local Node argument helpers.

const MB = 1024 * 1024;
const DEFAULT_BACKEND_HEAP_FRACTION = 0.25;
const MIN_BACKEND_OLD_SPACE_MB = 3072;
const MAX_BACKEND_OLD_SPACE_MB = 8192;
// Explicit overrides get wider latitude than the computed default, but are still
// clamped: a typo like "64" must not give the backend a heap it cannot boot with.
const MIN_CONFIGURED_OLD_SPACE_MB = 1024;
const MAX_CONFIGURED_OLD_SPACE_MB = 32768;
const OLD_SPACE_FLAG_PATTERN = /(?:^|\s)--max[-_]old[-_]space[-_]size(?:=|\s|$)/;
const BACKEND_PROXY_ENV_KEYS = [
  "HTTPS_PROXY",
  "HTTP_PROXY",
  "ALL_PROXY",
  "https_proxy",
  "http_proxy",
  "all_proxy",
] as const;

/**
 * Node 22 inherits proxy variables but does not route native fetch through them
 * unless the process opts in. Desktop provider CLIs already honor these values;
 * keep the backend control plane on the same user-configured network route.
 */
export function withBackendEnvProxyOptIn(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  if (env.NODE_USE_ENV_PROXY?.trim()) {
    return env;
  }
  const hasConfiguredProxy = BACKEND_PROXY_ENV_KEYS.some((key) => env[key]?.trim());
  return hasConfiguredProxy ? { ...env, NODE_USE_ENV_PROXY: "1" } : env;
}

function parseConfiguredOldSpaceMb(value: string | null | undefined): number | null {
  if (typeof value !== "string") {
    return null;
  }
  const parsed = Number.parseInt(value.trim(), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return null;
  }
  return Math.min(MAX_CONFIGURED_OLD_SPACE_MB, Math.max(MIN_CONFIGURED_OLD_SPACE_MB, parsed));
}

export function resolveBackendMaxOldSpaceMb(input: {
  readonly configuredMb?: string | null | undefined;
  readonly totalMemoryBytes: number;
}): number {
  const configuredMb = parseConfiguredOldSpaceMb(input.configuredMb);
  if (configuredMb !== null) {
    return configuredMb;
  }

  const totalMemoryMb = Math.max(0, Math.floor(input.totalMemoryBytes / MB));
  const targetMb = Math.floor(totalMemoryMb * DEFAULT_BACKEND_HEAP_FRACTION);
  return Math.min(MAX_BACKEND_OLD_SPACE_MB, Math.max(MIN_BACKEND_OLD_SPACE_MB, targetMb));
}

// Keeps desktop backend heap room proportional to the host without changing inherited env.
export function withBackendHeapLimitArg(
  nodeOptions: string | undefined,
  maxOldSpaceMb: number,
): string[] {
  const existingOptions = nodeOptions?.trim() ?? "";
  if (OLD_SPACE_FLAG_PATTERN.test(existingOptions)) {
    return [];
  }

  return [`--max-old-space-size=${maxOldSpaceMb}`];
}

export function resolveBackendNodeArgs(input: {
  readonly configuredMaxOldSpaceMb?: string | null | undefined;
  readonly existingNodeOptions?: string | undefined;
  readonly totalMemoryBytes: number;
}): string[] {
  return withBackendHeapLimitArg(
    input.existingNodeOptions,
    resolveBackendMaxOldSpaceMb({
      configuredMb: input.configuredMaxOldSpaceMb,
      totalMemoryBytes: input.totalMemoryBytes,
    }),
  );
}
