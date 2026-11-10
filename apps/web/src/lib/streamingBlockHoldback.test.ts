import { describe, expect, it } from "vitest";

import { holdBackPartialBlockMarker } from "./streamingBlockHoldback";

describe("holdBackPartialBlockMarker", () => {
  it("holds back a last line that is only a block marker", () => {
    for (const marker of [
      "-",
      "* ",
      "1.",
      "12)",
      "- [",
      "- [ ]",
      "- [x] ",
      "##",
      "> ",
      "> -",
      "```",
      "~~",
    ]) {
      expect(holdBackPartialBlockMarker(`Intro\n${marker}`)).toBe("Intro\n");
    }
  });

  it("keeps a line once its content starts", () => {
    for (const line of ["- a", "1. Step", "## Title", "> quote", "```ts", "-1 degrees"]) {
      expect(holdBackPartialBlockMarker(`Intro\n${line}`)).toBe(`Intro\n${line}`);
    }
  });

  it("only looks at the last line", () => {
    expect(holdBackPartialBlockMarker("-\nnext")).toBe("-\nnext");
    expect(holdBackPartialBlockMarker("Done.")).toBe("Done.");
    expect(holdBackPartialBlockMarker("Text\n")).toBe("Text\n");
  });
});
