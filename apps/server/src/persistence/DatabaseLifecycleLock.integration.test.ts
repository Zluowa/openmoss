import { execFileSync, spawn, type ChildProcess } from "node:child_process";
import * as fs from "node:fs";
import * as fsPromises from "node:fs/promises";
import * as os from "node:os";
import * as path from "node:path";
import { fileURLToPath } from "node:url";

import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

const holderFixture = fileURLToPath(
  new URL("../fixtures/databaseLifecycleLockHolder.ts", import.meta.url),
);

type HolderState =
  | { readonly pid: number; readonly outcome: "acquired" }
  | { readonly pid: number; readonly outcome: "refused"; readonly message: string };

async function waitFor<T>(read: () => T | undefined, description: string): Promise<T> {
  const deadline = Date.now() + 20_000;
  while (Date.now() < deadline) {
    const value = read();
    if (value !== undefined) return value;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`Timed out waiting for ${description}`);
}

async function killHard(child: ChildProcess): Promise<void> {
  if (child.exitCode !== null || child.signalCode !== null) return;
  const exited = new Promise<void>((resolve) => child.once("exit", () => resolve()));
  child.kill("SIGKILL");
  await exited;
}

// Two real backends on one data folder: exactly one may own the database, and an
// owner killed without cleanup must not keep the next start out.
describe("database lifecycle lock across real processes", () => {
  let fixtureDirectory: string;
  let bundledHolder: string;
  const children: ChildProcess[] = [];

  beforeAll(async () => {
    fixtureDirectory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "moss-lock-fixture-"));
    bundledHolder = path.join(fixtureDirectory, "holder.mjs");
    execFileSync("bun", ["build", holderFixture, "--target=node", "--outfile", bundledHolder], {
      windowsHide: true,
      timeout: 60_000,
    });
  }, 65_000);

  afterEach(async () => {
    await Promise.all(children.splice(0).map(killHard));
  });

  afterAll(async () => {
    if (fixtureDirectory) await fsPromises.rm(fixtureDirectory, { recursive: true, force: true });
  });

  function startHolder(dbPath: string, statePath: string): ChildProcess {
    const child = spawn(process.execPath, [bundledHolder, dbPath, statePath], {
      stdio: ["ignore", "ignore", "pipe"],
      windowsHide: true,
    });
    children.push(child);
    return child;
  }

  function readState(statePath: string): HolderState | undefined {
    if (!fs.existsSync(statePath)) return undefined;
    try {
      return JSON.parse(fs.readFileSync(statePath, "utf8")) as HolderState;
    } catch {
      return undefined;
    }
  }

  it("admits one of two concurrent backends and recovers after the owner is killed", async () => {
    const directory = await fsPromises.mkdtemp(path.join(os.tmpdir(), "moss-lock-two-"));
    try {
      const dbPath = path.join(directory, "state.sqlite");
      const statePaths = [path.join(directory, "a.json"), path.join(directory, "b.json")];
      const holders = statePaths.map((statePath) => startHolder(dbPath, statePath));

      const states = await Promise.all(
        statePaths.map((statePath) => waitFor(() => readState(statePath), statePath)),
      );
      const winners = states.filter((state) => state.outcome === "acquired");
      const losers = states.filter((state) => state.outcome === "refused");
      expect(winners).toHaveLength(1);
      expect(losers).toHaveLength(1);
      const winner = winners[0]!;
      expect(losers[0]).toMatchObject({
        message: expect.stringContaining(`owner pid ${winner.pid} is live`),
      });

      // Unclean stop: the lock directory stays behind with a dead owner.
      const winnerProcess = holders[states.indexOf(winner)]!;
      await killHard(winnerProcess);
      expect(fs.existsSync(`${dbPath}.lifecycle-lock`)).toBe(true);

      const nextStatePath = path.join(directory, "c.json");
      startHolder(dbPath, nextStatePath);
      const next = await waitFor(() => readState(nextStatePath), "restart after kill");
      expect(next.outcome).toBe("acquired");
      const owner = JSON.parse(
        await fsPromises.readFile(path.join(`${dbPath}.lifecycle-lock`, "owner.json"), "utf8"),
      );
      expect(owner.pid).toBe(next.pid);
    } finally {
      await Promise.all(children.splice(0).map(killHard));
      await fsPromises.rm(directory, { recursive: true, force: true });
    }
  }, 60_000);
});
