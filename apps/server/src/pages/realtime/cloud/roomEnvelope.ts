import {
  ROOM_ENVELOPE_SUITE,
  RoomEnvelopeError,
  assertKind,
  copyBytes,
  copyFrame,
  copyRoomBinding,
  copyStreamBinding,
  encodeStreamId,
  envelopeLimits,
  frameParameters,
  rejectEnvelope,
  roomIdentity,
  streamIdentity,
  streamKeyParameters,
  type RoomBinding,
  type RoomEnvelopeErrorCode,
  type RoomEnvelopeLimits,
  type RoomFrameKind,
  type RoomLane,
  type RoomStreamBinding,
  type SealedRoomFrame,
} from "./roomEnvelopeProtocol";

/**
 * Trusted injection boundary; no production provider exists yet. request MUST
 * capture the current authorization generation synchronously. Logout/revoke/
 * account switch permanently invalidates that grant, including A -> B -> A.
 * Public account identifiers supply context, never secret key entropy.
 */
export interface RoomKeyProvider {
  request(binding: RoomBinding, signal: AbortSignal): RoomKeyGrant;
}
export interface RoomKeyGrant {
  /**
   * Non-extractable HKDF key imported from an independently random 256-bit room
   * secret. WebCrypto hides the imported HKDF length, so entropy/length are this
   * trusted provider's obligation; matching public IDs cannot satisfy it.
   */
  readonly key: Promise<CryptoKey>;
  readonly revoked: AbortSignal;
  assertCurrent(): void;
  release(): void;
}
declare const roomLeaseBrand: unique symbol;
export interface RoomKeyLease {
  readonly [roomLeaseBrand]: true;
  readonly binding: RoomBinding;
  close(): void;
}
export interface RoomFrameWriter {
  readonly stream: RoomStreamBinding;
  seal(kind: RoomFrameKind, plaintext: Uint8Array, signal?: AbortSignal): Promise<SealedRoomFrame>;
  close(): void;
}
export interface PreparedRoomFrame {
  /** A fresh copy on every access; mutating it cannot change the committed bytes. */
  readonly payload: Uint8Array<ArrayBuffer>;
  /**
   * Consumes replay state synchronously and returns another authenticated copy.
   * This is NOT a transaction, persistence acknowledgement or durable saved.
   * Stage/validate the candidate first; integration then swaps it without await.
   * A failed external swap requires resync, not replay of this consumed frame.
   */
  commit(): Uint8Array<ArrayBuffer>;
  abort(): void;
}
export interface RoomFrameReceiver {
  prepare(frame: SealedRoomFrame, signal?: AbortSignal): Promise<PreparedRoomFrame>;
  close(): void;
}

class Scope {
  readonly controller = new AbortController();
  readonly cleanup = new Set<() => void>();
  reason: RoomEnvelopeErrorCode | undefined;
  constructor(private readonly assertParent: () => void = () => {}) {}
  addCleanup(cleanup: () => void): void {
    if (this.reason) cleanup();
    else this.cleanup.add(cleanup);
  }
  check(signal?: AbortSignal): void {
    if (this.reason) rejectEnvelope(this.reason);
    this.assertParent();
    if (signal?.aborted) rejectEnvelope("aborted");
  }
  follow(signal: AbortSignal, reason: RoomEnvelopeErrorCode): void {
    const abort = () => this.close(reason);
    signal.addEventListener("abort", abort, { once: true });
    const unlink = () => signal.removeEventListener("abort", abort);
    this.addCleanup(unlink);
    if (signal.aborted) this.close(reason);
  }
  close(reason: RoomEnvelopeErrorCode = "closed"): void {
    if (this.reason) return;
    this.reason = reason;
    this.controller.abort();
    for (const cleanup of this.cleanup) cleanup();
    this.cleanup.clear();
  }
}

// Cancellation does not cancel native WebCrypto. The caller keeps its native
// work quota until that underlying promise settles, even if this returns early.
async function currentResult<T>(
  work: Promise<T>,
  scope: Scope,
  signal: AbortSignal | undefined,
  failure: RoomEnvelopeErrorCode,
): Promise<T> {
  let unlisten = () => {};
  const canceled = new Promise<never>((_, reject) => {
    const abort = () => reject(new RoomEnvelopeError(scope.reason ?? "aborted"));
    scope.controller.signal.addEventListener("abort", abort, { once: true });
    signal?.addEventListener("abort", abort, { once: true });
    unlisten = () => {
      scope.controller.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    };
    if (scope.controller.signal.aborted || signal?.aborted) abort();
  });
  try {
    const result = await Promise.race([work, canceled]);
    scope.check(signal);
    return result;
  } catch {
    scope.check(signal);
    // Only our current scope can authorize lifecycle errors. Never propagate a
    // provider/native exception object, even if it resembles our error class.
    rejectEnvelope(failure);
  } finally {
    unlisten();
  }
}

interface LeaseState {
  readonly scope: Scope;
  key: CryptoKey | undefined;
}

/**
 * Only trusted composition code may construct an authority, acquire leases or
 * admit a receiver. Frame headers NEVER admit a stream. Lease identity is checked
 * using this authority's private WeakMap, not brands or equal public fields.
 *
 * Group AEAD proves room-key possession, NOT sender/owner identity. Authorization
 * and cross-restart replay floors/key distribution remain separate gates.
 */
export function createRoomEnvelopeAuthority(
  provider: RoomKeyProvider,
  lowerLimits: Partial<RoomEnvelopeLimits> = {},
  // Trusted composition only. Ordinary authorities cannot admit historical
  // streams; recovery supplies a private identity-based one-use capability.
  consumeRecoveryPermit?: (
    permit: object,
    lease: RoomKeyLease,
    stream: RoomStreamBinding,
  ) => boolean,
) {
  const limits = envelopeLimits(lowerLimits);
  const authority = new Scope();
  const leases = new WeakMap<RoomKeyLease, LeaseState>();
  const active = new Set<Scope>();
  // No eviction: reopening an old admission with an empty window is forbidden.
  // This is authority-lifetime memory, not a persistent replay database.
  const issuedStreams = new Set<string>();
  const admittedStreams = new Set<string>();
  let pendingKeys = 0;
  let derivations = 0;
  let nativeFrames = 0;
  let reservations = 0;

  function stateFor(lease: RoomKeyLease): LeaseState {
    authority.check();
    const state = leases.get(lease);
    if (!state) rejectEnvelope("invalid-lease");
    state.scope.check();
    return state;
  }
  function reserveStream(registry: Set<string>, identity: string): void {
    if (registry.has(identity)) rejectEnvelope("stream-reused");
    if (issuedStreams.size + admittedStreams.size >= limits.streams)
      rejectEnvelope("budget-exceeded");
    registry.add(identity);
  }
  async function streamKey(
    state: LeaseState,
    stream: RoomStreamBinding,
    scope: Scope,
    signal?: AbortSignal,
  ) {
    scope.check(signal);
    if (!state.key) rejectEnvelope("revoked");
    if (derivations >= limits.pending) rejectEnvelope("budget-exceeded");
    derivations++;
    const work = Promise.resolve().then(() => {
      scope.check(signal);
      return globalThis.crypto.subtle.deriveKey(
        streamKeyParameters(stream),
        state.key!,
        { name: "AES-GCM", length: 256 },
        false,
        ["encrypt", "decrypt"],
      );
    });
    void work.then(
      () => {
        derivations--;
      },
      () => {
        derivations--;
      },
    );
    return currentResult(work, scope, signal, "crypto-failed");
  }
  function childScope(state: LeaseState): Scope {
    const child = new Scope(() => state.scope.check());
    child.follow(state.scope.controller.signal, "revoked");
    return child;
  }

  return Object.freeze({
    /** Revalidates an actual capability without exposing its key material. */
    assertCurrent(lease: RoomKeyLease): void {
      stateFor(lease);
    },
    revocationSignal(lease: RoomKeyLease): AbortSignal {
      return stateFor(lease).scope.controller.signal;
    },
    async acquireRoom(input: RoomBinding, signal?: AbortSignal): Promise<RoomKeyLease> {
      authority.check(signal);
      const binding = copyRoomBinding(input);
      if (active.size >= limits.leases || pendingKeys >= limits.pending)
        rejectEnvelope("budget-exceeded");
      const scope = new Scope(() => authority.check());
      active.add(scope);
      scope.addCleanup(() => active.delete(scope));
      scope.follow(authority.controller.signal, "closed");
      if (signal) scope.follow(signal, "aborted");
      let grant: RoomKeyGrant;
      pendingKeys++;
      try {
        scope.check();
        grant = provider.request(binding, scope.controller.signal);
      } catch {
        pendingKeys--;
        scope.close("key-unavailable");
        rejectEnvelope("key-unavailable");
      }
      const state: LeaseState = { scope, key: undefined };
      scope.addCleanup(() => {
        state.key = undefined;
        // release is bookkeeping, and may not leak provider errors to callers.
        try {
          grant.release();
        } catch {
          /* Already revoked locally. */
        }
      });
      let keyWorkTracked = false;
      try {
        const keyWork = Promise.resolve(grant.key);
        // A canceled grant can still own a never-settling provider operation.
        // Its promise, not lease release, controls this authority quota.
        // Both handlers also observe rejection after synchronous revocation.
        keyWorkTracked = true;
        void keyWork.then(
          () => {
            pendingKeys--;
          },
          () => {
            pendingKeys--;
          },
        );
        scope.follow(grant.revoked, "revoked");
        const checkGrant = () => {
          scope.check();
          try {
            grant.assertCurrent();
          } catch {
            scope.close("revoked");
            rejectEnvelope("revoked");
          }
          scope.check(); // A provider check may synchronously signal revocation.
        };
        checkGrant();
        // The provider promise may be slow or never resolve; cancellation still
        // releases the lease. The same generation is checked after the await.
        const key = await currentResult(keyWork, scope, undefined, "key-unavailable");
        checkGrant();
        if (
          key.type !== "secret" ||
          key.algorithm.name !== "HKDF" ||
          key.extractable ||
          key.usages.length !== 1 ||
          key.usages[0] !== "deriveKey"
        )
          rejectEnvelope("key-unavailable");
        state.key = key;
        const checked = new Scope(checkGrant);
        checked.follow(scope.controller.signal, "revoked");
        checked.addCleanup(() => scope.close());
        const token = Object.freeze({ binding, close: () => checked.close() }) as RoomKeyLease;
        leases.set(token, { scope: checked, key });
        checked.addCleanup(() => {
          const saved = leases.get(token);
          if (saved) saved.key = undefined;
        });
        return token;
      } catch {
        if (!keyWorkTracked) pendingKeys--;
        // Synchronous provider getters/follow hooks are also untrusted error
        // boundaries. Only a reason recorded by our scope carries authority.
        const code = scope.reason ?? "key-unavailable";
        scope.close(code);
        rejectEnvelope(code);
      }
    },

    async createWriter(
      lease: RoomKeyLease,
      senderRef: string,
      lane: RoomLane,
      signal?: AbortSignal,
    ): Promise<RoomFrameWriter> {
      const state = stateFor(lease);
      state.scope.check(signal);
      let streamId: string;
      try {
        streamId = encodeStreamId(globalThis.crypto.getRandomValues(new Uint8Array(32)));
      } catch {
        rejectEnvelope("entropy-failed");
      }
      const stream = copyStreamBinding({ room: lease.binding, senderRef, streamId, lane });
      reserveStream(issuedStreams, streamId);
      const scope = childScope(state);
      let key: CryptoKey;
      try {
        key = await streamKey(state, stream, scope, signal);
        scope.check(signal);
      } catch (error) {
        scope.close();
        throw error;
      }
      let next = 0;
      let bytes = 0;
      return Object.freeze({
        stream,
        async seal(
          kind: RoomFrameKind,
          input: Uint8Array,
          operationSignal?: AbortSignal,
        ): Promise<SealedRoomFrame> {
          scope.check(operationSignal);
          assertKind(stream.lane, kind);
          const plaintext = copyBytes(input, limits.frameBytes);
          if (
            next >= limits.streamFrames ||
            bytes + plaintext.byteLength > limits.streamBytes ||
            nativeFrames >= limits.pending
          ) {
            rejectEnvelope("budget-exceeded");
          }
          // Reserve synchronously, before any await. Failures burn seq and bytes.
          const header = Object.freeze({
            v: 1 as const,
            suite: ROOM_ENVELOPE_SUITE,
            stream,
            seq: next++,
            kind,
          });
          bytes += plaintext.byteLength;
          nativeFrames++;
          const work = Promise.resolve().then(() => {
            scope.check(operationSignal);
            return globalThis.crypto.subtle.encrypt(frameParameters(header), key, plaintext);
          });
          void work.then(
            () => {
              nativeFrames--;
              plaintext.fill(0);
            },
            () => {
              nativeFrames--;
              plaintext.fill(0);
            },
          );
          const ciphertext = await currentResult(work, scope, operationSignal, "crypto-failed");
          scope.check(operationSignal);
          return Object.freeze({ ...header, ciphertext: new Uint8Array(ciphertext) });
        },
        close: () => scope.close(),
      });
    },

    /** trustedStream comes from authenticated admission, never untrusted frame data. */
    async createReceiver(
      lease: RoomKeyLease,
      input: RoomStreamBinding,
      signal?: AbortSignal,
      recoveryPermit?: object,
    ): Promise<RoomFrameReceiver> {
      const state = stateFor(lease);
      state.scope.check(signal);
      const stream = copyStreamBinding(input);
      if (roomIdentity(stream.room) !== roomIdentity(lease.binding))
        rejectEnvelope("binding-mismatch");
      if (stream.lane === "checkpoint" || stream.lane === "owner-log") {
        let admitted = false;
        try {
          admitted =
            !!recoveryPermit && consumeRecoveryPermit?.(recoveryPermit, lease, stream) === true;
        } catch {
          /* fail closed */
        }
        if (!admitted) rejectEnvelope("invalid-admission");
      }
      const identity = streamIdentity(stream);
      reserveStream(admittedStreams, identity);
      const scope = childScope(state);
      let key: CryptoKey;
      try {
        key = await streamKey(state, stream, scope, signal);
        scope.check(signal);
      } catch (error) {
        scope.close();
        throw error;
      }
      let highest = -1;
      let seen = 0n;
      const mask = (1n << BigInt(limits.replayWindow)) - 1n;
      const pending = new Set<number>();
      let attempts = 0;
      let bytes = 0;
      const checkSequence = (seq: number) => {
        if (seq <= highest - limits.replayWindow || seq > highest + limits.forwardGap)
          rejectEnvelope("sequence-outside-window");
        if (seq <= highest && (seen & (1n << BigInt(highest - seq))) !== 0n)
          rejectEnvelope("replayed");
      };
      return Object.freeze({
        async prepare(
          inputFrame: SealedRoomFrame,
          operationSignal?: AbortSignal,
        ): Promise<PreparedRoomFrame> {
          scope.check(operationSignal);
          const frame = copyFrame(inputFrame, limits);
          if (streamIdentity(frame.stream) !== identity) rejectEnvelope("binding-mismatch");
          checkSequence(frame.seq);
          if (pending.has(frame.seq)) rejectEnvelope("replayed");
          if (
            reservations >= limits.pending ||
            nativeFrames >= limits.pending ||
            attempts >= limits.streamFrames ||
            bytes + frame.ciphertext.byteLength - 16 > limits.streamBytes
          )
            rejectEnvelope("budget-exceeded");
          attempts++;
          bytes += frame.ciphertext.byteLength - 16;
          pending.add(frame.seq);
          reservations++;
          let payload: Uint8Array<ArrayBuffer> | undefined;
          let spent = false;
          const abort = () => {
            if (spent) return;
            spent = true;
            payload?.fill(0);
            payload = undefined;
            pending.delete(frame.seq);
            reservations--;
            scope.cleanup.delete(abort);
            operationSignal?.removeEventListener("abort", abort);
          };
          scope.addCleanup(abort);
          operationSignal?.addEventListener("abort", abort, { once: true });
          nativeFrames++;
          const work = Promise.resolve().then(() => {
            scope.check(operationSignal);
            return globalThis.crypto.subtle.decrypt(frameParameters(frame), key, frame.ciphertext);
          });
          void work.then(
            (result) => {
              nativeFrames--;
              if (spent || scope.reason || operationSignal?.aborted) new Uint8Array(result).fill(0);
            },
            () => {
              nativeFrames--;
            },
          );
          try {
            const decrypted = new Uint8Array(
              await currentResult(work, scope, operationSignal, "crypto-failed"),
            );
            try {
              scope.check(operationSignal);
              if (spent) rejectEnvelope("prepared-spent");
            } catch (error) {
              decrypted.fill(0);
              throw error;
            }
            payload = decrypted;
            const checkPrepared = () => {
              scope.check(operationSignal);
              if (spent || !payload) rejectEnvelope("prepared-spent");
            };
            return Object.freeze({
              get payload() {
                checkPrepared();
                return new Uint8Array(payload!);
              },
              commit() {
                try {
                  checkPrepared();
                  checkSequence(frame.seq);
                  const result = new Uint8Array(payload!);
                  if (frame.seq > highest) {
                    seen = ((seen << BigInt(frame.seq - highest)) | 1n) & mask;
                    highest = frame.seq;
                  } else {
                    seen |= 1n << BigInt(highest - frame.seq);
                  }
                  return result;
                } finally {
                  abort();
                }
              },
              abort,
            });
          } catch (error) {
            abort();
            throw error;
          }
        },
        close: () => scope.close(),
      });
    },
    close: () => authority.close(),
  });
}
