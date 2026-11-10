// FILE: codexNativeLaunch.ts
// Purpose: Starts an npm-installed Codex's native binary directly on Windows, exactly as the
//          package's own JS launcher would, instead of going through cmd.exe and Node first.
// Layer: Shared provider runtime
// Exports: CodexNativeLaunch, resolveCodexNativeLaunch

import { readFileSync, realpathSync, statSync } from "node:fs";
import { win32 } from "node:path";

import { resolveCodexRuntimeTarget } from "./codexRuntime";
import { resolveExecutable } from "./executable";

export interface CodexNativeLaunch {
  /** The platform binary the npm launcher would have started. */
  readonly command: string;
  /** The caller's environment plus the variables the npm launcher sets for Codex. */
  readonly env: NodeJS.ProcessEnv;
  readonly packageRoot: string;
}

const PACKAGE_MANAGER_ENV_KEYS = [
  "CODEX_MANAGED_BY_NPM",
  "CODEX_MANAGED_BY_BUN",
  "CODEX_MANAGED_BY_PNPM",
  "CODEX_MANAGED_BY_VITE_PLUS",
] as const;
// npm's shim for `@openai/codex` ends by running this script with Node.
const NPM_SHIM_SCRIPT = /node_modules[\\/]@openai[\\/]codex[\\/]bin[\\/]codex\.js/iu;
const MAX_SHIM_BYTES = 4096;

function isFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

function readSmallText(path: string): string | null {
  try {
    if (statSync(path).size > MAX_SHIM_BYTES) return null;
    return readFileSync(path, "utf8");
  } catch {
    return null;
  }
}

/**
 * On Windows an npm global install of Codex is a `.cmd` shim: cmd.exe starts Node, Node loads
 * `codex.js`, and that script starts the native `codex.exe`. Two extra processes cost a second
 * or more on a busy PC for every session and every version check. This finds the same native
 * binary the script would pick (its platform package next to the package, then its vendor
 * folder) and the two variables it sets, so callers can start it directly.
 *
 * Returns null for anything else (a native path, another package manager's layout, a custom
 * shim, a missing platform package); callers then start `binaryPath` as before.
 */
export function resolveCodexNativeLaunch(input: {
  readonly binaryPath: string;
  readonly env: NodeJS.ProcessEnv;
  readonly cwd?: string;
  readonly platform?: NodeJS.Platform;
  readonly arch?: string;
}): CodexNativeLaunch | null {
  const platform = input.platform ?? process.platform;
  if (platform !== "win32") return null;
  const target = resolveCodexRuntimeTarget({ platform, arch: input.arch ?? process.arch });
  if (!target) return null;
  const shim = resolveExecutable(input.binaryPath, {
    env: input.env,
    platform,
    ...(input.cwd !== undefined ? { cwd: input.cwd } : {}),
  });
  if (!shim || !/\.cmd$/iu.test(shim)) return null;
  const shimText = readSmallText(shim);
  if (!shimText || !NPM_SHIM_SCRIPT.test(shimText)) return null;
  const shimDirectory = win32.dirname(shim);
  const lexicalPackageRoot = win32.join(shimDirectory, "node_modules", "@openai", "codex");
  if (!isFile(win32.join(lexicalPackageRoot, "bin", "codex.js"))) return null;
  let packageRoot: string;
  try {
    packageRoot = realpathSync(lexicalPackageRoot);
  } catch {
    return null;
  }
  const platformPackage = target.packageName.split("/");
  const binaryInVendor = (root: string) =>
    win32.join(root, "vendor", target.targetTriple, "bin", target.executableName);
  // Node resolves the platform package from the package first, then from the shared
  // node_modules beside it; the launcher falls back to the package's own vendor folder.
  const command = [
    binaryInVendor(win32.join(packageRoot, "node_modules", ...platformPackage)),
    binaryInVendor(win32.join(shimDirectory, "node_modules", ...platformPackage)),
    binaryInVendor(packageRoot),
  ].find(isFile);
  if (!command) return null;
  const env: NodeJS.ProcessEnv = { ...input.env, CODEX_MANAGED_PACKAGE_ROOT: packageRoot };
  for (const key of PACKAGE_MANAGER_ENV_KEYS) delete env[key];
  env.CODEX_MANAGED_BY_NPM = "1";
  return { command, env, packageRoot };
}
