import { randomBytes, randomUUID } from "node:crypto";
import { basename as pathBasename } from "node:path";

import {
  CommandId,
  GUEST_FILE_MAX_BYTES,
  GUEST_OPTIONAL_ROUTES,
  GUEST_RENDER_MAX_BYTES,
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
  type OrchestrationThread,
  type OrchestrationThreadDetailSnapshot,
  type ThreadId,
} from "@moss/contracts";
import { isThreadDetailEventFor, THREAD_DETAIL_EVENT_TYPES } from "@moss/shared/threadDetailEvents";
import { formatGuestMessageAttribution } from "@moss/shared/guestShareAttribution";
import { resolveThreadWorkspaceCwd } from "@moss/shared/threadEnvironment";
import { INLINE_VISUALS_BETA_FEATURE } from "@moss/shared/betaFeatures";
import { htmlRenderFileName } from "@moss/shared/htmlRender";
import { buildInlineVisualDocument } from "@moss/shared/inlineVisual";
import { resolveGuestHtmlRenderMapConfig } from "@moss/shared/htmlRenderMaps";
import * as SqlClient from "effect/unstable/sql/SqlClient";
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
import { accountLane } from "../../account/accountLane.ts";
import { resolveAttachmentRelativePath } from "../../attachmentPaths.ts";
import { resolveAttachmentPath } from "../../attachmentStore.ts";
import { isServerBetaFeatureEnabled } from "../../betaFeatureGate.ts";
import { CheckpointDiffQuery } from "../../checkpointing/Services/CheckpointDiffQuery.ts";
import { inlineVisualizationDocument } from "../../inlineVisualization.ts";
import {
  readInlineVisualizationLibrary,
  readInlineVisualizationRequest,
} from "../../inlineVisualizationAccess.ts";
import { readInlineVisual } from "../../inlineVisualStore.ts";
import { ServerSettingsService } from "../../serverSettings.ts";
import { ServerSecretStore } from "../../auth/Services/ServerSecretStore.ts";
import { resolveProjectCwdForKind } from "../../checkpointing/Utils.ts";
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
import { resolveScratchWorkspacesRoot } from "../../scratchWorkspaces.ts";
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
import {
  handleGuestRequest,
  type GuestFileTarget,
  type GuestRenderTarget,
  type GuestServedBytes,
  type GuestServedFile,
} from "../guestRequestHandler.ts";
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
  findGuestHtmlRender,
  findGuestInlineVisual,
  findGuestLocalArtifact,
  guestHtmlRenderSize,
  guestImageMentions,
  guestReplyMentions,
  inlineVisualizationLibraries,
  normalizeLocalReference,
  resolveGuestLinkedFile,
  resolveGuestSharedImage,
  shareableTurnDiff,
  withOfflinePagePolicy,
  type GuestImageMentions,
} from "../guestSharedResources.ts";
import {
  modelSelectionOfEvent,
  sanitizeGuestThreadEvent,
  sanitizeGuestThreadSnapshot,
} from "../guestThreadSanitizer.ts";
import { GuestShareService, type GuestShareServiceShape } from "../Services/GuestShareService.ts";
import { ShareRelayTransport } from "../Services/ShareRelayTransport.ts";
import { deleteShareFromRelay, registerShareWithRelay } from "../shareRelayRegistration.ts";
import { ShareRelayHostClient } from "../shareRelayHostClient.ts";
import {
  isOnAccountShareRelay,
  resolveShareRelayAccount,
  shareRelayEntriesForOrigin,
} from "../shareRelayOrigin.ts";
import { makeCursorSafeSnapshotLiveStream } from "../../wsSnapshotLiveStream.ts";

const SHARE_ID_BYTES = 16;
const isHtmlFileName = (name: string) => /\.html?$/iu.test(name);
// How soon an open stream notices that its session stopped working for a reason that sends no
// `ended` (for example the share row vanished). Closing, replacing, and expiry end it at once.
const ACCESS_RECHECK_INTERVAL = Duration.seconds(30);
const EXPIRY_SWEEP_INTERVAL = Duration.minutes(1);
// A guest's staged file waits for the owner's decision, which can take the whole share.
const ATTACHMENT_STAGING_GRACE_MS = 5 * 60 * 1000;

const MANAGED_ATTACHMENT_ID_PATTERN = /^att_v2_[0-9a-f]{32}$/u;
// A page load asks for every picture and page at once; they share one read of the window.
const GUEST_WINDOW_CACHE_TTL = Duration.seconds(5);

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
  // Visualization markers resolve through the projection and, for Codex threads, the settings.
  const sql = yield* SqlClient.SqlClient;
  const serverSettings = yield* Effect.serviceOption(ServerSettingsService);
  // A turn's changes, for the guest's "review changes".
  const diffQuery = yield* Effect.serviceOption(CheckpointDiffQuery);
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
  const accountSources = {
    phoneAccount,
    cloudAccount,
    env: transport.env,
    ...(transport.relayRouters ? { routers: transport.relayRouters } : {}),
  };
  /** The relay a stored share lives on, for its socket and deletion (no account needed). */
  const relayOfShare = (origin: string) =>
    shareRelayEntriesForOrigin(origin, transport.env, transport.relayRouters);

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

  /**
   * The relay forgot the share (after a restart): register it again with a fresh bearer,
   * through the relay's entry in use. The link keeps the entry it was issued on. Only a share
   * on the account's own relay is renewed; another realm's relay, or a different override, is
   * a different relay and the bearer does not go there.
   */
  const reregister = (shareId: GuestShareId, hostKey: string) =>
    Effect.gen(function* () {
      const record = yield* repository.getById(shareId);
      if (Option.isNone(record) || isGuestShareExpired(record.value, Date.now())) return false;
      const account = yield* resolveShareRelayAccount(accountSources);
      if (!isOnAccountShareRelay(account, record.value.relayOrigin)) {
        yield* Effect.logWarning("The guest share relay changed; the link cannot be renewed.", {
          shareId,
        });
        return false;
      }
      yield* registerShareWithRelay({
        fetch: transport.fetch,
        origin: record.value.relayOrigin,
        router: account.relay.router,
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
      const relay = relayOfShare(record.relayOrigin);
      // The first connection after startup goes to an entry that answers its health check.
      if (relay.router !== null) {
        const router = relay.router;
        yield* Effect.promise(() => router.ensure());
        if (entry.client !== null || liveShares.get(record.id) !== entry) return;
      }
      const hostKey = relayHostKey(signingKey, record.id);
      const client = new ShareRelayHostClient({
        origin: record.relayOrigin,
        entries: relay.router,
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
            router: relayOfShare(record.relayOrigin).router,
            shareId: record.id,
            hostKey: relayHostKey(signingKey, record.id),
          }),
        ),
        Effect.forkIn(layerScope),
      );
      yield* persisted(repository.deleteById(record.id));
      guestWindowCache.delete(record.threadId);
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
        const opened = openGuestShare({
          shareId,
          threadId,
          relayOrigin: account.origin,
          nowMs: Date.now(),
        });
        const hostKey = relayHostKey(signingKey, shareId);
        const registration = yield* registerShareWithRelay({
          fetch: transport.fetch,
          origin: account.origin,
          router: account.relay.router,
          bearer: account.bearer,
          request: {
            shareId,
            hostKeyHash: relayHostKeyHash(hostKey),
            expiresAt: opened.expiresAt,
            protocolVersion: SHARE_RELAY_PROTOCOL_VERSION,
          },
        });
        // The link names the entry the share was registered through.
        const record =
          registration.origin === opened.relayOrigin
            ? opened
            : { ...opened, relayOrigin: registration.origin };
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
              origin: record.relayOrigin,
              router: account.relay.router,
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
        {
          type: "hello",
          protocolVersion: GUEST_SHARE_PROTOCOL_VERSION,
          routes: [...GUEST_OPTIONAL_ROUTES],
        },
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
      // A tool result's picture (an MCP image the agent produced), while the window shows it.
      if (found === undefined && MANAGED_ATTACHMENT_ID_PATTERN.test(attachmentId)) {
        const { thread } = yield* guestWindow(record.threadId);
        found = findGuestLocalArtifact(thread, attachmentId) ?? undefined;
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

  /**
   * The thread as the session's stream shows it: the same scrubbed window, so a guest can load
   * a page or picture only while the transcript it watches shows it. The pictures it names are
   * indexed once per read.
   */
  const readGuestWindow = (threadId: ThreadId) =>
    snapshotQuery
      .getThreadDetailSnapshotById(threadId, { limit: GUEST_SNAPSHOT_MESSAGE_LIMIT })
      .pipe(
        Effect.mapError(() => guestAccessError("unavailable")),
        Effect.flatMap((detail) =>
          Option.isNone(detail) ||
          detail.value.thread.archivedAt !== null ||
          detail.value.thread.deletedAt !== null
            ? Effect.fail(inactive)
            : Effect.sync(() => {
                const thread = sanitizeGuestThreadSnapshot(detail.value, {
                  userTurnLimit: GUEST_SNAPSHOT_USER_TURN_LIMIT,
                  messageLimit: GUEST_SNAPSHOT_MESSAGE_LIMIT,
                }).thread;
                return {
                  thread,
                  mentions: guestImageMentions(thread),
                  replies: guestReplyMentions(thread),
                };
              }),
        ),
      );

  const guestWindowCache = new Map<
    ThreadId,
    Effect.Effect<
      {
        readonly thread: OrchestrationThread;
        readonly mentions: GuestImageMentions;
        readonly replies: ReadonlyArray<string>;
      },
      GuestShareAccessError
    >
  >();
  const guestWindow = (threadId: ThreadId) =>
    Effect.gen(function* () {
      let cached = guestWindowCache.get(threadId);
      if (cached === undefined) {
        cached = yield* Effect.cachedWithTTL(readGuestWindow(threadId), GUEST_WINDOW_CACHE_TTL);
        guestWindowCache.set(threadId, cached);
      }
      return yield* cached;
    });

  /** The thread's folder, for pictures the transcript names by a relative path. */
  const threadFolder = (threadId: ThreadId) =>
    snapshotQuery.getThreadCheckpointContext(threadId).pipe(
      Effect.map((context) =>
        Option.isNone(context)
          ? null
          : resolveThreadWorkspaceCwd({
              projectCwd: resolveProjectCwdForKind({
                kind: context.value.projectKind,
                workspaceRoot: context.value.workspaceRoot,
                worktreePath: context.value.worktreePath,
              }),
              envMode: context.value.envMode,
              worktreePath: context.value.worktreePath,
              workingDirectory: context.value.workingDirectory,
            }),
      ),
      Effect.orElseSucceed(() => null),
    );

  const media: GuestShareServiceShape["media"] = (session, src) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      const { mentions } = yield* guestWindow(record.threadId);
      const cwd = yield* threadFolder(record.threadId);
      const picture = yield* Effect.promise(() =>
        resolveGuestSharedImage({
          src,
          cwd,
          mentions,
          scratchWorkspacesRoot: resolveScratchWorkspacesRoot(),
        }).catch(() => null),
      );
      if (picture === null) return yield* guestAccessError("unavailable");
      return picture;
    });

  /** A page the agent published in the shared window, as stored. */
  const sharedPage = (thread: OrchestrationThread, attachmentId: string) =>
    Effect.gen(function* () {
      const page = findGuestHtmlRender(thread, attachmentId, serverConfig.attachmentsDir);
      if (page === null) return yield* guestAccessError("unavailable");
      const sizeBytes = yield* Effect.promise(() => guestHtmlRenderSize(page.path));
      if (sizeBytes === null) return yield* guestAccessError("unavailable");
      return { path: page.path, sizeBytes, title: page.reference.title };
    });

  /** An inline visual the shared window shows, with its stored source. */
  const sharedVisual = (thread: OrchestrationThread, visualId: string) =>
    Effect.gen(function* () {
      const unavailable = guestAccessError("unavailable");
      // The owner's own app shows visuals only while the feature is on.
      if (!isServerBetaFeatureEnabled(INLINE_VISUALS_BETA_FEATURE)) return yield* unavailable;
      const visual = findGuestInlineVisual(thread, visualId);
      if (visual === null) return yield* unavailable;
      const source = yield* Effect.promise(() =>
        readInlineVisual({
          attachmentsDir: serverConfig.attachmentsDir,
          threadId: thread.id,
          visualId,
        }).catch(() => null),
      );
      if (source === null) return yield* unavailable;
      return { ...visual, source };
    });

  /**
   * A visualization marker's file. The marker must be in one of the agent's replies in the
   * window, and the file must resolve the way the owner's own frame resolves it.
   */
  const sharedVisualization = (threadId: ThreadId, replies: ReadonlyArray<string>, src: string) =>
    Effect.gen(function* () {
      const unavailable = guestAccessError("unavailable");
      const needle = normalizeLocalReference(src);
      if (needle.length === 0 || !replies.some((reply) => reply.includes(needle))) {
        return yield* unavailable;
      }
      const lookup = readInlineVisualizationRequest({ threadId, requestedPath: src }).pipe(
        Effect.provideService(SqlClient.SqlClient, sql),
        Effect.provideService(ServerConfig, serverConfig),
      );
      const resolved = yield* (
        Option.isSome(serverSettings)
          ? lookup.pipe(Effect.provideService(ServerSettingsService, serverSettings.value))
          : lookup
      ).pipe(Effect.orElseSucceed(() => null));
      if (resolved === null) return yield* unavailable;
      return resolved.visualization;
    });

  /** A file the agent linked in a reply, inside the thread's folder. */
  const sharedLinkedFile = (threadId: ThreadId, replies: ReadonlyArray<string>, src: string) =>
    Effect.gen(function* () {
      const cwd = yield* threadFolder(threadId);
      const linked = yield* Effect.promise(() =>
        resolveGuestLinkedFile({
          src,
          cwd,
          replies,
          scratchWorkspacesRoot: resolveScratchWorkspacesRoot(),
        }).catch(() => null),
      );
      if (linked === null) return yield* guestAccessError("unavailable");
      return linked;
    });

  const render: GuestShareServiceShape["render"] = (session, target: GuestRenderTarget) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      const { thread, replies } = yield* guestWindow(record.threadId);
      switch (target.kind) {
        case "page": {
          const page = yield* sharedPage(thread, target.attachmentId);
          return { kind: "path", path: page.path, sizeBytes: page.sizeBytes } as GuestServedBytes;
        }
        case "visual": {
          const visual = yield* sharedVisual(thread, target.visualId);
          if (visual.format !== "html") return yield* guestAccessError("unavailable");
          // The same document the owner's frame runs. The theme's colors follow over
          // postMessage once the frame loads, as they do when the owner changes theme.
          const text = buildInlineVisualDocument(visual.source, {
            appearance: target.appearance,
            variables: {},
          });
          return { kind: "text", text } as GuestServedBytes;
        }
        case "visualization": {
          const visualization = yield* sharedVisualization(thread.id, replies, target.src);
          const text = yield* Effect.promise(() =>
            inlineVisualizationLibraries(
              inlineVisualizationDocument(visualization.source),
              (name) => readInlineVisualizationLibrary(name, serverConfig.staticDir),
            ),
          );
          return { kind: "text", text } as GuestServedBytes;
        }
        case "file": {
          const linked = yield* sharedLinkedFile(thread.id, replies, target.src);
          if (!isHtmlFileName(linked.name) || linked.sizeBytes > GUEST_RENDER_MAX_BYTES) {
            return yield* guestAccessError("unavailable");
          }
          const html = yield* fileSystem
            .readFileString(linked.path)
            .pipe(Effect.mapError(() => guestAccessError("unavailable")));
          // The owner's own file preview loads nothing from the network; the page carries the
          // same rule as its first element, since the relay sends its own frame headers.
          return { kind: "text", text: withOfflinePagePolicy(html) } as GuestServedBytes;
        }
      }
    });

  const file: GuestShareServiceShape["file"] = (session, target: GuestFileTarget) =>
    Effect.gen(function* () {
      const record = yield* authorizeSession(session);
      const { thread, replies } = yield* guestWindow(record.threadId);
      // Sources and pages download as bytes; the relay plays only pictures and videos inline.
      const bytes = "application/octet-stream";
      switch (target.kind) {
        case "visual": {
          const visual = yield* sharedVisual(thread, target.visualId);
          const extension = visual.format === "html" ? "html" : "txt";
          return {
            kind: "text",
            text: visual.source,
            name: `${visual.title}.${extension}`,
            mimeType: bytes,
          } as GuestServedFile;
        }
        case "page": {
          const page = yield* sharedPage(thread, target.attachmentId);
          return {
            kind: "path",
            path: page.path,
            sizeBytes: page.sizeBytes,
            name: htmlRenderFileName(page.title),
            mimeType: bytes,
          } as GuestServedFile;
        }
        case "visualization": {
          const visualization = yield* sharedVisualization(thread.id, replies, target.src);
          return {
            kind: "text",
            text: visualization.source,
            name: pathBasename(visualization.path),
            mimeType: bytes,
          } as GuestServedFile;
        }
        case "file": {
          const linked = yield* sharedLinkedFile(thread.id, replies, target.src);
          return {
            kind: "path",
            path: linked.path,
            sizeBytes: linked.sizeBytes,
            name: linked.name,
            mimeType: linked.mimeType,
          } as GuestServedFile;
        }
        case "diff": {
          // The change a turn in the window made, as the owner's "review changes" shows it.
          const unavailable = guestAccessError("unavailable");
          const checkpoint = thread.checkpoints.find(
            (candidate) => candidate.turnId === target.turnId && candidate.status === "ready",
          );
          if (
            Option.isNone(diffQuery) ||
            checkpoint === undefined ||
            checkpoint.checkpointTurnCount < 1
          ) {
            return yield* unavailable;
          }
          const result = yield* diffQuery.value
            .getTurnDiff({
              threadId: thread.id,
              fromTurnCount: checkpoint.checkpointTurnCount - 1,
              toTurnCount: checkpoint.checkpointTurnCount,
            })
            .pipe(Effect.mapError(() => unavailable));
          const text = shareableTurnDiff(result.diff);
          if (Buffer.byteLength(text, "utf8") > GUEST_FILE_MAX_BYTES) return yield* unavailable;
          return { kind: "text", text, name: "changes.diff", mimeType: bytes } as GuestServedFile;
        }
        case "map": {
          // The map the owner's own pages draw: the owner's lane, with only the map keys Moss
          // ships publicly. A key the owner set for themselves stays on their computer.
          const lane = yield* accountLane(phoneAccount);
          const text = JSON.stringify(resolveGuestHtmlRenderMapConfig({ env: process.env, lane }));
          return { kind: "text", text, name: "map.json", mimeType: bytes } as GuestServedFile;
        }
      }
    });

  const operations = { redeem, check, submit, stream, attachment, render, media, file };

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
    render,
    media,
    file,
    handleGuestRequest: handleGuestRequestOperation,
  } satisfies GuestShareServiceShape;
});

export const GuestShareServiceLive = Layer.effect(GuestShareService, make);

export type { GuestAccessErrorReason, GuestShareAccessError, GuestShareOwnerError };
