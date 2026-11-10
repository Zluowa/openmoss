// FILE: managedAgentPaths.ts
// Purpose: Where Moss installs agent CLIs, and putting that folder on PATH.
// Layer: Provider maintenance (server). A leaf on purpose: PATH discovery (agentCliPathFloor),
//        server settings and the installer all need these paths, and none of them may pull in
//        the installer's agent tables while the settings module is still loading.

import * as NodePath from "node:path";

import { envPathKeyFor } from "@moss/shared/executable";
import { mergePathEntries } from "@moss/shared/shell";

import { npmGlobalBinDirectory } from "../platform/npmGlobalLayout.ts";

/** npm's `--prefix` for everything Moss installs. */
export function managedAgentInstallPrefix(mossHomeDir: string): string {
  return NodePath.join(mossHomeDir, "agents");
}

/** Where npm puts command shims for a global install under `prefix`. */
export function managedAgentBinDirectory(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return npmGlobalBinDirectory(prefix, platform);
}

/**
 * Appends the Moss-managed agent folder to PATH (once), after the person's own entries,
 * so agents Moss installed are found and the person's own installs still win.
 */
export function appendManagedAgentBinDirectoryToPath(
  mossHomeDir: string,
  env: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): string {
  const binDirectory = managedAgentBinDirectory(managedAgentInstallPrefix(mossHomeDir), platform);
  const pathKey = envPathKeyFor(env, platform);
  // Merging dedupes, so calling this again after an install changes nothing.
  env[pathKey] = mergePathEntries(env[pathKey], binDirectory, platform) ?? binDirectory;
  return binDirectory;
}
