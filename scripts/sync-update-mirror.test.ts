import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { afterEach, describe, expect, it } from "vitest";

import {
  parseSettingsFile,
  readUpdateMirrorS3ClientOptions,
  readUpdateMirrorStoreSettings,
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
    const pins = '{"runtimes":[{"name":"codex","version":"1.2.3"}]}\n';
    const fake = world("v2.0.0", { ...release(), "runtime-pins.json": pins });

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

  function settingsFolder(files: Record<string, Record<string, string>>): string {
    const folder = mkdtempSync(join(tmpdir(), "moss-mirror-settings-"));
    folders.push(folder);
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

  function twoStores() {
    const cos = world("v2.0.0", release());
    const r2 = world("v2.0.0", release());
    const fetchImpl = ((input: string | URL | Request, init?: RequestInit) => {
      const url = new URL(input instanceof Request ? input.url : input);
      return (url.hostname === "r2.example.test" ? r2 : cos).fetchImpl(input, init);
    }) as typeof fetch;
    const cosFolder = settingsFolder({
      "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: COS_FEED },
      "update-mirror-upload.env": storage("cos-bucket", { MOSS_UPDATE_MIRROR_S3_PATH_STYLE: "0" }),
      "update-mirror-signing.env": { MOSS_UPDATE_MIRROR_SIGNING_KEY: privateKey },
    });
    const r2Folder = settingsFolder({
      "update-mirror.env": { MOSS_UPDATE_MIRROR_FEED_URL: R2_FEED },
      "update-mirror-upload.env": storage("r2-bucket"),
    });
    const storeEnvs: Array<Readonly<Record<string, string | undefined>>> = [];
    const createStore = (env: Readonly<Record<string, string | undefined>>) => {
      storeEnvs.push(env);
      return env.MOSS_UPDATE_MIRROR_S3_BUCKET === "cos-bucket" ? cos.store : r2.store;
    };
    const runBoth = (extraEnv: Record<string, string> = {}) =>
      runUpdateMirrorSync({
        args: [],
        env: {
          MOSS_UPDATE_MIRROR_SETTINGS_DIRS: [cosFolder, r2Folder].join(delimiter),
          MOSS_UPDATE_MIRROR_GITHUB_API_URL: API,
          MOSS_DESKTOP_UPDATE_REPOSITORY: REPOSITORY,
          ...extraEnv,
        },
        homeDirectory: tmpdir(),
        createStore,
        builtInPublicKey: manifestPublicKey,
        fetchImpl,
        verifyRetryDelayMs: 0,
      });
    return { cos, r2, cosFolder, r2Folder, storeEnvs, runBoth };
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
});
