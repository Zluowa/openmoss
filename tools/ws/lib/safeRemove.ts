// The only code in ws that deletes files. Rules:
// 1. A target must be a real directory strictly inside an allowed root, not a link, not reached
//    through a link, not protected, not containing anything protected and not a main checkout.
// 2. Links (symlinks and junctions) are removed as links. ws never descends into one.
// 3. Before descending into a directory, its real path must be exactly where it was expected.
//    A directory whose real path differs is a reparse point lstat did not report: it is unlinked,
//    never entered.
import fs from "node:fs";
import path from "node:path";
import { isInsideOrEqual, isStrictlyInside, normalize, samePath, tryRealpath } from "./paths.ts";

export class UnsafeTargetError extends Error {}

export interface RemovalGuard {
  /** The target must be strictly inside one of these. */
  readonly roots: readonly string[];
  /** Never removed, nor anything that contains them, nor anything inside them. */
  readonly protectedPaths: readonly string[];
  /** Other live worktrees: the target must not contain any of them. */
  readonly otherWorktrees?: readonly string[];
}

/** Throws UnsafeTargetError with the reason when `target` must not be removed. */
export function assertRemovable(target: string, guard: RemovalGuard): void {
  if (!path.isAbsolute(target)) throw new UnsafeTargetError(`not an absolute path: ${target}`);
  const t = normalize(target);
  let st: fs.Stats;
  try {
    st = fs.lstatSync(t);
  } catch {
    throw new UnsafeTargetError(`does not exist: ${t}`);
  }
  if (st.isSymbolicLink()) throw new UnsafeTargetError(`is a link, not a directory: ${t}`);
  if (!st.isDirectory()) throw new UnsafeTargetError(`is not a directory: ${t}`);
  const real = tryRealpath(t);
  if (!real || !samePath(real, t)) {
    throw new UnsafeTargetError(`is reached through a link (real path ${real ?? "unknown"}): ${t}`);
  }
  const roots = guard.roots.map(normalize);
  const realRoots = roots.map((r) => tryRealpath(r) ?? r);
  if (!roots.some((r, i) => isStrictlyInside(t, r) && isStrictlyInside(real, realRoots[i]!))) {
    throw new UnsafeTargetError(`is outside the configured roots (${roots.join(", ")}): ${t}`);
  }
  for (const p of guard.protectedPaths) {
    const pr = tryRealpath(p) ?? normalize(p);
    if (isInsideOrEqual(t, p) || isInsideOrEqual(real, pr)) {
      throw new UnsafeTargetError(`is or is inside a protected path (${p}): ${t}`);
    }
    if (isStrictlyInside(p, t) || isStrictlyInside(pr, real)) {
      throw new UnsafeTargetError(`contains a protected path (${p}): ${t}`);
    }
  }
  for (const w of guard.otherWorktrees ?? []) {
    if (isStrictlyInside(w, t))
      throw new UnsafeTargetError(`contains another worktree (${w}): ${t}`);
  }
  // A worktree has a `.git` file. A `.git` directory means a main checkout that owns the objects.
  try {
    if (fs.lstatSync(path.join(t, ".git")).isDirectory()) {
      throw new UnsafeTargetError(`has a .git directory (a main checkout, not a worktree): ${t}`);
    }
  } catch (error) {
    if (error instanceof UnsafeTargetError) throw error;
  }
}

export interface RemovalReport {
  links: number;
  files: number;
  dirs: number;
  errors: string[];
}

function unlinkLink(p: string, report: RemovalReport): void {
  try {
    fs.unlinkSync(p);
    report.links += 1;
    return;
  } catch {
    // A directory junction on some Windows builds only goes with rmdir; rmdir without
    // `recursive` removes the link itself and never touches the target.
  }
  try {
    fs.rmdirSync(p);
    report.links += 1;
  } catch (error) {
    report.errors.push(`link ${p}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
}

function unlinkFile(p: string, report: RemovalReport): void {
  try {
    fs.unlinkSync(p);
    report.files += 1;
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EPERM" || code === "EACCES") {
      try {
        fs.chmodSync(p, 0o666);
        fs.unlinkSync(p);
        report.files += 1;
        return;
      } catch {
        // fall through to the error below
      }
    }
    report.errors.push(`file ${p}: ${code ?? String(error)}`);
  }
}

/** Is `p` (found by listing `parentReal`) a real directory at the expected place? */
function isPlainDirectory(p: string, parentReal: string, name: string): string | undefined {
  const real = tryRealpath(p);
  if (!real) return undefined;
  return samePath(real, path.join(parentReal, name)) ? real : undefined;
}

/** Pass 1: remove every link under `dir` as a link, descending only into plain directories. */
function removeLinksUnder(dir: string, dirReal: string, report: RemovalReport): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    report.errors.push(`list ${dir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      unlinkLink(p, report);
    } else if (st.isDirectory()) {
      const real = isPlainDirectory(p, dirReal, entry.name);
      if (real) removeLinksUnder(p, real, report);
      else unlinkLink(p, report);
    }
  }
}

/** Pass 2: delete what is left. Still checks every entry, in case something changed. */
function removeContents(dir: string, dirReal: string, report: RemovalReport): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch (error) {
    report.errors.push(`list ${dir}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
    return;
  }
  for (const entry of entries) {
    const p = path.join(dir, entry.name);
    let st: fs.Stats;
    try {
      st = fs.lstatSync(p);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) {
      unlinkLink(p, report);
    } else if (st.isDirectory()) {
      const real = isPlainDirectory(p, dirReal, entry.name);
      if (!real) {
        unlinkLink(p, report);
        continue;
      }
      removeContents(p, real, report);
      try {
        fs.rmdirSync(p);
        report.dirs += 1;
      } catch (error) {
        report.errors.push(`dir ${p}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
      }
    } else {
      unlinkFile(p, report);
    }
  }
}

/** Count of links a removal would unlink, without changing anything (for dry runs). */
export function countLinks(dir: string): number {
  let count = 0;
  const walk = (d: string, dReal: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const p = path.join(d, entry.name);
      let st: fs.Stats;
      try {
        st = fs.lstatSync(p);
      } catch {
        continue;
      }
      if (st.isSymbolicLink()) count += 1;
      else if (st.isDirectory()) {
        const real = isPlainDirectory(p, dReal, entry.name);
        if (real) walk(p, real);
        else count += 1;
      }
    }
  };
  const real = tryRealpath(dir);
  if (real) walk(dir, real);
  return count;
}

/**
 * Removes `target` after assertRemovable: links first (as links), then files and directories,
 * then the target itself. Returns what it did; errors (for example locked files) are collected,
 * not thrown, and the target stays when anything could not be removed.
 */
export function removeTreeSafe(target: string, guard: RemovalGuard): RemovalReport {
  assertRemovable(target, guard);
  const t = normalize(target);
  const real = tryRealpath(t)!;
  const report: RemovalReport = { links: 0, files: 0, dirs: 0, errors: [] };
  removeLinksUnder(t, real, report);
  removeContents(t, real, report);
  try {
    fs.rmdirSync(t);
    report.dirs += 1;
  } catch (error) {
    report.errors.push(`dir ${t}: ${(error as NodeJS.ErrnoException).code ?? String(error)}`);
  }
  return report;
}
