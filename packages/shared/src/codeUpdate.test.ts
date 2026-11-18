import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  encodeAsarHeader,
  findAsarNode,
  isAsarDirectory,
  packAsar,
  readAsarArchive,
  walkAsarFiles,
} from "./asarArchive";
import {
  applyCodeUpdate,
  checkCodeUpdateManifest,
  CODE_UPDATE_IDENTITY_PATH,
  codeUpdateId,
  codeUpdatePackagePath,
  parseCodeUpdateManifest,
  signCodeUpdateManifest,
  type CodeUpdateManifest,
} from "./codeUpdate";
import { EMPTY_CODE_UPDATE_STATE } from "./codeUpdateState";
import { generateMossUpdateManifestKeyPair } from "./mossUpdateMirror";

const SHELL = "a".repeat(40);
const OTHER_SHELL = "b".repeat(40);
const COMMIT = "c".repeat(40);

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "moss-code-update-test-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function tree(root: string, files: Record<string, string>): Promise<string> {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(path.dirname(path.join(root, name)), { recursive: true });
    await writeFile(path.join(root, name), text);
  }
  return root;
}

/** An installed archive: package.json naming the shell, node_modules, and the old code. */
async function installedArchive(): Promise<string> {
  const root = await tree(path.join(work, "installed-src"), {
    "node_modules/dep/index.js": "module.exports = 'dependency';\n",
    "apps/desktop/dist-electron/main.js": "console.log('old main');\n",
    "apps/desktop/resources/icon.txt": "icon\n",
    "apps/server/dist/index.mjs": "console.log('old server');\n",
    "apps/server/dist/client/index.html": "<p>old</p>\n",
  });
  const file = path.join(work, "installed.asar");
  await packAsar({
    output: file,
    directories: {
      node_modules: path.join(root, "node_modules"),
      apps: path.join(root, "apps"),
    },
    files: {
      "package.json": Buffer.from(JSON.stringify({ name: "moss", mossCommitHash: SHELL })),
    },
  });
  return file;
}

interface Built {
  readonly manifest: CodeUpdateManifest;
  readonly packageFile: string;
  readonly codeArchive: string;
}

async function buildPackage(
  options: { shells?: string[]; readerFloor?: number; extraFile?: string } = {},
): Promise<Built> {
  const root = await tree(path.join(work, "code-src"), {
    "apps/desktop/dist-electron/main.js": "console.log('new main');\n",
    "apps/server/dist/index.mjs": "console.log('new server');\n",
    "apps/server/dist/client/index.html": "<p>new</p>\n",
  });
  const codeArchive = path.join(work, "code.asar");
  await packAsar({
    output: codeArchive,
    directories: {
      "apps/desktop/dist-electron": path.join(root, "apps/desktop/dist-electron"),
      "apps/server/dist": path.join(root, "apps/server/dist"),
    },
    files: {
      [CODE_UPDATE_IDENTITY_PATH]: Buffer.from(
        JSON.stringify({ commit: COMMIT, codeVersion: "1.0.7+ccccccccc" }),
      ),
      ...(options.extraFile ? { [options.extraFile]: Buffer.from("x") } : {}),
    },
  });
  const archive = await readFile(codeArchive);
  const compressed = zstdCompressSync(archive, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 3 },
  });
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const packageFile = path.join(work, "package.asar.zst");
  await writeFile(packageFile, compressed);
  return {
    codeArchive,
    packageFile,
    manifest: {
      schema: 1,
      channel: "preview",
      sequence: 100,
      commit: COMMIT,
      codeVersion: "1.0.7+ccccccccc",
      shells: options.shells ?? [SHELL],
      package: {
        path: codeUpdatePackagePath(COMMIT, sha256),
        size: compressed.length,
        sha256,
        archiveSize: archive.length,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      },
      migrations: { latest: 170, readerFloor: options.readerFloor ?? 169 },
      results: {},
    },
  };
}

async function readArchiveText(archive: string, archivePath: string): Promise<string> {
  const parsed = await readAsarArchive(archive);
  const node = findAsarNode(parsed.header, archivePath);
  if (!node || isAsarDirectory(node) || !("size" in node))
    throw new Error(`${archivePath} missing`);
  const bytes = await readFile(archive);
  const start = parsed.dataStart + Number(node.offset);
  return bytes.subarray(start, start + node.size).toString("utf8");
}

describe("code update manifest", () => {
  const keys = generateMossUpdateManifestKeyPair();
  const signed = (manifest: CodeUpdateManifest) => {
    const text = `${JSON.stringify(manifest, null, 2)}\n`;
    return {
      text,
      signature: signCodeUpdateManifest({
        manifest: text,
        channel: "preview",
        privateKey: keys.privateKey,
      }),
    };
  };
  const check = (
    text: string,
    signature: string,
    overrides: Partial<Parameters<typeof checkCodeUpdateManifest>[0]> = {},
  ) =>
    checkCodeUpdateManifest({
      manifestText: text,
      signature,
      channel: "preview",
      publicKey: keys.manifestPublicKey,
      shellCommit: SHELL,
      runningSequence: 0,
      knownIds: [],
      state: EMPTY_CODE_UPDATE_STATE,
      fallbackLatestMigrations: [],
      ...overrides,
    });

  it("accepts a signed manifest for this shell", async () => {
    const { manifest } = await buildPackage();
    const { text, signature } = signed(manifest);
    expect(check(text, signature)).toMatchObject({ ok: true, id: codeUpdateId(manifest) });
  });

  it("refuses a manifest changed after signing", async () => {
    const { manifest } = await buildPackage();
    const { text, signature } = signed(manifest);
    const tampered = text.replace('"sequence": 100', '"sequence": 101');
    expect(check(tampered, signature)).toMatchObject({ ok: false, refusal: "signature" });
  });

  it("refuses a preview signature replayed onto the stable channel", async () => {
    const { manifest } = await buildPackage();
    const { text, signature } = signed(manifest);
    expect(check(text, signature, { channel: "desktop" })).toMatchObject({
      ok: false,
      refusal: "signature",
    });
  });

  it("refuses a package built for another shell", async () => {
    const { manifest } = await buildPackage({ shells: [OTHER_SHELL] });
    const { text, signature } = signed(manifest);
    expect(check(text, signature)).toMatchObject({ ok: false, refusal: "shell" });
    expect(check(text, signature, { shellCommit: null })).toMatchObject({
      ok: false,
      refusal: "shell",
    });
  });

  it("refuses an older or equal sequence (no downgrade by an old manifest)", async () => {
    const { manifest } = await buildPackage();
    const { text, signature } = signed(manifest);
    expect(check(text, signature, { runningSequence: 100 })).toMatchObject({
      ok: false,
      refusal: "not-newer",
    });
  });

  it("refuses a reader floor the fallback code could not open", async () => {
    const { manifest } = await buildPackage({ readerFloor: 171 });
    const { text, signature } = signed(manifest);
    expect(check(text, signature, { fallbackLatestMigrations: [170] })).toMatchObject({
      ok: false,
      refusal: "reader-floor",
    });
  });

  it("refuses a package that was already rejected here", async () => {
    const { manifest } = await buildPackage();
    const { text, signature } = signed(manifest);
    const id = codeUpdateId(manifest);
    const state = {
      ...EMPTY_CODE_UPDATE_STATE,
      rejected: { [id]: { reason: "load-error" as const, detail: "x", at: "t" } },
    };
    expect(check(text, signature, { state })).toMatchObject({ ok: false, refusal: "rejected" });
  });

  it("rejects malformed fields instead of ignoring them", async () => {
    const { manifest } = await buildPackage();
    expect(parseCodeUpdateManifest(JSON.stringify(manifest))).not.toBeNull();
    for (const broken of [
      { ...manifest, schema: 2 },
      { ...manifest, shells: [] },
      { ...manifest, package: { ...manifest.package, path: "../../evil.asar.zst" } },
      { ...manifest, package: { ...manifest.package, archiveSize: 4 * 1024 ** 3 } },
      { ...manifest, results: { nope: "x" } },
    ]) {
      expect(parseCodeUpdateManifest(JSON.stringify(broken))).toBeNull();
    }
  });
});

describe("applyCodeUpdate", () => {
  it("splices the new code into a copy of the installed archive and never touches the original", async () => {
    const installed = await installedArchive();
    const before = await readFile(installed);
    const { manifest, packageFile } = await buildPackage();
    const store = path.join(work, "store");
    const report = await applyCodeUpdate({
      manifest,
      packageFile,
      installedArchive: installed,
      shellCommit: SHELL,
      storeDir: store,
    });
    const id = codeUpdateId(manifest);
    const result = path.join(store, id, "app.asar");
    expect(await readArchiveText(result, "apps/desktop/dist-electron/main.js")).toContain(
      "new main",
    );
    expect(await readArchiveText(result, "apps/server/dist/client/index.html")).toContain("new");
    expect(await readArchiveText(result, "node_modules/dep/index.js")).toContain("dependency");
    expect(await readArchiveText(result, "apps/desktop/resources/icon.txt")).toBe("icon\n");
    expect(await readArchiveText(result, "package.json")).toContain(SHELL);
    expect(
      JSON.parse(await readFile(path.join(store, id, "installed.json"), "utf8")),
    ).toMatchObject({
      id,
      commit: COMMIT,
      shellCommit: SHELL,
      archiveSize: report.installed.archiveSize,
    });
    expect((await readFile(installed)).equals(before)).toBe(true);
  });

  it("checks the spliced archive against the build's result when the manifest has it", async () => {
    const installed = await installedArchive();
    const { manifest, packageFile } = await buildPackage();
    const installedSha = createHash("sha256")
      .update(await readFile(installed))
      .digest("hex");
    const wrong = { ...manifest, results: { [installedSha]: "0".repeat(64) } };
    await expect(
      applyCodeUpdate({
        manifest: wrong,
        packageFile,
        installedArchive: installed,
        shellCommit: SHELL,
        storeDir: path.join(work, "store"),
      }),
    ).rejects.toMatchObject({ reason: "result" });
  });

  it("refuses a package whose bytes do not unpack to the signed archive", async () => {
    const installed = await installedArchive();
    const { manifest, packageFile } = await buildPackage();
    // A valid zstd frame of other data with the signed size: only the archive hash can tell.
    await writeFile(packageFile, zstdCompressSync(Buffer.alloc(manifest.package.archiveSize, 7)));
    await expect(
      applyCodeUpdate({
        manifest,
        packageFile,
        installedArchive: installed,
        shellCommit: SHELL,
        storeDir: path.join(work, "store"),
      }),
    ).rejects.toMatchObject({ reason: "archive" });
    expect(
      await readFile(path.join(work, "store", codeUpdateId(manifest), "installed.json")).catch(
        () => null,
      ),
    ).toBeNull();
  });

  it("refuses code whose files do not match their integrity records", async () => {
    const installed = await installedArchive();
    const built = await buildPackage();
    // Rewrite the code archive with one file's bytes changed but its record kept, then sign
    // over it as a compromised build would: the splice still refuses it.
    const parsed = await readAsarArchive(built.codeArchive);
    const bytes = await readFile(built.codeArchive);
    const data = Buffer.from(bytes.subarray(parsed.dataStart));
    for (const { path: archivePath, entry } of walkAsarFiles(parsed.header)) {
      if (archivePath === "apps/desktop/dist-electron/main.js" && "offset" in entry) {
        data[Number(entry.offset)] = "X".charCodeAt(0);
      }
    }
    const archive = Buffer.concat([encodeAsarHeader(parsed.header), data]);
    const compressed = zstdCompressSync(archive);
    const sha256 = createHash("sha256").update(compressed).digest("hex");
    await writeFile(built.packageFile, compressed);
    const manifest: CodeUpdateManifest = {
      ...built.manifest,
      package: {
        path: codeUpdatePackagePath(COMMIT, sha256),
        size: compressed.length,
        sha256,
        archiveSize: archive.length,
        archiveSha256: createHash("sha256").update(archive).digest("hex"),
      },
    };
    await expect(
      applyCodeUpdate({
        manifest,
        packageFile: built.packageFile,
        installedArchive: installed,
        shellCommit: SHELL,
        storeDir: path.join(work, "store"),
      }),
    ).rejects.toThrow(/integrity record/u);
  });

  it("refuses code that reaches outside the two code folders", async () => {
    const installed = await installedArchive();
    const { manifest, packageFile } = await buildPackage({
      extraFile: "node_modules/dep/index.js",
    });
    await expect(
      applyCodeUpdate({
        manifest,
        packageFile,
        installedArchive: installed,
        shellCommit: SHELL,
        storeDir: path.join(work, "store"),
      }),
    ).rejects.toMatchObject({ reason: "content" });
  });
});
