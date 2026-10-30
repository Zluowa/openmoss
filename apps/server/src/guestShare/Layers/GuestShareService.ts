import { randomBytes, randomUUID } from "node:crypto";

import {
  CommandId,
  GUEST_SHARE_PROTOCOL_VERSION,
  GUEST_SNAPSHOT_MESSAGE_LIMIT,
  GUEST_SNAPSHOT_USER_TURN_LIMIT,
  GuestMessageId,
  GuestShareId,
  MessageId,
  SHARE_RELAY_PROTOCOL_VERSION,
  isGuestShareExpired,
  type GuestAccessErrorReason,
  type GuestMessageAttachment,
  type GuestShareEndReason,
  type GuestShareOwnerEvent,
  type GuestShareRelayStatus,
  type GuestStreamEvent,
  type ModelSelection,
  type OrchestrationEvent,
  type OrchestrationThreadDetailSnapshot,
  type ThreadId,
} from "@synara/contracts";
import {
  isThreadDetailEventFor,
  THREAD_DETAIL_EVENT_TYPES,
} from "@synara/shared/threadDetailEvents";
import { formatGuestMessageAttribution } from "@synara/shared/guestShareAttribution";
import {
  Deferred,
  Duration,
  Effect,
  FileSystem,
  Layer,
  Option,
  Path,
  PubSub,
  Schedule,
  Semaphore,
  Stream,
} from "effect";

import { MossCloudAccountService } from "../../account/Services/MossCloudAccountService.ts";
import { MossPhoneAccountService } from "../../account/Services/MossPhoneAccountService.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { ServerConfig } from "../../config.ts";
import {
  attachmentPrincipalForGuestShare,
  type ManagedAttachmentPrincipal,
} from "../../managedAttachmentPrincipal.ts";
import {
  ManagedAttachmentStoreError,
  persistReservedManagedAttachment,
  reserveManagedAttachmentUpload,
} from "../../managedAttachmentStore.ts";
import { OrchestrationEngineService } from "../../orchestration/Services/OrchestrationEngine.ts";
import { ProjectionSnapshotQuery } from "../../orchestration/Services/ProjectionSnapshotQuery.ts";
import {
  GuestShareRepository,
  type GuestShareRecord,
} from "../../persistence/Services/GuestShareRepository.ts";
import { ManagedAttachmentRepository } from "../../persistence/Services/ManagedAttachments.ts";
import { ServerRuntimeStartup } from "../../serverRuntimeStartup.ts";
import {
  guestAccessError,
  guestShareOwnerError,
  type GuestShareAccessError,
  type GuestShareOwnerError,
} from "../Errors.ts";
import {
  classifyGuestUploads,
  GUEST_UPLOAD_HEADER_BYTES,
  guestMessageAttachments,
  type GuestUpload,
} from "../guestAttachments.ts";
import { handleGuestRequest } from "../guestRequestHandler.ts";
import {
  guestInviteCredential,
  GUEST_SHARE_SIGNING_KEY_BYTES,
  GUEST_SHARE_SIGNING_SECRET_NAME,
  parseGuestInviteCredential,
  relayHostKey,
  relayHostKeyHash,
  signGuestSession,
  verifyGuestSession,
} from "../guestShareCredentials.ts";
import {
  guestInviteUrl,
  guestShareView,
  guestThreadModel,
  openGuestShare,
  pendingGuestAttachments,
  redeemGuestShare,
  releasedGuestAttachments,
  resolveGuestMessage,
  revertSentGuestMessage,
  submitGuestMessage,
  toThreadGuestShare,
  withSentGuestMessage,
} from "../guestShareDecider.ts";
import {
  modelSelectionOfEvent,
  sanitizeGuestThreadEvent,
  sanitizeGuestThreadSnapshot,
} from "../guestThreadSanitizer.ts";
import { GuestShareService, type GuestShareServiceShape } from "../Services/GuestShareService.ts";
import { ShareRelayTransport } from "../Services/ShareRelayTransport.ts";
import { deleteShareFromRelay, registerShareWithRelay } from "../shareRelayRegistration.ts";
import { ShareRelayHostClient } from "../shareRelayHostClient.ts";
import { resolveShareRelayAccount } from "../shareRelayOrigin.ts";
import { makeCursorSafeSnapshotLiveStream } from "../../wsSnapshotLiveStream.ts";

const SHARE_ID_BYTES = 16;
// How soon an open stream notices that its session stopped working for a reason that sends no
// `ended` (for example the share row vanished). Closing, replacing, and expiry end it at once.
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);
const EXPIRY_SWEEP_INTERVAL = Duration.minutes(1);
// A guest's staged file waits for the owner's decision, which can take the whole share.
const ATTACHMENT_STAGING_GRACE_MS = 5 * 60 * 1000;

const MANAGED_ATTACHMENT_ID_PATTERN = /^att_v2_[0-9a-f]{32}$/u;

type GuestShareChange =
  | {
      readonly type: "upsert";
      readonly record: GuestShareRecord;
      readonly relayStatus: GuestShareRelayStatus;
    }
  | {
      readonly type: "remove";
      readonly shareId: GuestShareId;
      readonly threadId: ThreadId;
      readonly reason: GuestShareEndReason;
    };

/** What the server keeps in memory for a share that lives: its relay socket and end signal. */
interface LiveShare {
  readonly threadId: ThreadId;
  client: ShareRelayHostClient | null;
  relayStatus: GuestShareRelayStatus;
  readonly ended: Deferred.Deferred<GuestShareEndReason>;
}

type ThreadEndEvent = Extract<OrchestrationEvent, { type: "thread.archived" | "thread.deleted" }>;

const ended = (reason: GuestShareEndReason): GuestStreamEvent => ({ type: "ended", reason });

/** How long an ending share waits for its guest streams to carry `ended` out. */
const ENDED_DRAIN_TIMEOUT_MS = 2_000;

const isThreadEndEvent = (event: OrchestrationEvent): event is ThreadEndEvent =>
  event.type === "thread.archived" || event.type === "thread.deleted";

const endReasonForEvent = (event: ThreadEndEvent): GuestShareEndReason =>
  event.type === "thread.archived" ? "archived" : "deleted";

const make = Effect.gen(function* () {
  const repository = yield* GuestShareRepository;
  const orchestrationEngine = yield* OrchestrationEngineService;
  const snapshotQuery = yield* ProjectionSnapshotQuery;
  const managedAttachments = yield* ManagedAttachmentRepository;
  const serverConfig = yield* ServerConfig;
  const secretStore = yield* ServerSecretStore;
  const runtimeStartup = yield* ServerRuntimeStartup;
  const phoneAccount = yield* MossPhoneAccountService;
  const cloudAccount = yield* MossCloudAccountService;
  const transport = yield* ShareRelayTransport;
  const fileSystem = yield* FileSystem.FileSystem;
  const layerScope = yield* Effect.scope;
  const services = yield* Effect.services<FileSystem.FileSystem | Path.Path>();
  const signingKey = yield* secretStore
    .getOrCreateRandom(GUEST_SHARE_SIGNING_SECRET_NAME, GUEST_SHARE_SIGNING_KEY_BYTES)
    .pipe(Effect.orDie);
  // Decisions on one thread run one at a time: that is what makes a link redeem once and a
  // message send once.
  const threadLocks = yield* Semaphore.makePartitioned<string>({ permits: 1 });
  const changes = yield* PubSub.unbounded<GuestShareChange>();
  const liveShares = new Map<GuestShareId, LiveShare>();
  const accountSources = { phoneAccount, cloudAccount, env: transport.env };

  const withThreadLock = <A, E, R>(threadId: ThreadId, effect: Effect.Effect<A, E, R>) =>
    threadLocks.withPermits(threadId, 1)(effect);
  const inviteUrlOf = (record: GuestShareRecord) =>
    guestInviteUrl(record.relayOrigin, record.id, guestInviteCredential(signingKey, record.id));
  const relayStatusOf = (shareId: GuestShareId): GuestShareRelayStatus =>
    liveShares.get(shareId)?.relayStatus ?? "offline";
  const ownerShareOf = (record: GuestShareRecord) =>
    toThreadGuestShare(record, {
      inviteUrl: inviteUrlOf(record),
      relayStatus: relayStatusOf(record.id),
    });
  const publishUpsert = (record: GuestShareRecord) =>
    PubSub.publish(changes, {
      type: "upsert",
      record,
      relayStatus: relayStatusOf(record.id),
    }).pipe(Effect.asVoid);

  const persisted = <A, E, R>(effect: Effect.Effect<A, E, R>) => effect.pipe(Effect.orDie);
  const rejected = (cause: unknown) => guestAccessError("rejected", cause);

  const ensureLive = (record: GuestShareRecord) =>
    Effect.gen(function* () {
      const existing = liveShares.get(record.id);
      if (existing !== undefined) return existing;
      const entry: LiveShare = {
        threadId: record.threadId,
        client: null,
        relayStatus: "offline",
        ended: yield* Deferred.make<GuestShareEndReason>(),
      };
      liveShares.set(record.id, entry);
      return entry;
    });

  // ── Guest files ───────────────────────────────────────────────────

  /** Removes a share's staged files: the durable cleanup job, plus the file itself right away. */
  const releaseAttachments = (
    shareId: GuestShareId,
    threadId: ThreadId,
    attachments: ReadonlyArray<GuestMessageAttachment>,
  ) =>
    Effect.forEach(
      attachments,
      (attachment) =>
        Effect.gen(function* () {
          const principal = attachmentPrincipalForGuestShare(shareId);
          const now = new Date().toISOString();
          const blob = yield* managedAttachments.findServerOwned({
            attachmentId: attachment.id,
            ownerThreadId: threadId,
            ownerKind: principal.ownerKind,
            ownerId: principal.ownerId,
            now,
          });
          yield* managedAttachments.cancelStaged({
            attachmentId: attachment.id,
            ownerKind: principal.ownerKind,
            ownerId: principal.ownerId,
            reason: "guest-share-released",
            requestedAt: now,
          });
          if (Option.isSome(blob) && blob.value.state !== "claimed") {
            const path = resolveAttachmentRelativePath({
              attachmentsDir: serverConfig.attachmentsDir,
              relativePath: blob.value.relativePath,
            });
            if (path !== null) yield* fileSystem.remove(path, { force: true });
          }
        }).pipe(
          Effect.catch((cause) =>
            Effect.logWarning("Could not release a guest attachment.", {
              shareId,
              attachmentId: attachment.id,
              cause: String(cause),
            }),
          ),
        ),
      { discard: true },
    );

  /**
   * Checks the files and stages them as managed attachments owned by the share, so a message
   * can wait for the owner's decision for as long as the share lives. Send claims them for the
   * turn; dismissing the message or ending the share deletes them.
   */
  const storeUploads = (record: GuestShareRecord, uploads: ReadonlyArray<GuestUpload>) =>
    Effect.gen(function* () {
      const inspected = yield* Effect.forEach(uploads, (upload) =>
        Effect.gen(function* () {
          const info = yield* fileSystem.stat(upload.path);
          const file = yield* fileSystem.open(upload.path, { flag: "r" });
          const header = (yield* file.readAlloc(GUEST_UPLOAD_HEADER_BYTES)) ?? new Uint8Array();
          return { ...upload, sizeBytes: Number(info.size), header };
        }).pipe(Effect.scoped, Effect.mapError(rejected)),
      );
      const classified = classifyGuestUploads(inspected);
      if (!classified.ok) return yield* guestAccessError(classified.reason);
      const principal = attachmentPrincipalForGuestShare(record.id);
      const stagingTtlMs = Math.max(
        ATTACHMENT_STAGING_GRACE_MS,
        Date.parse(record.expiresAt) - Date.now() + ATTACHMENT_STAGING_GRACE_MS,
      );
      const stored: Array<GuestMessageAttachment> = [];
      yield* Effect.forEach(
        classified.attachments,
        (draft, index) =>
          Effect.gen(function* () {
            const now = new Date().toISOString();
            const bytes = yield* fileSystem.readFile(uploads[index]!.path);
            const reservation = yield* reserveManagedAttachmentUpload({
              type: draft.type,
              threadId: record.threadId,
              name: draft.name,
              mimeType: draft.mimeType,
              reservedBytes: draft.sizeBytes,
              now,
              principal,
              repository: managedAttachments,
            });
            const attachment = yield* persistReservedManagedAttachment({
              reservation,
              bytes,
              attachmentsDir: serverConfig.attachmentsDir,
              now,
              principal,
              repository: managedAttachments,
              stagingTtlMs,
            });
            stored.push(attachment);
          }),
        { discard: true },
      ).pipe(
        Effect.mapError((cause) =>
          cause instanceof ManagedAttachmentStoreError && cause.code === "attachment_quota_exceeded"
            ? guestAccessError("files_busy", cause)
            : rejected(cause),
        ),
        Effect.tapError(() => releaseAttachments(record.id, record.threadId, stored)),
      );
      return stored;
    });

  /** Where a guest-visible attachment is stored, or null when it is not on disk. */
  const attachmentPath = (
    attachment: GuestMessageAttachment,
    ownedBy: ManagedAttachmentPrincipal | null,
    threadId: ThreadId,
  ) =>
    Effect.gen(function* () {
      if (!MANAGED_ATTACHMENT_ID_PATTERN.test(attachment.id)) {
        return resolveAttachmentPath({ attachmentsDir: serverConfig.attachmentsDir, attachment });
      }
      const claimed = yield* managedAttachments.findClaimedById({ attachmentId: attachment.id });
      const blob = Option.isSome(claimed)
        ? claimed
        : ownedBy === null
          ? Option.none()
          : yield* managedAttachments.findServerOwned({
              attachmentId: attachment.id,
              ownerThreadId: threadId,
              ownerKind: ownedBy.ownerKind,
              ownerId: ownedBy.ownerId,
              now: new Date().toISOString(),
            });
      if (Option.isNone(blob) || blob.value.ownerThreadId !== threadId) return null;
      return resolveAttachmentRelativePath({
        attachmentsDir: serverConfig.attachmentsDir,
        relativePath: blob.value.relativePath,
      });
    });

  // ── Relay host connection ─────────────────────────────────────────

  const guestRequestHandler = (record: GuestShareRecord) => {
    const run = Effect.runPromiseWith(services);
    return (request: Parameters<GuestShareServiceShape["handleGuestRequest"]>[0]) =>
      run(
        handleGuestRequest(operations, request).pipe(
          Effect.annotateLogs({ shareId: record.id, threadId: record.threadId }),
        ),
      );
  };

  const onRelayStatus = (shareId: GuestShareId, status: GuestShareRelayStatus) =>
    Effect.gen(function* () {
      const entry = liveShares.get(shareId);
      if (entry === undefined) return;
      entry.relayStatus = status;
      const record = yield* repository.getById(shareId);
      if (Option.isSome(record)) yield* publishUpsert(record.value);
    }).pipe(Effect.ignore);

  /** The relay forgot the share (after a restart): register it again with a fresh bearer. */
  const reregister = (shareId: GuestShareId, hostKey: string) =>
    Effect.gen(function* () {
      const record = yield* repository.getById(shareId);
      if (Option.isNone(record) || isGuestShareExpired(record.value, Date.now())) return false;
      const account = yield* resolveShareRelayAccount(accountSources);
      if (account.origin !== record.value.relayOrigin) {
        yield* Effect.logWarning("The guest share relay changed; the link cannot be renewed.", {
          shareId,
        });
        return false;
      }
      yield* registerShareWithRelay({
        fetch: transport.fetch,
        origin: account.origin,
        bearer: account.bearer,
        request: {
          shareId,
          hostKeyHash: relayHostKeyHash(hostKey),
          expiresAt: record.value.expiresAt,
          protocolVersion: SHARE_RELAY_PROTOCOL_VERSION,
        },
      });
      return true;
    }).pipe(
      Effect.catch((cause) =>
        Effect.logWarning("Could not register a guest share with the relay again.", {
          shareId,
          cause: String(cause),
        }).pipe(Effect.as(false)),
      ),
    );

  const startHost = (record: GuestShareRecord) =>
    Effect.gen(function* () {
      const entry = yield* ensureLive(record);
      if (entry.client !== null) return;
      const hostKey = relayHostKey(signingKey, record.id);
      const client = new ShareRelayHostClient({
        origin: record.relayOrigin,
        shareId: record.id,
        hostKey,
        handle: guestRequestHandler(record),
        onStatus: (status) => {
          Effect.runFork(onRelayStatus(record.id, status));
        },
        onEnded: () => {
          Effect.runFork(endShareById(record.id, "closed"));
        },
        reregister: () => Effect.runPromise(reregister(record.id, hostKey)),
        webSocket: transport.webSocket,
        ...(transport.backoff === undefined ? {} : { backoff: transport.backoff }),
      });
      entry.client = client;
      entry.relayStatus = "connecting";
      client.start();
    });

  // ── Ending a share ────────────────────────────────────────────────

  /** Caller holds the thread lock. Guest streams end with `ended`, the relay forgets the share. */
  const endShare = (record: GuestShareRecord, reason: GuestShareEndReason) =>
    Effect.gen(function* () {
      const entry = liveShares.get(record.id);
      liveShares.delete(record.id);
      // Guests are told first; the socket and the relay registration go once those frames are
      // out, so a guest sees "ended" instead of a dropped connection.
      if (entry !== undefined) yield* Deferred.succeed(entry.ended, reason);
      yield* releaseAttachments(record.id, record.threadId, pendingGuestAttachments(record));
      // The relay answer is not worth waiting for; the registration also expires on its own.
      yield* Effect.promise(
        () => entry?.client?.closeWhenDrained(ENDED_DRAIN_TIMEOUT_MS) ?? Promise.resolve(),
      ).pipe(
        Effect.andThen(
          deleteShareFromRelay({
            fetch: transport.fetch,
            origin: record.relayOrigin,
            shareId: record.id,
            hostKey: relayHostKey(signingKey, record.id),
          }),
        ),
        Effect.forkIn(layerScope),
      );
      yield* persisted(repository.deleteById(record.id));
      yield* PubSub.publish(changes, {
        type: "remove",
        shareId: record.id,
        threadId: record.threadId,
        reason,
      });
      yield* Effect.logInfo("Guest share ended.", { shareId: record.id, reason });
    });

  const endShareById = (shareId: GuestShareId, reason: GuestShareEndReason) =>
    Effect.gen(function* () {
      const found = yield* repository.getById(shareId);
      if (Option.isNone(found)) return;
      yield* withThreadLock(
        found.value.threadId,
        Effect.gen(function* () {
          const current = yield* repository.getById(shareId);
          if (Option.isSome(current)) yield* endShare(current.value, reason);
        }),
      );
    }).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not end a guest share.", { shareId, cause: String(cause) }),
      ),
    );

  const endShareForThread = (threadId: ThreadId, reason: GuestShareEndReason) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const current = yield* repository.getByThreadId(threadId);
        if (Option.isSome(current)) yield* endShare(current.value, reason);
      }),
    ).pipe(
      Effect.catchCause((cause) =>
        Effect.logWarning("Could not end a guest share.", { threadId, cause: String(cause) }),
      ),
    );

  const sweepExpired = Effect.gen(function* () {
    const now = Date.now();
    const records = yield* repository.list();
    for (const record of records) {
      if (isGuestShareExpired(record, now)) yield* endShareById(record.id, "expired");
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Guest share expiry sweep failed.", { cause: String(cause) }),
    ),
  );

  const resumeHosts = Effect.gen(function* () {
    const records = yield* repository.list();
    for (const record of records) {
      if (!isGuestShareExpired(record, Date.now())) yield* startHost(record);
    }
  }).pipe(
    Effect.catchCause((cause) =>
      Effect.logWarning("Could not resume guest share connections.", { cause: String(cause) }),
    ),
  );

  // ── Owner operations ──────────────────────────────────────────────

  const threadShell = (threadId: ThreadId) =>
    snapshotQuery.getThreadShellById(threadId).pipe(
      Effect.mapError((cause) => guestShareOwnerError("guest_share.thread_unavailable", cause)),
      Effect.flatMap((shell) =>
        Option.isNone(shell) || shell.value.archivedAt !== null
          ? Effect.fail(guestShareOwnerError("guest_share.thread_unavailable"))
          : Effect.succeed(shell.value),
      ),
    );

  const create: GuestShareServiceShape["create"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        yield* threadShell(threadId);
        const account = yield* resolveShareRelayAccount(accountSources);
        const shareId = GuestShareId.makeUnsafe(randomBytes(SHARE_ID_BYTES).toString("base64url"));
        const record = openGuestShare({
          shareId,
          threadId,
          relayOrigin: account.origin,
          nowMs: Date.now(),
        });
        const hostKey = relayHostKey(signingKey, shareId);
        yield* registerShareWithRelay({
          fetch: transport.fetch,
          origin: account.origin,
          bearer: account.bearer,
          request: {
            shareId,
            hostKeyHash: relayHostKeyHash(hostKey),
            expiresAt: record.expiresAt,
            protocolVersion: SHARE_RELAY_PROTOCOL_VERSION,
          },
        });
        yield* Effect.gen(function* () {
          const previous = yield* persisted(repository.getByThreadId(threadId));
          if (Option.isSome(previous)) yield* endShare(previous.value, "replaced");
          yield* persisted(repository.insert(record));
          yield* startHost(record);
          yield* publishUpsert(record);
        }).pipe(
          // The relay must not keep a share this server never stored.
          Effect.tapError(() =>
            deleteShareFromRelay({
              fetch: transport.fetch,
              origin: account.origin,
              shareId,
              hostKey,
            }).pipe(Effect.forkIn(layerScope)),
          ),
        );
        const inviteUrl = inviteUrlOf(record);
        return { share: ownerShareOf(record), inviteUrl };
      }),
    );

  const close: GuestShareServiceShape["close"] = (threadId) =>
    withThreadLock(
      threadId,
      Effect.gen(function* () {
        const current = yield* persisted(repository.getByThreadId(threadId));
        if (Option.isNone(current)) return yield* guestShareOwnerError("guest_share.not_found");
        yield* endShare(current.value, "closed");
      }),
    );

  const dismiss = (record: GuestShareRecord, guestMessageId: GuestMessageId) =>
    Effect.gen(function* () {
      const next = resolveGuestMessage(record, guestMessageId, "dismissed");
      if (next === null) return yield* guestShareOwnerError("guest_share.message_not_pending");
      yield* releaseAttachments(record.id, record.threadId, releasedGuestAttachments(record, next));
      yield* persisted(repository.update(next));
      yield* publishUpsert(next);
    });

  /**
   * Marks the message sent, then dispatches the turn. The mark comes first so a crash between
   * the two cannot send a message twice; a failed dispatch puts the message back.
   */
  const send = (record: GuestShareRecord, guestMessageId: GuestMessageId) =>
    Effect.gen(function* () {
      const sent = resolveGuestMessage(record, guestMessageId, "sent");
      const message = record.messages.find((candidate) => candidate.id === guestMessageId);
      if (sent === null || message === undefined) {
        return yield* guestShareOwnerError("guest_share.message_not_pending");
      }
      const suffix = randomUUID();
      const messageId = MessageId.makeUnsafe(`guest:${suffix}:message`);
      const marked = withSentGuestMessage(sent, { guestMessageId, messageId });
      yield* persisted(repository.update(marked));
      yield* publishUpsert(marked);
      const revert = (cause: unknown) =>
        Effect.gen(function* () {
          const reverted = revertSentGuestMessage(marked, guestMessageId);
          yield* persisted(repository.update(reverted));
          yield* publishUpsert(reverted);
          return yield* guestShareOwnerError("guest_share.send_failed", cause);
        });
      const shell = yield* threadShell(record.threadId).pipe(Effect.catch(revert));
      yield* runtimeStartup
        .enqueueCommand(
          orchestrationEngine.dispatch(
            {
              type: "thread.turn.start",
              commandId: CommandId.makeUnsafe(`guest:${suffix}:send`),
              threadId: record.threadId,
              message: {
                messageId,
                role: "user",
                text: formatGuestMessageAttribution(record.guestName, message.text),
                attachments: message.attachments,
              },
              modelSelection: shell.modelSelection,
              dispatchMode: "queue",
              runtimeMode: shell.runtimeMode,
              interactionMode: shell.interactionMode,
              createdAt: new Date().toISOString(),
            },
            { attachmentPrincipal: attachmentPrincipalForGuestShare(record.id) },
          ),
        )
        .pipe(Effect.catch(revert));
    });

  const resolveMessage: GuestShareServiceShape["resolveMessage"] = (input) =>
    withThreadLock(
      input.threadId,
      Effect.gen(function* () {
        const current = yield* persisted(repository.getByThreadId(input.threadId));
        if (Option.isNone(current)) return yield* guestShareOwnerError("guest_share.not_found");
        yield* input.decision === "send"
          ? send(current.value, input.guestMessageId)
          : dismiss(current.value, input.guestMessageId);
      }),
    );

  const subscribe: GuestShareServiceShape["subscribe"] = () =>
    Stream.unwrap(
      Effect.gen(function* () {
        // Subscribe before reading, so no change can land between the snapshot and the feed.
        const subscription = yield* PubSub.subscribe(changes);
        const records = yield* persisted(repository.list());
        const snapshot: GuestShareOwnerEvent = {
          type: "snapshot",
          shares: records.map(ownerShareOf),
        };
        return Stream.make(snapshot).pipe(
          Stream.concat(
            Stream.fromSubscription(subscription).pipe(
              Stream.map(
                (change): GuestShareOwnerEvent =>
                  change.type === "upsert"
                    ? {
                        type: "upsert",
                        share: toThreadGuestShare(change.record, {
                          inviteUrl: inviteUrlOf(change.record),
                          relayStatus: change.relayStatus,
                        }),
                      }
                    : { type: "remove", threadId: change.threadId, shareId: change.shareId },
              ),
            ),
          ),
        );
      }),
    );

  // ── Guest operations ──────────────────────────────────────────────

  const inactive = guestAccessError("inactive");

  /** The share a session token opens: same thread, the guest joined, not expired. */
  const authorizeSession = (token: string) =>
    Effect.gen(function* () {
      const claims = verifyGuestSession(signingKey, token);
      if (claims === null) return yield* guestAccessError("invalid");
      const record = yield* repository.getById(claims.shareId).pipe(Effect.mapError(rejected));
      if (
        Option.isNone(record) ||
        record.value.threadId !== claims.threadId ||
        record.value.guestName === null ||
        isGuestShareExpired(record.value, Date.now())
      ) {
        return yield* inactive;
      }
      return record.value;
    });

  const redeem: GuestShareServiceShape["redeem"] = (request) =>
    Effect.gen(function* () {
      const shareId = parseGuestInviteCredential(signingKey, request.credential);
      if (shareId === null) return yield* guestAccessError("invalid");
      const found = yield* repository.getById(shareId).pipe(Effect.mapError(rejected));
      if (Option.isNone(found)) return yield* inactive;
      yield* withThreadLock(
        found.value.threadId,
        Effect.gen(function* () {
          const current = yield* repository.getById(shareId).pipe(Effect.mapError(rejected));
          if (Option.isNone(current)) return yield* inactive;
          const decision = redeemGuestShare(current.value, {
            guestName: request.name,
            nowMs: Date.now(),
          });
          if (!decision.ok) return yield* guestAccessError(decision.reason);
          yield* repository.update(decision.value).pipe(Effect.mapError(rejected));
          yield* publishUpsert(decision.value);
        }),
      );
      return {
        token: signGuestSession(signingKey, {
          kind: "session",
          threadId: found.value.threadId,
          shareId,
        }),
        shareId,
      };
    });

  const check: GuestShareServiceShape["check"] = (session) =>
    authorizeSession(session).pipe(Effect.asVoid);

  const submit: GuestShareServiceShape["submit"] = (session, fields, uploads) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      if (fields.text.length === 0 && uploads.length === 0) {
        return yield* guestAccessError("empty");
      }
      const attachments = yield* storeUploads(record, uploads);
      yield* withThreadLock(
        record.threadId,
        Effect.gen(function* () {
          const current = yield* repository.getById(record.id).pipe(Effect.mapError(rejected));
          if (Option.isNone(current)) return yield* inactive;
          const decision = submitGuestMessage(current.value, {
            guestMessageId: GuestMessageId.makeUnsafe(randomUUID()),
            text: fields.text,
            attachments,
            nowMs: Date.now(),
          });
          if (!decision.ok) return yield* guestAccessError(decision.reason);
          yield* repository.update(decision.value).pipe(Effect.mapError(rejected));
          yield* publishUpsert(decision.value);
        }),
      ).pipe(Effect.tapError(() => releaseAttachments(record.id, record.threadId, attachments)));
    });

  /** Completes once the session no longer opens its share, so an open stream ends with it. */
  const untilRevoked = (session: string) =>
    authorizeSession(session).pipe(
      Effect.repeat(Schedule.spaced(ACCESS_RECHECK_INTERVAL)),
      Effect.ignore,
    );

  const stream: GuestShareServiceShape["stream"] = (session) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      const { id: shareId, threadId } = record;
      const live = yield* ensureLive(record);
      // The thread must still be open, and its model labels the opening view.
      const shell = yield* snapshotQuery
        .getThreadShellById(threadId)
        .pipe(Effect.mapError(() => inactive));
      if (Option.isNone(shell) || shell.value.archivedAt !== null) return yield* inactive;
      let share = record;
      let modelSelection: ModelSelection = shell.value.modelSelection;
      const viewOf = () => guestShareView(share, guestThreadModel(modelSelection));
      const initialView = viewOf();
      if (initialView === null) return yield* inactive;
      // A view goes out only when what the guest sees changed; a relay status change does not.
      let lastViewJson = JSON.stringify(initialView);
      const viewChanges = (): ReadonlyArray<GuestStreamEvent> => {
        const view = viewOf();
        const viewJson = JSON.stringify(view);
        if (view === null || viewJson === lastViewJson) return [];
        lastViewJson = viewJson;
        return [{ type: "view", view }];
      };
      const snapshot = snapshotQuery
        .getThreadDetailSnapshotById(threadId, { limit: GUEST_SNAPSHOT_MESSAGE_LIMIT })
        .pipe(
          Effect.mapError(() => inactive),
          Effect.flatMap((detail) =>
            Option.isNone(detail) ||
            detail.value.thread.archivedAt !== null ||
            detail.value.thread.deletedAt !== null
              ? Effect.fail(inactive)
              : Effect.succeed(
                  sanitizeGuestThreadSnapshot(detail.value, {
                    userTurnLimit: GUEST_SNAPSHOT_USER_TURN_LIMIT,
                    messageLimit: GUEST_SNAPSHOT_MESSAGE_LIMIT,
                  }),
                ),
          ),
        );
      // The thread as the owner's subscription streams it: live events attach first, the
      // snapshot and the gap to the journal head follow, then strictly newer events.
      const threadItems = makeCursorSafeSnapshotLiveStream<
        OrchestrationThreadDetailSnapshot,
        GuestShareAccessError
      >({
        subscribeLive: orchestrationEngine.subscribeDomainEvents.pipe(
          Effect.map((events) =>
            events.pipe(Stream.filter((event) => isThreadDetailEventFor(event, threadId))),
          ),
        ),
        liveBufferOptions: { label: `guest-share.thread:${shareId}` },
        snapshot,
        snapshotSequence: (detail) => detail.snapshotSequence,
        getHighWaterSequence: orchestrationEngine.getEventHighWaterSequence.pipe(
          Effect.mapError(() => inactive),
        ),
        replay: (fromSequenceExclusive, throughSequenceInclusive) =>
          orchestrationEngine
            .readThreadEventsThrough(
              threadId,
              fromSequenceExclusive,
              throughSequenceInclusive,
              THREAD_DETAIL_EVENT_TYPES,
            )
            .pipe(Stream.mapError(() => inactive)),
      });
      const liveThread = threadItems.pipe(
        Stream.map((item): ReadonlyArray<GuestStreamEvent> => {
          if (item.kind === "snapshot") {
            modelSelection = item.snapshot.thread.modelSelection;
            return [
              { type: "thread", item: { kind: "snapshot", snapshot: item.snapshot } },
              ...viewChanges(),
            ];
          }
          const events = item.kind === "event" ? [item.event] : item.events;
          const out: Array<GuestStreamEvent> = [];
          for (const event of events) {
            if (isThreadEndEvent(event)) {
              out.push(ended(endReasonForEvent(event)));
              break;
            }
            const sanitized = sanitizeGuestThreadEvent(event);
            if (sanitized === null) continue;
            out.push({ type: "thread", item: { kind: "event", event: sanitized } });
            const model = modelSelectionOfEvent(sanitized);
            if (model !== null) {
              modelSelection = model;
              out.push(...viewChanges());
            }
          }
          return out;
        }),
        Stream.flattenIterable,
        // A failed or overflowed read closes the response without `ended`: the page reconnects,
        // and the session check decides whether the link still works.
        Stream.catchCause(() => Stream.empty),
      );
      const liveShare = Stream.unwrap(
        Effect.gen(function* () {
          const shareChanges = yield* PubSub.subscribe(changes);
          // A change between authorize and this subscription is caught up here.
          const current = yield* repository
            .getById(shareId)
            .pipe(Effect.orElseSucceed(() => Option.none<GuestShareRecord>()));
          if (Option.isSome(current)) share = current.value;
          return Stream.fromIterable(viewChanges()).pipe(
            Stream.concat(
              Stream.fromSubscription(shareChanges).pipe(
                Stream.filter(
                  (change) =>
                    (change.type === "upsert" ? change.record.id : change.shareId) === shareId,
                ),
                Stream.map((change): ReadonlyArray<GuestStreamEvent> => {
                  if (change.type === "remove") return [ended(change.reason)];
                  share = change.record;
                  return viewChanges();
                }),
                Stream.flattenIterable,
              ),
            ),
          );
        }),
      );
      const endedByOwner = Stream.fromEffect(Deferred.await(live.ended)).pipe(Stream.map(ended));
      const endedByExpiry = Stream.fromEffect(
        Effect.sleep(Duration.millis(Math.max(0, Date.parse(share.expiresAt) - Date.now()))),
      ).pipe(Stream.map(() => ended("expired")));
      const opening: ReadonlyArray<GuestStreamEvent> = [
        { type: "hello", protocolVersion: GUEST_SHARE_PROTOCOL_VERSION },
        { type: "view", view: initialView },
      ];
      return Stream.fromIterable(opening).pipe(
        Stream.concat(
          liveThread.pipe(
            Stream.merge(liveShare),
            Stream.merge(endedByOwner),
            Stream.merge(endedByExpiry),
          ),
        ),
        Stream.takeUntil((event) => event.type === "ended"),
        // A session that stops working for a reason that sends no `ended` closes quietly; the
        // page reconnects and the session check decides whether the link still works.
        Stream.interruptWhen(untilRevoked(session)),
      );
    });

  const attachment: GuestShareServiceShape["attachment"] = (session, attachmentId) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      const unavailable = guestAccessError("unavailable");
      // A dismissed message's files are deleted with it.
      const fromShare = record.messages
        .flatMap((message) => (message.status === "dismissed" ? [] : message.attachments))
        .find((candidate) => candidate.id === attachmentId);
      let found: GuestMessageAttachment | undefined = fromShare;
      if (found === undefined) {
        const thread = yield* snapshotQuery
          .getThreadDetailWithoutActivitiesById(record.threadId)
          .pipe(Effect.mapError(() => unavailable));
        found = Option.isNone(thread)
          ? undefined
          : thread.value.messages
              .flatMap((message) => guestMessageAttachments(message.attachments))
              .find((candidate) => candidate.id === attachmentId);
      }
      if (found === undefined) return yield* unavailable;
      const path = yield* attachmentPath(
        found,
        fromShare === undefined ? null : attachmentPrincipalForGuestShare(record.id),
        record.threadId,
      ).pipe(Effect.mapError(() => unavailable));
      if (path === null) return yield* unavailable;
      const exists = yield* fileSystem.exists(path).pipe(Effect.orElseSucceed(() => false));
      return exists ? { path, attachment: found } : yield* unavailable;
    });

  const operations = { redeem, check, submit, stream, attachment };

  const handleGuestRequestOperation: GuestShareServiceShape["handleGuestRequest"] = (request) =>
    handleGuestRequest(operations, request).pipe(Effect.provideServices(services));

  // ── Background work ───────────────────────────────────────────────

  // Archiving or deleting the thread ends its share.
  yield* orchestrationEngine.streamDomainEvents.pipe(
    Stream.filter(isThreadEndEvent),
    Stream.runForEach((event) =>
      endShareForThread(event.payload.threadId, endReasonForEvent(event)),
    ),
    Effect.forkScoped,
  );

  // Once the projections are readable, drop expired shares and reconnect the live ones; then
  // keep sweeping so a share ends on time even when no guest is connected.
  yield* Effect.gen(function* () {
    yield* runtimeStartup.awaitReadReady.pipe(Effect.ignore);
    yield* sweepExpired;
    yield* resumeHosts;
    yield* sweepExpired.pipe(Effect.delay(EXPIRY_SWEEP_INTERVAL), Effect.forever);
  }).pipe(Effect.forkScoped);

  yield* Effect.addFinalizer(() =>
    Effect.sync(() => {
      for (const entry of liveShares.values()) entry.client?.close();
      liveShares.clear();
    }),
  );

  return {
    create,
    close,
    resolveMessage,
    subscribe,
    redeem,
    check,
    submit,
    stream,
    attachment,
    handleGuestRequest: handleGuestRequestOperation,
  } satisfies GuestShareServiceShape;
});

export const GuestShareServiceLive = Layer.effect(GuestShareService, make);

export type { GuestAccessErrorReason, GuestShareAccessError, GuestShareOwnerError };
