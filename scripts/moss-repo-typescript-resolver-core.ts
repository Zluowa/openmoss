// FILE: moss-repo-typescript-resolver-core.ts
// Purpose: Resolves only ordinary repository-local TypeScript files for the Gate 8 Node hook.

import { lstatSync, realpathSync } from "node:fs";
import { basename, dirname, extname, resolve, sep } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

function isContainedPath(root: string, candidate: string): boolean {
  return candidate === root || candidate.startsWith(`${root}${sep}`);
}

export function resolveRepoTypeScriptSpecifier(options: {
  readonly repoRoot: string;
  readonly parentURL: string | undefined;
  readonly specifier: string;
}): string | undefined {
  const { repoRoot, parentURL, specifier } = options;
  if (
    typeof parentURL !== "string" ||
    (!specifier.startsWith("./") && !specifier.startsWith("../")) ||
    specifier.includes("?") ||
    specifier.includes("#") ||
    extname(basename(specifier)) !== ""
  ) {
    return undefined;
  }

  try {
    const parsedParent = new URL(parentURL);
    if (parsedParent.protocol !== "file:") return undefined;

    const root = realpathSync(repoRoot);
    const parentPath = fileURLToPath(parsedParent);
    const parentStats = lstatSync(parentPath);
    if (!parentStats.isFile() || parentStats.isSymbolicLink()) return undefined;
    const realParentPath = realpathSync(parentPath);
    if (!isContainedPath(root, realParentPath)) return undefined;

    const candidatePath = resolve(dirname(realParentPath), `${specifier}.ts`);
    const candidateStats = lstatSync(candidatePath);
    if (!candidateStats.isFile() || candidateStats.isSymbolicLink()) return undefined;
    const realCandidatePath = realpathSync(candidatePath);
    if (!isContainedPath(root, realCandidatePath)) return undefined;
    return pathToFileURL(realCandidatePath).href;
  } catch {
    return undefined;
  }
}
