// What the owner's real Codex turn of 2026-11-17 becomes in the work log.

import { describe, expect, it } from "vitest";

import { isTypedGeneratedImageEntry } from "./components/chat/generatedImageGallery.logic";
import { codexOwnerWorkEntries } from "./test/fixtures/codexOwnerImageTurn.timeline";

describe("the owner's Codex turn in the work log", () => {
  it("keeps one image record: the start merges into the finished picture", () => {
    const images = codexOwnerWorkEntries().filter((entry) => entry.itemType === "image_generation");
    // Before the fix the start stayed behind as its own row and drew an empty
    // grey "已生成图像 1" box in the unfolded turn.
    expect(images).toHaveLength(1);
    expect(images[0]!.generatedImage).toMatchObject({
      state: "completed",
      path: expect.stringContaining("exec-98c98b54-7665-4fdc-b6e9-fe02edc92b99.png"),
    });
    expect(isTypedGeneratedImageEntry(images[0]!)).toBe(true);
  });

  it("keeps each Codex reasoning item as its own row with its item id", () => {
    const reasoning = codexOwnerWorkEntries().filter(
      (entry) => entry.toolTitle === "Reasoning trace",
    );
    expect(reasoning.length).toBeGreaterThan(20);
    expect(reasoning.every((entry) => entry.toolCallId?.startsWith("rs_"))).toBe(true);
  });
});
