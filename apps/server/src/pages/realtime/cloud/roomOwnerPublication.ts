import * as Y from "yjs";
import {
  createRoomEnvelopeAuthority,
  type RoomKeyLease,
  type RoomKeyProvider,
} from "./roomEnvelope";
import {
  ROOM_ENVELOPE_LIMITS,
  copyBytes,
  copyRoomBinding,
  encodeStreamId,
  envelopeRecord,
  envelopeReference,
  roomByteLength,
  roomIdentity,
  type RoomBinding,
} from "./roomEnvelopeProtocol";
import {
  RECOVERY_FORMAT,
  bundleDigestInput,
  checkBundleShape,
  copyRecoveryAnchor,
  copyRecoveryBundle,
  encodeRecoveryPayload,
  frameDigestInput,
  stateDigestInput,
  type RecoveryAnchor,
  type RecoveryBundle,
} from "./roomRecoveryProtocol";
import type { CommittedRoomCut } from "./pageRoomCommittedCut";

/** All target fields come from the trusted owner provider. A local writer name,
 * guest ticket or a caller-supplied page ID does not issue this grant. */
export interface OwnerPublicationTarget {
  readonly room: RoomBinding;
  readonly profileRef: string;
  readonly scopeKey: string;
  readonly pageId: string;
  readonly senderRef: string;
  readonly fence: number;
}
export interface RoomOwnerGrant {
  readonly target: OwnerPublicationTarget;
  readonly revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
export interface RoomOwnerProvider {
  capture(room: RoomBinding): RoomOwnerGrant | null;
}

export interface OwnerSourceStamp {
  readonly generation: string;
  readonly revision: number;
  readonly throughSequence: number;
  readonly rawStateDigest: string;
}
/** Owner private record. Only bundle goes to the opaque relay; the raw source
 * digest, random receipt salt and trusted anchor stay on the owner side. */
export interface OwnerPublicationRecord {
  readonly source: OwnerSourceStamp;
  readonly previousCommitDigest: string | null;
  readonly receiptSalt: string;
  readonly anchor: RecoveryAnchor;
  readonly bundle: RecoveryBundle;
}
export type OwnerRead =
  | {
      readonly kind: "ready";
      readonly cut: CommittedRoomCut;
      readonly head: OwnerPublicationRecord | null;
      readonly genesisAllowed: boolean;
    }
  | { readonly kind: "revoked" | "cut-not-ready" | "over-budget" | "owner-required" };
export interface OwnerPublicationCAS {
  readonly target: OwnerPublicationTarget;
  readonly cut: CommittedRoomCut;
  readonly expectedHead: string | null;
  /** null confirms idempotent reuse under the same fresh source/fence/head CAS. */
  readonly record: OwnerPublicationRecord | null;
  readonly assertCurrent: () => void;
}
export type OwnerCommit =
  | "over-budget"
  | "committed"
  | "conflict"
  | "revoked"
  | "cut-changed"
  | "owner-required";
/** Trusted storage boundary. read obtains
 * one SQLite snapshot. commit MUST recheck durable fence, head and exact raw
 * source in the write transaction that persists blob, head and outbox together. */
export interface OwnerPublicationStore {
  read(target: OwnerPublicationTarget): Promise<OwnerRead>;
  commit(input: OwnerPublicationCAS): Promise<OwnerCommit>;
}
type PublicationErrorCode =
  | "closed"
  | "busy"
  | "aborted"
  | "revoked"
  | "invalid-lease"
  | "owner-required"
  | "over-budget"
  | "cut-not-ready"
  | "cut-changed"
  | "conflict"
  | "invalid-cut"
  | "invalid-head"
  | "crypto-failed"
  | "storage-unavailable"
  | "commit-unknown";
export class RoomOwnerPublicationError extends Error {
  constructor(readonly code: PublicationErrorCode) {
    super(`Room owner publication: ${code}`);
  }
}
function fail(code: PublicationErrorCode): never {
  throw new RoomOwnerPublicationError(code);
}
const digestPattern = /^[0-9a-f]{64}$/u;
const randomPattern = /^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/u;
const text = new TextEncoder();

function targetFrom(input: unknown): OwnerPublicationTarget {
  const fields = envelopeRecord(input, [
    "room",
    "profileRef",
    "scopeKey",
    "pageId",
    "senderRef",
    "fence",
  ]);
  if (
    typeof fields.scopeKey !== "string" ||
    !/^(?:local-default|project-space:[A-Za-z0-9_-]{1,128})$/u.test(fields.scopeKey) ||
    typeof fields.fence !== "number" ||
    !Number.isSafeInteger(fields.fence) ||
    fields.fence < 1
  )
    fail("owner-required");
  return Object.freeze({
    room: copyRoomBinding(fields.room),
    profileRef: envelopeReference(fields.profileRef),
    scopeKey: fields.scopeKey,
    pageId: envelopeReference(fields.pageId),
    senderRef: envelopeReference(fields.senderRef),
    fence: fields.fence,
  });
}
function copyHead(
  value: OwnerPublicationRecord,
  target: OwnerPublicationTarget,
): OwnerPublicationRecord {
  const anchor = copyRecoveryAnchor(value.anchor),
    bundle = copyRecoveryBundle(value.bundle);
  checkBundleShape(bundle, anchor);
  const source = Object.freeze({
    generation: value.source.generation,
    revision: value.source.revision,
    throughSequence: value.source.throughSequence,
    rawStateDigest: value.source.rawStateDigest,
  });
  if (
    roomIdentity(anchor.room) !== roomIdentity(target.room) ||
    source.generation !== target.room.documentGeneration ||
    !Number.isSafeInteger(source.revision) ||
    source.revision < 1 ||
    !Number.isSafeInteger(source.throughSequence) ||
    source.throughSequence < 0 ||
    !digestPattern.test(source.rawStateDigest) ||
    !randomPattern.test(value.receiptSalt) ||
    bundle.tail.length ||
    anchor.tailHeadDigest !== anchor.coveredCommitDigest ||
    anchor.coveredCommitIndex !== anchor.tailEndCommitIndex ||
    anchor.checkpointVersion !== anchor.coveredCommitIndex + 1 ||
    (anchor.coveredCommitIndex === 0
      ? value.previousCommitDigest !== null
      : !digestPattern.test(value.previousCommitDigest ?? ""))
  )
    fail("invalid-head");
  return Object.freeze({
    source,
    previousCommitDigest: value.previousCommitDigest,
    receiptSalt: value.receiptSalt,
    anchor,
    bundle,
  });
}
function randomId() {
  try {
    return encodeStreamId(globalThis.crypto.getRandomValues(new Uint8Array(32)));
  } catch {
    fail("crypto-failed");
  }
}
function commitInput(
  room: RoomBinding,
  index: number,
  previous: string | null,
  salt: string,
  source: OwnerSourceStamp,
) {
  return text.encode(
    JSON.stringify([
      "moss-room-owner-cut-commit",
      1,
      roomIdentity(room),
      index,
      previous,
      salt,
      source.generation,
      source.revision,
      source.throughSequence,
      source.rawStateDigest,
    ]),
  );
}
function normalizeCut(state: Uint8Array<ArrayBuffer>) {
  const doc = new Y.Doc({ gc: false });
  try {
    Y.applyUpdate(doc, new Uint8Array(state));
    const vector = new Uint8Array(Y.encodeStateVector(doc));
    // Yjs can accept an update without integrating it: it keeps unresolved
    // structs/delete ranges for later. Only closed causal state can be minted
    // as the authoritative full checkpoint. Use public pinned Yjs APIs here.
    const integrated = Y.decodeStateVector(vector);
    const residual = Y.decodeUpdate(Y.encodeStateAsUpdate(doc, vector));
    if (residual.structs.length) fail("invalid-cut");
    for (const [client, ranges] of residual.ds.clients) {
      if (ranges.some((range) => range.clock + range.len > (integrated.get(client) ?? 0)))
        fail("invalid-cut");
    }
    return { update: new Uint8Array(Y.encodeStateAsUpdate(doc)), vector };
  } catch {
    fail("invalid-cut");
  } finally {
    try {
      doc.destroy();
    } catch {
      fail("invalid-cut");
    }
  }
}

/** Internal, checkpoint-only owner publisher. Its only caller-supplied authority
 * input is an actual lease minted by this core. No service/transport registration. */
export function createRoomOwnerPublisher(
  keys: RoomKeyProvider,
  owners: RoomOwnerProvider,
  store: OwnerPublicationStore,
) {
  const core = createRoomEnvelopeAuthority(keys);
  let closed = false,
    publishing = false;
  return Object.freeze({
    acquireRoom: core.acquireRoom,
    async publish(lease: RoomKeyLease, signal?: AbortSignal) {
      if (closed) fail("closed");
      if (publishing) fail("busy");
      if (signal?.aborted) fail("aborted");
      try {
        core.assertCurrent(lease);
      } catch {
        fail("invalid-lease");
      }
      publishing = true;
      let grant: RoomOwnerGrant | null = null;
      try {
        let target: OwnerPublicationTarget, revoked: AbortSignal;
        try {
          grant = owners.capture(lease.binding);
          if (!grant) fail("owner-required");
          target = targetFrom(grant.target);
          revoked = grant.revoked;
        } catch {
          fail("owner-required");
        }
        if (roomIdentity(target.room) !== roomIdentity(lease.binding)) fail("owner-required");
        const captured = grant;
        const check = () => {
          if (closed) fail("closed");
          if (signal?.aborted) fail("aborted");
          try {
            if (revoked.aborted) fail("revoked");
            core.assertCurrent(lease);
            captured.assertCurrent();
            core.assertCurrent(lease);
            if (revoked.aborted) fail("revoked");
          } catch {
            fail("revoked");
          }
          if (closed) fail("closed");
          if (signal?.aborted) fail("aborted");
        };
        const hash = async (bytes: Uint8Array<ArrayBuffer>) => {
          check();
          let result: ArrayBuffer;
          try {
            result = await globalThis.crypto.subtle.digest("SHA-256", bytes);
          } catch {
            check();
            fail("crypto-failed");
          }
          check();
          return Array.from(new Uint8Array(result), (b) => b.toString(16).padStart(2, "0")).join(
            "",
          );
        };
        check();
        let snapshot: OwnerRead;
        try {
          const raw = await store.read(target);
          snapshot =
            raw.kind === "ready"
              ? { kind: "ready", cut: raw.cut, head: raw.head, genesisAllowed: raw.genesisAllowed }
              : { kind: raw.kind };
        } catch {
          check();
          fail("storage-unavailable");
        }
        check();
        if (snapshot.kind !== "ready") {
          switch (snapshot.kind) {
            case "revoked":
            case "cut-not-ready":
            case "over-budget":
            case "owner-required":
              fail(snapshot.kind);
            default:
              fail("storage-unavailable");
          }
        }
        let cut: CommittedRoomCut, prior: OwnerPublicationRecord | null;
        try {
          const input = snapshot.cut;
          if (
            input.generation !== target.room.documentGeneration ||
            !Number.isSafeInteger(input.revision) ||
            input.revision < 1 ||
            !Number.isSafeInteger(input.throughSequence) ||
            input.throughSequence < 0
          )
            fail("invalid-cut");
          cut = Object.freeze({
            generation: input.generation,
            revision: input.revision,
            throughSequence: input.throughSequence,
            state: copyBytes(input.state, ROOM_ENVELOPE_LIMITS.frameBytes, 1),
          });
        } catch {
          fail("invalid-cut");
        }
        try {
          prior = snapshot.head === null ? null : copyHead(snapshot.head, target);
        } catch {
          fail("invalid-head");
        }
        if (!prior && snapshot.genesisAllowed !== true) fail("owner-required");
        const source: OwnerSourceStamp = Object.freeze({
          generation: cut.generation,
          revision: cut.revision,
          throughSequence: cut.throughSequence,
          rawStateDigest: await hash(cut.state),
        });
        const normalized = normalizeCut(cut.state);
        if (roomByteLength(normalized.update) > ROOM_ENVELOPE_LIMITS.frameBytes)
          fail("over-budget");
        const finalStateDigest = await hash(stateDigestInput(normalized.update));
        if (prior) {
          if (
            (await hash(frameDigestInput(prior.bundle.checkpoint))) !==
              prior.anchor.checkpointDigest ||
            (await hash(bundleDigestInput(prior.bundle, prior.anchor.checkpointDigest, []))) !==
              prior.anchor.bundleDigest ||
            (await hash(
              commitInput(
                target.room,
                prior.anchor.coveredCommitIndex,
                prior.previousCommitDigest,
                prior.receiptSalt,
                prior.source,
              ),
            )) !== prior.anchor.coveredCommitDigest
          )
            fail("invalid-head");
          if (
            source.revision < prior.source.revision ||
            source.throughSequence < prior.source.throughSequence
          )
            fail("cut-changed");
        }
        const samePosition =
          prior &&
          source.revision === prior.source.revision &&
          source.throughSequence === prior.source.throughSequence;
        if (prior && samePosition && source.rawStateDigest !== prior.source.rawStateDigest)
          fail("cut-changed");
        if (prior && samePosition && finalStateDigest !== prior.anchor.finalStateDigest)
          fail("invalid-head");
        let record: OwnerPublicationRecord;
        if (prior && samePosition) {
          record = prior;
        } else {
          const checkpointVersion = (prior?.anchor.checkpointVersion ?? 0) + 1;
          const index = (prior?.anchor.tailEndCommitIndex ?? -1) + 1;
          if (!Number.isSafeInteger(checkpointVersion) || !Number.isSafeInteger(index))
            fail("over-budget");
          const checkpointId = randomId(),
            receiptSalt = randomId();
          if (
            checkpointId === receiptSalt ||
            checkpointId === prior?.anchor.checkpointId ||
            receiptSalt === prior?.receiptSalt
          )
            fail("crypto-failed");
          const previous = prior?.anchor.tailHeadDigest ?? null;
          const coveredCommitDigest = await hash(
            commitInput(target.room, index, previous, receiptSalt, source),
          );
          let payload: Uint8Array<ArrayBuffer>;
          try {
            payload = encodeRecoveryPayload(
              {
                kind: "checkpoint",
                checkpointId,
                checkpointVersion,
                commitIndex: index,
                previousDigest: coveredCommitDigest,
              },
              normalized.update,
              normalized.vector,
            );
          } catch {
            fail("over-budget");
          }
          check();
          const writer = await core
            .createWriter(lease, target.senderRef, "checkpoint")
            .catch(() => {
              check();
              return fail("crypto-failed");
            });
          let checkpoint: RecoveryBundle["checkpoint"];
          try {
            check();
            checkpoint = await writer.seal("checkpoint", payload);
          } catch {
            check();
            fail("crypto-failed");
          } finally {
            writer.close();
            payload.fill(0);
          }
          check();
          const bundle: RecoveryBundle = Object.freeze({
            format: RECOVERY_FORMAT,
            room: target.room,
            checkpointId,
            checkpointVersion,
            coveredCommitIndex: index,
            coveredCommitDigest,
            checkpoint,
            tail: Object.freeze([]),
          });
          const checkpointDigest = await hash(frameDigestInput(checkpoint));
          const anchor: RecoveryAnchor = Object.freeze({
            format: RECOVERY_FORMAT,
            room: target.room,
            checkpointId,
            checkpointVersion,
            coveredCommitIndex: index,
            coveredCommitDigest,
            checkpointDigest,
            tailEndCommitIndex: index,
            tailHeadDigest: coveredCommitDigest,
            bundleDigest: await hash(bundleDigestInput(bundle, checkpointDigest, [])),
            finalStateDigest,
          });
          record = Object.freeze({
            source,
            previousCommitDigest: previous,
            receiptSalt,
            anchor,
            bundle,
          });
        }
        check();
        let result: OwnerCommit;
        try {
          result = await store.commit({
            target,
            cut,
            expectedHead: prior?.anchor.bundleDigest ?? null,
            record: samePosition ? null : record,
            assertCurrent: check,
          });
        } catch {
          check();
          fail("commit-unknown");
        }
        check();
        if (result !== "committed") {
          switch (result) {
            case "over-budget":
            case "revoked":
            case "cut-changed":
            case "conflict":
            case "owner-required":
              fail(result);
            default:
              fail("commit-unknown");
          }
        }
        return Object.freeze({
          kind: samePosition ? ("reused" as const) : ("published" as const),
          anchor: record.anchor,
          bundle: copyRecoveryBundle(record.bundle),
        });
      } finally {
        if (grant) {
          try {
            grant.release();
          } catch {
            /* Only the recorded outcome escapes. */
          }
        }
        publishing = false;
      }
    },
    close() {
      closed = true;
      core.close();
    },
  });
}
