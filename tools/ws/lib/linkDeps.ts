// Gives a fresh worktree working node_modules without an install (port of the operator's mkwt.mjs).
// Every package's node_modules becomes a real folder of junctions into the source checkout's
// install, except @moss/* which point at the worktree's own packages. Plain files are copied.
// Differences from mkwt.mjs: tool caches (.cache, .vite, .vite-temp) are real empty folders in the
// worktree, not links into the source; a dangling link in the source is skipped with a warning
// instead of aborting half way.
import fs from "node:fs";
import path from "node:path";

export interface LinkReport {
  linked: number;
  copied: number;
  skippedPackages: string[];
  warnings: string[];
  /** Cache folders created empty in the worktree instead of linked. */
  ownCaches: string[];
}

const linkType = process.platform === "win32" ? "junction" : "dir";

/**
 * Tool caches inside node_modules. mkwt.mjs links these into the source checkout, so a typecheck
 * or Vitest run in a worktree rewrites cache files in the primary checkout. ws gives every
 * worktree its own real, empty folder instead.
 */
export const OWN_CACHE_DIRS: ReadonlySet<string> = new Set([".cache", ".vite", ".vite-temp"]);

function packageDirs(source: string): string[] {
  const dirs = ["."];
  for (const group of ["apps", "packages"]) {
    let names: string[] = [];
    try {
      names = fs.readdirSync(path.join(source, group));
    } catch {
      continue;
    }
    for (const name of names.toSorted()) dirs.push(`${group}/${name}`);
  }
  dirs.push("scripts");
  return dirs;
}

function realOrUndefined(p: string): string | undefined {
  try {
    return fs.realpathSync(p);
  } catch {
    return undefined;
  }
}

export function linkDependencies(source: string, worktree: string): LinkReport {
  const report: LinkReport = {
    linked: 0,
    copied: 0,
    skippedPackages: [],
    warnings: [],
    ownCaches: [],
  };
  const link = (target: string, at: string) => {
    fs.symlinkSync(target, at, linkType);
    report.linked += 1;
  };
  for (const dir of packageDirs(source)) {
    const from = path.join(source, dir, "node_modules");
    const pkg = path.join(worktree, dir);
    if (!fs.existsSync(from) || !fs.existsSync(path.join(pkg, "package.json"))) continue;
    const to = path.join(pkg, "node_modules");
    if (fs.existsSync(to)) {
      report.skippedPackages.push(dir);
      continue;
    }
    fs.mkdirSync(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      if (OWN_CACHE_DIRS.has(entry.name)) {
        fs.mkdirSync(dst);
        report.ownCaches.push(`${dir}/node_modules/${entry.name}`);
      } else if (entry.name === "@moss") {
        fs.mkdirSync(dst);
        for (const child of fs.readdirSync(src)) {
          const target = realOrUndefined(path.join(src, child));
          if (!target) {
            report.warnings.push(`dangling link skipped: ${dir}/node_modules/@moss/${child}`);
            continue;
          }
          const rel = path.relative(source, target);
          link(
            rel.startsWith("..") || path.isAbsolute(rel) ? target : path.join(worktree, rel),
            path.join(dst, child),
          );
        }
      } else if (entry.name.startsWith("@") && entry.isDirectory()) {
        fs.mkdirSync(dst);
        for (const child of fs.readdirSync(src)) {
          const target = realOrUndefined(path.join(src, child));
          if (!target) {
            report.warnings.push(
              `dangling link skipped: ${dir}/node_modules/${entry.name}/${child}`,
            );
            continue;
          }
          link(target, path.join(dst, child));
        }
      } else if (entry.isFile()) {
        fs.copyFileSync(src, dst);
        report.copied += 1;
      } else {
        const target = realOrUndefined(src);
        if (!target) {
          report.warnings.push(`dangling link skipped: ${dir}/node_modules/${entry.name}`);
          continue;
        }
        link(target, dst);
      }
    }
  }
  return report;
}

export interface RelinkReport {
  /** Entries added because the worktree lacked them ("apps/web/node_modules/@ui-sdk/core"). */
  added: string[];
  /** Links that point somewhere other than the source now does (an upgraded package). */
  stale: string[];
  /** Stale links pointed at the source's current target (only with `update`). */
  retargeted: string[];
  /** Plain files in node_modules that differ from the source's; never overwritten. */
  differingFiles: string[];
  warnings: string[];
}

function isLink(p: string): boolean {
  try {
    return fs.lstatSync(p).isSymbolicLink();
  } catch {
    return false;
  }
}

function removeLink(p: string): void {
  // A link is removed as a link; ws never descends into one (safeRemove.ts). A directory junction
  // goes with rmdir on some Windows builds and with unlink on others.
  try {
    fs.unlinkSync(p);
  } catch {
    fs.rmdirSync(p);
  }
}

/**
 * Brings an existing worktree's node_modules up to the source checkout's install after a
 * dependency was added or upgraded there: adds every entry the worktree lacks, using the same rules
 * as linkDependencies, and lists links whose target moved (a new version). It never removes or
 * replaces a real folder or file; with `update` it re-points stale links (links only).
 */
export function relinkDependencies(
  source: string,
  worktree: string,
  options: { update?: boolean } = {},
): RelinkReport {
  const report: RelinkReport = {
    added: [],
    stale: [],
    retargeted: [],
    differingFiles: [],
    warnings: [],
  };
  const ensureLink = (target: string, at: string, label: string) => {
    if (!fs.existsSync(at) && !isLink(at)) {
      fs.symlinkSync(target, at, linkType);
      report.added.push(label);
      return;
    }
    if (!isLink(at)) return; // a real folder or file of the worktree: never touched
    const current = realOrUndefined(at);
    if (current && realOrUndefined(target) === current) return;
    report.stale.push(label);
    if (options.update) {
      removeLink(at);
      fs.symlinkSync(target, at, linkType);
      report.retargeted.push(label);
    }
  };
  for (const dir of packageDirs(source)) {
    const from = path.join(source, dir, "node_modules");
    const pkg = path.join(worktree, dir);
    if (!fs.existsSync(from) || !fs.existsSync(path.join(pkg, "package.json"))) continue;
    const to = path.join(pkg, "node_modules");
    if (isLink(to)) continue; // the whole folder mirrors some install already
    if (!fs.existsSync(to)) fs.mkdirSync(to);
    for (const entry of fs.readdirSync(from, { withFileTypes: true })) {
      const src = path.join(from, entry.name);
      const dst = path.join(to, entry.name);
      const label = `${dir}/node_modules/${entry.name}`;
      if (OWN_CACHE_DIRS.has(entry.name)) {
        if (!fs.existsSync(dst)) fs.mkdirSync(dst);
      } else if (entry.name.startsWith("@") && entry.isDirectory()) {
        if (isLink(dst)) continue;
        if (!fs.existsSync(dst)) fs.mkdirSync(dst);
        for (const child of fs.readdirSync(src)) {
          const target = realOrUndefined(path.join(src, child));
          if (!target) {
            report.warnings.push(`dangling link skipped: ${label}/${child}`);
            continue;
          }
          const rel = path.relative(source, target);
          const mapped =
            entry.name === "@moss" && !(rel.startsWith("..") || path.isAbsolute(rel))
              ? path.join(worktree, rel)
              : target;
          ensureLink(mapped, path.join(dst, child), `${label}/${child}`);
        }
      } else if (entry.isFile()) {
        if (!fs.existsSync(dst)) {
          fs.copyFileSync(src, dst);
          report.added.push(label);
        } else if (!fs.readFileSync(src).equals(fs.readFileSync(dst))) {
          report.differingFiles.push(label);
        }
      } else {
        const target = realOrUndefined(src);
        if (!target) {
          report.warnings.push(`dangling link skipped: ${label}`);
          continue;
        }
        ensureLink(target, dst, label);
      }
    }
  }
  return report;
}
