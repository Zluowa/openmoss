import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevsOutboundWorker } from "./devsOutboundWorker";
import type { DevsFetch } from "./devsReports";

const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
async function directory() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-outbound-worker-"));
  directories.push(root);
  return root;
}
const report = {
  id: "11111111-1111-1111-1111-111111111111",
  engine: "codex" as const,
  description: "window broken",
  context: "provider error",
};
const token = "worker-fixture-" + "a".repeat(40);
const lease = "lease-fixture-private-credential-123456789";
describe("outbound-only maintainer worker", () => {
  it("leaves reports queued while Magpie is unavailable, then claims once it is ready", async () => {
    const stateDir = await directory();
    let available = false;
    const fetcher = vi.fn<DevsFetch>(async () => Response.json({ job: null }));
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair: vi.fn(),
      ready: async () => available,
    });
    expect(await worker.runOnce()).toBe(false);
    expect(fetcher).not.toHaveBeenCalled();
    available = true;
    expect(await worker.runOnce()).toBe(false);
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it("returns progress and the real repair receipt without sharing worker credentials with repair callbacks", async () => {
    const events: string[] = [];
    const fetcher: DevsFetch = async (url, options) => {
      expect(new Headers(options?.headers).get("authorization")).toBe(`Bearer ${token}`);
      const route = new URL(String(url)).pathname;
      events.push(route);
      if (route.endsWith("claim")) return Response.json({ report, lease });
      return Response.json({ status: route.endsWith("complete") ? "pull-request" : "running" });
    };
    const repair = vi.fn(async (input, authorize) => {
      expect(input).toEqual(report);
      expect(JSON.stringify(input)).not.toContain(token);
      await authorize();
      return "https://github.com/fixture/repo/pull/1";
    });
    const stateDir = await directory();
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair,
    });
    expect(await worker.runOnce()).toBe(true);
    expect(repair).toHaveBeenCalledTimes(1);
    expect(events).toEqual([
      "/worker/claim",
      `/worker/${report.id}/heartbeat`,
      `/worker/${report.id}/heartbeat`,
      `/worker/${report.id}/complete`,
    ]);
    await expect(fs.stat(path.join(stateDir, "worker-journal.json"))).rejects.toThrow();
  });
  it("retries an unknown completion receipt after restart without running the model twice", async () => {
    const stateDir = await directory();
    let completeAttempts = 0;
    const fetcher: DevsFetch = async (url) => {
      const route = new URL(String(url)).pathname;
      if (route.endsWith("claim")) return Response.json({ report, lease });
      if (route.endsWith("complete") && ++completeAttempts === 1) throw new Error("response lost");
      return Response.json({ status: route.endsWith("complete") ? "pull-request" : "running" });
    };
    const repair = vi.fn(async () => "https://github.com/fixture/repo/pull/1");
    const config = { queueUrl: "https://queue.test", token, stateDir, fetcher, repair };
    await expect(new DevsOutboundWorker(config).runOnce()).rejects.toThrow("response lost");
    await new DevsOutboundWorker(config).runOnce();
    expect(repair).toHaveBeenCalledTimes(1);
    expect(completeAttempts).toBe(2);
  });
  it("fails an interrupted job conservatively and never replays a possibly completed push", async () => {
    const stateDir = await directory();
    await fs.writeFile(
      path.join(stateDir, "worker-journal.json"),
      JSON.stringify({ claimId: randomUUID(), stage: "running", report, lease }),
    );
    const fetcher = vi.fn<DevsFetch>(async (_url, options) => {
      expect(JSON.parse(String(options?.body)).pullRequestUrl).toBeNull();
      return Response.json({ status: "failed" });
    });
    const repair = vi.fn();
    await new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair,
    }).runOnce();
    expect(repair).not.toHaveBeenCalled();
    expect(fetcher).toHaveBeenCalledTimes(1);
  });
  it.each([404, 409])(
    "archives an expired completion (%s) and continues with new claims",
    async (status) => {
      const stateDir = await directory();
      await fs.writeFile(
        path.join(stateDir, "worker-journal.json"),
        JSON.stringify({
          claimId: randomUUID(),
          stage: "completed",
          report,
          lease,
          pullRequestUrl: null,
        }),
      );
      const fetcher = vi.fn<DevsFetch>(async (url) => {
        if (String(url).endsWith("/complete")) return new Response(null, { status });
        return Response.json({ job: null });
      });
      const repair = vi.fn();
      const worker = new DevsOutboundWorker({
        queueUrl: "https://queue.test",
        token,
        stateDir,
        fetcher,
        repair,
      });
      expect(await worker.runOnce()).toBe(true);
      expect(await worker.runOnce()).toBe(false);
      expect(repair).not.toHaveBeenCalled();
      expect(
        (await fs.readdir(stateDir)).filter((name) => name.startsWith("worker-closed-")),
      ).toHaveLength(1);
      expect(fetcher).toHaveBeenCalledTimes(2);
    },
  );
  it("stops claiming once the day's job budget is used and resumes the next UTC day", async () => {
    const stateDir = await directory();
    let time = Date.parse("2026-11-03T10:00:00Z");
    const claims: string[] = [];
    const fetcher: DevsFetch = async (url) => {
      const route = new URL(String(url)).pathname;
      if (!route.endsWith("claim"))
        return Response.json({ status: route.endsWith("complete") ? "failed" : "running" });
      claims.push(route);
      return Response.json({ report: { ...report, id: randomUUID() }, lease });
    };
    const repair = vi.fn(async () => "https://github.com/fixture/repo/pull/1");
    const worker = new DevsOutboundWorker({
      queueUrl: "https://queue.test",
      token,
      stateDir,
      fetcher,
      repair,
      dailyJobLimit: 2,
      now: () => time,
    });
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(true);
    expect(await worker.runOnce()).toBe(false);
    expect(claims).toHaveLength(2);
    expect(repair).toHaveBeenCalledTimes(2);
    time += 86_400_000;
    expect(await worker.runOnce()).toBe(true);
    expect(claims).toHaveLength(3);
  });
});
