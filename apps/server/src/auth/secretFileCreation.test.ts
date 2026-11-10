import { mkdtempSync, readFileSync, readdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  SECRET_CREATE_ATTEMPTS,
  getOrCreateSecretFile,
  nodeSecretFileOps,
  type SecretFileOps,
} from "./secretFileCreation";

const errno = (code: string) => Object.assign(new Error(code), { code });

let dirs: string[] = [];
const freshDir = () => {
  const dir = mkdtempSync(path.join(tmpdir(), "moss-secret-create-"));
  dirs.push(dir);
  return dir;
};
afterEach(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  dirs = [];
});

/** Real file operations with a hook in front of `link`. */
const withLink = (link: SecretFileOps["link"]): SecretFileOps => ({
  ...nodeSecretFileOps,
  link,
  sleep: async () => undefined,
});

describe("getOrCreateSecretFile", () => {
  it("gives every concurrent creator the same key and leaves no temporary files", async () => {
    const dir = freshDir();
    const file = path.join(dir, "guest-share-signing-key.bin");
    const keys = await Promise.all(
      Array.from({ length: 12 }, () => getOrCreateSecretFile(file, 32)),
    );
    const onDisk = Array.from(readFileSync(file));
    expect(onDisk).toHaveLength(32);
    for (const key of keys) expect(Array.from(key)).toEqual(onDisk);
    expect(readdirSync(dir)).toEqual(["guest-share-signing-key.bin"]);
  });

  it("retries a transient EPERM from Windows and then creates the key", async () => {
    const file = path.join(freshDir(), "key.bin");
    let failures = 2;
    const key = await getOrCreateSecretFile(
      file,
      16,
      withLink(async (from, to) => {
        if (failures-- > 0) throw errno("EPERM");
        await nodeSecretFileOps.link(from, to);
      }),
    );
    expect(Array.from(readFileSync(file))).toEqual(Array.from(key));
  });

  it("reads the winner's key when another writer created it during an EPERM", async () => {
    const file = path.join(freshDir(), "key.bin");
    const winner = new Uint8Array(16).fill(7);
    const key = await getOrCreateSecretFile(
      file,
      16,
      withLink(async () => {
        // The other writer's file lands while ours is refused.
        await nodeSecretFileOps.writeNewFile(file, winner).catch(() => undefined);
        throw errno("EPERM");
      }),
    );
    expect(Array.from(key)).toEqual(Array.from(winner));
  });

  it("gives up with the error when the file stays locked and no key appears", async () => {
    const file = path.join(freshDir(), "key.bin");
    let calls = 0;
    await expect(
      getOrCreateSecretFile(
        file,
        16,
        withLink(async () => {
          calls += 1;
          throw errno("EPERM");
        }),
      ),
    ).rejects.toMatchObject({ code: "EPERM" });
    expect(calls).toBe(SECRET_CREATE_ATTEMPTS);
  });

  it("falls back to an atomic rename on filesystems without hard links", async () => {
    const file = path.join(freshDir(), "key.bin");
    const key = await getOrCreateSecretFile(
      file,
      16,
      withLink(async () => {
        throw errno("ENOTSUP");
      }),
    );
    expect(Array.from(readFileSync(file))).toEqual(Array.from(key));
  });

  it("does not retry real failures", async () => {
    const file = path.join(freshDir(), "key.bin");
    await expect(
      getOrCreateSecretFile(
        file,
        16,
        withLink(async () => {
          throw errno("ENOSPC");
        }),
      ),
    ).rejects.toMatchObject({ code: "ENOSPC" });
  });
});
