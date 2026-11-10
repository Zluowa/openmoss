import { describe, expect, it } from "vitest";

import {
  deriveMossUpdateManifestPublicKey,
  generateMossUpdateManifestKeyPair,
  MOSS_DESKTOP_CN_UPDATE_MIRROR,
  parseMossUpdateMirrorConfig,
  signMossUpdateManifest,
  verifyMossUpdateManifest,
} from "./mossUpdateMirror";

const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
const manifest = "version: 2.0.0\npath: Moss-2.0.0-x64.exe\nsha512: abc\n";

function signed(channelFile = "moss.yml", body = manifest): string {
  return signMossUpdateManifest({ channelFile, manifest: body, privateKey });
}

describe("verifyMossUpdateManifest", () => {
  it("accepts a manifest signed by the release key", () => {
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest,
        signature: `${signed()}\n`,
        manifestPublicKey,
      }),
    ).toBe(true);
  });

  it("rejects a changed manifest", () => {
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest: manifest.replace("abc", "evil"),
        signature: signed(),
        manifestPublicKey,
      }),
    ).toBe(false);
  });

  it("rejects a signature replayed from another channel or platform", () => {
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss-linux.yml",
        manifest,
        signature: signed("moss.yml"),
        manifestPublicKey,
      }),
    ).toBe(false);
  });

  it("rejects a signature from another key", () => {
    const other = generateMossUpdateManifestKeyPair();
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest,
        signature: signed(),
        manifestPublicKey: other.manifestPublicKey,
      }),
    ).toBe(false);
  });

  it("rejects garbage instead of throwing", () => {
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest,
        signature: "<html>not found</html>",
        manifestPublicKey,
      }),
    ).toBe(false);
    expect(
      verifyMossUpdateManifest({
        channelFile: "moss.yml",
        manifest,
        signature: signed(),
        manifestPublicKey: "not-a-key",
      }),
    ).toBe(false);
  });
});

describe("deriveMossUpdateManifestPublicKey", () => {
  it("recovers the public key that verifies the private key's signatures", () => {
    expect(deriveMossUpdateManifestPublicKey(privateKey)).toBe(manifestPublicKey);
  });
});

describe("parseMossUpdateMirrorConfig", () => {
  it("normalizes the feed to a directory URL", () => {
    expect(
      parseMossUpdateMirrorConfig({
        feedUrl: "https://updates.example.cn/moss",
        manifestPublicKey,
      }).feedUrl,
    ).toBe("https://updates.example.cn/moss/");
  });

  it("refuses plain HTTP and loopback feeds in production", () => {
    for (const feedUrl of [
      "http://updates.example.cn/moss/",
      "https://localhost/moss/",
      "http://127.0.0.1:9000/",
      "ftp://updates.example.cn/",
    ]) {
      expect(() => parseMossUpdateMirrorConfig({ feedUrl, manifestPublicKey }), feedUrl).toThrow();
    }
  });

  it("allows a loopback mock feed only when asked", () => {
    expect(
      parseMossUpdateMirrorConfig(
        { feedUrl: "http://127.0.0.1:9000", manifestPublicKey },
        { allowLoopback: true },
      ).feedUrl,
    ).toBe("http://127.0.0.1:9000/");
  });

  it("refuses credentials, queries, and fragments", () => {
    for (const feedUrl of [
      "https://user:pw@updates.example.cn/",
      "https://updates.example.cn/?sign=1",
      "https://updates.example.cn/#x",
    ]) {
      expect(() => parseMossUpdateMirrorConfig({ feedUrl, manifestPublicKey }), feedUrl).toThrow();
    }
  });

  it("refuses a key that is not Ed25519", () => {
    expect(() =>
      parseMossUpdateMirrorConfig({
        feedUrl: "https://updates.example.cn/",
        manifestPublicKey: "bm90LWEta2V5",
      }),
    ).toThrow();
  });

  it("keeps the built-in production mirror valid", () => {
    if (MOSS_DESKTOP_CN_UPDATE_MIRROR === null) return;
    expect(parseMossUpdateMirrorConfig(MOSS_DESKTOP_CN_UPDATE_MIRROR)).toEqual(
      MOSS_DESKTOP_CN_UPDATE_MIRROR,
    );
  });
});
