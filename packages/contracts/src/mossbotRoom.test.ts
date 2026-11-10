import { describe, it, expect } from "vitest";
import { Schema } from "effect";
import { MossbotRoomCreateInput, MossbotRoomUpdateInput, MossbotRoomMember } from "./mossbotRoom";
describe("native group UI contracts", () => {
  it("accepts the upstream optional context while preserving provider/account identity", () => {
    expect(
      Schema.decodeUnknownSync(MossbotRoomCreateInput)({
        requestId: "room",
        name: "Launch",
        section: "Review",
        responder: "lead",
        memberProjectIds: ["a"],
      }).section,
    ).toBe("Review");
    const member = Schema.decodeUnknownSync(MossbotRoomMember)({
      id: "a",
      name: "Nova",
      icon: null,
      color: null,
      threadId: "native",
      hidden: true,
      modelSelection: { provider: "hermes", model: "custom", instanceId: "private-cli" },
    });
    expect(member.modelSelection).toMatchObject({ instanceId: "private-cli" });
    expect(member.hidden).toBe(true);
  });
  it("requires the observed roster for a membership save", () => {
    expect(() =>
      Schema.decodeUnknownSync(MossbotRoomUpdateInput)({
        roomId: "room",
        memberProjectIds: ["a"],
        responder: "everyone",
      }),
    ).toThrow();
  });
  it("rejects empty and oversized rosters and unsupported responder modes", () => {
    for (const ids of [[], Array.from({ length: 13 }, (_, i) => `member-${i}`)])
      expect(() =>
        Schema.decodeUnknownSync(MossbotRoomUpdateInput)({
          roomId: "room",
          expectedMemberProjectIds: ["a"],
          memberProjectIds: ids,
          responder: "mentions",
        }),
      ).toThrow();
    expect(() =>
      Schema.decodeUnknownSync(MossbotRoomUpdateInput)({
        roomId: "room",
        expectedMemberProjectIds: ["a"],
        memberProjectIds: ["a"],
        responder: "auto",
      }),
    ).toThrow();
  });
});
