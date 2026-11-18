import { afterEach, describe, expect, it } from "vitest";

import { SUBAGENT_MARK_TONES } from "~/theme/subagentMarkColors";

import { SUBAGENT_MARK_SHAPE_COUNT, SUBAGENT_MARK_SHAPES } from "./subagentMarkGeometry";
import {
  registerSubagentMarkOrder,
  resetSubagentMarkOrderForTests,
  subagentMarkAppearance,
  subagentMarkIndexFor,
  subagentMarkKey,
  subagentMarkOrderFromEntries,
} from "./subagentMarkOrder";

const entry = (...threadIds: string[]) => ({
  subagents: threadIds.map((threadId) => ({ threadId })),
});

afterEach(() => resetSubagentMarkOrderForTests());

describe("subagent mark order", () => {
  it("hands marks out in order of first appearance in the chat", () => {
    const order = subagentMarkOrderFromEntries([
      entry("cedar"),
      entry("birch", "cedar"),
      entry("maple"),
      entry("birch"),
    ]);
    expect([...order]).toEqual([
      ["cedar", 0],
      ["birch", 1],
      ["maple", 2],
    ]);
  });

  it("treats a child thread id and its provider thread id as one subagent", () => {
    expect(subagentMarkKey("subagent:parent-1:019a-cedar")).toBe("019a-cedar");
    registerSubagentMarkOrder("parent-1", [
      entry("019a-birch"),
      { subagents: [{ threadId: "019a-cedar", resolvedThreadId: "subagent:parent-1:019a-cedar" }] },
    ]);
    expect(subagentMarkIndexFor("019a-cedar")).toBe(1);
    expect(subagentMarkIndexFor("subagent:parent-1:019a-cedar")).toBe(1);
  });

  it("never changes a mark when older turns of the chat load later", () => {
    registerSubagentMarkOrder("chat", [entry("rowan"), entry("alder", "hazel")]);
    const before = ["rowan", "alder", "hazel"].map(subagentMarkIndexFor);
    expect(before).toEqual([0, 1, 2]);
    // The chat pages in its older turns: earlier agents arrive first in the log, plus a repeat.
    registerSubagentMarkOrder("chat", [
      entry("cedar", "birch"),
      entry("maple", "rowan"),
      entry("rowan"),
      entry("alder", "hazel"),
    ]);
    expect(["rowan", "alder", "hazel"].map(subagentMarkIndexFor)).toEqual(before);
    const all = ["cedar", "birch", "maple", "rowan", "alder", "hazel"].map(subagentMarkIndexFor);
    expect(new Set(all).size).toBe(all.length);
    expect(["cedar", "birch", "maple"].map(subagentMarkIndexFor)).toEqual([3, 4, 5]);
  });

  it("keeps each chat's marks its own", () => {
    registerSubagentMarkOrder("chat-a", [entry("a-1", "a-2")]);
    registerSubagentMarkOrder("chat-b", [entry("b-1", "b-2", "b-3")]);
    // Chat B's agents start from the first mark of their own chat, and A's do not move.
    expect(["a-1", "a-2"].map(subagentMarkIndexFor)).toEqual([0, 1]);
    expect(["b-1", "b-2", "b-3"].map(subagentMarkIndexFor)).toEqual([0, 1, 2]);
    // A second look at chat A (more turns loaded) neither moves A's marks nor touches B's.
    registerSubagentMarkOrder("chat-a", [entry("a-0"), entry("a-1", "a-2")]);
    expect(["a-1", "a-2", "a-0"].map(subagentMarkIndexFor)).toEqual([0, 1, 2]);
    expect(["b-1", "b-2", "b-3"].map(subagentMarkIndexFor)).toEqual([0, 1, 2]);
  });

  it("gives the same marks after a restart when the same part of the chat is loaded", () => {
    const log = Array.from({ length: 12 }, (_, index) => entry(`agent-${(index * 7) % 12}`));
    const first = [...subagentMarkOrderFromEntries(log)];
    resetSubagentMarkOrderForTests();
    expect([...subagentMarkOrderFromEntries(log)]).toEqual(first);
  });

  it("never gives two subagents of one chat the same mark", () => {
    const seen = new Set<string>();
    for (
      let index = 0;
      index < SUBAGENT_MARK_SHAPE_COUNT * SUBAGENT_MARK_TONES.length;
      index += 1
    ) {
      const { shape, tone } = subagentMarkAppearance(index);
      const mark = `${shape}/${tone}`;
      expect(seen.has(mark), `position ${index}`).toBe(false);
      seen.add(mark);
    }
    // The first eighteen are eighteen different outlines.
    const firstOutlines = Array.from(
      { length: 18 },
      (_, index) => subagentMarkAppearance(index).shape,
    );
    expect(new Set(firstOutlines).size).toBe(18);
  });

  it("never gives two agents in a row the same colour", () => {
    for (let index = 0; index < 200; index += 1) {
      expect(subagentMarkAppearance(index).tone).not.toBe(subagentMarkAppearance(index + 1).tone);
    }
  });

  it("keeps a stable mark for a subagent the work log has not named yet", () => {
    const index = subagentMarkIndexFor("agent-1");
    expect(subagentMarkIndexFor("agent-1")).toBe(index);
    const spread = new Set(
      Array.from({ length: 40 }, (_, item) => subagentMarkIndexFor(`agent-${item}`)),
    );
    expect(spread.size).toBeGreaterThanOrEqual(14);
  });

  it("draws every mark as light faces and folds inside the box", () => {
    expect(SUBAGENT_MARK_SHAPES).toHaveLength(18);
    for (const shape of SUBAGENT_MARK_SHAPES) {
      const roles = new Set(shape.parts.map((part) => part.role));
      expect(roles).toEqual(new Set(["face", "fold"]));
      for (const part of shape.parts) {
        for (const value of part.d.match(/-?\d+(?:\.\d+)?/g) ?? []) {
          // Control points may sit a little outside the painted edge; the box is 0..32.
          expect(Number(value)).toBeGreaterThan(-4);
          expect(Number(value)).toBeLessThan(36);
        }
      }
    }
  });
});
