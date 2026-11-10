// FILE: mossUpdateMirror.ts
// Purpose: Describes the domestic desktop update mirror and the signature that makes it trustworthy.
//          A storage bucket is easier to tamper with than the release repository, and Windows
//          publisher checks only run on code-signed builds, so the app accepts a mirror's update
//          manifest only when it carries a signature from the Moss release key. The manifest pins
//          each installer's sha512, so this covers the downloaded bytes as well.
// Layer: Shared release/runtime contract (scripts sign, the desktop main process verifies).

import {
  createPrivateKey,
  createPublicKey,
  generateKeyPairSync,
  sign,
  verify,
  type KeyObject,
} from "node:crypto";

export interface MossUpdateMirrorConfig {
  /** Directory holding the channel manifests and installers, always ending in a slash. */
  readonly feedUrl: string;
  /** Base64 DER (SPKI) Ed25519 public key. Not a secret. */
  readonly manifestPublicKey: string;
}

/** The production mirror. Null would mean every account keeps using the official feed. */
export const MOSS_DESKTOP_CN_UPDATE_MIRROR: MossUpdateMirrorConfig | null = {
  feedUrl: "https://moss-update.comiction.cn/desktop/",
  manifestPublicKey: "MCowBQYDK2VwAyEAsF4Nc7+iI39nphKy9Sot+jfpQSMcVLQyjeTkLHZJHwE=",
};

export const MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX = ".sig";

const SIGNATURE_DOMAIN = "moss-update-manifest-v1";

function isLoopbackHostname(hostname: string): boolean {
  return hostname === "localhost" || hostname === "127.0.0.1" || hostname === "[::1]";
}

function importPublicKey(manifestPublicKey: string): KeyObject {
  const key = createPublicKey({
    key: Buffer.from(manifestPublicKey, "base64"),
    format: "der",
    type: "spki",
  });
  if (key.asymmetricKeyType !== "ed25519") {
    throw new Error("Update mirror manifest key must be Ed25519.");
  }
  return key;
}

/** Throws on a mirror the app must not use. Plain HTTP is only for a local mock feed. */
export function parseMossUpdateMirrorConfig(
  input: { readonly feedUrl: string; readonly manifestPublicKey: string },
  options: { readonly allowLoopback?: boolean } = {},
): MossUpdateMirrorConfig {
  const url = new URL(input.feedUrl);
  const isLoopback = isLoopbackHostname(url.hostname);
  if (isLoopback ? !options.allowLoopback : url.protocol !== "https:") {
    throw new Error("Update mirror feed must be a public HTTPS URL.");
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Update mirror feed must be an HTTP(S) URL.");
  }
  if (url.username || url.password || url.search || url.hash) {
    throw new Error("Update mirror feed must not carry credentials, a query, or a fragment.");
  }
  importPublicKey(input.manifestPublicKey);
  return {
    feedUrl: url.href.endsWith("/") ? url.href : `${url.href}/`,
    manifestPublicKey: input.manifestPublicKey,
  };
}

// Binding the file name stops a valid signature for one channel or platform from being replayed
// onto another.
function signaturePayload(channelFile: string, manifest: string): Buffer {
  return Buffer.from(`${SIGNATURE_DOMAIN}\n${channelFile}\n${manifest}`, "utf8");
}

export function signMossUpdateManifest(input: {
  readonly channelFile: string;
  readonly manifest: string;
  /** Base64 DER (PKCS#8) Ed25519 private key. */
  readonly privateKey: string;
}): string {
  const key = createPrivateKey({
    key: Buffer.from(input.privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return sign(null, signaturePayload(input.channelFile, input.manifest), key).toString("base64");
}

export function verifyMossUpdateManifest(input: {
  readonly channelFile: string;
  readonly manifest: string;
  readonly signature: string;
  readonly manifestPublicKey: string;
}): boolean {
  try {
    return verify(
      null,
      signaturePayload(input.channelFile, input.manifest),
      importPublicKey(input.manifestPublicKey),
      Buffer.from(input.signature.trim(), "base64"),
    );
  } catch {
    return false;
  }
}

export function deriveMossUpdateManifestPublicKey(privateKey: string): string {
  const key = createPrivateKey({
    key: Buffer.from(privateKey, "base64"),
    format: "der",
    type: "pkcs8",
  });
  return createPublicKey(key).export({ format: "der", type: "spki" }).toString("base64");
}

export function generateMossUpdateManifestKeyPair(): {
  readonly manifestPublicKey: string;
  readonly privateKey: string;
} {
  const { publicKey, privateKey } = generateKeyPairSync("ed25519");
  return {
    manifestPublicKey: publicKey.export({ format: "der", type: "spki" }).toString("base64"),
    privateKey: privateKey.export({ format: "der", type: "pkcs8" }).toString("base64"),
  };
}
