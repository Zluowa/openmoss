import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import {
  MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY,
  desktopUpdateChannel,
} from "@synara/shared/desktopIdentity";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createCurlFeedClient,
  prepareFeedRelease,
  publishFeedRelease,
  syncDomesticMirror,
  type FeedAsset,
  type FeedReleaseClient,
  type PreparedFeedRelease,
  type RemoteAsset,
  type RemoteRelease,
} from "./desktop-feed-release";
import { readReleaseUpdatePolicyConfig } from "./release-update-policy";

const VERSION = "1.0.2";
const INSTALLER = `Moss-${VERSION}-x64.exe`;
const directories: string[] = [];

afterEach(() => {
  for (const directory of directories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

function writeBuildFolder(options: { readonly manifestVersion?: string } = {}): string {
  const directory = mkdtempSync(join(tmpdir(), "moss-feed-release-"));
  directories.push(directory);
  const installer = Buffer.from("installer bytes");
  const sha512 = createHash("sha512").update(installer).digest("base64");
  writeFileSync(join(directory, INSTALLER), installer);
  writeFileSync(join(directory, `${INSTALLER}.blockmap`), "blockmap bytes");
  writeFileSync(
    join(directory, "latest.yml"),
    [
      `version: ${options.manifestVersion ?? VERSION}`,
      "files:",
      `  - url: ${INSTALLER}`,
      `    sha512: ${sha512}`,
      `    size: ${installer.length}`,
      `path: ${INSTALLER}`,
      `sha512: ${sha512}`,
      "releaseDate: '2026-10-31T00:00:00.000Z'",
      "",
    ].join("\n"),
  );
  return directory;
}

function prepare(directory: string, publishedStableTags: readonly string[] = ["v0.7.2"]) {
  return prepareFeedRelease({
    artifactsDirectory: directory,
    version: VERSION,
    channel: "moss",
    publishedStableTags,
  });
}

interface FakeFeedOptions {
  readonly releases?: readonly RemoteRelease[];
  readonly tagExists?: boolean;
  readonly draftAssets?: readonly RemoteAsset[];
  readonly failUploads?: (name: string, attempt: number) => boolean;
  readonly latestTagAfterPublish?: readonly (string | null)[];
}

function createFakeFeed(prepared: PreparedFeedRelease, options: FakeFeedOptions = {}) {
  const calls: string[] = [];
  const assets = new Map<string, RemoteAsset>(
    (options.draftAssets ?? []).map((asset) => [asset.name, asset]),
  );
  const uploadAttempts = new Map<string, number>();
  const latestTags = [...(options.latestTagAfterPublish ?? [prepared.tag])];
  let published = false;
  let nextAssetId = 1000;
  const release = (draft: boolean): RemoteRelease => ({
    id: 7,
    tagName: prepared.tag,
    draft,
    prerelease: false,
    htmlUrl: "https://example.test/release",
  });
  const client: FeedReleaseClient = {
    listReleases: async () => options.releases ?? [],
    tagExists: async () => options.tagExists ?? false,
    createDraft: async () => {
      calls.push("createDraft");
      return release(true);
    },
    listAssets: async () => [...assets.values()],
    deleteAsset: async (assetId) => {
      calls.push(`delete:${assetId}`);
      for (const [name, asset] of assets) {
        if (asset.id === assetId) assets.delete(name);
      }
    },
    uploadAsset: async (_releaseId, asset: FeedAsset) => {
      const attempt = (uploadAttempts.get(asset.name) ?? 0) + 1;
      uploadAttempts.set(asset.name, attempt);
      calls.push(`upload:${asset.name}`);
      if (options.failUploads?.(asset.name, attempt)) {
        throw new Error(`network dropped ${asset.name}`);
      }
      nextAssetId += 1;
      assets.set(asset.name, {
        id: nextAssetId,
        name: asset.name,
        size: asset.size,
        state: "uploaded",
        digest: `sha256:${asset.sha256}`,
      });
    },
    publish: async () => {
      calls.push("publish");
      published = true;
      return release(false);
    },
    readLatestTag: async () => (published ? (latestTags.shift() ?? prepared.tag) : "v0.7.2"),
    readPublicFile: async (_tag, name) => {
      const asset = prepared.assets.find((candidate) => candidate.name === name);
      return published && asset ? readFileSync(asset.path) : null;
    },
    readPublicFileSize: async (_tag, name) => {
      const asset = prepared.assets.find((candidate) => candidate.name === name);
      return published && asset ? asset.size : null;
    },
  };
  return { client, calls, assets };
}

const publishOptions = { name: `Moss ${VERSION}`, body: "notes" };

describe("the feed names match what installed apps request", () => {
  it("publishes under the channel the packaged app asks for", () => {
    // A release built on a different channel name is exactly the 404 this guards:
    // installed apps ask for `<channel>.yml` and nothing else.
    const config = readReleaseUpdatePolicyConfig(resolve(import.meta.dirname, "../.."));
    expect(config.channel).toBe(desktopUpdateChannel("production"));
    expect(config.channel).toBe("moss");
  });

  it("publishes to the repository packaged apps read", () => {
    expect(MOSS_DESKTOP_DEFAULT_UPDATE_REPOSITORY).toBe("Zluowa/moss-releases");
  });
});

describe("prepareFeedRelease", () => {
  it("writes the channel manifest byte-identical to latest.yml and lists every asset", () => {
    const directory = writeBuildFolder();
    const prepared = prepare(directory);

    expect(readFileSync(join(directory, "moss.yml"))).toEqual(
      readFileSync(join(directory, "latest.yml")),
    );
    expect(prepared.assets.map((asset) => asset.name).toSorted()).toEqual(
      [INSTALLER, `${INSTALLER}.blockmap`, "SHA256SUMS", "latest.yml", "moss.yml"].toSorted(),
    );
    const checksums = readFileSync(join(directory, "SHA256SUMS"), "utf8");
    for (const name of [INSTALLER, `${INSTALLER}.blockmap`, "latest.yml", "moss.yml"]) {
      expect(checksums).toContain(`  ${name}\n`);
    }
  });

  it("can be repeated on the same folder", () => {
    const directory = writeBuildFolder();
    const first = prepare(directory);
    expect(prepare(directory).assets).toEqual(first.assets);
  });

  it("refuses a suffixed version, which production installs would never take", () => {
    expect(() =>
      prepareFeedRelease({
        artifactsDirectory: writeBuildFolder(),
        version: "1.0.2-beta.2",
        channel: "moss",
        publishedStableTags: ["v0.7.2"],
      }),
    ).toThrow(/strict SemVer/);
  });

  it("refuses a version that is not newer than the feed", () => {
    expect(() => prepare(writeBuildFolder(), ["v1.0.2"])).toThrow(/strictly newer/);
  });

  it("refuses a manifest for another version", () => {
    expect(() => prepare(writeBuildFolder({ manifestVersion: "1.0.1" }))).toThrow(
      /has version 1\.0\.1/,
    );
  });

  it("refuses a manifest that does not describe the installer's bytes", () => {
    const directory = writeBuildFolder();
    writeFileSync(join(directory, INSTALLER), "different bytes");
    expect(() => prepare(directory)).toThrow(/does not describe the bytes/);
  });

  it("refuses a build folder without its blockmap", () => {
    const directory = writeBuildFolder();
    rmSync(join(directory, `${INSTALLER}.blockmap`));
    expect(() => prepare(directory)).toThrow();
  });
});

describe("publishFeedRelease", () => {
  it("uploads everything to a draft before it publishes, then checks the public feed", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared);

    await publishFeedRelease(prepared, feed.client, publishOptions);

    expect(feed.calls[0]).toBe("createDraft");
    expect(feed.calls.at(-1)).toBe("publish");
    expect(feed.calls.filter((call) => call.startsWith("upload:"))).toHaveLength(5);
  });

  it("refuses a tag that is already published and changes nothing", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, {
      releases: [
        {
          id: 1,
          tagName: prepared.tag,
          draft: false,
          prerelease: false,
          htmlUrl: "https://example.test/old",
        },
      ],
    });

    await expect(publishFeedRelease(prepared, feed.client, publishOptions)).rejects.toThrow(
      /never overwritten/,
    );
    expect(feed.calls).toEqual([]);
  });

  it("refuses a tag that exists without a release", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, { tagExists: true });

    await expect(publishFeedRelease(prepared, feed.client, publishOptions)).rejects.toThrow(
      /never overwritten/,
    );
    expect(feed.calls).toEqual([]);
  });

  it("resumes a draft: keeps complete uploads and replaces partial or foreign ones", async () => {
    const prepared = prepare(writeBuildFolder());
    const blockmap = prepared.assets.find((asset) => asset.name.endsWith(".blockmap"));
    const installer = prepared.assets.find((asset) => asset.name === INSTALLER);
    if (!blockmap || !installer) throw new Error("fixture lost its assets");
    const feed = createFakeFeed(prepared, {
      releases: [
        {
          id: 7,
          tagName: prepared.tag,
          draft: true,
          prerelease: false,
          htmlUrl: "https://example.test/draft",
        },
      ],
      draftAssets: [
        {
          id: 1,
          name: blockmap.name,
          size: blockmap.size,
          state: "uploaded",
          digest: `sha256:${blockmap.sha256}`,
        },
        { id: 2, name: installer.name, size: 3, state: "starter", digest: null },
        { id: 3, name: "stray.txt", size: 1, state: "uploaded", digest: null },
      ],
    });

    await publishFeedRelease(prepared, feed.client, publishOptions);

    expect(feed.calls).not.toContain("createDraft");
    expect(feed.calls).toContain("delete:2");
    expect(feed.calls).toContain("delete:3");
    expect(feed.calls).not.toContain("delete:1");
    expect(feed.calls).not.toContain(`upload:${blockmap.name}`);
    expect(feed.calls).toContain(`upload:${installer.name}`);
  });

  it("replaces an upload whose checksum differs even when the size matches", async () => {
    const prepared = prepare(writeBuildFolder());
    const manifest = prepared.assets.find((asset) => asset.name === "moss.yml");
    if (!manifest) throw new Error("fixture lost its manifest");
    const feed = createFakeFeed(prepared, {
      releases: [
        {
          id: 7,
          tagName: prepared.tag,
          draft: true,
          prerelease: false,
          htmlUrl: "https://example.test/draft",
        },
      ],
      draftAssets: [
        {
          id: 1,
          name: manifest.name,
          size: manifest.size,
          state: "uploaded",
          digest: "sha256:0000",
        },
      ],
    });

    await publishFeedRelease(prepared, feed.client, publishOptions);

    expect(feed.calls).toContain("delete:1");
    expect(feed.calls).toContain("upload:moss.yml");
  });

  it("retries a dropped upload and still publishes", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, {
      failUploads: (name, attempt) => name === INSTALLER && attempt === 1,
    });

    await publishFeedRelease(prepared, feed.client, publishOptions);

    expect(feed.calls.filter((call) => call === `upload:${INSTALLER}`)).toHaveLength(2);
    expect(feed.calls.at(-1)).toBe("publish");
  });

  it("never publishes while an asset is missing", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, { failUploads: (name) => name === INSTALLER });

    await expect(publishFeedRelease(prepared, feed.client, publishOptions)).rejects.toThrow(
      /nothing was published/,
    );
    expect(feed.calls).not.toContain("publish");
  });

  it("waits for GitHub's Latest to catch up", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, {
      latestTagAfterPublish: ["v0.7.2", null, prepared.tag],
    });

    await expect(publishFeedRelease(prepared, feed.client, publishOptions)).resolves.toMatchObject({
      tagName: prepared.tag,
    });
  });

  it("reports failure when Latest never moves to the new release", async () => {
    const prepared = prepare(writeBuildFolder());
    const feed = createFakeFeed(prepared, {
      latestTagAfterPublish: Array.from({ length: 12 }, () => "v0.7.2"),
    });

    await expect(
      publishFeedRelease(prepared, feed.client, { ...publishOptions, maxVerifyAttempts: 3 }),
    ).rejects.toThrow(/Latest release is v0\.7\.2/);
  });
});

describe("syncDomesticMirror", () => {
  function writeSyncScript(source: string): string {
    const directory = mkdtempSync(join(tmpdir(), "moss-feed-mirror-"));
    directories.push(directory);
    const scriptPath = join(directory, "sync-update-mirror.mjs");
    writeFileSync(scriptPath, source);
    return scriptPath;
  }

  it("skips quietly on a checkout without the sync script", () => {
    const messages: string[] = [];
    syncDomesticMirror({
      scriptPath: join(tmpdir(), "moss-no-such-sync-script.mjs"),
      artifactsDirectory: "unused",
      cwd: tmpdir(),
      log: (message) => messages.push(message),
    });
    expect(messages).toEqual(["This checkout has no domestic mirror sync; skipping it."]);
  });

  it("hands the build folder to the sync and keeps the release token from it", () => {
    vi.stubEnv("GITHUB_TOKEN", "write-token");
    vi.stubEnv("MOSS_UPDATE_MIRROR_FEED_URL", "https://mirror.example.test");
    try {
      const scriptPath = writeSyncScript(`
        import { writeFileSync } from "node:fs";
        writeFileSync(process.argv[1] + ".seen.json", JSON.stringify({
          args: process.argv.slice(2),
          token: process.env.GITHUB_TOKEN ?? null,
          feedUrl: process.env.MOSS_UPDATE_MIRROR_FEED_URL ?? null,
        }));
      `);
      syncDomesticMirror({ scriptPath, artifactsDirectory: "build-folder", cwd: tmpdir() });

      expect(JSON.parse(readFileSync(`${scriptPath}.seen.json`, "utf8"))).toEqual({
        args: ["--assets-dir", "build-folder"],
        token: null,
        feedUrl: "https://mirror.example.test",
      });
    } finally {
      vi.unstubAllEnvs();
    }
  });

  it("says the release is already public and how to finish when the sync fails", () => {
    const scriptPath = writeSyncScript("process.exit(3);");
    expect(() =>
      syncDomesticMirror({ scriptPath, artifactsDirectory: "build-folder", cwd: tmpdir() }),
    ).toThrow(
      /Published to GitHub, but the domestic mirror did not sync.*--assets-dir build-folder/,
    );
  });
});

describe("createCurlFeedClient", () => {
  it("drives the whole publication through real curl against a GitHub-shaped server", async () => {
    const prepared = prepare(writeBuildFolder());
    const uploads = new Map<string, Buffer>();
    const authorizations = new Set<string | undefined>();
    let published = false;
    const server = createServer((request, response) => {
      const url = new URL(request.url ?? "/", "http://localhost");
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        const body = Buffer.concat(chunks);
        const sendJson = (status: number, value: unknown): void => {
          response.writeHead(status, { "content-type": "application/json" });
          response.end(JSON.stringify(value));
        };
        const release = {
          id: 7,
          tag_name: prepared.tag,
          draft: !published,
          prerelease: false,
          html_url: "http://localhost/release",
        };
        const route = `${request.method} ${url.pathname}`;
        if (url.pathname.startsWith("/api/")) authorizations.add(request.headers.authorization);
        if (route === "GET /api/repos/o/r/releases") return sendJson(200, []);
        if (route === `GET /api/repos/o/r/git/ref/tags/${prepared.tag}`) {
          return sendJson(404, { message: "Not Found" });
        }
        if (route === "POST /api/repos/o/r/releases") {
          expect(JSON.parse(body.toString("utf8"))).toMatchObject({
            tag_name: prepared.tag,
            draft: true,
            prerelease: false,
          });
          return sendJson(201, release);
        }
        if (route === "GET /api/repos/o/r/releases/7/assets") {
          return sendJson(
            200,
            [...uploads].map(([name, bytes], index) => ({
              id: index + 1,
              name,
              size: bytes.length,
              state: "uploaded",
              digest: `sha256:${createHash("sha256").update(bytes).digest("hex")}`,
            })),
          );
        }
        if (route === "POST /upload/repos/o/r/releases/7/assets") {
          uploads.set(url.searchParams.get("name") ?? "", body);
          return sendJson(201, {});
        }
        if (route === "PATCH /api/repos/o/r/releases/7") {
          expect(JSON.parse(body.toString("utf8"))).toMatchObject({
            draft: false,
            make_latest: "true",
          });
          published = true;
          return sendJson(200, { ...release, draft: false });
        }
        if (route === "GET /web/o/r/releases/latest") {
          expect(request.headers.authorization).toBeUndefined();
          return sendJson(200, { tag_name: published ? prepared.tag : "v0.7.2" });
        }
        const download = /^\/web\/o\/r\/releases\/download\/[^/]+\/(.+)$/.exec(url.pathname);
        const bytes = download?.[1] ? uploads.get(download[1]) : undefined;
        if (download && bytes && published) {
          // Same shape as GitHub: an asset download is a redirect to the CDN.
          if (!url.searchParams.has("cdn")) {
            response.writeHead(302, {
              location: `${url.pathname}?cdn=1`,
              "content-length": "0",
            });
            return response.end();
          }
          response.writeHead(200, { "content-length": String(bytes.length) });
          return response.end(request.method === "HEAD" ? undefined : bytes);
        }
        return sendJson(500, { message: `unexpected ${route}` });
      });
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
      const client = createCurlFeedClient({
        repository: "o/r",
        token: "test-token",
        apiBaseUrl: `${base}/api`,
        uploadBaseUrl: `${base}/upload`,
        webBaseUrl: `${base}/web`,
      });

      await publishFeedRelease(prepared, client, publishOptions);

      expect(published).toBe(true);
      expect(authorizations).toEqual(new Set(["Bearer test-token"]));
      for (const asset of prepared.assets) {
        expect(uploads.get(asset.name)).toEqual(readFileSync(asset.path));
      }
    } finally {
      await new Promise((done) => server.close(done));
    }
  }, 30_000);

  it("reports GitHub's refusal instead of treating it as success", async () => {
    const server = createServer((_request, response) => {
      response.writeHead(403, { "content-type": "application/json" });
      response.end(JSON.stringify({ message: "Resource not accessible" }));
    });
    await new Promise<void>((done) => server.listen(0, "127.0.0.1", done));
    try {
      const client = createCurlFeedClient({
        repository: "o/r",
        token: "test-token",
        apiBaseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      });
      await expect(client.listReleases()).rejects.toThrow(/403.*Resource not accessible/);
    } finally {
      await new Promise((done) => server.close(done));
    }
  }, 30_000);
});
