import { createHash } from "node:crypto";
import * as fs from "node:fs";
import { createRequire } from "node:module";
import os from "node:os";
import path from "node:path";
import { finished } from "node:stream/promises";

import * as asar from "@electron/asar";
import { afterEach, describe, expect, it } from "vitest";

import { createDirectoryAlias, createRejectedFileAlias } from "../fixtures/filesystem-links";
import {
  bindMacBuildOnlyAsarSigning,
  encodeAsarHeader,
  parseAsarHeader,
  verifyPackagedAsarIntegrity,
  type AsarSigningHooks,
} from "./mac-asar-integrity.mjs";

const require = createRequire(import.meta.url);
const fromBuilder = createRequire(require.resolve("electron-builder/package.json"));
const plist = fromBuilder("plist") as {
  build: (value: Record<string, unknown>) => string;
  parse: (value: string) => Record<string, unknown>;
};
const roots: string[] = [];
afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});
const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

function nativeBytes(signatureBytes = 0): Buffer {
  const bytes = Buffer.alloc(128 + signatureBytes, 0x2a);
  bytes.fill(0, 0, 104);
  bytes.writeUInt32LE(0xfeedfacf, 0);
  bytes.writeUInt32LE(0x0100000c, 4);
  bytes.writeUInt32LE(1, 16);
  bytes.writeUInt32LE(72, 20);
  bytes.writeUInt32LE(0x19, 32);
  bytes.writeUInt32LE(72, 36);
  bytes.write("__LINKEDIT", 40, "ascii");
  bytes.writeBigUInt64LE(BigInt(4096 + signatureBytes), 64);
  bytes.writeBigUInt64LE(104n, 72);
  bytes.writeBigUInt64LE(BigInt(24 + signatureBytes), 80);
  return bytes;
}

// The unit signer only models the permitted transformation. The separate macOS
// fixture executes real clang/codesign and the actual private signing CLI.
const unitSigner: NonNullable<AsarSigningHooks["runCommand"]> = (command, args) => {
  expect(command).toBe("/usr/bin/codesign");
  if (args[0] === "--remove-signature") {
    const temporary = args[1]!;
    expect(path.basename(path.dirname(temporary))).toMatch(/^moss-asar-signature-/u);
    const bytes = fs.readFileSync(temporary).subarray(0, 128);
    bytes.writeBigUInt64LE(24n, 80);
    fs.writeFileSync(temporary, bytes);
  } else {
    expect(args.slice(0, 3)).toEqual(["--verify", "--strict", "--verbose=4"]);
  }
  return { status: 0 };
};

async function fixture() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "moss-asar-integrity-test-"));
  roots.push(root);
  const app = path.join(root, "Moss.app");
  const resources = path.join(app, "Contents/Resources");
  const source = path.join(root, "input");
  fs.mkdirSync(path.join(source, "unpacked"), { recursive: true });
  fs.mkdirSync(resources, { recursive: true });
  fs.writeFileSync(path.join(source, "main.js"), "module.exports = 42;\n");
  fs.writeFileSync(path.join(source, "empty.txt"), "");
  fs.writeFileSync(path.join(source, "exact-block.bin"), Buffer.alloc(4 * 1024 * 1024, 7));
  fs.writeFileSync(path.join(source, "unpacked/engine.node"), nativeBytes(), { mode: 0o755 });
  fs.writeFileSync(path.join(source, "unpacked/stable.bin"), "ordinary immutable bytes");
  const archive = path.join(resources, "app.asar");
  await finished(await asar.createPackageWithOptions(source, archive, { unpackDir: "unpacked" }));
  const raw = asar.getRawHeader(archive);
  const info = path.join(app, "Contents/Info.plist");
  fs.writeFileSync(
    info,
    plist.build({
      CFBundleIdentifier: "test.moss.asar",
      PreserveThis: { nested: ["a", 0, false] },
      ElectronAsarIntegrity: {
        "Resources/app.asar": { algorithm: "SHA256", hash: sha(Buffer.from(raw.headerString)) },
      },
    }),
  );
  return {
    root,
    app,
    archive,
    info,
    resources,
    native: path.join(`${archive}.unpacked`, "unpacked/engine.node"),
    ordinary: path.join(`${archive}.unpacked`, "unpacked/stable.bin"),
  };
}

function headerAndPayload(archive: string) {
  const bytes = fs.readFileSync(archive);
  const offset = 8 + bytes.readUInt32LE(4);
  return {
    parsed: parseAsarHeader(bytes.subarray(0, offset), bytes.length),
    payload: bytes.subarray(offset),
    prefix: bytes.subarray(0, offset),
  };
}

describe("build-only ASAR metadata binding", () => {
  it("ignores only bound non-native unpacked files and still rejects their replacement", async () => {
    const f = await fixture();
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    expect(binding.shouldIgnoreFile(f.ordinary)).toBe(true);
    expect(binding.shouldIgnoreFile(f.native)).toBe(false);
    expect(binding.shouldIgnoreFile(f.app)).toBe(false);
    expect(binding.shouldIgnoreFile(path.dirname(f.ordinary))).toBe(false);
    expect(binding.shouldIgnoreFile(`${f.ordinary}.unbound`)).toBe(false);
    const retained = path.join(f.root, "original-stable.bin");
    fs.renameSync(f.ordinary, retained);
    fs.copyFileSync(retained, f.ordinary);
    expect(() => binding.shouldIgnoreFile(f.ordinary)).toThrow(/changed/u);
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
  });

  it("agrees with the pinned ASAR writer for empty and exact-block files", async () => {
    const f = await fixture();
    const verified = verifyPackagedAsarIntegrity(f.app);
    expect(verified).toMatchObject({ packedFiles: 3, unpackedFiles: 2 });
    const parsed = headerAndPayload(f.archive).parsed;
    expect(
      parsed.entries.find((entry) => entry.path === "exact-block.bin")?.node.integrity,
    ).toMatchObject({
      blocks: [sha(Buffer.alloc(4 * 1024 * 1024, 7)), sha(Buffer.alloc(0))],
    });
  });

  it("updates native size/full and block hashes, retains offsets/payload, and survives repeated callbacks", async () => {
    const f = await fixture();
    const before = headerAndPayload(f.archive);
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    fs.writeFileSync(f.native, nativeBytes(4 * 1024 * 1024));
    expect(() => verifyPackagedAsarIntegrity(f.app)).toThrow(/unpacked file hash mismatch/u);
    expect(binding.refresh()).toMatchObject({ refreshCount: 1, changedNativeFiles: 1 });
    const after = headerAndPayload(f.archive);
    expect(after.prefix.length).toBeGreaterThan(before.prefix.length);
    expect(after.payload.equals(before.payload)).toBe(true);
    expect(after.parsed.entries.filter((entry) => !entry.unpacked)).toEqual(
      before.parsed.entries.filter((entry) => !entry.unpacked),
    );
    asar.uncache(f.archive);
    expect(asar.extractFile(f.archive, "main.js").toString()).toBe("module.exports = 42;\n");
    expect(
      asar.extractFile(f.archive, "unpacked/engine.node").equals(fs.readFileSync(f.native)),
    ).toBe(true);
    expect(plist.parse(fs.readFileSync(f.info, "utf8")).PreserveThis).toEqual({
      nested: ["a", 0, false],
    });
    expect(binding.refresh()).toMatchObject({ refreshCount: 2, changedNativeFiles: 0 });
    fs.writeFileSync(f.native, nativeBytes(1024));
    expect(binding.refresh()).toMatchObject({ refreshCount: 3, changedNativeFiles: 1 });
    expect(binding.finish()).toMatchObject({ refreshCount: 3, payloadSha256: sha(before.payload) });
    for (const directory of [f.resources, path.dirname(f.info)]) {
      expect(fs.readdirSync(directory).some((name) => name.includes(".staging-"))).toBe(false);
    }
  });

  it.each(["native", "ordinary", "packed", "plist"] as const)(
    "refuses %s content tampering before publishing metadata",
    async (kind) => {
      const f = await fixture();
      const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
      const archiveBefore = fs.readFileSync(f.archive);
      const plistBefore = fs.readFileSync(f.info);
      if (kind === "native") {
        const bad = nativeBytes(1000);
        bad[110] = 0xff;
        fs.writeFileSync(f.native, bad);
      } else if (kind === "ordinary") fs.writeFileSync(f.ordinary, "tampered ordinary input");
      else if (kind === "packed") {
        const bad = Buffer.from(archiveBefore);
        bad[bad.length - 1] = bad[bad.length - 1]! ^ 0xff;
        fs.writeFileSync(f.archive, bad);
      } else
        fs.writeFileSync(
          f.info,
          fs.readFileSync(f.info, "utf8").replace("test.moss.asar", "test.moss.other"),
        );
      const archiveAfterTamper = fs.readFileSync(f.archive);
      const plistAfterTamper = fs.readFileSync(f.info);
      expect(() => binding.refresh()).toThrow(/Packaged ASAR integrity/u);
      expect(fs.readFileSync(f.archive).equals(archiveAfterTamper)).toBe(true);
      expect(fs.readFileSync(f.info).equals(plistAfterTamper)).toBe(true);
      if (kind !== "packed") expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(true);
      if (kind !== "plist") expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(true);
    },
  );

  it.each(["symlink", "hardlink", "directory"] as const)(
    "rejects a %s alias inside unpacked inputs",
    async (kind) => {
      const f = await fixture();
      const original = path.join(f.root, "preserved.node");
      fs.renameSync(f.native, original);
      if (kind === "symlink") createRejectedFileAlias(original, f.native);
      else if (kind === "hardlink") fs.linkSync(original, f.native);
      else {
        const unpacked = path.dirname(f.native);
        const elsewhere = path.join(f.root, "elsewhere");
        fs.renameSync(unpacked, elsewhere);
        createDirectoryAlias(elsewhere, unpacked);
      }
      expect(() => bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner })).toThrow(
        /Packaged ASAR integrity/u,
      );
      expect(fs.readFileSync(original).equals(nativeBytes())).toBe(true);
    },
  );

  it("rejects a file replacement at descriptor open", async () => {
    const f = await fixture();
    let replaced = false;
    expect(() =>
      bindMacBuildOnlyAsarSigning(f.app, {
        runCommand: unitSigner,
        beforeOpen(filePath) {
          if (filePath === f.native && !replaced) {
            replaced = true;
            const backup = path.join(f.root, "backup.node");
            fs.renameSync(f.native, backup);
            fs.linkSync(backup, f.native);
          }
        },
      }),
    ).toThrow(/singly linked/u);
    expect(replaced).toBe(true);
  });

  it.each(["input", "pending"] as const)("refuses a %s race at atomic commit", async (kind) => {
    const f = await fixture();
    const archiveBefore = fs.readFileSync(f.archive);
    const plistBefore = fs.readFileSync(f.info);
    const binding = bindMacBuildOnlyAsarSigning(f.app, {
      runCommand: unitSigner,
      beforeCommit({ pendingArchive }) {
        fs.appendFileSync(kind === "input" ? f.ordinary : pendingArchive, "racing mutation");
      },
    });
    fs.writeFileSync(f.native, nativeBytes(300));
    expect(() => binding.refresh()).toThrow(/changed/u);
    expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(true);
    expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(true);
    expect(fs.readdirSync(f.resources).some((name) => name.includes(".pending-"))).toBe(false);
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
  });

  it("rolls back an interruption between ASAR and plist publication", async () => {
    const f = await fixture();
    const archiveBefore = fs.readFileSync(f.archive);
    const plistBefore = fs.readFileSync(f.info);
    const binding = bindMacBuildOnlyAsarSigning(f.app, {
      runCommand: unitSigner,
      afterArchiveCommit() {
        throw new Error("injected commit interruption");
      },
    });
    fs.writeFileSync(f.native, nativeBytes(300));
    expect(() => binding.refresh()).toThrow("injected commit interruption");
    expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(true);
    expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(true);
    expect(fs.readdirSync(f.resources).some((name) => name.includes(".pending-"))).toBe(false);
    expect(() => binding.finish()).toThrow(/did not complete/u);
  });

  it("refuses missing outer callbacks and later plist mutation", async () => {
    const f = await fixture();
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    expect(() => binding.finish()).toThrow(/did not complete/u);
    binding.refresh();
    fs.writeFileSync(
      f.info,
      fs.readFileSync(f.info, "utf8").replace("test.moss.asar", "test.moss.changed"),
    );
    expect(() => binding.finish()).toThrow(/changed after outer sealing/u);
  });

  it("permanently aborts when the archive cannot be read, even if the input is restored", async () => {
    const f = await fixture();
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    const backup = path.join(f.root, "preserved.asar");
    fs.renameSync(f.archive, backup);
    expect(() => binding.refresh()).toThrow();
    fs.renameSync(backup, f.archive);
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
    expect(() => binding.finish()).toThrow(/did not complete/u);
  });

  it("permanently aborts after failed sealing verification even if plist bytes are restored", async () => {
    const f = await fixture();
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    binding.refresh();
    const before = fs.readFileSync(f.info);
    fs.writeFileSync(f.info, before.toString().replace("test.moss.asar", "test.moss.changed"));
    expect(() => binding.finish()).toThrow(/changed after outer sealing/u);
    fs.writeFileSync(f.info, before);
    expect(() => binding.finish()).toThrow(/did not complete/u);
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
  });

  it.each(["plist", "pending-plist"] as const)(
    "refuses a %s replacement between metadata renames",
    async (kind) => {
      const f = await fixture();
      const archiveBefore = fs.readFileSync(f.archive);
      const plistBefore = fs.readFileSync(f.info);
      let pendingPlist = "";
      let changed = Buffer.alloc(0);
      const binding = bindMacBuildOnlyAsarSigning(f.app, {
        runCommand: unitSigner,
        beforeCommit(pending) {
          pendingPlist = pending.pendingPlist;
        },
        afterArchiveCommit() {
          const target = kind === "plist" ? f.info : pendingPlist;
          changed = Buffer.from(
            fs.readFileSync(target).toString().replace("test.moss.asar", "test.moss.raced"),
          );
          const replacement = path.join(f.root, "replacement.plist");
          fs.writeFileSync(replacement, changed);
          fs.renameSync(replacement, target);
        },
      });
      fs.writeFileSync(f.native, nativeBytes(300));
      expect(() => binding.refresh()).toThrow(/changed/u);
      expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(true);
      expect(fs.readFileSync(f.info).equals(kind === "plist" ? changed : plistBefore)).toBe(true);
      expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
    },
  );

  it("never rolls back over a foreign ASAR replacement after the first rename", async () => {
    const f = await fixture();
    const plistBefore = fs.readFileSync(f.info);
    const foreign = Buffer.from("concurrent archive must be preserved");
    const binding = bindMacBuildOnlyAsarSigning(f.app, {
      runCommand: unitSigner,
      afterArchiveCommit() {
        const replacement = path.join(f.root, "foreign.asar");
        fs.writeFileSync(replacement, foreign);
        fs.renameSync(replacement, f.archive);
        throw new Error("interrupted after foreign replacement");
      },
    });
    fs.writeFileSync(f.native, nativeBytes(300));
    expect(() => binding.refresh()).toThrow(/rollback refused/u);
    expect(fs.readFileSync(f.archive).equals(foreign)).toBe(true);
    expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(true);
    expect(fs.readdirSync(f.resources).some((name) => name.includes(".pending-"))).toBe(false);
    expect(() => binding.finish()).toThrow(/did not complete/u);
  });

  it.each(["pendingArchive", "pendingPlist"] as const)(
    "preserves a foreign replacement at %s when aborting cleanup",
    async (kind) => {
      const f = await fixture();
      const archiveBefore = fs.readFileSync(f.archive);
      const plistBefore = fs.readFileSync(f.info);
      const foreign = Buffer.from("foreign-owned staging file must survive");
      let replacedPath = "";
      let retainedPath = "";
      const binding = bindMacBuildOnlyAsarSigning(f.app, {
        runCommand: unitSigner,
        beforeCommit(pending) {
          replacedPath = pending[kind];
          retainedPath = path.join(f.root, "preserved-staging-file");
          fs.renameSync(replacedPath, retainedPath);
          fs.writeFileSync(replacedPath, foreign, { flag: "wx" });
        },
      });
      fs.writeFileSync(f.native, nativeBytes(300));
      expect(() => binding.refresh()).toThrow(/changed/u);
      expect(fs.readFileSync(replacedPath).equals(foreign)).toBe(true);
      expect(fs.statSync(retainedPath).isFile()).toBe(true);
      expect(fs.readdirSync(path.dirname(replacedPath))).toContain("payload");
      expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(true);
      expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(true);
      expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
      expect(() => binding.finish()).toThrow(/did not complete/u);
    },
  );

  it("aborts and preserves a foreign file that replaces an empty staging directory at cleanup", async () => {
    const f = await fixture();
    const foreign = Buffer.from("foreign file at staging directory path");
    let directory = "";
    let replaced = false;
    const binding = bindMacBuildOnlyAsarSigning(f.app, {
      runCommand: unitSigner,
      beforeCommit({ pendingArchive }) {
        directory = path.dirname(pendingArchive);
      },
      syncParent() {
        if (replaced) return;
        fs.rmdirSync(directory);
        fs.writeFileSync(directory, foreign, { flag: "wx" });
        replaced = true;
      },
    });
    fs.writeFileSync(f.native, nativeBytes(300));
    expect(() => binding.refresh()).toThrow(/ENOTDIR/u);
    expect(fs.readFileSync(directory).equals(foreign)).toBe(true);
    expect(verifyPackagedAsarIntegrity(f.app)).toMatchObject({ unpackedFiles: 2 });
    expect(() => binding.finish()).toThrow(/did not complete/u);
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
  });

  it.each([1, 2])("keeps a coherent pair when directory fsync %s fails", async (failAt) => {
    const f = await fixture();
    const archiveBefore = fs.readFileSync(f.archive);
    const plistBefore = fs.readFileSync(f.info);
    let calls = 0;
    const binding = bindMacBuildOnlyAsarSigning(f.app, {
      runCommand: unitSigner,
      syncParent(filePath) {
        calls += 1;
        const fd = fs.openSync(filePath, "r");
        fs.closeSync(fd);
        // Exercise a real failed fsync at the directory-sync boundary without
        // modifying unrelated descriptors or mocking global filesystem calls.
        if (calls === failAt) fs.fsyncSync(fd);
      },
    });
    fs.writeFileSync(f.native, nativeBytes(300));
    expect(() => binding.refresh()).toThrow(/EBADF/u);
    expect(calls).toBe(failAt);
    expect(fs.readFileSync(f.archive).equals(archiveBefore)).toBe(false);
    expect(fs.readFileSync(f.info).equals(plistBefore)).toBe(false);
    expect(verifyPackagedAsarIntegrity(f.app)).toMatchObject({ unpackedFiles: 2, packedFiles: 3 });
    expect(() => binding.refresh()).toThrow(/aborted signing transaction/u);
    expect(() => binding.finish()).toThrow(/did not complete/u);
  });

  it.each(["native", "ordinary"] as const)(
    "rejects a same-byte %s inode replacement after the final refresh",
    async (kind) => {
      const f = await fixture();
      const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
      binding.refresh();
      const replacement = path.join(f.root, "same-bytes");
      fs.copyFileSync(f[kind], replacement);
      fs.chmodSync(replacement, fs.statSync(f[kind]).mode);
      fs.renameSync(replacement, f[kind]);
      expect(verifyPackagedAsarIntegrity(f.app)).toMatchObject({ unpackedFiles: 2 });
      expect(() => binding.finish()).toThrow(/changed after validation/u);
    },
  );

  it("rejects unpacked permission changes after the final refresh", async () => {
    const f = await fixture();
    const binding = bindMacBuildOnlyAsarSigning(f.app, { runCommand: unitSigner });
    binding.refresh();
    const originalMode = fs.statSync(f.native).mode;
    try {
      fs.chmodSync(f.native, 0o444);
      expect(fs.statSync(f.native).mode & 0o222).toBe(0);
      expect(originalMode & 0o222).not.toBe(0);
      expect(() => binding.finish()).toThrow(/changed after validation/u);
    } finally {
      fs.chmodSync(f.native, originalMode);
    }
  });

  it("rejects duplicate plist keys and malformed, overlapping, or escaping ASAR inventories", async () => {
    const f = await fixture();
    fs.writeFileSync(
      f.info,
      fs
        .readFileSync(f.info, "utf8")
        .replace("<key>PreserveThis</key>", "<key>CFBundleIdentifier</key>"),
    );
    expect(() => verifyPackagedAsarIntegrity(f.app)).toThrow(/duplicate/u);
    const { parsed, prefix } = headerAndPayload(f.archive);
    const malformed = Buffer.from(prefix);
    malformed.writeUInt32LE(0xfffffff0, 12);
    expect(() => parseAsarHeader(malformed, fs.statSync(f.archive).size)).toThrow(/bounds/u);
    const make = (header: Record<string, unknown>, payload = 4 * 1024 * 1024 + 100) => {
      const next = encodeAsarHeader(header);
      return () => parseAsarHeader(next, next.length + payload);
    };
    const files = (parsed.header as { files: Record<string, Record<string, unknown>> }).files;
    expect(make({ files: { "..": files["main.js"] } })).toThrow(/unsafe/u);
    expect(make({ files: { a: { ...files["main.js"], offset: "999999999" } } })).toThrow(
      /out-of-bounds/u,
    );
    expect(make({ files: { a: files["main.js"], b: files["main.js"] } })).toThrow(/overlapping/u);
  });

  it("admits repaired ASARs at both package and final extraction boundaries", () => {
    const source = fs.readFileSync(
      new URL("../build-desktop-artifact.ts", import.meta.url),
      "utf8",
    );
    expect(source).toContain("? verifyPackagedAsarIntegrity(path.resolve(runtime.resourcesDir");
    expect(source).toContain("? { verifyAsarIntegrity: true }");
    const signing = fs.readFileSync(
      new URL("../mac-canonical-filesystem-helper-sign.mjs", import.meta.url),
      "utf8",
    );
    const cli = signing.slice(signing.indexOf("async function runMacBuildOnlySignCli"));
    expect(cli.indexOf("bindMacBuildOnlyAsarSigning(options.app)")).toBeLessThan(
      cli.indexOf("await signMacCanonicalFilesystemHelperAware"),
    );
    expect(cli).toContain("if (path.resolve(filePath) === options.app) asar.refresh()");
    expect(cli).toContain("asar.finish()");
  });
});
