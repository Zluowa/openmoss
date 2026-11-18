import { createHash, randomBytes } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { readdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as Zlib from "node:zlib";

import { afterEach, describe, expect, it } from "vitest";

import {
  agentRuntimeInstallDir,
  agentRuntimeObjectPath,
  agentRuntimeSourceUrls,
  type AgentRuntimePin,
  AgentRuntimeStoreError,
  defaultAgentRuntimeStoreRoot,
  ensureAgentRuntime,
  findAgentRuntime,
  installAgentRuntimeArchive,
  pruneAgentRuntimeStore,
} from "./agentRuntimeStore";
import { createTarParser, listTarEntries, writeTarArchive } from "./tarArchive";

const folders: string[] = [];
const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) {
    server.closeAllConnections();
    await new Promise((resolve) => server.close(resolve));
  }
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

function folder(label = "store"): string {
  // Spaces and non-ASCII, as in real Windows profile paths.
  const root = mkdtempSync(join(tmpdir(), `moss ${label} 用户 é-`));
  folders.push(root);
  return root;
}

const sha = (bytes: Buffer) => createHash("sha256").update(bytes).digest("hex");

const RUNTIME_FILES: Record<string, Buffer> = {
  "bin/codex.exe": Buffer.from("MZ pretend program ".repeat(5_000)),
  "codex-resources/voice/bin/glib-2.0-0.dll": Buffer.from("library"),
  [`${"deep/".repeat(25)}long-name.txt`]: Buffer.from("a path over 100 bytes"),
  "empty.txt": Buffer.alloc(0),
  // Larger than every stream buffer and incompressible: exercises back-pressure while unpacking.
  "bin/big.dll": randomBytes(6 * 1024 * 1024),
};

async function zstd(chunks: AsyncIterable<Buffer>): Promise<Buffer> {
  const parts: Buffer[] = [];
  for await (const chunk of chunks) parts.push(chunk);
  return Zlib.zstdCompressSync(Buffer.concat(parts));
}

/** Packs files exactly as the build will: deterministic tar, then zstd. */
async function packRuntime(
  files: Record<string, Buffer>,
): Promise<{ archive: Buffer; pin: AgentRuntimePin }> {
  const source = folder("source");
  for (const [path, bytes] of Object.entries(files)) {
    mkdirSync(join(source, ...path.split("/").slice(0, -1)), { recursive: true });
    writeFileSync(join(source, ...path.split("/")), bytes);
  }
  const archive = await zstd(writeTarArchive(await listTarEntries(source)));
  return {
    archive,
    pin: {
      name: "codex",
      version: "0.166.0",
      platform: "win32",
      arch: "x64",
      archive: { size: archive.length, sha256: sha(archive) },
      executable: "bin/codex.exe",
      files: Object.entries(files).map(([path, bytes]) => ({
        path,
        size: bytes.length,
        sha256: sha(bytes),
        executable: path.endsWith(".exe"),
      })),
    },
  };
}

async function serve(body: Buffer): Promise<{ base: string; hits: () => number }> {
  let hits = 0;
  const server = createServer((request, response) => {
    hits += 1;
    const start = Number(/^bytes=(\d+)-$/u.exec(request.headers.range ?? "")?.[1] ?? 0);
    response.writeHead(206, {
      "Content-Range": `bytes ${start}-${body.length - 1}/${body.length}`,
    });
    // Slow enough that a second caller arrives while the first one downloads.
    setTimeout(() => response.end(body.subarray(start)), 150);
  });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return { base: `http://127.0.0.1:${(server.address() as AddressInfo).port}/`, hits: () => hits };
}

const nodeFetch = (url: string, init: { headers: Record<string, string>; signal: AbortSignal }) =>
  fetch(url, init);

describe("tar archives", () => {
  it("round-trips files, long paths and empty files through the shared writer and parser", async () => {
    const source = folder("tar");
    for (const [path, bytes] of Object.entries(RUNTIME_FILES)) {
      mkdirSync(join(source, ...path.split("/").slice(0, -1)), { recursive: true });
      writeFileSync(join(source, ...path.split("/")), bytes);
    }
    const parts: Buffer[] = [];
    for await (const chunk of writeTarArchive(await listTarEntries(source))) parts.push(chunk);
    const read = new Map<string, Buffer>();
    const parser = createTarParser({
      entry: (header) => {
        const chunks: Buffer[] = [];
        return {
          chunk: (bytes) => chunks.push(Buffer.from(bytes)),
          end: () => read.set(header.path, Buffer.concat(chunks)),
        };
      },
    });
    parser.write(Buffer.concat(parts));
    parser.finish();
    expect([...read.keys()].toSorted()).toEqual(Object.keys(RUNTIME_FILES).toSorted());
    for (const [path, bytes] of Object.entries(RUNTIME_FILES))
      expect(read.get(path)?.equals(bytes)).toBe(true);
  });
});

describe("agent runtime store", () => {
  it("names objects the same way on every source", async () => {
    const { pin } = await packRuntime(RUNTIME_FILES);
    const file = `codex-0.166.0-win32-x64-${pin.archive.sha256.slice(0, 16)}.tar.zst`;
    expect(agentRuntimeObjectPath(pin)).toBe(`runtimes/v1/codex/0.166.0/${file}`);
    expect(agentRuntimeSourceUrls(pin, ["https://a.example/", "https://b.example/mirror"])).toEqual(
      [
        `https://a.example/runtimes/v1/codex/0.166.0/${file}`,
        `https://b.example/mirror/runtimes/v1/codex/0.166.0/${file}`,
      ],
    );
  });

  it("puts the store under LocalAppData on Windows, and lets the isolation kit override it", () => {
    expect(
      defaultAgentRuntimeStoreRoot({
        env: { LOCALAPPDATA: "C:\\Users\\张 三\\AppData\\Local" },
        platform: "win32",
        homeDir: "C:\\Users\\张 三",
      }),
    ).toBe(join("C:\\Users\\张 三\\AppData\\Local", "Moss", "runtimes"));
    expect(defaultAgentRuntimeStoreRoot({ env: {}, platform: "darwin", homeDir: "/Users/a" })).toBe(
      join("/Users/a", "Library", "Application Support", "Moss", "runtimes"),
    );
    expect(
      defaultAgentRuntimeStoreRoot({
        env: { MOSS_RUNTIME_STORE_DIR: "/iso/runtimes" },
        platform: "win32",
        homeDir: "/h",
      }),
    ).toBe("/iso/runtimes");
  });

  it("installs a verified archive in one rename, marker last, and finds it again", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const store = folder();
    const archivePath = join(store, "codex.tar.zst");
    writeFileSync(archivePath, archive);
    const directory = await installAgentRuntimeArchive({ archivePath, pin, storeRoot: store });
    expect(directory).toBe(agentRuntimeInstallDir(store, pin));
    for (const [path, bytes] of Object.entries(RUNTIME_FILES))
      expect(readFileSync(join(directory, ...path.split("/"))).equals(bytes)).toBe(true);
    expect(await readdir(join(store, ".staging"))).toEqual([]);
    expect(await findAgentRuntime([store], pin)).toEqual({
      state: "ready",
      directory,
      executablePath: join(directory, "bin", "codex.exe"),
    });
  });

  it("finishes when a file's last bytes fill a whole stream chunk (the real codex.exe hang)", async () => {
    // First entry: data starts after one 512-byte header, so 16 KiB × 4 − 512 bytes end exactly
    // on a 16 KiB chunk boundary and the last write both overflows the buffer and ends the file.
    const aligned = { "a.bin": randomBytes(16 * 1024 * 4 - 512), "b.txt": Buffer.from("next") };
    const { archive, pin } = await packRuntime(aligned);
    const store = folder();
    writeFileSync(join(store, "a.tar.zst"), archive);
    const directory = await installAgentRuntimeArchive({
      archivePath: join(store, "a.tar.zst"),
      pin,
      storeRoot: store,
    });
    expect(readFileSync(join(directory, "a.bin")).equals(aligned["a.bin"])).toBe(true);
  }, 10_000);

  it("refuses an archive with a changed file, an extra file or a missing file, and leaves nothing", async () => {
    const { archive: changed, pin } = await packRuntime({
      ...RUNTIME_FILES,
      "empty.txt": Buffer.from("x"),
    });
    const { archive: extra } = await packRuntime({
      ...RUNTIME_FILES,
      "extra.dll": Buffer.from("x"),
    });
    const { "empty.txt": _dropped, ...fewer } = RUNTIME_FILES;
    const { archive: missing } = await packRuntime(fewer);
    const { pin: realPin } = await packRuntime(RUNTIME_FILES);
    void pin;
    for (const archive of [changed, extra, missing]) {
      const store = folder();
      const archivePath = join(store, "codex.tar.zst");
      writeFileSync(archivePath, archive);
      const failure = await installAgentRuntimeArchive({
        archivePath,
        pin: realPin,
        storeRoot: store,
      }).catch((error) => error);
      expect(failure).toBeInstanceOf(AgentRuntimeStoreError);
      expect(failure.failure).toBe("invalid-archive");
      expect(existsSync(agentRuntimeInstallDir(store, realPin))).toBe(false);
      expect(await readdir(join(store, ".staging"))).toEqual([]);
    }
  });

  it("refuses entries that would escape the runtime folder", async () => {
    const header = Buffer.alloc(512);
    header.write("../escape.txt", 0);
    header.write("0000644\0", 100);
    header.write("0000000\0", 108);
    header.write("0000000\0", 116);
    header.write("00000000001\0", 124);
    header.write("00000000000\0", 136);
    header.fill(0x20, 148, 156);
    header.write("0", 156);
    header.write("ustar\0", 257);
    header.write("00", 263);
    let sum = 0;
    for (const byte of header) sum += byte;
    header.write(`${sum.toString(8).padStart(6, "0")}\0`, 148);
    const tar = Buffer.concat([header, Buffer.from("x"), Buffer.alloc(511), Buffer.alloc(1024)]);
    const archive = Zlib.zstdCompressSync(tar);
    const pin: AgentRuntimePin = {
      name: "codex",
      version: "1",
      platform: "win32",
      arch: "x64",
      archive: { size: archive.length, sha256: sha(archive) },
      executable: "escape.txt",
      files: [{ path: "escape.txt", size: 1, sha256: sha(Buffer.from("x")), executable: false }],
    };
    const store = folder();
    writeFileSync(join(store, "a.tar.zst"), archive);
    const failure = await installAgentRuntimeArchive({
      archivePath: join(store, "a.tar.zst"),
      pin,
      storeRoot: store,
    }).catch((error) => error);
    expect(failure.failure).toBe("invalid-archive");
    expect(existsSync(join(store, "escape.txt"))).toBe(false);
  });

  it("reports a removed or changed program as damaged (what antivirus quarantine looks like)", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const store = folder();
    writeFileSync(join(store, "a.tar.zst"), archive);
    const directory = await installAgentRuntimeArchive({
      archivePath: join(store, "a.tar.zst"),
      pin,
      storeRoot: store,
    });
    rmSync(join(directory, "bin", "codex.exe"));
    expect(await findAgentRuntime([store], pin)).toEqual({
      state: "damaged",
      directory,
      path: "bin/codex.exe",
    });
  });

  it("downloads, installs and reports, then finds it already installed without a request", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const source = await serve(archive);
    const store = folder();
    const phases: string[] = [];
    const first = await ensureAgentRuntime({
      pin,
      storeRoot: store,
      sourceBases: [source.base],
      fetch: nodeFetch,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
      onStatus: (status) => phases.push(status.phase),
    });
    expect(first.report).toMatchObject({ outcome: "ready", name: "codex", version: "0.166.0" });
    expect(first.report.download).toMatchObject({
      outcome: "ok",
      sourceIndex: 0,
      bytesTransferred: archive.length,
    });
    expect(phases[0]).toBe("checking");
    expect(phases).toContain("downloading");
    expect(phases.slice(-2)).toEqual(["installing", "ready"]);
    expect(existsSync(join(store, ".downloads", `${pin.archive.sha256}.tar.zst`))).toBe(false);
    const second = await ensureAgentRuntime({
      pin,
      storeRoot: store,
      sourceBases: [source.base],
      fetch: nodeFetch,
    });
    expect(second.report.outcome).toBe("already-installed");
    expect(second.executablePath).toBe(first.executablePath);
    expect(source.hits()).toBe(1);
  });

  it("downloads once when two Moss windows or profiles ask at the same time", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const source = await serve(archive);
    const store = folder();
    const ask = () =>
      ensureAgentRuntime({
        pin,
        storeRoot: store,
        sourceBases: [source.base],
        fetch: nodeFetch,
        freeBytes: async () => Number.MAX_SAFE_INTEGER,
        lockPollMs: 20,
      });
    const [a, b] = await Promise.all([ask(), ask()]);
    expect(a.executablePath).toBe(b.executablePath);
    expect([a.report.outcome, b.report.outcome].toSorted()).toEqual(["already-installed", "ready"]);
    expect(source.hits()).toBe(1);
  });

  it("takes over a lock left by a process that is gone", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const source = await serve(archive);
    const store = folder();
    mkdirSync(join(store, ".locks"), { recursive: true });
    writeFileSync(
      join(store, ".locks", "codex-0.166.0-win32-x64.lock"),
      JSON.stringify({ pid: 2 ** 22 + 7, at: Date.now() }),
    );
    const result = await ensureAgentRuntime({
      pin,
      storeRoot: store,
      sourceBases: [source.base],
      fetch: nodeFetch,
      freeBytes: async () => Number.MAX_SAFE_INTEGER,
    });
    expect(result.report.outcome).toBe("ready");
  });

  it("refuses to start when the disk lacks room for the archive and the unpacked files", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const source = await serve(archive);
    const failure = await ensureAgentRuntime({
      pin,
      storeRoot: folder(),
      sourceBases: [source.base],
      fetch: nodeFetch,
      freeBytes: async () => 10,
    }).catch((error) => error);
    expect(failure).toBeInstanceOf(AgentRuntimeStoreError);
    expect(failure.failure).toBe("disk");
    expect(source.hits()).toBe(0);
  });

  it("uses a pre-seeded copy from the full installer without downloading", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const preseeded = folder("seed");
    writeFileSync(join(preseeded, "a.tar.zst"), archive);
    await installAgentRuntimeArchive({
      archivePath: join(preseeded, "a.tar.zst"),
      pin,
      storeRoot: preseeded,
    });
    const result = await ensureAgentRuntime({
      pin,
      storeRoot: folder(),
      preseededRoots: [preseeded],
      sourceBases: [],
      fetch: async () => {
        throw new Error("no download expected");
      },
    });
    expect(result.report.outcome).toBe("already-installed");
    expect(result.executablePath.startsWith(preseeded)).toBe(true);
  });

  it("removes versions no longer pinned and staging left by a dead process", async () => {
    const { archive, pin } = await packRuntime(RUNTIME_FILES);
    const store = folder();
    writeFileSync(join(store, "a.tar.zst"), archive);
    await installAgentRuntimeArchive({
      archivePath: join(store, "a.tar.zst"),
      pin,
      storeRoot: store,
    });
    const old = { ...pin, version: "0.165.0" };
    mkdirSync(agentRuntimeInstallDir(store, old), { recursive: true });
    mkdirSync(join(store, ".staging", `codex-${2 ** 22 + 9}-abcd1234`), { recursive: true });
    const removed = await pruneAgentRuntimeStore({ storeRoot: store, keep: [pin] });
    expect(removed).toHaveLength(2);
    expect((await findAgentRuntime([store], pin)).state).toBe("ready");
    expect(existsSync(agentRuntimeInstallDir(store, old))).toBe(false);
  });
});
