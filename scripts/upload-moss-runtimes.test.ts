import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  assertRuntimeObjectPath,
  parseRuntimeArchiveList,
  runtimeSourceBaseUrl,
  uploadRuntimeArchives,
  type RuntimeStoreTarget,
} from "./upload-moss-runtimes.ts";

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

const sha256 = (bytes: Uint8Array | string) => createHash("sha256").update(bytes).digest("hex");

function archive(name: string, platform: string, bytes: Buffer) {
  const hash = sha256(bytes);
  return {
    path: `runtimes/v1/${name}/1.2.3/${name}-1.2.3-${platform}-x64-${hash.slice(0, 16)}.tar.zst`,
    size: bytes.length,
    sha256: hash,
    bytes,
  };
}

const codex = archive("codex", "win32", Buffer.from("codex runtime bytes"));
const claude = archive("claude", "win32", Buffer.from("claude runtime bytes, longer"));

function buildOutput(entries = [codex, claude], listing?: unknown): string {
  const out = mkdtempSync(join(tmpdir(), "moss-runtimes-out-"));
  folders.push(out);
  for (const entry of entries) {
    mkdirSync(dirname(join(out, entry.path)), { recursive: true });
    writeFileSync(join(out, entry.path), entry.bytes);
  }
  writeFileSync(
    join(out, "runtime-archives.json"),
    JSON.stringify(
      listing ?? {
        schemaVersion: 1,
        objects: entries.map(({ path, size, sha256: hash }) => ({ path, size, sha256: hash })),
      },
    ),
  );
  return out;
}

/** A store plus its public URL; reads through the URL accept GET only, like the COS source. */
function fakeSource(host: string) {
  const objects = new Map<string, Buffer>();
  const uploads: string[] = [];
  const methods: string[] = [];
  let failUploads = false;
  const target: RuntimeStoreTarget = {
    label: host,
    publicBaseUrl: `https://${host}/`,
    store: {
      upload: async (key, localPath) => {
        if (failUploads) throw new Error("storage refused");
        uploads.push(key);
        objects.set(key, readFileSync(localPath));
      },
      sizeOf: async (key) => objects.get(key)?.length ?? null,
    },
  };
  const serve = (url: URL, init?: RequestInit): Response => {
    const method = init?.method ?? "GET";
    methods.push(method);
    if (method !== "GET") return new Response(null, { status: 403 });
    const bytes = objects.get(url.pathname.slice(1));
    return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
  };
  return {
    target,
    objects,
    uploads,
    methods,
    serve,
    refuseUploads: () => {
      failUploads = true;
    },
  };
}

function network(...sources: ReadonlyArray<ReturnType<typeof fakeSource>>): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : input);
    const source = sources.find((candidate) => candidate.target.label === url.host);
    if (!source) throw new Error(`unexpected host ${url.host}`);
    return source.serve(url, init);
  }) as typeof fetch;
}

const quiet = { attempts: 2, retryDelayMs: 0 };

describe("runtime object paths", () => {
  it("accepts runtimes/v1/<name>/<version>/<name>-<version>-<platform>-<arch>-<sha16>.tar.zst", () => {
    expect(() => assertRuntimeObjectPath(codex.path, codex.sha256)).not.toThrow();
  });

  it.each([
    ["outside runtimes/v1", `desktop/${codex.path.split("/").pop()}`],
    ["a climb", `runtimes/v1/codex/../../desktop/latest.yml`],
    ["an absolute path", `/${codex.path}`],
    ["a URL", `https://elsewhere.example/${codex.path}`],
    ["a backslash", codex.path.replaceAll("/", "\\")],
    ["an encoded climb", "runtimes/v1/codex/%2e%2e/x.tar.zst"],
    ["another hash in the name", codex.path.replace(codex.sha256.slice(0, 16), "0".repeat(16))],
    ["another name in the file", codex.path.replace("/codex-1.2.3-", "/claude-1.2.3-")],
  ])("refuses %s", (_label, path) => {
    expect(() => assertRuntimeObjectPath(path, codex.sha256)).toThrow();
  });

  const entry = { path: codex.path, size: codex.size, sha256: codex.sha256 };
  const list = (objects: unknown, schemaVersion: unknown = 1) =>
    JSON.stringify({ schemaVersion, objects });

  it("reads the builder's schemaVersion 1 list", () => {
    expect(parseRuntimeArchiveList(list([entry]))).toEqual([entry]);
  });

  it("refuses another schemaVersion instead of half-reading it", () => {
    expect(() => parseRuntimeArchiveList(list([entry], 2))).toThrow(
      /schemaVersion 2; this tool reads only schemaVersion 1/,
    );
    expect(() => parseRuntimeArchiveList(JSON.stringify({ objects: [entry] }))).toThrow(
      /schemaVersion undefined/,
    );
  });

  it("refuses a list without objects, and the earlier list shapes", () => {
    expect(() => parseRuntimeArchiveList(JSON.stringify({ schemaVersion: 1 }))).toThrow(
      /no "objects" list/,
    );
    expect(() =>
      parseRuntimeArchiveList(JSON.stringify({ schemaVersion: 1, archives: [entry] })),
    ).toThrow(/no "objects" list/);
    expect(() => parseRuntimeArchiveList(JSON.stringify([entry]))).toThrow(/must be an object/);
  });

  it("refuses duplicates and bad hashes", () => {
    expect(() => parseRuntimeArchiveList(list([entry, entry]))).toThrow(/twice/);
    expect(() => parseRuntimeArchiveList(list([{ ...entry, sha256: "ABC" }]))).toThrow(
      /invalid entry/,
    );
  });
});

describe("uploadRuntimeArchives", () => {
  it("uploads to every store, skips what is stored, and reads every object back with GET", async () => {
    const cos = fakeSource("cos.example.test");
    const r2 = fakeSource("r2.example.test");
    r2.objects.set(codex.path, codex.bytes);
    const logs: string[] = [];

    const lines = await uploadRuntimeArchives({
      outDirectory: buildOutput(),
      stores: [cos.target, r2.target],
      fetchImpl: network(cos, r2),
      log: (message) => logs.push(message),
      ...quiet,
    });

    expect(cos.uploads.toSorted()).toEqual([claude.path, codex.path].toSorted());
    expect(r2.uploads).toEqual([claude.path]);
    expect(lines.map((line) => [line.store, line.path, line.action, line.served])).toEqual([
      ["cos.example.test", codex.path, "uploaded", true],
      ["cos.example.test", claude.path, "uploaded", true],
      ["r2.example.test", codex.path, "already stored", true],
      ["r2.example.test", claude.path, "uploaded", true],
    ]);
    expect(logs).toHaveLength(4);
    expect([...cos.methods, ...r2.methods].every((method) => method === "GET")).toBe(true);
  });

  it("fails when one store lacks an object, still finishing and reporting the other", async () => {
    const cos = fakeSource("cos.example.test");
    const r2 = fakeSource("r2.example.test");
    cos.refuseUploads();
    const logs: string[] = [];

    const failure = await uploadRuntimeArchives({
      outDirectory: buildOutput(),
      stores: [cos.target, r2.target],
      fetchImpl: network(cos, r2),
      log: (message) => logs.push(message),
      ...quiet,
    }).catch((error: unknown) => error as Error & { lines: Array<{ problem: string | null }> });

    expect(String(failure)).toMatch(/missing or wrong in 1 store\(s\): cos\.example\.test/);
    expect(r2.objects.size).toBe(2);
    expect(logs.filter((line) => line.startsWith("FAIL cos.example.test"))).toHaveLength(2);
    expect(logs.filter((line) => line.startsWith("ok   r2.example.test"))).toHaveLength(2);
    expect(logs[0]).toContain("not served (HTTP 404)");
  });

  it("fails on a served copy whose bytes differ from the list", async () => {
    const r2 = fakeSource("r2.example.test");
    r2.objects.set(codex.path, Buffer.alloc(codex.size, 7));

    const failure = await uploadRuntimeArchives({
      outDirectory: buildOutput([codex]),
      stores: [r2.target],
      fetchImpl: network(r2),
      log: () => undefined,
      ...quiet,
    }).catch((error: unknown) => error as Error);

    expect(String(failure)).toMatch(/missing or wrong/);
    expect(r2.uploads).toEqual([]);
  });

  it("writes nothing into a store that holds an object of that name at another size", async () => {
    const cos = fakeSource("cos.example.test");
    const r2 = fakeSource("r2.example.test");
    cos.objects.set(codex.path, Buffer.from("other bytes of another size, longer than before"));
    const logs: string[] = [];

    const failure = await uploadRuntimeArchives({
      outDirectory: buildOutput(),
      stores: [cos.target, r2.target],
      fetchImpl: network(cos, r2),
      log: (message) => logs.push(message),
      ...quiet,
    }).catch((error: unknown) => error as Error);

    expect(String(failure)).toContain("cos.example.test");
    expect(cos.uploads).toEqual([]);
    expect(String(cos.objects.get(codex.path))).toBe(
      "other bytes of another size, longer than before",
    );
    expect(
      logs.find((line) => line.includes(codex.path) && line.includes("cos.example.test")),
    ).toMatch(/conflict.*not overwritten/);
    // The other store is unaffected.
    expect(r2.uploads).toHaveLength(2);
  });

  it("uploads nothing anywhere when a local file was changed after the list was written", async () => {
    const cos = fakeSource("cos.example.test");
    const out = buildOutput();
    writeFileSync(join(out, codex.path), Buffer.alloc(codex.size, 1));

    await expect(
      uploadRuntimeArchives({
        outDirectory: out,
        stores: [cos.target],
        fetchImpl: network(cos),
        log: () => undefined,
        ...quiet,
      }),
    ).rejects.toThrow(/nothing was uploaded:\n.*its sha256 differs from the list/);
    expect(cos.uploads).toEqual([]);
  });

  it("uploads nothing when a listed file is missing or a listed path leaves runtimes/v1", async () => {
    const cos = fakeSource("cos.example.test");
    const missing = buildOutput([codex]);
    rmSync(join(missing, codex.path));
    await expect(
      uploadRuntimeArchives({
        outDirectory: missing,
        stores: [cos.target],
        fetchImpl: network(cos),
        log: () => undefined,
        ...quiet,
      }),
    ).rejects.toThrow(/missing from/);

    const outside = buildOutput([codex], {
      schemaVersion: 1,
      objects: [{ path: "desktop/latest.yml", size: 1, sha256: "0".repeat(64) }],
    });
    await expect(
      uploadRuntimeArchives({
        outDirectory: outside,
        stores: [cos.target],
        fetchImpl: network(cos),
        log: () => undefined,
        ...quiet,
      }),
    ).rejects.toThrow(/must be under runtimes\/v1\//);
    expect(cos.uploads).toEqual([]);
  });
});

describe("runtimeSourceBaseUrl", () => {
  it("serves runtimes from the origin of each store's feed, one store defaulting to R2", () => {
    expect(
      runtimeSourceBaseUrl(
        { MOSS_UPDATE_MIRROR_FEED_URL: "https://cos.example.test/desktop/" },
        { severalStores: true },
      ),
    ).toBe("https://cos.example.test/");
    expect(runtimeSourceBaseUrl({}, { severalStores: false })).toBe(
      "https://update.mossbotai.com/",
    );
    expect(() => runtimeSourceBaseUrl({}, { severalStores: true })).toThrow(
      /every settings folder/,
    );
  });
});
