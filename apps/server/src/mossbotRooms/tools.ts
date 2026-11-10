import { Effect, Schema } from "effect";
import { MossbotRoomSendInput } from "@moss/contracts";
import type { MossbotRoomRuntime } from "./runtime";
import {
  READ_ONLY_TOOL_ANNOTATIONS,
  WRITE_TOOL_ANNOTATIONS,
  type ToolEntry,
} from "../agentGateway/toolRuntime";
import { mcpToolResultJson, mcpToolResultError } from "../agentGateway/protocol";
import { mossbotRoomToolErrorText } from "./errors";
import { MossbotRoomError } from "@moss/shared/mossbotRoom";

export function makeMossbotRoomTools(runtime: MossbotRoomRuntime): ToolEntry[] {
  return [
    {
      requiredCapability: "thread:read",
      definition: {
        name: "moss_room_read",
        description:
          "Read the shared group conversation and its members. You can only read rooms where your current thread is a member.",
        inputSchema: {
          type: "object",
          properties: { roomId: { type: "string" } },
          required: ["roomId"],
          additionalProperties: false,
        },
        annotations: READ_ONLY_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.tryPromise({
          try: async () => {
            const room = runtime
              .list()
              .find(
                (r) =>
                  r.id === args.roomId &&
                  r.members.some((m) => !m.hidden && m.threadId === context.callerThreadId),
              );
            if (!room)
              throw new MossbotRoomError("not_member", "You are not a member of this room.");
            return mcpToolResultJson(await runtime.get(room.id));
          },
          catch: (error) => error,
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(mcpToolResultError(mossbotRoomToolErrorText(error))),
          ),
        ),
    },
    {
      requiredCapability: "thread:write",
      requiresActiveTurn: true,
      definition: {
        name: "moss_room_post",
        description:
          "Post to your current Mossbot group. @name or @everyone queues peers to respond in turn. Use a stable requestId when retrying. Ordinary final replies are already shown in the group; do not repost them. Peer exchanges are bounded and stop with the group.",
        inputSchema: {
          type: "object",
          properties: {
            roomId: { type: "string" },
            requestId: { type: "string" },
            text: { type: "string" },
            picked: { type: "array", items: { type: "string" } },
          },
          required: ["roomId", "requestId", "text"],
          additionalProperties: false,
        },
        annotations: WRITE_TOOL_ANNOTATIONS,
      },
      handler: (args, context) =>
        Effect.gen(function* () {
          const input = yield* Effect.try({
            try: () => Schema.decodeUnknownSync(MossbotRoomSendInput)(args),
            catch: (error) => new Error(String(error)),
          });
          yield* context.assertCallerTurnActive();
          return yield* Effect.tryPromise({
            try: async () => mcpToolResultJson(await runtime.send(input, context.callerThreadId)),
            catch: (error) => error,
          });
        }).pipe(
          Effect.catch((error) =>
            Effect.succeed(mcpToolResultError(mossbotRoomToolErrorText(error))),
          ),
        ),
    },
  ];
}
