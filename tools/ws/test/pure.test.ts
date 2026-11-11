import { describe, expect, it } from "vitest";
import { parseArgs } from "../lib/args.ts";
import { classify, type TreeFacts } from "../lib/classify.ts";
import { matchPullRequest, type PullRequest } from "../lib/gh.ts";
import { parseWorktreeList } from "../lib/git.ts";
import { commandLineUsesPath, isStrictlyInside, samePath } from "../lib/paths.ts";
import { orphanedDevProcesses, parsePsOutput, parseWindowsProcessJson } from "../lib/proc.ts";
import { parseProfile, ProfileError } from "../lib/profile.ts";
import { pickPortOffset } from "../lib/registry.ts";

const win = process.platform === "win32";

describe("paths", () => {
  it("compares paths the way the OS does", () => {
    expect(isStrictlyInside("/a/b/c", "/a/b")).toBe(true);
    expect(isStrictlyInside("/a/b", "/a/b")).toBe(false);
    expect(isStrictlyInside("/a/bc", "/a/b")).toBe(false);
    if (win) {
      expect(samePath("C:/DevTemp/X", "c:\\devtemp\\x\\")).toBe(true);
      expect(isStrictlyInside("c:\\devtemp\\moss-wt\\a", "C:/DevTemp/moss-wt")).toBe(true);
    }
  });

  it("finds a path in a command line only at a boundary", () => {
    const dir = win ? "C:\\wt\\abc" : "/wt/abc";
    expect(commandLineUsesPath(`node ${dir}/node_modules/vitest/vitest.mjs run`, dir)).toBe(true);
    expect(commandLineUsesPath(`"bun" "${dir}"`, dir)).toBe(true);
    expect(commandLineUsesPath(`node ${dir}`, dir)).toBe(true);
    expect(commandLineUsesPath(`node ${dir}d/x.js`, dir)).toBe(false);
    if (win) expect(commandLineUsesPath("node c:/wt/ABC/x.js", dir)).toBe(true);
  });
});

describe("args", () => {
  it("parses flags, values and the rest after --", () => {
    const a = parseArgs(
      ["x", "--base", "origin/main", "--force", "--owner=me", "--", "bash", "--x"],
      ["base", "owner"],
    );
    expect(a.positionals).toEqual(["x"]);
    expect(a.flags.get("base")).toBe("origin/main");
    expect(a.flags.get("force")).toBe(true);
    expect(a.flags.get("owner")).toBe("me");
    expect(a.rest).toEqual(["bash", "--x"]);
    expect(() => parseArgs(["--base"], ["base"])).toThrow(/needs a value/);
  });
});

describe("profile", () => {
  it("fills defaults and always protects the primary checkout and state folder", () => {
    const p = parseProfile(
      { primaryCheckout: "/m/primary", worktreeRoot: "/m/wt" },
      "/home/u/.moss-ws/profile.json",
    );
    expect(p.protectedPaths.some((x) => samePath(x, "/m/primary"))).toBe(true);
    expect(p.protectedPaths.some((x) => samePath(x, "/home/u/.moss-ws"))).toBe(true);
    expect(p.disk.floorGB).toBe(6);
    expect(p.lock).toEqual({ staleHours: 3, pollSeconds: 10 });
  });

  it("rejects a drive root as a worktree root and a missing primary", () => {
    expect(() => parseProfile({ worktreeRoot: "/x" }, "/p.json")).toThrow(ProfileError);
    expect(() =>
      parseProfile({ primaryCheckout: "/m/p", worktreeRoot: win ? "C:\\" : "/" }, "/p.json"),
    ).toThrow(/drive root/);
  });
});

describe("git worktree list parsing", () => {
  it("reads main, branch and detached entries", () => {
    const list = parseWorktreeList(
      "worktree /m/main\nHEAD aaa\ndetached\n\nworktree /m/wt/a\nHEAD bbb\nbranch refs/heads/feat/a\n\nworktree /m/wt/b\nHEAD ccc\ndetached\nprunable gitdir file points to non-existent location\n",
    );
    expect(list.map((w) => [w.isMain, w.branch, w.head, w.prunable])).toEqual([
      [true, undefined, "aaa", false],
      [false, "feat/a", "bbb", false],
      [false, undefined, "ccc", true],
    ]);
  });
});

describe("processes", () => {
  it("parses Windows and ps listings and finds orphans", () => {
    const w = parseWindowsProcessJson(
      JSON.stringify([
        { ProcessId: 10, ParentProcessId: 1, Name: "node.exe", CommandLine: "node vitest run" },
        {
          ProcessId: 11,
          ParentProcessId: 999,
          Name: "node.exe",
          CommandLine: "node C:/wt/a/node_modules/vitest/vitest.mjs",
        },
        { ProcessId: 12, ParentProcessId: 998, Name: "chrome.exe", CommandLine: "chrome --vitest" },
        { ProcessId: 1, ParentProcessId: 0, Name: "init", CommandLine: null },
      ]),
    );
    expect(w).toHaveLength(4);
    expect(orphanedDevProcesses(w).map((p) => p.pid)).toEqual([11]);
    expect(
      parseWindowsProcessJson('{"ProcessId":5,"ParentProcessId":1,"Name":"a","CommandLine":"b"}'),
    ).toHaveLength(1);
    expect(parsePsOutput("  7   1 node  node /wt/x/vite.js\n")).toEqual([
      { pid: 7, ppid: 1, name: "node", commandLine: "node /wt/x/vite.js" },
    ]);
  });
});

describe("pull request matching", () => {
  const prs: PullRequest[] = [
    { number: 1, state: "CLOSED", headRefName: "feat/a", headRefOid: "old" },
    { number: 2, state: "MERGED", headRefName: "feat/a", headRefOid: "head" },
    { number: 3, state: "OPEN", headRefName: "feat/b", headRefOid: "x" },
    { number: 4, state: "MERGED", headRefName: "fix/c", headRefOid: "detached-sha" },
  ];
  it("prefers open, then the one at HEAD, then the newest; detached trees match by sha", () => {
    expect(matchPullRequest(prs, "feat/a", "head")?.number).toBe(2);
    expect(matchPullRequest(prs, "feat/b", "y")?.number).toBe(3);
    expect(matchPullRequest(prs, undefined, "detached-sha")?.number).toBe(4);
    expect(matchPullRequest(prs, "none", "nothing")).toBeUndefined();
  });
});

describe("port offsets", () => {
  it("skips offsets held by leases and ports in use", async () => {
    const reg = {
      version: 1 as const,
      leases: { a: { portOffset: 100 } as never },
    };
    const busy = new Set([3773 + 110]);
    const offset = await pickPortOffset(
      { ports: { offsetFirst: 100, offsetLast: 200, offsetStep: 10 } },
      reg,
      async (port) => !busy.has(port),
    );
    expect(offset).toBe(120);
  });
});

const pr = (state: PullRequest["state"], headRefOid = "h"): PullRequest => ({
  number: 7,
  state,
  headRefName: "b",
  headRefOid,
});

describe("reap classification", () => {
  const base: TreeFacts = {
    name: "t",
    path: "/wt/t",
    registered: false,
    protected: false,
    insideRoots: true,
    kept: false,
    containsWorktree: false,
    missing: false,
    gitOk: true,
    head: "h",
    dirty: 0,
    unpushed: 0,
    ahead: 1,
    headInBase: false,
    pr: undefined,
    prUnknown: false,
    livePids: [],
    lastActivityHours: 100,
    recentHours: 4,
  };
  const v = (f: Partial<TreeFacts>) => classify({ ...base, ...f });
  it("releases merged, closed-and-pushed, in-main and vanished trees", () => {
    expect(v({ headInBase: true, ahead: 0 })).toEqual({
      release: true,
      reason: "clean; HEAD already in origin/main",
    });
    expect(v({ pr: pr("MERGED") })).toEqual({ release: true, reason: "clean; PR #7 merged" });
    expect(v({ pr: pr("CLOSED") }).release).toBe(true);
    expect(v({ missing: true, gitOk: false }).release).toBe(true);
  });

  it("keeps everything else, with the reason", () => {
    expect(v({ protected: true, headInBase: true }).reason).toBe("protected checkout");
    expect(v({ insideRoots: false, headInBase: true }).reason).toBe("outside the configured roots");
    expect(v({ kept: true, headInBase: true }).release).toBe(false);
    expect(v({ containsWorktree: true, headInBase: true }).release).toBe(false);
    expect(v({ gitOk: false }).reason).toMatch(/git status failed/);
    expect(v({ livePids: [42], headInBase: true }).reason).toMatch(/running process .*42/);
    expect(v({ dirty: 2, headInBase: true }).reason).toBe("2 uncommitted/untracked files");
    expect(v({ pr: pr("OPEN"), headInBase: true }).reason).toBe("open PR #7");
    expect(v({ pr: pr("MERGED", "other"), ahead: 2 }).reason).toMatch(/HEAD moved after it/);
    expect(v({ pr: pr("CLOSED"), unpushed: 2 }).reason).toBe(
      "PR #7 closed unmerged, 2 commits not pushed",
    );
    expect(v({}).reason).toBe("1 commits not in origin/main and no PR");
    expect(v({ prUnknown: true }).reason).toMatch(/PR state unknown/);
    expect(v({ headInBase: true, lastActivityHours: 1 }).reason).toMatch(
      /git activity 1\.0 h ago \(< 4 h\), may be in use/,
    );
    expect(v({ headInBase: true, lastActivityHours: 1, pr: pr("MERGED") }).release).toBe(true);
  });
});
