import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { parseArgs } from "../lib/args.ts";
import {
  cmdDoctor,
  cmdList,
  cmdNew,
  cmdReap,
  cmdRelease,
  EXIT_DISK_FLOOR,
} from "../lib/commands.ts";
import { isAlive } from "../lib/proc.ts";
import { listWorktrees } from "../lib/git.ts";
import { samePath } from "../lib/paths.ts";
import { readRegistry } from "../lib/registry.ts";
import {
  captureIo,
  cleanup,
  git,
  linkType,
  makeMachine,
  sentinel,
  type Machine,
} from "./helpers.ts";

const machines: Machine[] = [];
afterEach(() => {
  for (const m of machines.splice(0)) cleanup(m.base);
});

const args = (...a: string[]) => parseArgs(a, ["base", "branch", "owner"]);
const free = async () => true;

function machine(overrides: Record<string, unknown> = {}) {
  const m = makeMachine(overrides);
  machines.push(m);
  return m;
}

async function newTree(m: Machine, name: string, ...extra: string[]) {
  const io = captureIo();
  const code = await cmdNew(m.profile, args(name, "--owner", "tester", "--no-deps", ...extra), io, {
    isPortFree: free,
  });
  expect(io.text()).not.toMatch(/failed/);
  expect(code).toBe(0);
  return path.join(m.root, name);
}

describe("ws new", () => {
  it("creates a worktree, a lease with ports and scratch, and links dependencies", async () => {
    const m = machine();
    // Give the dependency source an install to link.
    const store = sentinel(path.join(m.base, "store", "pkg"));
    fs.mkdirSync(path.join(m.primary, "node_modules"));
    fs.symlinkSync(store.dir, path.join(m.primary, "node_modules", "pkg"), linkType);
    const io = captureIo();
    const code = await cmdNew(
      m.profile,
      args("one", "--branch", "feat/one", "--owner", "tester"),
      io,
      { isPortFree: free },
    );
    expect(code).toBe(0);
    const wt = path.join(m.root, "one");
    expect(fs.existsSync(path.join(wt, "package.json"))).toBe(true);
    expect(fs.existsSync(path.join(wt, "node_modules", "pkg", "keep.txt"))).toBe(true);
    const lease = readRegistry(m.profile).leases.one!;
    expect(lease).toMatchObject({
      name: "one",
      branch: "feat/one",
      base: "origin/main",
      owner: "tester",
      portOffset: 500,
    });
    expect(lease.ports).toEqual({ server: 3773 + 500, web: 5733 + 500 });
    expect(fs.existsSync(lease.scratch)).toBe(true);
    expect(git(wt, "rev-parse", "--abbrev-ref", "HEAD")).toBe("feat/one");

    // A second lease gets the next offset; a duplicate name is refused.
    await newTree(m, "two");
    expect(readRegistry(m.profile).leases.two!.portOffset).toBe(510);
    const dup = captureIo();
    expect(await cmdNew(m.profile, args("one"), dup, { isPortFree: free })).toBe(1);
    expect(dup.text()).toMatch(/already exists/);
  });

  it("refuses when the target drive is below the disk floor", async () => {
    const m = machine({ disk: { floorGB: 6 } });
    const io = captureIo();
    const code = await cmdNew(m.profile, args("low"), io, {
      isPortFree: free,
      measure: (p) => ({ drive: "X:", path: p, freeGB: 1.5 }),
    });
    expect(code).toBe(EXIT_DISK_FLOOR);
    expect(io.text()).toMatch(/ws new refused\. Disk floor is 6 GB; below it: X: 1\.5 GB free/);
    expect(fs.existsSync(path.join(m.root, "low"))).toBe(false);
  });

  it("refuses bad names and branches that are not <type>/<slug>", async () => {
    const m = machine();
    expect(await cmdNew(m.profile, args("../escape"), captureIo())).toBe(2);
    expect(await cmdNew(m.profile, args("ok", "--branch", "nobranchtype"), captureIo())).toBe(2);
  });
});

describe("ws release", () => {
  it("removes the worktree, its links as links, scratch and lease; the sentinel survives", async () => {
    const m = machine();
    const wt = await newTree(m, "rel");
    const outside = sentinel(path.join(m.base, "outside"));
    fs.mkdirSync(path.join(wt, "node_modules"));
    fs.symlinkSync(outside.dir, path.join(wt, "node_modules", "dep"), linkType);
    fs.symlinkSync(m.primary, path.join(wt, "node_modules", "primary-link"), linkType);

    const dry = captureIo();
    expect(await cmdRelease(m.profile, args("rel", "--dry-run"), dry)).toBe(0);
    expect(dry.text()).toMatch(/would release rel/);
    expect(dry.text()).toMatch(/remove 2 links/);
    expect(fs.existsSync(wt)).toBe(true);

    const io = captureIo();
    expect(await cmdRelease(m.profile, args("rel"), io)).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
    expect(outside.alive()).toBe(true);
    expect(fs.existsSync(path.join(m.primary, "package.json"))).toBe(true);
    expect(readRegistry(m.profile).leases.rel).toBeUndefined();
    expect(fs.existsSync(path.join(m.scratchRoot, "rel"))).toBe(false);
    expect(listWorktrees("git", m.primary).some((w) => samePath(w.path, wt))).toBe(false);
  });

  it("lists processes running inside the tree on a dry run, then stops them on release", async () => {
    const m = machine();
    const wt = await newTree(m, "busy");
    const child = spawn(
      process.execPath,
      ["-e", "setInterval(() => {}, 1000)", path.join(wt, "marker")],
      {
        stdio: "ignore",
      },
    );
    const exited = new Promise((r) => child.on("exit", r));
    try {
      await new Promise((r) => setTimeout(r, 500));
      const dry = captureIo();
      expect(await cmdRelease(m.profile, args("busy", "--dry-run"), dry)).toBe(0);
      expect(dry.text()).toMatch(new RegExp(`stop pid ${child.pid}`));
      expect(isAlive(child.pid!)).toBe(true);
      const io = captureIo();
      expect(await cmdRelease(m.profile, args("busy"), io)).toBe(0);
      await exited;
      expect(isAlive(child.pid!)).toBe(false);
      expect(fs.existsSync(wt)).toBe(false);
    } finally {
      child.kill();
    }
  });

  it("refuses uncommitted or unpushed work unless --force", async () => {
    const m = machine();
    const wt = await newTree(m, "dirty");
    fs.writeFileSync(path.join(wt, "new-file.txt"), "work");
    const io = captureIo();
    expect(await cmdRelease(m.profile, args("dirty"), io)).toBe(1);
    expect(io.text()).toMatch(/1 uncommitted\/untracked files/);
    expect(fs.existsSync(path.join(wt, "new-file.txt"))).toBe(true);

    git(wt, "add", ".");
    git(wt, "commit", "-m", "local only");
    const io2 = captureIo();
    expect(await cmdRelease(m.profile, args("dirty"), io2)).toBe(1);
    expect(io2.text()).toMatch(/1 commits not pushed/);

    expect(await cmdRelease(m.profile, args("dirty", "--force"), captureIo())).toBe(0);
    expect(fs.existsSync(wt)).toBe(false);
  });

  it("never releases the primary checkout or a worktree outside the roots", async () => {
    const m = machine();
    const io = captureIo();
    expect(await cmdRelease(m.profile, args(m.primary, "--force"), io)).toBe(1);
    expect(fs.existsSync(path.join(m.primary, "package.json"))).toBe(true);

    const elsewhere = path.join(m.base, "elsewhere-wt");
    git(m.primary, "worktree", "add", "-b", "wip/elsewhere", elsewhere, "origin/main");
    const io2 = captureIo();
    expect(await cmdRelease(m.profile, args(elsewhere, "--force"), io2)).toBe(1);
    expect(io2.text()).toMatch(/outside the configured roots/);
    expect(fs.existsSync(path.join(elsewhere, "package.json"))).toBe(true);
  });
});

describe("ws list and doctor", () => {
  it("shows leases and unregistered worktrees with size, and doctor reports what is over limits", async () => {
    const m = machine({ limits: { maxWorktrees: 1 } });
    await newTree(m, "leased");
    git(
      m.primary,
      "worktree",
      "add",
      "-b",
      "wip/handmade",
      path.join(m.root, "handmade"),
      "origin/main",
    );
    const io = captureIo();
    expect(await cmdList(m.profile, args("--json"), io)).toBe(0);
    const rows = JSON.parse(io.lines.join("\n")) as Array<Record<string, unknown>>;
    const byName = Object.fromEntries(rows.map((r) => [r.name, r]));
    expect(byName.leased).toMatchObject({
      registered: true,
      owner: "tester",
      branch: "wip/leased",
      dirty: 0,
    });
    expect(byName.handmade).toMatchObject({ registered: false, insideRoots: true });
    expect(Number(byName.handmade!.sizeBytes)).toBeGreaterThan(0);
    expect(rows.find((r) => r.main)).toBeTruthy();

    const doc = captureIo();
    expect(await cmdDoctor(m.profile, args(), doc)).toBe(1);
    expect(doc.text()).toMatch(/lock {3}heavy is free/);
    expect(doc.text()).toMatch(/1 unregistered/);
    expect(doc.text()).toMatch(/2 worktrees, over the limit of 1/);
  });
});

describe("ws reap", () => {
  it("keeps a fresh tree whose HEAD is in main (it may be about to be used)", async () => {
    const m = machine();
    await newTree(m, "fresh");
    const io = captureIo();
    expect(await cmdReap(m.profile, args("--no-size"), io)).toBe(0);
    expect(io.text()).toMatch(/KEEP\s+fresh\s+.*may be in use/);
  });

  it("dry run by default; --apply releases only clean trees whose HEAD is in origin/main", async () => {
    const m = machine({ keep: ["kept"], limits: { recentHours: 0 } });
    const merged = await newTree(m, "merged");
    const ahead = await newTree(m, "ahead");
    const kept = await newTree(m, "kept");
    const dirty = await newTree(m, "dirty");
    git(ahead, "commit", "--allow-empty", "-m", "unpushed");
    fs.writeFileSync(path.join(dirty, "x.txt"), "x");
    // An unregistered worktree under the root, created by hand.
    const manual = path.join(m.root, "manual");
    git(m.primary, "worktree", "add", "-b", "wip/manual", manual, "origin/main");

    const dry = captureIo();
    expect(await cmdReap(m.profile, args("--no-size"), dry)).toBe(0);
    const text = dry.text();
    expect(text).toMatch(/Would release 2/);
    expect(text).toMatch(/RELEASE\s+merged\s+.*HEAD already in origin\/main/);
    expect(text).toMatch(/RELEASE\s+manual/);
    expect(text).toMatch(
      /KEEP\s+ahead\s+.*1 commits not in origin\/main and no PR|KEEP\s+ahead\s+.*PR state unknown/,
    );
    expect(text).toMatch(/KEEP\s+kept\s+.*keep list/);
    expect(text).toMatch(/KEEP\s+dirty\s+.*1 uncommitted/);
    expect(fs.existsSync(merged)).toBe(true);

    const io = captureIo();
    expect(await cmdReap(m.profile, args("--apply", "--no-size"), io)).toBe(0);
    expect(fs.existsSync(merged)).toBe(false);
    expect(fs.existsSync(manual)).toBe(false);
    for (const d of [ahead, kept, dirty]) expect(fs.existsSync(d)).toBe(true);
    expect(fs.existsSync(path.join(m.primary, "package.json"))).toBe(true);
  });
});
