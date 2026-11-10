import { spawnSync } from "node:child_process";
import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { SSH_REMOTE_RUNTIME_PRUNER } from "./sshRemoteRuntimePruner";

const day = 24 * 60 * 60 * 1000;
const digest = (seed: string) => seed.repeat(64).slice(0, 64);
let root: string;
let scriptPath: string;

function payload(name: string, ageMs: number): string {
  const directory = Path.join(root, `payload-${digest(name)}-linux-x64-137`);
  FS.mkdirSync(Path.join(directory, "node_modules", "dep"), { recursive: true });
  FS.writeFileSync(Path.join(directory, ".dependencies-ready"), "ready\n");
  const at = new Date(Date.now() - ageMs);
  FS.utimesSync(Path.join(directory, ".dependencies-ready"), at, at);
  FS.utimesSync(directory, at, at);
  return directory;
}
function upload(name: string, ageMs: number, extension = "tar.gz"): string {
  FS.mkdirSync(Path.join(root, "uploads"), { recursive: true });
  const file = Path.join(
    root,
    "uploads",
    `${digest(name)}-11111111-1111-4111-8111-111111111111.${extension}`,
  );
  FS.writeFileSync(file, "archive");
  const at = new Date(Date.now() - ageMs);
  FS.utimesSync(file, at, at);
  return file;
}
function prune(current: string, cwds: unknown, archive?: string) {
  const result = spawnSync(process.execPath, [scriptPath], {
    encoding: "utf8",
    timeout: 20_000,
    env: {
      ...process.env,
      MOSS_SSH_RUNTIME_ROOT: root,
      MOSS_SSH_PAYLOAD_DIR: current,
      ...(archive ? { MOSS_SSH_ARCHIVE_PATH: archive } : {}),
      MOSS_SSH_PRUNER_TEST_CWDS: typeof cwds === "string" ? cwds : JSON.stringify(cwds),
    },
  });
  expect(result.error).toBeUndefined();
  expect(result.status).toBe(0);
}

beforeEach(() => {
  root = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-ssh-prune-"));
  scriptPath = Path.join(
    FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-ssh-pruner-script-")),
    "p.cjs",
  );
  FS.writeFileSync(scriptPath, SSH_REMOTE_RUNTIME_PRUNER);
});
afterEach(() => {
  FS.rmSync(root, { recursive: true, force: true });
  FS.rmSync(Path.dirname(scriptPath), { recursive: true, force: true });
});

describe("remote SSH runtime pruning", () => {
  it("removes an idle superseded runtime and keeps the current one", () => {
    const current = payload("a", 0);
    const old = payload("b", 3 * day);
    prune(current, []);
    expect(FS.existsSync(old)).toBe(false);
    expect(FS.existsSync(Path.join(current, ".dependencies-ready"))).toBe(true);
    expect(FS.existsSync(Path.join(current, ".last-used"))).toBe(true);
    expect(FS.readdirSync(root).filter((name) => name.startsWith(".trash-"))).toEqual([]);
  });

  it("keeps an old runtime that a running process still uses", () => {
    const current = payload("a", 0);
    const old = payload("b", 3 * day);
    prune(current, [old]);
    expect(FS.existsSync(Path.join(old, ".dependencies-ready"))).toBe(true);
  });

  it("keeps a runtime used within the last day, by its install or last-used marker", () => {
    const current = payload("a", 0);
    const recent = payload("b", 2 * 60 * 60 * 1000);
    const reused = payload("c", 3 * day);
    FS.writeFileSync(Path.join(reused, ".last-used"), "now\n");
    prune(current, []);
    expect(FS.existsSync(recent)).toBe(true);
    expect(FS.existsSync(reused)).toBe(true);
  });

  it("deletes no runtime when it cannot tell which directories are in use", () => {
    const current = payload("a", 0);
    const old = payload("b", 3 * day);
    prune(current, "not json");
    expect(FS.existsSync(old)).toBe(true);
  });

  it("refuses a current runtime outside the private runtime root", () => {
    const old = payload("b", 3 * day);
    prune(Path.join(OS.tmpdir(), "elsewhere"), []);
    expect(FS.existsSync(old)).toBe(true);
  });

  it("removes this connection's installed archive and only stale, unlocked other uploads", () => {
    const current = payload("a", 0);
    const own = upload("a", 0);
    const stale = upload("b", 3 * day);
    const stalePartial = upload("c", 3 * day, "partial");
    const fresh = upload("d", 60 * 1000);
    const locked = upload("e", 3 * day);
    FS.writeFileSync(
      locked.replace(/\.tar\.gz$/u, ".lock"),
      JSON.stringify({ pid: process.pid, nonce: "fixture" }),
    );
    prune(current, [], own);
    expect(FS.existsSync(own)).toBe(false);
    expect(FS.existsSync(stale)).toBe(false);
    expect(FS.existsSync(stalePartial)).toBe(false);
    expect(FS.existsSync(fresh)).toBe(true);
    expect(FS.existsSync(locked)).toBe(true);
  });
});
