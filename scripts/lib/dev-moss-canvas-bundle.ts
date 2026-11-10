// FILE: dev-moss-canvas-bundle.ts
// Purpose: Give a development checkout the prepared Moss Canvas bundle that the release flow stages.
// Layer: Development helper (dev-runner)
// Notes: The bundle is gitignored and normally built by scripts/prepare-moss-canvas-bundle.ts from a
//   pinned open-hoola-canvas checkout. A fresh clone or worktree has none, so its dev window showed
//   "画布工作区暂不可用". This links a bundle that matches the pin from another checkout of the same
//   repository instead of building one, and says exactly what to run when none exists.

import { execFileSync } from "node:child_process";
import * as FS from "node:fs";
import * as Path from "node:path";

import { MOSS_CANVAS_BUNDLE_DIR, MOSS_CANVAS_BUNDLE_RECEIPT } from "./bundled-moss-canvas.ts";
import {
  readMossCanvasSourcePin,
  validatePinnedMossCanvasBundle,
  type MossCanvasSourcePin,
} from "./moss-canvas-source-pin.ts";

/** A prepared bundle to use before looking at other worktrees. */
export const MOSS_DEV_CANVAS_BUNDLE_ENV = "MOSS_DEV_CANVAS_BUNDLE_DIR";

export type DevMossCanvasBundleOutcome =
  | { readonly kind: "present"; readonly directory: string }
  | { readonly kind: "linked"; readonly directory: string; readonly source: string }
  | { readonly kind: "missing"; readonly directory: string; readonly message: string };

export interface EnsureDevMossCanvasBundleInput {
  readonly repoRoot: string;
  readonly env?: NodeJS.ProcessEnv;
  /** Checkout roots of the same repository; defaults to `git worktree list`. */
  readonly listCheckouts?: (repoRoot: string) => ReadonlyArray<string>;
  readonly link?: (target: string, linkPath: string) => void;
}

function listGitWorktrees(repoRoot: string): ReadonlyArray<string> {
  try {
    const output = execFileSync("git", ["-C", repoRoot, "worktree", "list", "--porcelain"], {
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
      timeout: 10_000,
    });
    return output
      .split(/\r?\n/u)
      .filter((line) => line.startsWith("worktree "))
      .map((line) => line.slice("worktree ".length).trim())
      .filter((line) => line.length > 0);
  } catch {
    return [];
  }
}

function linkDirectory(target: string, linkPath: string): void {
  // A junction needs no Windows developer mode or elevation.
  FS.symlinkSync(target, linkPath, process.platform === "win32" ? "junction" : "dir");
}

function sameDirectory(left: string, right: string): boolean {
  const normalize = (value: string) => {
    let resolved = Path.resolve(value);
    try {
      resolved = FS.realpathSync.native(resolved);
    } catch {
      // A missing directory is compared by its resolved path.
    }
    return process.platform === "win32" ? resolved.toLowerCase() : resolved;
  };
  return normalize(left) === normalize(right);
}

function isLink(path: string): boolean {
  try {
    return FS.lstatSync(path).isSymbolicLink();
  } catch {
    return false;
  }
}

function matchesPin(directory: string, pin: MossCanvasSourcePin): string | null {
  try {
    validatePinnedMossCanvasBundle(directory, pin);
    return null;
  } catch (cause) {
    return cause instanceof Error ? cause.message : String(cause);
  }
}

function receiptNamesPin(directory: string, pin: MossCanvasSourcePin): boolean {
  try {
    const receipt = JSON.parse(
      FS.readFileSync(Path.join(directory, MOSS_CANVAS_BUNDLE_RECEIPT), "utf8"),
    ) as { sourcePin?: Record<string, unknown> };
    return (["repository", "commit", "tree", "lockfileSha256"] as const).every(
      (key) => receipt.sourcePin?.[key] === pin[key],
    );
  } catch {
    return false;
  }
}

function missingMessage(pin: MossCanvasSourcePin, detail: string): string {
  return [
    `Moss Canvas is unavailable in this dev window: ${detail}`,
    `Prepare it once with: node scripts/prepare-moss-canvas-bundle.ts <open-hoola-canvas checkout at ${pin.commit}>`,
    `or point ${MOSS_DEV_CANVAS_BUNDLE_ENV} at a prepared bundle for that commit.`,
  ].join("\n");
}

/**
 * Make sure `apps/desktop/canvas-bundle` holds a bundle for the pinned Canvas
 * source. A real directory is never changed. A link this helper made earlier is
 * replaced when it no longer matches the pin.
 */
export function ensureDevMossCanvasBundle(
  input: EnsureDevMossCanvasBundleInput,
): DevMossCanvasBundleOutcome {
  const env = input.env ?? process.env;
  const directory = Path.join(input.repoRoot, MOSS_CANVAS_BUNDLE_DIR);
  const pin = readMossCanvasSourcePin(input.repoRoot);
  if (FS.existsSync(directory) || isLink(directory)) {
    const problem = FS.existsSync(directory) ? matchesPin(directory, pin) : "the link is broken";
    if (problem === null) return { kind: "present", directory };
    if (!isLink(directory))
      return {
        kind: "missing",
        directory,
        message: missingMessage(
          pin,
          `${MOSS_CANVAS_BUNDLE_DIR} does not match the pin (${problem}).`,
        ),
      };
    FS.rmSync(directory, { force: true, recursive: false });
  }
  const explicit = env[MOSS_DEV_CANVAS_BUNDLE_ENV]?.trim();
  const candidates = [
    ...(explicit ? [Path.resolve(explicit)] : []),
    ...(input.listCheckouts ?? listGitWorktrees)(input.repoRoot)
      .filter((checkout) => !sameDirectory(checkout, input.repoRoot))
      .map((checkout) => Path.join(checkout, MOSS_CANVAS_BUNDLE_DIR)),
  ];
  const seen = new Set<string>();
  for (const candidate of candidates) {
    // Read the small receipt first: only a bundle that names the pin is hashed,
    // and a bundle several worktrees link to is hashed once.
    if (!receiptNamesPin(candidate, pin)) continue;
    const source = FS.realpathSync.native(candidate);
    const key = process.platform === "win32" ? source.toLowerCase() : source;
    if (seen.has(key)) continue;
    seen.add(key);
    if (matchesPin(source, pin) !== null) continue;
    FS.mkdirSync(Path.dirname(directory), { recursive: true });
    (input.link ?? linkDirectory)(source, directory);
    return { kind: "linked", directory, source };
  }
  return {
    kind: "missing",
    directory,
    message: missingMessage(
      pin,
      explicit
        ? `${MOSS_DEV_CANVAS_BUNDLE_ENV} does not hold a bundle for the pinned commit.`
        : "no checkout of this repository has a prepared bundle for the pinned commit.",
    ),
  };
}
