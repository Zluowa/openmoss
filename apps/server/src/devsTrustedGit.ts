import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { localRepairEnvironment } from "./devsLocalExecutor";

/**
 * Settings for every Git command the repair controller runs. A job checkout holds files an
 * untrusted model wrote, and Git reads some of them as configuration, so nothing that Git or
 * Git LFS could execute or send a credential through is left switched on:
 * - hooks, including the pre-push hook Git LFS installs, point at the null device;
 * - the Git LFS filters, which a global `git lfs install` defines, are emptied, so Git LFS is
 *   never started and `.lfsconfig` is never read;
 * - fsmonitor, external diff and submodule recursion are off;
 * - inherited credential helpers are reset.
 */
export function trustedGitArgs(): string[] {
  return [
    ["core.hooksPath", os.devNull],
    ["core.fsmonitor", "false"],
    ["core.attributesFile", os.devNull],
    ["core.autocrlf", "false"],
    ["core.longpaths", "true"],
    ["filter.lfs.process", ""],
    ["filter.lfs.clean", ""],
    ["filter.lfs.smudge", ""],
    ["filter.lfs.required", "false"],
    ["diff.external", ""],
    ["submodule.recurse", "false"],
    ["push.recurseSubmodules", "no"],
    ["protocol.ext.allow", "never"],
    ["credential.helper", ""],
  ].flatMap(([key, value]) => ["-c", `${key}=${value}`]);
}

/** No inherited credentials, Git configuration overrides or prompts reach the controller's Git. */
export function trustedGitEnvironment(): NodeJS.ProcessEnv {
  return {
    ...localRepairEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
    GCM_INTERACTIVE: "never",
    GIT_LFS_SKIP_SMUDGE: "1",
    GIT_LFS_SKIP_PUSH: "1",
    GIT_NO_REPLACE_OBJECTS: "1",
  };
}

const PASSWORD_VARIABLE = "MOSS_DEVS_GIT_PUSH_TOKEN";

export function githubRepositoryUrl(repository: string): string {
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repository))
    throw new Error("Invalid repair repository.");
  return `https://github.com/${repository}.git`;
}

/**
 * Credentials for exactly `https://github.com/<repository>.git`. The token is in the
 * environment of that one Git process, never in argv, a URL, a file or a log, and the helper
 * answers no other host or repository: a redirect, a rewritten URL or a Git LFS endpoint gets
 * nothing.
 */
export function githubTransport(repository: string, githubToken: string) {
  const url = githubRepositoryUrl(repository);
  return {
    url,
    args: [
      ...trustedGitArgs(),
      "-c",
      "credential.useHttpPath=true",
      "-c",
      `credential.${url}.helper=!f() { test "$1" = get || exit 0; echo username=x-access-token; echo "password=$${PASSWORD_VARIABLE}"; }; f`,
      "-c",
      "http.followRedirects=false",
    ],
    env: { ...trustedGitEnvironment(), [PASSWORD_VARIABLE]: githubToken },
  };
}

/**
 * Fingerprint of the job's Git metadata that Git treats as configuration. The model is never
 * allowed to change it; the controller compares it before running any Git command on the
 * model's edits, so a planted filter, include or alternate object store is never used.
 */
export async function gitMetadataFingerprint(checkout: string): Promise<string> {
  const gitDir = path.join(checkout, ".git");
  const stat = await fs.lstat(gitDir);
  if (!stat.isDirectory() || stat.isSymbolicLink())
    throw new Error("The repair checkout's Git metadata is not a directory.");
  const hash = createHash("sha256");
  const add = async (relative: string) => {
    const location = path.join(gitDir, relative);
    const entry = await fs.lstat(location).catch((error: NodeJS.ErrnoException) => {
      if (error.code === "ENOENT") return null;
      throw error;
    });
    hash.update(`${relative}\0`);
    if (!entry) return hash.update("missing\0");
    if (entry.isSymbolicLink()) return hash.update(`link:${await fs.readlink(location)}\0`);
    if (entry.isDirectory()) {
      hash.update("directory\0");
      for (const name of (await fs.readdir(location)).toSorted())
        await add(path.join(relative, name));
      return;
    }
    hash.update(await fs.readFile(location));
  };
  for (const relative of [
    "config",
    "config.worktree",
    "commondir",
    "HEAD",
    "info",
    "hooks",
    path.join("objects", "info"),
  ])
    await add(relative);
  return hash.digest("hex");
}

/** Removes every occurrence of each secret, whatever produced the text. */
export function stripSecrets(text: string, secrets: readonly (string | undefined)[]): string {
  let output = text;
  for (const secret of secrets)
    if (secret && secret.length >= 8) output = output.split(secret).join("[redacted]");
  return output;
}
