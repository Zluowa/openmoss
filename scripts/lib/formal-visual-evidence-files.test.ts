// FILE: formal-visual-evidence-files.test.ts
// Purpose: Proves formal visual evidence files are private, non-symbolic, and frozen against swaps.
// Layer: Release verification filesystem tests

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { createServer } from "node:net";
import {
  chmodSync,
  existsSync,
  linkSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  renameSync,
  statSync,
  unlinkSync,
  utimesSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { Worker } from "node:worker_threads";
import { describe, expect, it } from "vitest";
import { createDirectoryAlias, createRejectedFileAlias } from "../fixtures/filesystem-links.ts";

// These cases exercise the real descriptor-relative native publication boundary.
const nativePublicationTest = it.runIf(
  process.platform === "darwin" || process.platform === "linux",
);

import { compileFormalVisualDirectoryNativeForTest } from "./formal-visual-directory-native";
import {
  EvidenceDirectoryPublicationDurabilityError,
  EvidenceDirectoryPublicationRecoveryError,
  assertFrozenEvidenceFile,
  assertPublishedPrivateEvidenceDirectory,
  ensurePrivateEvidenceDirectory,
  evidenceDirectoryPublicationCommittedJournalPath,
  evidenceDirectoryPublicationPendingJournalPath,
  evidenceDirectoryPublicationReceiptPath,
  freezeEvidenceFile,
  publishGeneratedPrivateEvidenceFile,
  publishPrivateEvidenceDirectory,
  publishPrivateEvidenceFile,
  resolveEvidenceFile,
} from "./formal-visual-evidence-files";

const POSIX_MODES = process.platform !== "win32";
const REAL_TMPDIR = realpathSync(tmpdir());
const NATIVE_SOURCE_PATH = fileURLToPath(
  new URL("./formal-visual-directory-native.c", import.meta.url),
);

function privateRoot(prefix: string): string {
  const root = mkdtempSync(join(REAL_TMPDIR, prefix));
  ensurePrivateEvidenceDirectory(root);
  return root;
}

describe("formal visual evidence filesystem boundary", () => {
  it("resets errno for every native readdir attempt before interpreting EOF", () => {
    const source = readFileSync(NATIVE_SOURCE_PATH, "utf8");

    expect(source).toMatch(
      /for \(;;\) \{[\s\S]*?errno = 0;[\s\S]*?entry = readdir\(directory\);[\s\S]*?if \(entry == NULL\) \{[\s\S]*?read_errno = errno;[\s\S]*?break;/u,
    );
  });

  nativePublicationTest(
    "forces run directories to 0700 and exclusively publishes 0600 files",
    () => {
      const root = privateRoot("moss-formal-private-");
      chmodSync(root, 0o755);
      ensurePrivateEvidenceDirectory(root);

      const frozen = publishPrivateEvidenceFile(root, "receipt.json", '{"ok":true}\n');

      if (POSIX_MODES) {
        expect(statSync(root).mode & 0o777).toBe(0o700);
        expect(statSync(frozen.path).mode & 0o777).toBe(0o600);
      }
      expect(() => publishPrivateEvidenceFile(root, "receipt.json", "replacement\n")).toThrow(
        /already exists|exclusive/iu,
      );
    },
  );

  it("rejects traversal and symbolic parent directories inside the run root", () => {
    const root = privateRoot("moss-formal-path-");
    const outside = privateRoot("moss-formal-outside-");
    writeFileSync(join(outside, "capture.png"), "pixels", { mode: 0o600 });
    createDirectoryAlias(outside, join(root, "linked"));

    expect(() => resolveEvidenceFile(root, "../capture.png", "capture")).toThrow(
      /capture-relative|escapes/iu,
    );
    expect(() => resolveEvidenceFile(root, "linked/capture.png", "capture")).toThrow(
      /symbolic parent/iu,
    );
  });

  it("refuses to create an output directory through a symbolic parent", () => {
    const root = privateRoot("moss-formal-output-parent-");
    const outside = privateRoot("moss-formal-output-outside-");
    createDirectoryAlias(outside, join(root, "linked"));

    expect(() => ensurePrivateEvidenceDirectory(join(root, "linked", "run"))).toThrow(
      /symbolic ancestor|symbolic parent/iu,
    );
    expect(existsSync(join(outside, "run"))).toBe(false);
  });

  it("rejects symbolic ancestors for existing output directories and evidence files", () => {
    const root = privateRoot("moss-formal-existing-parent-");
    const outside = privateRoot("moss-formal-existing-outside-");
    const existing = join(outside, "existing");
    mkdirSync(existing, { mode: 0o700 });
    writeFileSync(join(existing, "capture.png"), "pixels", { mode: 0o600 });
    createDirectoryAlias(outside, join(root, "linked"));

    expect(() => ensurePrivateEvidenceDirectory(join(root, "linked", "existing"))).toThrow(
      /symbolic ancestor|symbolic parent/iu,
    );
    expect(() =>
      freezeEvidenceFile(join(root, "linked", "existing", "capture.png"), "linked capture"),
    ).toThrow(/symbolic ancestor|symbolic parent/iu);
    expect(() =>
      resolveEvidenceFile(join(root, "linked", "existing"), "capture.png", "linked capture"),
    ).toThrow(/symbolic ancestor|symbolic parent/iu);
  });

  it("rejects symlinks, hardlinks, and non-regular files", async () => {
    const root = privateRoot("moss-formal-kinds-");
    const original = join(root, "original.json");
    writeFileSync(original, "{}\n", { mode: 0o600 });

    createRejectedFileAlias(original, join(root, "symbolic.json"));
    expect(() => freezeEvidenceFile(join(root, "symbolic.json"), "symbolic evidence")).toThrow(
      /symbolic|regular file/iu,
    );

    linkSync(original, join(root, "hardlinked.json"));
    expect(() => freezeEvidenceFile(original, "hardlinked evidence")).toThrow(/hardlink/iu);

    if (process.platform !== "win32") {
      const fifo = join(root, "named-pipe");
      const result = spawnSync("mkfifo", [fifo]);
      expect(result.status).toBe(0);
      expect(() => freezeEvidenceFile(fifo, "fifo evidence")).toThrow(/regular file/iu);
      expect(() => freezeEvidenceFile("/dev/null", "device evidence")).toThrow(/regular file/iu);

      const socket = join(root, "unix-socket");
      const server = createServer();
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(socket, resolve);
      });
      try {
        expect(() => freezeEvidenceFile(socket, "socket evidence")).toThrow(/regular file/iu);
      } finally {
        await new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        });
      }
    }
  });

  it("detects an inode swap even when replacement bytes and timestamps match", () => {
    const root = privateRoot("moss-formal-frozen-");
    const path = join(root, "capture.png");
    writeFileSync(path, "same bytes\n", { mode: 0o600 });
    const frozen = freezeEvidenceFile(path, "capture", { requirePrivateMode: true });
    const original = statSync(path, { bigint: true });
    const replacement = join(root, "replacement.png");
    writeFileSync(replacement, "same bytes\n", { mode: 0o600 });
    // Preserve the original timestamp so dev/ino binding, not only size/mtime/hash, catches the swap.
    const seconds = Number(original.mtimeNs) / 1_000_000_000;
    utimesSync(replacement, seconds, seconds);
    renameSync(replacement, path);

    expect(() => assertFrozenEvidenceFile(frozen)).toThrow(/changed after it was frozen/iu);
  });

  it("detects content mutation at a later consumption point", () => {
    const root = privateRoot("moss-formal-mutated-");
    const path = join(root, "metrics.json");
    writeFileSync(path, '{"value":1}\n', { mode: 0o600 });
    const frozen = freezeEvidenceFile(path, "metrics", { requirePrivateMode: true });
    unlinkSync(path);
    writeFileSync(path, '{"value":2}\n', { mode: 0o600 });

    expect(() => assertFrozenEvidenceFile(frozen)).toThrow(/changed after it was frozen/iu);
  });

  nativePublicationTest(
    "uses an atomic no-replace link when a target appears at the publication boundary",
    () => {
      const root = privateRoot("moss-formal-exclusive-link-");
      const targetPath = join(root, "receipt.json");

      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
          beforeExclusiveLink() {
            writeFileSync(targetPath, "racing publisher\n", { mode: 0o600 });
          },
        }),
      ).toThrow(/already exists|exclusive/iu);
      expect(readFileSync(targetPath, "utf8")).toBe("racing publisher\n");
      expect(readdirSync(root).filter((file) => file.includes(".tmp"))).toEqual([]);
    },
  );

  nativePublicationTest("fsyncs the immediate parent twice after exclusive publication", () => {
    const root = privateRoot("moss-formal-parent-fsync-");
    const syncedDirectories: string[] = [];

    publishPrivateEvidenceFile(root, "receipt.json", "durable\n", {
      afterParentDirectoryFsync(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([root, root]);
  });

  nativePublicationTest("fsyncs the immediate parent of a nested publication", () => {
    const root = privateRoot("moss-formal-nested-parent-fsync-");
    const nested = join(root, "nested");
    mkdirSync(nested, { mode: 0o700 });
    const syncedDirectories: string[] = [];

    publishPrivateEvidenceFile(root, "nested/receipt.json", "durable\n", {
      afterParentDirectoryFsync(path) {
        syncedDirectories.push(path);
      },
    });

    expect(syncedDirectories).toEqual([nested, nested]);
  });

  nativePublicationTest(
    "never redirects concurrent same-process Worker relative I/O into the evidence parent",
    () => {
      const originalCwd = process.cwd();
      const cwd = privateRoot("moss-formal-cwd-isolation-");
      const root = join(cwd, "evidence");
      mkdirSync(root, { mode: 0o700 });
      const signal = new SharedArrayBuffer(Int32Array.BYTES_PER_ELEMENT);
      const state = new Int32Array(signal);

      process.chdir(cwd);
      try {
        publishPrivateEvidenceFile(root, "receipt.json", "bound mutation\n", {
          aroundExclusiveLink(publish) {
            const worker = new Worker(
              `
              const { writeFileSync } = require("node:fs");
              const { workerData } = require("node:worker_threads");
              writeFileSync("worker-relative.txt", "worker stayed in caller cwd\\n");
              const state = new Int32Array(workerData);
              Atomics.store(state, 0, 1);
              Atomics.notify(state, 0);
            `,
              { eval: true, workerData: signal },
            );
            expect(Atomics.wait(state, 0, 0, 5_000)).toBe("ok");
            publish();
            void worker.terminate();
          },
        });
      } finally {
        process.chdir(originalCwd);
      }

      expect(readFileSync(join(cwd, "worker-relative.txt"), "utf8")).toBe(
        "worker stayed in caller cwd\n",
      );
      expect(existsSync(join(root, "worker-relative.txt"))).toBe(false);
    },
  );

  nativePublicationTest(
    "generates exact bytes without accumulating quarantine directories on success or failure",
    () => {
      const root = privateRoot("moss-formal-generated-bytes-");
      const quarantinePrefix = "moss-formal-evidence-quarantine-";
      const countQuarantines = () =>
        readdirSync(REAL_TMPDIR).filter((entry) => entry.startsWith(quarantinePrefix)).length;
      const before = countQuarantines();

      publishGeneratedPrivateEvidenceFile(root, "receipt.json", () =>
        Buffer.from("generated bytes\n"),
      );
      expect(readFileSync(join(root, "receipt.json"), "utf8")).toBe("generated bytes\n");
      expect(countQuarantines()).toBe(before);

      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "failure.json", () => {
          throw new Error("injected generator failure");
        }),
      ).toThrow(/injected generator failure/iu);
      expect(countQuarantines()).toBe(before);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "ignores malicious CC/PATH programs and leaves no native build directory",
    () => {
      const root = privateRoot("moss-formal-native-env-");
      const marker = join(root, "untrusted-tool-ran");
      const fakeCompiler = join(root, "cc");
      const fakeNode = join(root, "node");
      writeFileSync(fakeCompiler, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 91\n`, {
        mode: 0o700,
      });
      writeFileSync(fakeNode, `#!/bin/sh\ntouch ${JSON.stringify(marker)}\nexit 92\n`, {
        mode: 0o700,
      });
      let buildDirectory = "";
      const originalCc = process.env.CC;
      const originalPath = process.env.PATH;
      process.env.CC = fakeCompiler;
      process.env.PATH = root;
      try {
        compileFormalVisualDirectoryNativeForTest({
          onBuildDirectory(path) {
            buildDirectory = path;
          },
        });
      } finally {
        if (originalCc === undefined) delete process.env.CC;
        else process.env.CC = originalCc;
        if (originalPath === undefined) delete process.env.PATH;
        else process.env.PATH = originalPath;
      }
      expect(existsSync(marker)).toBe(false);
      expect(buildDirectory).not.toBe("");
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "compiles the hashed private source snapshot even if the original is replaced",
    () => {
      const root = privateRoot("moss-formal-native-source-snapshot-");
      const mutableSource = join(root, "mutable-native-source.c");
      const sourceBytes = readFileSync(NATIVE_SOURCE_PATH);
      const sourceHash = createHash("sha256").update(sourceBytes).digest("hex").slice(0, 16);
      writeFileSync(mutableSource, sourceBytes, { mode: 0o600 });
      let buildDirectory = "";

      compileFormalVisualDirectoryNativeForTest({
        sourcePath: mutableSource,
        onBuildDirectory(path) {
          buildDirectory = path;
        },
        afterSourceSnapshot() {
          writeFileSync(mutableSource, "this replacement is deliberately not valid C\n");
        },
      });

      expect(readFileSync(mutableSource, "utf8")).toMatch(/not valid C/iu);
      expect(buildDirectory).not.toBe("");
      expect(buildDirectory).toContain(`moss-formal-native-${sourceHash}-`);
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "rejects a changed private source snapshot and removes the exact build directory",
    () => {
      let buildDirectory = "";

      expect(() =>
        compileFormalVisualDirectoryNativeForTest({
          onBuildDirectory(path) {
            buildDirectory = path;
          },
          afterSourceSnapshot() {
            writeFileSync(
              join(buildDirectory, "formal-visual-directory-native.c"),
              "tampered private snapshot\n",
            );
          },
        }),
      ).toThrow(/source snapshot changed/iu);
      expect(buildDirectory).not.toBe("");
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "removes the native build directory when an early observer fails",
    () => {
      let buildDirectory = "";

      expect(() =>
        compileFormalVisualDirectoryNativeForTest({
          onBuildDirectory(path) {
            buildDirectory = path;
            throw new Error("injected native build observer failure");
          },
        }),
      ).toThrow(/injected native build observer failure/iu);
      expect(buildDirectory).not.toBe("");
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "cleans every native snapshot when compilation fails",
    () => {
      let buildDirectory = "";

      expect(() =>
        compileFormalVisualDirectoryNativeForTest({
          compilerPath: "/usr/bin/false",
          onBuildDirectory(path) {
            buildDirectory = path;
          },
        }),
      ).toThrow(/unable to compile/iu);
      expect(buildDirectory).not.toBe("");
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "loads the audited addon descriptor when its pathname is replaced before dlopen",
    () => {
      let buildDirectory = "";
      let displacedAddon = "";
      let replacementObserved = false;

      compileFormalVisualDirectoryNativeForTest({
        onBuildDirectory(path) {
          buildDirectory = path;
        },
        beforeAddonLoad(path) {
          replacementObserved = true;
          displacedAddon = `${path}.audited`;
          renameSync(path, displacedAddon);
          writeFileSync(path, "not a native addon\n", { mode: 0o700 });
        },
        afterAddonLoadAttempt(path) {
          unlinkSync(path);
          renameSync(displacedAddon, path);
        },
      });

      expect(replacementObserved).toBe(true);
      expect(buildDirectory).not.toBe("");
      expect(existsSync(buildDirectory)).toBe(false);
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "fails closed on a stale canonical target without a receipt and never overwrites it",
    () => {
      const parent = privateRoot("moss-formal-directory-exposure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      mkdirSync(staging, { mode: 0o700 });
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(staging, "owned.txt"), "owned staging\n", { mode: 0o600 });
      writeFileSync(join(target, "racing.txt"), "racing target\n", { mode: 0o600 });

      expect(() => publishPrivateEvidenceDirectory(staging, target)).toThrow(
        /already exists.*without a publication receipt|stale output.*quarantined/iu,
      );
      expect(readFileSync(join(staging, "owned.txt"), "utf8")).toBe("owned staging\n");
      expect(readFileSync(join(target, "racing.txt"), "utf8")).toBe("racing target\n");
      expect(existsSync(evidenceDirectoryPublicationReceiptPath(target))).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "refuses a swapped staging entry while retaining the verified directory descriptor",
    () => {
      const parent = privateRoot("moss-formal-directory-source-swap-");
      const staging = join(parent, ".capture.staging-owned");
      const displaced = join(parent, ".capture.staging-displaced");
      const target = join(parent, "capture");
      let rejected = "";
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "owned.txt"), "verified staging\n", { mode: 0o600 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      expect(() =>
        publishPrivateEvidenceDirectory(staging, target, {
          afterNativeSourcePrecheck({ rejectedPath }) {
            rejected = rejectedPath;
            renameSync(staging, displaced);
            mkdirSync(staging, { mode: 0o700 });
            writeFileSync(join(staging, "replacement.txt"), "unverified replacement\n", {
              mode: 0o600,
            });
          },
        }),
      ).toThrow(/changed|identity|verified source/iu);

      expect(existsSync(target)).toBe(false);
      expect(readFileSync(join(displaced, "owned.txt"), "utf8")).toBe("verified staging\n");
      expect(rejected).not.toBe("");
      expect(readFileSync(join(rejected, "replacement.txt"), "utf8")).toBe(
        "unverified replacement\n",
      );
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /unavailable|publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "leaves an unquarantinable swapped source ineligible for every formal consumer",
    () => {
      const parent = privateRoot("moss-formal-directory-source-swap-blocked-quarantine-");
      const staging = join(parent, ".capture.staging-owned");
      const displaced = join(parent, ".capture.staging-displaced");
      const target = join(parent, "capture");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "owned.txt"), "verified staging\n", { mode: 0o600 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      expect(() =>
        publishPrivateEvidenceDirectory(staging, target, {
          afterNativeSourcePrecheck({ rejectedPath }) {
            mkdirSync(rejectedPath, { mode: 0o700 });
            renameSync(staging, displaced);
            mkdirSync(staging, { mode: 0o700 });
            writeFileSync(join(staging, "replacement.txt"), "unverified replacement\n", {
              mode: 0o600,
            });
          },
        }),
      ).toThrow(/changed|identity|unquarantined|publication receipt/iu);

      expect(existsSync(target)).toBe(true);
      expect(readFileSync(join(target, "replacement.txt"), "utf8")).toBe(
        "unverified replacement\n",
      );
      expect(existsSync(evidenceDirectoryPublicationReceiptPath(target))).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "fsyncs the verified parent after the directory rename commits",
    () => {
      const parent = privateRoot("moss-formal-directory-post-rename-fsync-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const events: string[] = [];
      let pendingJournalIdentity: { readonly dev: bigint; readonly ino: bigint } | undefined;
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "owned.txt"), "durable staging\n", { mode: 0o600 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      publishPrivateEvidenceDirectory(staging, target, {
        afterPublicationPendingJournalParentFsync(path) {
          const metadata = statSync(path, { bigint: true });
          pendingJournalIdentity = { dev: metadata.dev, ino: metadata.ino };
          events.push("pending-journal-durable");
        },
        afterVerifiedRename(path) {
          expect(path).toBe(target);
          expect(readFileSync(join(target, "owned.txt"), "utf8")).toBe("durable staging\n");
          events.push("renamed");
        },
        afterPostRenameParentFsync(path) {
          expect(path).toBe(parent);
          expect(existsSync(target)).toBe(true);
          events.push("parent-fsynced");
        },
      });

      expect(events).toEqual(["pending-journal-durable", "renamed", "parent-fsynced"]);
      expect(assertPublishedPrivateEvidenceDirectory(target)).toBe(target);
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(target);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(evidenceDirectoryPublicationPendingJournalPath(target))).toBe(false);
      expect(existsSync(committedJournalPath)).toBe(true);
      expect(pendingJournalIdentity).toBeDefined();
      const committedJournalIdentity = statSync(committedJournalPath, { bigint: true });
      expect([committedJournalIdentity.dev, committedJournalIdentity.ino]).toEqual([
        pendingJournalIdentity?.dev,
        pendingJournalIdentity?.ino,
      ]);
      expect(JSON.parse(readFileSync(committedJournalPath, "utf8"))).toMatchObject({
        schema: "moss.formal-evidence-directory-publication-journal",
        schemaVersion: 1,
        targetName: "capture",
        receiptSha256: createHash("sha256").update(readFileSync(receiptPath)).digest("hex"),
      });

      writeFileSync(evidenceDirectoryPublicationPendingJournalPath(target), "occupied pending\n", {
        mode: 0o600,
      });
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /pending transaction|publication journal/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "binds the receipt to the target inode, manifest, and complete evidence tree",
    () => {
      const parent = privateRoot("moss-formal-directory-receipt-binding-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });
      writeFileSync(join(staging, "owned.txt"), "bound evidence\n", { mode: 0o600 });
      mkdirSync(join(staging, "nested"), { mode: 0o700 });
      writeFileSync(join(staging, "nested", "proof.json"), '{"proof":true}\n', { mode: 0o600 });

      publishPrivateEvidenceDirectory(staging, target);
      const receipt = JSON.parse(
        readFileSync(evidenceDirectoryPublicationReceiptPath(target), "utf8"),
      ) as Record<string, unknown>;
      expect(receipt).toMatchObject({
        schema: "moss.formal-evidence-directory-publication-receipt",
        schemaVersion: 1,
        targetName: "capture",
        manifest: { file: "formal-capture-manifest.json" },
        evidence: { algorithm: "sha256-tree-v1", fileCount: 3, directoryCount: 2 },
      });
      expect(assertPublishedPrivateEvidenceDirectory(target)).toBe(target);

      const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(target);
      const committedJournalBytes = readFileSync(committedJournalPath);
      const forgedJournal = JSON.parse(committedJournalBytes.toString("utf8")) as Record<
        string,
        unknown
      >;
      forgedJournal.receiptSha256 = "0".repeat(64);
      writeFileSync(committedJournalPath, `${JSON.stringify(forgedJournal, null, 2)}\n`);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /journal.*receipt|receipt.*journal/iu,
      );
      writeFileSync(committedJournalPath, committedJournalBytes);
      expect(assertPublishedPrivateEvidenceDirectory(target)).toBe(target);

      writeFileSync(join(target, "owned.txt"), "bound evidencf\n");
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /does not match|evidence tree/iu,
      );

      writeFileSync(join(target, "owned.txt"), "bound evidence\n");
      const displaced = join(parent, ".capture.displaced");
      renameSync(target, displaced);
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });
      writeFileSync(join(target, "owned.txt"), "bound evidence\n", { mode: 0o600 });
      mkdirSync(join(target, "nested"), { mode: 0o700 });
      writeFileSync(join(target, "nested", "proof.json"), '{"proof":true}\n', { mode: 0o600 });
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /does not match|target identity/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "keeps crash recovery fail closed when the committed-journal parent fsync fails",
    () => {
      const parent = privateRoot("moss-formal-directory-journal-fsync-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const pendingJournalPath = evidenceDirectoryPublicationPendingJournalPath(target);
      const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(target);
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          injectPostCommittedJournalParentFsyncFailure(context) {
            expect(context.pendingJournalPath).toBe(pendingJournalPath);
            expect(context.committedJournalPath).toBe(committedJournalPath);
            expect(existsSync(pendingJournalPath)).toBe(false);
            expect(existsSync(committedJournalPath)).toBe(true);
            const cause = new Error(
              "injected committed-journal parent fsync EIO",
            ) as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(Error);
      expect(String(failure)).toMatch(/committed publication journal durability.*unconfirmed/iu);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(pendingJournalPath)).toBe(false);
      expect(existsSync(committedJournalPath)).toBe(true);

      // C-only is a safe recovery choice because target and receipt crossed their durability
      // boundaries before promotion. If reboot instead restores the last durable PENDING name,
      // a fresh consumer must reject the same canonical pair.
      expect(assertPublishedPrivateEvidenceDirectory(target)).toBe(target);
      renameSync(committedJournalPath, pendingJournalPath);
      expect(existsSync(pendingJournalPath)).toBe(true);
      expect(existsSync(committedJournalPath)).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /pending transaction|publication journal/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "withholds the receipt when the durable canonical name no longer binds the opened target",
    () => {
      const parent = privateRoot("moss-formal-directory-post-fsync-target-swap-");
      const staging = join(parent, ".capture.staging-owned");
      const displaced = join(parent, ".capture.displaced");
      const target = join(parent, "capture");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      expect(() =>
        publishPrivateEvidenceDirectory(staging, target, {
          afterPostRenameParentFsync() {
            renameSync(target, displaced);
            mkdirSync(target, { mode: 0o700 });
            writeFileSync(join(target, "formal-capture-manifest.json"), '{"replacement":true}\n', {
              mode: 0o600,
            });
          },
        }),
      ).toThrow(/changed after its durable rename|no publication receipt/iu);

      expect(existsSync(evidenceDirectoryPublicationReceiptPath(target))).toBe(false);
      expect(existsSync(displaced)).toBe(true);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "reports a committed directory with unconfirmed durability and withholds its receipt",
    () => {
      const parent = privateRoot("moss-formal-directory-fsync-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          injectPostRenameParentFsyncFailure() {
            const cause = new Error("injected parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(String(failure)).toMatch(/publication durability.*unconfirmed.*fail closed/iu);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(staging)).toBe(false);
      expect(existsSync(evidenceDirectoryPublicationReceiptPath(target))).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "durably quarantines a canonical receipt after its parent fsync fails",
    () => {
      const parent = privateRoot("moss-formal-directory-receipt-fsync-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const events: string[] = [];
      let receiptQuarantinePath = "";
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          afterReceiptVerifiedRename(path) {
            expect(path).toBe(receiptPath);
            expect(existsSync(path)).toBe(true);
            events.push("receipt-renamed");
          },
          injectPostReceiptParentFsyncFailure(context) {
            expect(context.receiptPath).toBe(receiptPath);
            receiptQuarantinePath = context.receiptQuarantinePath;
            events.push("receipt-fsync-failed");
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterReceiptFailureCleanup(context) {
            expect(context.method).toBe("receipt-quarantine");
            expect(context.receiptPath).toBe(receiptPath);
            expect(context.receiptQuarantinePath).toBe(receiptQuarantinePath);
            expect(existsSync(receiptPath)).toBe(false);
            expect(existsSync(receiptQuarantinePath)).toBe(true);
            expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
              /publication receipt/iu,
            );
            events.push("receipt-quarantined");
          },
          afterReceiptFailureCleanupParentFsync(path) {
            expect(path).toBe(parent);
            events.push("cleanup-parent-fsynced");
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(events).toEqual([
        "receipt-renamed",
        "receipt-fsync-failed",
        "receipt-quarantined",
        "cleanup-parent-fsynced",
      ]);
      expect(existsSync(receiptPath)).toBe(false);
      expect(existsSync(receiptQuarantinePath)).toBe(true);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "quarantines the canonical target when receipt quarantine fails and durably rejects consumption",
    () => {
      const parent = privateRoot("moss-formal-directory-receipt-quarantine-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const events: string[] = [];
      let blockedQuarantinePath = "";
      let targetQuarantinePath = "";
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          injectPostReceiptParentFsyncFailure() {
            events.push("receipt-fsync-failed");
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterNativeReceiptFailureQuarantinePrecheck(context) {
            blockedQuarantinePath = context.receiptQuarantinePath;
            writeFileSync(blockedQuarantinePath, "occupied quarantine\n", { mode: 0o600 });
          },
          afterReceiptFailureCleanup(context) {
            expect(context.method).toBe("target-quarantine");
            targetQuarantinePath = context.targetQuarantinePath;
            expect(existsSync(receiptPath)).toBe(true);
            expect(existsSync(target)).toBe(false);
            expect(existsSync(targetQuarantinePath)).toBe(true);
            expect(readFileSync(blockedQuarantinePath, "utf8")).toBe("occupied quarantine\n");
            expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
              /unavailable|publication receipt/iu,
            );
            events.push("target-quarantined");
          },
          afterReceiptFailureCleanupParentFsync() {
            events.push("cleanup-parent-fsynced");
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(events).toEqual([
        "receipt-fsync-failed",
        "target-quarantined",
        "cleanup-parent-fsynced",
      ]);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(targetQuarantinePath)).toBe(true);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /unavailable|publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "preserves a replaced receipt in rejection quarantine and falls back to target quarantine",
    () => {
      const parent = privateRoot("moss-formal-directory-replaced-receipt-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const displacedReceipt = join(parent, ".publication-receipt-displaced");
      let rejectedReplacementPath = "";
      let targetQuarantinePath = "";
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          injectPostReceiptParentFsyncFailure() {
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterNativeReceiptFailureQuarantinePrecheck(context) {
            rejectedReplacementPath = context.rejectedPath;
            renameSync(receiptPath, displacedReceipt);
            writeFileSync(receiptPath, "unowned replacement receipt\n", { mode: 0o600 });
          },
          afterReceiptFailureCleanup(context) {
            expect(context.method).toBe("target-quarantine");
            targetQuarantinePath = context.targetQuarantinePath;
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(receiptPath)).toBe(false);
      expect(existsSync(targetQuarantinePath)).toBe(true);
      expect(readFileSync(displacedReceipt, "utf8")).toMatch(
        /moss\.formal-evidence-directory-publication-receipt/u,
      );
      expect(readFileSync(rejectedReplacementPath, "utf8")).toBe("unowned replacement receipt\n");
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /unavailable|publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "rejects consumption through a durable pending journal when both quarantines fail",
    () => {
      const parent = privateRoot("moss-formal-directory-double-quarantine-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const pendingJournalPath = evidenceDirectoryPublicationPendingJournalPath(target);
      const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(target);
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          injectPostReceiptParentFsyncFailure() {
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterNativeReceiptFailureQuarantinePrecheck(context) {
            writeFileSync(context.receiptQuarantinePath, "occupied receipt quarantine\n", {
              mode: 0o600,
            });
          },
          afterNativeTargetFailureQuarantinePrecheck(context) {
            mkdirSync(context.targetQuarantinePath, { mode: 0o700 });
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationRecoveryError);
      expect(String(failure)).toMatch(/unrecoverable.*journal eligibility.*explicit quarantine/iu);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(receiptPath)).toBe(true);
      expect(existsSync(pendingJournalPath)).toBe(true);
      expect(existsSync(committedJournalPath)).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /pending transaction|publication journal/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "stays rejected after both cleanup fsyncs fail and a reboot restores both canonical names",
    () => {
      const parent = privateRoot("moss-formal-directory-double-cleanup-fsync-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const pendingJournalPath = evidenceDirectoryPublicationPendingJournalPath(target);
      const committedJournalPath = evidenceDirectoryPublicationCommittedJournalPath(target);
      const events: string[] = [];
      let receiptQuarantinePath = "";
      let targetQuarantinePath = "";
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          afterPublicationPendingJournalParentFsync(path) {
            expect(path).toBe(pendingJournalPath);
            events.push("pending-journal-durable");
          },
          injectPostReceiptParentFsyncFailure() {
            events.push("receipt-fsync-failed");
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterReceiptFailureCleanup(context) {
            if (context.method === "receipt-quarantine") {
              receiptQuarantinePath = context.receiptQuarantinePath;
              events.push("receipt-quarantined");
            } else {
              targetQuarantinePath = context.targetQuarantinePath;
              events.push("target-quarantined");
            }
          },
          injectReceiptFailureCleanupParentFsyncFailure() {
            events.push("first-cleanup-fsync-failed");
            const cause = new Error(
              "injected first cleanup parent fsync EIO",
            ) as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          injectSecondReceiptFailureCleanupParentFsyncFailure() {
            events.push("second-cleanup-fsync-failed");
            const cause = new Error(
              "injected second cleanup parent fsync EIO",
            ) as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(events).toEqual([
        "pending-journal-durable",
        "receipt-fsync-failed",
        "receipt-quarantined",
        "first-cleanup-fsync-failed",
        "target-quarantined",
        "second-cleanup-fsync-failed",
      ]);
      expect(existsSync(pendingJournalPath)).toBe(true);
      expect(existsSync(committedJournalPath)).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect(existsSync(receiptPath)).toBe(false);

      // Model crash recovery choosing the pre-cleanup directory state because neither cleanup
      // fsync completed. The already-durable pending journal must still make a fresh consumer reject.
      renameSync(targetQuarantinePath, target);
      renameSync(receiptQuarantinePath, receiptPath);
      expect(existsSync(target)).toBe(true);
      expect(existsSync(receiptPath)).toBe(true);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /pending transaction|publication journal/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "stays fail closed when the receipt cleanup parent fsync also fails",
    () => {
      const parent = privateRoot("moss-formal-directory-receipt-cleanup-fsync-failure-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      const receiptPath = evidenceDirectoryPublicationReceiptPath(target);
      const events: string[] = [];
      mkdirSync(staging, { mode: 0o700 });
      writeFileSync(join(staging, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });

      let failure: unknown;
      try {
        publishPrivateEvidenceDirectory(staging, target, {
          afterReceiptVerifiedRename() {
            events.push("receipt-renamed");
          },
          injectPostReceiptParentFsyncFailure() {
            events.push("receipt-fsync-failed");
            const cause = new Error("injected receipt parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterReceiptFailureCleanup(context) {
            if (context.method === "receipt-quarantine") {
              expect(existsSync(receiptPath)).toBe(false);
              events.push("receipt-quarantined");
            } else {
              expect(context.method).toBe("target-quarantine");
              expect(existsSync(target)).toBe(false);
              events.push("target-quarantined");
            }
          },
          injectReceiptFailureCleanupParentFsyncFailure() {
            events.push("cleanup-parent-fsync-failed");
            const cause = new Error("injected cleanup parent fsync EIO") as NodeJS.ErrnoException;
            cause.code = "EIO";
            throw cause;
          },
          afterReceiptFailureCleanupParentFsync() {
            events.push("cleanup-parent-fsynced");
          },
        });
      } catch (cause) {
        failure = cause;
      }

      expect(failure).toBeInstanceOf(EvidenceDirectoryPublicationDurabilityError);
      expect(events).toEqual([
        "receipt-renamed",
        "receipt-fsync-failed",
        "receipt-quarantined",
        "cleanup-parent-fsync-failed",
        "target-quarantined",
        "cleanup-parent-fsynced",
      ]);
      expect(existsSync(receiptPath)).toBe(false);
      expect(existsSync(target)).toBe(false);
      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(
        /publication receipt/iu,
      );
    },
  );

  it.runIf(process.platform === "darwin" || process.platform === "linux")(
    "rejects a forged boolean marker that is not an inode and evidence-bound receipt",
    () => {
      const parent = privateRoot("moss-formal-directory-forged-receipt-");
      const target = join(parent, "capture");
      mkdirSync(target, { mode: 0o700 });
      writeFileSync(join(target, "formal-capture-manifest.json"), '{"complete":true}\n', {
        mode: 0o600,
      });
      writeFileSync(evidenceDirectoryPublicationReceiptPath(target), '{"published":true}\n', {
        mode: 0o600,
      });

      expect(() => assertPublishedPrivateEvidenceDirectory(target)).toThrow(/schema|receipt/iu);
    },
  );

  it.runIf(process.platform === "win32")(
    "fails closed on file publication before exposing any Windows evidence bytes",
    () => {
      const root = privateRoot("moss-formal-file-win32-");
      const before = readdirSync(root);

      expect(() => publishPrivateEvidenceFile(root, "receipt.json", "not eligible\n")).toThrow(
        /unsupported on win32/iu,
      );
      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "generated.json", () => "not eligible\n"),
      ).toThrow(/unsupported on win32/iu);
      expect(readdirSync(root)).toEqual(before);
    },
  );

  it("fails closed on win32 before changing either staging or canonical output", () => {
    const parent = privateRoot("moss-formal-directory-win32-");
    const staging = join(parent, ".capture.staging-owned");
    const target = join(parent, "capture");
    mkdirSync(staging, { mode: 0o700 });
    writeFileSync(join(staging, "owned.txt"), "private staging\n", { mode: 0o600 });
    const entriesBefore = readdirSync(parent).toSorted();

    expect(() =>
      publishPrivateEvidenceDirectory(staging, target, { platformForTest: "win32" }),
    ).toThrow(/unsupported on win32/iu);

    expect(readdirSync(parent).toSorted()).toEqual(entriesBefore);
    expect(readFileSync(join(staging, "owned.txt"), "utf8")).toBe("private staging\n");
    expect(existsSync(target)).toBe(false);
  });

  it.runIf(process.platform === "win32")(
    "fails closed with zero canonical output on the actual win32 runtime",
    () => {
      const parent = privateRoot("moss-formal-directory-real-win32-");
      const staging = join(parent, ".capture.staging-owned");
      const target = join(parent, "capture");
      mkdirSync(staging);
      writeFileSync(join(staging, "owned.txt"), "private staging\n");
      const entriesBefore = readdirSync(parent).toSorted();

      expect(() => publishPrivateEvidenceDirectory(staging, target)).toThrow(
        /unsupported on win32/iu,
      );
      expect(readdirSync(parent).toSorted()).toEqual(entriesBefore);
      expect(existsSync(target)).toBe(false);
      expect(readFileSync(join(staging, "owned.txt"), "utf8")).toBe("private staging\n");
    },
  );

  it("binds the directory transaction before generated bytes are produced", () => {
    const parent = privateRoot("moss-formal-generated-transaction-");
    const root = join(parent, "run");
    const movedRoot = join(parent, "moved-run");
    mkdirSync(root, { mode: 0o700 });

    expect(() =>
      publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => {
        renameSync(root, movedRoot);
        mkdirSync(root, { mode: 0o700 });
        return "owned temporary\n";
      }),
    ).toThrow(/directory.*changed|ancestor.*changed/iu);
    expect(existsSync(join(root, "receipt.json"))).toBe(false);
    expect(existsSync(join(movedRoot, "receipt.json"))).toBe(false);
  });

  nativePublicationTest("binds the complete directory chain before the exclusive mutation", () => {
    const parent = privateRoot("moss-formal-directory-transaction-");
    const root = join(parent, "run");
    mkdirSync(root, { mode: 0o700 });
    const movedRoot = join(parent, "moved-run");
    const targetPath = join(root, "receipt.json");

    expect(() =>
      publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
        beforeExclusiveLink() {
          renameSync(root, movedRoot);
          mkdirSync(root, { mode: 0o700 });
        },
      }),
    ).toThrow(/directory.*changed|ancestor.*changed/iu);
    expect(existsSync(targetPath)).toBe(false);
    expect(readFileSync(join(movedRoot, "receipt.json"), "utf8")).toBe("owned temporary\n");
  });

  nativePublicationTest(
    "binds ancestors above the run root for the whole publication transaction",
    () => {
      const grandparent = privateRoot("moss-formal-ancestor-transaction-");
      const ancestor = join(grandparent, "ancestor");
      const root = join(ancestor, "run");
      const movedAncestor = join(grandparent, "moved-ancestor");
      mkdirSync(ancestor, { mode: 0o700 });
      mkdirSync(root, { mode: 0o700 });
      const targetPath = join(root, "receipt.json");

      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
          beforeExclusiveLink() {
            renameSync(ancestor, movedAncestor);
            mkdirSync(ancestor, { mode: 0o700 });
            mkdirSync(root, { mode: 0o700 });
          },
        }),
      ).toThrow(/directory.*changed|ancestor.*changed/iu);
      expect(existsSync(targetPath)).toBe(false);
      expect(readFileSync(join(movedAncestor, "run", "receipt.json"), "utf8")).toBe(
        "owned temporary\n",
      );
    },
  );

  nativePublicationTest(
    "binds the exclusive mutation to the original parent across an ancestor ABA swap",
    () => {
      const parent = privateRoot("moss-formal-parent-handle-");
      const root = join(parent, "run");
      const displacedRoot = join(parent, "displaced-run");
      const alternateRoot = join(parent, "alternate-run");
      const leakedPath = join(alternateRoot, "leaked-receipt.json");
      mkdirSync(root, { mode: 0o700 });
      mkdirSync(alternateRoot, { mode: 0o700 });

      publishPrivateEvidenceFile(root, "receipt.json", "bound mutation\n", {
        aroundExclusiveLink(publish) {
          renameSync(root, displacedRoot);
          renameSync(alternateRoot, root);
          try {
            const temporaryName = readdirSync(displacedRoot).find((file) => file.includes(".tmp"));
            if (temporaryName) {
              linkSync(join(displacedRoot, temporaryName), join(root, temporaryName));
            }
            publish();
            const alternateTarget = join(root, "receipt.json");
            if (existsSync(alternateTarget)) {
              writeFileSync(join(root, "leaked-receipt.json"), readFileSync(alternateTarget), {
                mode: 0o600,
              });
              unlinkSync(alternateTarget);
              if (temporaryName) {
                unlinkSync(join(root, temporaryName));
                linkSync(join(displacedRoot, temporaryName), join(displacedRoot, "receipt.json"));
              }
            }
          } finally {
            renameSync(root, alternateRoot);
            renameSync(displacedRoot, root);
          }
        },
      });

      expect(readFileSync(join(root, "receipt.json"), "utf8")).toBe("bound mutation\n");
      expect(existsSync(leakedPath)).toBe(false);
    },
  );

  nativePublicationTest(
    "never unlinks a same-inode entry recreated after the cleanup ownership check",
    () => {
      const root = privateRoot("moss-formal-cleanup-window-");
      const targetPath = join(root, "receipt.json");
      const backupPath = join(root, "external-backup.json");
      let raced = false;

      expect(() =>
        publishPrivateEvidenceFile(root, "receipt.json", "owned bytes\n", {
          afterExclusiveLink() {
            throw new Error("injected publication failure");
          },
          beforeOwnedCleanupUnlink(path) {
            if (raced || path !== targetPath) return;
            raced = true;
            linkSync(path, backupPath);
            unlinkSync(path);
            linkSync(backupPath, path);
          },
        }),
      ).toThrow(/injected publication failure/iu);
      expect(raced).toBe(true);
      expect(readFileSync(targetPath, "utf8")).toBe("owned bytes\n");
    },
  );

  nativePublicationTest(
    "never removes an unowned replacement while cleaning up a failed publication",
    () => {
      const root = privateRoot("moss-formal-owned-cleanup-");
      const targetPath = join(root, "receipt.json");

      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
          afterExclusiveLink() {
            unlinkSync(targetPath);
            writeFileSync(targetPath, "unowned replacement\n", { mode: 0o600 });
            throw new Error("injected post-link failure");
          },
        }),
      ).toThrow(/injected post-link failure/iu);
      expect(readFileSync(targetPath, "utf8")).toBe("unowned replacement\n");
      expect(readdirSync(root).filter((file) => file.includes(".tmp"))).toEqual([]);
    },
  );

  it("rejects a generated result that is not exact bytes", () => {
    const root = privateRoot("moss-formal-generated-contract-");

    expect(() =>
      publishGeneratedPrivateEvidenceFile(
        root,
        "receipt.json",
        (() => undefined) as unknown as () => Buffer,
      ),
    ).toThrow(/must return exact string or Buffer/iu);
    expect(existsSync(join(root, "receipt.json"))).toBe(false);
  });

  nativePublicationTest(
    "does not delete a same-inode directory entry relinked by another actor",
    () => {
      const root = privateRoot("moss-formal-same-inode-relink-");
      const targetPath = join(root, "receipt.json");
      const externalPath = join(root, "external-owned-entry.json");

      expect(() =>
        publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
          afterExclusiveLink() {
            linkSync(targetPath, externalPath);
            unlinkSync(targetPath);
            linkSync(externalPath, targetPath);
            throw new Error("injected same-inode relink failure");
          },
        }),
      ).toThrow(/same-inode relink failure/iu);
      expect(readFileSync(targetPath, "utf8")).toBe("owned temporary\n");
      expect(readFileSync(externalPath, "utf8")).toBe("owned temporary\n");
      expect(statSync(targetPath).nlink).toBe(2);
    },
  );

  nativePublicationTest("preserves a racing hardlink that the publisher did not create", () => {
    const root = privateRoot("moss-formal-unowned-hardlink-");
    const targetPath = join(root, "receipt.json");
    const externalPath = join(root, "external.json");
    writeFileSync(externalPath, "external publisher\n", { mode: 0o600 });

    expect(() =>
      publishGeneratedPrivateEvidenceFile(root, "receipt.json", () => "owned temporary\n", {
        beforeExclusiveLink() {
          linkSync(externalPath, targetPath);
        },
      }),
    ).toThrow(/already exists|exclusive|hardlink/iu);
    expect(readFileSync(targetPath, "utf8")).toBe("external publisher\n");
    expect(readFileSync(externalPath, "utf8")).toBe("external publisher\n");
    expect(statSync(targetPath).nlink).toBe(2);
    expect(readdirSync(root).filter((file) => file.includes(".tmp"))).toEqual([]);
  });

  it.runIf(POSIX_MODES)("rejects evidence files that are not private", () => {
    const root = privateRoot("moss-formal-public-mode-");
    const path = join(root, "public.json");
    writeFileSync(path, "{}\n", { mode: 0o644 });
    // The repository test process runs with a restrictive umask, so make the
    // intentionally public mode explicit before asserting the fail-closed
    // boundary.
    chmodSync(path, 0o644);

    expect(() => freezeEvidenceFile(path, "public evidence", { requirePrivateMode: true })).toThrow(
      /private mode 0600/iu,
    );
  });
});
