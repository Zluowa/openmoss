import { SecretRequestActivityPayload } from "./secretRequest";
import { Option, Schema, SchemaIssue } from "effect";
import {
  ChatFileAttachment,
  ChatImageAttachment,
  ModelSelection,
  OrchestrationMessage,
  PROVIDER_SEND_TURN_MAX_ATTACHMENTS,
} from "./orchestration";
import { ProjectId, ThreadId } from "./baseSchemas";

const Id = Schema.String.check(Schema.isPattern(/^[a-zA-Z0-9_-]{1,128}$/));
export const MossbotRoomCreateInput = Schema.Struct({
  requestId: Id,
  name: Schema.String.check(Schema.isMinLength(1), Schema.isMaxLength(100)),
  memberProjectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  section: Schema.optional(Schema.String.check(Schema.isMaxLength(60))),
  responder: Schema.Literals(["everyone", "mentions", "lead"]),
});
export type MossbotRoomCreateInput = typeof MossbotRoomCreateInput.Type;
export const MossbotRoomGetInput = Schema.Struct({ roomId: Id });
export const MossbotRoomDeleteResult = Schema.Struct({ roomId: Id });
export type MossbotRoomDeleteResult = typeof MossbotRoomDeleteResult.Type;

/** Stable failure codes of group-chat operations; clients localize by code (wire: `mossbot.<code>`). */
export const MOSSBOT_ROOM_ERROR_CODES = [
  "room_not_found",
  "request_conflict",
  "duplicate_member",
  "name_required",
  "saving",
  "not_member",
  "message_conflict",
  "no_active_turn",
  "message_limit",
  "turn_limit",
  "members_changed",
  "stop_first",
  "project_deleted",
  "member_thread_deleted",
  "assistant_unavailable",
  "ambiguous_name",
  "unavailable",
  "member_turn_failed",
  "attachment_unavailable",
] as const;
export type MossbotRoomErrorCode = (typeof MOSSBOT_ROOM_ERROR_CODES)[number];
export const MOSSBOT_ROOM_ERROR_CODE_PREFIX = "mossbot.";
/**
 * A picture or file on a group post. The sender uploads it the way a thread turn's attachment
 * is uploaded (`/api/attachments/upload`), naming the room's `projectId` as the upload's
 * `threadId`; the room keeps it and hands each responding member its own copy.
 */
export const MossbotRoomAttachment = Schema.Union([ChatImageAttachment, ChatFileAttachment]);
export type MossbotRoomAttachment = typeof MossbotRoomAttachment.Type;
const MossbotRoomAttachmentList = Schema.Array(MossbotRoomAttachment).check(
  Schema.isMaxLength(PROVIDER_SEND_TURN_MAX_ATTACHMENTS),
);
export const MossbotRoomSendInput = Schema.Struct({
  roomId: Id,
  requestId: Id,
  text: Schema.String.check(Schema.isMaxLength(32_000)),
  picked: Schema.optional(Schema.Array(ProjectId).check(Schema.isMaxLength(20))),
  attachments: Schema.optional(MossbotRoomAttachmentList),
}).check(
  Schema.makeFilter(
    (input: { readonly text: string; readonly attachments?: ReadonlyArray<unknown> | undefined }) =>
      input.text.length > 0 ||
      (input.attachments?.length ?? 0) > 0 ||
      new SchemaIssue.InvalidValue(Option.some(input.text), {
        message: "A group post must include text or attachments.",
      }),
    { identifier: "MossbotRoomPostContent" },
  ),
);
export type MossbotRoomSendInput = typeof MossbotRoomSendInput.Type;
export const MossbotRoomMember = Schema.Struct({
  id: ProjectId,
  name: Schema.String,
  icon: Schema.NullOr(Schema.String),
  color: Schema.NullOr(Schema.String),
  threadId: ThreadId,
  modelSelection: ModelSelection,
  hidden: Schema.optional(Schema.Boolean),
});
export type MossbotRoomMember = typeof MossbotRoomMember.Type;
export const MossbotRoomLine = Schema.Struct({
  id: Schema.String,
  senderId: Schema.NullOr(ProjectId),
  text: Schema.String,
  createdAt: Schema.String,
  attachments: Schema.optional(Schema.Array(MossbotRoomAttachment)),
});
export const MossbotRoomDelivery = Schema.Struct({
  requestId: Schema.String,
  memberId: ProjectId,
  state: Schema.Literals(["queued", "running", "completed", "failed", "cancelled"]),
  error: Schema.NullOr(Schema.String),
});
export const MossbotRoom = Schema.Struct({
  id: Id,
  name: Schema.String,
  projectId: ProjectId,
  section: Schema.optional(Schema.String),
  createdAt: Schema.String,
  responder: Schema.Literals(["everyone", "mentions", "lead"]),
  members: Schema.Array(MossbotRoomMember),
  lines: Schema.Array(MossbotRoomLine),
  deliveries: Schema.Array(MossbotRoomDelivery),
});
export type MossbotRoom = typeof MossbotRoom.Type;
export const MossbotRoomView = Schema.Struct({
  room: MossbotRoom,
  secretRequests: Schema.Array(
    Schema.Struct({
      memberId: ProjectId,
      threadId: ThreadId,
      request: SecretRequestActivityPayload,
    }),
  ),
  replies: Schema.Array(
    Schema.Struct({ memberId: ProjectId, threadId: ThreadId, message: OrchestrationMessage }),
  ),
});
export type MossbotRoomView = typeof MossbotRoomView.Type;

export const MossbotRoomUpdateInput = Schema.Struct({
  roomId: Id,
  memberProjectIds: Schema.Array(ProjectId).check(Schema.isMinLength(1), Schema.isMaxLength(12)),
  expectedMemberProjectIds: Schema.Array(ProjectId).check(Schema.isMaxLength(12)),
  responder: Schema.Literals(["everyone", "mentions", "lead"]),
});
export type MossbotRoomUpdateInput = typeof MossbotRoomUpdateInput.Type;
