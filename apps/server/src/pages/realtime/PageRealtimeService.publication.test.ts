import { randomUUID } from "node:crypto";
import { ThreadId } from "@moss/contracts";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";

import { LOCAL_PAGES_PRINCIPAL as user } from "../Services/PagesService";
import { sourceKey } from "./PageRealtimeRoom";
import { appendRoomUpdate, commitRoomCheckpoint } from "./pageRoomPublication";
import { applyPlateValue, readPageDoc, seedPageDoc } from "./pageYjsContent";
import { makePageRealtimeSqliteHarness as fixture } from "./testing/pageRealtimeSqliteHarness";
import { sendRoomEdit } from "./testing/sendRoomEdit";

type Harness = Awaited<ReturnType<typeof fixture>>;
const p = (text: string) => ({ type: "p", children: [{ text }] });
const page = (h: Harness) => h.run(h.base.read({ scopeSpaceId: null, pageId: h.page.id }, user));
const issue = (h: Harness) =>
  h.run(h.realtime.issueToken({ scopeSpaceId: null, pageId: h.page.id }, user));
const join = (h: Harness, token: string) =>
  h.realtime.join({
    pageId: h.page.id,
    token,
    connection: (mode) => ({ mode, send: () => {}, close: () => {} }),
  });
async function connect(h: Harness) {
  const joined = await join(h, (await issue(h)).token);
  if (!joined) throw new Error("Fixture failed to join Page room");
  return joined;
}
function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
async function checkpoint(h: Harness) {
  const [row] = await h.run(h.sql<{
    state: Uint8Array;
    compacted_revision: number;
    compacted_through_sequence: number;
  }>`
    SELECT state,compacted_revision,compacted_through_sequence FROM pages_realtime_docs WHERE page_id=${h.page.id}`);
  if (!row) throw new Error("No room checkpoint");
  const decoded = new Y.Doc();
  try {
    Y.applyUpdate(decoded, row.state);
    return {
      body: readPageDoc(decoded),
      revision: row.compacted_revision,
      through: row.compacted_through_sequence,
    };
  } finally {
    decoded.destroy();
  }
}
const journal = (h: Harness) =>
  h.run(h.sql`SELECT seq FROM pages_realtime_updates WHERE page_id=${h.page.id} ORDER BY seq`);
const blockAppend = (h: Harness) =>
  h.run(h.sql`CREATE TRIGGER fixture_block BEFORE INSERT ON pages_realtime_updates
  BEGIN SELECT RAISE(ABORT,'fixture append unavailable'); END`);
const unblock = (h: Harness) => h.run(h.sql`DROP TRIGGER IF EXISTS fixture_block`);
function noAutomaticTimer() {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
}

describe("SQLite Page publication cuts", () => {
  it("rolls back Page body, version, original request bookkeeping, snapshot and prune together", async () => {
    const h = await fixture();
    noAutomaticTimer();
    try {
      const { room } = await connect(h);
      const requests = () =>
        h.run(h.sql`SELECT actor_key,request_id FROM pages_requests ORDER BY request_id`);
      const initialRequests = await requests();
      await h.run(h.sql`CREATE TRIGGER fixture_block BEFORE INSERT ON pages_realtime_snapshots WHEN NEW.revision > 1
        BEGIN SELECT RAISE(ABORT,'fixture publication failure'); END`);
      applyPlateValue(room.doc, [p("A")], "local");
      await expect(room.compact()).rejects.toBeDefined();
      expect((await page(h)).content).toBe("original");
      expect(
        await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${h.page.id}`),
      ).toEqual([{ revision: 1 }]);
      expect(await requests()).toEqual(initialRequests);
      expect(
        await h.run(h.sql`SELECT * FROM pages_version_contributors WHERE page_id=${h.page.id}`),
      ).toEqual([]);
      expect(await checkpoint(h)).toEqual({ body: [p("original")], revision: 1, through: 0 });
      expect(await journal(h)).toEqual([{ seq: 1 }]);
      await unblock(h);
      await room.compact();
      expect((await page(h)).content).toBe("A");
      expect(await checkpoint(h)).toEqual({ body: [p("A")], revision: 2, through: 1 });
      expect(await journal(h)).toEqual([]);
    } finally {
      await unblock(h);
      await h.close();
      vi.useRealTimers();
    }
  });

  it("does not checkpoint B when it arrives during Page write A in the real transaction", async () => {
    const h = await fixture();
    const entered = barrier();
    const release = barrier();
    noAutomaticTimer();
    try {
      const { room, connection } = await connect(h);
      h.controls.write = async () => {
        entered.release();
        await release.promise;
      };
      expect(sendRoomEdit(room, connection, [p("A")])).toBe(true);
      const first = room.compact();
      await entered.promise;
      expect(sendRoomEdit(room, connection, [p("A"), p("B")])).toBe(true);
      release.release();
      await first;
      expect(JSON.parse((await page(h)).richContent!)).toEqual([p("A")]);
      expect(await checkpoint(h)).toEqual({ body: [p("A")], revision: 2, through: 1 });
      await room.persist();
      expect(await journal(h)).toEqual([{ seq: 2 }]);
      await room.compact();
      expect(JSON.parse((await page(h)).richContent!)).toEqual([p("A"), p("B")]);
      expect(await checkpoint(h)).toEqual({ body: [p("A"), p("B")], revision: 3, through: 2 });
      expect(await journal(h)).toEqual([]);
      const history = await h.run(
        h.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, user),
      );
      expect(history.versions.slice(0, 2).map((record) => record.contributors)).toEqual([
        [{ kind: "local-user" }],
        [{ kind: "local-user" }],
      ]);
    } finally {
      release.release();
      await h.close();
      vi.useRealTimers();
    }
  });

  it("keeps an accepted edit and undo as one attributable version even when visible text returns to the original", async () => {
    const h = await fixture();
    noAutomaticTimer();
    try {
      const { room, connection } = await connect(h);
      expect(sendRoomEdit(room, connection, [p("temporary text")])).toBe(true);
      expect(sendRoomEdit(room, connection, [p("original")])).toBe(true);
      await room.compact();
      await room.compact();
      const versions = await h.run(
        h.pages.versions({ scopeSpaceId: null, pageId: h.page.id }, user),
      );
      expect(versions.versions).toHaveLength(2);
      expect(versions.versions[0]).toMatchObject({
        content: "original",
        contributors: [{ kind: "local-user" }],
      });
      expect(versions.versions[1]?.contributors).toBeUndefined();
    } finally {
      await h.close();
      vi.useRealTimers();
    }
  });

  it("replays legacy NULL and accepted agent audit from SQLite without inventing a local editor", async () => {
    const h = await fixture();
    const doc = new Y.Doc();
    noAutomaticTimer();
    try {
      const threadId = randomUUID();
      const projectId = randomUUID();
      await h.run(h.sql`INSERT INTO projection_projects(project_id,title,workspace_root,scripts_json,created_at,updated_at)
        VALUES(${projectId},'history fixture','/fixture','[]','2026-11-06','2026-11-06')`);
      await h.run(h.sql`INSERT INTO projection_threads(thread_id,project_id,title,created_at,updated_at)
        VALUES(${threadId},${projectId},'room fixture','2026-11-06','2026-11-06')`);
      const old = await page(h);
      seedPageDoc(doc, [p("original")]);
      await h.run(
        commitRoomCheckpoint(h.sql, h.page.id, {
          generation: "g",
          revision: 1,
          throughSequence: 0,
          state: Y.encodeStateAsUpdate(doc),
          key: sourceKey({ content: old.content, richContent: old.richContent ?? null }),
        }),
      );
      let before = Y.encodeStateVector(doc);
      applyPlateValue(doc, [p("legacy edit")], null);
      await h.run(appendRoomUpdate(h.sql, h.page.id, "g", Y.encodeStateAsUpdate(doc, before), []));
      await h.run(
        h.sql`UPDATE pages_realtime_updates SET contributors_json=NULL WHERE page_id=${h.page.id} AND seq=1`,
      );
      before = Y.encodeStateVector(doc);
      applyPlateValue(doc, [p("legacy edit"), p("agent edit")], null);
      const agent = { kind: "agent" as const, threadId: ThreadId.makeUnsafe(threadId) };
      await h.run(
        appendRoomUpdate(h.sql, h.page.id, "g", Y.encodeStateAsUpdate(doc, before), [agent]),
      );
      await connect(h);
      const versions = await h.run(
        h.pages.versions({ scopeSpaceId: null, pageId: h.page.id, summaryOnly: true }, user),
      );
      expect(versions.versions[0]).toMatchObject({
        author: "agent",
        authorThreadId: threadId,
        contributors: [{ kind: "unrecorded" }, agent],
      });
      expect(await journal(h)).toEqual([]);
    } finally {
      doc.destroy();
      await h.close();
      vi.useRealTimers();
    }
  });

  it.each(["{", '[{"kind":"guest","actorRef":"raw proof"}]', '[{"kind":"unrecorded"}]'])(
    "refuses malformed or conflicting journal metadata during publication (%s)",
    async (invalid) => {
      const h = await fixture();
      noAutomaticTimer();
      try {
        const { room, connection } = await connect(h);
        expect(sendRoomEdit(room, connection, [p("not yet published")])).toBe(true);
        await room.persist();
        await h.run(
          h.sql`UPDATE pages_realtime_updates SET contributors_json=${invalid} WHERE page_id=${h.page.id}`,
        );
        await expect(room.compact()).rejects.toBeDefined();
        expect((await page(h)).page.revision).toBe(1);
        expect(await journal(h)).toEqual([{ seq: 1 }]);
        expect(
          await h.run(h.sql`SELECT * FROM pages_version_contributors WHERE page_id=${h.page.id}`),
        ).toEqual([]);
      } finally {
        await h.run(
          h.sql`UPDATE pages_realtime_updates SET contributors_json='[{"kind":"local-user"}]' WHERE page_id=${h.page.id}`,
        );
        await h.close();
        vi.useRealTimers();
      }
    },
  );

  it("fails both full and summary history reads on a corrupt sidecar", async () => {
    const h = await fixture();
    try {
      await h.run(
        h.sql`INSERT INTO pages_version_contributors(page_id,revision,contributors_json) VALUES(${h.page.id},1,'{')`,
      );
      for (const summaryOnly of [false, true])
        await expect(
          h.run(h.pages.versions({ scopeSpaceId: null, pageId: h.page.id, summaryOnly }, user)),
        ).rejects.toMatchObject({ code: "storage" });
    } finally {
      await h.close();
    }
  });

  it("replays durable post-crash journal into a Page version before admitting its first editor", async () => {
    const h = await fixture();
    const doc = new Y.Doc();
    noAutomaticTimer();
    try {
      const original = await page(h);
      seedPageDoc(doc, [p("original")]);
      await h.run(
        commitRoomCheckpoint(h.sql, h.page.id, {
          generation: "persisted-generation",
          key: sourceKey({ content: original.content, richContent: original.richContent ?? null }),
          state: Y.encodeStateAsUpdate(doc),
          revision: 1,
          throughSequence: 0,
        }),
      );
      const before = Y.encodeStateVector(doc);
      applyPlateValue(doc, [p("survived crash")], "prior-room");
      await h.run(
        appendRoomUpdate(
          h.sql,
          h.page.id,
          "persisted-generation",
          Y.encodeStateAsUpdate(doc, before),
          [{ kind: "unrecorded" }],
        ),
      );
      const token = await issue(h);
      expect(token.revision).toBe(2);
      expect((await page(h)).content).toBe("survived crash");
      expect(await checkpoint(h)).toEqual({ body: [p("survived crash")], revision: 2, through: 1 });
      expect(await journal(h)).toEqual([]);
      const joined = await join(h, token.token);
      expect(readPageDoc(joined!.room.doc)).toEqual([p("survived crash")]);
      expect((await issue(h)).revision).toBe(2);
    } finally {
      doc.destroy();
      await h.close();
      vi.useRealTimers();
    }
  });

  it.each(["race", "follow"])(
    "preserves independent edits when an outside Page version lands (%s)",
    async (mode) => {
      const h = await fixture();
      noAutomaticTimer();
      try {
        await h.run(
          h.base.mutate(
            {
              op: "update",
              requestId: randomUUID(),
              scopeSpaceId: null,
              pageId: h.page.id,
              expectedRevision: 1,
              richContent: JSON.stringify([p("first"), p("second")]),
            },
            user,
          ),
        );
        const { room } = await connect(h);
        applyPlateValue(room.doc, [p("live first"), p("second")], "local");
        const outside = await h.run(
          h.base.mutate(
            {
              op: "update",
              requestId: randomUUID(),
              scopeSpaceId: null,
              pageId: h.page.id,
              expectedRevision: 2,
              title: "outside title",
              richContent: JSON.stringify([p("first"), p("outside second")]),
            },
            user,
          ),
        );
        expect(outside.page.revision).toBe(3);
        if (mode === "follow")
          await room.followPage({
            content: outside.content,
            richContent: outside.richContent ?? null,
            revision: 3,
            trashed: false,
          });
        else await room.compact();
        const merged = await page(h);
        expect(merged.page.title).toBe("outside title");
        expect(merged.page.revision).toBe(4);
        expect(JSON.parse(merged.richContent!)).toEqual([p("live first"), p("outside second")]);
        expect(await checkpoint(h)).toMatchObject({
          body: JSON.parse(merged.richContent!),
          revision: 4,
        });
        expect(await journal(h)).toEqual([]);
      } finally {
        await h.close();
        vi.useRealTimers();
      }
    },
  );

  it("denies a previously issued ticket while an idle-close prefix remains volatile, then retries on owner admission", async () => {
    const h = await fixture();
    noAutomaticTimer();
    try {
      const joined = await connect(h);
      const oldTicket = await issue(h);
      h.realtime.leave(h.page.id, joined.connection);
      await vi.advanceTimersByTimeAsync(29_999);
      await blockAppend(h);
      applyPlateValue(joined.room.doc, [p("retained after failed close")], "local");
      const attempted = barrier();
      const close = joined.room.close.bind(joined.room);
      const attempts = vi.spyOn(joined.room, "close").mockImplementation(() => {
        attempted.release();
        return close();
      });
      await vi.advanceTimersByTimeAsync(1);
      await attempted.promise;
      await expect(attempts.mock.results[0]!.value).rejects.toMatchObject({
        hasVolatileUpdates: true,
      });
      expect(joined.room.isClosing).toBe(true);
      expect(h.realtime.roomCount()).toBe(1);
      expect((await page(h)).page.revision).toBe(1);
      expect(await journal(h)).toEqual([]);
      expect(await join(h, oldTicket.token)).toBeNull();
      await expect(issue(h)).rejects.toBeDefined();
      const count = attempts.mock.calls.length;
      await vi.advanceTimersByTimeAsync(90_000);
      expect(attempts).toHaveBeenCalledTimes(count);
      await unblock(h);
      const replacement = await connect(h);
      expect(replacement.room).not.toBe(joined.room);
      expect(readPageDoc(replacement.room.doc)).toEqual([p("retained after failed close")]);
      expect((await page(h)).page.revision).toBe(2);
      expect(await checkpoint(h)).toEqual({
        body: [p("retained after failed close")],
        revision: 2,
        through: 1,
      });
    } finally {
      await unblock(h);
      await h.close();
      vi.useRealTimers();
    }
  });

  it("reports an unpersisted prefix during scope shutdown instead of clearing the failed room", async () => {
    const h = await fixture();
    noAutomaticTimer();
    try {
      const { room } = await connect(h);
      await blockAppend(h);
      applyPlateValue(room.doc, [p("shutdown failed to persist")], "local");
      await expect(h.close()).rejects.toBeDefined();
      expect(h.realtime.roomCount()).toBe(1);
      expect(room.isClosing).toBe(true);
      expect(readPageDoc(room.doc)).toEqual([p("shutdown failed to persist")]);
    } finally {
      await h.close().catch(() => undefined);
      vi.useRealTimers();
    }
  });
});
