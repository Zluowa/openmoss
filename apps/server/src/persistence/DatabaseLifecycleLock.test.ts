import { spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { randomUUID } from "node:crypto";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { Effect, Layer } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { createRejectedFileAlias } from "../../../../scripts/fixtures/filesystem-links.ts";

import {
  acquireDatabaseLifecycleLock,
  classifyLockOwnerProcess,
  DatabaseLifecycleLockedError,
  releaseDatabaseLifecycleLock,
  setProcessIdentityProbeForTesting,
  withDatabaseLifecycleLock,
} from "./DatabaseLifecycleLock.ts";
import { makeSqlitePersistenceLive } from "./Layers/Sqlite.ts";
import { restoreMarkedMigrationBackup } from "./MigrationBackup.ts";

const tempDirectories: Array<string> = [];

async function makeDbPath(): Promise<string> {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), "moss-db-lock-"));
  tempDirectories.push(directory);
  return path.join(directory, "state.sqlite");
}

async function writeOwnedDirectory(directoryPath: string, pid: number): Promise<void> {
  await fs.mkdir(directoryPath, { mode: 0o700 });
  await fs.writeFile(
    path.join(directoryPath, "owner.json"),
    `${JSON.stringify({
      pid,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`,
    { mode: 0o600 },
  );
}

afterEach(async () => {
  await Promise.all(
    tempDirectories.splice(0).map((directory) => fs.rm(directory, { recursive: true })),
  );
});

describe("database lifecycle lock", () => {
  it("allows one same-process owner and releases only its owner token", async () => {
    const dbPath = await makeDbPath();
    const first = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));

    try {
      await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
        DatabaseLifecycleLockedError,
      );
      const parentEntries = await fs.readdir(path.dirname(dbPath));
      expect(parentEntries.some((entry) => entry.includes(".lifecycle-lock.acquiring."))).toBe(
        false,
      );
      await expect(fs.readFile(path.join(first.lockPath, "owner.json"), "utf8")).resolves.toContain(
        first.owner.token,
      );
      const forged = { ...first, owner: { ...first.owner, token: randomUUID() } };
      await expect(Effect.runPromise(releaseDatabaseLifecycleLock(forged))).rejects.toBeInstanceOf(
        DatabaseLifecycleLockedError,
      );
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(first));
    }

    const next = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    await Effect.runPromise(releaseDatabaseLifecycleLock(next));
    const releasedEntries = await fs.readdir(path.dirname(dbPath));
    expect(releasedEntries.some((entry) => entry.includes(".lifecycle-lock.released."))).toBe(
      false,
    );
  });

  it("recovers a well-formed lock owned by a dead process", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);

    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(acquired.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));
    await expect(fs.stat(`${lockPath}.reaper`)).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("recovers a reaper guard whose owner process died", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const reaperPath = `${lockPath}.reaper`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);
    await writeOwnedDirectory(reaperPath, 2_147_483_647);

    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(acquired.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));

    const entries = await fs.readdir(path.dirname(dbPath));
    expect(entries.some((entry) => entry.includes(".lifecycle-lock.reaper"))).toBe(false);
  });

  it.each(["", ".reaper"])(
    "recovers an ownerless lock%s directory containing Finder metadata",
    async (suffix) => {
      const dbPath = await makeDbPath();
      const lockPath = `${dbPath}.lifecycle-lock`;
      if (suffix) await writeOwnedDirectory(lockPath, 2_147_483_647);
      const abandonedPath = `${lockPath}${suffix}`;
      await fs.mkdir(abandonedPath, { mode: 0o700 });
      await fs.writeFile(path.join(abandonedPath, ".DS_Store"), "Finder metadata");

      await Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void));

      expect(await fs.readdir(path.dirname(dbPath))).toEqual([]);
    },
  );

  it("preserves a live owner even when Finder metadata is present", async () => {
    const dbPath = await makeDbPath();
    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    const metadataPath = path.join(acquired.lockPath, ".DS_Store");
    await fs.writeFile(metadataPath, "Finder metadata");
    try {
      await expect(
        Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
      ).rejects.toThrow(`owner pid ${process.pid} is live`);
      expect(await fs.readFile(metadataPath, "utf8")).toBe("Finder metadata");
      expect(
        JSON.parse(await fs.readFile(path.join(acquired.lockPath, "owner.json"), "utf8")),
      ).toEqual(acquired.owner);
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));
    }
  });

  it.each(["owner.json", "unrecognized-file"])(
    "preserves an unverifiable lock containing %s and Finder metadata",
    async (fileName) => {
      const dbPath = await makeDbPath();
      const lockPath = `${dbPath}.lifecycle-lock`;
      await fs.mkdir(lockPath, { mode: 0o700 });
      await fs.writeFile(path.join(lockPath, ".DS_Store"), "Finder metadata");
      await fs.writeFile(path.join(lockPath, fileName), "unrecognized contents");

      await expect(
        Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
      ).rejects.toBeInstanceOf(DatabaseLifecycleLockedError);

      expect(await fs.readFile(path.join(lockPath, fileName), "utf8")).toBe(
        "unrecognized contents",
      );
      expect(await fs.readFile(path.join(lockPath, ".DS_Store"), "utf8")).toBe("Finder metadata");
    },
  );

  it("admits only one concurrent owner when recovering Finder metadata", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(path.join(lockPath, ".DS_Store"), "Finder metadata");

    const contenders = await Promise.allSettled(
      Array.from({ length: 8 }, () => Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))),
    );
    const owners = contenders.filter((result) => result.status === "fulfilled");
    try {
      expect(owners).toHaveLength(1);
      expect(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8"))).toEqual(
        owners[0]?.value.owner,
      );
    } finally {
      for (const owner of owners)
        await Effect.runPromise(releaseDatabaseLifecycleLock(owner.value));
    }
  });

  it("does not recover Finder metadata that is a symbolic link", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const outsidePath = path.join(path.dirname(dbPath), "outside-file");
    await fs.writeFile(outsidePath, "preserved contents");
    await fs.mkdir(lockPath, { mode: 0o700 });
    // The Windows junction occupies a file slot only for this no-follow regression.
    createRejectedFileAlias(outsidePath, path.join(lockPath, ".DS_Store"));

    await expect(
      Effect.runPromise(withDatabaseLifecycleLock(dbPath, Effect.void)),
    ).rejects.toBeInstanceOf(DatabaseLifecycleLockedError);

    expect((await fs.lstat(path.join(lockPath, ".DS_Store"))).isSymbolicLink()).toBe(true);
    expect(await fs.readFile(outsidePath, "utf8")).toBe("preserved contents");
  });

  it("does not take over a reaper guard owned by a live process", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const reaperPath = `${lockPath}.reaper`;
    await writeOwnedDirectory(lockPath, 2_147_483_647);
    await writeOwnedDirectory(reaperPath, process.pid);

    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
      DatabaseLifecycleLockedError,
    );
    await expect(fs.stat(lockPath)).resolves.toBeDefined();
    await expect(fs.stat(reaperPath)).resolves.toBeDefined();
  });

  it("recovers an ownerless directory and fails closed for an owner-file symlink", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    await fs.mkdir(lockPath, { mode: 0o700 });

    const recovered = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    expect(recovered.owner.pid).toBe(process.pid);
    await Effect.runPromise(releaseDatabaseLifecycleLock(recovered));

    await fs.mkdir(lockPath, { mode: 0o700 });
    const outsideOwner = path.join(path.dirname(dbPath), "outside-owner.json");
    const outsideContents = `${JSON.stringify({
      pid: 2_147_483_647,
      token: randomUUID(),
      createdAt: new Date().toISOString(),
    })}\n`;
    await fs.writeFile(outsideOwner, outsideContents);
    createRejectedFileAlias(outsideOwner, path.join(lockPath, "owner.json"));

    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toBeInstanceOf(
      DatabaseLifecycleLockedError,
    );
    expect(await fs.readFile(outsideOwner, "utf8")).toBe(outsideContents);
    expect((await fs.lstat(path.join(lockPath, "owner.json"))).isSymbolicLink()).toBe(true);
  });

  it("makes recovery refuse while a server layer owns the database", async () => {
    const dbPath = await makeDbPath();

    const recoveryExit = await Effect.runPromise(
      Effect.scoped(
        Effect.gen(function* () {
          yield* Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          );
          return yield* Effect.exit(restoreMarkedMigrationBackup(dbPath));
        }),
      ),
    );

    expect(recoveryExit._tag).toBe("Failure");
    if (recoveryExit._tag === "Failure") {
      expect(String(recoveryExit.cause)).toContain("DatabaseLifecycleLockedError");
    }
  });

  it("makes server startup refuse while recovery owns the database", async () => {
    const dbPath = await makeDbPath();

    const startupExit = await Effect.runPromise(
      withDatabaseLifecycleLock(
        dbPath,
        Effect.exit(
          Layer.build(
            makeSqlitePersistenceLive(dbPath).pipe(Layer.provide(NodeServices.layer)),
          ).pipe(Effect.scoped),
        ),
      ),
    );

    expect(startupExit._tag).toBe("Failure");
    if (startupExit._tag === "Failure") {
      expect(String(startupExit.cause)).toContain("DatabaseLifecycleLockedError");
    }
  });
});

// 2026-11-17: an unclean stop left a lock whose pid Windows then gave to
// conhost.exe; every later start refused with "owner pid … is live".
describe("database lifecycle lock owner identity", () => {
  const children: ChildProcess[] = [];
  const HOUR_MS = 60 * 60 * 1_000;

  afterEach(() => {
    for (const child of children.splice(0)) {
      if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
    }
  });

  /** A real live process that is not a Moss backend and holds no lock. */
  async function spawnBystander(): Promise<{ pid: number; spawnedAt: number }> {
    const child = spawn(process.execPath, ["-e", "setTimeout(() => undefined, 60_000)"], {
      stdio: "ignore",
      windowsHide: true,
    });
    children.push(child);
    const spawnedAt = Date.now();
    await new Promise<void>((resolve, reject) => {
      child.once("spawn", () => resolve());
      child.once("error", reject);
    });
    return { pid: child.pid!, spawnedAt };
  }

  async function writeOwner(lockPath: string, owner: Record<string, unknown>): Promise<string> {
    const token = randomUUID();
    await fs.mkdir(lockPath, { mode: 0o700 });
    await fs.writeFile(
      path.join(lockPath, "owner.json"),
      `${JSON.stringify({ ...owner, token })}\n`,
      { mode: 0o600 },
    );
    return token;
  }

  async function expectRecovered(dbPath: string): Promise<void> {
    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    try {
      expect(acquired.owner.pid).toBe(process.pid);
      const written = JSON.parse(
        await fs.readFile(path.join(acquired.lockPath, "owner.json"), "utf8"),
      );
      expect(written).toEqual(acquired.owner);
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));
    }
    const leftovers = (await fs.readdir(path.dirname(dbPath))).filter((entry) =>
      entry.includes(".lifecycle-lock"),
    );
    expect(leftovers).toEqual([]);
  }

  it("records the owner's start time and executable", async () => {
    const dbPath = await makeDbPath();
    const acquired = await Effect.runPromise(acquireDatabaseLifecycleLock(dbPath));
    try {
      const written = JSON.parse(
        await fs.readFile(path.join(acquired.lockPath, "owner.json"), "utf8"),
      );
      expect(written.executable).toBe(path.basename(process.execPath));
      const startedAt = Date.parse(written.processStartedAt);
      expect(Math.abs(startedAt - (Date.now() - process.uptime() * 1_000))).toBeLessThan(1_000);
      expect(startedAt).toBeLessThanOrEqual(Date.parse(written.createdAt));
    } finally {
      await Effect.runPromise(releaseDatabaseLifecycleLock(acquired));
    }
  });

  it("recovers a lock whose owner is dead (current format)", async () => {
    const dbPath = await makeDbPath();
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: 2_147_483_000,
      createdAt: new Date().toISOString(),
      processStartedAt: new Date(Date.now() - 5_000).toISOString(),
      executable: path.basename(process.execPath),
    });
    await expectRecovered(dbPath);
  });

  it("recovers a 1.0.7 lock (no identity fields) whose owner is dead", async () => {
    const dbPath = await makeDbPath();
    // Same shape as the lock found on the owner's PC on 2026-11-17.
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: 2_147_483_000,
      createdAt: "2026-11-17T11:08:34.698Z",
    });
    await expectRecovered(dbPath);
  });

  it("recovers a 1.0.7 lock whose pid now belongs to another process", async () => {
    const dbPath = await makeDbPath();
    const bystander = await spawnBystander();
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt - HOUR_MS).toISOString(),
    });
    await expectRecovered(dbPath);
  }, 30_000);

  it("recovers a lock whose pid is alive but runs a different program", async () => {
    const dbPath = await makeDbPath();
    const bystander = await spawnBystander();
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt - HOUR_MS).toISOString(),
      processStartedAt: new Date(bystander.spawnedAt - HOUR_MS - 3_000).toISOString(),
      executable: "Moss.exe",
    });
    await expectRecovered(dbPath);
  }, 30_000);

  it.runIf(process.platform === "win32")(
    "recovers on Windows when the executable differs even without a start-time hint",
    async () => {
      const dbPath = await makeDbPath();
      const bystander = await spawnBystander();
      // The lock claims to be newer than the process: only the name can tell.
      await writeOwner(`${dbPath}.lifecycle-lock`, {
        pid: bystander.pid,
        createdAt: new Date(Date.now() + 60_000).toISOString(),
        processStartedAt: new Date().toISOString(),
        executable: "Moss.exe",
      });
      await expectRecovered(dbPath);
    },
    30_000,
  );

  it("recovers when the pid runs the same executable but started after the lock", async () => {
    const dbPath = await makeDbPath();
    const bystander = await spawnBystander();
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt - HOUR_MS).toISOString(),
      processStartedAt: new Date(bystander.spawnedAt - HOUR_MS - 3_000).toISOString(),
      executable: path.basename(process.execPath),
    });
    await expectRecovered(dbPath);
  }, 30_000);

  it("recovers a lock left by a dead owner whose pid this process inherited", async () => {
    const dbPath = await makeDbPath();
    const startedAt = Date.now() - process.uptime() * 1_000;
    await writeOwner(`${dbPath}.lifecycle-lock`, {
      pid: process.pid,
      createdAt: new Date(startedAt - HOUR_MS).toISOString(),
    });
    await expectRecovered(dbPath);
  });

  it("keeps a 1.0.7 lock whose owner is still the same running process", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const bystander = await spawnBystander();
    // Written after the process started, as a real owner would.
    const token = await writeOwner(lockPath, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt + 5_000).toISOString(),
    });
    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toThrow(
      `owner pid ${bystander.pid} is live`,
    );
    expect(JSON.parse(await fs.readFile(path.join(lockPath, "owner.json"), "utf8")).token).toBe(
      token,
    );
  }, 30_000);

  it("keeps the lock when the owner's identity cannot be read", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const bystander = await spawnBystander();
    await writeOwner(lockPath, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt - HOUR_MS).toISOString(),
    });
    const restore = setProcessIdentityProbeForTesting(async () => ({ state: "unknown" }));
    try {
      await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toThrow(
        `owner pid ${bystander.pid} is live`,
      );
    } finally {
      restore();
    }
    await expect(fs.stat(path.join(lockPath, "owner.json"))).resolves.toBeDefined();
  }, 30_000);

  it("does not take over a reaper guard whose pid is a live process that predates it", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const bystander = await spawnBystander();
    await writeOwner(lockPath, { pid: 2_147_483_000, createdAt: new Date().toISOString() });
    await writeOwner(`${lockPath}.reaper`, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt + 5_000).toISOString(),
    });
    await expect(Effect.runPromise(acquireDatabaseLifecycleLock(dbPath))).rejects.toThrow(
      `stale-lock recovery owner pid ${bystander.pid} is live`,
    );
  }, 30_000);

  it("recovers a reaper guard whose pid was reused", async () => {
    const dbPath = await makeDbPath();
    const lockPath = `${dbPath}.lifecycle-lock`;
    const bystander = await spawnBystander();
    await writeOwner(lockPath, { pid: 2_147_483_000, createdAt: new Date().toISOString() });
    await writeOwner(`${lockPath}.reaper`, {
      pid: bystander.pid,
      createdAt: new Date(bystander.spawnedAt - HOUR_MS).toISOString(),
    });
    await expectRecovered(dbPath);
  }, 30_000);

  describe("classifyLockOwnerProcess", () => {
    const createdAt = "2026-11-17T11:08:34.698Z";
    const createdAtMs = Date.parse(createdAt);

    it("passes through dead and unknown", () => {
      expect(classifyLockOwnerProcess({ createdAt }, { state: "dead" })).toBe("dead");
      expect(classifyLockOwnerProcess({ createdAt }, { state: "unknown" })).toBe("unknown");
    });

    it("treats a process started after the lock as a reused pid", () => {
      const reused = { state: "live", startedAtMs: createdAtMs + 8 * 60 * 60 * 1_000 } as const;
      expect(classifyLockOwnerProcess({ createdAt }, reused, "win32")).toBe("dead");
      expect(classifyLockOwnerProcess({ createdAt }, reused, "linux")).toBe("dead");
      expect(
        classifyLockOwnerProcess(
          { createdAt },
          { state: "live", startedAtMs: createdAtMs + 1_500 },
        ),
      ).toBe("live");
      expect(
        classifyLockOwnerProcess(
          { createdAt },
          { state: "live", startedAtMs: createdAtMs - 4_000 },
        ),
      ).toBe("live");
    });

    it("compares executable names on Windows only, ignoring case and .exe", () => {
      const observed = { state: "live", executable: "conhost.exe" } as const;
      expect(
        classifyLockOwnerProcess({ createdAt, executable: "Moss.exe" }, observed, "win32"),
      ).toBe("dead");
      expect(
        classifyLockOwnerProcess({ createdAt, executable: "Moss.exe" }, observed, "darwin"),
      ).toBe("live");
      expect(
        classifyLockOwnerProcess(
          { createdAt, executable: "Moss.exe" },
          { state: "live", executable: "moss" },
          "win32",
        ),
      ).toBe("live");
      expect(classifyLockOwnerProcess({ createdAt }, observed, "win32")).toBe("live");
    });

    it("keeps a live owner when nothing about the process can be read", () => {
      expect(classifyLockOwnerProcess({ createdAt }, { state: "live" })).toBe("live");
      expect(
        classifyLockOwnerProcess({ createdAt: "not a date" }, { state: "live", startedAtMs: 1 }),
      ).toBe("live");
    });
  });
});
