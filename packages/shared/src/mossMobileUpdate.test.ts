import { describe, expect, it } from "vitest";

import {
  buildMossUpdateSignaturePayload,
  compareSemver,
  isNewerMobileRelease,
  MOSS_MOBILE_ANDROID_MANIFEST_FILE,
  MOSS_MOBILE_UPDATE_MIRRORS,
  MOSS_UPDATE_MANIFEST_PUBLIC_KEY,
  mossMobileUpdateMirrorBases,
  parseMossMobileUpdateManifest,
  resolveMobileArtifactUrl,
  resolveMobileArtifactUrls,
} from "./mossMobileUpdate";

const VALID_SHA = "a".repeat(64);

const sampleAndroidManifest = JSON.stringify(
  {
    schemaVersion: 1,
    platform: "android",
    channel: "stable",
    version: "1.0.14",
    buildNumber: 10014,
    releaseDate: "2026-11-23T08:00:00Z",
    fileName: "Moss-Android-1.0.14.apk",
    path: "Moss-Android-1.0.14.apk",
    size: 52428800,
    sha256: VALID_SHA,
    releaseNotes: {
      zh: "优化聊天排版与手机端自动更新体验",
      en: "Polished chat layout and in-app auto updates.",
    },
  },
  null,
  2,
);

describe("mossMobileUpdate contract", () => {
  it("orders mirrors COS->R2 for cn and R2->COS for global under /mobile/", () => {
    expect(mossMobileUpdateMirrorBases("cn")).toEqual([
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/",
      "https://update.mossbotai.com/mobile/",
    ]);
    expect(mossMobileUpdateMirrorBases("global")).toEqual([
      "https://update.mossbotai.com/mobile/",
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/",
    ]);
    expect(MOSS_MOBILE_UPDATE_MIRRORS[0]?.manifestPublicKey).toBe(MOSS_UPDATE_MANIFEST_PUBLIC_KEY);
  });

  it("formats domain-separated signature payloads identically to desktop", () => {
    expect(buildMossUpdateSignaturePayload(MOSS_MOBILE_ANDROID_MANIFEST_FILE, "{}\n")).toBe(
      "moss-update-manifest-v1\nandroid-latest.json\n{}\n",
    );
  });

  it("compares SemVer 2.0.0 and buildNumber accurately", () => {
    expect(compareSemver("1.0.14", "1.0.11")).toBeGreaterThan(0);
    expect(compareSemver("1.0.14", "1.0.14-rc.1")).toBeGreaterThan(0);
    expect(compareSemver("1.1.0", "1.0.99")).toBeGreaterThan(0);
    expect(compareSemver("1.0.14", "1.0.14")).toBe(0);

    const parsed = parseMossMobileUpdateManifest(sampleAndroidManifest);
    expect(
      isNewerMobileRelease({
        currentVersion: "1.0.11",
        currentBuildNumber: 10011,
        candidate: parsed,
      }),
    ).toBe(true);
    expect(
      isNewerMobileRelease({
        currentVersion: "1.0.14",
        currentBuildNumber: 10014,
        candidate: parsed,
      }),
    ).toBe(false);
    expect(
      isNewerMobileRelease({
        currentVersion: "1.0.14",
        currentBuildNumber: 10013,
        candidate: parsed,
      }),
    ).toBe(true);
  });

  it("rejects unsafe paths, bad hashes, and HTTP download bases", () => {
    const valid = parseMossMobileUpdateManifest(sampleAndroidManifest);
    expect(
      resolveMobileArtifactUrl(
        "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/",
        valid,
      ),
    ).toBe(
      "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/Moss-Android-1.0.14.apk",
    );

    expect(() => resolveMobileArtifactUrl("http://evil.example.com/mobile/", valid)).toThrow(
      /HTTPS/,
    );

    expect(() =>
      parseMossMobileUpdateManifest(
        sampleAndroidManifest.replace("Moss-Android-1.0.14.apk", "../evil.apk"),
      ),
    ).toThrow(/single-segment/);

    expect(() =>
      parseMossMobileUpdateManifest(sampleAndroidManifest.replace(VALID_SHA, "deadbeef")),
    ).toThrow(/sha256/);
  });

  it("uses mirrorPath (.bin) on COS default domain and demotes COS without mirrorPath behind R2", () => {
    const baseObj = JSON.parse(sampleAndroidManifest) as Record<string, unknown>;
    const withMirror = parseMossMobileUpdateManifest(
      JSON.stringify({ ...baseObj, mirrorPath: "Moss-Android-1.0.14.bin" }),
    );
    expect(withMirror.mirrorPath).toBe("Moss-Android-1.0.14.bin");

    const cosFeed = "https://moss-update-1259646312.cos.ap-guangzhou.myqcloud.com/mobile/";
    const r2Feed = "https://update.mossbotai.com/mobile/";

    expect(resolveMobileArtifactUrl(cosFeed, withMirror)).toBe(`${cosFeed}Moss-Android-1.0.14.bin`);
    expect(resolveMobileArtifactUrl(r2Feed, withMirror)).toBe(`${r2Feed}Moss-Android-1.0.14.apk`);
    expect(resolveMobileArtifactUrls([cosFeed, r2Feed, cosFeed], withMirror)).toEqual([
      `${cosFeed}Moss-Android-1.0.14.bin`,
      `${r2Feed}Moss-Android-1.0.14.apk`,
    ]);

    const withoutMirror = parseMossMobileUpdateManifest(sampleAndroidManifest);
    expect(resolveMobileArtifactUrls([cosFeed, r2Feed], withoutMirror)).toEqual([
      `${r2Feed}Moss-Android-1.0.14.apk`,
      `${cosFeed}Moss-Android-1.0.14.apk`,
    ]);

    expect(() =>
      parseMossMobileUpdateManifest(
        JSON.stringify({ ...baseObj, mirrorPath: "Moss-Android-1.0.14.exe" }),
      ),
    ).toThrow(/mirrorPath/);
  });
});
