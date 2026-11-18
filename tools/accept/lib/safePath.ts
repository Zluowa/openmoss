// FILE: safePath.ts
// Purpose: The kit removes and overwrites folders (an app copy, a test profile). Each target must be
//          inside the run's own out folder and must not be a link, or a typo or a planted junction
//          could delete or overwrite something of the owner's.
// Layer: tools/accept

import fs from "node:fs";
import path from "node:path";

export class UnsafePathError extends Error {}

/** Throws unless `target` is strictly inside `root` and neither it nor a folder between is a link. */
export function assertInside(root: string, target: string): void {
  const base = path.resolve(root);
  const full = path.resolve(target);
  const rel = path.relative(base, full);
  if (!rel || rel.startsWith("..") || path.isAbsolute(rel))
    throw new UnsafePathError(`${full} is not inside the run folder ${base}`);
  let at = base;
  for (const part of rel.split(path.sep)) {
    at = path.join(at, part);
    let stat: fs.Stats;
    try {
      stat = fs.lstatSync(at);
    } catch {
      return; // the rest does not exist yet
    }
    if (stat.isSymbolicLink())
      throw new UnsafePathError(`${at} is a link; the kit never removes or writes through one`);
  }
}

/** rmSync after assertInside. */
export function removeInside(root: string, target: string): void {
  assertInside(root, target);
  fs.rmSync(target, { recursive: true, force: true, maxRetries: 5, retryDelay: 500 });
}
