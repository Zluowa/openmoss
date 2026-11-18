// FILE: sign-update-mirror-manifests.ts
// Purpose: Signs a release's update manifests for the mirrors, and generates the key pair. The
//          signed files are the channel manifests (`*.yml`) and, from builds that fetch their agent
//          runtimes after install, `runtime-pins.json`; each `.sig` binds its file name. Upload the
//          installers first and the manifests with their signatures last, so a client never reads a
//          manifest whose files are not there yet.
// Usage:
//   bun run scripts/sign-update-mirror-manifests.ts keygen --out <private-key-file>
//   MOSS_UPDATE_MIRROR_SIGNING_KEY=<base64> bun run scripts/sign-update-mirror-manifests.ts sign --dir <release-dir>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import {
  generateMossUpdateManifestKeyPair,
  MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX,
  signMossUpdateManifest,
} from "@moss/shared/mossUpdateMirror";

// electron-builder's own debug log shares the extension but is not a manifest.
const NON_MANIFEST_FILES: ReadonlySet<string> = new Set(["builder-debug.yml"]);

/** The agent runtime pins of one app version, beside its channel manifests in the feed folder. */
export const RUNTIME_PINS_FILE_NAME = "runtime-pins.json";

/** A channel manifest electron-updater reads (`latest.yml`, `moss-mac.yml`, …). */
export function isChannelManifestFileName(name: string): boolean {
  return name.endsWith(".yml") && !NON_MANIFEST_FILES.has(name);
}

/** Every file the feed carries with a release-key signature beside it. */
export function isUpdateManifestFileName(name: string): boolean {
  return isChannelManifestFileName(name) || name === RUNTIME_PINS_FILE_NAME;
}

export function signUpdateManifestsInDirectory(input: {
  readonly directory: string;
  readonly privateKey: string;
}): ReadonlyArray<string> {
  const channelFiles = readdirSync(input.directory).filter(isUpdateManifestFileName).toSorted();
  if (!channelFiles.some(isChannelManifestFileName)) {
    throw new Error(`No update manifests found in ${input.directory}.`);
  }
  for (const channelFile of channelFiles) {
    const manifest = readFileSync(join(input.directory, channelFile), "utf8");
    const signature = signMossUpdateManifest({
      channelFile,
      manifest,
      privateKey: input.privateKey,
    });
    writeFileSync(
      join(input.directory, `${channelFile}${MOSS_UPDATE_MANIFEST_SIGNATURE_SUFFIX}`),
      `${signature}\n`,
    );
  }
  return channelFiles;
}

/** Refuses to overwrite: replacing the key strands every install that embeds the old public key. */
export function writeUpdateMirrorKeyPair(privateKeyPath: string): {
  readonly manifestPublicKey: string;
} {
  if (existsSync(privateKeyPath)) {
    throw new Error(`Refusing to overwrite ${privateKeyPath}.`);
  }
  const { manifestPublicKey, privateKey } = generateMossUpdateManifestKeyPair();
  writeFileSync(privateKeyPath, `${privateKey}\n`, { mode: 0o600, flag: "wx" });
  return { manifestPublicKey };
}

function requireFlag(args: ReadonlyArray<string>, flag: string): string {
  const value = args[args.indexOf(flag) + 1];
  if (!args.includes(flag) || !value) {
    throw new Error(`Missing ${flag}.`);
  }
  return value;
}

function main(args: ReadonlyArray<string>): void {
  const [command, ...rest] = args;
  if (command === "keygen") {
    const { manifestPublicKey } = writeUpdateMirrorKeyPair(requireFlag(rest, "--out"));
    console.log(`manifestPublicKey: ${manifestPublicKey}`);
    return;
  }
  if (command === "sign") {
    const privateKey = process.env.MOSS_UPDATE_MIRROR_SIGNING_KEY?.trim();
    if (!privateKey) {
      throw new Error("MOSS_UPDATE_MIRROR_SIGNING_KEY is not set.");
    }
    const signed = signUpdateManifestsInDirectory({
      directory: requireFlag(rest, "--dir"),
      privateKey,
    });
    console.log(`Signed ${signed.join(", ")}.`);
    return;
  }
  throw new Error("Usage: sign-update-mirror-manifests.ts <keygen --out file | sign --dir dir>");
}

if (import.meta.main) {
  main(process.argv.slice(2));
}
