import { describe, it, expect, vi } from "vitest";
import { Effect } from "effect";
import { makeMossbotRoomTools } from "./tools";
import type { MossbotRoomRuntime } from "./runtime";
import type { ToolContext } from "../agentGateway/toolRuntime";
const context = (threadId: string, active = true) =>
  ({
    callerThreadId: threadId,
    assertCallerTurnActive: () => (active ? Effect.void : Effect.fail(new Error("retired turn"))),
  }) as unknown as ToolContext;
function setup() {
  const runtime = {
    list: () => [{ id: "room", members: [{ threadId: "member", hidden: false }] }],
    get: vi.fn(async () => ({ room: { id: "room" } })),
    send: vi.fn(async () => ({ id: "room" })),
  };
  return { runtime, tools: makeMossbotRoomTools(runtime as unknown as MossbotRoomRuntime) };
}
describe("room MCP boundary", () => {
  it("does not read a room for a different caller thread", async () => {
    const { runtime, tools } = setup();
    const result = await Effect.runPromise(
      tools[0]!.handler({ roomId: "room" }, context("outsider")),
    );
    expect(result.isError).toBe(true);
    expect(runtime.get).not.toHaveBeenCalled();
  });
  it("permits room reads only after binding the member's native identity", async () => {
    const { runtime, tools } = setup();
    const result = await Effect.runPromise(
      tools[0]!.handler({ roomId: "room" }, context("member")),
    );
    expect(result.isError).not.toBe(true);
    expect(runtime.get).toHaveBeenCalledWith("room");
  });
  it("rejects writes from retired native turns before posting to the queue", async () => {
    const { runtime, tools } = setup();
    const result = await Effect.runPromise(
      tools[1]!.handler(
        { roomId: "room", requestId: "post", text: "@peer review" },
        context("member", false),
      ),
    );
    expect(result.isError).toBe(true);
    expect(runtime.send).not.toHaveBeenCalled();
  });
});

it("removed members cannot read their former room through MCP", async () => {
  const { runtime, tools } = setup();
  runtime.list = () => [{ id: "room", members: [{ threadId: "member", hidden: true }] }];
  const result = await Effect.runPromise(tools[0]!.handler({ roomId: "room" }, context("member")));
  expect(result.isError).toBe(true);
  expect(runtime.get).not.toHaveBeenCalled();
});
