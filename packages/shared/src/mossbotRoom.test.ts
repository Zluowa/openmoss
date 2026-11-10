import { describe, it, expect } from "vitest";
import { ProjectId, ThreadId, type MossbotRoomMember } from "@moss/contracts";
import { routeMossbotRoomMessage } from "./mossbotRoom";
const members: MossbotRoomMember[] = ["Nova", "Atlas", "小芽"].map((name, i) => ({
  id: ProjectId.makeUnsafe(String(i)),
  name,
  icon: null,
  color: null,
  threadId: ThreadId.makeUnsafe(`thread-${i}`),
  modelSelection: { provider: "codex", model: "test" },
}));
describe("OpenMaus-adapted group routing", () => {
  it.each(["@Nova check", "(@Nova) check", "**@Nova** check", "hello\n@Nova check"])(
    "resolves explicit mention: %s",
    (text) => {
      expect(routeMossbotRoomMessage(text, members, "everyone")).toEqual([members[0]]);
    },
  );
  it.each(["user@Nova.example", "https://site/@Nova", "@NovaExtra", "@小芽研究"])(
    "does not misroute: %s",
    (text) => {
      expect(routeMossbotRoomMessage(text, members, "mentions")).toEqual([]);
    },
  );
  it("supports everyone and explicit lead/mentions modes", () => {
    expect(routeMossbotRoomMessage("@everyone discuss", members, "lead")).toEqual(members);
    expect(routeMossbotRoomMessage("hello", members, "lead")).toEqual([members[0]]);
    expect(routeMossbotRoomMessage("hello", members, "mentions")).toEqual([]);
  });
  it("uses a selected identity to disambiguate a shared name", () => {
    const duplicate = [members[0]!, { ...members[1]!, name: "Nova" }];
    expect(() => routeMossbotRoomMessage("@Nova check", duplicate, "everyone")).toThrow();
    expect(routeMossbotRoomMessage("@Nova check", duplicate, "everyone", [members[1]!.id])).toEqual(
      [duplicate[1]],
    );
  });
});

it("never routes to retired members, including everyone and lead fallbacks", () => {
  const roster = [{ ...members[0]!, hidden: true }, members[1]!];
  expect(routeMossbotRoomMessage("@everyone discuss", roster, "everyone")).toEqual([members[1]]);
  expect(routeMossbotRoomMessage("hello", roster, "lead")).toEqual([members[1]]);
  expect(routeMossbotRoomMessage("@Nova hello", roster, "mentions")).toEqual([]);
});
