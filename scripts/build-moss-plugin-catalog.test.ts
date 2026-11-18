import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, dirname, join } from "node:path";

import type { MossPluginCatalogPackage } from "@moss/shared/mossPluginCatalog";
import { encodeMossPluginPackage } from "@moss/shared/mossPluginPackage";
import { afterEach, describe, expect, it } from "vitest";

import {
  catalogPublicBaseUrl,
  runCatalogUpload,
  uploadCatalogToStores,
  verifyServedCatalog,
} from "./build-moss-plugin-catalog.ts";

const demoPackage = encodeMossPluginPackage({
  name: "demo",
  version: "1.2.3",
  files: [
    {
      path: "skills/demo/SKILL.md",
      executable: false,
      bytes: new TextEncoder().encode("---\nname: demo\n---\n"),
    },
  ],
});

const demo: MossPluginCatalogPackage = {
  name: "demo",
  version: "1.2.3",
  displayName: "Demo",
  developerName: "Moss",
  license: "MIT",
  description: "Demo plugin",
  websiteUrl: null,
  icon: "icons/demo.png",
  skills: [{ name: "demo", description: "Demo skill" }],
  mcpServers: [],
  package: {
    file: "packages/demo-1.2.3.json.gz",
    sha256: demoPackage.sha256,
    bytes: demoPackage.json.byteLength,
  },
};

const folders: string[] = [];
afterEach(() => {
  for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
});

/** A source that refuses HEAD the way the COS default domain does. */
function cosLikeSource(files: Readonly<Record<string, Uint8Array>>) {
  const requests: Array<{ url: string; method: string; range: string | null }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const method = init?.method ?? "GET";
    const range = new Headers(init?.headers).get("range");
    requests.push({ url, method, range });
    if (method !== "GET") return new Response(null, { status: 403 });
    const bytes = files[new URL(url).pathname];
    if (!bytes) return new Response(null, { status: 404 });
    if (range === "bytes=0-0") {
      return new Response(new Uint8Array(bytes.subarray(0, 1)), {
        status: 206,
        headers: { "content-range": `bytes 0-0/${bytes.length}` },
      });
    }
    return new Response(new Uint8Array(bytes));
  }) as typeof fetch;
  return { fetchImpl, requests };
}

describe("verifyServedCatalog", () => {
  it("reads packages and icons with GET only, so a source that refuses HEAD passes", async () => {
    const source = cosLikeSource({
      "/plugin-catalog/v1/packages/demo-1.2.3.json.gz": demoPackage.gzip,
      "/plugin-catalog/v1/icons/demo.png": new Uint8Array([137, 80, 78, 71]),
    });

    await verifyServedCatalog({
      baseUrl: "https://cos.example.test/plugin-catalog/v1/",
      catalog: [demo],
      fetchImpl: source.fetchImpl,
      attempts: 1,
      log: () => undefined,
    });

    expect(source.requests).toEqual([
      {
        url: "https://cos.example.test/plugin-catalog/v1/packages/demo-1.2.3.json.gz",
        method: "GET",
        range: null,
      },
      {
        url: "https://cos.example.test/plugin-catalog/v1/icons/demo.png",
        method: "GET",
        range: "bytes=0-0",
      },
    ]);
  });

  it("fails when an icon is missing", async () => {
    const source = cosLikeSource({
      "/plugin-catalog/v1/packages/demo-1.2.3.json.gz": demoPackage.gzip,
    });
    await expect(
      verifyServedCatalog({
        baseUrl: "https://cos.example.test/plugin-catalog/v1/",
        catalog: [demo],
        fetchImpl: source.fetchImpl,
        attempts: 1,
        log: () => undefined,
      }),
    ).rejects.toThrow(/icon missing \(HTTP 404\)/);
  });
});

describe("catalogPublicBaseUrl", () => {
  it("keeps one store on MOSS_PLUGIN_CATALOG_URL or the R2 copy, as before", () => {
    expect(catalogPublicBaseUrl({}, { severalStores: false, prefix: "plugin-catalog/v1/" })).toBe(
      "https://update.mossbotai.com/plugin-catalog/v1/",
    );
    expect(
      catalogPublicBaseUrl(
        { MOSS_PLUGIN_CATALOG_URL: "https://elsewhere.example.test/c" },
        { severalStores: false, prefix: "plugin-catalog/v1/" },
      ),
    ).toBe("https://elsewhere.example.test/c/");
  });

  it("derives each store's catalog URL from its own feed URL", () => {
    expect(
      catalogPublicBaseUrl(
        { MOSS_UPDATE_MIRROR_FEED_URL: "https://cos.example.test/desktop/" },
        { severalStores: true, prefix: "plugin-catalog/v1/" },
      ),
    ).toBe("https://cos.example.test/plugin-catalog/v1/");
    expect(() =>
      catalogPublicBaseUrl({}, { severalStores: true, prefix: "plugin-catalog/v1/" }),
    ).toThrow(/every settings folder/);
  });
});

describe("uploadCatalogToStores", () => {
  function builtCatalog(): string {
    const out = mkdtempSync(join(tmpdir(), "moss-catalog-out-"));
    folders.push(out);
    for (const [key, bytes] of [
      [demo.package.file, demoPackage.gzip],
      [demo.icon!, new Uint8Array([1, 2, 3])],
      ["packages/unrelated.json.gz", new Uint8Array([9])],
    ] as const) {
      mkdirSync(dirname(join(out, key)), { recursive: true });
      writeFileSync(join(out, key), bytes);
    }
    return out;
  }

  it("writes and verifies every store, and reports a failing one only after trying the rest", async () => {
    const written: Record<string, string[]> = { cos: [], r2: [] };
    const verified: string[] = [];
    const logs: string[] = [];
    const failure = await uploadCatalogToStores({
      out: builtCatalog(),
      severalStores: true,
      catalog: [demo],
      stores: [
        {
          label: "cos-folder",
          env: {
            MOSS_UPDATE_MIRROR_S3_BUCKET: "cos",
            MOSS_UPDATE_MIRROR_FEED_URL: "https://cos.example.test/desktop/",
          },
        },
        {
          label: "r2-folder",
          env: {
            MOSS_UPDATE_MIRROR_S3_BUCKET: "r2",
            MOSS_UPDATE_MIRROR_FEED_URL: "https://r2.example.test/desktop/",
          },
        },
      ],
      createWriter: (env) => async (key) => {
        if (env.MOSS_UPDATE_MIRROR_S3_BUCKET === "cos") throw new Error("COS write refused");
        written[env.MOSS_UPDATE_MIRROR_S3_BUCKET!]!.push(key);
      },
      verifyStore: async (baseUrl) => {
        verified.push(baseUrl);
      },
      log: (message) => logs.push(message),
    }).catch((error: unknown) => error as Error);

    expect(String(failure)).toMatch(
      /1 of 2 catalog store\(s\) failed:\ncos-folder: COS write refused/,
    );
    expect(written.r2?.toSorted()).toEqual([
      "plugin-catalog/v1/icons/demo.png",
      "plugin-catalog/v1/packages/demo-1.2.3.json.gz",
    ]);
    expect(verified).toEqual(["https://r2.example.test/plugin-catalog/v1/"]);
  });

  it("uploads nothing when the built folder lacks a pinned file", async () => {
    const out = mkdtempSync(join(tmpdir(), "moss-catalog-out-"));
    folders.push(out);
    const writes: string[] = [];
    await expect(
      uploadCatalogToStores({
        out,
        severalStores: false,
        catalog: [demo],
        stores: [{ label: "only", env: {} }],
        createWriter: () => async (key) => {
          writes.push(key);
        },
        verifyStore: async () => undefined,
        log: () => undefined,
      }),
    ).rejects.toThrow(/Missing from .*Run build first/);
    expect(writes).toEqual([]);
  });

  it("writes every store listed in the default settings folder, needing a feed URL in each", async () => {
    const home = mkdtempSync(join(tmpdir(), "moss-catalog-home-"));
    folders.push(home);
    const listing = join(home, ".moss-release");
    const write = (folder: string, values: Record<string, string>) => {
      mkdirSync(folder, { recursive: true });
      writeFileSync(
        join(folder, "update-mirror.env"),
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
      );
    };
    write(listing, {
      MOSS_UPDATE_MIRROR_SETTINGS_DIRS: ["cos", "r2"].join(delimiter),
      MOSS_UPDATE_MIRROR_FEED_URL: "https://listing.example.test/desktop/",
    });
    write(join(listing, "cos"), {
      MOSS_UPDATE_MIRROR_S3_BUCKET: "cos",
      MOSS_UPDATE_MIRROR_FEED_URL: "https://cos.example.test/desktop/",
    });
    write(join(listing, "r2"), { MOSS_UPDATE_MIRROR_S3_BUCKET: "r2" });
    const written: string[] = [];
    const verified: string[] = [];
    const logs: string[] = [];

    const failure = await runCatalogUpload({
      out: builtCatalog(),
      env: {},
      homeDirectory: home,
      catalog: [demo],
      createWriter: (env) => async (key) => {
        written.push(`${env.MOSS_UPDATE_MIRROR_S3_BUCKET}:${key}`);
      },
      verifyStore: async (baseUrl) => {
        verified.push(baseUrl);
      },
      log: (message) => logs.push(message),
    }).catch((error: unknown) => error as Error);

    expect(logs[0]).toBe(
      `Store folders listed in ${listing}: ${join(listing, "cos")}, ${join(listing, "r2")}`,
    );
    // Several stores: the R2 folder may not fall back to the single-store default URL.
    expect(String(failure)).toContain(
      `${join(listing, "r2")}: Set MOSS_PLUGIN_CATALOG_URL or MOSS_UPDATE_MIRROR_FEED_URL in every settings folder.`,
    );
    expect(verified).toEqual(["https://cos.example.test/plugin-catalog/v1/"]);
    expect(written.every((entry) => entry.startsWith("cos:"))).toBe(true);
  });
});
