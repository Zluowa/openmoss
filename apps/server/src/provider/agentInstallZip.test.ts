import * as FS from "node:fs/promises";
import * as Path from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it } from "vitest";
import { extractAgentZip } from "./agentInstallZip.ts";
import { syntheticAgentZip } from "./agentInstallZip.testHelpers.ts";

const roots: string[] = [];
async function destination() {
  const root = await FS.mkdtemp(Path.join(tmpdir(), "moss-zip-"));
  roots.push(root);
  return root;
}
afterEach(async () => {
  for (const root of roots.splice(0)) await FS.rm(root, { recursive: true, force: true });
});

describe("bounded native agent ZIP", () => {
  it("extracts stored, deflated and deep paths without invoking an external extractor", async () => {
    const root = await destination();
    const deep = `${"node_modules/nested/".repeat(12)}index.js`;
    const archive = syntheticAgentZip([
      { name: "dist-package/lib/" },
      { name: "dist-package/node.exe", content: "fake exe" },
      { name: "dist-package/lib/index.js", content: "fake js", deflate: true },
      { name: `dist-package/${deep}`, content: "deep" },
    ]);
    expect(await extractAgentZip(archive, root)).toBe(3);
    expect(await FS.readFile(Path.join(root, "lib/index.js"), "utf8")).toBe("fake js");
    expect(await FS.readFile(Path.join(root, deep), "utf8")).toBe("deep");
  });

  it.each([
    "../outside",
    "/absolute",
    "C:/drive",
    "//server/share",
    "other/file",
    "dist-package/../escape",
    "dist-package/a/../../escape",
    "dist-package/a\\..\\escape",
    "dist-package/file:stream",
    "dist-package/CON",
    "dist-package/aux.txt",
    "dist-package/COM1.exe",
    "dist-package/a.",
    "dist-package/a ",
    "dist-package/a\0b",
    "dist-package//a",
    "dist-package/./a",
  ])("rejects unsafe path %s before writing any entry", async (name) => {
    const root = await destination();
    const archive = syntheticAgentZip([
      { name: "dist-package/good", content: "must not be written" },
      { name, content: "bad" },
    ]);
    await expect(extractAgentZip(archive, root)).rejects.toThrow();
    expect(await FS.readdir(root)).toEqual([]);
  });

  it.each(
    [
      [{ name: "dist-package/A" }, { name: "dist-package/a" }],
      [{ name: "dist-package/a" }, { name: "dist-package/a/child" }],
      [{ name: "dist-package/link", attributes: (0xa1ff << 16) >>> 0 }],
      [{ name: "dist-package/device", attributes: (0x21ff << 16) >>> 0 }],
      [{ name: "dist-package/reparse", attributes: 0x400 }],
    ].map((entries) => ({ entries })),
  )("rejects ambiguous or special entries %#", async ({ entries }) => {
    const root = await destination();
    await expect(extractAgentZip(syntheticAgentZip(entries), root)).rejects.toThrow();
    expect(await FS.readdir(root)).toEqual([]);
  });

  it.each(["crc", "method", "encrypted", "local-name", "truncated", "oversized", "zip64"])(
    "rejects malformed %s",
    async (kind) => {
      const root = await destination();
      let archive = syntheticAgentZip([{ name: "dist-package/index.js", content: "hello" }]);
      const central = archive.readUInt32LE(archive.length - 6);
      if (kind === "crc") {
        const offset = 30 + "dist-package/index.js".length;
        archive[offset] = archive[offset]! ^ 1;
      }
      if (kind === "method") archive.writeUInt16LE(99, central + 10);
      if (kind === "encrypted") archive.writeUInt16LE(1, central + 8);
      if (kind === "local-name") archive[30] = 0x65;
      if (kind === "truncated") archive = archive.subarray(0, archive.length - 1);
      if (kind === "oversized") archive.writeUInt32LE(0x40000000, central + 24);
      if (kind === "zip64") archive.writeUInt32LE(0xffffffff, archive.length - 6);
      await expect(extractAgentZip(archive, root)).rejects.toThrow();
      expect(await FS.readdir(root)).toEqual([]);
    },
  );

  it("rejects a populated destination without replacing existing data", async () => {
    const root = await destination();
    await FS.writeFile(Path.join(root, "keep"), "original");
    await expect(
      extractAgentZip(syntheticAgentZip([{ name: "dist-package/keep", content: "bad" }]), root),
    ).rejects.toThrow();
    expect(await FS.readFile(Path.join(root, "keep"), "utf8")).toBe("original");
  });

  it("rejects a compression bomb before creating files", async () => {
    const root = await destination();
    const archive = syntheticAgentZip([
      { name: "dist-package/bomb", content: "a".repeat(4_000_000), deflate: true },
    ]);
    await expect(extractAgentZip(archive, root)).rejects.toThrow(/compression ratio/u);
    expect(await FS.readdir(root)).toEqual([]);
  });

  it("refuses a linked destination without writing into its target", async () => {
    const root = await destination();
    const outside = await destination();
    const link = Path.join(root, "linked");
    await FS.symlink(outside, link, process.platform === "win32" ? "junction" : "dir");
    await expect(
      extractAgentZip(syntheticAgentZip([{ name: "dist-package/file", content: "bad" }]), link),
    ).rejects.toThrow(/fresh/u);
    expect(await FS.readdir(outside)).toEqual([]);
  });
});
