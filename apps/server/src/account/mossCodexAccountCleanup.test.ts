import * as NodeServices from "@effect/platform-node/NodeServices";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { Effect, FileSystem } from "effect";
import { afterEach, describe, expect, it } from "vitest";

import {
  removeMossCodexAccountOverlay,
  removeMossCodexAccountOverlayFamily,
  removeMossCodexAccountShellSnapshotsFamily,
  resolveMossCodexAccountOverlayPath,
} from "./mossCodexAccountCleanup";

const testRoots: string[] = [];

afterEach(() => {
  for (const testRoot of testRoots.splice(0)) {
    rmSync(testRoot, { recursive: true, force: true });
  }
});

describe("Moss Codex account overlay cleanup", () => {
  it("resolves only the account-scoped overlay and rejects default-account cleanup", () => {
    const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-overlay-path-"));
    testRoots.push(runtimeHome);
    const sourceHome = path.join(runtimeHome, "source-home");
    const overlayPath = resolveMossCodexAccountOverlayPath({
      env: { MOSS_HOME: runtimeHome },
      homePath: sourceHome,
      accountId: "byok",
    });

    expect(overlayPath).not.toBe(sourceHome);
    expect(path.dirname(overlayPath)).toBe(
      path.join(runtimeHome, "codex-home-overlay", "accounts"),
    );
    expect(path.basename(overlayPath)).toMatch(/^byok-[a-f0-9]{12}$/);
    expect(() =>
      resolveMossCodexAccountOverlayPath({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "default",
      }),
    ).toThrow(/non-default/i);
  });

  it("removes only the exact managed-style overlay and remains idempotent", async () => {
    const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-overlay-exact-"));
    testRoots.push(runtimeHome);
    const sourceHome = path.join(runtimeHome, "managed-source-home");
    const overlayPath = resolveMossCodexAccountOverlayPath({
      env: { MOSS_HOME: runtimeHome },
      homePath: sourceHome,
      accountId: "moss",
    });
    const siblingOverlay = path.join(path.dirname(overlayPath), "moss-000000000000");

    const result = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of [overlayPath, siblingOverlay, sourceHome]) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "sentinel"), "test-only");
      }
      const input = {
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "moss",
      };
      yield* removeMossCodexAccountOverlay(fs, input);
      yield* removeMossCodexAccountOverlay(fs, input);
      return {
        exactExists: yield* fs.exists(overlayPath),
        siblingExists: yield* fs.exists(siblingOverlay),
        sourceSentinel: yield* fs.readFileString(path.join(sourceHome, "sentinel")),
      };
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

    expect(result).toEqual({
      exactExists: false,
      siblingExists: true,
      sourceSentinel: "test-only",
    });
  });

  it("sweeps only exact reserved-account overlay segments", async () => {
    const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-overlay-family-"));
    testRoots.push(runtimeHome);
    const sourceHome = path.join(runtimeHome, "source-home");
    const overlayPath = resolveMossCodexAccountOverlayPath({
      env: { MOSS_HOME: runtimeHome },
      homePath: sourceHome,
      accountId: "byok",
    });
    const accountsDirectory = path.dirname(overlayPath);
    const legacyOverlay = path.join(accountsDirectory, "byok-000000000000");
    const invalidSibling = path.join(accountsDirectory, "byok-not-owned");
    const otherAccount = path.join(accountsDirectory, "moss-111111111111");

    const result = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of [overlayPath, legacyOverlay, invalidSibling, otherAccount]) {
        yield* fs.makeDirectory(directory, { recursive: true });
        yield* fs.writeFileString(path.join(directory, "sentinel"), "test-only");
      }
      yield* removeMossCodexAccountOverlayFamily(fs, {
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "byok",
      });
      return {
        currentExists: yield* fs.exists(overlayPath),
        legacyExists: yield* fs.exists(legacyOverlay),
        invalidSiblingExists: yield* fs.exists(invalidSibling),
        otherAccountExists: yield* fs.exists(otherAccount),
      };
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

    expect(result).toEqual({
      currentExists: false,
      legacyExists: false,
      invalidSiblingExists: true,
      otherAccountExists: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "fails closed when managed-style exact cleanup finds a symbolic overlay root",
    async () => {
      const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-exact-root-link-"));
      testRoots.push(runtimeHome);
      const sourceHome = path.join(runtimeHome, "managed-source-home");
      const overlayPath = resolveMossCodexAccountOverlayPath({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "moss",
      });
      const overlayRoot = path.dirname(path.dirname(overlayPath));
      const externalOverlayRoot = path.join(runtimeHome, "external-overlay-root");
      const externalOverlay = path.join(
        externalOverlayRoot,
        "accounts",
        path.basename(overlayPath),
      );

      const result = await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(externalOverlay, { recursive: true });
        yield* fs.writeFileString(path.join(externalOverlay, "sentinel"), "must-survive");
        yield* Effect.sync(() => symlinkSync(externalOverlayRoot, overlayRoot, "dir"));
        const failure = yield* removeMossCodexAccountOverlay(fs, {
          env: { MOSS_HOME: runtimeHome },
          homePath: sourceHome,
          accountId: "moss",
        }).pipe(Effect.flip);
        return {
          failure,
          externalSentinelExists: yield* fs.exists(path.join(externalOverlay, "sentinel")),
        };
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

      expect(result.failure).toBeInstanceOf(Error);
      expect(String(result.failure)).toMatch(/overlay root.*symbolic link/i);
      expect(result.externalSentinelExists).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when managed-style exact cleanup finds a symbolic accounts directory",
    async () => {
      const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-exact-accounts-link-"));
      testRoots.push(runtimeHome);
      const sourceHome = path.join(runtimeHome, "managed-source-home");
      const overlayPath = resolveMossCodexAccountOverlayPath({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "moss",
      });
      const accountsDirectory = path.dirname(overlayPath);
      const overlayRoot = path.dirname(accountsDirectory);
      const externalAccounts = path.join(runtimeHome, "external-accounts");
      const externalOverlay = path.join(externalAccounts, path.basename(overlayPath));

      const result = await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(overlayRoot, { recursive: true });
        yield* fs.makeDirectory(externalOverlay, { recursive: true });
        yield* fs.writeFileString(path.join(externalOverlay, "sentinel"), "must-survive");
        yield* Effect.sync(() => symlinkSync(externalAccounts, accountsDirectory, "dir"));
        const failure = yield* removeMossCodexAccountOverlay(fs, {
          env: { MOSS_HOME: runtimeHome },
          homePath: sourceHome,
          accountId: "moss",
        }).pipe(Effect.flip);
        return {
          failure,
          externalSentinelExists: yield* fs.exists(path.join(externalOverlay, "sentinel")),
        };
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

      expect(result.failure).toBeInstanceOf(Error);
      expect(String(result.failure)).toMatch(/accounts directory.*symbolic link/i);
      expect(result.externalSentinelExists).toBe(true);
    },
  );

  it.runIf(process.platform !== "win32")(
    "fails closed when managed-style exact cleanup finds a symbolic account entry",
    async () => {
      const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-exact-entry-link-"));
      testRoots.push(runtimeHome);
      const sourceHome = path.join(runtimeHome, "managed-source-home");
      const overlayPath = resolveMossCodexAccountOverlayPath({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "moss",
      });
      const accountsDirectory = path.dirname(overlayPath);
      const externalOverlay = path.join(runtimeHome, "external-account-overlay");

      const result = await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(accountsDirectory, { recursive: true });
        yield* fs.makeDirectory(externalOverlay, { recursive: true });
        yield* fs.writeFileString(path.join(externalOverlay, "sentinel"), "must-survive");
        yield* Effect.sync(() => symlinkSync(externalOverlay, overlayPath, "dir"));
        const failure = yield* removeMossCodexAccountOverlay(fs, {
          env: { MOSS_HOME: runtimeHome },
          homePath: sourceHome,
          accountId: "moss",
        }).pipe(Effect.flip);
        return {
          failure,
          externalSentinelExists: yield* fs.exists(path.join(externalOverlay, "sentinel")),
        };
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

      expect(result.failure).toBeInstanceOf(Error);
      expect(String(result.failure)).toMatch(/account overlay.*symbolic link/i);
      expect(result.externalSentinelExists).toBe(true);
    },
  );

  it("removes only shell snapshots from exact reserved-account overlays", async () => {
    const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-snapshot-family-"));
    testRoots.push(runtimeHome);
    const sourceHome = path.join(runtimeHome, "source-home");
    const overlayPath = resolveMossCodexAccountOverlayPath({
      env: { MOSS_HOME: runtimeHome },
      homePath: sourceHome,
      accountId: "byok",
    });
    const accountsDirectory = path.dirname(overlayPath);
    const legacyOverlay = path.join(accountsDirectory, "byok-000000000000");
    const invalidSibling = path.join(accountsDirectory, "byok-not-owned");
    const otherAccount = path.join(accountsDirectory, "moss-111111111111");

    const result = await Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      for (const directory of [overlayPath, legacyOverlay, invalidSibling, otherAccount]) {
        yield* fs.makeDirectory(path.join(directory, "shell_snapshots"), { recursive: true });
        yield* fs.makeDirectory(path.join(directory, "sessions"), { recursive: true });
        yield* fs.writeFileString(
          path.join(directory, "shell_snapshots", "snapshot.sh"),
          "test-only",
        );
        yield* fs.writeFileString(path.join(directory, "sessions", "history.jsonl"), "test-only");
      }
      yield* removeMossCodexAccountShellSnapshotsFamily(fs, {
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "byok",
      });
      return {
        currentSnapshotExists: yield* fs.exists(path.join(overlayPath, "shell_snapshots")),
        legacySnapshotExists: yield* fs.exists(path.join(legacyOverlay, "shell_snapshots")),
        invalidSnapshotExists: yield* fs.exists(path.join(invalidSibling, "shell_snapshots")),
        otherSnapshotExists: yield* fs.exists(path.join(otherAccount, "shell_snapshots")),
        currentHistoryExists: yield* fs.exists(path.join(overlayPath, "sessions", "history.jsonl")),
        legacyHistoryExists: yield* fs.exists(
          path.join(legacyOverlay, "sessions", "history.jsonl"),
        ),
      };
    }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

    expect(result).toEqual({
      currentSnapshotExists: false,
      legacySnapshotExists: false,
      invalidSnapshotExists: true,
      otherSnapshotExists: true,
      currentHistoryExists: true,
      legacyHistoryExists: true,
    });
  });

  it.runIf(process.platform !== "win32")(
    "fails closed instead of following a shell snapshots symbolic link",
    async () => {
      const runtimeHome = mkdtempSync(path.join(tmpdir(), "moss-account-snapshot-symlink-"));
      testRoots.push(runtimeHome);
      const sourceHome = path.join(runtimeHome, "source-home");
      const overlayPath = resolveMossCodexAccountOverlayPath({
        env: { MOSS_HOME: runtimeHome },
        homePath: sourceHome,
        accountId: "byok",
      });
      const externalSnapshots = path.join(runtimeHome, "external-snapshots");

      const result = await Effect.gen(function* () {
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(overlayPath, { recursive: true });
        yield* fs.makeDirectory(externalSnapshots, { recursive: true });
        yield* fs.writeFileString(path.join(externalSnapshots, "sentinel"), "must-survive");
        yield* Effect.sync(() =>
          symlinkSync(externalSnapshots, path.join(overlayPath, "shell_snapshots"), "dir"),
        );
        const failure = yield* removeMossCodexAccountShellSnapshotsFamily(fs, {
          env: { MOSS_HOME: runtimeHome },
          homePath: sourceHome,
          accountId: "byok",
        }).pipe(Effect.flip);
        return {
          failure,
          externalSentinelExists: yield* fs.exists(path.join(externalSnapshots, "sentinel")),
        };
      }).pipe(Effect.provide(NodeServices.layer), Effect.runPromise);

      expect(result.failure).toBeInstanceOf(Error);
      expect(String(result.failure)).toMatch(/symbolic link/i);
      expect(result.externalSentinelExists).toBe(true);
    },
  );
});
