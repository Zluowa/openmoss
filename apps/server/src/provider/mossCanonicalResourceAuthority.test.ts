import { realpathSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { makeNodeMossOwnershipStore } from "./mossResourceImport.ts";

const REAL_TMPDIR = realpathSync(tmpdir());
const posixDurabilityIt = it.skipIf(process.platform === "win32");

const lockInput = (
  overrides: Partial<
    Parameters<ReturnType<typeof makeNodeMossOwnershipStore>["acquireLock"]>[0]
  > = {},
) => ({
  cwd: "/tmp/moss-canonical-workspace",
  ownerId: "owner-a",
  projectId: "project-a",
  workspaceId: "workspace-a",
  principalId: "principal-a",
  sessionId: "session-a",
  nonce: "nonce-a",
  ...overrides,
});

describe("Moss canonical resource authority", () => {
  const roots: string[] = [];

  afterEach(async () => {
    await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
  });

  it("owns a private fenced lock with the complete authority identity", async () => {
    const stateRoot = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-lock-"));
    roots.push(stateRoot);
    const store = makeNodeMossOwnershipStore(stateRoot);

    const lock = await store.acquireLock(lockInput());

    expect(lock).toMatchObject({
      ownerId: "owner-a",
      projectId: "project-a",
      workspaceId: "workspace-a",
      principalId: "principal-a",
      sessionId: "session-a",
      nonce: "nonce-a",
      fencingToken: expect.any(String),
      generation: expect.any(String),
    });
    expect(lock.fencingToken).not.toBe(lock.generation);
    await expect(readFile(join(stateRoot, ".lock"), "utf8")).resolves.toContain(
      '"workspaceId":"workspace-a"',
    );
  });

  it("fails closed on an occupied or stale private lock and never reclaims it", async () => {
    const stateRoot = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-stale-"));
    roots.push(stateRoot);
    const store = makeNodeMossOwnershipStore(stateRoot);
    const stale = {
      ownerId: "stale-owner",
      projectId: "stale-project",
      workspaceId: "stale-workspace",
      principalId: "stale-principal",
      sessionId: "stale-session",
      nonce: "stale-nonce",
      fencingToken: "stale-fence",
      generation: "stale-generation",
    };
    await writeFile(join(stateRoot, ".lock"), `${JSON.stringify(stale)}\n`, { mode: 0o600 });

    await expect(store.acquireLock(lockInput())).rejects.toMatchObject({
      code: "concurrent-modification",
    });
    await expect(readFile(join(stateRoot, ".lock"), "utf8")).resolves.toContain("stale-owner");
  });

  it("release is token-safe when a newer private lock occupies the lock path", async () => {
    const stateRoot = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-release-"));
    roots.push(stateRoot);
    const store = makeNodeMossOwnershipStore(stateRoot);
    const first = await store.acquireLock(lockInput());
    const newer = {
      ...lockInput({ nonce: "nonce-b" }),
      fencingToken: "newer-fence",
      generation: "newer-generation",
    };
    await writeFile(join(stateRoot, ".lock"), `${JSON.stringify(newer)}\n`, { mode: 0o600 });

    await first.release();

    await expect(readFile(join(stateRoot, ".lock"), "utf8")).resolves.toContain("newer-fence");
  });

  it.runIf(process.platform === "win32")(
    "reports unconfirmed directory durability when releasing a real native fenced lock",
    async () => {
      const stateRoot = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-lock-release-refusal-"));
      const workspace = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-lock-workspace-"));
      roots.push(stateRoot, workspace);
      await writeFile(join(workspace, "sentinel"), "keep-canonical");
      const lock = await makeNodeMossOwnershipStore(stateRoot).acquireLock(
        lockInput({ cwd: workspace }),
      );
      await expect(lock.release()).rejects.toMatchObject({ code: "durability-unsupported" });
      expect(await readFile(join(workspace, "sentinel"), "utf8")).toBe("keep-canonical");
    },
  );

  posixDurabilityIt(
    "returns a fresh fence after a complete release without touching workspace state",
    async () => {
      const stateRoot = await mkdtemp(join(REAL_TMPDIR, "moss-canonical-authority-generation-"));
      roots.push(stateRoot);
      const store = makeNodeMossOwnershipStore(stateRoot);
      const first = await store.acquireLock(lockInput());
      await first.release();
      const second = await store.acquireLock(lockInput({ nonce: "nonce-b" }));

      expect(second.fencingToken).not.toBe(first.fencingToken);
      expect(second.generation).not.toBe(first.generation);
      expect(second.nonce).toBe("nonce-b");
      await second.release();
    },
  );
});
