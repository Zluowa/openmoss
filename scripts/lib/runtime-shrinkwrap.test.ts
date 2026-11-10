import { createHash } from "node:crypto";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import * as Zlib from "node:zlib";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import {
  createRuntimeShrinkwrap,
  parseBunLockPackages,
  stripJsonTrailingCommas,
} from "./runtime-shrinkwrap.ts";

const integrity = (seed: string) => `sha512-${seed.repeat(8)}==`;
const URL_TARBALL = "https://pkg.example.test/u@abc123";
const BUN_LOCK = `{
  "lockfileVersion": 1,
  "packages": {
    "a": ["a@1.0.0", "", { "dependencies": { "b": "^2.0.0" }, "optionalDependencies": { "plat-x": "1.0.0" } }, "${integrity("a")}"],
    "a/b": ["b@2.0.0", "", {}, "${integrity("b")}"],
    "b": ["b@3.1.0", "", {}, "${integrity("c")}"],
    "plat-x": ["plat-x@1.0.0", "", { "os": "darwin", "cpu": ["arm64"], }, "${integrity("d")}"],
    "u": ["u@${URL_TARBALL}", { "dependencies": { "toml": "^3.0.0" } }, "${integrity("e")}"],
    "toml": ["toml@5.0.1", "", {}, "${integrity("f")}"],
    "@scope/w": ["@scope/w@workspace:packages/w"],
  },
}`;

let root: string;
function install(directory: string, manifest: Record<string, unknown>, files: string[] = []) {
  FS.mkdirSync(directory, { recursive: true });
  FS.writeFileSync(Path.join(directory, "package.json"), JSON.stringify(manifest));
  for (const file of files) FS.writeFileSync(Path.join(directory, file), "");
}
beforeEach(() => {
  root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-shrinkwrap-"));
  const modules = Path.join(root, "app", "node_modules");
  install(Path.join(modules, "a"), {
    name: "a",
    version: "1.0.0",
    dependencies: { b: "^2.0.0" },
    optionalDependencies: { "plat-x": "1.0.0" },
    bin: "cli.js",
  });
  // a needs b@2 while the package itself needs b@3: npm must nest a's copy.
  install(Path.join(modules, "a", "node_modules", "b"), { name: "b", version: "2.0.0" }, [
    "binding.gyp",
  ]);
  install(Path.join(modules, "b"), {
    name: "b",
    version: "3.1.0",
    scripts: { postinstall: "node setup.js" },
  });
  // A bun override resolved u's toml to 5.0.1 although u asks for ^3.0.0.
  install(Path.join(modules, "u"), {
    name: "u",
    version: "0.0.0-abc",
    dependencies: { toml: "^3.0.0" },
  });
  install(Path.join(modules, "toml"), { name: "toml", version: "5.0.1" });
});
afterEach(() => FS.rmSync(root, { recursive: true, force: true }));

const runtimeLock = (
  dependencies: Record<string, string> = { a: "^1.0.0", b: "^3.0.0", u: URL_TARBALL },
  patchedDependencies?: Record<string, string>,
) =>
  createRuntimeShrinkwrap({
    packageDirectory: Path.join(root, "app"),
    packageJson: { name: "@moss/cli", version: "1.0.5", dependencies },
    bunLock: parseBunLockPackages(BUN_LOCK),
    ...(patchedDependencies ? { patchedDependencies, patchRoot: root } : {}),
  });
const build = (dependencies?: Record<string, string>) => runtimeLock(dependencies).shrinkwrap;

/** Minimal ustar reader: file name -> contents. */
function readTarball(gzipped: Buffer): Map<string, string> {
  const tar = Zlib.gunzipSync(gzipped);
  const files = new Map<string, string>();
  for (let offset = 0; offset + 512 <= tar.length; ) {
    const header = tar.subarray(offset, offset + 512);
    if (header.every((byte) => byte === 0)) break;
    const text = (start: number, length: number) =>
      header
        .subarray(start, start + length)
        .toString("utf8")
        .split("\0")[0]!;
    const name = [text(345, 155), text(0, 100)].filter(Boolean).join("/");
    const size = Number.parseInt(text(124, 12), 8);
    files.set(name, tar.subarray(offset + 512, offset + 512 + size).toString("utf8"));
    offset += 512 + Math.ceil(size / 512) * 512;
  }
  return files;
}
function writePatch(name: string, file: string, added: string) {
  FS.mkdirSync(Path.join(root, "patches"), { recursive: true });
  FS.writeFileSync(
    Path.join(root, "patches", name),
    [`--- a/${file}`, `+++ b/${file}`, "@@ -1 +1,2 @@", " export {};", `+${added}`, ""].join("\n"),
  );
  return `patches/${name}`;
}

describe("runtime shrinkwrap from bun.lock", () => {
  it("parses bun.lock's trailing commas without touching commas inside strings", () => {
    expect(JSON.parse(stripJsonTrailingCommas('{"a": "x,}", "b": [1, 2,],}'))).toEqual({
      a: "x,}",
      b: [1, 2],
    });
  });

  it("pins every package to bun.lock's release, tarball and integrity in npm's layout", () => {
    const lock = build();
    expect(lock.lockfileVersion).toBe(3);
    expect(lock.packages[""]).toEqual({
      name: "@moss/cli",
      version: "1.0.5",
      dependencies: { a: "^1.0.0", b: "^3.0.0", u: URL_TARBALL },
    });
    expect(lock.packages["node_modules/a"]).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/a/-/a-1.0.0.tgz",
      integrity: integrity("a"),
      dependencies: { b: "2.0.0" },
      optionalDependencies: { "plat-x": "1.0.0" },
      bin: { a: "cli.js" },
    });
    expect(lock.packages["node_modules/a/node_modules/b"]).toMatchObject({
      version: "2.0.0",
      integrity: integrity("b"),
      hasInstallScript: true,
    });
    expect(lock.packages["node_modules/b"]).toMatchObject({
      version: "3.1.0",
      hasInstallScript: true,
    });
    expect(lock.packages["node_modules/u"]).toEqual({
      version: "0.0.0-abc",
      resolved: URL_TARBALL,
      integrity: integrity("e"),
      dependencies: { toml: "5.0.1" },
    });
  });

  it("takes an uninstalled optional platform package from bun.lock and marks it optional", () => {
    expect(build().packages["node_modules/plat-x"]).toEqual({
      version: "1.0.0",
      resolved: "https://registry.npmjs.org/plat-x/-/plat-x-1.0.0.tgz",
      integrity: integrity("d"),
      optional: true,
      os: ["darwin"],
      cpu: ["arm64"],
    });
  });

  it("ignores a stray copy of an optional platform package that Node's lookup reaches", () => {
    // bun skipped plat-x on this platform; an unrelated older copy sits higher up.
    install(Path.join(root, "node_modules", "plat-x"), { name: "plat-x", version: "0.9.0" });
    expect(build().packages["node_modules/plat-x"]).toMatchObject({
      version: "1.0.0",
      integrity: integrity("d"),
      optional: true,
    });
  });

  it("ships a patched direct dependency as its own tarball with its own integrity", () => {
    const modules = Path.join(root, "app", "node_modules");
    FS.writeFileSync(Path.join(modules, "b", "index.js"), "export {};\nguardPid(1);\n");
    FS.writeFileSync(Path.join(modules, "b", ".bun-tag"), "");
    const lock = runtimeLock(undefined, {
      "b@3.1.0": writePatch("b.patch", "index.js", "guardPid(1);"),
      "not-in-runtime@1.0.0": "patches/unused.patch",
    });
    expect(lock.files.map((file) => file.path)).toEqual(["patched/b-3.1.0.tgz"]);
    const tarball = lock.files[0]!.contents;
    expect(lock.shrinkwrap.packages["node_modules/b"]).toMatchObject({
      version: "3.1.0",
      resolved: "file:patched/b-3.1.0.tgz",
      integrity: `sha512-${createHash("sha512").update(tarball).digest("base64")}`,
    });
    expect(lock.dependencies.b).toBe("file:patched/b-3.1.0.tgz");
    expect((lock.shrinkwrap.packages[""] as { dependencies: unknown }).dependencies).toEqual(
      lock.dependencies,
    );
    const contents = readTarball(tarball);
    expect(contents.get("package/index.js")).toContain("guardPid(1);");
    expect([...contents.keys()].toSorted()).toEqual(["package/index.js", "package/package.json"]);
  });

  it("points a nested patched dependency at the tarball relative to its dependent", () => {
    const nested = Path.join(root, "app", "node_modules", "a", "node_modules", "b");
    FS.writeFileSync(Path.join(nested, "index.js"), "export {};\nkeepGroup();\n");
    const lock = runtimeLock(undefined, {
      "b@2.0.0": writePatch("b2.patch", "index.js", "keepGroup();"),
    }).shrinkwrap;
    expect(lock.packages["node_modules/a/node_modules/b"]).toMatchObject({
      resolved: "file:patched/b-2.0.0.tgz",
    });
    expect((lock.packages["node_modules/a"] as { dependencies: unknown }).dependencies).toEqual({
      b: "file:../../patched/b-2.0.0.tgz",
    });
    // The unpatched b@3.1.0 keeps its registry tarball.
    expect(lock.packages["node_modules/b"]).toMatchObject({
      resolved: "https://registry.npmjs.org/b/-/b-3.1.0.tgz",
    });
  });

  it("fails the pack when an installed runtime copy does not carry its patch", () => {
    FS.writeFileSync(Path.join(root, "app", "node_modules", "b", "index.js"), "export {};\n");
    expect(() =>
      runtimeLock(undefined, { "b@3.1.0": writePatch("b.patch", "index.js", "guardPid(1);") }),
    ).toThrow(/b@3\.1\.0 does not carry its patch/u);
  });

  it("fails instead of writing a lock that npm could not reproduce", () => {
    install(Path.join(root, "app", "node_modules", "toml"), { name: "toml", version: "9.9.9" });
    expect(() => build()).toThrow(/toml@9\.9\.9.*no bun\.lock integrity/u);
    expect(() => build({ missing: "^1.0.0" })).toThrow(/'missing' is not installed/u);
  });
});
