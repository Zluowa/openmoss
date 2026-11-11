// Path comparison that behaves the same on Windows (case-insensitive, either slash) and POSIX.
import fs from "node:fs";
import path from "node:path";

const isWindows = process.platform === "win32";

/** Absolute, normalised, without a trailing separator (except for a drive or POSIX root). */
export function normalize(p: string): string {
  let out = path.resolve(p);
  if (
    out.length > 1 &&
    (out.endsWith("\\") || out.endsWith("/")) &&
    !/^[A-Za-z]:[\\/]$/.test(out)
  ) {
    out = out.slice(0, -1);
  }
  return out;
}

/** Key used for equality: lower-case with forward slashes on Windows. */
export function pathKey(p: string): string {
  const n = normalize(p);
  return isWindows ? n.replaceAll("\\", "/").toLowerCase() : n;
}

export function samePath(a: string, b: string): boolean {
  return pathKey(a) === pathKey(b);
}

/** True when `child` is strictly inside `parent` (never equal). */
export function isStrictlyInside(child: string, parent: string): boolean {
  const c = pathKey(child);
  const p = pathKey(parent);
  if (c === p) return false;
  const prefix = p.endsWith("/") ? p : `${p}/`;
  return c.startsWith(prefix);
}

export function isInsideOrEqual(child: string, parent: string): boolean {
  return samePath(child, parent) || isStrictlyInside(child, parent);
}

/** realpath that returns undefined instead of throwing. */
export function tryRealpath(p: string): string | undefined {
  try {
    return fs.realpathSync.native(p);
  } catch {
    return undefined;
  }
}

/** The drive or mount a path lives on, for messages: `C:` on Windows, the path itself elsewhere. */
export function driveLabel(p: string): string {
  const n = normalize(p);
  const m = /^([A-Za-z]:)/.exec(n);
  return m ? m[1]!.toUpperCase() : n;
}

/**
 * Whether a process command line refers to a path inside `dir`. Matches either slash form and
 * requires the path to end at a separator, quote, space or the end, so `C:/wt/a` does not match `C:/wt/ab`.
 */
export function commandLineUsesPath(commandLine: string, dir: string): boolean {
  const c = isWindows ? commandLine.toLowerCase() : commandLine;
  const base = isWindows ? normalize(dir).toLowerCase() : normalize(dir);
  const forms = new Set([base, base.replaceAll("\\", "/"), base.replaceAll("/", "\\")]);
  for (const form of forms) {
    let from = 0;
    for (;;) {
      const at = c.indexOf(form, from);
      if (at < 0) break;
      const next = c[at + form.length];
      if (
        next === undefined ||
        next === "\\" ||
        next === "/" ||
        next === '"' ||
        next === "'" ||
        next === " "
      ) {
        return true;
      }
      from = at + 1;
    }
  }
  return false;
}
