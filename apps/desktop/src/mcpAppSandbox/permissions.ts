// FILE: permissions.ts
// Purpose: Map Electron permission requests from a widget guest onto the
// MCP Apps permission keys, and decide them (pure).
// Layer: Electron main-process support.
//
// A device permission is granted only when all of these hold: the widget's
// resource declared it, no frame site withholds device permissions, and the
// trusted host granted it for this partition after the user approved it.
// Everything else (notifications, MIDI, HID, display capture, ...) is denied.

import {
  MCP_APP_SANDBOX_PERMISSION_KEYS,
  type McpAppSandboxPermissionKey,
  type McpAppSandboxPermissions,
} from "@moss/contracts";

/** Which permission keys an Electron permission request needs, or null if it is never grantable. */
export function mcpAppPermissionKeysFor(
  permission: string,
  mediaTypes: readonly string[] | undefined,
): McpAppSandboxPermissionKey[] | null {
  switch (permission) {
    case "geolocation":
      return ["geolocation"];
    case "clipboard-sanitized-write":
      return ["clipboardWrite"];
    case "media": {
      const types = mediaTypes ?? [];
      if (types.length === 0) return null;
      const keys: McpAppSandboxPermissionKey[] = [];
      for (const type of types) {
        if (type === "video") keys.push("camera");
        else if (type === "audio") keys.push("microphone");
        else return null;
      }
      return [...new Set(keys)];
    }
    default:
      return null;
  }
}

export interface McpAppPermissionContext {
  /** What the widget's resource declared, after frame-site withholding. */
  readonly declared: McpAppSandboxPermissions;
  /** What the trusted host granted for the partition. */
  readonly granted: McpAppSandboxPermissions;
}

export function decideMcpAppPermission(
  permission: string,
  mediaTypes: readonly string[] | undefined,
  context: McpAppPermissionContext | null,
): boolean {
  if (!context) return false;
  const keys = mcpAppPermissionKeysFor(permission, mediaTypes);
  if (!keys || keys.length === 0) return false;
  return keys.every((key) => context.declared[key] === true && context.granted[key] === true);
}

/** Electron's check handler reports one media type at a time ("video" | "audio" | "unknown"). */
export function decideMcpAppPermissionCheck(
  permission: string,
  mediaType: string | undefined,
  context: McpAppPermissionContext | null,
): boolean {
  if (permission === "media") {
    return mediaType === "video" || mediaType === "audio"
      ? decideMcpAppPermission(permission, [mediaType], context)
      : false;
  }
  return decideMcpAppPermission(permission, undefined, context);
}

/**
 * The set the host may grant: what it asked for, limited to what some live
 * registration of the partition declared (and may be delegated).
 */
export function grantableMcpAppPermissions(
  requested: McpAppSandboxPermissions,
  declaredByRegistrations: readonly McpAppSandboxPermissions[],
): McpAppSandboxPermissions {
  const granted: Partial<Record<McpAppSandboxPermissionKey, boolean>> = {};
  for (const key of MCP_APP_SANDBOX_PERMISSION_KEYS) {
    if (requested[key] !== true) continue;
    if (declaredByRegistrations.some((declared) => declared[key] === true)) granted[key] = true;
  }
  return granted;
}
