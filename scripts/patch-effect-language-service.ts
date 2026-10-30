import { spawnSync } from "node:child_process";
import { existsSync, globSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

interface WorkspaceManifest {
  workspaces?: string[] | { packages: string[] };
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
}

export interface EffectPatchTarget {
  workspace: string;
  typescriptDirectory: string;
  cli: string;
  version: string;
}

function readManifest(path: string): WorkspaceManifest {
  return JSON.parse(readFileSync(path, "utf8")) as WorkspaceManifest;
}

// Only what the install linked into the workspace's node_modules chain counts. Node's own
// resolution also consults NODE_PATH and other global folders, which would make a workspace
// a filtered install skipped look half installed whenever a global TypeScript exists.
function resolveInstalledPackage(workspace: string, name: string): string | undefined {
  for (let directory = workspace; ; directory = dirname(directory)) {
    const manifest = join(directory, "node_modules", name, "package.json");
    if (existsSync(manifest)) return realpathSync(manifest);
    if (dirname(directory) === directory) return undefined;
  }
}

export function collectEffectPatchTargets(root: string): EffectPatchTarget[] {
  const manifest = readManifest(join(root, "package.json"));
  const patterns = Array.isArray(manifest.workspaces)
    ? manifest.workspaces
    : manifest.workspaces?.packages;
  if (!patterns) throw new Error("Effect patch installation requires workspace declarations.");
  const targets = new Map<string, EffectPatchTarget>();
  for (const path of globSync(
    patterns.map((pattern) => `${pattern}/package.json`),
    { cwd: root },
  ).sort()) {
    const workspace = dirname(resolve(root, path));
    const workspaceManifest = readManifest(join(workspace, "package.json"));
    if (
      !workspaceManifest.dependencies?.["@effect/language-service"] &&
      !workspaceManifest.devDependencies?.["@effect/language-service"]
    ) {
      continue;
    }
    const effectPackage = resolveInstalledPackage(workspace, "@effect/language-service");
    const typescriptPackage = resolveInstalledPackage(workspace, "typescript");
    // A filtered install can leave a workspace entirely uninstalled. A partial
    // toolchain is an installation error and must not silently lose diagnostics.
    if (!effectPackage && !typescriptPackage) continue;
    if (!effectPackage || !typescriptPackage) {
      throw new Error(`Incomplete Effect TypeScript toolchain in ${workspace}.`);
    }
    const version: unknown = JSON.parse(readFileSync(effectPackage, "utf8")).version;
    if (typeof version !== "string" || !version) {
      throw new Error(`Missing Effect language-service version in ${effectPackage}.`);
    }
    const typescriptDirectory = dirname(typescriptPackage);
    const existing = targets.get(typescriptDirectory);
    if (existing && existing.version !== version) {
      throw new Error(`Conflicting Effect language-service versions for ${typescriptDirectory}.`);
    }
    if (!existing) {
      targets.set(typescriptDirectory, {
        workspace,
        typescriptDirectory,
        cli: join(dirname(effectPackage), "cli.js"),
        version,
      });
    }
  }
  return [...targets.values()];
}

export function patchEffectWorkspaceTypescript(root: string): number {
  // Bun 1.4.2 runs workspace prepare hooks concurrently even with
  // --concurrent-scripts=1. Its workspace links share the same TypeScript files.
  // One root postinstall owns all patches, after dependency installation, with
  // each physical compiler patched exactly once and independent copies in order.
  for (const target of collectEffectPatchTargets(root)) {
    const child = spawnSync(
      process.execPath,
      [target.cli, "patch", "--dir", target.typescriptDirectory],
      { cwd: target.workspace, stdio: "inherit" },
    );
    if (child.error) throw child.error;
    if (child.signal) throw new Error(`Effect TypeScript patch terminated by ${child.signal}.`);
    if (child.status !== 0) return child.status ?? 1;
  }
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = patchEffectWorkspaceTypescript(
    resolve(dirname(fileURLToPath(import.meta.url)), ".."),
  );
}
