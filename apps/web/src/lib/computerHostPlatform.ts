// FILE: computerHostPlatform.ts
// Purpose: Name the OS the computer-control host runs on, from the server's own status.
// Layer: Web settings helpers
// Exports: resolveComputerHostPlatform, computerHostPlatformName
// Depends on: the status's `hostPlatform` (reported by the Cua driver host); the window's own
//             platform only as a fallback for servers that predate the field.

import type { ComputerHostPlatform, ComputerStatusResult } from "@moss/contracts";

import { isLinuxPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";

/**
 * The host platform the status reports. Cua runs on macOS and Windows, and the host can be a
 * different computer from the one showing this window, so the window's OS is used only when an
 * older server leaves the field out.
 */
export function resolveComputerHostPlatform(
  status: Pick<ComputerStatusResult, "hostPlatform"> | undefined,
  navigatorPlatform: string,
): ComputerHostPlatform | null {
  if (status?.hostPlatform) return status.hostPlatform;
  if (isWindowsPlatform(navigatorPlatform)) return "win32";
  if (isMacPlatform(navigatorPlatform)) return "darwin";
  if (isLinuxPlatform(navigatorPlatform)) return "linux";
  return null;
}

export function computerHostPlatformName(platform: ComputerHostPlatform | null): string | null {
  switch (platform) {
    case "darwin":
      return "macOS";
    case "win32":
      return "Windows";
    case "linux":
      return "Linux";
    default:
      return null;
  }
}
