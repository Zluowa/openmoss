import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join, sep } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSettingsFile,
  parseSyncUpdateMirrorArgs,
  readUpdateMirrorS3ClientOptions,
  readUpdateMirrorStoreSettings,
  resolveUpdateMirrorStores,
  runUpdateMirrorSync,
  splitUpdateMirrorSettingsDirs,
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
  /** Runtime archives this source serves (`runtimes/v1/...` path to size), and the requests for them. */
  readonly runtimeObjects: Map<string, number>;
  readonly runtimeRequests: Array<{ readonly url: string; readonly init: RequestInit | undefined }>;
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
    runtimeObjects: new Map(),
    runtimeRequests: [],
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
      if (url.pathname.startsWith("/runtimes/")) {
        fake.runtimeRequests.push({ url: url.href, init });
        const size = fake.runtimeObjects.get(url.pathname.slice(1));
        return size === undefined
          ? new Response(null, { status: 404 })
          : new Response(new Uint8Array(1), {
              status: 206,
              headers: { "content-range": `bytes 0-0/${size}` },
            });
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

// A pinned runtime as runtime-pins.json lists it; the archive itself is faked by its size.
const RUNTIME_SHA256 = "ab".repeat(32);
const pinnedRuntime = {
  name: "codex",
  version: "1.2.3",
  platform: "win32",
  arch: "x64",
  archive: { size: 4096, sha256: RUNTIME_SHA256 },
  executable: "codex.exe",
  files: [],
};
const RUNTIME_PATH = `runtimes/v1/codex/1.2.3/codex-1.2.3-win32-x64-${RUNTIME_SHA256.slice(0, 16)}.tar.zst`;
const pinsFile = (runtimes: unknown[] = [pinnedRuntime], schemaVersion: unknown = 1) =>
  `${JSON.stringify({ schemaVersion, appVersion: "2.0.0", runtimes })}\n`;

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

describe("readUpdateMirrorS3ClientOptions", () => {
  // Placeholders only; real settings live on the publishing machine.
  const r2 = {
    MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID: "test-access-key-id",
    MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: "test-secret",
    MOSS_UPDATE_MIRROR_S3_BUCKET: "moss-update",
    MOSS_UPDATE_MIRROR_S3_ENDPOINT: "https://0123456789abcdef.r2.cloudflarestorage.com",
    MOSS_UPDATE_MIRROR_S3_REGION: "auto",
  };

  it("addresses a Cloudflare R2 bucket path-style by default", () => {
    expect(readUpdateMirrorS3ClientOptions(r2)).toEqual({
      accessKeyId: "test-access-key-id",
      secretAccessKey: "test-secret",
      bucket: "moss-update",
      endpoint: "https://0123456789abcdef.r2.cloudflarestorage.com",
      region: "auto",
      virtualHostedStyle: false,
    });
    expect(
      readUpdateMirrorS3ClientOptions({ ...r2, MOSS_UPDATE_MIRROR_S3_PATH_STYLE: "1" })
        .virtualHostedStyle,
    ).toBe(false);
  });

  it("switches to virtual-hosted addressing only when asked", () => {
    expect(
      readUpdateMirrorS3ClientOptions({ ...r2, MOSS_UPDATE_MIRROR_S3_PATH_STYLE: "0" })
        .virtualHostedStyle,
    ).toBe(true);
    expect(() =>
      readUpdateMirrorS3ClientOptions({ ...r2, MOSS_UPDATE_MIRROR_S3_PATH_STYLE: "yes" }),
    ).toThrow(/PATH_STYLE/);
  });

  it("names a missing setting instead of guessing it", () => {
    const { MOSS_UPDATE_MIRROR_S3_REGION: _region, ...withoutRegion } = r2;
    expect(() => readUpdateMirrorS3ClientOptions(withoutRegion)).toThrow(
      "MOSS_UPDATE_MIRROR_S3_REGION is not set.",
    );
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

  it("signs and publishes runtime-pins.json with the feed, before the channel manifest", async () => {
    const pins = pinsFile();
    const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pins });
    fake.runtimeObjects.set(RUNTIME_PATH, pinnedRuntime.archive.size);

    await expect(run(fake)).resolves.toMatchObject({
      status: "synced",
      manifests: ["runtime-pins.json", "moss.yml"],
    });
    expect(String(fake.mirror.get("runtime-pins.json"))).toBe(pins);
    expect(
      verifyMossUpdateManifest({
        channelFile: "runtime-pins.json",
        manifest: pins,
        signature: String(fake.mirror.get("runtime-pins.json.sig")),
        manifestPublicKey,
      }),
    ).toBe(true);
    expect(fake.uploads.indexOf("runtime-pins.json")).toBeLessThan(
      fake.uploads.indexOf("moss.yml"),
    );
    await expect(run(fake)).resolves.toMatchObject({ status: "in-sync" });

    // A damaged pins signature makes the mirror behind, like a channel manifest's.
    fake.mirror.set("runtime-pins.json.sig", Buffer.from("AAAA\n"));
    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });
  });

  it("does not need runtime-pins.json from an older release", async () => {
    const fake = world("v2.0.0", release());
    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });
    expect(fake.mirror.has("runtime-pins.json")).toBe(false);
    expect(fake.mirror.has("runtime-pins.json.sig")).toBe(false);
    expect(fake.runtimeRequests).toEqual([]);
  });

  it("asks the store's origin for every pinned runtime with a one-byte anonymous GET", async () => {
    const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pinsFile() });
    fake.runtimeObjects.set(RUNTIME_PATH, pinnedRuntime.archive.size);

    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });

    expect(fake.runtimeRequests.map((request) => request.url)).toEqual([
      `https://updates.example.cn/${RUNTIME_PATH}`,
    ]);
    const init = fake.runtimeRequests[0]?.init;
    expect(init?.method).toBe("GET");
    expect(new Headers(init?.headers).get("range")).toBe("bytes=0-0");
    expect(new Headers(init?.headers).has("authorization")).toBe(false);
  });

  it("writes nothing to a store that does not serve a pinned runtime", async () => {
    const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pinsFile() });

    const failure = await run(fake).then(
      () => new Error("expected a failure"),
      (error: unknown) => error as Error,
    );

    expect(failure).toBeInstanceOf(Error);
    expect(failure.message).toContain(`https://updates.example.cn/${RUNTIME_PATH}`);
    expect(failure.message).toContain("not served (HTTP 404)");
    expect(failure.message).toContain("scripts/upload-moss-runtimes.ts --out");
    expect(failure.message).toContain("few minutes");
    expect(fake.uploads).toEqual([]);
    // A 404 is final: asking again only feeds the edge's cache of "not found".
    expect(fake.runtimeRequests).toHaveLength(1);
  });

  it("refuses runtime pins it cannot read safely, before writing anything", async () => {
    for (const pins of [
      pinsFile([pinnedRuntime], 2),
      pinsFile([{ ...pinnedRuntime, archive: { size: 4096, sha256: "ABC" } }]),
      pinsFile([{ ...pinnedRuntime, version: "1.2.3/../../../desktop" }]),
    ]) {
      const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pins });
      await expect(run(fake)).rejects.toThrow(/runtime-pins\.json|segments/);
      expect(fake.uploads).toEqual([]);
      expect(fake.runtimeRequests).toEqual([]);
    }
  });

  it("checks nothing for runtime pins that pin no runtime", async () => {
    const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pinsFile([]) });
    await expect(run(fake)).resolves.toMatchObject({ status: "synced" });
    expect(fake.runtimeRequests).toEqual([]);
  });

  it("refuses a release that has runtime pins but no channel manifest", async () => {
    const fake = world("v2.0.0", { "runtime-pins.json": "{}\n", "Moss-2.0.0-x64.exe": installer });
    await expect(run(fake)).rejects.toThrow(/has no update manifests/);
    expect(fake.uploads).toEqual([]);
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

// Placeholders only: the store is faked, so no credential is ever read.
const storage = (bucket: string, extra: Record<string, string> = {}) => ({
  MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID: `${bucket}-id`,
  MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY: `${bucket}-placeholder`,
  MOSS_UPDATE_MIRROR_S3_BUCKET: bucket,
  MOSS_UPDATE_MIRROR_S3_ENDPOINT: `https://${bucket}.storage.example.test`,
  MOSS_UPDATE_MIRROR_S3_REGION: "auto",
  ...extra,
});

describe("several stores", () => {
  const COS_FEED = "https://cos.example.test/moss/";
  const R2_FEED = "https://r2.example.test/moss/";
  const folders: string[] = [];

  afterEach(() => {
    for (const folder of folders.splice(0)) rmSync(folder, { recursive: true, force: true });
  });

  function settingsFolder(files: Record<string, Record<string, string>>, at?: string): string {
    const folder = at ?? mkdtempSync(join(tmpdir(), "moss-mirror-settings-"));
    if (at) mkdirSync(at, { recursive: true });
    else folders.push(folder);
    for (const [fileName, values] of Object.entries(files)) {
      writeFileSync(
        join(folder, fileName),
        Object.entries(values)
          .map(([name, value]) => `${name}=${value}\n`)
          .join(""),
      );
    }
    return folder;
  }

  function tempHome(): string {
    const home = mkdtempSync(join(tmpdir(), "moss-mirror-home-"));
    folders.push(home);
    return home;
  }

  function twoStores(
    options: { readonly assets?: Record<string, Buffer | string>; readonly parent?: string } = {},
  ) {
    const cos = world("v2.0.0", options.assets ?? release());
    const r2 = world("v2.0.0", options.assets ?? release());
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return (url.hostname === "r2.example.test" ? r2 : cos).fetchImpl(input, init);
    }) as typeof fetch;
    const cosFolder = settingsFolder(
      {
        "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED },
        "update-mirror-upload.env": storage("cos-bucket", {
          MOSS_UPDATE_MIRROR_S3_PATH_STYLE: "0",
        }),
        "update-mirror-signing.env": { MOSS_UPDATE_MIRROR_SIGNING_KEY: privateKey },
      },
      options.parent && join(options.parent, "cos"),
    );
    const r2Folder = settingsFolder(
      {
        "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: R2_FEED },
        "update-mirror-upload.env": storage("r2-bucket"),
      },
      options.parent && join(options.parent, "r2"),
    );
    const storeEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
    const createStore = (env: Readonly<Record<string, string | undefined>>) => {
      storeEnvs.push(env);
      return env.MOSS_UPDATE_MIRROR_S3_BUCKET === "cos-bucket" ? cos.store : r2.store;
    };
    const logs: string[] = [];
    const runBoth = (
      extraEnv: Record<string, string> = {},
      how: { readonly listInEnv?: boolean; readonly homeDirectory?: string } = {},
    ) =>
      runUpdateMirrorSync({
        args: [],
        env: {
          ...(how.listInEnv === false
            ? {}
            : { MOSS_UPDATE_MIRROR_SETTINGS_DIRS: [cosFolder, r2Folder].join(delimiter) }),
          MOSS_UPDATE_MIRROR_GITHUB_API_URL: API,
          MOSS_DESKTOP_UPDATE_REPOSITORY: REPOSITORY,
          ...extraEnv,
        },
        homeDirectory: how.homeDirectory ?? tmpdir(),
        createStore,
        builtInPublicKey: manifestPublicKey,
        fetchImpl,
        verifyRetryDelayMs: 0,
        log: (message) => logs.push(message),
      });
    return { cos, r2, cosFolder, r2Folder, storeEnvs, logs, runBoth };
  }

  it("splits the folder list on the platform's path-list separator", () => {
    expect(splitUpdateMirrorSettingsDirs(" a ;; b ", ";")).toEqual(["a", "b"]);
    expect(splitUpdateMirrorSettingsDirs("/x/a:/x/b", ":")).toEqual(["/x/a", "/x/b"]);
  });

  it("syncs and signs every store, each read back through its own public URL", async () => {
    const fake = twoStores();

    const outcomes = await fake.runBoth();

    expect(outcomes.map((outcome) => [outcome.feedUrl, outcome.result?.status])).toEqual([
      [COS_FEED, "synced"],
      [R2_FEED, "synced"],
    ]);
    for (const store of [fake.cos, fake.r2]) {
      expect(store.uploads.at(-1)).toBe("moss.yml");
      expect(
        verifyMossUpdateManifest({
          channelFile: "moss.yml",
          manifest: String(store.mirror.get("moss.yml")),
          signature: String(store.mirror.get("moss.yml.sig")),
          manifestPublicKey,
        }),
      ).toBe(true);
    }
    await expect(fake.runBoth()).resolves.toMatchObject([
      { result: { status: "in-sync" } },
      { result: { status: "in-sync" } },
    ]);
  });

  it("gives each store only its own folder's storage settings", async () => {
    const fake = twoStores();
    await fake.runBoth();

    const [cosEnv, r2Env] = fake.storeEnvs;
    expect(cosEnv?.MOSS_UPDATE_MIRROR_S3_BUCKET).toBe("cos-bucket");
    expect(cosEnv?.MOSS_UPDATE_MIRROR_S3_PATH_STYLE).toBe("0");
    expect(r2Env?.MOSS_UPDATE_MIRROR_S3_BUCKET).toBe("r2-bucket");
    // COS needs virtual-hosted addressing; R2 keeps the path-style default.
    expect(r2Env?.MOSS_UPDATE_MIRROR_S3_PATH_STYLE).toBeUndefined();
    expect(readUpdateMirrorS3ClientOptions(cosEnv!).virtualHostedStyle).toBe(true);
    expect(readUpdateMirrorS3ClientOptions(r2Env!).virtualHostedStyle).toBe(false);
    expect(r2Env?.MOSS_UPDATE_MIRROR_FEED_URL).toBe(R2_FEED);
  });

  it("refuses a store setting in the environment, which would apply to every store", async () => {
    const fake = twoStores();
    await expect(fake.runBoth({ MOSS_UPDATE_MIRROR_S3_BUCKET: "leaked" })).rejects.toThrow(
      /MOSS_UPDATE_MIRROR_S3_BUCKET is set in the environment/,
    );
    await expect(fake.runBoth({ MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED })).rejects.toThrow(
      /MOSS_UPDATE_MIRROR_FEED_URL/,
    );
    expect(fake.cos.uploads).toEqual([]);
    expect(fake.r2.uploads).toEqual([]);
  });

  it("finishes the other store and then fails when one store fails", async () => {
    const fake = twoStores();
    fake.cos.store.upload = async () => {
      throw new Error("COS upload refused");
    };

    const failure = await fake.runBoth().catch((error: unknown) => error);

    expect(failure).toBeInstanceOf(Error);
    expect((failure as Error).message).toMatch(/1 of 2 update mirror store\(s\) failed/);
    expect((failure as Error).message).toContain("COS upload refused");
    const outcomes = (failure as { outcomes: Array<{ feedUrl: string; result: unknown }> })
      .outcomes;
    expect(outcomes.map((outcome) => outcome.feedUrl)).toEqual([COS_FEED, R2_FEED]);
    expect(outcomes[1]?.result).toMatchObject({ status: "synced" });
    expect(fake.r2.mirror.has("moss.yml")).toBe(true);
    // The failed store never got a manifest pointing at files it does not have.
    expect(fake.cos.mirror.has("moss.yml")).toBe(false);
  });

  it("fails a store that is still stale after syncing, without hiding the other", async () => {
    const fake = twoStores();
    fake.r2.rangeSupported = false;

    const failure = await fake.runBoth().catch((error: unknown) => error);

    expect((failure as Error).message).toContain(fake.r2Folder);
    expect((failure as Error).message).toContain("byte ranges");
    expect(fake.cos.mirror.has("moss.yml")).toBe(true);
  });

  it("needs a feed URL in every folder and one signing key for all of them", async () => {
    const noFeed = settingsFolder({ "update-mirror-upload.env": storage("x") });
    const keyed = settingsFolder({
      "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED },
      "update-mirror-signing.env": { MOSS_UPDATE_MIRROR_SIGNING_KEY: privateKey },
    });
    const outcome = await runUpdateMirrorSync({
      args: [],
      env: { MOSS_UPDATE_MIRROR_SETTINGS_DIRS: [keyed, noFeed].join(delimiter) },
      homeDirectory: tmpdir(),
      createStore: () => world("v2.0.0", release()).store,
      builtInPublicKey: manifestPublicKey,
      fetchImpl: world("v2.0.0", release()).fetchImpl,
      verifyRetryDelayMs: 0,
    }).catch((error: unknown) => error as Error);
    expect(String(outcome)).toContain(`MOSS_UPDATE_MIRROR_FEED_URL is not set in ${noFeed}`);

    const otherKey = settingsFolder({
      "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: R2_FEED },
      "update-mirror-signing.env": {
        MOSS_UPDATE_MIRROR_SIGNING_KEY: generateMossUpdateManifestKeyPair().privateKey,
      },
    });
    await expect(
      runUpdateMirrorSync({
        args: [],
        env: { MOSS_UPDATE_MIRROR_SETTINGS_DIRS: [keyed, otherKey].join(delimiter) },
        homeDirectory: tmpdir(),
        createStore: () => world("v2.0.0", release()).store,
        builtInPublicKey: manifestPublicKey,
      }),
    ).rejects.toThrow(/different MOSS_UPDATE_MIRROR_SIGNING_KEY/);
  });

  it("keeps one settings folder working as before: values already in the environment win", async () => {
    const folder = settingsFolder({
      "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED },
      "update-mirror-upload.env": storage("folder-bucket"),
    });
    const stores = await readUpdateMirrorStoreSettings({
      env: { MOSS_UPDATE_MIRROR_SETTINGS_DIR: folder, MOSS_UPDATE_MIRROR_S3_BUCKET: "env-bucket" },
      homeDirectory: tmpdir(),
      files: ["update-mirror.env", "update-mirror-upload.env"],
    });
    expect(stores).toHaveLength(1);
    expect(stores[0]?.env.MOSS_UPDATE_MIRROR_S3_BUCKET).toBe("env-bucket");
    expect(stores[0]?.env.MOSS_UPDATE_MIRROR_FEED_URL).toBe(COS_FEED);
  });

  it("checks the pinned runtimes on each store, failing only the store that lacks one", async () => {
    const fake = twoStores({ assets: { ...release(), "runtime-pins.json": pinsFile() } });
    fake.cos.runtimeObjects.set(RUNTIME_PATH, pinnedRuntime.archive.size);

    const failure = await fake.runBoth().then(
      () => new Error("expected a failure"),
      (error: unknown) => error as Error,
    );

    expect(failure.message).toMatch(/1 of 2 update mirror store\(s\) failed/);
    expect(failure.message).toContain(fake.r2Folder);
    expect(failure.message).toContain(`https://r2.example.test/${RUNTIME_PATH}`);
    expect(fake.r2.uploads).toEqual([]);
    expect(fake.r2.mirror.size).toBe(0);
    expect(fake.cos.mirror.has("moss.yml")).toBe(true);
    expect(fake.cos.mirror.has("runtime-pins.json")).toBe(true);
  });

  describe("a store list in the settings folder", () => {
    // The listing folder's own store settings, which must reach no store.
    const listingOwn = {
      MOSS_UPDATE_MIRROR_FEED_URL: "https://listing.example.test/moss/",
      ...storage("listing-bucket"),
    };

    function listingFolder(at: string, list: string, extra: Record<string, string> = {}): string {
      return settingsFolder(
        {
          "update-mirror.env": { MOSS_UPDATE_MIRROR_SETTINGS_DIRS: list, ...extra },
          "update-mirror-upload.env": listingOwn,
        },
        at,
      );
    }

    it("writes both stores from the plain default command, entries relative to the folder", async () => {
      const home = tempHome();
      const listing = join(home, ".moss-release");
      const fake = twoStores({ parent: listing });
      listingFolder(listing, ["cos", "r2"].join(delimiter));

      const outcomes = await fake.runBoth({}, { listInEnv: false, homeDirectory: home });

      expect(
        outcomes.map((outcome) => [outcome.label, outcome.feedUrl, outcome.result?.status]),
      ).toEqual([
        [join(listing, "cos"), COS_FEED, "synced"],
        [join(listing, "r2"), R2_FEED, "synced"],
      ]);
      expect(fake.logs).toContain(
        `Store folders listed in ${listing}: ${join(listing, "cos")}, ${join(listing, "r2")}`,
      );
      expect(fake.storeEnvs.map((env) => env.MOSS_UPDATE_MIRROR_S3_BUCKET)).toEqual([
        "cos-bucket",
        "r2-bucket",
      ]);
      for (const env of fake.storeEnvs) {
        expect(env.MOSS_UPDATE_MIRROR_FEED_URL).not.toBe(listingOwn.MOSS_UPDATE_MIRROR_FEED_URL);
        expect(env.MOSS_UPDATE_MIRROR_S3_ENDPOINT).not.toBe(
          listingOwn.MOSS_UPDATE_MIRROR_S3_ENDPOINT,
        );
        expect(env.MOSS_UPDATE_MIRROR_SETTINGS_DIRS).toBeUndefined();
      }
      expect(fake.r2Folder).toBe(join(listing, "r2"));
    });

    it("honours a list in MOSS_UPDATE_MIRROR_SETTINGS_DIR, with absolute entries", async () => {
      const fake = twoStores();
      const listing = listingFolder(
        join(tempHome(), "release-settings"),
        [fake.cosFolder, fake.r2Folder].join(delimiter),
      );

      const outcomes = await fake.runBoth(
        { MOSS_UPDATE_MIRROR_SETTINGS_DIR: listing },
        { listInEnv: false },
      );

      expect(outcomes.map((outcome) => [outcome.label, outcome.feedUrl])).toEqual([
        [fake.cosFolder, COS_FEED],
        [fake.r2Folder, R2_FEED],
      ]);
      expect(fake.logs[0]).toBe(
        `Store folders listed in ${listing}: ${fake.cosFolder}, ${fake.r2Folder}`,
      );
    });

    it("lets the environment variable win over a list in the folder", async () => {
      const home = tempHome();
      listingFolder(join(home, ".moss-release"), ["elsewhere-a", "elsewhere-b"].join(delimiter));
      const fake = twoStores();

      const outcomes = await fake.runBoth({}, { homeDirectory: home });

      expect(outcomes.map((outcome) => outcome.label)).toEqual([fake.cosFolder, fake.r2Folder]);
      expect(fake.logs.some((line) => line.startsWith("Store folders listed in"))).toBe(false);
    });

    it("shares the listing folder's other settings, such as the signing key", async () => {
      const home = tempHome();
      const listing = join(home, ".moss-release");
      settingsFolder(
        { "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED } },
        join(listing, "cos"),
      );
      listingFolder(listing, "cos", { MOSS_DESKTOP_UPDATE_REPOSITORY: REPOSITORY });
      settingsFolder(
        { "update-mirror-signing.env": { MOSS_UPDATE_MIRROR_SIGNING_KEY: privateKey } },
        listing,
      );

      const resolution = await resolveUpdateMirrorStores({
        env: {},
        homeDirectory: home,
        files: ["update-mirror.env", "update-mirror-signing.env", "update-mirror-upload.env"],
      });

      expect(resolution.severalStores).toBe(true);
      expect(resolution.listedIn).toBe(listing);
      expect(resolution.stores).toHaveLength(1);
      const env = resolution.stores[0]!.env;
      expect(env.MOSS_UPDATE_MIRROR_FEED_URL).toBe(COS_FEED);
      expect(env.MOSS_UPDATE_MIRROR_SIGNING_KEY).toBe(privateKey);
      expect(env.MOSS_DESKTOP_UPDATE_REPOSITORY).toBe(REPOSITORY);
      expect(env.MOSS_UPDATE_MIRROR_S3_BUCKET).toBeUndefined();
      expect(env.MOSS_UPDATE_MIRROR_SETTINGS_DIRS).toBeUndefined();
    });

    it("refuses a store setting in the environment", async () => {
      const home = tempHome();
      const listing = join(home, ".moss-release");
      const fake = twoStores({ parent: listing });
      listingFolder(listing, ["cos", "r2"].join(delimiter));

      await expect(
        fake.runBoth(
          { MOSS_UPDATE_MIRROR_S3_BUCKET: "leaked" },
          { listInEnv: false, homeDirectory: home },
        ),
      ).rejects.toThrow(
        `MOSS_UPDATE_MIRROR_S3_BUCKET is set in the environment; with MOSS_UPDATE_MIRROR_SETTINGS_DIRS in ${listing}`,
      );
      expect(fake.cos.uploads).toEqual([]);
      expect(fake.r2.uploads).toEqual([]);
    });

    it("refuses a listed folder that lists folders itself, and a folder named twice", async () => {
      const home = tempHome();
      const listing = join(home, ".moss-release");
      const fake = twoStores({ parent: listing });
      const read = () =>
        resolveUpdateMirrorStores({
          env: {},
          homeDirectory: home,
          files: ["update-mirror.env", "update-mirror-upload.env"],
        });

      listingFolder(listing, ["cos", `.${sep}cos`].join(delimiter));
      await expect(read()).rejects.toThrow(/names a folder twice/);

      listingFolder(listing, ["cos", "r2"].join(delimiter));
      settingsFolder(
        {
          "update-mirror.env": {
            MOSS_UPDATE_MIRROR_FEED_URL: R2_FEED,
            MOSS_UPDATE_MIRROR_SETTINGS_DIRS: "deeper",
          },
        },
        fake.r2Folder,
      );
      await expect(read()).rejects.toThrow(
        `${fake.r2Folder} is a store folder listed in MOSS_UPDATE_MIRROR_SETTINGS_DIRS in ${listing}`,
      );
    });

    it("needs a feed URL in every listed folder", async () => {
      const home = tempHome();
      const listing = join(home, ".moss-release");
      const fake = twoStores({ parent: listing });
      listingFolder(listing, ["cos", "r2", "empty"].join(delimiter));
      mkdirSync(join(listing, "empty"));

      const failure = await fake.runBoth({}, { listInEnv: false, homeDirectory: home }).then(
        () => new Error("expected a failure"),
        (error: unknown) => error as Error,
      );

      expect(failure.message).toContain(
        `MOSS_UPDATE_MIRROR_FEED_URL is not set in ${join(listing, "empty")}`,
      );
      expect(fake.cos.mirror.has("moss.yml")).toBe(true);
    });

    it("treats an empty list value as no list: one store, as before", async () => {
      const home = tempHome();
      const listing = settingsFolder(
        {
          "update-mirror.env": {
            MOSS_UPDATE_MIRROR_SETTINGS_DIRS: "   ",
            MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED,
          },
        },
        join(home, ".moss-release"),
      );

      const resolution = await resolveUpdateMirrorStores({
        env: { MOSS_UPDATE_MIRROR_S3_BUCKET: "env-bucket" },
        homeDirectory: home,
        files: ["update-mirror.env"],
      });

      expect(resolution).toMatchObject({ severalStores: false, listedIn: null });
      expect(resolution.stores.map((store) => store.label)).toEqual([listing]);
      expect(resolution.stores[0]?.env.MOSS_UPDATE_MIRROR_FEED_URL).toBe(COS_FEED);
      expect(resolution.stores[0]?.env.MOSS_UPDATE_MIRROR_S3_BUCKET).toBe("env-bucket");
    });

    it("keeps a folder without a list as one store", async () => {
      const home = tempHome();
      settingsFolder(
        { "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED } },
        join(home, ".moss-release"),
      );
      const resolution = await resolveUpdateMirrorStores({
        env: {},
        homeDirectory: home,
        files: ["update-mirror.env"],
      });
      expect(resolution).toMatchObject({ severalStores: false, listedIn: null });
      expect(resolution.stores).toHaveLength(1);
    });
  });
});

describe("parseSyncUpdateMirrorArgs", () => {
  it("enables pruning by default with 2 Windows and 1 macOS versions", () => {
    expect(parseSyncUpdateMirrorArgs([])).toEqual({
      assetsDirectory: undefined,
      prune: {
        enabled: true,
        dryRun: false,
        keepWinVersions: 2,
        keepMacVersions: 1,
      },
    });
  });

  it("parses pruning and assets-dir flags", () => {
    expect(
      parseSyncUpdateMirrorArgs([
        "--assets-dir",
        "/tmp/release",
        "--prune-dry-run",
        "--keep-win-versions",
        "3",
        "--keep-mac-versions=2",
      ]),
    ).toEqual({
      assetsDirectory: "/tmp/release",
      prune: {
        enabled: true,
        dryRun: true,
        keepWinVersions: 3,
        keepMacVersions: 2,
      },
    });
    expect(parseSyncUpdateMirrorArgs(["--no-prune"]).prune.enabled).toBe(false);
  });

  it("rejects conflicting, invalid, or unknown CLI flags", () => {
    expect(() => parseSyncUpdateMirrorArgs(["--no-prune", "--prune-dry-run"])).toThrow(
      /Cannot combine --no-prune and --prune-dry-run/,
    );
    expect(() => parseSyncUpdateMirrorArgs(["--keep-win-versions", "0"])).toThrow(
      /positive integer/,
    );
    expect(() => parseSyncUpdateMirrorArgs(["--keep-mac-versions", "abc"])).toThrow(
      /positive integer/,
    );
    expect(() => parseSyncUpdateMirrorArgs(["--keep-win-versions"])).toThrow(/Missing value/);
    expect(() => parseSyncUpdateMirrorArgs(["--assets-dir"])).toThrow(/Missing value/);
    expect(() => parseSyncUpdateMirrorArgs(["--unknown-flag"])).toThrow(/Unknown option/);
  });
});

describe("automatic pruning during syncUpdateMirror", () => {
  const PREFIX = "desktop/";

  function prunableWorld(tag: string, assets: Record<string, Buffer | string>) {
    const base = world(tag, assets);
    const events: string[] = [];
    const deleted: string[] = [];
    const extraObjects = new Map<string, Buffer>();
    let listError: unknown = null;
    let deleteError: unknown = null;
    let listCalls = 0;

    const store: UpdateMirrorStore = {
      prefix: PREFIX,
      upload: async (fileName, localPath) => {
        events.push(`upload:${fileName}`);
        await base.store.upload(fileName, localPath);
      },
      sizeOf: (fileName) => base.store.sizeOf(fileName),
      list: async () => {
        listCalls += 1;
        events.push("list");
        if (listError !== null) throw listError;
        return [
          ...[...base.mirror.entries()].map(([name, bytes]) => ({
            key: `${PREFIX}${name}`,
            size: bytes.length,
          })),
          ...[...extraObjects.entries()].map(([key, bytes]) => ({
            key,
            size: bytes.length,
          })),
        ];
      },
      readText: async (fileName) => {
        const bytes = base.mirror.get(fileName);
        return bytes ? bytes.toString("utf8") : null;
      },
      delete: async (fileName) => {
        events.push(`delete:${fileName}`);
        if (deleteError !== null) throw deleteError;
        deleted.push(fileName);
        base.mirror.delete(fileName);
      },
    };

    const fetchImpl: typeof fetch = (async (input, init) => {
      const url = new URL(input instanceof Request ? input.url : input);
      if (url.hostname === "updates.example.cn") {
        const name = url.pathname.replace("/moss/", "");
        events.push(`readback:${name}`);
      }
      return base.fetchImpl(input, init);
    }) as typeof fetch;

    return {
      base,
      store,
      fetchImpl,
      events,
      deleted,
      extraObjects,
      get listCalls() {
        return listCalls;
      },
      setListError(error: unknown) {
        listError = error;
      },
      setDeleteError(error: unknown) {
        deleteError = error;
      },
    };
  }

  it("prunes strictly AFTER upload, manifest publish, and public read-back succeed", async () => {
    const installer1010 = Buffer.from("installer-1.0.10");
    const env = prunableWorld("v1.0.10", {
      "latest.yml": manifestFor("1.0.10", installer1010),
      "moss.yml": manifestFor("1.0.10", installer1010),
      "Moss-1.0.10-x64.exe": installer1010,
      "Moss-1.0.10-x64.exe.blockmap": Buffer.from("blockmap-1.0.10"),
    });
    // Pre-populate older installers plus immune nested prefixes.
    env.base.mirror.set("Moss-1.0.2-x64.exe", Buffer.alloc(1000, 1));
    env.base.mirror.set("Moss-1.0.2-x64.exe.blockmap", Buffer.alloc(100, 2));
    env.base.mirror.set("Moss-1.0.9-x64.exe", Buffer.alloc(1200, 3));
    env.base.mirror.set("Moss-1.0.9-x64.exe.blockmap", Buffer.alloc(120, 4));
    env.base.mirror.set("Moss-1.0.8-arm64.dmg", Buffer.alloc(2000, 5));
    env.base.mirror.set("Moss-1.0.9-arm64.dmg", Buffer.alloc(2100, 6));
    env.extraObjects.set(
      "desktop/code/v1/moss-code-abc123456789-0123456789abcdef.asar.zst",
      Buffer.alloc(500),
    );
    env.extraObjects.set(
      "runtimes/v1/codex/1.0.0/codex-1.0.0-win32-x64-0123456789abcdef.tar.zst",
      Buffer.alloc(500),
    );
    env.extraObjects.set("plugin-catalog/v1/index.json", Buffer.from("{}"));
    env.extraObjects.set("preview/Moss-1.0.0-x64.exe", Buffer.alloc(500));

    const logs: string[] = [];
    const result = await syncUpdateMirror({
      repository: REPOSITORY,
      feedUrl: FEED,
      privateKey,
      store: env.store,
      githubApiUrl: API,
      fetchImpl: env.fetchImpl,
      verifyRetryDelayMs: 0,
      log: (message) => logs.push(message),
    });

    expect(result).toMatchObject({
      status: "synced",
      tag: "v1.0.10",
      prune: {
        status: "pruned",
        dryRun: false,
        deleted: ["Moss-1.0.8-arm64.dmg", "Moss-1.0.2-x64.exe", "Moss-1.0.2-x64.exe.blockmap"],
        bytesFreed: 3100,
      },
    });

    // Strict ordering: list and every delete occur strictly AFTER final manifest upload & read-back.
    const lastUploadIndex = env.events.findLastIndex((event) => event.startsWith("upload:"));
    const lastReadbackIndex = env.events.findLastIndex((event) => event.startsWith("readback:"));
    const listIndex = env.events.indexOf("list");
    const firstDeleteIndex = env.events.findIndex((event) => event.startsWith("delete:"));
    expect(lastUploadIndex).toBeGreaterThanOrEqual(0);
    expect(lastReadbackIndex).toBeGreaterThan(lastUploadIndex);
    expect(listIndex).toBeGreaterThan(lastReadbackIndex);
    expect(firstDeleteIndex).toBeGreaterThan(listIndex);

    // Kept: latest 2 Win (1.0.10, 1.0.9), latest 1 Mac (1.0.9), all manifests and nested prefixes.
    expect(env.base.mirror.has("Moss-1.0.10-x64.exe")).toBe(true);
    expect(env.base.mirror.has("Moss-1.0.9-x64.exe")).toBe(true);
    expect(env.base.mirror.has("Moss-1.0.9-x64.exe.blockmap")).toBe(true);
    expect(env.base.mirror.has("Moss-1.0.9-arm64.dmg")).toBe(true);
    expect(env.base.mirror.has("Moss-1.0.2-x64.exe")).toBe(false);
    expect(env.base.mirror.has("Moss-1.0.2-x64.exe.blockmap")).toBe(false);
    expect(env.base.mirror.has("Moss-1.0.8-arm64.dmg")).toBe(false);
    expect(logs.some((line) => line.startsWith("Prune summary: deleted 3 object(s)"))).toBe(true);
  });

  it("never lists or deletes anything when upload or read-back verification fails", async () => {
    const installer1010 = Buffer.from("installer-1.0.10");
    const env = prunableWorld("v1.0.10", {
      "moss.yml": manifestFor("1.0.10", installer1010),
      "Moss-1.0.10-x64.exe": installer1010,
    });
    env.base.mirror.set("Moss-1.0.1-x64.exe", Buffer.alloc(1000));
    env.base.mirror.set("Moss-1.0.2-x64.exe", Buffer.alloc(1000));
    env.base.rangeSupported = false;

    await expect(
      syncUpdateMirror({
        repository: REPOSITORY,
        feedUrl: FEED,
        privateKey,
        store: env.store,
        githubApiUrl: API,
        fetchImpl: env.fetchImpl,
        verifyRetryDelayMs: 0,
      }),
    ).rejects.toThrow("byte ranges");

    expect(env.listCalls).toBe(0);
    expect(env.deleted).toEqual([]);
    expect(env.base.mirror.has("Moss-1.0.1-x64.exe")).toBe(true);
  });

  it("protects the macOS version named by moss-mac-notice.json and fails closed if unreadable", async () => {
    const installer1010 = Buffer.from("installer-1.0.10");
    const env = prunableWorld("v1.0.10", {
      "moss.yml": manifestFor("1.0.10", installer1010),
      "Moss-1.0.10-x64.exe": installer1010,
    });
    env.base.mirror.set("Moss-1.0.8-arm64.dmg", Buffer.alloc(1000));
    env.base.mirror.set("Moss-1.0.9-arm64.dmg", Buffer.alloc(1000));
    env.base.mirror.set("Moss-1.0.10-arm64.dmg", Buffer.alloc(1000));
    env.base.mirror.set("moss-mac-notice.json", Buffer.from('{"version":"1.0.9"}\n'));

    const result = await syncUpdateMirror({
      repository: REPOSITORY,
      feedUrl: FEED,
      privateKey,
      store: env.store,
      githubApiUrl: API,
      fetchImpl: env.fetchImpl,
      verifyRetryDelayMs: 0,
    });

    expect(result.prune).toMatchObject({
      status: "pruned",
      deleted: ["Moss-1.0.8-arm64.dmg"],
    });
    expect(env.base.mirror.has("Moss-1.0.9-arm64.dmg")).toBe(true);
    expect(env.base.mirror.has("Moss-1.0.10-arm64.dmg")).toBe(true);

    // Now corrupt moss-mac-notice.json and add another older dmg: fail-closed protects all Mac dmgs.
    env.base.mirror.set("Moss-1.0.7-arm64.dmg", Buffer.alloc(1000));
    env.base.mirror.set("moss-mac-notice.json", Buffer.from("{broken"));
    const logs: string[] = [];
    const second = await syncUpdateMirror({
      repository: REPOSITORY,
      feedUrl: FEED,
      privateKey,
      store: env.store,
      githubApiUrl: API,
      fetchImpl: env.fetchImpl,
      verifyRetryDelayMs: 0,
      log: (message) => logs.push(message),
    });

    expect(second).toMatchObject({
      status: "in-sync",
      prune: { status: "pruned", deleted: [] },
    });
    expect(env.base.mirror.has("Moss-1.0.7-arm64.dmg")).toBe(true);
    expect(logs.some((line) => line.includes("protecting all macOS installers"))).toBe(true);
  });

  it("supports --prune-dry-run and --no-prune through runUpdateMirrorSync", async () => {
    const folders: string[] = [];
    try {
      const folder = mkdtempSync(join(tmpdir(), "moss-prune-cli-"));
      folders.push(folder);
      writeFileSync(join(folder, "update-mirror.env"), `MOSS_UPDATE_MIRROR_FEED_URL=${FEED}\n`);
      writeFileSync(
        join(folder, "update-mirror-signing.env"),
        `MOSS_UPDATE_MIRROR_SIGNING_KEY=${privateKey}\n`,
      );
      writeFileSync(
        join(folder, "update-mirror-upload.env"),
        Object.entries(storage("test-bucket"))
          .map(([k, v]) => `${k}=${v}\n`)
          .join(""),
      );

      const installer1010 = Buffer.from("installer-1.0.10");
      const env = prunableWorld("v1.0.10", {
        "moss.yml": manifestFor("1.0.10", installer1010),
        "Moss-1.0.10-x64.exe": installer1010,
      });
      env.base.mirror.set("Moss-1.0.1-x64.exe", Buffer.alloc(1000));
      env.base.mirror.set("Moss-1.0.9-x64.exe", Buffer.alloc(1000));

      const dryRunLogs: string[] = [];
      const dryRunOutcomes = await runUpdateMirrorSync({
        args: ["--prune-dry-run"],
        env: {
          MOSS_UPDATE_MIRROR_SETTINGS_DIR: folder,
          MOSS_UPDATE_MIRROR_GITHUB_API_URL: API,
          MOSS_DESKTOP_UPDATE_REPOSITORY: REPOSITORY,
        },
        homeDirectory: tmpdir(),
        createStore: () => env.store,
        builtInPublicKey: manifestPublicKey,
        fetchImpl: env.fetchImpl,
        verifyRetryDelayMs: 0,
        log: (message) => dryRunLogs.push(message),
      });

      expect(dryRunOutcomes[0]?.result).toMatchObject({
        status: "synced",
        prune: {
          status: "dry-run",
          dryRun: true,
          wouldDelete: ["Moss-1.0.1-x64.exe"],
          bytesToFree: 1000,
        },
      });
      expect(env.deleted).toEqual([]);
      expect(env.base.mirror.has("Moss-1.0.1-x64.exe")).toBe(true);
      expect(dryRunLogs.some((line) => line.includes("Prune dry-run summary:"))).toBe(true);

      // With --no-prune, neither list nor delete runs.
      const callsBefore = env.listCalls;
      const noPruneOutcomes = await runUpdateMirrorSync({
        args: ["--no-prune"],
        env: {
          MOSS_UPDATE_MIRROR_SETTINGS_DIR: folder,
          MOSS_UPDATE_MIRROR_GITHUB_API_URL: API,
          MOSS_DESKTOP_UPDATE_REPOSITORY: REPOSITORY,
        },
        homeDirectory: tmpdir(),
        createStore: () => env.store,
        builtInPublicKey: manifestPublicKey,
        fetchImpl: env.fetchImpl,
        verifyRetryDelayMs: 0,
      });

      expect(noPruneOutcomes[0]?.result).toEqual({ status: "in-sync", tag: "v1.0.10" });
      expect(env.listCalls).toBe(callsBefore);
      expect(env.deleted).toEqual([]);
    } finally {
      for (const folder of folders) rmSync(folder, { recursive: true, force: true });
    }
  });

  it("logs an actionable warning instead of failing when list or delete returns 403 / AccessDenied", async () => {
    const installer1010 = Buffer.from("installer-1.0.10");
    const env = prunableWorld("v1.0.10", {
      "moss.yml": manifestFor("1.0.10", installer1010),
      "Moss-1.0.10-x64.exe": installer1010,
    });
    env.base.mirror.set("Moss-1.0.1-x64.exe", Buffer.alloc(1000));
    env.base.mirror.set("Moss-1.0.9-x64.exe", Buffer.alloc(1000));
    env.setListError(
      Object.assign(new Error("Access Denied."), { name: "S3Error", code: "AccessDenied" }),
    );

    const listWarnLogs: string[] = [];
    const listResult = await syncUpdateMirror({
      repository: REPOSITORY,
      feedUrl: FEED,
      privateKey,
      store: env.store,
      githubApiUrl: API,
      fetchImpl: env.fetchImpl,
      verifyRetryDelayMs: 0,
      log: (message) => listWarnLogs.push(message),
    });

    expect(listResult).toMatchObject({
      status: "synced",
      tag: "v1.0.10",
      prune: {
        status: "permission-denied",
        operation: "list",
        deleted: [],
      },
    });
    expect(listWarnLogs.some((line) => line.includes("lack ListBucket permission"))).toBe(true);

    // Now allow list, deny delete with 403.
    env.setListError(null);
    env.setDeleteError(Object.assign(new Error("HTTP 403 Forbidden"), { status: 403 }));
    const deleteWarnLogs: string[] = [];
    const deleteResult = await syncUpdateMirror({
      repository: REPOSITORY,
      feedUrl: FEED,
      privateKey,
      store: env.store,
      githubApiUrl: API,
      fetchImpl: env.fetchImpl,
      verifyRetryDelayMs: 0,
      log: (message) => deleteWarnLogs.push(message),
    });

    expect(deleteResult).toMatchObject({
      status: "in-sync",
      tag: "v1.0.10",
      prune: {
        status: "permission-denied",
        operation: "delete",
        deleted: [],
      },
    });
    expect(deleteWarnLogs.some((line) => line.includes("lack DeleteObject permission"))).toBe(true);
  });
});
