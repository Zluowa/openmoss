import { mkdtempSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import {
  collectEffectPatchTargets,
  patchEffectWorkspaceTypescript,
} from "./patch-effect-language-service";

const temporaryRoots: string[] = [];

function json(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, JSON.stringify(value));
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), "moss effect patch "));
  temporaryRoots.push(root);
  json(join(root, "package.json"), { private: true, workspaces: { packages: ["packages/*"] } });
  writeFileSync(join(root, "events.jsonl"), "");
  return root;
}

function compiler(root: string, name = "typescript") {
  const directory = join(root, "installed", name);
  json(join(directory, "package.json"), { name: "typescript", version: "5.9.3" });
  return directory;
}

function languageService(root: string, name = "effect", version = "0.75.1", exitCode = 0) {
  const directory = join(root, "installed", name);
  json(join(directory, "package.json"), { name: "@effect/language-service", version });
  writeFileSync(
    join(directory, "cli.js"),
    `const fs = require("node:fs");
const events = ${JSON.stringify(join(root, "events.jsonl"))};
const active = ${JSON.stringify(join(root, "active"))};
const args = process.argv.slice(2);
if (args[0] !== "patch" || args[1] !== "--dir" || args.length !== 3) process.exit(94);
const lock = fs.openSync(active, "wx");
fs.appendFileSync(events, JSON.stringify({phase:"start",dir:args[2]})+"\\n");
Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 25);
fs.appendFileSync(events, JSON.stringify({phase:"end",dir:args[2]})+"\\n");
fs.closeSync(lock); fs.unlinkSync(active);
process.exit(${exitCode});
`,
  );
  return directory;
}

function workspace(root: string, name: string, ts?: string, effect?: string) {
  const directory = join(root, "packages", name);
  json(join(directory, "package.json"), {
    name,
    devDependencies: { typescript: "5.9.3", "@effect/language-service": "0.75.1" },
  });
  for (const [packageName, target] of [
    ["typescript", ts],
    ["@effect/language-service", effect],
  ]) {
    if (!target || !packageName) continue;
    const link = join(directory, "node_modules", packageName);
    mkdirSync(dirname(link), { recursive: true });
    symlinkSync(target, link, "junction");
  }
  return directory;
}

function events(root: string) {
  return readFileSync(join(root, "events.jsonl"), "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as { phase: string; dir: string });
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe("root Effect TypeScript patch installation", () => {
  it("patches five workspace links to one physical compiler exactly once", () => {
    const root = fixture();
    const ts = compiler(root);
    const effect = languageService(root);
    for (let i = 0; i < 5; i++) workspace(root, `workspace-${i}`, ts, effect);
    expect(collectEffectPatchTargets(root)).toHaveLength(1);
    expect(patchEffectWorkspaceTypescript(root)).toBe(0);
    expect(events(root)).toEqual([
      { phase: "start", dir: ts },
      { phase: "end", dir: ts },
    ]);
  });

  it("runs separate physical compilers sequentially with no overlapping writer", () => {
    const root = fixture();
    const effect = languageService(root);
    const first = compiler(root, "typescript-first");
    const second = compiler(root, "typescript-second");
    workspace(root, "first", first, effect);
    workspace(root, "second", second, effect);
    expect(patchEffectWorkspaceTypescript(root)).toBe(0);
    expect(events(root)).toEqual([
      { phase: "start", dir: first },
      { phase: "end", dir: first },
      { phase: "start", dir: second },
      { phase: "end", dir: second },
    ]);
  });

  it("supports filtered installs without skipping an installed workspace", () => {
    const root = fixture();
    workspace(root, "not-installed");
    workspace(root, "scripts-only", compiler(root), languageService(root));
    expect(collectEffectPatchTargets(root)).toHaveLength(1);
    expect(patchEffectWorkspaceTypescript(root)).toBe(0);
    expect(events(root)).toHaveLength(2);
  });

  it.each(["typescript", "language-service"])(
    "rejects a partially installed %s toolchain",
    (missing) => {
      const root = fixture();
      workspace(
        root,
        "partial",
        missing === "typescript" ? undefined : compiler(root),
        missing === "language-service" ? undefined : languageService(root),
      );
      expect(() => patchEffectWorkspaceTypescript(root)).toThrow(
        "Incomplete Effect TypeScript toolchain",
      );
      expect(events(root)).toEqual([]);
    },
  );

  it("rejects conflicting patch versions before touching their shared compiler", () => {
    const root = fixture();
    const ts = compiler(root);
    workspace(root, "first", ts, languageService(root));
    workspace(root, "second", ts, languageService(root, "other", "0.74.0"));
    expect(() => patchEffectWorkspaceTypescript(root)).toThrow(
      "Conflicting Effect language-service versions",
    );
    expect(events(root)).toEqual([]);
  });

  it("propagates a patch failure and does not continue to another compiler", () => {
    const root = fixture();
    const first = compiler(root, "typescript-first");
    workspace(root, "first", first, languageService(root, "failing", "0.75.1", 23));
    workspace(root, "second", compiler(root, "typescript-second"), languageService(root));
    expect(patchEffectWorkspaceTypescript(root)).toBe(23);
    expect(events(root)).toEqual([
      { phase: "start", dir: first },
      { phase: "end", dir: first },
    ]);
  });

  it("keeps Effect and native patches in root postinstall and removes concurrent workspace writers", () => {
    const root = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8"));
    expect(root.scripts.postinstall).toBe(
      "node scripts/patch-effect-language-service.ts && effect-tsgo patch --typescript --typescript-package @typescript/native",
    );
    for (const path of [
      "apps/server",
      "apps/web",
      "packages/contracts",
      "packages/shared",
      "scripts",
    ]) {
      const manifest = JSON.parse(
        readFileSync(new URL(`../${path}/package.json`, import.meta.url), "utf8"),
      );
      expect(manifest.scripts.prepare).toBeUndefined();
    }
  });
});
