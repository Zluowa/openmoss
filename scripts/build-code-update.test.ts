import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import * as path from "node:path";

import { generateMossUpdateManifestKeyPair } from "@moss/shared/mossUpdateMirror";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { resolveCodeUpdateSigningKey } from "./build-code-update.ts";

let work: string;
beforeEach(async () => {
  work = await mkdtemp(path.join(tmpdir(), "moss-code-update-sign-"));
});
afterEach(async () => {
  await rm(work, { recursive: true, force: true });
});

// Generated at run time: no key material is written into the source.
const key = () => generateMossUpdateManifestKeyPair().privateKey;

describe("resolveCodeUpdateSigningKey", () => {
  it("does not sign unless asked", async () => {
    expect(
      await resolveCodeUpdateSigningKey({
        sign: false,
        signKeyFile: undefined,
        env: {},
        homeDirectory: work,
      }),
    ).toBeNull();
  });

  it("--sign takes the release key from the environment, as the mirror sync does", async () => {
    const value = key();
    expect(
      await resolveCodeUpdateSigningKey({
        sign: true,
        signKeyFile: undefined,
        env: { MOSS_UPDATE_MIRROR_SIGNING_KEY: value },
        homeDirectory: work,
      }),
    ).toBe(value);
  });

  it("--sign takes the release key from the update-mirror settings folder", async () => {
    const value = key();
    const folder = path.join(work, "settings");
    await mkdir(folder);
    await writeFile(
      path.join(folder, "update-mirror-signing.env"),
      `MOSS_UPDATE_MIRROR_SIGNING_KEY=${value}\n`,
    );
    expect(
      await resolveCodeUpdateSigningKey({
        sign: true,
        signKeyFile: undefined,
        env: { MOSS_UPDATE_MIRROR_SETTINGS_DIR: folder },
        homeDirectory: work,
      }),
    ).toBe(value);
  });

  it("--sign without a key anywhere fails instead of writing an unsigned manifest", async () => {
    await expect(
      resolveCodeUpdateSigningKey({
        sign: true,
        signKeyFile: undefined,
        env: { MOSS_UPDATE_MIRROR_SETTINGS_DIR: path.join(work, "empty") },
        homeDirectory: work,
      }),
    ).rejects.toThrow(/MOSS_UPDATE_MIRROR_SIGNING_KEY is not set/u);
  });

  it("--sign-key-file stays an alternative, and the two together are refused", async () => {
    const value = key();
    const file = path.join(work, "key.txt");
    await writeFile(file, `${value}\n`);
    expect(
      await resolveCodeUpdateSigningKey({
        sign: false,
        signKeyFile: file,
        env: {},
        homeDirectory: work,
      }),
    ).toBe(value);
    await expect(
      resolveCodeUpdateSigningKey({ sign: true, signKeyFile: file, env: {}, homeDirectory: work }),
    ).rejects.toThrow(/not both/u);
  });
});
