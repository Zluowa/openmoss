// The workspace packages and which one owns a file. Which packages a change affects comes from
// the file import graph (graph.ts), not from package.json: a package.json edge nothing imports
// (the server lists @moss/web only to bundle its build) does not make a change affect the
// dependent, and a relative import into another package's folder (scripts and tools import app
// code by path) does.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

export interface WorkspacePackage {
  /** package.json name, or `tools/<name>` for a tool folder with its own Vitest config. */
  readonly name: string;
  /** Repository-relative folder, forward slashes. */
  readonly dir: string;
  readonly scripts: Readonly<Record<string, string>>;
  /** Names of workspace packages this one depends on. */
  readonly deps: readonly string[];
  readonly kind: "package" | "tool";
}

const DEP_FIELDS = ["dependencies", "devDependencies", "peerDependencies", "optionalDependencies"];

function expandWorkspaceGlob(repoRoot: string, pattern: string): string[] {
  if (!pattern.endsWith("/*")) return [pattern];
  const parent = pattern.slice(0, -2);
  const full = join(repoRoot, parent);
  if (!existsSync(full)) return [];
  return readdirSync(full, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `${parent}/${entry.name}`);
}

export function readWorkspace(repoRoot: string): WorkspacePackage[] {
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8")) as {
    workspaces?: string[] | { packages?: string[] };
  };
  const patterns = Array.isArray(root.workspaces)
    ? root.workspaces
    : (root.workspaces?.packages ?? []);
  const manifests = patterns
    .flatMap((pattern) => expandWorkspaceGlob(repoRoot, pattern))
    .filter((dir) => existsSync(join(repoRoot, dir, "package.json")))
    .map((dir) => ({
      dir,
      json: JSON.parse(readFileSync(join(repoRoot, dir, "package.json"), "utf8")) as Record<
        string,
        unknown
      >,
    }));
  const names = new Set(manifests.map(({ json }) => String(json.name)));
  const packages: WorkspacePackage[] = manifests.map(({ dir, json }) => ({
    name: String(json.name),
    dir,
    scripts: (json.scripts ?? {}) as Record<string, string>,
    deps: [
      ...new Set(
        DEP_FIELDS.flatMap((field) => Object.keys((json[field] ?? {}) as object)).filter((dep) =>
          names.has(dep),
        ),
      ),
    ].toSorted(),
    kind: "package",
  }));
  const toolsDir = join(repoRoot, "tools");
  if (existsSync(toolsDir)) {
    for (const entry of readdirSync(toolsDir, { withFileTypes: true })) {
      const dir = `tools/${entry.name}`;
      if (!entry.isDirectory() || !existsSync(join(repoRoot, dir, "vitest.config.ts"))) continue;
      packages.push({ name: dir, dir, scripts: {}, deps: [], kind: "tool" });
    }
  }
  return packages;
}

/** The package whose folder holds the file (the longest match), or undefined. */
export function packageOf(
  file: string,
  packages: readonly WorkspacePackage[],
): WorkspacePackage | undefined {
  let best: WorkspacePackage | undefined;
  for (const pkg of packages) {
    if (file.startsWith(`${pkg.dir}/`) && (!best || pkg.dir.length > best.dir.length)) best = pkg;
  }
  return best;
}
