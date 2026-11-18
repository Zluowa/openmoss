import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import { COMMIT_PATTERN, runCodeUpdatePipeline, workTreeRefusal } from "../lib/codeUpdate.ts";
import { acceptanceEnvironment, INHERITED_NAMES, launchMoss } from "../lib/launch.ts";
import { assertInside, removeInside, UnsafePathError } from "../lib/safePath.ts";
import { runIdsForFixture } from "../lib/window.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});
function tempDir(): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), "accept-safety-"));
  dirs.push(d);
  return d;
}
const git = (cwd: string, ...args: string[]) =>
  spawnSync("git", ["-C", cwd, ...args], { encoding: "utf8" });

describe("the test copy's environment", () => {
  it("inherits only the OS basics, never a session's credentials or proxies", () => {
    // Names and values built from parts, so no secret-shaped literal sits in the source.
    const planted: Record<string, string> = {};
    for (const name of [
      ["ANTHROPIC", "API", "KEY"],
      ["OPENAI", "API", "KEY"],
      ["CLAUDE", "CODE", "OAUTH", "TOKEN"],
      ["GH", "TOKEN"],
      ["GITHUB", "TOKEN"],
      ["HTTPS", "PROXY"],
      ["MOSS", "AUTH", "TOKEN"],
    ])
      planted[name.join("_")] = ["planted", "value"].join("-");
    const inherited = {
      ...planted,
      SystemRoot: "C:/Windows",
      PATH: "C:/owner/tools;C:/Windows",
      PATHEXT: ".EXE",
    };
    const env = acceptanceEnvironment(path.join(tempDir(), "profile"), inherited);
    for (const name of Object.keys(planted)) expect(env[name], name).toBeUndefined();
    expect(Object.values(env)).not.toContain("planted-value");
    expect(env.SystemRoot).toBe("C:/Windows");
    expect(env.PATH).not.toContain("owner");
    expect(INHERITED_NAMES).not.toContain("PATH");
  });
});

describe("on-screen runs", () => {
  it("are refused unless the lead set MOSS_ACCEPT_ON_SCREEN=owner-approved", async () => {
    const before = process.env.MOSS_ACCEPT_ON_SCREEN;
    delete process.env.MOSS_ACCEPT_ON_SCREEN;
    try {
      await expect(
        launchMoss({ app: process.execPath, runDir: tempDir(), onScreen: true }),
      ).rejects.toThrow(/MOSS_ACCEPT_ON_SCREEN=owner-approved/);
    } finally {
      if (before !== undefined) process.env.MOSS_ACCEPT_ON_SCREEN = before;
    }
  });
});

describe("code-update guards", () => {
  it("takes only a hex commit id, before anything runs", async () => {
    expect(COMMIT_PATTERN.test("38e4428e1")).toBe(true);
    for (const bad of ["main", "abc; rm -rf /", "38e4428e1 && calc", "12345"])
      expect(COMMIT_PATTERN.test(bad), bad).toBe(false);
    await expect(
      runCodeUpdatePipeline({
        commit: "x & calc",
        shellApp: tempDir(),
        workTree: tempDir(),
        dependencySource: tempDir(),
        outDir: tempDir(),
        cacheDir: tempDir(),
      }),
    ).rejects.toThrow(/7-40 hex digits/);
  });

  it("never checks out the dependency source, the shared checkout or a repository's main worktree", () => {
    const repo = tempDir();
    expect(git(repo, "init", "-q").status).toBe(0);
    git(
      repo,
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.invalid",
      "commit",
      "-q",
      "--allow-empty",
      "-m",
      "x",
    );
    const linked = path.join(tempDir(), "linked");
    expect(git(repo, "worktree", "add", "-q", "--detach", linked).status).toBe(0);
    expect(workTreeRefusal(repo, tempDir())).toMatch(/main worktree/);
    expect(workTreeRefusal(linked, linked)).toMatch(/dependency source/);
    expect(workTreeRefusal(linked, tempDir(), linked)).toMatch(/shared checkout/);
    expect(workTreeRefusal(linked, tempDir())).toBeUndefined();
  });

  it("removes and writes only inside the run folder, never through a link", () => {
    const out = tempDir();
    const outside = tempDir();
    fs.writeFileSync(path.join(outside, "keep.txt"), "owner's");
    expect(() => assertInside(out, outside)).toThrow(UnsafePathError);
    expect(() => assertInside(out, out)).toThrow(UnsafePathError);
    const link = path.join(out, "app");
    fs.symlinkSync(outside, link, "junction");
    expect(() => removeInside(out, link)).toThrow(/is a link/);
    expect(() => removeInside(out, path.join(link, "keep.txt"))).toThrow(/is a link/);
    expect(fs.readFileSync(path.join(outside, "keep.txt"), "utf8")).toBe("owner's");
    fs.mkdirSync(path.join(out, "real"));
    removeInside(out, path.join(out, "real"));
    expect(fs.existsSync(path.join(out, "real"))).toBe(false);
  });
});

describe.runIf(process.platform === "win32")("the window mover's process walk", () => {
  it("never adopts an older process that names the run's PID as its parent", () => {
    const at = (s: number) => new Date(Date.UTC(2026, 10, 18, 12, 0, s)).toISOString();
    const ids = runIdsForFixture(
      100,
      [
        { ProcessId: 100, ParentProcessId: 1, CreationDate: at(10) },
        { ProcessId: 101, ParentProcessId: 100, CreationDate: at(11) },
        { ProcessId: 102, ParentProcessId: 101, CreationDate: at(12) },
        // The owner's program, started before the run, whose parent's PID was reused by the run.
        { ProcessId: 200, ParentProcessId: 100, CreationDate: at(1) },
        { ProcessId: 201, ParentProcessId: 200, CreationDate: at(20) },
      ],
      tempDir(),
    );
    expect(ids.toSorted((a, b) => a - b)).toEqual([100, 101, 102]);
  }, 60_000);
});
