import { describe, expect, it } from "vitest";

import {
  findMossPluginCatalogEntry,
  MOSS_PLUGIN_CATALOG,
  MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL,
  MOSS_PLUGIN_CATALOG_FEATURED_PLUGIN_IDS,
  MOSS_PLUGIN_CATALOG_SELECTION,
  MOSS_PLUGIN_CATALOG_SOURCE,
  mossPluginCatalogEntryForPluginId,
  mossPluginCatalogIconUrl,
  mossPluginCatalogPackageUrl,
  mossPluginCatalogPluginId,
  normalizeMossPluginCatalogBaseUrl,
} from "./mossPluginCatalog";
import {
  decodeMossPluginPackage,
  encodeMossPluginPackage,
  isSafeMossPluginPackagePath,
} from "./mossPluginPackage";

describe("MOSS_PLUGIN_CATALOG", () => {
  it("ships a pinned package for every selected plugin", () => {
    expect(MOSS_PLUGIN_CATALOG.map((entry) => entry.name)).toEqual(MOSS_PLUGIN_CATALOG_SELECTION);
    expect(MOSS_PLUGIN_CATALOG_SOURCE.commit).toMatch(/^[0-9a-f]{40}$/u);
    for (const entry of MOSS_PLUGIN_CATALOG) {
      expect(entry.package.sha256).toMatch(/^[0-9a-f]{64}$/u);
      expect(entry.package.file).toBe(`packages/${entry.name}-${entry.version}.json.gz`);
      expect(["MIT", "Apache-2.0"]).toContain(entry.license);
      // One line of Chinese, as the directory shows it.
      expect(entry.zhDescription).toMatch(/[\u4e00-\u9fff]/u);
      expect(entry.zhDescription).not.toContain("\n");
      expect(entry.skills.length).toBeGreaterThan(0);
    }
  });

  it("features only plugins it lists", () => {
    expect(MOSS_PLUGIN_CATALOG_FEATURED_PLUGIN_IDS.length).toBeGreaterThan(0);
    for (const id of MOSS_PLUGIN_CATALOG_FEATURED_PLUGIN_IDS) {
      expect(mossPluginCatalogEntryForPluginId(id)).toBeDefined();
    }
  });

  it("maps plugin ids to entries only within its own marketplace", () => {
    expect(mossPluginCatalogPluginId("superpowers")).toBe("superpowers@moss-catalog");
    expect(mossPluginCatalogEntryForPluginId("superpowers@moss-catalog")?.name).toBe("superpowers");
    expect(mossPluginCatalogEntryForPluginId("superpowers@openai-curated")).toBeUndefined();
    expect(mossPluginCatalogEntryForPluginId("unknown@moss-catalog")).toBeUndefined();
  });

  it("builds mirror URLs under the base folder", () => {
    const entry = findMossPluginCatalogEntry("superpowers")!;
    expect(mossPluginCatalogPackageUrl(MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL, entry)).toBe(
      `https://moss-update.comiction.cn/plugin-catalog/v1/packages/superpowers-${entry.version}.json.gz`,
    );
    expect(mossPluginCatalogIconUrl("http://127.0.0.1:9000/catalog", entry)).toBe(
      "http://127.0.0.1:9000/catalog/icons/superpowers.png",
    );
  });

  it("accepts only https mirrors, or loopback http for development", () => {
    expect(normalizeMossPluginCatalogBaseUrl(undefined)).toBe(MOSS_PLUGIN_CATALOG_DEFAULT_BASE_URL);
    expect(normalizeMossPluginCatalogBaseUrl("https://example.com/c?x=1")).toBe(
      "https://example.com/c/",
    );
    expect(() => normalizeMossPluginCatalogBaseUrl("http://example.com/c/")).toThrow(/HTTPS/u);
  });
});

describe("Moss plugin packages", () => {
  const files = [
    { path: "skills/a/SKILL.md", executable: false, bytes: new TextEncoder().encode("# A\n") },
    { path: "scripts/run.sh", executable: true, bytes: new TextEncoder().encode("echo hi\n") },
  ];

  it("round-trips and checks the pinned hash of the uncompressed JSON", () => {
    const encoded = encodeMossPluginPackage({ name: "demo", version: "1.0.0", files });
    const decoded = decodeMossPluginPackage({
      gzip: encoded.gzip,
      expectedName: "demo",
      expectedVersion: "1.0.0",
      expectedSha256: encoded.sha256,
    });
    expect(decoded.map((file) => [file.path, file.executable])).toEqual([
      ["scripts/run.sh", true],
      ["skills/a/SKILL.md", false],
    ]);
    expect(new TextDecoder().decode(decoded[1]!.bytes)).toBe("# A\n");
    // Same input, same hash: the order files arrive in does not matter.
    expect(
      encodeMossPluginPackage({ name: "demo", version: "1.0.0", files: files.toReversed() }).sha256,
    ).toBe(encoded.sha256);
  });

  it("rejects a package that is not the pinned one", () => {
    const encoded = encodeMossPluginPackage({ name: "demo", version: "1.0.0", files });
    expect(() =>
      decodeMossPluginPackage({
        gzip: encoded.gzip,
        expectedName: "demo",
        expectedVersion: "1.0.0",
        expectedSha256: "0".repeat(64),
      }),
    ).toThrow(/does not match/u);
    expect(() =>
      decodeMossPluginPackage({
        gzip: encoded.gzip,
        expectedName: "other",
        expectedVersion: "1.0.0",
        expectedSha256: encoded.sha256,
      }),
    ).toThrow(/expected format/u);
    expect(() =>
      decodeMossPluginPackage({
        gzip: new Uint8Array([1, 2, 3]),
        expectedName: "demo",
        expectedVersion: "1.0.0",
        expectedSha256: encoded.sha256,
      }),
    ).toThrow(/not a valid archive/u);
  });

  it("never writes outside the plugin folder", () => {
    for (const path of ["../x", "a/../b", "/etc/passwd", "C:/x", "a\\b", "con.txt", "a/./b", ""]) {
      expect(isSafeMossPluginPackagePath(path)).toBe(false);
    }
    expect(isSafeMossPluginPackagePath(".codex-plugin/plugin.json")).toBe(true);
    expect(() =>
      encodeMossPluginPackage({
        name: "demo",
        version: "1.0.0",
        files: [{ path: "../escape", executable: false, bytes: new Uint8Array() }],
      }),
    ).toThrow(/Unsafe/u);
  });
});
