import { randomUUID } from "node:crypto";
import {
  PAGE_GUEST_LINK_PARAM,
  type PageGuestViewRequest,
  type PageId,
  type PageShareTarget,
} from "@moss/contracts";
import { Deferred, Effect } from "effect";
import { describe, expect, it, vi } from "vitest";
import * as Y from "yjs";
import type { Harness } from "../../sharing/PageSharingServiceLive.test";
import { LOCAL_PAGES_PRINCIPAL as owner } from "../../Services/PagesService";
import { pageAccessEpoch } from "../../pageAccessEpoch";
import { applyPlateValue, readPageDoc, seedPageDoc } from "../../realtime/pageYjsContent";
import { PageRealtimeRoom } from "../../realtime/PageRealtimeRoom";
import { appendRoomUpdate, commitRoomCheckpoint } from "../../realtime/pageRoomPublication";
import { discardUnusedGuestSeed, publishedSeedForGuestOpen } from "../publishedSeedForGuestOpen";
import { sendRoomEdit } from "../../realtime/testing/sendRoomEdit";

const visitor = "projection-integration-01";
const p = (text: string) => ({ type: "p", children: [{ text }] });
const publicBody = [p("Published first"), p("Published second")];

function proof(url: string): PageGuestViewRequest {
  const parsed = new URL(url);
  const link = parsed.searchParams.get(PAGE_GUEST_LINK_PARAM);
  const key = parsed.hash.length > 1 ? decodeURIComponent(parsed.hash.slice(1)) : undefined;
  return { visitor, ...(link ? { link } : {}), ...(key ? { key } : {}) };
}
function edit(seed: Uint8Array, body: readonly unknown[]) {
  const doc = new Y.Doc();
  try {
    Y.applyUpdate(doc, seed);
    const vector = Y.encodeStateVector(doc);
    applyPlateValue(doc, body, null);
    return Y.encodeStateAsUpdate(doc, vector);
  } finally {
    doc.destroy();
  }
}
async function share(
  h: Harness,
  target: PageShareTarget,
  role: "edit" | "comment" | "view" = "edit",
) {
  const initial = await h.run(h.sharing.get({ scopeSpaceId: null, target }));
  const set = await h.run(
    h.sharing.mutate({
      op: "set-link",
      scopeSpaceId: null,
      target,
      expectedVersion: initial.version,
      setting: { access: "link", role },
    }),
  );
  const current = set.linkUrl
    ? set
    : await vi.waitFor(
        async () => {
          const state = await h.run(h.sharing.get({ scopeSpaceId: null, target }));
          expect(state.linkUrl).toBeTruthy();
          return state;
        },
        { timeout: 2000, interval: 50 },
      );
  return { entry: proof(current.linkUrl!), state: current };
}
async function ownerRoom(h: Harness, pageId: PageId) {
  const token = await h.run(h.realtime.issueToken({ pageId, scopeSpaceId: null }, owner));
  const sent: Array<Uint8Array | string> = [];
  const joined = await h.realtime.join({
    pageId,
    token: token.token,
    connection: (mode) => ({ mode, send: (msg) => sent.push(msg), close: () => {} }),
  });
  if (!joined) throw new Error("Fixture did not open actual room");
  return { ...joined, sent };
}
async function setup(h: Harness) {
  const page = await h.createPage("Projection source", "", {
    richContent: JSON.stringify(publicBody),
  });
  const target = { kind: "page", id: page.id } as const;
  const { entry, state } = await share(h, target);
  return { page, target, entry, state, ...(await ownerRoom(h, page.id)) };
}

export function registerProjectionAdapterCases(harness: () => Harness) {
  describe("real guest projection adapter", () => {
    it("maps a fresh guest seed into the real owner room and its authorized SQLite version exactly once", async () => {
      const h = harness(),
        x = await setup(h);
      const opened = await h.projection.open(x.entry, x.page.id);
      const guest = new Y.Doc();
      try {
        Y.applyUpdate(guest, opened.seed);
        expect(readPageDoc(guest)).toEqual(publicBody);
      } finally {
        guest.destroy();
      }
      const bytes = edit(opened.seed, [p("Visible guest edit"), publicBody[1]]);
      x.sent.length = 0;
      expect(await h.projection.submit(x.entry, opened.ticket, bytes)).toEqual({
        revision: 2,
        applied: true,
      });
      expect(await h.projection.submit(x.entry, opened.ticket, bytes)).toEqual({
        revision: 2,
        applied: true,
      });
      const history = await h.run(
        h.pages.versions({ pageId: x.page.id, scopeSpaceId: null }, owner),
      );
      const latest = history.versions[0]!;
      expect(history.versions).toHaveLength(2);
      expect(latest).toMatchObject({
        author: "guest",
        authorGuestRef: expect.stringMatching(/^[0-9a-f]{64}$/),
      });
      expect(latest.contributors).toEqual([{ kind: "guest", actorRef: latest.authorGuestRef }]);
      expect(JSON.parse(latest.richContent!)).toEqual([p("Visible guest edit"), publicBody[1]]);
      expect(readPageDoc(x.room.doc)).toEqual([p("Visible guest edit"), publicBody[1]]);
      expect(x.sent.some((msg) => msg instanceof Uint8Array)).toBe(true);
      expect(
        await h.run(
          h.sql`SELECT compacted_revision,compacted_through_sequence FROM pages_realtime_docs WHERE page_id=${x.page.id}`,
        ),
      ).toEqual([{ compacted_revision: 2, compacted_through_sequence: 1 }]);
    });

    it("exports only published content and refuses to overwrite concurrent unpublished owner text", async () => {
      const h = harness(),
        x = await setup(h);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        expect(
          sendRoomEdit(x.room, x.connection, [p("OWNER_PRIVATE_PENDING"), publicBody[1]]),
        ).toBe(true);
        const opened = await h.projection.open(x.entry, x.page.id);
        const guest = new Y.Doc();
        try {
          Y.applyUpdate(guest, opened.seed);
          expect(readPageDoc(guest)).toEqual(publicBody);
        } finally {
          guest.destroy();
        }
        expect(Buffer.from(opened.seed).includes(Buffer.from("OWNER_PRIVATE_PENDING"))).toBe(false);
        const before = Y.encodeStateAsUpdate(x.room.doc);
        x.sent.length = 0;
        await expect(
          h.projection.submit(
            x.entry,
            opened.ticket,
            edit(opened.seed, [p("guest rewrite"), publicBody[1]]),
          ),
        ).rejects.toMatchObject({ code: "conflict" });
        expect(Y.encodeStateAsUpdate(x.room.doc)).toEqual(before);
        expect(x.sent).toEqual([]);
        expect(
          (await h.run(h.pages.read({ pageId: x.page.id, scopeSpaceId: null }, owner))).page
            .revision,
        ).toBe(1);
      } finally {
        vi.useRealTimers();
      }
    });

    it("invalidates a member's old session across edit→comment→edit while the link version remains constant", async () => {
      const h = harness(),
        x = await setup(h);
      const invited = await h.run(
        h.sharing.mutate({
          op: "invite",
          scopeSpaceId: null,
          target: x.target,
          name: "member",
          role: "edit",
        }),
      );
      const member = invited.members[0]!,
        entry = proof(member.url!);
      const old = await h.projection.open(entry, x.page.id);
      await h.run(
        h.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: x.target,
          memberId: member.id,
          role: "comment",
        }),
      );
      await expect(h.projection.open(entry, x.page.id)).rejects.toMatchObject({
        code: "unavailable",
      });
      await h.run(
        h.sharing.mutate({
          op: "set-member",
          scopeSpaceId: null,
          target: x.target,
          memberId: member.id,
          role: "edit",
        }),
      );
      expect((await h.run(h.sharing.get({ scopeSpaceId: null, target: x.target }))).version).toBe(
        invited.version,
      );
      await expect(
        h.projection.submit(entry, old.ticket, edit(old.seed, [p("stale member")])),
      ).rejects.toMatchObject({ code: "unavailable" });
      expect(await h.projection.open(entry, x.page.id)).toMatchObject({ revision: 1 });
    });

    it("rejects a target page after its inherited space grant is revoked and regranted", async () => {
      const h = harness(),
        space = await h.createSpace("Inherited");
      const page = await h.createPage("Child", "", {
        spaceId: space.id,
        parentPageId: space.rootPageId,
        richContent: JSON.stringify(publicBody),
      });
      const target = { kind: "space", id: space.id } as PageShareTarget;
      const { entry } = await share(h, target);
      await ownerRoom(h, page.id);
      const old = await h.projection.open(entry, page.id);
      await share(h, target, "comment");
      await expect(h.projection.open(entry, page.id)).rejects.toMatchObject({
        code: "unavailable",
      });
      await share(h, target);
      await expect(h.projection.read(entry, old.ticket)).rejects.toMatchObject({
        code: "unavailable",
      });
      expect(await h.projection.open(entry, page.id)).toMatchObject({ revision: 1 });
    });

    it.each(["move", "trash", "body"] as const)(
      "invalidates a window across the owner's actual %s mutation",
      async (kind) => {
        const h = harness(),
          x = await setup(h);
        const parent = kind === "move" ? await h.createPage("New parent", "parent") : null;
        const old = await h.projection.open(x.entry, x.page.id);
        if (parent) {
          await h.run(
            h.pages.mutate(
              {
                op: "move",
                scopeSpaceId: null,
                pageId: x.page.id,
                expectedRevision: 1,
                requestId: randomUUID(),
                parentPageId: parent.id,
                spaceId: null,
              },
              owner,
            ),
          );
        } else if (kind === "trash") {
          const trashed = await h.run(
            h.pages.mutate(
              {
                op: "trash",
                scopeSpaceId: null,
                pageId: x.page.id,
                expectedRevision: 1,
                requestId: randomUUID(),
              },
              owner,
            ),
          );
          await h.run(
            h.pages.mutate(
              {
                op: "restore",
                scopeSpaceId: null,
                pageId: x.page.id,
                expectedRevision: trashed.page.revision,
                requestId: randomUUID(),
              },
              owner,
            ),
          );
        } else {
          await h.updatePage(x.page.id, 1, "", JSON.stringify([p("owner body")]));
        }
        await expect(h.projection.read(x.entry, old.ticket)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect((await h.projection.open(x.entry, x.page.id)).revision).toBeGreaterThan(1);
      },
    );

    it("does not issue a projection during a real mutation stalled before SQLite acquisition", async () => {
      const h = harness(),
        x = await setup(h);
      const old = await h.projection.open(x.entry, x.page.id);
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>();
      const holder = h.run(
        h.sql.withTransaction(
          Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
        ),
      );
      await h.run(Deferred.await(entered));
      const epoch = pageAccessEpoch(h.sql);
      let began!: () => void;
      const beginning = new Promise<void>((res) => {
        began = res;
      });
      const off = epoch.listen(() => {
        if (epoch.current() === null) began();
      });
      const mutation = h.run(
        h.sharing.mutate({
          op: "set-link",
          scopeSpaceId: null,
          target: x.target,
          expectedVersion: x.state.version,
          setting: { access: "link", role: "edit" },
        }),
      );
      try {
        await beginning;
        expect(epoch.current()).toBeNull();
        await expect(h.projection.open(x.entry, x.page.id)).rejects.toMatchObject({
          code: "unavailable",
        });
        await expect(h.projection.read(x.entry, old.ticket)).rejects.toMatchObject({
          code: "unavailable",
        });
      } finally {
        off();
        await h.run(Deferred.succeed(release, undefined));
        await holder;
        await mutation;
      }
      expect(epoch.current()).not.toBeNull();
      expect(await h.projection.open(x.entry, x.page.id)).toMatchObject({ revision: 1 });
    });

    it("rolls back a guest transaction when a competing permission change begins after its preliminary proof check", async () => {
      const h = harness(),
        x = await setup(h);
      const opened = await h.projection.open(x.entry, x.page.id);
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>();
      let calls = 0;
      const original = h.sharing.resolveEditableGuestPage;
      const pause = vi
        .spyOn(h.sharing, "resolveEditableGuestPage")
        .mockImplementation((req) =>
          ++calls === 2
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(original(req)),
              )
            : original(req),
        );
      try {
        x.sent.length = 0;
        const writing = h.projection
          .submit(x.entry, opened.ticket, edit(opened.seed, [p("revoked frame")]))
          .then(
            () => false,
            () => true,
          );
        await h.run(Deferred.await(entered));
        const revoke = h.run(
          h.sharing.mutate({
            op: "set-link",
            scopeSpaceId: null,
            target: x.target,
            expectedVersion: x.state.version,
            setting: { access: "link", role: "comment" },
          }),
        );
        expect(await writing).toBe(true);
        await revoke;
        expect(x.room.currentRevision).toBe(1);
        expect(readPageDoc(x.room.doc)).toEqual(publicBody);
        expect(x.sent).toEqual([]);
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
      } finally {
        await h.run(Deferred.succeed(release, undefined));
        pause.mockRestore();
      }
    });

    it("rejects a late SQLite failure before adopting or broadcasting mapped bytes", async () => {
      const h = harness(),
        x = await setup(h);
      const opened = await h.projection.open(x.entry, x.page.id);
      await h.run(h.sql`CREATE TRIGGER projection_failure BEFORE INSERT ON pages_realtime_snapshots WHEN NEW.revision>1
        BEGIN SELECT RAISE(ABORT,'fixture failure'); END`);
      try {
        x.sent.length = 0;
        const before = Y.encodeStateAsUpdate(x.room.doc);
        await expect(
          h.projection.submit(x.entry, opened.ticket, edit(opened.seed, [p("must roll back")])),
        ).rejects.toMatchObject({ code: "unavailable" });
        expect(Y.encodeStateAsUpdate(x.room.doc)).toEqual(before);
        expect(x.sent).toEqual([]);
        expect(
          await h.run(h.sql`SELECT * FROM pages_version_contributors WHERE page_id=${x.page.id}`),
        ).toEqual([]);
      } finally {
        await h.run(h.sql`DROP TRIGGER projection_failure`);
      }
    });

    it("declines non-text resources without sending their raw values", async () => {
      const h = harness();
      const other = await h.createPage("App block", "", {
        richContent: JSON.stringify([
          { type: "moss_visualization", appPageId: "PRIVATE_APP", children: [{ text: "" }] },
        ]),
      });
      const otherShare = await share(h, { kind: "page", id: other.id });
      await ownerRoom(h, other.id);
      await expect(h.projection.open(otherShare.entry, other.id)).rejects.toMatchObject({
        code: "unsupported",
        message: "unsupported",
      });
    });
  });

  describe("first authorized guest room", () => {
    async function fresh(h: Harness, role: "edit" | "comment" | "view" = "edit") {
      const page = await h.createPage("Closed page", "", {
        richContent: JSON.stringify(publicBody),
      });
      const target = { kind: "page", id: page.id } as const;
      return { page, target, ...(await share(h, target, role)) };
    }
    it("opens an authorized first generation from published text without an owner token or owner recovery", async () => {
      const h = harness(),
        x = await fresh(h);
      const ticket = vi.spyOn(h.realtime, "issueToken");
      const recover = vi.spyOn(PageRealtimeRoom.prototype, "open");
      const published =
        typeof PageRealtimeRoom.prototype.openPublished === "function"
          ? vi.spyOn(PageRealtimeRoom.prototype, "openPublished")
          : undefined;
      try {
        expect(h.realtime.roomCount()).toBe(0);
        const opened = await h.projection.open(x.entry, x.page.id);
        expect(opened.revision).toBe(1);
        expect(published).toHaveBeenCalledOnce();
        expect(ticket).not.toHaveBeenCalled();
        expect(recover).not.toHaveBeenCalled();
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
        expect(
          await h.projection.submit(
            x.entry,
            opened.ticket,
            edit(opened.seed, [p("first guest wrote")]),
          ),
        ).toEqual({ revision: 2, applied: true });
        const versions = await h.run(
          h.pages.versions({ pageId: x.page.id, scopeSpaceId: null }, owner),
        );
        expect(versions.versions[0]).toMatchObject({
          author: "guest",
          content: "first guest wrote",
          contributors: [{ kind: "guest", actorRef: versions.versions[0]!.authorGuestRef }],
        });
      } finally {
        ticket.mockRestore();
        recover.mockRestore();
        published?.mockRestore();
      }
    });

    it("coalesces simultaneous first guests, gives separate safe documents and one persisted generation", async () => {
      const h = harness(),
        x = await fresh(h);
      const warm = vi.spyOn(PageRealtimeRoom.prototype, "openPublished");
      try {
        const [a, b] = await Promise.all([
          h.projection.open(x.entry, x.page.id),
          h.projection.open({ ...x.entry, visitor: "guest-window-0002" }, x.page.id),
        ]);
        expect(warm).toHaveBeenCalledOnce();
        expect(h.realtime.roomCount()).toBe(1);
        expect(a.ticket.sessionKey).not.toBe(b.ticket.sessionKey);
        expect(a.ticket.epoch).not.toBe(b.ticket.epoch);
        expect(
          await h.run(
            h.sql`SELECT count(*) AS n FROM pages_realtime_docs WHERE page_id=${x.page.id}`,
          ),
        ).toEqual([{ n: 1 }]);
        expect(
          await h.run(
            h.sql`SELECT count(*) AS n FROM pages_realtime_snapshots WHERE page_id=${x.page.id}`,
          ),
        ).toEqual([{ n: 1 }]);
        await h.projection.submit(x.entry, a.ticket, edit(a.seed, [p("A first")]));
        await expect(
          h.projection.submit(x.entry, b.ticket, edit(b.seed, [p("B stale")])),
        ).rejects.toMatchObject({ code: "conflict" });
      } finally {
        warm.mockRestore();
      }
    });

    it.each(["view", "comment", "forged", "revoked"] as const)(
      "keeps an unopened page uninitialized for %s proof",
      async (kind) => {
        const h = harness(),
          x = await fresh(h, kind === "view" || kind === "comment" ? kind : "edit");
        if (kind === "revoked")
          await h.run(
            h.sharing.mutate({
              op: "rotate-link",
              scopeSpaceId: null,
              target: x.target,
              expectedVersion: x.state.version,
            }),
          );
        const entry = kind === "forged" ? { ...x.entry, key: "forged-invalid-proof" } : x.entry;
        await expect(h.projection.open(entry, x.page.id)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect(h.realtime.roomCount()).toBe(0);
        expect(
          await h.run(h.sql`SELECT * FROM pages_realtime_docs WHERE page_id=${x.page.id}`),
        ).toEqual([]);
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
      },
    );

    it("refuses an uncompacted owner journal without publishing, pruning or instantiating its room", async () => {
      const h = harness(),
        x = await fresh(h);
      const previous = new Y.Doc();
      const recover = vi.spyOn(PageRealtimeRoom.prototype, "open");
      try {
        seedPageDoc(previous, publicBody);
        await h.run(
          commitRoomCheckpoint(h.sql, x.page.id, {
            generation: "durable-owner",
            revision: 1,
            key: JSON.stringify(publicBody),
            throughSequence: 0,
            state: Y.encodeStateAsUpdate(previous),
          }),
        );
        const vector = Y.encodeStateVector(previous);
        applyPlateValue(previous, [p("UNPUBLISHED_PRIVATE_OWNER_JOURNAL")], null);
        const pending = Y.encodeStateAsUpdate(previous, vector);
        await h.run(
          appendRoomUpdate(h.sql, x.page.id, "durable-owner", pending, [{ kind: "local-user" }]),
        );
        await expect(h.projection.open(x.entry, x.page.id)).rejects.toMatchObject({
          code: "unavailable",
          message: "unavailable",
        });
        expect(recover).not.toHaveBeenCalled();
        expect(h.realtime.roomCount()).toBe(0);
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
        const rows = await h.run(
          h.sql<{
            seq: number;
            update_data: Uint8Array;
          }>`SELECT seq,update_data FROM pages_realtime_updates WHERE page_id=${x.page.id}`,
        );
        expect(rows).toHaveLength(1);
        expect(rows[0]!.seq).toBe(1);
        expect(Buffer.from(rows[0]!.update_data).equals(pending)).toBe(true);
        const joined = await ownerRoom(h, x.page.id);
        expect(recover).toHaveBeenCalledOnce();
        expect(joined.room.currentRevision).toBe(2);
        expect(readPageDoc(joined.room.doc)).toEqual([p("UNPUBLISHED_PRIVATE_OWNER_JOURNAL")]);
      } finally {
        recover.mockRestore();
        previous.destroy();
      }
    });

    it("refuses an incompatible closed checkpoint and preserves orphan snapshots", async () => {
      const h = harness();
      for (const kind of ["stale", "orphan"] as const) {
        const x = await fresh(h);
        const doc = new Y.Doc();
        try {
          seedPageDoc(doc, [p("different private body")]);
          const state = Y.encodeStateAsUpdate(doc);
          if (kind === "stale")
            await h.run(
              commitRoomCheckpoint(h.sql, x.page.id, {
                generation: "old",
                revision: 1,
                key: "other",
                throughSequence: 0,
                state,
              }),
            );
          else
            await h.run(h.sql`INSERT INTO pages_realtime_snapshots(page_id,generation,revision,state,created_at)
            VALUES(${x.page.id},'orphan',1,${state},'2026-11-06')`);
          await expect(h.projection.open(x.entry, x.page.id)).rejects.toMatchObject({
            code: "unavailable",
          });
          const [result] = await h.run(
            h.sql<{
              state: Uint8Array;
            }>`SELECT state FROM pages_realtime_snapshots WHERE page_id=${x.page.id}`,
          );
          expect(Buffer.from(result!.state).equals(state)).toBe(true);
          expect(h.realtime.activeGuestGeneration(x.page.id)).toBeNull();
        } finally {
          doc.destroy();
        }
      }
    });

    it("reopens the same clean generation after actual natural idle close without creating a Page version", async () => {
      const h = harness(),
        x = await fresh(h);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      try {
        const first = await h.projection.open(x.entry, x.page.id);
        const generation = h.realtime.activeGuestGeneration(x.page.id);
        expect(generation).toBeTruthy();
        await vi.advanceTimersByTimeAsync(30_001);
        expect(h.realtime.roomCount()).toBe(0);
        const reopened = await h.projection.read(x.entry, first.ticket);
        expect(reopened.revision).toBe(1);
        expect(h.realtime.activeGuestGeneration(x.page.id)).toBe(generation);
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
      } finally {
        vi.useRealTimers();
      }
    });

    it.each(["new-cache", "existing-cache"] as const)(
      "rechecks actual permission between initialization and admission (%s)",
      async (kind) => {
        const h = harness(),
          x = await fresh(h);
        const old = new Y.Doc();
        if (kind === "existing-cache") {
          seedPageDoc(old, publicBody);
          await h.run(
            commitRoomCheckpoint(h.sql, x.page.id, {
              generation: "existing",
              revision: 1,
              key: JSON.stringify(publicBody),
              throughSequence: 0,
              state: Y.encodeStateAsUpdate(old),
            }),
          );
        }
        const entered = Deferred.makeUnsafe<void>(),
          release = Deferred.makeUnsafe<void>();
        const original = h.sharing.resolveEditableGuestPage;
        let calls = 0;
        const pause = vi
          .spyOn(h.sharing, "resolveEditableGuestPage")
          .mockImplementation((req) =>
            ++calls === 2
              ? Deferred.succeed(entered, undefined).pipe(
                  Effect.andThen(Deferred.await(release)),
                  Effect.andThen(original(req)),
                )
              : original(req),
          );
        try {
          const opening = h.projection.open(x.entry, x.page.id).then(
            () => false,
            () => true,
          );
          await h.run(Deferred.await(entered));
          expect(h.realtime.roomCount()).toBe(1);
          const revoke = h.run(
            h.sharing.mutate({
              op: "set-link",
              scopeSpaceId: null,
              target: x.target,
              expectedVersion: x.state.version,
              setting: { access: "link", role: "comment" },
            }),
          );
          expect(await opening).toBe(true);
          await revoke;
          await h.run(h.realtime.withRoomClosed(x.page.id, Effect.void));
          expect(h.realtime.roomCount()).toBe(0);
          const headers = await h.run(
            h.sql<{
              state: Uint8Array;
            }>`SELECT state FROM pages_realtime_docs WHERE page_id=${x.page.id}`,
          );
          const snapshots = await h.run(
            h.sql<{
              state: Uint8Array;
            }>`SELECT state FROM pages_realtime_snapshots WHERE page_id=${x.page.id}`,
          );
          if (kind === "new-cache") {
            expect(headers).toEqual([]);
            expect(snapshots).toEqual([]);
          } else {
            expect(headers).toHaveLength(1);
            expect(snapshots).toHaveLength(1);
            expect(Buffer.from(headers[0]!.state).equals(Y.encodeStateAsUpdate(old))).toBe(true);
            expect(Buffer.from(snapshots[0]!.state).equals(Y.encodeStateAsUpdate(old))).toBe(true);
          }
          expect(
            await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
          ).toEqual([{ revision: 1 }]);
        } finally {
          await h.run(Deferred.succeed(release, undefined));
          pause.mockRestore();
          old.destroy();
        }
      },
    );

    it("never removes a new cache that subsequently acquired an owner journal row", async () => {
      const h = harness(),
        x = await fresh(h);
      const prepared = await h.run(
        h.sql.withTransaction(
          publishedSeedForGuestOpen(h.sql, x.page.id, 1, JSON.stringify(publicBody)),
        ),
      );
      expect(prepared.created).toBe(true);
      const doc = new Y.Doc();
      try {
        Y.applyUpdate(doc, prepared.seed.state);
        const before = Y.encodeStateVector(doc);
        applyPlateValue(doc, [p("subsequent owner update")], null);
        const delta = Y.encodeStateAsUpdate(doc, before);
        await h.run(
          appendRoomUpdate(h.sql, x.page.id, prepared.seed.generation, delta, [
            { kind: "local-user" },
          ]),
        );
        await h.run(discardUnusedGuestSeed(h.sql, x.page.id, prepared.seed));
        expect(
          await h.run(
            h.sql`SELECT next_sequence FROM pages_realtime_docs WHERE page_id=${x.page.id}`,
          ),
        ).toEqual([{ next_sequence: 2 }]);
        expect(
          await h.run(h.sql`SELECT seq FROM pages_realtime_updates WHERE page_id=${x.page.id}`),
        ).toEqual([{ seq: 1 }]);
        expect(
          await h.run(
            h.sql`SELECT revision FROM pages_realtime_snapshots WHERE page_id=${x.page.id}`,
          ),
        ).toEqual([{ revision: 1 }]);
      } finally {
        doc.destroy();
      }
    });

    it("never retries an owner's failed volatile close to manufacture guest availability", async () => {
      const h = harness(),
        x = await setup(h);
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
      try {
        h.realtime.leave(x.page.id, x.connection);
        await vi.advanceTimersByTimeAsync(29_999);
        await h.run(h.sql`CREATE TRIGGER blocked_guest_first_owner_append BEFORE INSERT ON pages_realtime_updates
          BEGIN SELECT RAISE(ABORT,'owner append unavailable'); END`);
        applyPlateValue(x.room.doc, [p("kept only in owner memory")], null);
        const close = x.room.close.bind(x.room);
        const attempt = vi.spyOn(x.room, "close").mockImplementation(() => close());
        await vi.advanceTimersByTimeAsync(1);
        await expect(attempt.mock.results[0]!.value).rejects.toMatchObject({
          hasVolatileUpdates: true,
        });
        const calls = attempt.mock.calls.length;
        await expect(h.projection.open(x.entry, x.page.id)).rejects.toMatchObject({
          code: "unavailable",
        });
        expect(attempt).toHaveBeenCalledTimes(calls);
        expect(readPageDoc(x.room.doc)).toEqual([p("kept only in owner memory")]);
        expect(
          await h.run(h.sql`SELECT revision FROM pages_versions WHERE page_id=${x.page.id}`),
        ).toEqual([{ revision: 1 }]);
      } finally {
        await h.run(h.sql`DROP TRIGGER IF EXISTS blocked_guest_first_owner_append`);
        vi.useRealTimers();
      }
    });

    it("cannot enter or supersede an in-flight real idle flush; a fresh request sees only its committed revision", async () => {
      const h = harness(),
        x = await setup(h);
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>();
      vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "Date"] });
      let holder: Promise<unknown> | undefined;
      try {
        h.realtime.leave(x.page.id, x.connection);
        await vi.advanceTimersByTimeAsync(29_999);
        holder = h.run(
          h.sql.withTransaction(
            Deferred.succeed(entered, undefined).pipe(Effect.andThen(Deferred.await(release))),
          ),
        );
        await h.run(Deferred.await(entered));
        applyPlateValue(x.room.doc, [p("owner idle flush")], null);
        const close = x.room.close.bind(x.room);
        const attempt = vi.spyOn(x.room, "close").mockImplementation(() => close());
        await vi.advanceTimersByTimeAsync(1);
        expect(x.room.isClosing).toBe(true);
        let settled = false;
        const waiting = h.projection
          .open(x.entry, x.page.id)
          .then(
            () => false,
            () => true,
          )
          .finally(() => {
            settled = true;
          });
        await vi.advanceTimersByTimeAsync(100);
        expect(settled).toBe(false);
        expect(h.realtime.roomCount()).toBe(1);
        await h.run(Deferred.succeed(release, undefined));
        await holder;
        await attempt.mock.results[0]!.value;
        expect(await waiting).toBe(true);
        const fresh = await h.projection.open(x.entry, x.page.id);
        expect(fresh.revision).toBe(2);
        const guest = new Y.Doc();
        try {
          Y.applyUpdate(guest, fresh.seed);
          expect(readPageDoc(guest)).toEqual([p("owner idle flush")]);
        } finally {
          guest.destroy();
        }
      } finally {
        await h.run(Deferred.succeed(release, undefined));
        await holder;
        vi.useRealTimers();
      }
    });

    it("scope closure aborts an in-progress first admission and does not leave a live room", async () => {
      const h = harness(),
        x = await fresh(h);
      const entered = Deferred.makeUnsafe<void>(),
        release = Deferred.makeUnsafe<void>();
      const original = h.sharing.resolveEditableGuestPage;
      let calls = 0;
      const pause = vi
        .spyOn(h.sharing, "resolveEditableGuestPage")
        .mockImplementation((req) =>
          ++calls === 2
            ? Deferred.succeed(entered, undefined).pipe(
                Effect.andThen(Deferred.await(release)),
                Effect.andThen(original(req)),
              )
            : original(req),
        );
      try {
        const open = h.projection.open(x.entry, x.page.id).then(
          () => false,
          () => true,
        );
        await h.run(Deferred.await(entered));
        expect(h.realtime.roomCount()).toBe(1);
        await h.closeService();
        expect(await open).toBe(true);
        expect(h.realtime.roomCount()).toBe(0);
      } finally {
        pause.mockRestore();
        await Effect.runPromise(Deferred.succeed(release, undefined));
      }
    });
  });
}
