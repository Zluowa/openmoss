// FILE: tools/queue/test/cli.test.ts
// Purpose: The commands wired end to end: plan, status, verify --only, merge --dry-run, against a
//          temporary repository, a fake GitHub and fake lane processes.
// Layer: test

import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { main } from "../cli.ts";
import {
  cleanup,
  FakeRunner,
  fakeGitHub,
  makeRepo,
  ok,
  testConfig,
  type FakePull,
  type Repo,
} from "./helpers.ts";

let repo: Repo | undefined;
afterEach(() => {
  if (repo) cleanup(repo.root);
  repo = undefined;
});

function io() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("bun run queue", () => {
  it("plan, status, verify --only, merge --dry-run", async () => {
    repo = makeRepo();
    const pulls = new Map<number, FakePull>();
    for (const n of [11, 12]) {
      const head = repo.pr(n, { [`f${n}.txt`]: `${n}\n` });
      pulls.set(n, {
        number: n,
        title: `PR ${n}`,
        head,
        headRef: `pr-${n}`,
        baseRef: "main",
        state: "open",
        merged: false,
      });
    }
    const gh = fakeGitHub(repo, pulls);
    const runner = new FakeRunner()
      .on(gh.handler)
      .on((call) =>
        call.cmd === "bun" ? ok(call.args.includes("lint") ? "Found 0 warnings" : "") : undefined,
      );
    const config = testConfig(repo.root, { checkout: repo.work });
    const held: string[] = [];
    const deps = {
      runner,
      config,
      lock: {
        hold: async <T>(label: string, _s: string, fn: () => Promise<T>) => (
          held.push(label), fn()
        ),
      },
    };

    const plan = io();
    expect(await main(["plan", "11", "#12"], plan.io, deps)).toBe(0);
    const sha = /^candidate ([0-9a-f]{40})$/.exec(plan.out[0]!)![1]!;
    expect(plan.out.join("\n")).toMatch(/#11 head [0-9a-f]{40} -> /);
    expect(fs.existsSync(path.join(config.stateDir, sha.slice(0, 12), "candidate.json"))).toBe(
      true,
    );
    // Fetches go through gh as the credential helper; no token is ever read.
    const fetch = runner.find("git", "fetch")[0]!;
    expect(fetch.args).toContain("credential.helper=!'gh' auth git-credential");
    expect(runner.calls.some((c) => c.cmd === "gh" && c.args.includes("token"))).toBe(false);

    const status = io();
    expect(await main(["status"], status.io, deps)).toBe(0);
    expect(status.out.join("\n")).toMatch(new RegExp(`candidate ${sha.slice(0, 9)}`));

    const ver = io();
    expect(await main(["verify", "--only", "fmt,lint"], ver.io, deps)).toBe(0);
    expect(ver.out.some((l) => /^fmt\s+green/.test(l))).toBe(true);
    expect(ver.out.join("\n")).toMatch(/verdict GREEN \(partial: not every lane ran\)/);
    expect(held).toEqual(["lanes"]);
    expect(runner.find("bun", "install", "--frozen-lockfile")).toHaveLength(1);

    const dry = io();
    expect(await main(["merge", "--dry-run"], dry.io, deps)).toBe(1);
    expect(dry.out.join("\n")).toMatch(/refused: the verdict is partial/);
    expect(gh.writes).toEqual([]);
  });

  it("prints usage and refuses bad input", async () => {
    repo = makeRepo();
    const config = testConfig(repo.root, { checkout: repo.work });
    const a = io();
    expect(await main([], a.io, { config })).toBe(2);
    const b = io();
    expect(await main(["plan", "x"], b.io, { config })).toBe(2);
    const c = io();
    expect(await main(["verify"], c.io, { config })).toBe(2);
    expect(c.err[0]).toMatch(/no candidate yet/);
  });
});
