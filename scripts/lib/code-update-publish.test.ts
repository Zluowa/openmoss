import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import {
  codeUpdateManifestPath,
  codeUpdatePackagePath,
  signCodeUpdateManifest,
  type CodeUpdateManifest,
} from "@moss/shared/codeUpdate";
import { generateMossUpdateManifestKeyPair } from "@moss/shared/mossUpdateMirror";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import {
  planCodeUpdatePrune,
  pruneCodeUpdateStore,
  readLocalCodeUpdate,
  uploadCodeUpdate,
  type CodeUpdateStore,
  type CodeUpdateStoreTarget,
} from "./code-update-publish.ts";

const keys = generateMossUpdateManifestKeyPair();
const COMMIT = "c".repeat(40);
let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "moss-code-update-publish-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

async function buildOut(options: { sign?: boolean } = {}) {
  const out = path.join(work, "out");
  const bytes = Buffer.from("package bytes ".repeat(500));
  const sha256 = createHash("sha256").update(bytes).digest("hex");
  const manifest: CodeUpdateManifest = {
    schema: 1,
    channel: "preview",
    sequence: 7,
    commit: COMMIT,
    codeVersion: "v",
    shells: ["a".repeat(40)],
    package: {
      path: codeUpdatePackagePath(COMMIT, sha256),
      size: bytes.length,
      sha256,
      archiveSize: 10,
      archiveSha256: "0".repeat(64),
    },
    migrations: { latest: 170, readerFloor: 169 },
    results: {},
  };
  const text = `${JSON.stringify(manifest)}\n`;
  await mkdir(path.dirname(path.join(out, manifest.package.path)), { recursive: true });
  await writeFile(path.join(out, manifest.package.path), bytes);
  await mkdir(path.dirname(path.join(out, codeUpdateManifestPath("preview"))), { recursive: true });
  await writeFile(path.join(out, codeUpdateManifestPath("preview")), text);
  if (options.sign !== false) {
    await writeFile(
      path.join(out, `${codeUpdateManifestPath("preview")}.sig`),
      signCodeUpdateManifest({ manifest: text, channel: "preview", privateKey: keys.privateKey }),
    );
  }
  return { out, manifest };
}

/** An in-memory store plus a public fetch that serves what is stored (optionally corrupted). */
function memoryStores(labels: string[], options: { corrupt?: string } = {}) {
  const events: string[] = [];
  const contents = new Map<string, Map<string, { bytes: Buffer; lastModified: Date }>>();
  const targets: CodeUpdateStoreTarget[] = labels.map((label) => {
    const objects = new Map<string, { bytes: Buffer; lastModified: Date }>();
    contents.set(label, objects);
    const store: CodeUpdateStore = {
      upload: async (key, localPath) => {
        events.push(`${label} upload ${key}`);
        objects.set(key, { bytes: await readFile(localPath), lastModified: new Date() });
      },
      sizeOf: async (key) => objects.get(key)?.bytes.length ?? null,
      list: async (prefix) =>
        [...objects.entries()]
          .filter(([key]) => key.startsWith(prefix))
          .map(([key, value]) => ({
            key,
            size: value.bytes.length,
            lastModified: value.lastModified,
          })),
      delete: async (key) => {
        events.push(`${label} delete ${key}`);
        objects.delete(key);
      },
    };
    return { label, store, publicBaseUrl: `https://${label}.example/` };
  });
  const fetchImpl = (async (url: string | URL) => {
    const parsed = new URL(String(url));
    const label = parsed.hostname.split(".")[0]!;
    const key = parsed.pathname.slice(1);
    events.push(`${label} GET ${key}${parsed.search}`);
    const object = contents.get(label)?.get(key);
    if (!object) return new Response(null, { status: 404 });
    const bytes =
      options.corrupt === label ? Buffer.from(object.bytes).fill(0x41, 0, 1) : object.bytes;
    return new Response(new Uint8Array(bytes), { status: 200 });
  }) as typeof fetch;
  return { targets, fetchImpl, events, contents };
}

const quiet = { log: () => undefined, attempts: 1, retryDelayMs: 0, sleep: async () => undefined };

describe("readLocalCodeUpdate", () => {
  it("refuses an unsigned manifest and one not signed with the release key", async () => {
    const { out } = await buildOut({ sign: false });
    await expect(readLocalCodeUpdate(out, "preview", keys.manifestPublicKey)).rejects.toThrow(
      /must be signed/u,
    );
    const other = generateMossUpdateManifestKeyPair();
    const signed = await buildOut();
    await expect(
      readLocalCodeUpdate(signed.out, "preview", other.manifestPublicKey),
    ).rejects.toThrow(/does not verify/u);
  });
});

describe("uploadCodeUpdate", () => {
  it("puts the package on every store and reads it back before any manifest goes anywhere", async () => {
    const { out, manifest } = await buildOut();
    const local = await readLocalCodeUpdate(out, "preview", keys.manifestPublicKey);
    const { targets, fetchImpl, events } = memoryStores(["cos", "r2"]);
    const result = await uploadCodeUpdate({ local, targets, publish: true, fetchImpl, ...quiet });
    expect(result.published).toBe(true);
    const firstManifestUpload = events.findIndex((event) => event.includes("upload preview/"));
    const lastPackageRead = events.findLastIndex((event) =>
      event.includes(`GET ${manifest.package.path}`),
    );
    expect(lastPackageRead).toBeLessThan(firstManifestUpload);
    expect(
      events.filter((event) => event.includes(`GET ${codeUpdateManifestPath("preview")}?noCache=`)),
    ).toHaveLength(2);
  });

  it("uploads no manifest anywhere when one store does not serve the package's bytes", async () => {
    const { out } = await buildOut();
    const local = await readLocalCodeUpdate(out, "preview", keys.manifestPublicKey);
    const { targets, fetchImpl, events } = memoryStores(["cos", "r2"], { corrupt: "r2" });
    const result = await uploadCodeUpdate({ local, targets, publish: true, fetchImpl, ...quiet });
    expect(result.published).toBe(false);
    expect(events.some((event) => event.includes("upload preview/"))).toBe(false);
  });

  it("writes nothing anywhere when a store holds another object under the package's name", async () => {
    const { out, manifest } = await buildOut();
    const local = await readLocalCodeUpdate(out, "preview", keys.manifestPublicKey);
    const { targets, fetchImpl, events, contents } = memoryStores(["cos", "r2"]);
    contents
      .get("r2")!
      .set(manifest.package.path, { bytes: Buffer.from("other"), lastModified: new Date() });
    const result = await uploadCodeUpdate({ local, targets, publish: true, fetchImpl, ...quiet });
    expect(result.published).toBe(false);
    expect(events.some((event) => event.includes(" upload "))).toBe(false);
  });

  it("writes nothing in a dry run", async () => {
    const { out } = await buildOut();
    const local = await readLocalCodeUpdate(out, "preview", keys.manifestPublicKey);
    const { targets, fetchImpl, events } = memoryStores(["cos"]);
    const result = await uploadCodeUpdate({ local, targets, publish: false, fetchImpl, ...quiet });
    expect(result.published).toBe(false);
    expect(events.some((event) => event.includes(" upload "))).toBe(false);
    expect(result.lines.map((line) => line.action)).toEqual([
      "would upload",
      "would upload",
      "would upload",
    ]);
  });
});

describe("prune", () => {
  const now = new Date("2026-11-19T12:00:00Z");
  const hoursAgo = (hours: number) => new Date(now.getTime() - hours * 3_600_000);
  const pkg = (n: number) =>
    `desktop/code/v1/moss-code-${String(n).repeat(12)}-${"1".repeat(16)}.asar.zst`;

  it("keeps what a served manifest names, what is recent, and what is not a package", () => {
    const plan = planCodeUpdatePrune({
      objects: [
        { key: pkg(1), size: 1, lastModified: hoursAgo(100) },
        { key: pkg(2), size: 1, lastModified: hoursAgo(100) },
        { key: pkg(3), size: 1, lastModified: hoursAgo(2) },
        { key: "desktop/code/v1/README.txt", size: 1, lastModified: hoursAgo(100) },
      ],
      named: new Set([pkg(1)]),
      now,
      keepHours: 24,
    });
    expect(plan.remove).toEqual([pkg(2)]);
    expect(plan.keep.map((entry) => entry.key)).toEqual([
      pkg(1),
      pkg(3),
      "desktop/code/v1/README.txt",
    ]);
  });

  it("deletes nothing in a dry run, and stops when a served manifest cannot be read", async () => {
    const { targets, fetchImpl, events, contents } = memoryStores(["cos"]);
    contents.get("cos")!.set(pkg(2), { bytes: Buffer.from("x"), lastModified: hoursAgo(100) });
    const plan = await pruneCodeUpdateStore({
      target: targets[0]!,
      apply: false,
      keepHours: 24,
      fetchImpl,
      now: () => now,
      log: () => undefined,
    });
    expect(plan.remove).toEqual([pkg(2)]);
    expect(events.some((event) => event.includes(" delete "))).toBe(false);

    const failing = (async () => new Response(null, { status: 503 })) as unknown as typeof fetch;
    await expect(
      pruneCodeUpdateStore({
        target: targets[0]!,
        apply: true,
        keepHours: 24,
        fetchImpl: failing,
        now: () => now,
        log: () => undefined,
      }),
    ).rejects.toThrow(/prune stops/u);
    expect(events.some((event) => event.includes(" delete "))).toBe(false);
  });
});
