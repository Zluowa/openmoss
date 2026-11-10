import { createHash, randomUUID } from "node:crypto";
import { DEVS_ATTACHMENT_LIMITS } from "@moss/shared/devsReport";
import { describe, expect, it } from "vitest";
import { createCloudDevsQueue, FEEDBACK_BODY_LIMIT, type DevsQueueStore } from "./cloudQueue";

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
const workerToken = "worker-private-credential-for-queue-fixture";
const readToken = "report-read-capability-for-queue-fixture";
const call = (path: string, token = readToken, body?: unknown) =>
  new Request(`https://queue.test${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: { authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
const report = (install: string | null = randomUUID()) => ({
  id: randomUUID(),
  engine: "codex",
  description: "The window freezes",
  context: "Authorization: Bearer private-fixture-token",
  ...(install ? { install } : {}),
});
const DAY = 86_400_000;
// Node's `Response.json()` resolves to `unknown`; these tests read the queue's JSON freely.
type QueueResponse = Omit<Response, "json"> & { json(): Promise<any> };
function fixture(
  limits: { dailyReportLimit?: number; dailyJobLimit?: number; installDailyLimit?: number } = {},
) {
  const store = new MemoryStore();
  let time = 1_000_000;
  const handle = createCloudDevsQueue({
    store,
    workerToken,
    repository: "fixture/repo",
    engines: ["codex"],
    dailyReportLimit: 1_000,
    dailyJobLimit: 1_000,
    installDailyLimit: 1_000,
    ...limits,
    now: () => time,
  });
  return {
    store,
    handle: handle as (request: Request) => Promise<QueueResponse>,
    advance: (milliseconds: number) => {
      time += milliseconds;
    },
  };
}

describe("production developer report queue", () => {
  it("caps the reports it accepts each day, for everyone and for each installation", async () => {
    const { handle, advance } = fixture({ dailyReportLimit: 3, installDailyLimit: 2 });
    const install = randomUUID();
    expect((await handle(call("/reports", readToken, report(install)))).status).toBe(202);
    expect((await handle(call("/reports", readToken, report(install)))).status).toBe(202);
    const perInstall = await handle(call("/reports", readToken, report(install)));
    expect(perInstall.status).toBe(429);
    expect(Number(perInstall.headers.get("retry-after"))).toBeGreaterThan(0);
    expect((await handle(call("/reports", readToken, report()))).status).toBe(202);
    const global = await handle(call("/reports", readToken, report()));
    expect(global.status).toBe(429);
    expect(await global.json()).toEqual({ error: "Daily report limit reached" });
    advance(DAY);
    expect((await handle(call("/reports", readToken, report(install)))).status).toBe(202);
  });
  it("gives apps that send no installation ID one shared allowance", async () => {
    const { handle } = fixture({ installDailyLimit: 1 });
    expect((await handle(call("/reports", readToken, report(null)))).status).toBe(202);
    expect((await handle(call("/reports", readToken, report(null)))).status).toBe(429);
    expect(
      (await handle(call("/reports", readToken, { ...report(), install: "not-an-id" }))).status,
    ).toBe(400);
  });
  it("stops handing out jobs when the day's job budget is used", async () => {
    const { handle, advance } = fixture({ dailyJobLimit: 1 });
    await handle(call("/reports", readToken, report()));
    await handle(call("/reports", readToken, report()));
    const first = await (
      await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
    ).json();
    await handle(
      call(`/worker/${first.report.id}/complete`, workerToken, {
        lease: first.lease,
        pullRequestUrl: null,
      }),
    );
    expect(
      await (
        await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
      ).json(),
    ).toEqual({ job: null, budgetExhausted: true });
    advance(DAY);
    const next = await (
      await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
    ).json();
    expect(next.report.id).toMatch(/^[0-9a-f-]{36}$/);
  });
  it("redacts phone numbers, prose credentials and paths again before storing", async () => {
    const { handle, store } = fixture();
    await handle(
      call("/reports", readToken, {
        ...report(),
        description: "call 13812345678, my password is hunter2, see D:\\work\\acme\\a.ts",
      }),
    );
    const stored = JSON.stringify([...store.data.values()]);
    for (const secret of ["13812345678", "hunter2", "acme"]) expect(stored).not.toContain(secret);
  });
  it("expires abandoned running jobs before enforcing pending admission limits", async () => {
    const { handle, advance } = fixture();
    for (let index = 0; index < 100; index++)
      expect((await handle(call("/reports", readToken, report()))).status).toBe(202);
    await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }));
    expect((await handle(call("/reports", readToken, report()))).status).toBe(429);
    advance(120_001);
    expect((await handle(call("/reports", readToken, report()))).status).toBe(202);
  });
  it("durably accepts idempotent reports and isolates each report's read capability", async () => {
    const { handle, store } = fixture();
    const input = report();
    expect((await handle(call("/reports", "short", input))).status).toBe(401);
    expect((await handle(call("/reports", readToken, input))).status).toBe(202);
    expect((await handle(call("/reports", readToken, input))).status).toBe(200);
    expect(
      (await handle(call("/reports", "different-capability-long-enough-1234", input))).status,
    ).toBe(409);
    expect(
      (await handle(call(`/reports/${input.id}`, "another-report-capability-long-1234"))).status,
    ).toBe(404);
    const receipt = await (await handle(call(`/reports/${input.id}`))).json();
    expect(receipt).toMatchObject({ id: input.id, status: "queued" });
    expect(receipt).not.toHaveProperty("description");
    expect(JSON.stringify([...store.data.values()])).not.toContain(readToken);
    expect(JSON.stringify([...store.data.values()])).not.toContain("private-fixture-token");
  });
  it("only allows the private worker to claim once, heartbeat and publish a bounded same-repository receipt", async () => {
    const { handle } = fixture();
    const input = report();
    await handle(call("/reports", readToken, input));
    const claimId = randomUUID();
    expect(
      (await handle(call("/worker/claim", readToken, { claimId, engine: "codex" }))).status,
    ).toBe(401);
    const first = await (
      await handle(call("/worker/claim", workerToken, { claimId, engine: "codex" }))
    ).json();
    expect(first.report.id).toBe(input.id);
    expect(
      await (await handle(call("/worker/claim", workerToken, { claimId, engine: "codex" }))).json(),
    ).toEqual(first);
    expect(
      await (
        await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
      ).json(),
    ).toEqual({ job: null });
    expect(
      (await handle(call(`/worker/${input.id}/heartbeat`, workerToken, { lease: "wrong" }))).status,
    ).toBe(409);
    expect(
      (
        await handle(
          call(`/worker/${input.id}/complete`, workerToken, {
            lease: first.lease,
            pullRequestUrl: "https://github.com/other/repo/pull/1",
          }),
        )
      ).status,
    ).toBe(400);
    const completion = {
      lease: first.lease,
      pullRequestUrl: "https://github.com/fixture/repo/pull/1",
    };
    const result = await (
      await handle(call(`/worker/${input.id}/complete`, workerToken, completion))
    ).json();
    expect(result.status).toBe("pull-request");
    expect(
      await (
        await handle(
          call(`/worker/${input.id}/complete`, workerToken, {
            ...completion,
            pullRequestUrl: null,
          }),
        )
      ).json(),
    ).toEqual(result);
    expect(
      await (
        await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
      ).json(),
    ).toEqual({ job: null });
  });
  it("does not replay an interrupted repair after lease expiration or service recreation", async () => {
    const { handle, store, advance } = fixture();
    const input = report();
    await handle(call("/reports", readToken, input));
    const first = await (
      await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
    ).json();
    advance(100_000);
    expect(
      (await handle(call(`/worker/${input.id}/heartbeat`, workerToken, { lease: first.lease })))
        .status,
    ).toBe(200);
    advance(120_001);
    expect((await (await handle(call(`/reports/${input.id}`))).json()).status).toBe("failed");
    const restarted = createCloudDevsQueue({
      store,
      workerToken,
      repository: "fixture/repo",
      engines: ["codex"],
    });
    expect(
      await (
        await restarted(
          call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }),
        )
      ).json(),
    ).toEqual({ job: null });
  });
  it("serializes simultaneous claims and rejects unsupported or oversized reports", async () => {
    const { handle } = fixture();
    const input = report();
    await handle(call("/reports", readToken, input));
    const claims = await Promise.all(
      [1, 2].map(async () =>
        (
          await handle(
            call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }),
          )
        ).json(),
      ),
    );
    expect(claims.filter((value) => value.report)).toHaveLength(1);
    expect(
      (await handle(call("/reports", readToken, { ...report(), engine: "claude" }))).status,
    ).toBe(400);
    expect(
      (await handle(call("/reports", readToken, { ...report(), description: "a".repeat(64_001) })))
        .status,
    ).toBe(400);
  });
  it("takes only declared attachments from the report's owner, and drops them once the job ends", async () => {
    const { handle, store } = fixture();
    const text = new TextEncoder().encode("TypeError: canvas\n");
    const sha256 = createHash("sha256").update(text).digest("hex");
    const input = {
      ...report(),
      attachments: [
        {
          name: "C:\\Users\\owner\\console.log",
          kind: "text",
          mimeType: "text/plain",
          size: text.length,
          sha256,
        },
      ],
    };
    expect((await handle(call("/reports", readToken, input))).status).toBe(202);
    const put = (token: string, body: Uint8Array<ArrayBuffer>, index = 0, type = "text/plain") =>
      handle(
        new Request(`https://queue.test/reports/${input.id}/attachments/${index}`, {
          method: "PUT",
          headers: { authorization: `Bearer ${token}`, "content-type": type },
          body,
        }),
      );
    const claim = () =>
      handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }));
    // Waiting for its attachment, the job is not handed out yet.
    expect(await (await claim()).json()).toEqual({ job: null });
    expect((await put("someone-else-entirely-with-a-long-token", text)).status).toBe(404);
    expect((await put(readToken, new TextEncoder().encode("different bytes!!!\n"))).status).toBe(
      400,
    );
    expect((await put(readToken, text, 1)).status).toBe(400);
    expect((await put(readToken, text, 0, "image/png")).status).toBe(400);
    const stored = await put(readToken, text);
    expect(await stored.json()).toMatchObject({ attachments: { count: 1, received: 1 } });
    const job = await (await claim()).json();
    expect(job.report.attachments).toEqual([
      {
        index: 0,
        name: "console.log",
        kind: "text",
        mimeType: "text/plain",
        size: text.length,
        sha256,
      },
    ]);
    // Already stored: an idempotent retry; the report is no longer waiting for anything.
    expect((await put(readToken, text)).status).toBe(200);
    const download = (lease: string) =>
      handle(call(`/worker/${input.id}/attachment`, workerToken, { lease, index: 0 }));
    expect((await download("not-the-lease-at-all-not-the-lease-at-all")).status).toBe(409);
    expect(new Uint8Array(await (await download(job.lease)).arrayBuffer())).toEqual(text);
    await handle(
      call(`/worker/${input.id}/complete`, workerToken, { lease: job.lease, pullRequestUrl: null }),
    );
    expect([...store.data.keys()].some((key) => key.startsWith("attachment:"))).toBe(false);
  });
  it("refuses attachment manifests beyond the limits", async () => {
    const { handle } = fixture();
    const entry = {
      name: "a.png",
      kind: "image",
      mimeType: "image/png",
      size: 10,
      sha256: "a".repeat(64),
    };
    for (const attachments of [
      [{ ...entry, size: 400_001 }],
      [{ ...entry, kind: "text" }],
      [{ ...entry, mimeType: "application/zip" }],
      Array.from({ length: DEVS_ATTACHMENT_LIMITS.maxCount + 1 }, () => entry),
    ])
      expect((await handle(call("/reports", readToken, { ...report(), attachments }))).status).toBe(
        400,
      );
  });
});

const png = (size = 64) => {
  const bytes = new Uint8Array(size);
  bytes.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  return bytes;
};
const base64 = (bytes: Uint8Array) => Buffer.from(bytes).toString("base64");
const feedback = (overrides: Record<string, unknown> = {}) => ({
  id: randomUUID(),
  category: "bug",
  details: "The send button stays grey. Call me on 13812345678.",
  summary: "I ran into a bug in Moss 1.0.5.\n\nPlatform: Win32, file C:\\Users\\owner\\secret.txt",
  ...overrides,
});
const postFeedback = (body: unknown, address = "203.0.113.7") =>
  new Request("https://queue.test/feedback", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": address },
    body: typeof body === "string" ? body : JSON.stringify(body),
  });

describe("分享反馈 feedback", () => {
  it("queues feedback with its images for the repair worker, redacted like a report", async () => {
    const { handle, store } = fixture();
    const image = png(200);
    const input = feedback({
      attachments: [
        { name: "D:\\shots\\screen 1.png", mimeType: "image/png", dataBase64: base64(image) },
      ],
    });
    const accepted = await handle(postFeedback(input));
    expect(accepted.status).toBe(202);
    expect(await accepted.json()).toMatchObject({
      id: input.id,
      status: "queued",
      attachments: { count: 1, received: 1 },
    });
    const job = await (
      await handle(call("/worker/claim", workerToken, { claimId: randomUUID(), engine: "codex" }))
    ).json();
    expect(job.report.id).toBe(input.id);
    expect(job.report.engine).toBe("codex");
    expect(job.report.description).toContain("Moss feedback (Bug): The send button stays grey.");
    expect(job.report.description).toContain("<phone>");
    expect(job.report.description).not.toContain("13812345678");
    expect(job.report.context).not.toContain("owner");
    expect(job.report.attachments).toEqual([
      {
        index: 0,
        name: "screen 1.png",
        kind: "image",
        mimeType: "image/png",
        size: image.length,
        sha256: createHash("sha256").update(image).digest("hex"),
      },
    ]);
    const download = await handle(
      call(`/worker/${input.id}/attachment`, workerToken, { lease: job.lease, index: 0 }),
    );
    expect(download.headers.get("content-type")).toBe("image/png");
    expect(new Uint8Array(await download.arrayBuffer())).toEqual(image);
    await handle(
      call(`/worker/${input.id}/complete`, workerToken, { lease: job.lease, pullRequestUrl: null }),
    );
    expect([...store.data.keys()].some((key) => key.startsWith("attachment:"))).toBe(false);
  });
  it("accepts feedback without a category or images, and retries with its capability idempotently", async () => {
    const { handle } = fixture();
    const input = feedback({ category: null });
    const send = () =>
      handle(
        new Request("https://queue.test/feedback", {
          method: "POST",
          headers: { authorization: `Bearer ${readToken}` },
          body: JSON.stringify(input),
        }),
      );
    expect((await send()).status).toBe(202);
    expect((await send()).status).toBe(200);
    // Without the capability, nobody can read it back or claim its ID.
    expect((await handle(postFeedback(input))).status).toBe(409);
    expect(
      (await handle(call(`/reports/${input.id}`, "someone-else-entirely-with-a-long-token")))
        .status,
    ).toBe(404);
  });
  it("refuses feedback that is malformed, mistyped or beyond the attachment limits", async () => {
    const { handle } = fixture();
    const image = { name: "a.png", mimeType: "image/png", dataBase64: base64(png()) };
    for (const input of [
      feedback({ id: "not-a-uuid" }),
      feedback({ category: "billing" }),
      feedback({ details: "   " }),
      feedback({ details: "a".repeat(5_001) }),
      feedback({ summary: 42 }),
      feedback({ attachments: [{ ...image, mimeType: "image/gif" }] }),
      feedback({ attachments: [{ ...image, mimeType: "image/jpeg" }] }),
      feedback({ attachments: [{ ...image, dataBase64: "not base64!" }] }),
      feedback({ attachments: [{ ...image, dataBase64: base64(png(400_001)) }] }),
      feedback({
        attachments: Array.from({ length: DEVS_ATTACHMENT_LIMITS.maxCount + 1 }, () => image),
      }),
    ])
      expect((await handle(postFeedback(input))).status).toBe(400);
    expect((await handle(postFeedback("{"))).status).toBe(413);
    expect((await handle(postFeedback("x".repeat(FEEDBACK_BODY_LIMIT + 1)))).status).toBe(413);
  });
  it("takes five full-size images at once", async () => {
    const { handle } = fixture();
    const image = {
      name: "a.png",
      mimeType: "image/png",
      dataBase64: base64(png(DEVS_ATTACHMENT_LIMITS.imageBytes)),
    };
    const response = await handle(
      postFeedback(feedback({ attachments: Array.from({ length: 5 }, () => image) })),
    );
    expect(response.status).toBe(202);
    expect(await response.json()).toMatchObject({ attachments: { count: 5, received: 5 } });
  });
  it("counts feedback against the daily caps, per sending address", async () => {
    const { handle } = fixture({ dailyReportLimit: 3, installDailyLimit: 2 });
    expect((await handle(postFeedback(feedback()))).status).toBe(202);
    expect((await handle(postFeedback(feedback()))).status).toBe(202);
    expect((await handle(postFeedback(feedback()))).status).toBe(429);
    expect((await handle(postFeedback(feedback(), "198.51.100.9"))).status).toBe(202);
    expect((await handle(call("/reports", readToken, report()))).status).toBe(429);
  });
});
