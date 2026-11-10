import { describe, expect, it } from "vitest";
import * as Y from "yjs";

import {
  applyPlateValue,
  diffPlateValue,
  mergePlateEdit,
  normalizePlateValue,
  readPageDoc,
  seedPageDoc,
} from "./pageYjsContent";

const p = (text: string, extra: Record<string, unknown> = {}) => ({
  type: "p",
  ...extra,
  children: [{ text }],
});

function seeded(value: unknown[]) {
  const doc = new Y.Doc();
  seedPageDoc(doc, value);
  return doc;
}

describe("pageYjsContent", () => {
  it("round-trips Plate JSON, including inline links and marks", () => {
    const value = [
      { type: "h1", children: [{ text: "标题" }] },
      {
        type: "p",
        children: [
          { text: "看 " },
          { type: "a", url: "https://example.com", children: [{ text: "链接" }] },
          { text: " 和", bold: true },
        ],
      },
    ];
    expect(readPageDoc(seeded(value))).toEqual(value);
  });

  it("never seeds an empty tree and ends on a paragraph once", () => {
    expect(normalizePlateValue([])).toEqual([p("")]);
    expect(normalizePlateValue([{ type: "h2", children: [] }])).toEqual([
      { type: "h2", children: [{ text: "" }] },
      p(""),
    ]);
  });

  it("diffs a typed word to a single text insertion", () => {
    expect(diffPlateValue([p("hello world")], [p("hello brave world")])).toEqual([
      { type: "insert_text", path: [0, 0], offset: 6, text: "brave " },
    ]);
  });

  it("applies a target value and reads it back", () => {
    const doc = seeded([p("one"), p("two")]);
    const target = [{ type: "h2", children: [{ text: "one!" }] }, p("two"), p("three")];
    expect(applyPlateValue(doc, target, "agent")).toBeGreaterThan(0);
    expect(readPageDoc(doc)).toEqual(target);
    expect(applyPlateValue(doc, target, "agent")).toBe(0);
  });

  it("merges a writer's edit made against an old state with live edits since", () => {
    const doc = seeded([p("alpha"), p("beta")]);
    const base = Y.encodeStateAsUpdate(doc);
    // A person keeps typing in the first block after the agent read the page.
    applyPlateValue(doc, [p("alpha one"), p("beta")], "person");
    // The agent rewrites the second block against what it read.
    mergePlateEdit({ doc, base, target: [p("alpha"), p("beta gamma")], origin: "agent" });
    expect(readPageDoc(doc)).toEqual([p("alpha one"), p("beta gamma")]);
  });

  it("converges two replicas that edit the same block concurrently", () => {
    const left = seeded([p("shared")]);
    const right = new Y.Doc();
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    applyPlateValue(left, [p("left shared")], null);
    applyPlateValue(right, [p("shared right")], null);
    Y.applyUpdate(left, Y.encodeStateAsUpdate(right));
    Y.applyUpdate(right, Y.encodeStateAsUpdate(left));
    expect(readPageDoc(left)).toEqual(readPageDoc(right));
    expect(readPageDoc(left)).toEqual([p("left shared right")]);
  });
});
