import { describe, expect, it } from "vitest";
import { parseDevsResolveArgs } from "./resolve";

const id = "cdb0671b-3b91-41b2-9381-a6c485146c28";
const pr = "https://github.com/Zluowa/moss-synara/pull/755";

describe("developer report resolve command", () => {
  it("builds the queue's resolution from the command line", () => {
    expect(parseDevsResolveArgs([id, "--fixed", "--pr", pr, "--note", " merged "])).toEqual({
      reportId: id,
      body: { status: "fixed", pullRequestUrl: pr, note: "merged" },
    });
    expect(parseDevsResolveArgs(["--in-progress", id])).toEqual({
      reportId: id,
      body: { status: "in-progress" },
    });
  });
  it.each([
    [[], "report ID"],
    [["not-a-uuid", "--fixed", "--pr", pr], "report ID"],
    [[id], "Choose --fixed or --in-progress"],
    [[id, "--fixed", "--in-progress", "--pr", pr], "not both"],
    [[id, "--fixed"], "--fixed needs --pr"],
    [[id, "--fixed", "--pr"], "--pr needs a value"],
    [[id, "--fixed", "--pr", "--note", "x"], "--pr needs a value"],
    [[id, "--fixed", "--pr", "https://github.com/other/repo/pull/1"], "pull request URL"],
    [[id, "--fixed", "--pr", `${pr}/files`], "pull request URL"],
    [[id, "--in-progress", "--note", "x".repeat(2_001)], "1 to 2000"],
    [[id, "--in-progress", "--force"], "Unknown option"],
    [[id, id, "--in-progress"], "Unexpected argument"],
  ])("refuses %j", (argv, problem) => {
    expect(() => parseDevsResolveArgs(argv)).toThrow(problem);
  });
});
