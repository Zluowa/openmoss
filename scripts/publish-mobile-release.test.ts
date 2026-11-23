import { createHash } from "node:crypto";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  verifyMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";
import { afterEach, describe, expect, it } from "vitest";

import {
  buildMobileReleaseManifest,
  inspectApkZipEntries,
  planMobileApkPrune,
  publishMobileRelease,
  resolveMobileMirrorTarget,
} from "./publish-mobile-release.ts";

/** Builds a minimal valid uncompressed ZIP containing the specified entry paths. */
function makeSyntheticZip(entries: ReadonlyArray<{ name: string; content?: Buffer }>): Buffer {
  const localParts: Buffer[] = [];
  const cdParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const data = entry.content ?? Buffer.from(`content:${entry.name}`, "utf8");

    const local = Buffer.alloc(30 + nameBuf.length + data.length);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt32LE(data.length, 18);
    local.writeUInt32LE(data.length, 22);
    local.writeUInt16LE(nameBuf.length, 26);
    nameBuf.copy(local, 30);
    data.copy(local, 30 + nameBuf.length);
    localParts.push(local);

    const cd = Buffer.alloc(46 + nameBuf.length);
    cd.writeUInt32LE(0x02014b50, 0);
    cd.writeUInt16LE(20, 4);
    cd.writeUInt16LE(20, 6);
    cd.writeUInt32LE(data.length, 20);
    cd.writeUInt32LE(data.length, 24);
    cd.writeUInt16LE(nameBuf.length, 28);
    cd.writeUInt32LE(offset, 42);
    nameBuf.copy(cd, 46);
    cdParts.push(cd);

    offset += local.length;
  }

  const cdBuf = Buffer.concat(cdParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cdBuf.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, cdBuf, eocd]);
}

const tempDirs: string[] = [];

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("publish-mobile-release", () => {
  it("validates Dual-ABI native libs and index.android.bundle inside APK ZIP", () => {
    const validApk = makeSyntheticZip([
      { name: "AndroidManifest.xml" },
      { name: "assets/index.android.bundle" },
      { name: "lib/arm64-v8a/libhermes.so" },
      { name: "lib/x86_64/libhermes.so" },
    ]);
    const info = inspectApkZipEntries(validApk);
    expect(info.hasArm64).toBe(true);
    expect(info.hasX86_64).toBe(true);
    expect(info.hasAndroidBundle).toBe(true);

    const missingArm64 = makeSyntheticZip([
      { name: "assets/index.android.bundle" },
      { name: "lib/x86_64/libhermes.so" },
    ]);
    expect(() => inspectApkZipEntries(missingArm64)).toThrow(/arm64=false/);
  });

  it("maps desktop mirror store settings to bucket-root mobile/ without nesting under desktop/", () => {
    const target = resolveMobileMirrorTarget({
      label: "cos",
      env: {
        MOSS_UPDATE_MIRROR_S3_PREFIX: "desktop/",
        MOSS_UPDATE_MIRROR_FEED_URL:
          "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/desktop/",
      },
    });
    expect(target.prefix).toBe("mobile/");
    expect(target.feedUrl).toBe(
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/",
    );
  });

  it("prunes older mobile APKs while protecting newest keep versions and current release", () => {
    const prune = planMobileApkPrune({
      prefix: "mobile/",
      protectedFileName: "Moss-Android-1.0.14.apk",
      keep: 2,
      keys: [
        "mobile/android-latest.json",
        "mobile/android-latest.json.sig",
        "mobile/Moss-Android-1.0.10.apk",
        "mobile/Moss-Android-1.0.11.apk",
        "mobile/Moss-Android-1.0.14.apk",
        "desktop/Moss-1.0.13-x64.exe",
      ],
    });
    expect(prune).toEqual(["mobile/Moss-Android-1.0.10.apk"]);
  });

  it("uploads APK + signed manifest to both stores and verifies via GET + Range 206 (never HEAD)", async () => {
    const root = mkdtempSync(join(tmpdir(), "moss-pub-mobile-"));
    tempDirs.push(root);
    const cosDir = join(root, "cos");
    const r2Dir = join(root, "r2");
    mkdirSync(cosDir);
    mkdirSync(r2Dir);

    const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
    const apkBytes = makeSyntheticZip([
      { name: "assets/index.android.bundle" },
      { name: "lib/arm64-v8a/libappmodules.so" },
      { name: "lib/x86_64/libappmodules.so" },
    ]);
    const apkPath = join(root, "Moss-Android-1.0.14.apk");
    writeFileSync(apkPath, apkBytes);

    const common = [
      `MOSS_UPDATE_MIRROR_SIGNING_KEY=${privateKey}`,
      "MOSS_UPDATE_MIRROR_S3_ACCESS_KEY_ID=test-ak",
      "MOSS_UPDATE_MIRROR_S3_SECRET_ACCESS_KEY=test-sk",
      "MOSS_UPDATE_MIRROR_S3_BUCKET=test-bucket",
      "MOSS_UPDATE_MIRROR_S3_ENDPOINT=https://s3.example.test",
      "MOSS_UPDATE_MIRROR_S3_REGION=auto",
      "MOSS_UPDATE_MIRROR_S3_PREFIX=desktop/",
    ].join("\n");
    writeFileSync(
      join(cosDir, "update-mirror.env"),
      `${common}\nMOSS_UPDATE_MIRROR_FEED_URL=https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/desktop/\n`,
    );
    writeFileSync(
      join(r2Dir, "update-mirror.env"),
      `${common}\nMOSS_UPDATE_MIRROR_FEED_URL=https://update.mossbotai.com/desktop/\n`,
    );

    const stored = new Map<string, Map<string, Buffer<ArrayBuffer>>>([
      [
        "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/",
        new Map([["mobile/Moss-Android-1.0.9.bin", Buffer.from("old")]]),
      ],
      [
        "https://update.mossbotai.com/mobile/",
        new Map([["mobile/Moss-Android-1.0.10.apk", Buffer.from("old2")]]),
      ],
    ]);
    const methodsSeen: string[] = [];

    const result = await publishMobileRelease({
      apkPath,
      version: "1.0.14",
      buildNumber: 10014,
      notesZh: "签名校验自动更新发布测试",
      notesEn: "Signed auto-update release check.",
      keep: 1,
      expectedPublicKey: manifestPublicKey,
      verifyRetryDelayMs: 0,
      env: {
        MOSS_UPDATE_MIRROR_SETTINGS_DIRS: [cosDir, r2Dir].join(delimiter),
      },
      createStoreClient: (storeEnv) => {
        const feedUrl = storeEnv.MOSS_UPDATE_MIRROR_FEED_URL!.replace("/desktop/", "/mobile/");
        const bucket = stored.get(feedUrl)!;
        return {
          uploadFile: async ({ key, localPath }) => {
            bucket.set(key, readFileSync(localPath));
          },
          listKeys: async (prefix) => [...bucket.keys()].filter((k) => k.startsWith(prefix)),
          deleteKey: async (key) => {
            bucket.delete(key);
          },
        };
      },
      fetchImpl: (async (input: RequestInfo | URL, init?: RequestInit) => {
        const method = init?.method ?? "GET";
        methodsSeen.push(method);
        if (method === "HEAD") return new Response("forbidden", { status: 403 });
        const url = new URL(String(input));
        const originBase = `${url.origin}/mobile/`;
        const bucket = stored.get(originBase)!;
        const key = url.pathname.replace(/^\//, "");
        if (url.hostname.endsWith(".myqcloud.com") && key.endsWith(".apk")) {
          return new Response("DownloadForbidden", { status: 403 });
        }
        const body = bucket.get(key);
        if (!body) return new Response("not found", { status: 404 });
        const headers = new Headers(init?.headers);
        if (headers.get("Range") === "bytes=0-1023") {
          return new Response(body.subarray(0, 1024), { status: 206 });
        }
        return new Response(body, { status: 200 });
      }) as unknown as typeof fetch,
      log: () => {},
    });

    expect(methodsSeen).not.toContain("HEAD");
    expect(result.sha256).toBe(createHash("sha256").update(apkBytes).digest("hex"));
    expect(result.stores).toHaveLength(2);
    expect(result.stores[0]?.apkUrl).toBe(
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/Moss-Android-1.0.14.bin",
    );
    expect(result.stores[1]?.apkUrl).toBe(
      "https://update.mossbotai.com/mobile/Moss-Android-1.0.14.apk",
    );
    expect(result.stores[0]?.verifiedManifestSignature).toBe(true);
    expect(result.stores[0]?.verifiedRange206).toBe(true);
    expect(result.stores[0]?.prunedKeys).toEqual(["mobile/Moss-Android-1.0.9.bin"]);
    expect(result.stores[1]?.prunedKeys).toEqual(["mobile/Moss-Android-1.0.10.apk"]);

    const cosManifest = stored
      .get("https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/")!
      .get("mobile/android-latest.json")!
      .toString("utf8");
    const cosSig = stored
      .get("https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/")!
      .get("mobile/android-latest.json.sig")!
      .toString("utf8");
    expect(
      verifyMossUpdateManifest({
        channelFile: "android-latest.json",
        manifest: cosManifest,
        signature: cosSig,
        manifestPublicKey,
      }),
    ).toBe(true);
    expect(
      buildMobileReleaseManifest({
        version: "1.0.14",
        buildNumber: 10014,
        apkBuffer: apkBytes,
        notesZh: "a",
        notesEn: "b",
      }).fileName,
    ).toBe("Moss-Android-1.0.14.apk");
  });
});
