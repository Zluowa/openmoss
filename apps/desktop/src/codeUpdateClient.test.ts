import { createHash } from "node:crypto";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import * as Path from "node:path";
import { constants as zlibConstants, zstdCompressSync } from "node:zlib";

import { packAsar } from "@moss/shared/asarArchive";
import {
  applyCodeUpdate,
  CODE_UPDATE_IDENTITY_PATH,
  codeUpdateId,
  codeUpdateManifestPath,
  codeUpdatePackagePath,
  signCodeUpdateManifest,
  type CodeUpdateManifest,
} from "@moss/shared/codeUpdate";
import { readCodeUpdateStateSync } from "@moss/shared/codeUpdateState";
import { MOSS_DOWNLOAD_SOURCES } from "@moss/shared/mossDownloadSources";
import {
  generateMossUpdateManifestKeyPair,
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
} from "@moss/shared/mossUpdateMirror";
import * as FS from "node:fs";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  resolveCodeUpdateClientConfig,
  runCodeUpdateCheck,
  type CodeUpdateClientConfig,
} from "./codeUpdateClient";

const SHELL = "a".repeat(40);
const COMMIT = "c".repeat(40);
const keys = generateMossUpdateManifestKeyPair();

let work: string;
let server: Server | null = null;
beforeEach(async () => {
  work = await mkdtemp(Path.join(tmpdir(), "moss-code-update-client-"));
});
afterEach(async () => {
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = null;
  await rm(work, { recursive: true, force: true });
});

async function writeTree(root: string, files: Record<string, string>) {
  for (const [name, text] of Object.entries(files)) {
    await mkdir(Path.dirname(Path.join(root, name)), { recursive: true });
    await writeFile(Path.join(root, name), text);
  }
}

/** The installed shell's archive and a feed folder with one signed code update for it. */
async function fixture(options: { shells?: string[] } = {}) {
  const installedSrc = Path.join(work, "installed-src");
  await writeTree(installedSrc, {
    "node_modules/dep/index.js": "module.exports = 1;\n",
    "apps/desktop/dist-electron/main.js": "old\n",
    "apps/server/dist/index.mjs": "old\n",
  });
  const installedArchive = Path.join(work, "app.asar");
  await packAsar({
    output: installedArchive,
    directories: {
      node_modules: Path.join(installedSrc, "node_modules"),
      apps: Path.join(installedSrc, "apps"),
    },
    files: { "package.json": Buffer.from(JSON.stringify({ mossCommitHash: SHELL })) },
  });

  const codeSrc = Path.join(work, "code-src");
  // Enough incompressible bytes that the package spans several reads.
  const filler = Array.from({ length: 4000 }, (_, i) =>
    createHash("sha256").update(String(i)).digest("hex"),
  ).join("\n");
  await writeTree(codeSrc, {
    "apps/desktop/dist-electron/main.js": `new\n${filler}\n`,
    "apps/server/dist/index.mjs": "new\n",
  });
  const codeArchive = Path.join(work, "code.asar");
  await packAsar({
    output: codeArchive,
    directories: {
      "apps/desktop/dist-electron": Path.join(codeSrc, "apps/desktop/dist-electron"),
      "apps/server/dist": Path.join(codeSrc, "apps/server/dist"),
    },
    files: {
      [CODE_UPDATE_IDENTITY_PATH]: Buffer.from(
        JSON.stringify({ commit: COMMIT, codeVersion: "v" }),
      ),
    },
  });
  const archive = await readFile(codeArchive);
  const compressed = zstdCompressSync(archive, {
    params: { [zlibConstants.ZSTD_c_compressionLevel]: 1 },
  });
  const sha256 = createHash("sha256").update(compressed).digest("hex");
  const manifest: CodeUpdateManifest = {
    schema: 1,
    channel: "preview",
    sequence: 10,
    commit: COMMIT,
    codeVersion: "v",
    shells: options.shells ?? [SHELL],
    package: {
      path: codeUpdatePackagePath(COMMIT, sha256),
      size: compressed.length,
      sha256,
      archiveSize: archive.length,
      archiveSha256: createHash("sha256").update(archive).digest("hex"),
    },
    migrations: { latest: 170, readerFloor: 169 },
    results: {},
  };
  const feed = Path.join(work, "feed");
  const manifestText = `${JSON.stringify(manifest)}\n`;
  await writeTree(feed, {
    [codeUpdateManifestPath("preview")]: manifestText,
    [`${codeUpdateManifestPath("preview")}.sig`]: signCodeUpdateManifest({
      manifest: manifestText,
      channel: "preview",
      privateKey: keys.privateKey,
    }),
  });
  await mkdir(Path.dirname(Path.join(feed, manifest.package.path)), { recursive: true });
  await writeFile(Path.join(feed, manifest.package.path), compressed);
  return { installedArchive, feed, manifest, compressed };
}

interface ServeOptions {
  /** Close the connection after this many body bytes of the package, on the first request only. */
  cutPackageAfter?: number;
  /** Bytes served instead of the package's. */
  packageBytes?: Buffer;
}

async function serve(feed: string, options: ServeOptions = {}) {
  const requests: Array<{ url: string; range: string | undefined; query: string | undefined }> = [];
  let packageRequests = 0;
  server = createServer(async (request, response) => {
    const [rawPath = "/", query] = (request.url ?? "/").split("?");
    const url = decodeURIComponent(rawPath.slice(1));
    requests.push({ url, range: request.headers.range, query });
    let body: Buffer;
    try {
      body = await readFile(Path.join(feed, url));
    } catch {
      response.writeHead(404).end();
      return;
    }
    const isPackage = url.endsWith(".asar.zst");
    if (isPackage && options.packageBytes) body = options.packageBytes;
    const match = /^bytes=(\d+)-$/u.exec(request.headers.range ?? "");
    const start = match ? Number(match[1]) : 0;
    const slice = body.subarray(start);
    response.writeHead(match ? 206 : 200, {
      "Content-Length": slice.length,
      ...(match ? { "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}` } : {}),
    });
    if (isPackage && options.cutPackageAfter !== undefined && packageRequests++ === 0) {
      response.write(slice.subarray(0, options.cutPackageAfter), () => request.socket.destroy());
      return;
    }
    response.end(slice);
  });
  await new Promise<void>((resolve) => server!.listen(0, "127.0.0.1", resolve));
  const { port } = server!.address() as AddressInfo;
  return { root: `http://127.0.0.1:${port}/`, requests };
}

function config(root: string): CodeUpdateClientConfig {
  const resolved = resolveCodeUpdateClientConfig(
    {
      MOSS_CODE_UPDATES: "1",
      MOSS_CODE_UPDATE_FEED: root,
      MOSS_CODE_UPDATE_TEST_PUBLIC_KEY: keys.manifestPublicKey,
    },
    "global",
    "win32",
  );
  if (!resolved || "error" in resolved) throw new Error("config");
  return resolved;
}

function deps(root: string, installedArchive: string, lines: string[]) {
  return {
    config: config(root),
    boot: {
      id: null,
      sequence: 0,
      storeDir: Path.join(work, "store"),
      installedArchive,
      shellCommit: SHELL,
    },
    fetch: (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
      fetch(url, init),
    apply: applyCodeUpdate,
    log: (line: string) => lines.push(line),
    installedArchiveBytes: FS.statSync(installedArchive).size,
    downloadRetryDelaysMs: [],
  };
}

describe("resolveCodeUpdateClientConfig", () => {
  it("is off unless the switch is on", () => {
    expect(resolveCodeUpdateClientConfig({})).toBeNull();
    expect(resolveCodeUpdateClientConfig({ MOSS_CODE_UPDATES: "0" })).toBeNull();
  });

  it("uses the ordered production sources and the release key by default", () => {
    expect(resolveCodeUpdateClientConfig({ MOSS_CODE_UPDATES: "1" }, "cn", "win32")).toMatchObject({
      sources: [...MOSS_DOWNLOAD_SOURCES.cn],
      publicKey: MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
      channel: "preview",
    });
    expect(
      resolveCodeUpdateClientConfig({ MOSS_CODE_UPDATES: "1" }, "global", "win32"),
    ).toMatchObject({
      sources: [...MOSS_DOWNLOAD_SOURCES.global],
    });
  });

  it("honours the test free-space figure only together with the loopback test key", () => {
    const withKey = resolveCodeUpdateClientConfig(
      {
        MOSS_CODE_UPDATES: "1",
        MOSS_CODE_UPDATE_FEED: "http://127.0.0.1:1/",
        MOSS_CODE_UPDATE_TEST_PUBLIC_KEY: keys.manifestPublicKey,
        MOSS_CODE_UPDATE_TEST_FREE_BYTES: "1024",
      },
      "global",
      "win32",
    );
    expect(withKey).toMatchObject({ testFreeBytes: 1024 });
    const withoutKey = resolveCodeUpdateClientConfig(
      { MOSS_CODE_UPDATES: "1", MOSS_CODE_UPDATE_TEST_FREE_BYTES: "1024" },
      "global",
      "win32",
    );
    expect(withoutKey).toMatchObject({ testFreeBytes: null });
  });

  it("never lets a test key make a public feed trusted", () => {
    expect(
      resolveCodeUpdateClientConfig(
        {
          MOSS_CODE_UPDATES: "1",
          MOSS_CODE_UPDATE_FEED: "https://update.mossbotai.com/",
          MOSS_CODE_UPDATE_TEST_PUBLIC_KEY: keys.manifestPublicKey,
        },
        "global",
        "win32",
      ),
    ).toMatchObject({ error: expect.stringContaining("loopback") });
    expect(
      resolveCodeUpdateClientConfig(
        {
          MOSS_CODE_UPDATES: "1",
          MOSS_CODE_UPDATE_FEED: "http://example.com/",
        },
        "global",
        "win32",
      ),
    ).toMatchObject({ error: expect.stringContaining("HTTPS") });
  });
});

describe("runCodeUpdateCheck", () => {
  it("keeps the package and its signed manifest after an apply", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const { root } = await serve(feed);
    await runCodeUpdateCheck(deps(root, installedArchive, []));
    const id = codeUpdateId(manifest);
    const store = Path.join(work, "store");
    expect(readCodeUpdateStateSync(FS, store).packages).toEqual([id]);
    for (const name of [`${id}.asar.zst`, `${id}.manifest.json`, `${id}.manifest.json.sig`]) {
      expect(existsSync(Path.join(store, "packages", name))).toBe(true);
    }
  });

  it("skips an update before downloading it when the disk is too full", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const { root, requests } = await serve(feed);
    const lines: string[] = [];
    const problems: unknown[] = [];
    const outcome = await runCodeUpdateCheck({
      ...deps(root, installedArchive, lines),
      freeBytes: async () => 1024,
      onProblem: (problem) => void problems.push(problem),
    });
    expect(outcome).toMatchObject({ outcome: "disk" });
    expect(requests.some((r) => r.url === manifest.package.path)).toBe(false);
    expect(problems).toEqual([expect.objectContaining({ stage: "download" })]);
    expect(lines.join("\n")).toContain("not enough disk space");
  });

  it("rebuilds a missing archive from its kept package without downloading again", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const { root, requests } = await serve(feed);
    const store = Path.join(work, "store");
    const id = codeUpdateId(manifest);
    await runCodeUpdateCheck(deps(root, installedArchive, []));
    // The code became healthy, then its archive went missing; the boot queued a rebuild.
    await rm(Path.join(store, id), { recursive: true, force: true });
    const state = readCodeUpdateStateSync(FS, store);
    FS.writeFileSync(
      Path.join(store, "state.json"),
      JSON.stringify({ ...state, active: null, pending: null, rebuild: id }),
    );
    const before = requests.length;
    const lines: string[] = [];
    const outcome = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    expect(outcome).toMatchObject({ outcome: "pending", id });
    expect(requests.length).toBe(before);
    expect(existsSync(Path.join(store, id, "installed.json"))).toBe(true);
    expect(readCodeUpdateStateSync(FS, store)).toMatchObject({ pending: id, rebuild: null });
    expect(lines.join("\n")).toContain("rebuilding");
  });

  it("drops a rebuild whose kept package was changed", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const { root } = await serve(feed);
    const store = Path.join(work, "store");
    const id = codeUpdateId(manifest);
    await runCodeUpdateCheck(deps(root, installedArchive, []));
    await rm(Path.join(store, id), { recursive: true, force: true });
    const kept = Path.join(store, "packages", `${id}.asar.zst`);
    const bytes = await readFile(kept);
    bytes[bytes.length >> 1] = (bytes[bytes.length >> 1] ?? 0) ^ 0xff;
    await writeFile(kept, bytes);
    const state = readCodeUpdateStateSync(FS, store);
    FS.writeFileSync(
      Path.join(store, "state.json"),
      JSON.stringify({ ...state, active: null, pending: null, rebuild: id }),
    );
    const outcome = await runCodeUpdateCheck(deps(root, installedArchive, []));
    expect(outcome).toMatchObject({
      outcome: "apply-failed",
      detail: expect.stringContaining("changed"),
    });
    expect(readCodeUpdateStateSync(FS, store)).toMatchObject({ rebuild: null, packages: [] });
  });

  it("downloads, verifies and applies a newer update, which then waits for the next start", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const { root, requests } = await serve(feed);
    const lines: string[] = [];
    const outcome = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    const id = codeUpdateId(manifest);
    expect(outcome).toMatchObject({ outcome: "pending", id });
    expect(readCodeUpdateStateSync(FS, Path.join(work, "store")).pending).toBe(id);
    // Manifests bypass edge caches with a query; the immutable package is fetched as it is.
    const manifestRequest = requests.find((r) => r.url === codeUpdateManifestPath("preview"));
    expect(manifestRequest?.query).toMatch(/^noCache=\d+$/u);
    expect(requests.find((r) => r.url === manifest.package.path)?.query).toBeUndefined();
    expect(existsSync(Path.join(work, "store", id, "installed.json"))).toBe(true);
  });

  it("resumes an interrupted download from the bytes it already has", async () => {
    const { installedArchive, feed, manifest } = await fixture();
    const cut = Math.floor(manifest.package.size / 2);
    const { root, requests } = await serve(feed, { cutPackageAfter: cut });
    const lines: string[] = [];
    const first = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    expect(first.outcome).toBe("download-failed");
    const partial = Path.join(
      work,
      "store",
      "downloads",
      `${manifest.package.sha256}.asar.zst.partial`,
    );
    expect((await readFile(partial)).length).toBe(cut);

    const second = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    expect(second).toMatchObject({ outcome: "pending", id: codeUpdateId(manifest) });
    const packageRequests = requests.filter((r) => r.url === manifest.package.path);
    expect(packageRequests.at(-1)?.range).toBe(`bytes=${cut}-`);
    expect(lines.join("\n")).toContain(`resumedFrom=${cut}`);
  });

  it("refuses a tampered package and installs nothing", async () => {
    const { installedArchive, feed, manifest, compressed } = await fixture();
    const tampered = Buffer.from(compressed);
    const middle = tampered.length >> 1;
    tampered[middle] = (tampered[middle] ?? 0) ^ 0xff;
    const { root } = await serve(feed, { packageBytes: tampered });
    const lines: string[] = [];
    const outcome = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    expect(outcome).toMatchObject({ outcome: "download-failed" });
    expect((outcome as { detail: string }).detail).toMatch(/^mismatch/u);
    const id = codeUpdateId(manifest);
    expect(existsSync(Path.join(work, "store", id))).toBe(false);
    expect(readCodeUpdateStateSync(FS, Path.join(work, "store")).pending).toBeNull();
  });

  it("refuses an update built for another shell without downloading it", async () => {
    const { installedArchive, feed, manifest } = await fixture({ shells: ["b".repeat(40)] });
    const { root, requests } = await serve(feed);
    const lines: string[] = [];
    const outcome = await runCodeUpdateCheck(deps(root, installedArchive, lines));
    expect(outcome).toMatchObject({ outcome: "none", refusal: "shell" });
    expect(requests.some((r) => r.url === manifest.package.path)).toBe(false);
    expect(lines.join("\n")).toContain("refused=shell");
  });
});
