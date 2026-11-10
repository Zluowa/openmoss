// Test-only schema/adapter. Never imported by production; no migration number.
import { Effect, ManagedRuntime } from "effect";
import * as SqlClient from "effect/unstable/sql/SqlClient";
import * as NodeSqliteClient from "../../../../persistence/NodeSqliteClient";
import { runMigrations } from "../../../../persistence/Migrations";
import { readPageRoomCommittedCut, type CommittedRoomCut } from "../pageRoomCommittedCut";
import { equalBytes } from "../roomRecoveryProtocol";
import { roomIdentity } from "../roomEnvelopeProtocol";
import type {
  OwnerCommit,
  OwnerPublicationCAS,
  OwnerPublicationRecord,
  OwnerPublicationStore,
  OwnerPublicationTarget,
  OwnerRead,
} from "../roomOwnerPublication";

export async function openPublicationFixture(filename: string) {
  const runtime = ManagedRuntime.make(NodeSqliteClient.layer({ filename }));
  const sql = await runtime.runPromise(Effect.service(SqlClient.SqlClient));
  const run = <A, E>(task: Effect.Effect<A, E, SqlClient.SqlClient>) => runtime.runPromise(task);
  return { sql, run, close: () => runtime.dispose() };
}
export type PublicationFixture = Awaited<ReturnType<typeof openPublicationFixture>>;

export async function seedPublicationFixture(filename: string) {
  const db = await openPublicationFixture(filename);
  try {
    await db.run(runMigrations({ toMigrationInclusive: 163 }));
    await db.run(
      db.sql.withTransaction(
        Effect.gen(function* () {
          yield* db.sql`CREATE TABLE fixture_c1c_grant (room TEXT PRIMARY KEY, profile_ref TEXT NOT NULL, scope_key TEXT NOT NULL,
        page_id TEXT NOT NULL, sender_ref TEXT NOT NULL, fence INTEGER NOT NULL, active INTEGER NOT NULL, genesis_allowed INTEGER NOT NULL)`;
          yield* db.sql`CREATE TABLE fixture_c1c_blob (room TEXT NOT NULL, digest TEXT NOT NULL, private_json TEXT NOT NULL,
        ciphertext BLOB NOT NULL, PRIMARY KEY(room,digest))`;
          yield* db.sql`CREATE TABLE fixture_c1c_head (room TEXT PRIMARY KEY, digest TEXT NOT NULL,
        FOREIGN KEY(room,digest) REFERENCES fixture_c1c_blob(room,digest))`;
          yield* db.sql`CREATE TABLE fixture_c1c_outbox (room TEXT NOT NULL, digest TEXT NOT NULL, fence INTEGER NOT NULL,
        delivered INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(room,digest), FOREIGN KEY(room,digest) REFERENCES fixture_c1c_blob(room,digest))`;
        }),
      ),
    );
  } finally {
    await db.close();
  }
}

function sameCut(left: CommittedRoomCut, right: CommittedRoomCut) {
  return (
    left.generation === right.generation &&
    left.revision === right.revision &&
    left.throughSequence === right.throughSequence &&
    equalBytes(left.state, right.state)
  );
}
export function makePublicationFixtureStore(db: PublicationFixture) {
  const { sql, run } = db;
  const hooks: { beforeCommit?: () => Promise<void>; afterCommit?: () => void } = {};
  const locator = (t: OwnerPublicationTarget) => ({
    pageId: t.pageId,
    scopeKey: t.scopeKey,
    generation: t.room.documentGeneration,
  });
  const readHead = (room: string) =>
    sql<{ digest: string }>`SELECT digest FROM fixture_c1c_head WHERE room=${room}`;
  const history = (room: string) => sql`SELECT 1 FROM fixture_c1c_blob WHERE room=${room} LIMIT 1`;
  const readGrant = (t: OwnerPublicationTarget) => sql<{
    genesis_allowed: number;
  }>`SELECT genesis_allowed FROM fixture_c1c_grant
    WHERE room=${roomIdentity(t.room)} AND fence=${t.fence} AND active=1 AND profile_ref=${t.profileRef}
      AND scope_key=${t.scopeKey} AND page_id=${t.pageId} AND sender_ref=${t.senderRef}`;
  const recordFor = (room: string, digest: string) =>
    Effect.gen(function* () {
      const [row] = yield* sql<{
        private_json: string;
        ciphertext: Uint8Array | null;
      }>`SELECT private_json,
      CASE WHEN length(ciphertext) <= 262160 THEN ciphertext END AS ciphertext FROM fixture_c1c_blob WHERE room=${room} AND digest=${digest}`;
      if (!row?.ciphertext) return null;
      const parsed = JSON.parse(row.private_json) as OwnerPublicationRecord;
      if (parsed.anchor.bundleDigest !== digest) return null;
      return {
        ...parsed,
        bundle: {
          ...parsed.bundle,
          checkpoint: { ...parsed.bundle.checkpoint, ciphertext: new Uint8Array(row.ciphertext) },
        },
      };
    });

  const store: OwnerPublicationStore = {
    async read(target): Promise<OwnerRead> {
      return run(
        sql.withTransaction(
          Effect.gen(function* () {
            const room = roomIdentity(target.room),
              [grant] = yield* readGrant(target);
            if (!grant) return { kind: "revoked" } as const;
            const cut = yield* readPageRoomCommittedCut(sql, locator(target));
            if (cut.kind !== "ready") return cut;
            const [head] = yield* readHead(room);
            if (!head && (!grant.genesis_allowed || (yield* history(room)).length))
              return { kind: "owner-required" } as const;
            const record = head ? yield* recordFor(room, head.digest) : null;
            if (head && !record) return { kind: "owner-required" } as const;
            return {
              kind: "ready",
              cut: cut.cut,
              head: record,
              genesisAllowed: grant.genesis_allowed === 1,
            } as const;
          }),
        ),
      );
    },
    async commit(input: OwnerPublicationCAS): Promise<OwnerCommit> {
      await hooks.beforeCommit?.(); // Deliberate test barrier outside SQLite's transaction.
      const t = input.target,
        room = roomIdentity(t.room);
      const outcome = await run(
        sql.withTransaction(
          Effect.gen(function* () {
            // Take the writer lock first. Fence changes, source changes and other
            // publishers now serialize with this exact head/blob/outbox decision.
            const [grant] = yield* sql<{
              genesis_allowed: number;
            }>`UPDATE fixture_c1c_grant SET fence=fence
          WHERE room=${room} AND fence=${t.fence} AND active=1 AND profile_ref=${t.profileRef} AND scope_key=${t.scopeKey}
            AND page_id=${t.pageId} AND sender_ref=${t.senderRef} RETURNING genesis_allowed`;
            if (!grant) return "revoked" as const;
            const current = yield* readPageRoomCommittedCut(sql, locator(t));
            if (current.kind !== "ready" || !sameCut(current.cut, input.cut))
              return "cut-changed" as const;
            const [head] = yield* readHead(room);
            if ((head?.digest ?? null) !== input.expectedHead) return "conflict" as const;
            if (!head && (!grant.genesis_allowed || (yield* history(room)).length))
              return "owner-required" as const;
            try {
              input.assertCurrent();
            } catch {
              return "revoked" as const;
            }
            const record = input.record;
            if (!record) {
              if (!head) return "conflict" as const;
              // A newly authorized fence can redeliver the same pending immutable
              // object. A late ACK from the previous fence no longer matches.
              const ready =
                yield* sql`UPDATE fixture_c1c_outbox SET fence=${t.fence} WHERE room=${room} AND digest=${head.digest} RETURNING room`;
              if (ready.length !== 1)
                return yield* Effect.fail(new Error("fixture head lacks its delivery record"));
              yield* Effect.try({
                try: input.assertCurrent,
                catch: () => new Error("fixture authorization changed before reuse"),
              });
              return "committed" as const;
            }
            const digest = record.anchor.bundleDigest;
            const metadata = {
              ...record,
              bundle: {
                ...record.bundle,
                checkpoint: { ...record.bundle.checkpoint, ciphertext: null },
              },
            };
            yield* sql`INSERT INTO fixture_c1c_blob(room,digest,private_json,ciphertext) VALUES(${room},${digest},${JSON.stringify(metadata)},${record.bundle.checkpoint.ciphertext})`;
            if (head) {
              const updated =
                yield* sql`UPDATE fixture_c1c_head SET digest=${digest} WHERE room=${room} AND digest=${input.expectedHead} RETURNING room`;
              if (updated.length !== 1)
                return yield* Effect.fail(new Error("fixture head CAS lost"));
            } else yield* sql`INSERT INTO fixture_c1c_head(room,digest) VALUES(${room},${digest})`;
            yield* sql`UPDATE fixture_c1c_grant SET genesis_allowed=0 WHERE room=${room}`;
            yield* sql`INSERT INTO fixture_c1c_outbox(room,digest,fence) VALUES(${room},${digest},${t.fence})`;
            // Failure after writes must roll back, not simply return a result.
            yield* Effect.try({
              try: input.assertCurrent,
              catch: () => new Error("fixture authorization changed before commit"),
            });
            return "committed" as const;
          }),
        ),
      );
      hooks.afterCommit?.();
      return outcome;
    },
  };
  async function acknowledge(target: OwnerPublicationTarget, digest: string) {
    const room = roomIdentity(target.room);
    const rows =
      await run(sql`UPDATE fixture_c1c_outbox SET delivered=1 WHERE room=${room} AND digest=${digest} AND fence=${target.fence}
      AND EXISTS(SELECT 1 FROM fixture_c1c_head h WHERE h.room=${room} AND h.digest=${digest})
      AND EXISTS(SELECT 1 FROM fixture_c1c_grant g WHERE g.room=${room} AND g.fence=${target.fence} AND g.active=1
        AND g.profile_ref=${target.profileRef} AND g.scope_key=${target.scopeKey} AND g.page_id=${target.pageId} AND g.sender_ref=${target.senderRef}) RETURNING room`);
    return rows.length === 1;
  }
  return { store, hooks, acknowledge };
}
