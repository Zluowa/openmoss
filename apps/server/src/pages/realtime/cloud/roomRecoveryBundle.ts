import * as Y from "yjs";
import {
  createRoomEnvelopeAuthority,
  type RoomFrameReceiver,
  type RoomKeyLease,
  type RoomKeyProvider,
} from "./roomEnvelope";
import {
  roomIdentity,
  streamIdentity,
  type RoomBinding,
  type RoomStreamBinding,
  type SealedRoomFrame,
} from "./roomEnvelopeProtocol";
import {
  RECOVERY_BUNDLE_BYTES,
  RoomRecoveryError,
  bundleDigestInput,
  checkBundleShape,
  checkRecoveryFloor,
  copyRecoveryAnchor,
  copyRecoveryBundle,
  copyRecoveryFloor,
  decodeRecoveryPayload,
  entryDigestInput,
  equalBytes,
  failRecovery,
  frameDigestInput,
  stateDigestInput,
  type RecoveryAnchor,
  type RecoveryBundle,
  type RecoveryErrorCode,
  type RecoveryFloor,
  type RecoveryPayloadContext,
} from "./roomRecoveryProtocol";

/** Synchronous trusted current-owner/floor snapshot. No production provider. */
export interface RecoveryAnchorProvider {
  capture(room: RoomBinding): RecoveryAnchorGrant | null;
}
export interface RecoveryAnchorGrant {
  readonly anchor: RecoveryAnchor;
  readonly floor: RecoveryFloor | null;
  readonly revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
declare const admissionBrand: unique symbol, candidateBrand: unique symbol;
export interface RecoveryAdmission {
  readonly [admissionBrand]: true;
  readonly room: RoomBinding;
}
export interface VerifiedRecoveryCandidate {
  readonly [candidateBrand]: true;
  /** Copy for pre-staging, never the verifier's retained bytes. */
  readonly update: Uint8Array<ArrayBuffer>;
}
export interface RoomRecoveryVerifier {
  /** Current captured key and owner grant, also after a candidate was taken. */
  assertCurrent(): void;
  prepare(bundle: RecoveryBundle | null, signal?: AbortSignal): Promise<VerifiedRecoveryCandidate>;
  /** Only releases a verified copy. No durable saved, anchor update or document swap. */
  take(candidate: VerifiedRecoveryCandidate): {
    readonly update: Uint8Array<ArrayBuffer>;
    readonly anchor: RecoveryAnchor;
  };
  discard(candidate: VerifiedRecoveryCandidate): void;
  close(): void;
}
interface HeldCandidate {
  token: VerifiedRecoveryCandidate;
  update: Uint8Array<ArrayBuffer>;
  unlink: () => void;
  signal?: AbortSignal;
}
interface AdmissionState {
  token: RecoveryAdmission;
  lease: RoomKeyLease;
  anchor: RecoveryAnchor;
  floor: RecoveryFloor | null;
  grant: RecoveryAnchorGrant;
  receivers: Map<string, RoomFrameReceiver>;
  unlink: () => void;
  claimed: boolean;
  reason?: RecoveryErrorCode;
  held?: HeldCandidate;
}

/** Single active bounded bundle; all work is local. A trusted anchor, not group
 * AEAD or a relay's newest number, establishes freshness/owner authorization. */
export function createRoomRecoveryAuthority(
  keys: RoomKeyProvider,
  anchors: RecoveryAnchorProvider,
) {
  const permits = new WeakMap<object, { lease: RoomKeyLease; identity: string }>();
  const core = createRoomEnvelopeAuthority(keys, {}, (token, lease, stream) => {
    const permit = permits.get(token);
    permits.delete(token);
    return permit?.lease === lease && permit.identity === streamIdentity(stream);
  });
  let closed = false,
    capturing = false,
    verifying = false;
  let active: AdmissionState | undefined;
  // At most two private historical readers survive a grant refresh so a newer
  // trusted tail of the same checkpoint can reuse its real stream admission.
  // No read reaches them until the new exact anchor has passed full digest checks.
  let cache:
    | {
        lease: RoomKeyLease;
        id: string;
        version: number;
        digest: string;
        receivers: Map<string, RoomFrameReceiver>;
      }
    | undefined;

  function clearCache() {
    if (!cache) return;
    for (const receiver of cache.receivers.values()) receiver.close();
    cache.receivers.clear();
    cache = undefined;
  }
  function readers(lease: RoomKeyLease, anchor: RecoveryAnchor) {
    if (
      cache?.lease === lease &&
      cache.id === anchor.checkpointId &&
      cache.version === anchor.checkpointVersion &&
      cache.digest === anchor.checkpointDigest
    )
      return cache.receivers;
    clearCache();
    cache = {
      lease,
      id: anchor.checkpointId,
      version: anchor.checkpointVersion,
      digest: anchor.checkpointDigest,
      receivers: new Map(),
    };
    return cache.receivers;
  }

  function forgetCandidate(state: AdmissionState) {
    const held = state.held;
    if (!held) return;
    delete state.held;
    held.unlink();
    held.update.fill(0);
  }
  function end(state: AdmissionState, reason: RecoveryErrorCode) {
    if (state.reason) return;
    state.reason = reason;
    if (active === state) active = undefined;
    forgetCandidate(state);
    try {
      state.unlink();
    } catch {
      /* No provider exception escapes. */
    }
    try {
      state.grant.release();
    } catch {
      /* Already unusable locally. */
    }
  }
  function check(state: AdmissionState, signal?: AbortSignal) {
    if (state.reason) failRecovery(state.reason);
    if (closed || active !== state) failRecovery("closed");
    try {
      core.assertCurrent(state.lease);
      state.grant.assertCurrent();
      // The anchor's check can synchronously trigger shared account logout.
      core.assertCurrent(state.lease);
    } catch {
      end(state, "revoked");
      failRecovery("revoked");
    }
    if (state.reason) failRecovery(state.reason);
    if (closed || active !== state) failRecovery("closed");
    if (signal?.aborted) failRecovery("aborted");
  }
  async function hash(input: Uint8Array<ArrayBuffer>, state: AdmissionState, signal?: AbortSignal) {
    check(state, signal);
    // Native digest is not cancelable. Keep `verifying`, its snapshot and
    // input owned until the underlying promise actually settles, even after
    // abort/close. No Promise.race that could admit another 4 MiB snapshot.
    let result: ArrayBuffer;
    try {
      result = await globalThis.crypto.subtle.digest("SHA-256", input);
    } catch {
      check(state, signal);
      failRecovery("hash-failed");
    }
    check(state, signal);
    return Array.from(new Uint8Array(result), (byte) => byte.toString(16).padStart(2, "0")).join(
      "",
    );
  }
  async function verifyDigests(
    bundle: RecoveryBundle,
    state: AdmissionState,
    signal?: AbortSignal,
  ) {
    const cp = await hash(frameDigestInput(bundle.checkpoint), state, signal);
    if (cp !== state.anchor.checkpointDigest) failRecovery("digest-mismatch");
    let previous = bundle.coveredCommitDigest;
    const entries: string[] = [];
    for (const entry of bundle.tail) {
      if (entry.previousDigest !== previous) failRecovery("invalid-history");
      const frame = await hash(frameDigestInput(entry.frame), state, signal);
      previous = await hash(entryDigestInput(bundle, entry, frame), state, signal);
      if (
        state.floor?.checkpointVersion === bundle.checkpointVersion &&
        state.floor.commitIndex === entry.commitIndex &&
        state.floor.commitDigest !== previous
      )
        failRecovery("fork");
      entries.push(previous);
    }
    if (
      previous !== state.anchor.tailHeadDigest ||
      (await hash(bundleDigestInput(bundle, cp, entries), state, signal)) !==
        state.anchor.bundleDigest
    )
      failRecovery("digest-mismatch");
  }

  // Private call, only after exact whole-bundle digest/anchor validation.
  async function receiverFor(
    state: AdmissionState,
    stream: RoomStreamBinding,
    signal?: AbortSignal,
  ) {
    check(state, signal);
    state.receivers = readers(state.lease, state.anchor);
    const identity = streamIdentity(stream);
    const existing = state.receivers.get(identity);
    if (existing) return existing;
    if (state.receivers.size >= 2) failRecovery("over-budget");
    const token = Object.freeze({});
    permits.set(token, { lease: state.lease, identity });
    let receiver: RoomFrameReceiver;
    try {
      // Do not cancel admission on a per-attempt abort. Keep this receiver for
      // a retry of the same anchored bundle; never reopen a blank old window.
      receiver = await core.createReceiver(state.lease, stream, undefined, token);
    } catch {
      check(state, signal);
      failRecovery("authentication-failed");
    } finally {
      permits.delete(token);
    }
    if (closed || cache?.receivers !== state.receivers) {
      receiver.close();
      failRecovery("closed");
    }
    state.receivers.set(identity, receiver);
    check(state, signal);
    return receiver;
  }
  async function applyFrame(
    doc: Y.Doc,
    frame: SealedRoomFrame,
    context: RecoveryPayloadContext,
    state: AdmissionState,
    signal?: AbortSignal,
  ) {
    const receiver = await receiverFor(state, frame.stream, signal);
    check(state, signal);
    const prepared = await receiver.prepare(frame, signal).catch(() => {
      check(state, signal);
      return failRecovery("authentication-failed");
    });
    let payload: Uint8Array<ArrayBuffer> | undefined;
    try {
      check(state, signal);
      payload = prepared.payload;
      const { update, vector } = decodeRecoveryPayload(context, payload);
      // Yjs may retain binary views from its decoder. Give the candidate doc
      // its own bytes before clearing the independently owned payload below.
      try {
        Y.applyUpdate(doc, new Uint8Array(update));
      } catch {
        failRecovery("invalid-yjs");
      }
      if (vector && !equalBytes(vector, Y.encodeStateVector(doc))) failRecovery("invalid-yjs");
    } finally {
      // Historical reads are repeatable only under the current exact anchor.
      // Never consume live replay as a substitute for a durable recovery floor.
      prepared.abort();
      payload?.fill(0);
    }
  }
  function hold(
    state: AdmissionState,
    update: Uint8Array<ArrayBuffer>,
    signal?: AbortSignal,
  ): VerifiedRecoveryCandidate {
    check(state, signal);
    const token = Object.freeze({
      get update(): Uint8Array<ArrayBuffer> {
        check(state, signal);
        if (state.held?.token !== token) failRecovery("invalid-capability");
        return new Uint8Array(update);
      },
    }) as VerifiedRecoveryCandidate;
    const abort = () => forgetCandidate(state);
    state.held = {
      token,
      update,
      unlink: () => signal?.removeEventListener("abort", abort),
      ...(signal ? { signal } : {}),
    };
    signal?.addEventListener("abort", abort, { once: true });
    return token;
  }

  return Object.freeze({
    acquireRoom: core.acquireRoom,
    assertCurrent: core.assertCurrent,
    admit(lease: RoomKeyLease): RecoveryAdmission {
      if (closed) failRecovery("closed");
      if (active || capturing || verifying) failRecovery("busy");
      try {
        core.assertCurrent(lease);
      } catch {
        failRecovery("invalid-capability");
      }
      capturing = true;
      let grant: RecoveryAnchorGrant | null = null;
      let state: AdmissionState | undefined;
      try {
        let anchor: RecoveryAnchor, floor: RecoveryFloor | null, revoked: AbortSignal;
        try {
          grant = anchors.capture(lease.binding);
          if (!grant) failRecovery("anchor-required");
          anchor = copyRecoveryAnchor(grant.anchor);
          floor = copyRecoveryFloor(grant.floor);
          revoked = grant.revoked;
        } catch {
          failRecovery("anchor-required");
        }
        if (closed) failRecovery("closed");
        if (roomIdentity(anchor.room) !== roomIdentity(lease.binding))
          failRecovery("binding-mismatch");
        checkRecoveryFloor(anchor, floor);
        const token = Object.freeze({ room: lease.binding }) as RecoveryAdmission;
        state = {
          token,
          lease,
          anchor,
          floor,
          grant,
          claimed: false,
          receivers: new Map(),
          unlink: () => {},
        };
        active = state;
        const owned = state;
        const onRevoke = () => end(owned, "revoked");
        try {
          state.unlink = () => revoked.removeEventListener("abort", onRevoke);
          revoked.addEventListener("abort", onRevoke, { once: true });
          if (revoked.aborted) onRevoke();
        } catch {
          end(state, "revoked");
          failRecovery("revoked");
        }
        check(state);
        return token;
      } catch (error) {
        if (state) end(state, state.reason ?? "closed");
        else if (grant) {
          try {
            grant.release();
          } catch {
            /* Provider errors are redacted. */
          }
        }
        // Provider calls/getters above each have their own fixed boundary.
        if (error instanceof RoomRecoveryError) failRecovery(error.code);
        failRecovery("anchor-required");
      } finally {
        capturing = false;
      }
    },
    openVerifier(token: RecoveryAdmission): RoomRecoveryVerifier {
      const state = active;
      if (!state || state.token !== token || state.claimed) failRecovery("invalid-capability");
      check(state);
      state.claimed = true;
      function held(candidate: VerifiedRecoveryCandidate) {
        check(state!);
        const current = state!.held;
        if (!current || current.token !== candidate) failRecovery("invalid-capability");
        check(state!, current.signal);
        return current;
      }
      return Object.freeze({
        assertCurrent() {
          check(state);
        },
        async prepare(
          input: RecoveryBundle | null,
          signal?: AbortSignal,
        ): Promise<VerifiedRecoveryCandidate> {
          check(state, signal);
          if (verifying || state.held) failRecovery("busy");
          if (input === null) failRecovery("owner-required");
          verifying = true;
          let doc: Y.Doc | undefined;
          try {
            let bundle: RecoveryBundle;
            try {
              bundle = copyRecoveryBundle(input);
            } catch (error) {
              failRecovery(
                error instanceof RoomRecoveryError && error.code === "over-budget"
                  ? "over-budget"
                  : "invalid-bundle",
              );
            }
            checkBundleShape(bundle, state.anchor);
            await verifyDigests(bundle, state, signal);
            check(state, signal);
            doc = new Y.Doc({ gc: false });
            const common = {
              checkpointId: bundle.checkpointId,
              checkpointVersion: bundle.checkpointVersion,
            };
            await applyFrame(
              doc,
              bundle.checkpoint,
              {
                ...common,
                kind: "checkpoint",
                commitIndex: bundle.coveredCommitIndex,
                previousDigest: bundle.coveredCommitDigest,
              },
              state,
              signal,
            );
            for (const entry of bundle.tail) {
              await applyFrame(
                doc,
                entry.frame,
                {
                  ...common,
                  kind: "committed-update",
                  commitIndex: entry.commitIndex,
                  previousDigest: entry.previousDigest,
                },
                state,
                signal,
              );
            }
            check(state, signal);
            const update = Y.encodeStateAsUpdate(doc);
            if (update.byteLength > RECOVERY_BUNDLE_BYTES) failRecovery("over-budget");
            if (
              (await hash(stateDigestInput(update), state, signal)) !==
              state.anchor.finalStateDigest
            )
              failRecovery("digest-mismatch");
            check(state, signal);
            return hold(state, new Uint8Array(update), signal);
          } catch (error) {
            check(state, signal);
            if (error instanceof RoomRecoveryError) failRecovery(error.code);
            failRecovery("invalid-yjs");
          } finally {
            try {
              doc?.destroy();
            } catch {
              forgetCandidate(state);
              failRecovery("invalid-yjs");
            } finally {
              verifying = false;
            }
          }
        },
        take(candidate: VerifiedRecoveryCandidate) {
          const result = { update: new Uint8Array(held(candidate).update), anchor: state.anchor };
          forgetCandidate(state);
          return Object.freeze(result);
        },
        discard(candidate: VerifiedRecoveryCandidate) {
          held(candidate);
          forgetCandidate(state);
        },
        close() {
          end(state, "closed");
        },
      });
    },
    close() {
      closed = true;
      if (active) end(active, "closed");
      clearCache();
      core.close();
    },
  });
}
