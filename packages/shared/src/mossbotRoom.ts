import type { MossbotRoomErrorCode, MossbotRoomMember } from "@moss/contracts";
import { resolveMentions } from "./mossbot/room-mentions";
import { isMentionBoundary, isMentionNameContinuation } from "./mossbot/mention-boundary";

/** A group-chat failure with a stable code the client localizes; the message is English detail. */
export class MossbotRoomError extends Error {
  constructor(
    readonly code: MossbotRoomErrorCode,
    message: string,
  ) {
    super(message);
    this.name = "MossbotRoomError";
  }
}

export const isMossbotRoomError = (cause: unknown): cause is MossbotRoomError =>
  cause instanceof MossbotRoomError ||
  (typeof cause === "object" &&
    cause !== null &&
    (cause as { name?: unknown }).name === "MossbotRoomError" &&
    typeof (cause as { code?: unknown }).code === "string");

// Adapted from OpenMausBot src/lib/group-routing.ts, Apache-2.0, commit
// 58378e85449ca49f3370d72e6c70cece4fee413f. Moss uses native thread targets,
// explicit refusal for ambiguous names, and no automatic model-based decider.
export function routeMossbotRoomMessage(
  text: string,
  members: readonly MossbotRoomMember[],
  responder: "everyone" | "mentions" | "lead",
  picked: readonly string[] = [],
): MossbotRoomMember[] {
  members = members.filter((member) => !member.hidden);
  for (let at = text.indexOf("@"); at !== -1; at = text.indexOf("@", at + 1)) {
    if (
      isMentionBoundary(text, at) &&
      text.slice(at + 1, at + 9).toLowerCase() === "everyone" &&
      !isMentionNameContinuation(text.slice(at + 9))
    )
      return [...members];
  }
  const mentioned = resolveMentions(text, members, picked);
  if (mentioned.ambiguous.length)
    throw new MossbotRoomError(
      "ambiguous_name",
      "Several assistants share this name. Select the intended assistant from the member list.",
    );
  if (mentioned.bots.length) return mentioned.bots;
  return responder === "everyone" ? [...members] : responder === "lead" ? members.slice(0, 1) : [];
}

// Renderer ports and server routing use the same upstream mention grammar.
export { resolveMentions, MENTION_PICKS_MAX } from "./mossbot/room-mentions";
export { isMentionBoundary, isMentionNameContinuation } from "./mossbot/mention-boundary";
