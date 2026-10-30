import { open, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { spawn } from "node:child_process";
import { describe, expect, it } from "vitest";

import { scanExactSecret } from "./moss-key-leak-scan.mjs";

const fixtureKey = "fixture-not-a-real-Moss-Key-✓";
const scannerPath = fileURLToPath(new URL("./moss-key-leak-scan.mjs", import.meta.url));

async function withTemporaryDirectory(run) {
  const root = await mkdtemp(join(tmpdir(), "moss-key-leak-scan-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function writeNestedFile(path, contents) {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, contents);
}

function scanRoot(category, path) {
  return { category, path };
}

function runScannerCli({ secret, roots }) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [scannerPath], {
      env: {
        ...process.env,
        MOSS_KEY_LEAK_SCAN_ROOTS: JSON.stringify(roots),
      },
      stdio: ["pipe", "pipe", "pipe"],
    });
    const stdout = [];
    const stderr = [];
    child.stdout.on("data", (chunk) => stdout.push(Buffer.from(chunk)));
    child.stderr.on("data", (chunk) => stderr.push(Buffer.from(chunk)));
    child.once("error", reject);
    child.once("close", (code, signal) => {
      resolve({
        code,
        signal,
        spawnargs: child.spawnargs,
        stdout: Buffer.concat(stdout).toString("utf8"),
        stderr: Buffer.concat(stderr).toString("utf8"),
      });
    });
    child.stdin.end(Buffer.from(secret, "utf8"));
  });
}

describe("exact plaintext Moss Key leak scan", () => {
  it("rejects a short placeholder before traversing app-owned roots", async () => {
    await withTemporaryDirectory(async (root) => {
      await writeNestedFile(join(root, "logs", "desktop.log"), "ordinary-text-with-dashes\n");

      const result = await runScannerCli({
        secret: "-",
        roots: [scanRoot("isolated-profile", root)],
      });

      expect(result.code).toBe(2);
      expect(result.stdout).toBe("");
      expect(result.stderr).toBe('{"status":"scan-error","code":"UNEXPECTED"}\n');
      expect(result.stderr).not.toContain("ordinary-text-with-dashes");
    });
  });

  it("passes a clean tree", async () => {
    await withTemporaryDirectory(async (root) => {
      await writeNestedFile(join(root, "logs", "desktop.log"), "ordinary clean text\n");
      await writeNestedFile(join(root, "state.sqlite"), Buffer.from([0, 1, 2, 3, 255]));

      const result = await scanExactSecret({
        secret: Buffer.from(fixtureKey, "utf8"),
        roots: [scanRoot("isolated-profile", root)],
      });

      expect(result.outcome).toBe("clean");
      expect(result.filesScanned).toBe(2);
      expect(result.matches).toEqual([]);
      expect(result.errors).toEqual([]);
    });
  });

  it("finds an exact plaintext match in a text file and reports location only", async () => {
    await withTemporaryDirectory(async (root) => {
      const leakedPath = join(root, "config.toml");
      await writeFile(leakedPath, `model = "gpt-5.6-sol"\nkey = "${fixtureKey}"\n`);

      const result = await runScannerCli({
        secret: fixtureKey,
        roots: [scanRoot("moss-home", root)],
      });

      expect(result.code).toBe(1);
      expect(result.signal).toBeNull();
      expect(result.spawnargs).not.toContain(fixtureKey);
      expect(result.stdout).toBe("");
      expect(result.stderr).not.toContain(fixtureKey);
      const report = JSON.parse(result.stderr.trim());
      expect(Object.keys(report).toSorted()).toEqual(["category", "path", "root"]);
      expect(report).toEqual({
        category: "moss-home",
        root,
        path: leakedPath,
      });

      // The stdin protocol is byte-exact and shares the driver's single-line
      // credential contract. An accidental WriteLine() must fail closed rather
      // than silently scan for a different byte sequence.
      const newlineNeedle = await runScannerCli({
        secret: `${fixtureKey}\n`,
        roots: [scanRoot("moss-home", root)],
      });
      expect(newlineNeedle.code).toBe(2);
      expect(newlineNeedle.stdout).toBe("");
      expect(newlineNeedle.stderr).toBe('{"status":"scan-error","code":"UNEXPECTED"}\n');
    });
  });

  it("finds an exact UTF-8 byte sequence split across binary read chunks", async () => {
    await withTemporaryDirectory(async (root) => {
      const leakedPath = join(root, "state.sqlite-wal");
      const keyBytes = Buffer.from(fixtureKey, "utf8");
      const chunkBoundary = 1024 * 1024;
      const binary = Buffer.concat([
        Buffer.alloc(chunkBoundary - 3, 0xa5),
        keyBytes,
        Buffer.from([0, 255, 19]),
      ]);
      await writeFile(leakedPath, binary);

      const result = await scanExactSecret({
        secret: keyBytes,
        roots: [scanRoot("electron-user-data", root)],
      });

      expect(result.outcome).toBe("match");
      expect(result.matches).toEqual([{ category: "electron-user-data", root, path: leakedPath }]);
      expect(result.errors).toEqual([]);
    });
  });

  it("scans an installer artifact supplied as an exact ordinary-file root", async () => {
    await withTemporaryDirectory(async (root) => {
      const installerPath = join(root, "Moss-fixture-x64.exe");
      await writeFile(
        installerPath,
        Buffer.concat([Buffer.from([77, 90, 0, 1]), Buffer.from(fixtureKey, "utf8")]),
      );

      const result = await runScannerCli({
        secret: fixtureKey,
        roots: [scanRoot("installer-artifact", installerPath)],
      });

      expect(result.code).toBe(1);
      expect(result.stderr).not.toContain(fixtureKey);
      expect(JSON.parse(result.stderr)).toEqual({
        category: "installer-artifact",
        root: installerPath,
        path: installerPath,
      });
    });
  });

  it("scans nested Codex snapshots, logs, SQLite, and IndexedDB as ordinary files", async () => {
    await withTemporaryDirectory(async (profileRoot) => {
      const mossHome = join(profileRoot, "moss-home");
      const snapshotPath = join(mossHome, "codex-home", "shell_snapshots", "session.sqlite");
      const indexedDbPath = join(
        profileRoot,
        "electron-user-data",
        "IndexedDB",
        "moss.indexeddb.leveldb",
        "000003.log",
      );
      await writeNestedFile(
        snapshotPath,
        Buffer.concat([Buffer.from([0, 7]), Buffer.from(fixtureKey)]),
      );
      await writeNestedFile(indexedDbPath, `prefix:${fixtureKey}:suffix`);

      const result = await scanExactSecret({
        secret: Buffer.from(fixtureKey, "utf8"),
        roots: [scanRoot("moss-home", mossHome), scanRoot("isolated-profile", profileRoot)],
      });

      expect(result.outcome).toBe("match");
      expect(result.matches).toEqual([
        { category: "moss-home", root: mossHome, path: snapshotPath },
        { category: "isolated-profile", root: profileRoot, path: indexedDbPath },
      ]);
      expect(result.filesScanned).toBe(2);
      expect(result.errors).toEqual([]);
    });
  });

  it("does not follow a nested symlink outside an approved root", async () => {
    await withTemporaryDirectory(async (base) => {
      const root = join(base, "approved");
      const outside = join(base, "outside");
      await mkdir(root, { recursive: true });
      await writeNestedFile(join(outside, "leaked.log"), fixtureKey);
      await writeFile(join(root, "clean.log"), "clean");
      await symlink(
        outside,
        join(root, "outside-link"),
        process.platform === "win32" ? "junction" : "dir",
      );

      const result = await scanExactSecret({
        secret: Buffer.from(fixtureKey, "utf8"),
        roots: [scanRoot("install-tree", root)],
      });

      expect(result.outcome).toBe("clean");
      expect(result.matches).toEqual([]);
      expect(result.errors).toEqual([]);
      expect(result.symlinksSkipped).toBe(1);
      expect(result.filesScanned).toBe(1);
    });
  });

  it("fails closed when an ordinary file cannot be opened", async () => {
    await withTemporaryDirectory(async (root) => {
      const inaccessiblePath = join(root, "logs", "unreadable.log");
      await writeNestedFile(inaccessiblePath, "unreadable fixture");

      const result = await scanExactSecret(
        {
          secret: Buffer.from(fixtureKey, "utf8"),
          roots: [scanRoot("moss-home", root)],
        },
        {
          fileSystem: {
            open: async (path, flags) => {
              if (path === inaccessiblePath) {
                throw Object.assign(new Error("synthetic unreadable file"), { code: "EACCES" });
              }
              return open(path, flags);
            },
          },
        },
      );

      expect(result.outcome).toBe("error");
      expect(result.matches).toEqual([]);
      expect(result.errors).toEqual([
        {
          category: "moss-home",
          root,
          path: inaccessiblePath,
          operation: "open",
          code: "EACCES",
        },
      ]);
    });
  });

  it("fails closed when file metadata changes while bytes are being scanned", async () => {
    await withTemporaryDirectory(async (root) => {
      const changingPath = join(root, "logs", "changing.log");
      await writeNestedFile(changingPath, "stable fixture contents");

      const result = await scanExactSecret(
        {
          secret: Buffer.from(fixtureKey, "utf8"),
          roots: [scanRoot("moss-home", root)],
        },
        {
          fileSystem: {
            open: async (path, flags) => {
              const handle = await open(path, flags);
              let statCalls = 0;
              return {
                close: handle.close.bind(handle),
                read: handle.read.bind(handle),
                stat: async () => {
                  const stat = await handle.stat();
                  statCalls += 1;
                  if (statCalls > 1) stat.ctimeMs += 1;
                  return stat;
                },
              };
            },
          },
        },
      );

      expect(result.outcome).toBe("error");
      expect(result.matches).toEqual([]);
      expect(result.errors).toEqual([
        {
          category: "moss-home",
          root,
          path: changingPath,
          operation: "stability",
          code: "FILE_CHANGED",
        },
      ]);
    });
  });

  it("fails closed instead of following a symlink supplied as a root", async () => {
    await withTemporaryDirectory(async (base) => {
      const outside = join(base, "outside");
      const linkedRoot = join(base, "linked-root");
      await writeNestedFile(join(outside, "leaked.log"), fixtureKey);
      await symlink(outside, linkedRoot, process.platform === "win32" ? "junction" : "dir");

      const result = await scanExactSecret({
        secret: Buffer.from(fixtureKey, "utf8"),
        roots: [scanRoot("diagnostic", linkedRoot)],
      });

      expect(result.outcome).toBe("error");
      expect(result.matches).toEqual([]);
      expect(result.errors).toEqual([
        {
          category: "diagnostic",
          root: linkedRoot,
          path: linkedRoot,
          operation: "root-symlink",
          code: "SYMLINK_ROOT",
        },
      ]);
    });
  });
});
