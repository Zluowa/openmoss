// FILE: providerUsage/credentials.atomic.test.ts
// Purpose: Verifies concurrent credential rotations use isolated atomic temp files.

import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import { writeJsonFileAtomic } from "./credentials.ts";

const tempDirectories: string[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    tempDirectories
      .splice(0)
      .map((directory) => fs.rm(directory, { recursive: true, force: true })),
  );
});

describe("writeJsonFileAtomic", () => {
  it("propagates a failed replacement, removes its temporary file, and admits the next rotation", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-credential-recovery-"));
    tempDirectories.push(directory);
    const credentialPath = path.join(directory, "auth.json");
    const originalRename = fs.rename.bind(fs);
    const failure = Object.assign(new Error("Synthetic credential replacement denied"), {
      code: "EACCES",
    });
    let rejected = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (!rejected && destination === credentialPath) {
        rejected = true;
        throw failure;
      }
      return originalRename(source, destination);
    });
    const results = await Promise.allSettled([
      writeJsonFileAtomic(credentialPath, { rotation: "first" }),
      writeJsonFileAtomic(credentialPath, { rotation: "next" }),
    ]);
    expect(results[0]).toEqual({ status: "rejected", reason: failure });
    expect(results[1]).toEqual({ status: "fulfilled", value: undefined });
    expect(JSON.parse(await fs.readFile(credentialPath, "utf8"))).toEqual({ rotation: "next" });
    expect(await fs.readdir(directory)).toEqual(["auth.json"]);
  });

  it("lets another credential destination finish while one replacement is blocked", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-credential-independent-"));
    tempDirectories.push(directory);
    const firstPath = path.join(directory, "first.json");
    const secondPath = path.join(directory, "second.json");
    const originalRename = fs.rename.bind(fs);
    let releaseFirst!: () => void;
    const gate = new Promise<void>((resolve) => {
      releaseFirst = resolve;
    });
    let firstStarted = false;
    let firstDone = false;
    let secondDone = false;
    vi.spyOn(fs, "rename").mockImplementation(async (source, destination) => {
      if (destination === firstPath) {
        firstStarted = true;
        await gate;
      }
      return originalRename(source, destination);
    });
    const first = writeJsonFileAtomic(firstPath, { account: "first" });
    const second = writeJsonFileAtomic(secondPath, { account: "second" });
    const results = Promise.allSettled([first, second]);
    void first.then(
      () => {
        firstDone = true;
      },
      () => {},
    );
    void second.then(
      () => {
        secondDone = true;
      },
      () => {},
    );
    try {
      await vi.waitFor(
        () => {
          expect(firstStarted).toBe(true);
          expect(secondDone).toBe(true);
        },
        { timeout: 5_000 },
      );
      expect(firstDone).toBe(false);
      expect(JSON.parse(await fs.readFile(secondPath, "utf8"))).toEqual({ account: "second" });
      await expect(fs.stat(firstPath)).rejects.toMatchObject({ code: "ENOENT" });
    } finally {
      releaseFirst();
      await results;
    }
    expect((await results).map((result) => result.status)).toEqual(["fulfilled", "fulfilled"]);
    expect((await fs.readdir(directory)).sort()).toEqual(["first.json", "second.json"]);
  });

  it("keeps same-millisecond concurrent writes independent", async () => {
    const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-credential-write-"));
    tempDirectories.push(directory);
    const credentialPath = path.join(directory, "auth.json");

    // The former temp name used Date.now, so every write below targeted the same file.
    vi.spyOn(Date, "now").mockReturnValue(1_789_000_000_000);
    const results = await Promise.allSettled(
      Array.from({ length: 16 }, (_, index) =>
        writeJsonFileAtomic(credentialPath, { account: index }),
      ),
    );

    expect(results.filter((result) => result.status === "rejected")).toEqual([]);
    const persisted = JSON.parse(await fs.readFile(credentialPath, "utf8")) as {
      account?: unknown;
    };
    expect(persisted.account).toEqual(expect.any(Number));
    expect(await fs.readdir(directory)).toEqual(["auth.json"]);
  });
});
