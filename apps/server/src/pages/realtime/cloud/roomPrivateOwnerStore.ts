import { createHash } from "node:crypto";
import { Effect } from "effect";
import { readPageRoomCommittedCut } from "./pageRoomCommittedCut";
import type {
  OwnerPublicationRecord,
  OwnerPublicationStore,
  OwnerPublicationTarget,
  OwnerRead,
} from "./roomOwnerPublication";
import {
  bundleDigestInput,
  checkBundleShape,
  copyRecoveryAnchor,
  copyRecoveryBundle,
  equalBytes,
  frameDigestInput,
} from "./roomRecoveryProtocol";
import {
  RoomPrivateStoreError,
  bindingValues,
  bound,
  denied,
  digest,
  targetMatches,
  withControl,
  type PrivateStoreContext,
  type VerifiedOwnerControl,
} from "./roomPrivateStoreAuthority";

interface Slot {
  page_id: string;
  sender_ref: string;
  scope_key: string;
  active: number;
  fence: number;
  authority_version: number;
  genesis_allowed: number;
  published_once: number;
  head_digest: string | null;
  confirmed_digest: string | null;
}
const sameOwner = (s: Slot, t: OwnerPublicationTarget) =>
  s.fence === t.fence &&
  s.page_id === t.pageId &&
  s.sender_ref === t.senderRef &&
  s.scope_key === t.scopeKey;
export function makePrivateOwnerStore(ctx: PrivateStoreContext) {
  const { sql } = ctx;
  const lookup = (
    t: OwnerPublicationTarget,
  ) => sql<Slot>`SELECT page_id,sender_ref,scope_key,active,fence,authority_version,genesis_allowed,published_once,
    head_digest,confirmed_digest FROM main.pages_room_owner_slots WHERE ${bound(sql, t)}`;
  const readRecord = (t: OwnerPublicationTarget, hash: string) =>
    Effect.gen(function* () {
      const [r] = yield* sql<{
        source_revision: number;
        source_sequence: number;
        source_digest: string;
        previous_commit_digest: string | null;
        prior_head_digest: string | null;
        receipt_salt: string;
        anchor: string | null;
        frame: string | null;
        ciphertext: Uint8Array | null;
      }>`SELECT
      source_revision,source_sequence,source_digest,previous_commit_digest,prior_head_digest,receipt_salt,
      CASE WHEN typeof(anchor_json)='text' AND length(CAST(anchor_json AS BLOB))<=4096 THEN anchor_json END AS anchor,
      CASE WHEN typeof(frame_json)='text' AND length(CAST(frame_json AS BLOB))<=2048 THEN frame_json END AS frame,
      CASE WHEN typeof(ciphertext)='blob' AND length(ciphertext) BETWEEN 16 AND 262160 THEN ciphertext END AS ciphertext
      FROM main.pages_room_owner_publications WHERE ${bound(sql, t)} AND bundle_digest=${hash}`;
      if (!r?.anchor || !r.frame || !r.ciphertext) return null;
      try {
        const anchor = copyRecoveryAnchor(JSON.parse(r.anchor));
        if (anchor.bundleDigest !== hash) return null;
        const bundle = copyRecoveryBundle({
          format: anchor.format,
          room: anchor.room,
          checkpointId: anchor.checkpointId,
          checkpointVersion: anchor.checkpointVersion,
          coveredCommitIndex: anchor.coveredCommitIndex,
          coveredCommitDigest: anchor.coveredCommitDigest,
          checkpoint: { ...JSON.parse(r.frame), ciphertext: r.ciphertext },
          tail: [],
        });
        checkBundleShape(bundle, anchor);
        const record: OwnerPublicationRecord = {
          source: {
            generation: t.room.documentGeneration,
            revision: r.source_revision,
            throughSequence: r.source_sequence,
            rawStateDigest: r.source_digest,
          },
          previousCommitDigest: r.previous_commit_digest,
          receiptSalt: r.receipt_salt,
          anchor,
          bundle,
        };
        return { record, prior: r.prior_head_digest };
      } catch {
        return null;
      }
    });
  const active = (c: VerifiedOwnerControl, s: Slot | undefined) =>
    !!s &&
    !!s.active &&
    c.active &&
    sameOwner(s, c.target) &&
    s.authority_version === c.authorityVersion &&
    s.confirmed_digest === c.confirmedDigest;
  const read = (c: VerifiedOwnerControl, t: OwnerPublicationTarget) =>
    Effect.gen(function* () {
      const [s] = yield* lookup(t);
      if (!targetMatches(c.target, t) || !active(c, s) || !s) return { kind: "revoked" } as const;
      const source = yield* readPageRoomCommittedCut(sql, {
        pageId: t.pageId,
        scopeKey: t.scopeKey,
        generation: t.room.documentGeneration,
      });
      if (source.kind !== "ready") return source;
      const head = s.head_digest ? yield* readRecord(t, s.head_digest) : null;
      if (
        s.published_once
          ? !head
          : s.head_digest !== null ||
            !s.genesis_allowed ||
            !c.authorizeGenesis ||
            c.confirmedDigest !== null
      )
        return { kind: "owner-required" } as const;
      if (head && s.head_digest !== c.confirmedDigest && head.prior !== c.confirmedDigest)
        return { kind: "owner-required" } as const;
      return {
        kind: "ready",
        cut: source.cut,
        head: head?.record ?? null,
        genesisAllowed: !!s.genesis_allowed,
      } as const;
    });
  const store: OwnerPublicationStore = {
    async read(t): Promise<OwnerRead> {
      return withControl(ctx, "owner", t.room, (c) => read(c, t)).catch(() => ({
        kind: "owner-required",
      }));
    },
    async commit(input) {
      const t = input.target;
      return withControl(ctx, "owner", t.room, (c) =>
        Effect.gen(function* () {
          // Acquire the SQLite writer before comparing the exact migration-163 source.
          yield* sql`UPDATE main.pages_room_owner_slots SET fence=fence WHERE ${bound(sql, t)}`;
          const current = yield* read(c, t);
          if (current.kind === "revoked" || current.kind === "owner-required") return current.kind;
          if (
            current.kind !== "ready" ||
            current.cut.revision !== input.cut.revision ||
            current.cut.throughSequence !== input.cut.throughSequence ||
            current.cut.generation !== input.cut.generation ||
            !equalBytes(current.cut.state, input.cut.state)
          )
            return "cut-changed" as const;
          const head = current.head?.anchor.bundleDigest ?? null;
          if (head !== input.expectedHead) return "conflict" as const;
          yield* Effect.try({ try: input.assertCurrent, catch: denied });
          const r = input.record;
          if (!r) {
            const rows =
              yield* sql`UPDATE main.pages_room_owner_outbox SET fence=${t.fence} WHERE ${bound(sql, t)} AND bundle_digest=${head} RETURNING fence`;
            if (rows.length !== 1) return "owner-required" as const;
          } else {
            // At most one checkpoint may be pending independent confirmation.
            if (head !== c.confirmedDigest) return "owner-required" as const;
            const [count] = yield* sql<{
              n: number;
            }>`SELECT count(*) AS n FROM main.pages_room_owner_publications WHERE ${bound(sql, t)}`;
            if (!count || count.n >= 32) return "over-budget" as const;
            const { ciphertext, ...header } = r.bundle.checkpoint;
            const hash = r.anchor.bundleDigest;
            yield* sql`INSERT INTO main.pages_room_owner_publications VALUES(${bindingValues(sql, t)},${hash},${head},${r.source.revision},
            ${r.source.throughSequence},${r.source.rawStateDigest},${r.previousCommitDigest},${r.receiptSalt},${JSON.stringify(r.anchor)},${JSON.stringify(header)},${ciphertext})`;
            const changed =
              yield* sql`UPDATE main.pages_room_owner_slots SET head_digest=${hash},published_once=1,genesis_allowed=0
            WHERE ${bound(sql, t)} AND head_digest IS ${head} AND fence=${t.fence} AND active=1 RETURNING fence`;
            if (changed.length !== 1)
              return yield* Effect.fail(new RoomPrivateStoreError("conflict"));
            yield* sql`INSERT INTO main.pages_room_owner_outbox VALUES(${bindingValues(sql, t)},${hash},${t.fence},0)
            ON CONFLICT DO UPDATE SET bundle_digest=excluded.bundle_digest,fence=excluded.fence,delivered=0`;
          }
          yield* Effect.try({ try: input.assertCurrent, catch: denied });
          return "committed" as const;
        }),
      );
    },
  };
  function pendingOwnerCheckpoint(room: OwnerPublicationTarget["room"]) {
    return withControl(ctx, "owner", room, (c) =>
      Effect.gen(function* () {
        const t = c.target,
          [s] = yield* lookup(t);
        if (!active(c, s) || !s?.head_digest) return null;
        const [o] = yield* sql<{
          fence: number;
        }>`SELECT fence FROM main.pages_room_owner_outbox WHERE ${bound(sql, t)}
          AND bundle_digest=${s.head_digest} AND fence=${t.fence} AND delivered=0`;
        if (!o) return null;
        const head = yield* readRecord(t, s.head_digest);
        if (!head || (s.head_digest !== c.confirmedDigest && head.prior !== c.confirmedDigest))
          return yield* Effect.fail(denied());
        const { anchor, bundle } = head.record;
        // Verify exactly the bytes released to the relay, even on replay after a crash.
        const checkpointDigest = createHash("sha256")
          .update(frameDigestInput(bundle.checkpoint))
          .digest("hex");
        const bundleDigest = createHash("sha256")
          .update(bundleDigestInput(bundle, checkpointDigest, []))
          .digest("hex");
        if (checkpointDigest !== anchor.checkpointDigest || bundleDigest !== s.head_digest)
          return yield* Effect.fail(denied());
        return {
          fence: t.fence,
          digest: s.head_digest,
          bundle,
          anchor,
          expected: head.prior,
          previousCommit: head.record.previousCommitDigest,
        };
      }),
    );
  }
  return {
    store,
    applyControl(
      room: OwnerPublicationTarget["room"],
      expectedVersion: number | null | "existing",
    ) {
      return withControl(ctx, "owner", room, (c) =>
        Effect.gen(function* () {
          const t = c.target;
          yield* sql`UPDATE main.pages_room_owner_slots SET fence=fence WHERE ${bound(sql, t)}`;
          const [s] = yield* lookup(t);
          if (!s) {
            if (
              expectedVersion !== null ||
              !c.active ||
              !c.mayEnroll ||
              !c.authorizeGenesis ||
              c.confirmedDigest !== null
            )
              return yield* Effect.fail(denied());
            yield* sql`INSERT INTO main.pages_room_owner_slots VALUES(${bindingValues(sql, t)},${t.pageId},${t.senderRef},${t.scopeKey},
            ${t.fence},${c.authorityVersion},1,1,0,NULL,NULL)`;
            return c.authorityVersion;
          }
          if (
            (expectedVersion !== "existing" && s.authority_version !== expectedVersion) ||
            c.authorityVersion < s.authority_version ||
            t.fence < s.fence ||
            t.pageId !== s.page_id ||
            t.scopeKey !== s.scope_key
          )
            return yield* Effect.fail(new RoomPrivateStoreError("conflict"));
          const genesis =
            !!c.active && !!c.authorizeGenesis && !s.published_once && c.confirmedDigest === null;
          if (c.authorityVersion === s.authority_version) {
            if (
              !sameOwner(s, t) ||
              !!s.active !== c.active ||
              s.confirmed_digest !== c.confirmedDigest ||
              !!s.genesis_allowed !== genesis
            )
              return yield* Effect.fail(denied());
            return c.authorityVersion;
          }
          if (
            c.confirmedDigest !== s.confirmed_digest &&
            (c.confirmedDigest === null || c.confirmedDigest !== s.head_digest)
          )
            return yield* Effect.fail(denied());
          if (c.active && s.sender_ref !== t.senderRef && c.confirmedDigest !== s.head_digest)
            return yield* Effect.fail(denied());
          if ((s.sender_ref !== t.senderRef || !!s.active !== c.active) && t.fence <= s.fence)
            return yield* Effect.fail(denied());
          yield* sql`UPDATE main.pages_room_owner_slots SET fence=${t.fence},sender_ref=${t.senderRef},authority_version=${c.authorityVersion},
          active=${Number(c.active)},genesis_allowed=${Number(genesis)},confirmed_digest=${c.confirmedDigest} WHERE ${bound(sql, t)}`;
          // Only a newly verified matching head pin can collect old ciphertext.
          if (c.active && c.confirmedDigest !== null && c.confirmedDigest === s.head_digest) {
            yield* sql`DELETE FROM main.pages_room_owner_publications AS p WHERE ${bound(sql, t)} AND bundle_digest<>${c.confirmedDigest}
            AND NOT EXISTS(SELECT 1 FROM main.pages_room_owner_outbox o WHERE o.profile_ref=p.profile_ref AND o.tenant_ref=p.tenant_ref AND o.room_id=p.room_id
              AND o.document_generation=p.document_generation AND o.key_epoch=p.key_epoch AND o.bundle_digest=p.bundle_digest)
            AND NOT EXISTS(SELECT 1 FROM main.pages_room_device_installs d WHERE d.tenant_ref=p.tenant_ref AND d.room_id=p.room_id
              AND d.document_generation=p.document_generation AND d.key_epoch=p.key_epoch AND d.bundle_digest=p.bundle_digest)`;
          }
          return c.authorityVersion;
        }),
      );
    },
    pendingOwnerCheckpoint,
    async pendingDelivery(room: OwnerPublicationTarget["room"]) {
      const checkpoint = await pendingOwnerCheckpoint(room);
      if (!checkpoint) return null;
      const { fence, digest, bundle } = checkpoint;
      return { fence, digest, bundle };
    },
    acknowledge(room: OwnerPublicationTarget["room"], fence: number, hash: string) {
      return withControl(ctx, "owner", room, (c) =>
        Effect.gen(function* () {
          const t = c.target,
            [s] = yield* lookup(t);
          if (!digest(hash) || fence !== t.fence || !active(c, s) || s?.head_digest !== hash)
            return false;
          const rows =
            yield* sql`UPDATE main.pages_room_owner_outbox SET delivered=1 WHERE ${bound(sql, t)} AND bundle_digest=${hash} AND fence=${fence} RETURNING fence`;
          return rows.length === 1;
        }),
      );
    },
  };
}
