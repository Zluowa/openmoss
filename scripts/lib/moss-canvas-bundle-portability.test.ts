import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  MOSS_CANVAS_BUNDLE_HASH_ALGORITHM,
  MOSS_CANVAS_BUNDLE_RECEIPT,
  MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
  prepareMossCanvasBundle,
} from "./bundled-moss-canvas.ts";
import { validatePinnedMossCanvasBundle } from "./moss-canvas-source-pin.ts";

const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const pin = {
  repository: "Zluowa/open-hoola-canvas" as const,
  commit: "a".repeat(40),
  tree: "b".repeat(40),
  lockfileSha256: "c".repeat(64),
};
// Frozen from the actual unchanged 0e296cc2f writer on Darwin/Node24.13.1
// under en-US and zh-CN; the baseline rejects each opposite-locale receipt.
const LEGACY = {
  en: "325e54e6393d88f761db2e19b8cee2389de3b7d4159881c35c8e9d46408cc888",
  zh: "ca78b53cd0d7185c2f068735e5f8fa95c718b3eb40b0df326054cb5191b1b8ad",
};
// Independently calculated by Python over the specified UTF-8 path order.
const UTF8 = "2fc7ab0e9cd5d68ceff1802ce2f55d3fdbd90a8a400c8ff21bf54df7323a8076";
function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-canvas-portable-"));
  roots.push(root);
  const source = path.join(root, "source"),
    target = path.join(root, "bundle");
  for (const name of [
    ...MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
    "COMMERCIAL_LICENSE.md",
    ...["z.js", "中.js", "ä.js", "阿.js", "A.js", "_chunk.js"].map(
      (name) => `apps/codex-canvas/dist/assets/${name}`,
    ),
  ]) {
    const file = path.join(source, name);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, "fixture\n");
  }
  prepareMossCanvasBundle({ sourceDir: source, targetDir: target, sourcePin: pin });
  return { root, source, target, receipt: path.join(target, MOSS_CANVAS_BUNDLE_RECEIPT) };
}
function child(action: string, locale: string, source: string, target: string) {
  const driver = fileURLToPath(
    new URL("../fixtures/canvas-bundle-portability-driver.mjs", import.meta.url),
  );
  const repo = fileURLToPath(new URL("../../", import.meta.url));
  const env = Object.fromEntries(
    Object.entries(process.env).filter(
      ([key]) => !["NODE_OPTIONS", "NODE_PATH", "BUN_OPTIONS"].includes(key.toUpperCase()),
    ),
  );
  const result = spawnSync(process.execPath, [driver, action, repo, source, target], {
    env: { ...env, LANG: locale, LC_ALL: locale, NODE_NO_WARNINGS: "1" },
    encoding: "utf8",
    timeout: 15_000,
  });
  expect(result.error).toBeUndefined();
  return {
    exit: result.status,
    value: JSON.parse(result.stdout) as {
      ok: boolean;
      locale: string;
      error?: string;
      result?: { sha256: string };
    },
  };
}
describe("portable Canvas bundle receipts", () => {
  it("writes the versioned byte-order digest rather than either frozen locale digest", () => {
    const f = fixture();
    const receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    expect(receipt).toMatchObject({
      hashAlgorithm: MOSS_CANVAS_BUNDLE_HASH_ALGORITHM,
      fileCount: 17,
      sha256: UTF8,
    });
    expect(validatePinnedMossCanvasBundle(f.target, pin).sha256).toBe(UTF8);
    expect(Object.values(LEGACY)).not.toContain(UTF8);
  });
  it.each(["en_US.UTF-8", "zh_CN.UTF-8"])(
    "writes and reads the same digest in a real %s process",
    (locale) => {
      const f = fixture(),
        other = path.join(f.root, "other");
      const prepared = child("prepare", locale, f.source, other);
      expect(prepared).toMatchObject({ exit: 0, value: { ok: true, result: { sha256: UTF8 } } });
      expect(child("validate", locale, f.source, f.target)).toMatchObject({
        exit: 0,
        value: { ok: true, result: { sha256: UTF8 } },
      });
      // Windows obtains its default locale from the OS. Darwin honors LANG;
      // prove both actual locale contexts there without adding platform skips.
      if (process.platform === "darwin")
        expect(prepared.value.locale).toBe(locale.startsWith("en") ? "en-US" : "zh-CN");
    },
  );
  it.each(Object.entries(LEGACY))(
    "strictly accepts frozen %s legacy receipts in both locale processes without rewriting them",
    (_tag, hash) => {
      const f = fixture();
      fs.writeFileSync(f.receipt, JSON.stringify({ sourcePin: pin, fileCount: 17, sha256: hash }));
      const original = fs.readFileSync(f.receipt);
      for (const locale of ["en_US.UTF-8", "zh_CN.UTF-8"]) {
        expect(child("validate", locale, f.source, f.target)).toMatchObject({
          exit: 0,
          value: { ok: true, result: { sha256: hash } },
        });
      }
      expect(fs.readFileSync(f.receipt).equals(original)).toBe(true);
    },
  );
  it.each(Object.entries(LEGACY))(
    "rejects payload, count, and source tampering for %s legacy receipts",
    (_tag, hash) => {
      const f = fixture();
      const write = (extra: Record<string, unknown>) =>
        fs.writeFileSync(
          f.receipt,
          JSON.stringify({ sourcePin: pin, fileCount: 17, sha256: hash, ...extra }),
        );
      write({ fileCount: 16 });
      expect(() => validatePinnedMossCanvasBundle(f.target, pin)).toThrow(/build receipt/u);
      write({ sourcePin: { ...pin, commit: "d".repeat(40) } });
      expect(() => validatePinnedMossCanvasBundle(f.target, pin)).toThrow(/pinned source/u);
      write({});
      fs.writeFileSync(path.join(f.target, "apps/codex-canvas/dist/index.html"), "tampered\n");
      expect(() => validatePinnedMossCanvasBundle(f.target, pin)).toThrow(/build receipt/u);
    },
  );
  it("refuses an unknown or misleading version marker", () => {
    const f = fixture(),
      receipt = JSON.parse(fs.readFileSync(f.receipt, "utf8"));
    fs.writeFileSync(f.receipt, JSON.stringify({ ...receipt, hashAlgorithm: "unknown" }));
    expect(() => validatePinnedMossCanvasBundle(f.target, pin)).toThrow(
      /unsupported hash algorithm/u,
    );
    fs.writeFileSync(f.receipt, JSON.stringify({ ...receipt, sha256: LEGACY.zh }));
    expect(() => validatePinnedMossCanvasBundle(f.target, pin)).toThrow(/build receipt/u);
  });
});
