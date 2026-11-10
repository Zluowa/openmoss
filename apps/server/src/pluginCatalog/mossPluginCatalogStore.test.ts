import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { encodeMossPluginPackage } from "@moss/shared/mossPluginPackage";

import {
  ensureMossPluginCatalogPlugin,
  isMossPluginCatalogMarketplacePath,
  materializeMossPluginCatalogMarketplace,
  mossPluginCatalogMarketplacePath,
  mossPluginCatalogRoot,
  MossPluginCatalogDownloadError,
  prefetchMossPluginCatalog,
} from "./mossPluginCatalogStore";

const demoPackage = encodeMossPluginPackage({
  name: "demo",
  version: "1.2.3",
  files: [
    {
      path: ".codex-plugin/plugin.json",
      executable: false,
      bytes: new TextEncoder().encode('{"name":"demo","version":"1.2.3"}'),
    },
    {
      path: "skills/demo/SKILL.md",
      executable: false,
      bytes: new TextEncoder().encode("---\nname: demo\n---\n"),
    },
  ],
});

const demoEntry = {
  name: "demo",
  version: "1.2.3",
  displayName: "Demo",
  developerName: "Moss",
  license: "MIT",
  description: "Demo plugin",
  websiteUrl: null,
  icon: null,
  skills: [{ name: "demo", description: "Demo skill" }],
  mcpServers: [],
  package: {
    file: "packages/demo-1.2.3.json.gz",
    sha256: demoPackage.sha256,
    bytes: demoPackage.json.byteLength,
  },
  category: "Developer Tools" as const,
  zhDescription: "演示插件",
};
const catalog = [demoEntry];

const roots: string[] = [];
function makeRoot(): string {
  const stateDir = mkdtempSync(path.join(tmpdir(), "moss-plugin-catalog-"));
  roots.push(stateDir);
  return mossPluginCatalogRoot(stateDir);
}

afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function serving(body: Uint8Array, status = 200) {
  return vi.fn(async (_url: string | URL | Request) => new Response(body, { status }));
}

describe("Moss plugin catalog store", () => {
  it("lists every catalog plugin in a local marketplace, files or not", async () => {
    const root = makeRoot();
    await materializeMossPluginCatalogMarketplace(root, catalog);
    const manifest = JSON.parse(readFileSync(mossPluginCatalogMarketplacePath(root), "utf8"));
    expect(manifest).toEqual({
      name: "moss-catalog",
      interface: { displayName: "Moss Plugin Catalog" },
      plugins: [
        {
          name: "demo",
          source: { source: "local", path: "./plugins/demo" },
          policy: { installation: "AVAILABLE", authentication: "ON_USE" },
          category: "Developer Tools",
        },
      ],
    });
    expect(isMossPluginCatalogMarketplacePath(root, mossPluginCatalogMarketplacePath(root))).toBe(
      true,
    );
    expect(isMossPluginCatalogMarketplacePath(root, path.join(root, "other.json"))).toBe(false);
    expect(
      isMossPluginCatalogMarketplacePath(undefined, mossPluginCatalogMarketplacePath(root)),
    ).toBe(false);
  });

  it("downloads, verifies and unpacks a plugin once, then reuses it", async () => {
    const root = makeRoot();
    const fetchImpl = serving(demoPackage.gzip);
    const input = {
      root,
      name: "demo",
      baseUrl: "http://127.0.0.1:9/catalog/",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      catalog,
    };
    expect(await ensureMossPluginCatalogPlugin(input)).toBe("downloaded");
    expect(fetchImpl).toHaveBeenCalledWith(
      "http://127.0.0.1:9/catalog/packages/demo-1.2.3.json.gz",
      expect.anything(),
    );
    const plugin = path.join(root, "plugins", "demo");
    expect(readFileSync(path.join(plugin, "skills", "demo", "SKILL.md"), "utf8")).toContain(
      "name: demo",
    );
    expect(JSON.parse(readFileSync(path.join(plugin, ".moss-package.json"), "utf8")).sha256).toBe(
      demoPackage.sha256,
    );
    expect(await ensureMossPluginCatalogPlugin(input)).toBe("present");
    expect(fetchImpl).toHaveBeenCalledTimes(1);
    // No staging or retired copies are left behind.
    expect(readdirSync(path.join(root, "plugins"))).toEqual(["demo"]);
  });

  it("shares one download between concurrent callers", async () => {
    const root = makeRoot();
    const fetchImpl = serving(demoPackage.gzip);
    const input = {
      root,
      name: "demo",
      fetchImpl: fetchImpl as unknown as typeof fetch,
      catalog,
    };
    const results = await Promise.all([
      ensureMossPluginCatalogPlugin(input),
      ensureMossPluginCatalogPlugin(input),
    ]);
    expect(results).toEqual(["downloaded", "downloaded"]);
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("writes nothing when the mirror serves something else or is unreachable", async () => {
    const root = makeRoot();
    const tampered = encodeMossPluginPackage({
      name: "demo",
      version: "1.2.3",
      files: [{ path: "evil.sh", executable: true, bytes: new TextEncoder().encode("rm -rf /") }],
    });
    await expect(
      ensureMossPluginCatalogPlugin({
        root,
        name: "demo",
        fetchImpl: serving(tampered.gzip) as unknown as typeof fetch,
        catalog,
      }),
    ).rejects.toBeInstanceOf(MossPluginCatalogDownloadError);
    const failing = vi.fn(async () => {
      throw new TypeError("fetch failed");
    });
    await expect(
      ensureMossPluginCatalogPlugin({
        root,
        name: "demo",
        fetchImpl: failing as unknown as typeof fetch,
        catalog,
      }),
    ).rejects.toThrow(/couldn't download this plugin/u);
    // One retry, then the person gets the calm message.
    expect(failing).toHaveBeenCalledTimes(2);
    expect(existsSync(path.join(root, "plugins", "demo"))).toBe(false);
  });

  it("refuses plugins outside the catalog", async () => {
    await expect(
      ensureMossPluginCatalogPlugin({ root: makeRoot(), name: "nope", catalog }),
    ).rejects.toThrow(/not in the Moss plugin catalog/u);
  });

  it("prefetches every plugin and reports failures without throwing", async () => {
    const root = makeRoot();
    await prefetchMossPluginCatalog(root, {
      fetchImpl: serving(demoPackage.gzip) as unknown as typeof fetch,
      catalog,
    });
    expect(existsSync(path.join(root, "plugins", "demo", ".moss-package.json"))).toBe(true);

    const other = makeRoot();
    const onError = vi.fn();
    await prefetchMossPluginCatalog(other, {
      fetchImpl: serving(new Uint8Array(), 404) as unknown as typeof fetch,
      catalog,
      onError,
    });
    expect(onError).toHaveBeenCalledWith("demo", expect.any(MossPluginCatalogDownloadError));
  });
});
