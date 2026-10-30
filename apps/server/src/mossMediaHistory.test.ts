import { mkdtemp, mkdir, rename, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { HoolaCanvasBridgeBroker, type HoolaCanvasDurableJob } from "./hoolaCanvasBridge";
import { MossMediaHistory } from "./mossMediaHistory";

const roots: string[] = [];
const scope = "a".repeat(64);
afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});
async function directory() {
  const root = await mkdtemp(join(tmpdir(), "moss-media-history-"));
  roots.push(root);
  return root;
}
function job(index: number, parent?: HoolaCanvasDurableJob, video = false): HoolaCanvasDurableJob {
  const broker = new HoolaCanvasBridgeBroker({ now: () => 1000 });
  broker.create({
    projectId: "images-workspace",
    operation: video ? "video" : "text_to_image",
    modelId: video ? "wan3.0-video" : "gpt-image-2-official",
    prompt: `image ${index}`,
    idempotencyKey: `key-${index}`,
    ...(parent
      ? { conversationId: parent.snapshot.conversationId, parentJobId: parent.snapshot.jobId }
      : {}),
  });
  const raw = broker.durableJobs()[0]!;
  return {
    ...raw,
    snapshot: {
      ...raw.snapshot,
      status: "succeeded",
      billingStatus: "captured",
      persistenceStatus: "ready",
      imageUrls: video ? [] : ["https://assets.example/image.png"],
      videoUrls: video ? ["https://assets.example/video.mp4"] : [],
    },
    checkpoint: {
      ...raw.checkpoint,
      status: "succeeded",
      billingStatus: "captured",
      outputPersistenceStatus: "ready",
      outputAssetUrl: "https://assets.example/image.png",
    },
  };
}

describe("durable media history", () => {
  it("never replaces a newer public revision with a delayed earlier checkpoint", async () => {
    const store = new MossMediaHistory(await directory());
    const first = job(1);
    const pending = {
      ...first,
      snapshot: {
        ...first.snapshot,
        status: "running" as const,
        billingStatus: "unknown" as const,
      },
      checkpoint: {
        ...first.checkpoint,
        status: "running" as const,
        billingStatus: "unknown" as const,
      },
    };
    await store.save(scope, pending);
    const earlierPage = await store.page(scope);
    await store.save(scope, { ...first, revision: 3 });
    await store.save(scope, pending);
    expect(earlierPage.jobs[0]).toMatchObject({ revision: 1, status: "running" });
    expect((await store.page(scope)).jobs[0]).toMatchObject({
      revision: 3,
      status: "succeeded",
      billingStatus: "captured",
    });
    expect(await store.hasProtectedJobs(scope)).toBe(false);
    expect((await store.get(scope, first.snapshot.jobId))?.checkpoint.revision).toBe(3);
  });
  it("retains more than 256 jobs across closed connections/restart and pages a fixed high-water mark", async () => {
    const root = await directory();
    const store = new MossMediaHistory(root);
    const jobs = Array.from({ length: 270 }, (_, i) => job(i));
    for (const item of jobs) await store.save(scope, item);
    let page = await store.page(scope, { kind: "image", limit: 23 });
    expect(page.jobs.map((item) => item.jobId)).toEqual(
      jobs
        .slice(-23)
        .toReversed()
        .map((item) => item.snapshot.jobId),
    );
    const newer = job(1000);
    await store.save(scope, newer);
    const restored = new MossMediaHistory(root);
    const seen = page.jobs.map((item) => item.jobId);
    while (page.nextCursor) {
      page = await restored.page(scope, { kind: "image", limit: 23, cursor: page.nextCursor });
      seen.push(...page.jobs.map((item) => item.jobId));
    }
    expect(seen).toHaveLength(270);
    expect(new Set(seen).size).toBe(270);
    expect(seen).not.toContain(newer.snapshot.jobId);
    expect(seen.at(-1)).toBe(jobs[0]!.snapshot.jobId);
    expect((await restored.get(scope, jobs[0]!.snapshot.jobId))?.snapshot).toEqual(
      jobs[0]!.snapshot,
    );
  });

  it("binds cursors to account, kind, conversation, signed position, and bounded input", async () => {
    const store = new MossMediaHistory(await directory());
    const first = job(1),
      second = job(2, first);
    await store.save(scope, first);
    await store.save(scope, second);
    const page = await store.page(scope, { kind: "image", limit: 1 });
    const cursor = page.nextCursor!;
    expect(cursor).toBeTypeOf("string");
    for (const input of [
      { kind: "video" as const, cursor },
      { kind: "image" as const, conversationId: first.snapshot.conversationId, cursor },
      { kind: "image" as const, cursor: cursor.slice(0, -1) + (cursor.endsWith("0") ? "1" : "0") },
      { cursor: "../../private" },
      { limit: 0 },
      { limit: 51 },
      { limit: 1.5 },
      { cursor: "x".repeat(1025) },
    ])
      await expect(store.page(scope, input)).rejects.toMatchObject({
        code: "invalid_history_cursor",
      });
    await expect(store.page("b".repeat(64), { kind: "image", cursor })).rejects.toMatchObject({
      code: "invalid_history_cursor",
    });
    const conversation = await store.page(scope, {
      kind: "image",
      conversationId: first.snapshot.conversationId,
      limit: 1,
    });
    expect(conversation.jobs[0]?.jobId).toBe(second.snapshot.jobId);
    expect(
      (
        await store.page(scope, {
          kind: "image",
          conversationId: first.snapshot.conversationId,
          cursor: conversation.nextCursor!,
        })
      ).jobs[0]?.jobId,
    ).toBe(first.snapshot.jobId);
  });

  it("atomically preserves identity and rejects foreign, cross-kind, incomplete, and changed parents", async () => {
    const store = new MossMediaHistory(await directory());
    const first = job(1),
      second = job(2, first);
    await expect(store.save(scope, second)).rejects.toMatchObject({ code: "invalid_conversation" });
    await store.save("b".repeat(64), first);
    await expect(store.save(scope, second)).rejects.toMatchObject({ code: "invalid_conversation" });
    const pending = {
      ...first,
      snapshot: { ...first.snapshot, status: "running" as const },
      checkpoint: { ...first.checkpoint, status: "running" as const },
    };
    await store.save(scope, pending);
    await expect(store.save(scope, second)).rejects.toMatchObject({ code: "invalid_conversation" });
    await store.save(scope, { ...first, revision: 2 });
    await expect(store.save(scope, job(3, first, true))).rejects.toMatchObject({
      code: "invalid_conversation",
    });
    await store.save(scope, second);
    await expect(
      store.save(scope, {
        ...second,
        snapshot: { ...second.snapshot, parentJobId: second.snapshot.jobId },
      }),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
    expect(
      (await store.find(scope, second.idempotencyIdentity, second.requestDigest))?.snapshot.jobId,
    ).toBe(second.snapshot.jobId);
    await expect(
      store.find(scope, second.idempotencyIdentity, "f".repeat(64)),
    ).rejects.toMatchObject({ code: "idempotency_conflict" });
  });

  it("does not erase prior committed history after a real filesystem failure", async () => {
    const root = await directory(),
      store = new MossMediaHistory(root),
      first = job(1);
    await store.save(scope, first);
    const database = join(root, "media-history", "history.sqlite");
    await rename(database, `${database}.saved`);
    await mkdir(database);
    await expect(store.save(scope, job(2))).rejects.toThrow();
    await rm(database, { recursive: true });
    await rename(`${database}.saved`, database);
    const page = await new MossMediaHistory(root).page(scope);
    expect(page.jobs).toEqual([first.snapshot]);
  });
});
