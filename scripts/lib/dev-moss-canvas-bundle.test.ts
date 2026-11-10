import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  MOSS_CANVAS_BUNDLE_DIR,
  MOSS_CANVAS_BUNDLE_HASH_ALGORITHM,
  MOSS_CANVAS_BUNDLE_RECEIPT,
  MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
  validateMossCanvasBundle,
} from "./bundled-moss-canvas.ts";
import { ensureDevMossCanvasBundle, MOSS_DEV_CANVAS_BUNDLE_ENV } from "./dev-moss-canvas-bundle.ts";
import { MOSS_CANVAS_SOURCE_PIN_FILE } from "./moss-canvas-source-pin.ts";

const PIN = {
  repository: "Zluowa/open-hoola-canvas",
  commit: "1".repeat(40),
  tree: "2".repeat(40),
  lockfileSha256: "3".repeat(64),
};
const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) FS.rmSync(root, { recursive: true, force: true });
});

function checkout(name: string, bundlePin?: typeof PIN): string {
  const base = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-dev-canvas-"));
  roots.push(base);
  const root = Path.join(base, name);
  FS.mkdirSync(Path.join(root, Path.dirname(MOSS_CANVAS_SOURCE_PIN_FILE)), { recursive: true });
  FS.writeFileSync(Path.join(root, MOSS_CANVAS_SOURCE_PIN_FILE), JSON.stringify(PIN));
  if (bundlePin) {
    const bundle = Path.join(root, MOSS_CANVAS_BUNDLE_DIR);
    for (const required of MOSS_CANVAS_BUNDLE_REQUIRED_PATHS) {
      FS.mkdirSync(Path.dirname(Path.join(bundle, required)), { recursive: true });
      FS.writeFileSync(Path.join(bundle, required), `${required}\n`);
    }
    const validation = validateMossCanvasBundle(bundle);
    FS.writeFileSync(
      Path.join(bundle, MOSS_CANVAS_BUNDLE_RECEIPT),
      JSON.stringify({
        hashAlgorithm: MOSS_CANVAS_BUNDLE_HASH_ALGORITHM,
        sourcePin: bundlePin,
        requiredPaths: [...MOSS_CANVAS_BUNDLE_REQUIRED_PATHS],
        fileCount: validation.fileCount,
        sha256: validation.sha256,
      }),
    );
  }
  return root;
}

const canvasIndex = (root: string) =>
  Path.join(root, MOSS_CANVAS_BUNDLE_DIR, "apps/codex-canvas/dist/index.html");

describe("dev Canvas bundle", () => {
  it("leaves a checkout that already has the pinned bundle alone", () => {
    const root = checkout("ready", PIN);
    expect(ensureDevMossCanvasBundle({ repoRoot: root, listCheckouts: () => [] })).toMatchObject({
      kind: "present",
    });
  });

  it("links the pinned bundle from another checkout of the same repository", () => {
    const fresh = checkout("fresh");
    const prepared = checkout("prepared", PIN);
    const outcome = ensureDevMossCanvasBundle({
      repoRoot: fresh,
      listCheckouts: () => [fresh, prepared],
    });
    expect(outcome.kind).toBe("linked");
    expect(FS.lstatSync(Path.join(fresh, MOSS_CANVAS_BUNDLE_DIR)).isSymbolicLink()).toBe(true);
    expect(FS.readFileSync(canvasIndex(fresh), "utf8")).toContain("index.html");
    // A second start finds it in place.
    expect(ensureDevMossCanvasBundle({ repoRoot: fresh, listCheckouts: () => [] }).kind).toBe(
      "present",
    );
  });

  it("prefers an explicit bundle and skips bundles for another Canvas commit", () => {
    const fresh = checkout("fresh");
    const stale = checkout("stale", { ...PIN, commit: "4".repeat(40) });
    const explicit = checkout("explicit", PIN);
    const outcome = ensureDevMossCanvasBundle({
      repoRoot: fresh,
      env: { [MOSS_DEV_CANVAS_BUNDLE_ENV]: Path.join(explicit, MOSS_CANVAS_BUNDLE_DIR) },
      listCheckouts: () => [stale],
    });
    expect(outcome).toMatchObject({ kind: "linked" });
    if (outcome.kind === "linked")
      expect(outcome.source.toLowerCase()).toContain(Path.basename(explicit).toLowerCase());
  });

  it("says how to prepare one when no checkout has it, without touching a real folder", () => {
    const fresh = checkout("fresh");
    const stale = checkout("stale", { ...PIN, commit: "4".repeat(40) });
    const missing = ensureDevMossCanvasBundle({ repoRoot: fresh, listCheckouts: () => [stale] });
    expect(missing.kind).toBe("missing");
    if (missing.kind === "missing") {
      expect(missing.message).toContain("prepare-moss-canvas-bundle.ts");
      expect(missing.message).toContain(PIN.commit);
    }
    expect(FS.existsSync(Path.join(fresh, MOSS_CANVAS_BUNDLE_DIR))).toBe(false);

    const ownStale = checkout("own-stale", { ...PIN, commit: "4".repeat(40) });
    const prepared = checkout("prepared", PIN);
    expect(
      ensureDevMossCanvasBundle({ repoRoot: ownStale, listCheckouts: () => [prepared] }).kind,
    ).toBe("missing");
    expect(FS.lstatSync(Path.join(ownStale, MOSS_CANVAS_BUNDLE_DIR)).isSymbolicLink()).toBe(false);
  });

  it("replaces its own link once it no longer matches the pin", () => {
    const fresh = checkout("fresh");
    const stale = checkout("stale", { ...PIN, commit: "4".repeat(40) });
    FS.mkdirSync(Path.join(fresh, Path.dirname(MOSS_CANVAS_BUNDLE_DIR)), { recursive: true });
    FS.symlinkSync(
      Path.join(stale, MOSS_CANVAS_BUNDLE_DIR),
      Path.join(fresh, MOSS_CANVAS_BUNDLE_DIR),
      process.platform === "win32" ? "junction" : "dir",
    );
    const prepared = checkout("prepared", PIN);
    expect(
      ensureDevMossCanvasBundle({ repoRoot: fresh, listCheckouts: () => [prepared] }).kind,
    ).toBe("linked");
    // The other checkout's bundle is never deleted through the link.
    expect(FS.existsSync(canvasIndex(stale))).toBe(true);
  });
});
