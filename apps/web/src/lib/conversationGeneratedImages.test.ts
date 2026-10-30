import { describe, expect, it } from "vitest";
import { conversationImageIdentity, mergeConversationImages } from "./conversationGeneratedImages";

describe("conversation image identity", () => {
  it("retains repeated provider call ids in different turns and separates delimiter collisions", () => {
    const a = conversationImageIdentity("turn-a", "call-1");
    const b = conversationImageIdentity("turn-b", "call-1");
    expect(a).not.toBe(b);
    expect(conversationImageIdentity("a:b", "c")).not.toBe(conversationImageIdentity("a", "b:c"));
    expect(
      mergeConversationImages(
        [{ id: a, path: "/a.png", name: "a.png" }],
        [{ id: b, path: "/b.png", name: "b.png" }],
      ),
    ).toHaveLength(2);
  });
  it("keeps chronology while updating a recovered image and appending a new completion", () => {
    expect(
      mergeConversationImages(
        [
          { id: "a", path: "/old.png", name: "old" },
          { id: "b", path: "/b.png", name: "b" },
        ],
        [
          { id: "a", path: "/recovered.png", name: "new" },
          { id: "c", path: "/c.png", name: "c" },
        ],
      ).map((image) => [image.id, image.path]),
    ).toEqual([
      ["a", "/recovered.png"],
      ["b", "/b.png"],
      ["c", "/c.png"],
    ]);
  });
});
