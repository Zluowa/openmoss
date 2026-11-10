// The whole @devs path against the real queue code with an in-memory store: the app sends a
// report with a screenshot and a log, the queue holds the job until both arrive, the worker
// claims it, downloads them and hands them to the repair, and the app's card follows along.
import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, expect, it } from "vitest";
import { ThreadId, type OrchestrationThread } from "@moss/contracts";
import { createCloudDevsQueue, type DevsQueueStore } from "../../../scripts/devs/cloudQueue";
import { DevsReports, type DevsFetch } from "./devsReports";
import { DevsOutboundWorker, describeWorkerError, WorkerRequestError } from "./devsOutboundWorker";
import type { RepairReport } from "./devsRepairRunner";

class MemoryStore implements DevsQueueStore {
  data = new Map<string, unknown>();
  private chain = Promise.resolve();
  async get<T>(key: string) {
    return structuredClone(this.data.get(key)) as T | undefined;
  }
  async put<T>(key: string, value: T) {
    this.data.set(key, structuredClone(value));
  }
  async delete(key: string) {
    this.data.delete(key);
  }
  transaction<T>(action: (store: DevsQueueStore) => Promise<T>): Promise<T> {
    const result = this.chain.then(() => action(this));
    this.chain = result.then(
      () => {},
      () => {},
    );
    return result;
  }
}
const thread = {
  modelSelection: { provider: "codex", model: "test-model" },
  session: { status: "ready" },
  latestTurn: { state: "completed" },
  messages: [],
  activities: [],
} as unknown as OrchestrationThread;
// A 1x1 WebP, as the app's re-encoder produces.
const WEBP = Buffer.from("UklGRiQAAABXRUJQVlA4IBgAAAAwAQCdASoBAAEAAwA0JaQAA3AA/vuUAAA=", "base64");
const cleanup: Array<() => Promise<unknown> | unknown> = [];
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close();
});

async function setup(options: { attachmentsOnQueue?: boolean } = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-pipeline-"));
  cleanup.push(() => fs.rm(root, { recursive: true, force: true }));
  let time = Date.parse("2026-11-05T05:15:00Z");
  const store = new MemoryStore();
  const workerToken = "worker-private-credential-for-pipeline-fixture";
  const handle = createCloudDevsQueue({
    store,
    workerToken,
    repository: "fixture/repo",
    engines: ["codex"],
    now: () => time,
  });
  const requests: string[] = [];
  const queue: DevsFetch = async (url, init) => {
    const target = url instanceof Request ? url.url : url instanceof URL ? url.href : url;
    const request = new Request(target, init as RequestInit);
    const route = `${request.method} ${new URL(request.url).pathname}`;
    requests.push(route);
    // The queue deployed today has no attachment routes.
    if (options.attachmentsOnQueue === false && route.includes("/attachment"))
      return Response.json({ error: "Not found" }, { status: 404 });
    return handle(request);
  };
  const app = new DevsReports(
    path.join(root, "app"),
    queue,
    { MOSS_DEVS_REPORT_URL: "https://queue.test/reports" },
    { now: () => time },
  );
  cleanup.push(() => app.close());
  await fs.mkdir(path.join(root, "app"), { recursive: true });
  const repaired: { report: RepairReport; files: Record<string, string> }[] = [];
  const worker = new DevsOutboundWorker({
    queueUrl: "https://queue.test",
    token: workerToken,
    stateDir: path.join(root, "worker"),
    fetcher: queue,
    now: () => time,
    repair: async (report) => {
      const files: Record<string, string> = {};
      for (const attachment of report.attachments ?? [])
        if (attachment.path)
          files[attachment.name] = (await fs.readFile(attachment.path)).toString("base64");
      repaired.push({ report, files });
      return "https://github.com/fixture/repo/pull/7";
    },
  });
  await fs.mkdir(path.join(root, "worker"), { recursive: true });
  const advance = (ms: number) => {
    time += ms;
  };
  return { app, worker, requests, repaired, advance, store };
}

async function sendReport(app: DevsReports, threadId: ThreadId) {
  const input = {
    id: randomUUID(),
    threadId,
    text: "@devs 画布打不开",
    attachments: [
      {
        name: "C:\\Users\\owner\\Desktop\\screen.png",
        kind: "image" as const,
        mimeType: "image/webp" as const,
        dataBase64: WEBP.toString("base64"),
      },
      {
        name: "console.log",
        kind: "text" as const,
        mimeType: "text/plain" as const,
        dataBase64: Buffer.from("TypeError: canvas\r\ntoken: abcdefSECRET123\r\n").toString(
          "base64",
        ),
      },
    ],
  };
  const preview = await app.prepare(input, thread, { phoneAccount: false });
  const { attachments: _bytes, ...submit } = input;
  await app.submit(submit);
  return { id: input.id, preview };
}

it("carries a report's screenshot and text file through the queue to the repair", async () => {
  const { app, worker, requests, repaired, advance } = await setup();
  const threadId = ThreadId.makeUnsafe("pipeline-chat");
  const { id, preview } = await sendReport(app, threadId);
  // The confirmation shows a folder-free name and the redacted text that will be sent.
  expect(preview.attachments?.map((attachment) => attachment.name)).toEqual([
    "screen.png",
    "console.log",
  ]);
  expect(preview.attachments?.[1]?.text).toContain("TypeError: canvas");
  expect(preview.attachments?.[1]?.text).not.toContain("abcdefSECRET123");
  let [card] = (await app.list(threadId)).reports;
  expect(card).toMatchObject({ delivered: false, attachments: { count: 2, delivered: 0 } });

  await app.poll();
  expect(requests).toEqual([
    "POST /reports",
    `PUT /reports/${id}/attachments/0`,
    `PUT /reports/${id}/attachments/1`,
  ]);
  [card] = (await app.list(threadId)).reports;
  expect(card).toMatchObject({
    status: "queued",
    delivered: true,
    attachments: { count: 2, delivered: 2, missed: false },
  });

  expect(await worker.runOnce()).toBe(true);
  expect(repaired).toHaveLength(1);
  expect(repaired[0]!.report.description).toBe("画布打不开");
  expect(repaired[0]!.files["screen.png"]).toBe(WEBP.toString("base64"));
  expect(Buffer.from(repaired[0]!.files["console.log"]!, "base64").toString()).toContain(
    "TypeError: canvas",
  );

  advance(20_000);
  await app.poll();
  [card] = (await app.list(threadId)).reports;
  expect(card).toMatchObject({
    status: "pull-request",
    pullRequestUrl: "https://github.com/fixture/repo/pull/7",
  });
});

it("holds a job until its attachments arrive, then lets a worker take it after the grace period", async () => {
  const { app, worker, repaired, advance } = await setup({ attachmentsOnQueue: false });
  const threadId = ThreadId.makeUnsafe("pipeline-old-queue");
  await sendReport(app, threadId);
  await app.poll();
  let [card] = (await app.list(threadId)).reports;
  // Delivered, but the queue could not take the attachments yet: the app keeps them and says so.
  expect(card).toMatchObject({ delivered: true, attachments: { count: 2, delivered: 0 } });
  expect(await worker.runOnce()).toBe(false);
  advance(11 * 60_000);
  expect(await worker.runOnce()).toBe(true);
  expect(repaired[0]!.report.attachments ?? []).toEqual([]);
  advance(20_000);
  await app.poll();
  [card] = (await app.list(threadId)).reports;
  expect(card).toMatchObject({
    status: "pull-request",
    attachments: { count: 2, delivered: 0, missed: true },
  });
});

it("names why the queue was unreachable without echoing the request", () => {
  expect(describeWorkerError(new WorkerRequestError(503))).toBe("HTTP 503");
  expect(describeWorkerError(new DOMException("t", "TimeoutError"))).toBe("timed out");
  expect(
    describeWorkerError(
      Object.assign(new TypeError("fetch failed https://x?token=1"), { code: "ECONNRESET" }),
    ),
  ).toBe("network ECONNRESET");
  expect(describeWorkerError(new TypeError("fetch failed https://x?token=1"))).toBe(
    "network error",
  );
});
