import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import * as asar from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

import {
  asarIntegrity,
  encodeAsarHeader,
  findAsarNode,
  isAsarDirectory,
  readAsarArchive,
  spliceAsar,
  walkAsarFiles,
  type AsarFileEntry,
} from "./asar-splice.ts";

const sha = (bytes: Buffer | string) => createHash("sha256").update(bytes).digest("hex");
// @electron/asar splits archive paths on the platform separator.
const extract = (archive: string, archivePath: string) =>
  asar.extractFile(archive, archivePath.split("/").join(path.sep));
const temps: string[] = [];
afterEach(async () => {
  for (const dir of temps.splice(0)) await rm(dir, { recursive: true, force: true });
});

async function tree(root: string, files: Record<string, string | Buffer>): Promise<void> {
  for (const [relative, contents] of Object.entries(files)) {
    const file = path.join(root, ...relative.split("/"));
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, contents);
  }
}

async function fixture() {
  const dir = await mkdtemp(path.join(tmpdir(), "moss-asar-splice-"));
  temps.push(dir);
  const app = path.join(dir, "app");
  const big = Buffer.alloc(5 * 1024 * 1024 + 17, 7); // spans two integrity blocks
  await tree(app, {
    "package.json": JSON.stringify({ name: "moss-desktop", mossCommitHash: "a".repeat(40) }),
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "node_modules/dep/empty.txt": "",
    "node_modules/native/build/addon.node": "native bytes",
    "node_modules/zz/big.bin": big,
    "apps/desktop/dist-electron/main.js": "old main\n",
    "apps/server/dist/index.mjs": "old server\n",
    "apps/server/dist/client/index.html": "<p>old</p>",
    "apps/server/dist/client/assets/old-123.js": "old asset",
    "apps/desktop/canvas-bundle/receipt.json": "{}",
  });
  const base = path.join(dir, "base.asar");
  await asar.createPackageWithOptions(app, base, { unpack: "*.node" });
  const build = path.join(dir, "build");
  await tree(build, {
    "dist-electron/main.js": "new main\n",
    "server/index.mjs": "new server\n",
    "server/index.cjs": "new cjs\n",
    "server/client/index.html": "<p>new</p>",
    "server/client/assets/new-456.js": "new asset",
  });
  return { dir, app, base, build, big };
}

describe("spliceAsar", () => {
  it("replaces whole subtrees and files while every kept file reads back byte for byte", async () => {
    const f = await fixture();
    const output = path.join(f.dir, "out.asar");
    const pkg = Buffer.from(
      JSON.stringify({ name: "moss-desktop", mossCommitHash: "b".repeat(40) }),
    );
    const report = await spliceAsar({
      base: f.base,
      output,
      replaceDirectories: {
        "apps/desktop/dist-electron": path.join(f.build, "dist-electron"),
        "apps/server/dist": path.join(f.build, "server"),
      },
      replaceFiles: { "package.json": pkg },
    });

    const read = (p: string) => extract(output, p);
    expect(read("apps/desktop/dist-electron/main.js").toString()).toBe("new main\n");
    expect(read("apps/server/dist/index.cjs").toString()).toBe("new cjs\n");
    expect(read("apps/server/dist/client/assets/new-456.js").toString()).toBe("new asset");
    expect(read("package.json")).toEqual(pkg);
    expect(read("node_modules/dep/index.js").toString()).toBe("module.exports = 1;\n");
    expect(read("node_modules/dep/empty.txt").length).toBe(0);
    expect(read("apps/desktop/canvas-bundle/receipt.json").toString()).toBe("{}");
    expect(sha(read("node_modules/zz/big.bin"))).toBe(sha(f.big));

    const listed = asar.listPackage(output, { isPack: false }).map((p) => p.replaceAll("\\", "/"));
    expect(listed).not.toContain("/apps/server/dist/client/assets/old-123.js");
    expect(listed).toContain("/apps/server/dist/client/assets/new-456.js");

    expect(report.newFiles).toBe(6);
    expect(report.removedFiles).toBe(5);
    expect(report.written["apps/server/dist/index.mjs"]).toBe(sha("new server\n"));
    // No stale bytes: the archive is exactly header + kept + new.
    const archive = await readAsarArchive(output);
    expect(archive.fileSize).toBe(archive.dataStart + report.keptBytes + report.newBytes);
  });

  it("keeps unpacked records untouched and writes electron-builder integrity for new files", async () => {
    const f = await fixture();
    const output = path.join(f.dir, "out2.asar");
    await spliceAsar({
      base: f.base,
      output,
      replaceDirectories: { "apps/server/dist": path.join(f.build, "server") },
    });
    const before = await readAsarArchive(f.base);
    const after = await readAsarArchive(output);
    const addonBefore = findAsarNode(before.header, "node_modules/native/build/addon.node");
    const addonAfter = findAsarNode(after.header, "node_modules/native/build/addon.node");
    expect(addonAfter).toEqual(addonBefore);
    expect((addonAfter as AsarFileEntry).unpacked).toBe(true);

    const mainBefore = findAsarNode(
      before.header,
      "apps/desktop/dist-electron/main.js",
    ) as AsarFileEntry;
    const mainAfter = findAsarNode(
      after.header,
      "apps/desktop/dist-electron/main.js",
    ) as AsarFileEntry;
    expect(mainAfter.integrity).toEqual(mainBefore.integrity);

    const html = findAsarNode(after.header, "apps/server/dist/client/index.html") as AsarFileEntry;
    expect(html.integrity).toEqual(asarIntegrity(Buffer.from("<p>new</p>")));
    // Same integrity record as @electron/asar writes for the same bytes in the base.
    const big = findAsarNode(after.header, "node_modules/zz/big.bin") as AsarFileEntry;
    expect(big.integrity).toEqual(asarIntegrity(f.big));
    expect(big.integrity!.blocks).toHaveLength(2);
  });

  it("is the identity when the replacement equals the base contents", async () => {
    const f = await fixture();
    const output = path.join(f.dir, "same.asar");
    await spliceAsar({
      base: f.base,
      output,
      replaceDirectories: { "apps/server/dist": path.join(f.app, "apps/server/dist") },
    });
    const before = await readAsarArchive(f.base);
    const after = await readAsarArchive(output);
    const files = (header: typeof before.header) =>
      Object.fromEntries(
        [...walkAsarFiles(header)].map(({ path: p, entry }) => [
          p,
          "integrity" in entry ? entry.integrity?.hash : "unpacked" in entry ? "unpacked" : "link",
        ]),
      );
    expect(files(after.header)).toEqual(files(before.header));
    for (const { path: p, entry } of walkAsarFiles(after.header)) {
      if ("unpacked" in entry && entry.unpacked) continue;
      expect(sha(extract(output, p))).toBe(sha(extract(f.base, p)));
    }
  });

  it("refuses to replace a tree that holds unpacked files, a missing path, or a symlinked source", async () => {
    const f = await fixture();
    const output = path.join(f.dir, "bad.asar");
    await expect(
      spliceAsar({ base: f.base, output, replaceDirectories: { "node_modules/native": f.build } }),
    ).rejects.toThrow(/app\.asar\.unpacked/);
    await expect(
      spliceAsar({ base: f.base, output, replaceDirectories: { "apps/nope": f.build } }),
    ).rejects.toThrow(/no directory apps\/nope/);
    await expect(
      spliceAsar({ base: f.base, output, replaceDirectories: { "apps/../x": f.build } }),
    ).rejects.toThrow(/unsafe archive path/);
    await expect(
      spliceAsar({ base: f.base, output, replaceFiles: { "missing.json": Buffer.from("{}") } }),
    ).rejects.toThrow(/no file missing\.json/);
  });

  it("encodes the header exactly as @electron/asar does", async () => {
    const f = await fixture();
    const archive = await readAsarArchive(f.base);
    const raw = await readFile(f.base);
    expect(encodeAsarHeader(archive.header)).toEqual(raw.subarray(0, archive.dataStart));
    expect(isAsarDirectory(archive.header)).toBe(true);
  });
});
