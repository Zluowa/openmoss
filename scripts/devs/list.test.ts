import path from "node:path";
import { describe, expect, it } from "vitest";
import { parseDevsListArgs } from "./list";

describe("developer report list command", () => {
  it("parses status, json, and save flags", () => {
    expect(parseDevsListArgs([])).toEqual({
      status: "all",
      json: false,
      saveDir: null,
    });
    expect(parseDevsListArgs(["--status", "queued", "--json", "--save", "D:/DevTemp/out"])).toEqual(
      {
        status: "queued",
        json: true,
        saveDir: path.resolve("D:/DevTemp/out"),
      },
    );
  });

  it.each([
    [["--status"], "--status needs a value"],
    [["--status", "unknown"], 'Invalid status "unknown"'],
    [["--save"], "--save needs a value"],
    [["--unknown"], "Unknown option"],
    [["extra"], "Unexpected argument"],
  ])("refuses %j", (argv, problem) => {
    expect(() => parseDevsListArgs(argv)).toThrow(problem);
  });
});
