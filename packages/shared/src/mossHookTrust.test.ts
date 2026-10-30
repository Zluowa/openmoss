import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile, mkdir } from "node:fs/promises";
import OS from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  computeHookTrustHash,
  forgetHookTrust,
  getHookTrustStorePath,
  readHookTrustStore,
  resolveHookTrustState,
  trustAllHooks,
  trustHook,
} from "./mossHookTrust";
import { MOSS_SESSION_START_EVENT } from "./mossHooks";
import { getMossSourceLayout } from "./mossSourceLayout";

const tempDirs: string[] = [];

async function makeTempProject(): Promise<string> {
  const tempDir = await mkdtemp(join(OS.tmpdir(), "t3-moss-hook-trust-"));
  tempDirs.push(tempDir);
  return tempDir;
}

afterEach(async () => {
  for (const tempDir of tempDirs.splice(0)) {
    await rm(tempDir, { recursive: true, force: true });
  }
});

describe("computeHookTrustHash", () => {
  it("is deterministic and trims command/event", () => {
    const hash = computeHookTrustHash({ command: "echo hi", event: MOSS_SESSION_START_EVENT });

    expect(hash).toBe(
      computeHookTrustHash({ command: " echo hi ", event: `${MOSS_SESSION_START_EVENT}\n` }),
    );
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("changes when command or event changes and defaults missing parts to empty", () => {
    const base = computeHookTrustHash({ command: "echo hi", event: MOSS_SESSION_START_EVENT });

    expect(computeHookTrustHash({ command: "echo bye", event: MOSS_SESSION_START_EVENT })).not.toBe(
      base,
    );
    expect(computeHookTrustHash({ command: "echo hi", event: "OtherEvent" })).not.toBe(base);
    expect(computeHookTrustHash({})).toBe(computeHookTrustHash({ command: "", event: "" }));
  });
});

describe("resolveHookTrustState", () => {
  it("reports untrusted without an entry, trusted on match, changed on mismatch", () => {
    const currentHash = computeHookTrustHash({
      command: "echo hi",
      event: MOSS_SESSION_START_EVENT,
    });

    expect(resolveHookTrustState({ currentHash, entry: undefined })).toBe("untrusted");
    expect(
      resolveHookTrustState({
        currentHash,
        entry: { trustedHash: currentHash, trustedAt: "2026-07-05T00:00:00.000Z" },
      }),
    ).toBe("trusted");
    expect(
      resolveHookTrustState({
        currentHash,
        entry: { trustedHash: "different", trustedAt: "2026-07-05T00:00:00.000Z" },
      }),
    ).toBe("changed");
  });
});

describe("hook trust store", () => {
  it("resolves the store path under .moss/hooks via the layout", async () => {
    const projectPath = await makeTempProject();

    expect(getHookTrustStorePath(projectPath)).toBe(
      join(getMossSourceLayout(projectPath).hooksRoot, ".trust.json"),
    );
  });

  it("returns an empty store when the file is missing or corrupt", async () => {
    const projectPath = await makeTempProject();

    expect(await readHookTrustStore(projectPath)).toEqual({ version: 1, hooks: {} });

    const storePath = getHookTrustStorePath(projectPath);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(storePath, "not json", "utf8");
    expect(await readHookTrustStore(projectPath)).toEqual({ version: 1, hooks: {} });
  });

  it("drops malformed entries and backfills trustedAt when reading", async () => {
    const projectPath = await makeTempProject();
    const storePath = getHookTrustStorePath(projectPath);
    await mkdir(dirname(storePath), { recursive: true });
    await writeFile(
      storePath,
      JSON.stringify({
        version: 1,
        hooks: {
          valid: { trustedHash: "abc" },
          missingHash: { trustedAt: "2026-07-05T00:00:00.000Z" },
          notAnObject: 7,
        },
      }),
      "utf8",
    );

    expect(await readHookTrustStore(projectPath)).toEqual({
      version: 1,
      hooks: {
        valid: { trustedHash: "abc", trustedAt: new Date(0).toISOString() },
      },
    });
  });

  it("trustHook writes a persistent entry that resolves to trusted", async () => {
    const projectPath = await makeTempProject();
    const trustedHash = computeHookTrustHash({
      command: "echo hi",
      event: MOSS_SESSION_START_EVENT,
    });

    await trustHook({ projectPath, hookName: "session-start", trustedHash });

    const store = await readHookTrustStore(projectPath);
    expect(store.hooks["session-start"]?.trustedHash).toBe(trustedHash);
    expect(
      resolveHookTrustState({ currentHash: trustedHash, entry: store.hooks["session-start"] }),
    ).toBe("trusted");
  });

  it("trustAllHooks records every provided hook and preserves other entries", async () => {
    const projectPath = await makeTempProject();
    await trustHook({ projectPath, hookName: "keep-me", trustedHash: "hash-keep" });

    await trustAllHooks({
      projectPath,
      hooks: [
        { name: "one", trustedHash: "hash-one" },
        { name: "two", trustedHash: "hash-two" },
      ],
    });

    const store = await readHookTrustStore(projectPath);
    expect(Object.keys(store.hooks).toSorted()).toEqual(["keep-me", "one", "two"]);
    expect(store.hooks.one?.trustedHash).toBe("hash-one");
    expect(store.hooks.two?.trustedHash).toBe("hash-two");
  });

  it("forgetHookTrust removes an entry and does not create a store for unknown hooks", async () => {
    const projectPath = await makeTempProject();

    await forgetHookTrust({ projectPath, hookName: "never-trusted" });
    expect(existsSync(getHookTrustStorePath(projectPath))).toBe(false);

    await trustHook({ projectPath, hookName: "session-start", trustedHash: "abc" });
    const store = await forgetHookTrust({ projectPath, hookName: "session-start" });
    expect(store.hooks).toEqual({});
    expect((await readHookTrustStore(projectPath)).hooks).toEqual({});
  });

  it("keeps the trust file content stable when re-reading", async () => {
    const projectPath = await makeTempProject();
    await trustHook({ projectPath, hookName: "session-start", trustedHash: "abc" });

    const raw = await readFile(getHookTrustStorePath(projectPath), "utf8");
    expect(raw.endsWith("\n")).toBe(true);
    expect(JSON.parse(raw).version).toBe(1);
  });
});
