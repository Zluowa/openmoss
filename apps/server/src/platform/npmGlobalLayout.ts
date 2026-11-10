// FILE: npmGlobalLayout.ts
// Purpose: Where `npm install --global --prefix <prefix>` puts command launchers on each platform.
// Layer: Server platform runtime
//
// npm writes launchers straight into the prefix on Windows (`name`, `name.cmd`, `name.ps1`)
// and into `<prefix>/bin` elsewhere (one symlink per command). Provider code that installs,
// finds or removes Moss-managed agents asks here instead of branching on the platform itself.

import * as NodePath from "node:path";

const WINDOWS_LAUNCHER_SUFFIXES: readonly string[] = ["", ".cmd", ".ps1"];
const POSIX_LAUNCHER_SUFFIXES: readonly string[] = [""];

/** The folder npm writes command launchers into for a global install under `prefix`. */
export function npmGlobalBinDirectory(
  prefix: string,
  platform: NodeJS.Platform = process.platform,
): string {
  return platform === "win32" ? prefix : NodePath.join(prefix, "bin");
}

/** File-name suffixes npm gives one command's launchers, appended to the command name. */
export function npmGlobalLauncherSuffixes(
  platform: NodeJS.Platform = process.platform,
): readonly string[] {
  return platform === "win32" ? WINDOWS_LAUNCHER_SUFFIXES : POSIX_LAUNCHER_SUFFIXES;
}
