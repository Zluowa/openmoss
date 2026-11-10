import { describe, expect, it } from "vitest";

import { isFenceClosedInSource } from "./markdownFence";

function check(source: string, code: string) {
  return isFenceClosedInSource(source, code, source.indexOf(code));
}

describe("isFenceClosedInSource", () => {
  it("sees a closing fence after the code", () => {
    const reply = "Intro\n\n```mermaid\nflowchart LR\n  A --> B\n```\n\nAfter";
    expect(check(reply, "flowchart LR\n  A --> B")).toBe(true);
    expect(check("```mermaid\ngraph TD\n```", "graph TD")).toBe(true);
    expect(check("~~~mermaid\ngraph TD\n~~~", "graph TD")).toBe(true);
    expect(check("> ```mermaid\n> graph TD\n> ```", "graph TD")).toBe(true);
  });

  it("treats a fence still streaming in as open", () => {
    expect(check("```mermaid\nflowchart LR\n  A --> B", "flowchart LR\n  A --> B")).toBe(false);
    expect(check("```mermaid\nA --> B\n``", "A --> B")).toBe(false);
  });

  it("needs the closer to match the opener", () => {
    // A longer opener is not closed by a shorter run, nor tildes by backticks.
    expect(check("````mermaid\nA --> B\n```", "A --> B")).toBe(false);
    expect(check("~~~mermaid\nA --> B\n```", "A --> B")).toBe(false);
    expect(check("```mermaid\nA --> B\n````", "A --> B")).toBe(true);
  });

  it("counts an unknown position or empty code as open", () => {
    expect(isFenceClosedInSource("```mermaid\nA\n```", "A", -1)).toBe(false);
    expect(isFenceClosedInSource("```mermaid\n\n```", "", 11)).toBe(false);
    expect(isFenceClosedInSource("plain text A", "A", 11)).toBe(false);
  });
});
