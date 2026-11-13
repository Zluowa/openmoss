// FILE: attachments.ts
// Purpose: Keep the pictures and files of a Mossbot group post. The sender stages them under
//          the room's project id; the room claims them for the post, and each member turn that
//          answers the post gets its own copy in that member's thread.
// Layer: Mossbot rooms
// Exports: makeRoomAttachmentStore

import { MessageId, ThreadId, type MossbotRoomAttachment } from "@moss/contracts";
import { MossbotRoomError } from "@moss/shared/mossbotRoom";
import { Effect } from "effect";

import { cloneDelegatedAttachments } from "../agentGateway/delegatedAttachments";
import { LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL } from "../managedAttachmentPrincipal";
import type { ManagedAttachmentRepositoryShape } from "../persistence/Services/ManagedAttachments";
import type { RoomAttachmentStore } from "./runtime";

const unavailable = (detail: string) =>
  new MossbotRoomError(
    "attachment_unavailable",
    `An attachment could not be used (${detail}). Attach it again and retry.`,
  );

export function makeRoomAttachmentStore(input: {
  readonly repository: ManagedAttachmentRepositoryShape;
  readonly attachmentsDir: string;
}): RoomAttachmentStore {
  const { repository, attachmentsDir } = input;
  return {
    keep: ({ ownerId, requestId, attachments, uploader }) =>
      Effect.runPromise(
        repository.claimForAcceptedTurn({
          attachmentIds: attachments.map((attachment) => attachment.id),
          ownerThreadId: ownerId,
          ownerKind: uploader.ownerKind,
          ownerId: uploader.ownerId,
          commandId: `room-post:${ownerId}:${requestId}`,
          messageId: requestId,
          now: new Date().toISOString(),
        }),
      ).then((claim) => {
        if (claim.status !== "claimed") throw unavailable(claim.reason);
        // The stored record, not the client's description, says what each file is.
        return attachments.map((attachment): MossbotRoomAttachment => {
          const blob = claim.attachments.find((row) => row.attachmentId === attachment.id);
          if (!blob || (blob.kind !== "image" && blob.kind !== "file") || blob.sizeBytes === null)
            throw unavailable("missing");
          return {
            type: blob.kind,
            id: blob.attachmentId,
            name: blob.originalName,
            mimeType: blob.mimeType,
            sizeBytes: blob.sizeBytes,
          } as MossbotRoomAttachment;
        });
      }),
    copyToThread: ({ ownerId, requestId, attachments, threadId, messageId }) =>
      Effect.runPromise(
        cloneDelegatedAttachments({
          sourceMessages: [
            {
              threadId: ThreadId.makeUnsafe(ownerId),
              messageId: MessageId.makeUnsafe(requestId),
              attachments,
            },
          ],
          targetThreadId: threadId,
          targetMessageId: messageId,
          dispatchKey: `room-post:${ownerId}:${requestId}`,
          attachmentsDir,
          repository,
          principal: LOCAL_LOOPBACK_ATTACHMENT_PRINCIPAL,
        }),
      ).then((copies) =>
        copies.filter(
          (copy): copy is MossbotRoomAttachment => copy.type === "image" || copy.type === "file",
        ),
      ),
    release: ({ ownerId, attachmentIds }) =>
      Effect.runPromise(
        attachmentIds
          ? repository.markCleanupByIds({
              attachmentIds,
              ownerThreadId: ownerId,
              reason: "room-post-trimmed",
              requestedAt: new Date().toISOString(),
            })
          : repository.markCleanupByThread({
              ownerThreadId: ownerId,
              reason: "room-deleted",
              requestedAt: new Date().toISOString(),
            }),
      ).then(() => undefined),
  };
}
