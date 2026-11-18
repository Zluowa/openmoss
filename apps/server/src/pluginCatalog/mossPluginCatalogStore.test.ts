import { existsSync, mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";
import { mossDownloadSourceOrder } from "@moss/shared/mossDownloadSources";
import { encodeMossPluginPackage } from "@moss/shared/mossPluginPackage";

import {
  ensureMossPluginCatalogPlugin,
  isMossPluginCatalogMarketplacePath,
  materializeMossPluginCatalogMarketplace,
  mossPluginCatalogMarketplacePath,
  mossPluginCatalogRoot,
  MossPluginCatalogDownloadError,
  mossPluginCatalogSourceOrder,
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

const COS_PACKAGE =
  "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/plugin-catalog/v1/packages/demo-1.2.3.json.gz";
const R2_PACKAGE = "https://update.mossbotai.com/plugin-catalog/v1/packages/demo-1.2.3.json.gz";

type SourceAnswer = "package" | "tampered" | "timeout" | "refused" | number;

/** Each source host answers as told; records every request with its method and headers. */
function sources(answers: Readonly<Record<string, SourceAnswer>>) {
  const tampered = encodeMossPluginPackage({
    name: "demo",
    version: "1.2.3",
    files: [{ path: "stale.md", executable: false, bytes: new TextEncoder().encode("old") }],
  });
  const requests: Array<{ url: string; method: string; headers: Headers }> = [];
  const fetchImpl = vi.fn(async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    requests.push({
      url,
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
    });
    const answer = answers[new URL(url).host];
    if (answer === undefined) throw new Error(`unexpected request ${url}`);
    if (answer === "refused") throw new TypeError("fetch failed");
    if (answer === "timeout") {
      throw new DOMException("The operation was aborted due to timeout", "TimeoutError");
    }
    if (typeof answer === "number") return new Response("no", { status: answer });
    return new Response(answer === "package" ? demoPackage.gzip : tampered.gzip, { status: 200 });
  });
  return { fetchImpl: fetchImpl as unknown as typeof fetch, requests };
}

const COS_HOST = "moss-update-1259646312.cos.ap-guangzhou.myqcloud.com";
const R2_HOST = "update.mossbotai.com";

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

  it("tries COS first for a mainland lane and R2 first otherwise", async () => {
    const cn = sources({ [COS_HOST]: "package", [R2_HOST]: "package" });
    await ensureMossPluginCatalogPlugin({
      root: makeRoot(),
      name: "demo",
      fetchImpl: cn.fetchImpl,
      catalog,
      resolveSourceOrder: () =>
        mossPluginCatalogSourceOrder({ codex_moss: { config: { realm: "cn" } } }),
    });
    expect(cn.requests.map((request) => request.url)).toEqual([COS_PACKAGE]);

    const global = sources({ [COS_HOST]: "package", [R2_HOST]: "package" });
    await ensureMossPluginCatalogPlugin({
      root: makeRoot(),
      name: "demo",
      fetchImpl: global.fetchImpl,
      catalog,
      resolveSourceOrder: async () => "global" as const,
    });
    expect(global.requests.map((request) => request.url)).toEqual([R2_PACKAGE]);
  });

  it.each([
    ["a timeout", "timeout"],
    ["a refused connection", "refused"],
    ["HTTP 403", 403],
    ["HTTP 404", 404],
    ["HTTP 206", 206],
    ["a copy that fails the pinned hash", "tampered"],
  ] as const)("moves to the next source after %s", async (_label, firstAnswer) => {
    const root = makeRoot();
    const world = sources({ [COS_HOST]: firstAnswer, [R2_HOST]: "package" });

    expect(
      await ensureMossPluginCatalogPlugin({
        root,
        name: "demo",
        fetchImpl: world.fetchImpl,
        catalog,
        resolveSourceOrder: () => "cn",
      }),
    ).toBe("downloaded");

    expect(world.requests.map((request) => request.url)).toEqual([COS_PACKAGE, R2_PACKAGE]);
    // The installed files are the pinned ones from the second source, not the stale copy.
    expect(existsSync(path.join(root, "plugins", "demo", "skills", "demo", "SKILL.md"))).toBe(true);
    expect(existsSync(path.join(root, "plugins", "demo", "stale.md"))).toBe(false);
  });

  it("downloads with a plain GET: no HEAD, no range, no credentials", async () => {
    const world = sources({ [COS_HOST]: 500, [R2_HOST]: "package" });
    await ensureMossPluginCatalogPlugin({
      root: makeRoot(),
      name: "demo",
      fetchImpl: world.fetchImpl,
      catalog,
      resolveSourceOrder: () => "cn",
    });
    expect(world.requests).toHaveLength(2);
    for (const request of world.requests) {
      expect(request.method).toBe("GET");
      expect(request.headers.has("authorization")).toBe(false);
      expect(request.headers.has("range")).toBe(false);
      expect(request.headers.has("cookie")).toBe(false);
    }
  });

  it("names every source that failed once all of them did", async () => {
    const root = makeRoot();
    const world = sources({ [COS_HOST]: 403, [R2_HOST]: "timeout" });
    const failure = await ensureMossPluginCatalogPlugin({
      root,
      name: "demo",
      fetchImpl: world.fetchImpl,
      catalog,
      resolveSourceOrder: () => "cn",
    }).catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(MossPluginCatalogDownloadError);
    const cause = (failure as Error).cause as Error;
    expect(cause.message).toContain(`${COS_HOST}: HTTP 403`);
    expect(cause.message).toContain(R2_HOST);
    expect(world.requests).toHaveLength(2);
    expect(existsSync(path.join(root, "plugins", "demo"))).toBe(false);
  });

  it("keeps an explicit catalog URL to that one base URL", async () => {
    const world = sources({ "127.0.0.1:9": 503 });
    await expect(
      ensureMossPluginCatalogPlugin({
        root: makeRoot(),
        name: "demo",
        baseUrl: "http://127.0.0.1:9/catalog/",
        fetchImpl: world.fetchImpl,
        catalog,
        resolveSourceOrder: () => "cn",
      }),
    ).rejects.toBeInstanceOf(MossPluginCatalogDownloadError);
    // Retried once, never another source.
    expect(world.requests.map((request) => request.url)).toEqual([
      "http://127.0.0.1:9/catalog/packages/demo-1.2.3.json.gz",
      "http://127.0.0.1:9/catalog/packages/demo-1.2.3.json.gz",
    ]);
  });

  it("orders sources by the account's lane, else by the machine's locale and time zone", () => {
    expect(mossPluginCatalogSourceOrder({ claude_moss: { config: { realm: "enterprise" } } })).toBe(
      "cn",
    );
    expect(mossPluginCatalogSourceOrder({ codex_moss: { config: { realm: "global" } } })).toBe(
      "global",
    );
    // A signed-out account (instances disabled) has no lane: the machine decides.
    const { locale, timeZone } = Intl.DateTimeFormat().resolvedOptions();
    expect(
      mossPluginCatalogSourceOrder({ codex_moss: { enabled: false, config: { realm: "cn" } } }),
    ).toBe(mossDownloadSourceOrder({ lane: null, locale, timeZone }));
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
