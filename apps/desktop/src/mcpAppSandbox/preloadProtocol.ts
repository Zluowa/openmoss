// FILE: preloadProtocol.ts
// Purpose: Keep the trusted MCP App preload protocol dependency-free.
// Layer: Desktop preload helper

import type { McpAppSandboxHostPortEnvelope } from "@synara/contracts";

export const MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL =
  "moss_desktop:mcp-app-sandbox-host-message" as const;
export const MCP_APP_SANDBOX_PORT_NAMES = ["mcp-app-host", "mcp-app-navigation"] as const;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasExactKeys(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  if (!isRecord(value)) return false;
  const ownKeys = Object.keys(value);
  return ownKeys.length === keys.length && keys.every((key) => ownKeys.includes(key));
}

function trimBoundedIdentity(value: unknown, maxLength: number): string | null {
  if (typeof value !== "string") return null;
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.length <= maxLength ? trimmed : null;
}

function hasExactPortNames(value: unknown): value is McpAppSandboxHostPortEnvelope["portNames"] {
  return (
    Array.isArray(value) &&
    value.length === MCP_APP_SANDBOX_PORT_NAMES.length &&
    value.every((name, index) => name === MCP_APP_SANDBOX_PORT_NAMES[index])
  );
}

/**
 * Dependency-free mirror of the shared contract decoder for sandboxed preload
 * code. Keep this fail-closed when changing the public envelope contract.
 */
export function decodeMcpAppSandboxHostPortEnvelope(
  value: unknown,
): McpAppSandboxHostPortEnvelope | null {
  try {
    if (!hasExactKeys(value, ["origin", "initId", "portNames", "sandboxId", "type"])) {
      return null;
    }
    const origin = trimBoundedIdentity(value.origin, 512);
    const initId = trimBoundedIdentity(value.initId, 200);
    const sandboxId = trimBoundedIdentity(value.sandboxId, 200);
    if (
      origin === null ||
      initId === null ||
      sandboxId === null ||
      value.type !== MCP_APP_SANDBOX_MAIN_TO_TRUSTED_CHANNEL ||
      !hasExactPortNames(value.portNames)
    ) {
      return null;
    }
    return { origin, initId, portNames: value.portNames, sandboxId, type: value.type };
  } catch {
    return null;
  }
}
