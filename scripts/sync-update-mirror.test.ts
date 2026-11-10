import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { describe, expect, it } from "vitest";

import {
  parseSettingsFile,
  syncUpdateMirror,
  type UpdateMirrorStore,
} from "./sync-update-mirror.ts";

const FEED = "https://updates.example.cn/moss/";
const API = "https://api.example.test";
const REPOSITORY = "acme/releases";
const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();

function sha512(bytes: Buffer | string): string {
  return createHash("sha512").update(bytes).digest("base64");
}

function manifestFor(version: string, installer: Buffer): string {
  const name = `Moss-${version}-x64.exe`;
  return `version: ${version}\nfiles:\n  - url: ${name}\n    sha512: ${sha512(installer)}\n    size: ${installer.length}\npath: ${name}\n`;
}

interface FakeWorld {
  readonly official: Map<string, Buffer>;
  readonly mirror: Map<string, Buffer>;
  readonly uploads: string[];
  readonly store: UpdateMirrorStore;
  readonly fetchImpl: typeof fetch;
  tag: string;
  /** A CDN that keeps answering the plain URL from an old copy. */
  staleCdn: Map<string, string>;
  /** How many more full downloads of a file answer "not found", as a CDN just after an upload. */
  unservedGets: Map<string, number>;
  rangeSupported: boolean;
}

function world(tag: string, assets: Record<string, Buffer | string>): FakeWorld {
  const fake: FakeWorld = {
    official: new Map(Object.entries(assets).map(([k, v]) => [k, Buffer.from(v)])),
    mirror: new Map(),
    uploads: [],
    tag,
    staleCdn: new Map(),
    unservedGets: new Map(),
    rangeSupported: true,
    store: {
      upload: async (fileName, localPath) => {
        fake.uploads.push(fileName);
        fake.mirror.set(fileName, readFileSync(localPath));
      },
      sizeOf: async (fileName) => fake.mirror.get(fileName)?.length ?? null,
    },
    fetchImpl: (async (input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.href === `${API}/repos/${REPOSITORY}/releases/latest`) {
        return Response.json({
          tag_name: fake.tag,
          assets: [...fake.official].map(([name, bytes]) => ({
            name,
            size: bytes.length,
            browser_download_url: `https://downloads.example.test/${name}`,
          })),
        });
      }
      if (url.hostname === "downloads.example.test") {
        const bytes = fake.official.get(url.pathname.slice(1));
        return bytes ? new Response(new Uint8Array(bytes)) : new Response(null, { status: 404 });
      }
      const name = url.pathname.replace("/moss/", "");
      const stale = url.search === "" ? fake.staleCdn.get(name) : undefined;
      if (stale !== undefined) return new Response(stale);
      const bytes = fake.mirror.get(name);
      if (!bytes) return new Response(null, { status: 404 });
      const range = new Headers(init?.headers).get("range");
      if (!range && fake.unservedGets.get(name)) {
        fake.unservedGets.set(name, (fake.unservedGets.get(name) ?? 0) - 1);
        return new Response(null, { status: 404 });
      }
      if (range && fake.rangeSupported) {
        return new Response(new Uint8Array(bytes.subarray(0, 1)), {
          status: 206,
          headers: { "content-range": `bytes 0-0/${bytes.length}` },
        });
      }
      return new Response(new Uint8Array(bytes));
    }) as typeof fetch,
  };
  return fake;
}

const run = (fake: FakeWorld, assetsDirectory?: string) =>
  syncUpdateMirror({
    repository: REPOSITORY,
    feedUrl: FEED,
    privateKey,
    store: fake.store,
    githubApiUrl: API,
    fetchImpl: fake.fetchImpl,
    verifyRetryDelayMs: 0,
    ...(assetsDirectory ? { assetsDirectory } : {}),
  });

function downloadsFrom(fake: FakeWorld): {
  readonly names: string[];
  readonly fetchImpl: typeof fetch;
} {
  const names: string[] = [];
  return {
    names,
    fetchImpl: ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "downloads.example.test") names.push(url.pathname.slice(1));
      return fake.fetchImpl(input, init);
    }) as typeof fetch,
  };
}

const installer = Buffer.from("installer-2.0.0");
const release = () => ({
  "moss.yml": manifestFor("2.0.0", installer),
  "Moss-2.0.0-x64.exe": installer,
  "Moss-2.0.0-x64.exe.blockmap": "blockmap",
  "builder-debug.yml": "x: 1\n",
});

describe("parseSettingsFile", () => {
  it("reads settings saved from any editor, and skips comments and empty values", () => {
    expect(
      parseSettingsFile("# note\r\nMOSS_A=one\r\n\r\n  MOSS_B = two=three \r\nMOSS_EMPTY=\r\n"),
    ).toEqual([
      ["MOSS_A", "one"],
      ["MOSS_B", "two=three"],
    ]);
  });
});

describe("syncUpdateMirror", () => {
  it("publishes a new release to an empty mirror, files before manifests", async () => {
    const fake = world("v2.0.0", release());

    const result = await run(fake);

    expect(result).toMatchObject({
      status: "synced",
      tag: "v2.0.0",
      manifests: ["moss.yml"],
      copied: ["Moss-2.0.0-x64.exe", "Moss-2.0.0-x64.exe.blockmap"],
    });
    expect(fake.uploads.at(-1)).toBe("moss.yml");
    expect(fake.uploads.indexOf("Moss-2.0.0-x64.exe")).toBeLessThan(
      fake.uploads.indexOf("moss.yml.sig"),
    );
    expect(fake.mirror.has("builder-debug.yml")).toBe(false);
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest: String(fake.mirror.get("moss.yml")),
        signature: String(fake.mirror.get("moss.yml.sig")),
        manifestPublicKey,
      }),
    ).toBe(true);
  });

  it("handles a Windows-only release: no Mac or Linux manifest is not an error", async () => {
    const fake = world("v1.0.2", {
      "latest.yml": manifestFor("1.0.2", installer),
      "moss.yml": manifestFor("1.0.2", installer),
      "Moss-1.0.2-x64.exe": installer,
      "Moss-1.0.2-x64.exe.blockmap": "blockmap",
      SHA256SUMS: "sums",
    });

    await expect(run(fake)).resolves.toMatchObject({
      status: "synced",
      manifests: ["latest.yml", "moss.yml"],
      copied: ["Moss-1.0.2-x64.exe", "Moss-1.0.2-x64.exe.blockmap"],
    });
    expect(fake.uploads.filter((name) => name === "Moss-1.0.2-x64.exe")).toHaveLength(1);
    expect(fake.mirror.has("SHA256SUMS")).toBe(false);
  });

  it("uses the installer already on this machine instead of downloading it", async () => {
    const fake = world("v2.0.0", release());
    const directory = mkdtempSync(join(tmpdir(), "moss-mirror-assets-"));
    try {
      writeFileSync(join(directory, "Moss-2.0.0-x64.exe"), installer);
      writeFileSync(join(directory, "Moss-2.0.0-x64.exe.blockmap"), "blockmap");
      const downloads = downloadsFrom(fake);

      await syncUpdateMirror({
        repository: REPOSITORY,
        feedUrl: FEED,
        privateKey,
        store: fake.store,
        githubApiUrl: API,
        fetchImpl: downloads.fetchImpl,
        assetsDirectory: directory,
      });

      expect(downloads.names).toEqual(["moss.yml"]);
      expect(fake.mirror.get("Moss-2.0.0-x64.exe")).toEqual(installer);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("downloads the real file when the local copy does not match the release", async () => {
    const fake = world("v2.0.0", release());
    const directory = mkdtempSync(join(tmpdir(), "moss-mirror-assets-"));
    try {
      writeFileSync(join(directory, "Moss-2.0.0-x64.exe"), "installer-9.9.9");

      await run(fake, directory);

      expect(fake.mirror.get("Moss-2.0.0-x64.exe")).toEqual(installer);
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does nothing when the mirror already serves the release", async () => {
    const fake = world("v2.0.0", release());
    await run(fake);
    fake.uploads.length = 0;

    await expect(run(fake)).resolves.toEqual({ status: "in-sync", tag: "v2.0.0" });
    expect(fake.uploads).toEqual([]);
  });

  it("picks up each newer release by itself and keeps earlier installers", async () => {
    const fake = world("v2.0.0", release());
    await run(fake);

    const newer = Buffer.from("installer-2.1.0");
    fake.official.clear();
    fake.official.set("moss.yml", Buffer.from(manifestFor("2.1.0", newer)));
    fake.official.set("Moss-2.1.0-x64.exe", newer);
    fake.tag = "v2.1.0";

    await expect(run(fake)).resolves.toMatchObject({ status: "synced", tag: "v2.1.0" });
    expect(String(fake.mirror.get("moss.yml"))).toContain("version: 2.1.0");
    // Someone may be halfway through downloading the previous version.
    expect(fake.mirror.has("Moss-2.0.0-x64.exe")).toBe(true);
  });

  it("finishes an interrupted sync without copying large files again", async () => {
    const fake = world("v2.0.0", release());
    fake.mirror.set("Moss-2.0.0-x64.exe", installer);

    const result = await run(fake);

    expect(result).toMatchObject({ copied: ["Moss-2.0.0-x64.exe.blockmap"] });
    expect(fake.uploads).not.toContain("Moss-2.0.0-x64.exe");
  });

  it("replaces a manifest whose signature was damaged", async () => {
    const fake = world("v2.0.0", release());
    await run(fake);
    fake.mirror.set("moss.yml.sig", Buffer.from("garbage"));
    fake.uploads.length = 0;

    await expect(run(fake)).resolves.toMatchObject({ status: "synced", copied: [] });
    expect(fake.uploads).toContain("moss.yml.sig");
  });

  it("fails loudly on a release without manifests, as v0.7.2 was", async () => {
    const fake = world("v0.7.2", { "Moss-0.7.2-x64.exe": "old" });

    await expect(run(fake)).rejects.toThrow("has no update manifests");
    expect(fake.uploads).toEqual([]);
  });

  it("publishes nothing when a manifest names a file the release lacks", async () => {
    const fake = world("v2.0.0", { "moss.yml": manifestFor("2.0.0", installer) });

    await expect(run(fake)).rejects.toThrow("which the release does not have");
    expect(fake.uploads).toEqual([]);
  });

  it("keeps the old manifest live when an installer fails its hash", async () => {
    const tampered = Buffer.from("installer-9.9.9");
    expect(tampered.length).toBe(installer.length);
    const fake = world("v2.0.0", { ...release(), "Moss-2.0.0-x64.exe": tampered });

    await expect(run(fake)).rejects.toThrow("does not match the sha512");
    expect(fake.mirror.has("moss.yml")).toBe(false);
    expect(fake.mirror.has("moss.yml.sig")).toBe(false);
  });

  it("keeps the manifest off the mirror when the mirror serves different bytes", async () => {
    const fake = world("v2.0.0", release());
    fake.mirror.set("Moss-2.0.0-x64.exe", Buffer.from("installer-9.9.9"));

    await expect(run(fake)).rejects.toThrow("does not match its manifest");
    expect(fake.mirror.has("moss.yml")).toBe(false);
  });

  it("gives the CDN a moment to start serving a new file", async () => {
    const fake = world("v2.0.0", release());
    fake.unservedGets.set("Moss-2.0.0-x64.exe", 2);

    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });
  });

  it("gives up, with the manifest off the mirror, when a file is never served", async () => {
    const fake = world("v2.0.0", release());
    fake.unservedGets.set("Moss-2.0.0-x64.exe", 100);

    await expect(run(fake)).rejects.toThrow("is not served by the mirror: HTTP 404");
    expect(fake.mirror.has("moss.yml")).toBe(false);
  });

  it("fails when a CDN keeps serving an old manifest", async () => {
    const fake = world("v2.0.0", release());
    fake.staleCdn.set("moss.yml", manifestFor("1.0.0", installer));

    await expect(run(fake)).rejects.toThrow("served stale");
  });

  it("fails when the mirror cannot serve byte ranges", async () => {
    const fake = world("v2.0.0", release());
    fake.rangeSupported = false;

    await expect(run(fake)).rejects.toThrow("byte ranges");
  });

  it("treats a signature from another key as behind and re-signs", async () => {
    const fake = world("v2.0.0", release());
    await run(fake);
    const other = generateMossUpdateManifestKeyPair();
    fake.mirror.set(
      "moss.yml.sig",
      Buffer.from(
        signMossUpdateManifest({
          channelFile: "moss.yml",
          manifest: String(fake.mirror.get("moss.yml")),
          privateKey: other.privateKey,
        }),
      ),
    );

    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });
  });
});
