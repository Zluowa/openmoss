import { spawnSync } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { parseProfile, type Profile } from "../lib/profile.ts";
import type { Io } from "../lib/commands.ts";

export const linkType = process.platform === "win32" ? "junction" : "dir";

export function tempDir(prefix: string): string {
  return fs.realpathSync.native(fs.mkdtempSync(path.join(os.tmpdir(), `ws-${prefix}-`)));
}

/** Cleans up a test folder. Links are removed first so the cleanup itself never follows one. */
export function cleanup(dir: string): void {
  const walk = (d: string) => {
    let entries: fs.Dirent[] = [];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      const p = path.join(d, e.name);
      if (e.isSymbolicLink()) fs.unlinkSync(p);
      else if (e.isDirectory()) walk(p);
    }
  };
  walk(dir);
  fs.rmSync(dir, { recursive: true, force: true });
}

/** A sentinel folder with one file; `alive` says whether it is intact. */
export function sentinel(at: string): { dir: string; alive: () => boolean } {
  fs.mkdirSync(at, { recursive: true });
  fs.writeFileSync(path.join(at, "keep.txt"), "must survive");
  fs.mkdirSync(path.join(at, "nested"), { recursive: true });
  fs.writeFileSync(path.join(at, "nested", "deep.txt"), "must survive");
  return {
    dir: at,
    alive: () =>
      fs.existsSync(path.join(at, "keep.txt")) &&
      fs.existsSync(path.join(at, "nested", "deep.txt")),
  };
}

export function git(cwd: string, ...args: string[]): string {
  const r = spawnSync("git", args, {
    cwd,
    encoding: "utf8",
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "ws test",
      GIT_AUTHOR_EMAIL: "ws@example.invalid",
      GIT_COMMITTER_NAME: "ws test",
      GIT_COMMITTER_EMAIL: "ws@example.invalid",
      GIT_CONFIG_NOSYSTEM: "1",
      GIT_TERMINAL_PROMPT: "0",
    },
  });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr}`);
  return r.stdout.trim();
}

export interface Machine {
  base: string;
  origin: string;
  primary: string;
  root: string;
  scratchRoot: string;
  stateDir: string;
  profile: Profile;
  profileFile: string;
}

/** A throwaway machine: bare origin, a primary clone with one commit on main, empty roots. */
export function makeMachine(overrides: Record<string, unknown> = {}): Machine {
  const base = tempDir("machine");
  const origin = path.join(base, "origin.git");
  const primary = path.join(base, "primary");
  const root = path.join(base, "wt");
  const scratchRoot = path.join(base, "scratch");
  const stateDir = path.join(base, "state");
  fs.mkdirSync(root);
  git(base, "init", "--bare", "-b", "main", origin);
  git(base, "clone", origin, primary);
  git(primary, "config", "user.name", "ws test");
  git(primary, "config", "user.email", "ws@example.invalid");
  git(primary, "config", "core.autocrlf", "false");
  fs.writeFileSync(path.join(primary, "package.json"), '{"name":"fixture"}\n');
  fs.writeFileSync(path.join(primary, ".gitignore"), "node_modules\n");
  git(primary, "add", ".");
  git(primary, "commit", "-m", "init");
  git(primary, "push", "origin", "HEAD:main");
  git(primary, "fetch", "origin");
  const raw = {
    machine: "test",
    primaryCheckout: primary,
    worktreeRoot: root,
    scratchRoot,
    stateDir,
    defaultBase: "origin/main",
    disk: { floorGB: 0, drives: [base] },
    ports: { offsetFirst: 500, offsetLast: 590, offsetStep: 10 },
    lock: { staleHours: 3, pollSeconds: 0.2 },
    ...overrides,
  };
  const profileFile = path.join(base, "profile.json");
  fs.writeFileSync(profileFile, JSON.stringify(raw, null, 2));
  return {
    base,
    origin,
    primary,
    root,
    scratchRoot,
    stateDir,
    profile: parseProfile(raw, profileFile),
    profileFile,
  };
}

export function captureIo(): Io & { lines: string[]; errors: string[]; text: () => string } {
  const lines: string[] = [];
  const errors: string[] = [];
  return {
    lines,
    errors,
    out: (l) => lines.push(l),
    err: (l) => errors.push(l),
    text: () => [...lines, ...errors].join("\n"),
  };
}
