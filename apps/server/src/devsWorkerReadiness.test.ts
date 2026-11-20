import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevsOutboundWorker } from "./devsOutboundWorker";
import type { DevsFetch } from "./devsReports";
import { DevsMirror, devsWorkerReadiness, isFile } from "./devsWorkerReadiness";

const MINUTE = 60_000;
// Real time for file writes to finish while timers are faked.
const realSetTimeout = globalThis.setTimeout;
const settle = () => new Promise((resolve) => realSetTimeout(resolve, 50));
/** Waits in real time, for file writes under faked timers, until `done` holds. */
async function until(done: () => boolean) {
  for (let attempt = 0; attempt < 100 && !done(); attempt++) await settle();
}
const fakeTimers = () =>
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "setInterval", "clearInterval"] });
const directories: string[] = [];
afterEach(async () => {
  vi.useRealTimers();
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-worker-readiness-"));
  directories.push(root);
  return root;
}
const report = {
  id: "22222222-2222-2222-2222-222222222222",
  engine: "codex" as const,
  description: "window broken",
  context: "provider error",
};
const token = "worker-fixture-" + "b".repeat(40);
const lease = "lease-fixture-private-credential-123456789";

function mirrorFixture(
  stateDir: string,
  overrides: Partial<ConstructorParameters<typeof DevsMirror>[0]> = {},
) {
  let clock = 1_000_000_000_000;
  const fetches: number[] = [];
  let fail: Error | null = null;
  const mirror = new DevsMirror({
    stampFile: path.join(stateDir, "mirror-fetched.json"),
    now: () => clock,
    head: async () => "abc123\n",
    fetch: async (timeoutMs) => {
      fetches.push(timeoutMs);
      if (fail) throw fail;
    },
    ...overrides,
  });
  return {
    mirror,
    fetches,
    advance: (ms: number) => {
      clock += ms;
    },
    failWith: (error: Error | null) => {
      fail = error;
    },
  };
}

describe("developer worker repository mirror", () => {
  it("is not fresh until a fetch succeeds, then expires after its age limit", async () => {
    const { mirror, fetches, advance, failWith } = mirrorFixture(await directory());
    expect(mirror.isFresh()).toBe(false);
    failWith(new Error("Repair command timed out."));
    expect(await mirror.refresh()).toBe(false);
    expect(mirror.isFresh()).toBe(false);
    failWith(null);
    expect(await mirror.refresh()).toBe(true);
    expect(mirror.isFresh()).toBe(true);
    // A background fetch gets an hour, not the two minutes a job step gets.
    expect(fetches).toEqual([60 * MINUTE, 60 * MINUTE]);
    advance(121 * MINUTE);
    expect(mirror.isFresh()).toBe(false);
  });

  it("shares one fetch between callers that arrive while it runs", async () => {
    let release!: () => void;
    const fetch = vi.fn(() => new Promise<void>((resolve) => (release = resolve)));
    const { mirror } = mirrorFixture(await directory(), { fetch });
    const first = mirror.refresh();
    const second = mirror.refresh();
    release();
    expect(await Promise.all([first, second])).toEqual([true, true]);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it("keeps the fetch time across restarts only while the mirror holds the same commit", async () => {
    const stateDir = await directory();
    const first = mirrorFixture(stateDir);
    await first.mirror.refresh();
    const same = mirrorFixture(stateDir);
    await same.mirror.load();
    expect(same.mirror.isFresh()).toBe(true);
    const replaced = mirrorFixture(stateDir, { head: async () => "def456" });
    await replaced.mirror.load();
    expect(replaced.mirror.isFresh()).toBe(false);
  });

  it("skips a job's refresh when the mirror is recent and never waits for a background fetch", async () => {
    let hang = false;
    const fetch = vi.fn((_timeoutMs: number) =>
      hang ? new Promise<void>(() => {}) : Promise.resolve(),
    );
    const { mirror, advance } = mirrorFixture(await directory(), { fetch });
    await mirror.refresh();
    advance(5 * MINUTE);
    await mirror.topUp();
    expect(fetch).toHaveBeenCalledTimes(1);
    advance(10 * MINUTE);
    hang = true;
    void mirror.refresh();
    expect(fetch).toHaveBeenCalledTimes(2);
    // The background fetch never ends here; the job still goes on with the current mirror.
    await expect(mirror.topUp()).resolves.toBeUndefined();
    expect(fetch).toHaveBeenCalledTimes(2);
  });

  it("lets a job continue on a fresh mirror when its own refresh times out", async () => {
    const { mirror, fetches, advance, failWith } = mirrorFixture(await directory());
    await mirror.refresh();
    advance(30 * MINUTE);
    failWith(new Error("Repair command timed out."));
    await expect(mirror.topUp()).resolves.toBeUndefined();
    expect(fetches).toEqual([60 * MINUTE, 5 * MINUTE]);
  });

  it("stops a job before any change when the mirror is stale and GitHub is unreachable", async () => {
    const { mirror, failWith } = mirrorFixture(await directory());
    failWith(new Error("Repair command timed out."));
    await expect(mirror.topUp()).rejects.toThrow("repository mirror is out of date");
  });

  it("retries a failed background fetch with a backoff, then refreshes on a schedule", async () => {
    fakeTimers();
    const fetch = vi
      .fn<(timeoutMs: number) => Promise<void>>()
      .mockRejectedValueOnce(new Error("Repair command timed out."))
      .mockResolvedValue(undefined);
    const log = vi.fn();
    const { mirror } = mirrorFixture(await directory(), { fetch, log });
    mirror.start();
    await until(() => fetch.mock.calls.length === 1 && log.mock.calls.length === 1);
    expect(fetch).toHaveBeenCalledTimes(1);
    expect(mirror.isFresh()).toBe(false);
    // The retry timer is armed once the failed attempt has settled.
    await settle();
    await vi.advanceTimersByTimeAsync(2 * MINUTE);
    await until(() => log.mock.calls.length === 2);
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(mirror.isFresh()).toBe(true);
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      expect.stringContaining("Repository mirror refresh failed (Repair command timed out.)"),
      expect.stringContaining("refreshed after 1 failed attempt(s)"),
    ]);
    // The next refresh is scheduled once the stamp is written.
    for (let step = 0; step < 20 && fetch.mock.calls.length < 3; step++) {
      await settle();
      await vi.advanceTimersByTimeAsync(MINUTE);
    }
    expect(fetch).toHaveBeenCalledTimes(3);
    mirror.stop();
    await vi.advanceTimersByTimeAsync(60 * MINUTE);
    expect(fetch).toHaveBeenCalledTimes(3);
  });
});

describe("developer worker readiness before a claim", () => {
  it("claims nothing while the mirror has never been fetched, and claims once it has", async () => {
    const stateDir = await directory();
    const { mirror, failWith } = mirrorFixture(stateDir);
    const fetcher = vi.fn<DevsFetch>(async () => Response.json({ job: null }));
    const log = vi.fn();
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair: vi.fn(),
      ready: devsWorkerReadiness({ "repository mirror out of date": () => mirror.isFresh() }, log),
    });
    failWith(new Error("Repair command timed out."));
    await mirror.refresh();
    expect(await worker.runOnce()).toBe(false);
    expect(await worker.runOnce()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    failWith(null);
    await mirror.refresh();
    expect(await worker.runOnce()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(new URL(String(fetcher.mock.calls[0]![0])).pathname).toBe("/worker/claim");
    expect(log.mock.calls.map(([line]) => line)).toEqual([
      "Developer worker not ready (repository mirror out of date); reports stay in the queue.",
      "Developer worker ready; claiming reports again.",
    ]);
  });

  it("refuses to claim when the Codex executable is missing or a check throws", async () => {
    const stateDir = await directory();
    const fetcher = vi.fn<DevsFetch>(async () => Response.json({ job: null }));
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair: vi.fn(),
      ready: devsWorkerReadiness({
        "Codex executable missing": () => isFile(path.join(stateDir, "missing-codex.exe")),
        "Magpie unreachable": async () => {
          throw new TypeError("fetch failed");
        },
      }),
    });
    expect(await worker.runOnce()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    expect(await isFile(path.join(stateDir, "worker-journal.json"))).toBe(true);
  });

  it("keeps the lease alive while a job's slow refresh runs, then repairs on the warm mirror", async () => {
    fakeTimers();
    const stateDir = await directory();
    const routes: string[] = [];
    const fetcher: DevsFetch = async (url) => {
      const route = new URL(String(url)).pathname;
      routes.push(route);
      if (route.endsWith("claim")) return Response.json({ report, lease });
      return Response.json({ status: route.endsWith("complete") ? "pull-request" : "running" });
    };
    let clock = 1_000_000_000_000;
    let slowFetch = false;
    const mirror = new DevsMirror({
      stampFile: path.join(stateDir, "mirror-fetched.json"),
      now: () => clock,
      head: async () => "abc123",
      fetch: (timeoutMs) =>
        slowFetch
          ? new Promise<void>((_resolve, reject) =>
              setTimeout(() => reject(new Error("Repair command timed out.")), timeoutMs),
            )
          : Promise.resolve(),
    });
    await mirror.refresh();
    clock += 20 * MINUTE;
    slowFetch = true;
    const cloned = vi.fn(async () => "https://github.com/fixture/repo/pull/2");
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      ready: devsWorkerReadiness({ mirror: () => mirror.isFresh() }),
      repair: async () => {
        await mirror.topUp();
        return cloned();
      },
    });
    const state: { finished: boolean | null } = { finished: null };
    const run = worker.runOnce().then((result) => (state.finished = result));
    // Thirty-second steps with real pauses, so file writes between timers complete.
    for (let step = 0; step < 40 && state.finished === null; step++) {
      await settle();
      await vi.advanceTimersByTimeAsync(30_000);
    }
    expect(await run).toBe(true);
    expect(cloned).toHaveBeenCalledTimes(1);
    // Initial heartbeat plus one every 30 seconds during the five-minute refresh.
    expect(routes.filter((route) => route.endsWith("heartbeat")).length).toBeGreaterThanOrEqual(10);
    expect(routes.at(-1)).toBe(`/worker/${report.id}/complete`);
  });
});
