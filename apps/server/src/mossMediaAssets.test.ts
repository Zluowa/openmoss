import { mkdtempSync, rmSync } from "node:fs";
import { lstat, readFile, readdir, unlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MossMediaAssetStore } from "./mossMediaAssets";
import { createRejectedFileAlias } from "../../../scripts/fixtures/filesystem-links.ts";

const PNG = Uint8Array.from([137, 80, 78, 71, 13, 10, 26, 10, 0, 1, 2, 3]);
const directories: string[] = [];
const scope = "a".repeat(64);
function directory() {
  const path = mkdtempSync(join(tmpdir(), "moss-media-assets-"));
  directories.push(path);
  return path;
}
afterEach(() =>
  directories.splice(0).forEach((path) => rmSync(path, { recursive: true, force: true })),
);

describe("Moss media durable assets", () => {
  it("serializes concurrent commits so distinct outputs cannot overrun the account limit", async () => {
    const path = directory();
    const store = new MossMediaAssetStore(
      path,
      async (request) => {
        const bytes = new Uint8Array(PNG);
        bytes[bytes.length - 1] = Number(new URL(request.url).pathname.slice(1));
        return {
          status: 200,
          body: bytes,
          headers: new Headers({ "content-type": "image/png" }),
          url: String(request.url),
        };
      },
      PNG.byteLength * 2,
    );
    const results = await Promise.all(
      [1, 2, 3].map((n) =>
        store.cache(scope, `moss_job${n}`, [`https://cdn.example/${n}`], "image"),
      ),
    );
    expect(results.flat()).toHaveLength(2);
    const names = await readdir(join(path, "media-assets", scope));
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    const sizes = await Promise.all(
      names.map(async (name) => (await lstat(join(path, "media-assets", scope, name))).size),
    );
    expect(sizes.reduce((sum, size) => sum + size, 0)).toBe(PNG.byteLength * 2);
  });

  it("rejects symlink reads and repairs same-length corrupt deduplicated files", async () => {
    const path = directory();
    const store = new MossMediaAssetStore(path, async () => ({
      status: 200,
      body: PNG,
      headers: new Headers({ "content-type": "image/png" }),
      url: "https://cdn.example/image",
    }));
    const [asset] = await store.cache(scope, "moss_job", ["https://cdn.example/image"], "image");
    const file = join(path, "media-assets", scope, `${asset!.assetId}.png`);
    await writeFile(file, new Uint8Array(PNG.byteLength));
    await expect(store.read(scope, asset!)).rejects.toThrow();
    expect(
      await store.cache(scope, "moss_repaired", ["https://cdn.example/image"], "image"),
    ).toHaveLength(1);
    expect([...(await store.read(scope, asset!))]).toEqual([...PNG]);
    const external = join(path, "outside.png");
    await writeFile(external, PNG);
    await unlink(file);
    // Windows occupies this regular-file slot with a junction to test no-follow refusal.
    createRejectedFileAlias(external, file);
    await expect(store.read(scope, asset!)).rejects.toThrow();
    expect([...(await readFile(external))]).toEqual([...PNG]);
  });

  it("skips collection against a live download then consults fresh committed references", async () => {
    let release!: () => void;
    let entered!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const started = new Promise<void>((resolve) => {
      entered = resolve;
    });
    let active = true;
    const store = new MossMediaAssetStore(directory(), async () => {
      entered();
      await gate;
      return {
        status: 200,
        body: PNG,
        headers: new Headers({ "content-type": "image/png" }),
        url: "https://cdn.example/image",
      };
    });
    const caching = store.cache(scope, "moss_job", ["https://cdn.example/image"], "image");
    await started;
    await store.collectUnreferenced(scope, () => (active ? null : new Set()));
    release();
    const assets = await caching;
    active = false;
    await store.collectUnreferenced(scope, () => new Set(assets.map((asset) => asset.assetId)));
    expect([...(await store.read(scope, assets[0]!))]).toEqual([...PNG]);
  });

  it("persists verified bytes across restarts and scopes reads to the account", async () => {
    const path = directory();
    const download = vi.fn(async (_request: unknown) => ({
      status: 200,
      body: PNG,
      headers: new Headers({ "content-type": "image/png" }),
      url: "https://cdn.example/image",
    }));
    const store = new MossMediaAssetStore(path, download);
    const assets = await store.cache(scope, "moss_job", ["https://cdn.example/image"], "image");
    expect(assets).toHaveLength(1);
    const asset = assets[0]!;
    expect(asset.downloadPath).toBe("/api/moss/media/assets/moss_job/0");
    expect([...(await new MossMediaAssetStore(path, download).read(scope, asset))]).toEqual([
      ...PNG,
    ]);
    await expect(store.read("b".repeat(64), asset)).rejects.toThrow();
    expect(download).toHaveBeenCalledWith(
      expect.objectContaining({
        method: "GET",
        policy: expect.objectContaining({
          requirePublicAddress: true,
          allowedOrigins: ["https://cdn.example"],
          maxRedirects: 0,
          maxResponseBytes: 32 * 1024 * 1024,
        }),
      }),
    );
    expect(download.mock.calls[0]?.[0]).not.toHaveProperty("headers");
  });
  it("never admits credential-bearing or non-HTTPS URLs into the downloader", async () => {
    const download = vi.fn();
    const store = new MossMediaAssetStore(directory(), download);
    expect(
      await store.cache(
        scope,
        "moss_job",
        ["http://127.0.0.1/secret", "https://user:pass@example.com/file", "file:///secret"],
        "image",
      ),
    ).toEqual([]);
    expect(download).not.toHaveBeenCalled();
  });
  it("rejects mismatched signatures and unsupported MIME without pretending persistence succeeded", async () => {
    const store = new MossMediaAssetStore(directory(), async () => ({
      status: 200,
      body: new TextEncoder().encode("<html>secret</html>"),
      headers: new Headers({ "content-type": "image/png" }),
      url: "https://cdn.example/image",
    }));
    expect(await store.cache(scope, "moss_job", ["https://cdn.example/image"], "image")).toEqual(
      [],
    );
    const svg = new MossMediaAssetStore(directory(), async () => ({
      status: 200,
      body: new TextEncoder().encode("<svg/>"),
      headers: new Headers({ "content-type": "image/svg+xml" }),
      url: "https://cdn.example/image",
    }));
    expect(await svg.cache(scope, "moss_job", ["https://cdn.example/image"], "image")).toEqual([]);
  });
  it("preserves successful output indexes when another cache download fails", async () => {
    const store = new MossMediaAssetStore(directory(), async (request) => {
      if (String(request.url).endsWith("/missing")) throw new Error("expired");
      return {
        status: 200,
        body: PNG,
        headers: new Headers({ "content-type": "image/png" }),
        url: String(request.url),
      };
    });
    const assets = await store.cache(
      scope,
      "moss_job",
      ["https://cdn.example/missing", "https://cdn.example/retained"],
      "image",
    );
    expect(assets.map((asset) => asset.index)).toEqual([1]);
    expect([...(await store.read(scope, assets[0]!))]).toEqual([...PNG]);
  });

  it("reclaims evicted job files while retaining referenced outputs at the cache limit", async () => {
    const store = new MossMediaAssetStore(
      directory(),
      async (request) => {
        const bytes = new Uint8Array(PNG);
        bytes[bytes.length - 1] = Number(new URL(request.url).pathname.slice(1));
        return {
          status: 200,
          body: bytes,
          headers: new Headers({ "content-type": "image/png" }),
          url: String(request.url),
        };
      },
      PNG.byteLength * 2,
    );
    const first = await store.cache(scope, "moss_first", ["https://cdn.example/1"], "image");
    const retained = await store.cache(scope, "moss_retained", ["https://cdn.example/2"], "image");
    expect(await store.cache(scope, "moss_new", ["https://cdn.example/3"], "image")).toEqual([]);
    await store.collectUnreferenced(scope, () => new Set(retained.map((asset) => asset.assetId)));
    await expect(store.read(scope, first[0]!)).rejects.toThrow();
    expect((await store.read(scope, retained[0]!)).length).toBe(PNG.byteLength);
    expect(await store.cache(scope, "moss_new", ["https://cdn.example/3"], "image")).toHaveLength(
      1,
    );
  });
  it("keeps archived assets and aborts collection when the history index cannot be read", async () => {
    const store = new MossMediaAssetStore(directory(), async (request) => ({
      status: 200,
      body: PNG,
      headers: new Headers({ "content-type": "image/png" }),
      url: String(request.url),
    }));
    const [asset] = await store.cache(
      scope,
      "moss_archived",
      ["https://cdn.example/history"],
      "image",
    );
    await store.collectUnreferenced(
      scope,
      () => new Set(),
      async () => true,
    );
    expect([...(await store.read(scope, asset!))]).toEqual([...PNG]);
    await store.collectUnreferenced(
      scope,
      () => new Set(),
      async () => {
        throw new Error("database unavailable");
      },
    );
    expect([...(await store.read(scope, asset!))]).toEqual([...PNG]);
    await store.collectUnreferenced(
      scope,
      () => new Set(),
      async () => false,
    );
    await expect(store.read(scope, asset!)).rejects.toThrow();
  });
});
