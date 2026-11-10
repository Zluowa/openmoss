import { createHash, randomBytes } from "node:crypto";
import { GUEST_FRAME_LIMIT } from "../realtime/guestRoomFrame";
import { copyOrdinaryByteView } from "../realtime/ordinaryByteView";
import {
  checkedOwnerBase,
  GuestProjectionError,
  mappedOwnerDelta,
  safeSeed,
  visibleParagraphs,
} from "./guestProjectionContent";
import type {
  GuestProjectionSessions,
  ProjectionBackend,
  ProjectionPage,
  ProjectionReceipt,
  ProjectionTicket,
} from "./guestProjectionSessions";
import type { ProjectionIdentity, ProjectionObservation } from "./guestProjectionSessions";

const ttl = 60_000;
const maxSessions = 16;
const maxOperations = 4;
const maxSeedBytes = 2 * 1024 * 1024;
const hash = (value: string | Uint8Array) => createHash("sha256").update(value).digest("hex");
const unavailable = () => new GuestProjectionError("unavailable");
const conflict = () => new GuestProjectionError("conflict");

interface Session {
  readonly keyHash: string;
  readonly epoch: string;
  readonly pageId: string;
  readonly binding: string;
  readonly subject: string;
  dropped?: "epoch" | "ended";
  readonly revision: number;
  readonly contentHash: string;
  readonly ownerHash: string;
  readonly expires: number;
  seed: Uint8Array | null;
  busy: boolean;
  abortCommit?: () => void;
  receipt?: { requestHash: string; result: ProjectionReceipt };
}

function subject(current: ProjectionIdentity, pageId: string) {
  if (
    current.mode !== "share" ||
    current.role !== "edit" ||
    current.kind !== "page" ||
    current.pageId !== pageId ||
    !Number.isSafeInteger(current.revision) ||
    current.revision < 1 ||
    !/^[a-f0-9]{64}$/.test(current.actorRef) ||
    typeof current.generation !== "string" ||
    !current.generation ||
    current.generation.length > 128 ||
    typeof current.grantEpoch !== "string" ||
    !current.grantEpoch ||
    current.grantEpoch.length > 128 ||
    (current.scope !== null && (typeof current.scope !== "string" || current.scope.length > 256))
  )
    throw unavailable();
  return hash(JSON.stringify([pageId, current.scope, current.actorRef, current.generation]));
}
const binding = (current: ProjectionIdentity, pageId: string) =>
  hash(subject(current, pageId) + ":" + current.grantEpoch);

/** Local capability/epoch state only. All authority and the owner commit belong to
 * the supplied trusted adapters; no user-supplied actor, scope or owner bytes enter. */
export function createProjectionStore<Proof>(
  backend: ProjectionBackend<Proof>,
): GuestProjectionSessions<Proof> {
  const sessions = new Map<string, Session>();
  const operations = new Set<AbortController>();
  const listeners = new Set<() => void>();
  const notify = () => {
    for (const listener of listeners) listener();
  };
  let retained = 0;
  let closed = false;
  let expiryTimer: ReturnType<typeof setTimeout> | undefined;

  function forgetSeed(session: Session) {
    if (!session.seed) return;
    retained -= session.seed.length;
    session.seed.fill(0);
    session.seed = null;
  }

  function drop(session: Session, reason: "ended" | "epoch" = "ended") {
    session.dropped = reason;
    session.abortCommit?.();
    delete session.abortCommit;
    forgetSeed(session);
    sessions.delete(session.keyHash);
    delete session.receipt;
    if (!sessions.size) {
      clearTimeout(expiryTimer);
      expiryTimer = undefined;
    }
    notify();
  }

  function sweep() {
    clearTimeout(expiryTimer);
    expiryTimer = undefined;
    const now = Date.now();
    let next = Infinity;
    for (const session of sessions.values()) {
      if (session.expires <= now) drop(session);
      else next = Math.min(next, session.expires);
    }
    if (!closed && Number.isFinite(next)) expiryTimer = setTimeout(sweep, Math.max(1, next - now));
  }

  async function bounded<A>(
    run: (signal: AbortSignal, abort: () => void) => Promise<A>,
    inputSignal?: AbortSignal,
  ) {
    sweep();
    if (closed || inputSignal?.aborted || operations.size >= maxOperations) throw unavailable();
    const controller = new AbortController();
    operations.add(controller);
    const abort = () => controller.abort();
    inputSignal?.addEventListener("abort", abort, { once: true });
    const timer = setTimeout(() => controller.abort(), 5000);
    return new Promise<A>((resolve, reject) => {
      const aborted = () => reject(unavailable());
      controller.signal.addEventListener("abort", aborted, { once: true });
      // Caller cancellation has its own completion. The backend owns the slot
      // until its real promise settles, even when it ignores the abort signal.
      void run(controller.signal, () => controller.abort())
        .then(
          (value) => {
            if (closed || controller.signal.aborted) aborted();
            else resolve(value);
          },
          (cause) => {
            if (
              cause instanceof GuestProjectionError &&
              ["invalid", "unsupported", "conflict", "unavailable"].includes(cause.code)
            )
              reject(new GuestProjectionError(cause.code));
            else reject(unavailable());
          },
        )
        .finally(() => {
          clearTimeout(timer);
          inputSignal?.removeEventListener("abort", abort);
          controller.signal.removeEventListener("abort", aborted);
          operations.delete(controller);
        });
    });
  }

  function find(ticket: ProjectionTicket, pageId?: string) {
    const { sessionKey, epoch } = ticket;
    if (
      typeof sessionKey !== "string" ||
      !/^[a-f0-9]{64}$/.test(sessionKey) ||
      typeof epoch !== "string" ||
      !/^[a-f0-9]{32}$/.test(epoch)
    )
      throw unavailable();
    const session = sessions.get(hash(sessionKey));
    if (
      !session ||
      session.epoch !== epoch ||
      session.expires <= Date.now() ||
      (pageId !== undefined && session.pageId !== pageId)
    )
      throw unavailable();
    return session;
  }

  function live(session: Session, signal: AbortSignal) {
    if (
      closed ||
      signal.aborted ||
      sessions.get(session.keyHash) !== session ||
      session.expires <= Date.now()
    )
      throw unavailable();
  }

  function checkBinding(session: Session, current: ProjectionIdentity, signal: AbortSignal) {
    live(session, signal);
    if (
      binding(current, session.pageId) !== session.binding ||
      (backend.currentGrantEpoch && backend.currentGrantEpoch(current) !== current.grantEpoch)
    )
      throw unavailable();
  }

  const identity = backend.readIdentity ?? backend.readCurrent;
  function observe(proof: Proof, pageId: string, ticket: ProjectionTicket, source: AbortSignal) {
    return bounded(async (signal): Promise<ProjectionObservation> => {
      const session = find(ticket, pageId);
      const initial = await identity(proof, pageId, signal);
      checkBinding(session, initial, signal);
      if (initial.revision !== session.revision || session.receipt) throw conflict();
      return {
        revision: session.revision,
        expires: session.expires,
        listen(wake) {
          listeners.add(wake);
          return () => {
            listeners.delete(wake);
          };
        },
        async check(input) {
          if (
            closed ||
            input.aborted ||
            session.dropped === "ended" ||
            session.expires <= Date.now()
          )
            return "ended";
          if (backend.isChanging?.() || operations.size >= maxOperations) return "wait";
          try {
            return await bounded(async (probe) => {
              const current = await identity(proof, pageId, probe);
              if (
                closed ||
                probe.aborted ||
                session.dropped === "ended" ||
                session.expires <= Date.now() ||
                subject(current, pageId) !== session.subject ||
                (backend.currentGrantEpoch &&
                  backend.currentGrantEpoch(current) !== current.grantEpoch)
              )
                return "ended";
              return session.dropped === "epoch" ||
                session.receipt ||
                current.revision !== session.revision ||
                binding(current, pageId) !== session.binding
                ? "refresh"
                : "ready";
            }, input);
          } catch {
            return !closed && !input.aborted && backend.isChanging?.() ? "wait" : "ended";
          }
        },
      };
    }, source);
  }

  function checkPublished(session: Session, current: ProjectionPage, signal: AbortSignal) {
    checkBinding(session, current, signal);
    if (current.revision !== session.revision) throw conflict();
    const publicContent = JSON.stringify(visibleParagraphs(current.publishedRich));
    if (hash(publicContent) !== session.contentHash) throw conflict();
    return publicContent;
  }

  return {
    open: (proof, pageId, source) =>
      bounded(async (signal) => {
        if (
          typeof pageId !== "string" ||
          !pageId ||
          pageId.length > 256 ||
          sessions.size >= maxSessions
        )
          throw unavailable();
        const page = await backend.readCurrent(proof, pageId, signal);
        if (closed || signal.aborted || sessions.size >= maxSessions) throw unavailable();
        const authority = binding(page, pageId);
        if (backend.currentGrantEpoch && backend.currentGrantEpoch(page) !== page.grantEpoch)
          throw unavailable();
        const { seed, content } = safeSeed(page.publishedRich);
        if (seed.length + retained > maxSeedBytes) throw unavailable();
        const owner = checkedOwnerBase(page.ownerState, content);
        const sessionKey = randomBytes(32).toString("hex");
        const epoch = randomBytes(16).toString("hex");
        const keyHash = hash(sessionKey);
        sessions.set(keyHash, {
          keyHash,
          epoch,
          pageId,
          binding: authority,
          subject: subject(page, pageId),
          revision: page.revision,
          contentHash: hash(content),
          ownerHash: hash(owner),
          seed,
          expires: Date.now() + ttl,
          busy: false,
        });
        retained += seed.length;
        sweep();
        return {
          ticket: { sessionKey, epoch },
          revision: page.revision,
          seed: new Uint8Array(seed),
        };
      }, source),

    observe,
    release: (proof, pageId, ticket, source) =>
      bounded(async (signal) => {
        const session = find(ticket, pageId);
        checkBinding(session, await identity(proof, pageId, signal), signal);
        drop(session);
      }, source),

    read: (proof, ticket) =>
      bounded(async (signal) => {
        const session = find(ticket);
        try {
          const current = await backend.readCurrent(proof, session.pageId, signal);
          if (session.busy || session.receipt) checkBinding(session, current, signal);
          else checkPublished(session, current, signal);
        } catch (cause) {
          drop(session);
          throw cause;
        }
        if (!session.seed || session.busy) throw conflict();
        return { revision: session.revision, seed: new Uint8Array(session.seed) };
      }),

    submit: (proof, ticket, value, pageId, source) =>
      bounded(async (signal, abort) => {
        const session = find(ticket, pageId);
        const request = copyOrdinaryByteView(value, GUEST_FRAME_LIMIT, 1);
        if (!request) throw new GuestProjectionError("invalid");
        if (session.busy) {
          const current = await backend.readCurrent(proof, session.pageId, signal);
          checkBinding(session, current, signal);
          throw conflict();
        }
        session.busy = true;
        session.abortCommit = abort;
        let authorized = false;
        try {
          const requestHash = hash(request);
          const current = await backend.readCurrent(proof, session.pageId, signal);
          checkBinding(session, current, signal);
          authorized = true;
          if (session.receipt) {
            if (session.receipt.requestHash !== requestHash) throw conflict();
            return { ...session.receipt.result };
          }
          checkPublished(session, current, signal);
          let mapped = false;
          let changed = false;
          const result = await backend.commitAuthorized(
            proof,
            session.pageId,
            (locked) => {
              if (mapped) throw unavailable();
              mapped = true;
              const content = checkPublished(session, locked, signal);
              const owner = checkedOwnerBase(locked.ownerState, content);
              if (hash(owner) !== session.ownerHash || !session.seed) throw conflict();
              const delta = mappedOwnerDelta(session.seed, request, owner);
              changed = delta !== null;
              return delta;
            },
            signal,
          );
          if (
            !mapped ||
            result.applied !== changed ||
            result.revision !== session.revision + (changed ? 1 : 0)
          )
            throw unavailable();
          // A revoke after commit prevents receipt delivery. The accepted version stays
          // durable. The caller can obtain a newly authorized projection to recover.
          const after = await backend.readCurrent(proof, session.pageId, signal);
          checkBinding(session, after, signal);
          if (after.revision < result.revision) throw unavailable();
          const receipt = { revision: result.revision, applied: result.applied };
          forgetSeed(session);
          session.receipt = { requestHash, result: receipt };
          notify();
          return { ...receipt };
        } catch (cause) {
          // Dropping the epoch because this operation has already failed must
          // preserve its conflict/invalid response. External close/revoke still aborts it.
          delete session.abortCommit;
          if (
            authorized &&
            !(session.receipt && cause instanceof GuestProjectionError && cause.code === "conflict")
          )
            drop(session);
          throw cause;
        } finally {
          session.busy = false;
          delete session.abortCommit;
        }
      }, source),

    invalidate() {
      for (const session of sessions.values()) drop(session, "epoch");
      // Includes first opens that have not installed a session yet. A permission
      // change cancels their caller without releasing the still-running backend slot.
      for (const operation of operations) operation.abort();
      notify();
    },
    close() {
      closed = true;
      clearTimeout(expiryTimer);
      for (const session of sessions.values()) drop(session);
      for (const operation of operations) operation.abort();
    },
  };
}
