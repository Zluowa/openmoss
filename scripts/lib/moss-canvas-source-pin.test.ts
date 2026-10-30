import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { afterEach, describe, it, expect } from "vitest";
import {
  MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
  prepareMossCanvasBundle,
} from "./bundled-moss-canvas.ts";
import {
  readMossCanvasSourcePin,
  validatePinnedMossCanvasBundle,
  type MossCanvasSourcePin,
} from "./moss-canvas-source-pin.ts";
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
const pin: MossCanvasSourcePin = {
  repository: "Zluowa/open-hoola-canvas",
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  lockfileSha256: "c".repeat(64),
};
const directory = () => {
  const root = mkdtempSync(join(tmpdir(), "moss-canvas-pin-"));
  roots.push(root);
  return root;
};
function fixture() {
  const root = directory(),
    source = join(root, "source"),
    target = join(root, "canvas-bundle");
  for (const name of [...MOSS_CANVAS_BUNDLE_REQUIRED_PATHS, "COMMERCIAL_LICENSE.md"]) {
    const file = join(source, name);
    mkdirSync(dirname(file), { recursive: true });
    writeFileSync(file, "fixture\n");
  }
  return { source, target };
}
describe("Moss Canvas source pin", () => {
  it("accepts the matching reviewed source and complete bundle receipt", () => {
    const { source, target } = fixture();
    const prepared = prepareMossCanvasBundle({
      sourceDir: source,
      targetDir: target,
      sourcePin: pin,
    });
    expect(validatePinnedMossCanvasBundle(target, pin).sha256).toBe(prepared.sha256);
  });
  it("rejects renderer tampering and a bundle from a different Canvas commit", () => {
    const { source, target } = fixture();
    prepareMossCanvasBundle({ sourceDir: source, targetDir: target, sourcePin: pin });
    expect(() =>
      validatePinnedMossCanvasBundle(target, { ...pin, commit: "d".repeat(40) }),
    ).toThrow(/pinned source/u);
    writeFileSync(join(target, "apps/codex-canvas/dist/index.html"), "different renderer");
    expect(() => validatePinnedMossCanvasBundle(target, pin)).toThrow(/build receipt/u);
  });
  it("rejects mutable refs and an unrelated source repository", () => {
    const root = directory();
    mkdirSync(join(root, "scripts/lib"), { recursive: true });
    for (const invalid of [
      { ...pin, commit: "main" },
      { ...pin, repository: "another/source" },
    ]) {
      writeFileSync(join(root, "scripts/lib/moss-canvas-source-pin.json"), JSON.stringify(invalid));
      expect(() => readMossCanvasSourcePin(root)).toThrow(/pin is invalid/u);
    }
  });
});
