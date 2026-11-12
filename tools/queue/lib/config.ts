// FILE: tools/queue/lib/config.ts
// Purpose: The queue's machine facts, read from the `queue` section of the ws machine profile.
// Layer: tool library
// Exports: QueueConfig, RemoteConfig, parseQueueConfig, loadQueueConfig
// Why: the repository holds no machine names, users or paths; `ws` already owns the profile file.

import fs from "node:fs";
import path from "node:path";
import { normalize } from "../../ws/lib/paths.ts";
import { loadProfile, ProfileError, type Profile } from "../../ws/lib/profile.ts";

export interface RemoteConfig {
  /** ssh destination, `user@host` or a Host alias. */
  readonly ssh: string;
  readonly sshCommand: string;
  readonly sshOptions: readonly string[];
  /** The remote work folder: absolute, or relative to the remote user's home. Holds `src/`. */
  readonly workdir: string;
  /** Prepended to PATH on the remote side; a leading `~/` means the remote home. */
  readonly pathPrepend: readonly string[];
  /** Shard count per lane run there (e.g. components: 3). */
  readonly shards: Readonly<Record<string, number>>;
  readonly portBase: number;
  readonly pollSeconds: number;
  readonly timeoutMinutes: number;
}

export interface QueueConfig {
  readonly profile: Profile;
  readonly repo: string;
  readonly remoteName: string;
  readonly baseBranch: string;
  /** The checkout the queue's git work and every local lane run in. */
  readonly checkout: string;
  readonly stateDir: string;
  readonly mergeLog: string | undefined;
  /**
   * `frozen`: `bun install --frozen-lockfile` before each series of runs. `linked`: no install;
   * the checkout's dependencies are managed elsewhere (a ws worktree's links), and a commit whose
   * bun.lock differs from the linked install is refused.
   */
  readonly install: "frozen" | "linked";
  readonly browserPortBase: number;
  readonly laneTimeoutMinutes: number;
  readonly tools: {
    readonly git: string;
    readonly gh: string;
    readonly bun: string;
    readonly node: string;
  };
  readonly remote: RemoteConfig | undefined;
}

type Json = Record<string, unknown>;

function asObject(v: unknown, key: string): Json | undefined {
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v))
    throw new ProfileError(`profile: "${key}" must be an object`);
  return v as Json;
}

function asString(o: Json | undefined, key: string): string | undefined {
  const v = o?.[key];
  if (v === undefined || v === null || v === "") return undefined;
  if (typeof v !== "string") throw new ProfileError(`profile: "queue.${key}" must be a string`);
  return v;
}

function asNumber(o: Json | undefined, key: string, fallback: number): number {
  const v = o?.[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0)
    throw new ProfileError(`profile: "queue.${key}" must be a non-negative number`);
  return v;
}

function asStrings(o: Json | undefined, key: string): string[] {
  const v = o?.[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string"))
    throw new ProfileError(`profile: "queue.${key}" must be a list of strings`);
  return v as string[];
}

function parseInstall(v: string | undefined): "frozen" | "linked" {
  if (v === undefined || v === "frozen" || v === "linked") return v ?? "frozen";
  throw new ProfileError('profile: "queue.install" must be "frozen" or "linked"');
}

/** Builds the queue configuration from a parsed ws profile and the raw profile JSON. */
export function parseQueueConfig(profile: Profile, raw: unknown): QueueConfig {
  const q = asObject((raw as Json | undefined)?.queue, "queue") ?? {};
  const base = path.dirname(profile.profilePath);
  const abs = (p: string) => normalize(path.resolve(base, p));
  const repo = asString(q, "repo") ?? profile.githubRepo;
  if (!repo || !/^[\w.-]+\/[\w.-]+$/.test(repo))
    throw new ProfileError('profile: "queue.repo" (or "githubRepo") must be owner/repo');
  const checkout = asString(q, "checkout");
  if (!checkout) throw new ProfileError('profile: "queue.checkout" is required');
  const slash = profile.defaultBase.indexOf("/");
  const remoteName = slash > 0 ? profile.defaultBase.slice(0, slash) : "origin";
  const baseBranch = slash > 0 ? profile.defaultBase.slice(slash + 1) : profile.defaultBase;
  const tools = asObject(q.tools, "queue.tools");
  const r = asObject(q.remote, "queue.remote");
  let remote: RemoteConfig | undefined;
  if (r) {
    const ssh = asString(r, "ssh");
    const workdir = asString(r, "workdir");
    if (!ssh || !workdir)
      throw new ProfileError('profile: "queue.remote" needs "ssh" and "workdir"');
    if (ssh.startsWith("-")) throw new ProfileError('profile: "queue.remote.ssh" is not a host');
    const shardsRaw = asObject(r.shards, "queue.remote.shards") ?? { components: 3 };
    const shards: Record<string, number> = {};
    for (const [lane, n] of Object.entries(shardsRaw)) {
      if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > 32)
        throw new ProfileError(`profile: "queue.remote.shards.${lane}" must be 1..32`);
      shards[lane] = n;
    }
    remote = {
      ssh,
      sshCommand: asString(r, "sshCommand") ?? "ssh",
      sshOptions: r.sshOptions
        ? asStrings(r, "sshOptions")
        : [
            "-o",
            "BatchMode=yes",
            "-o",
            "ConnectTimeout=25",
            "-o",
            "ServerAliveInterval=20",
            "-o",
            "ServerAliveCountMax=6",
          ],
      workdir: workdir.replace(/^~\//, ""),
      pathPrepend: asStrings(r, "pathPrepend"),
      shards,
      portBase: asNumber(r, "portBase", 53700),
      pollSeconds: asNumber(r, "pollSeconds", 30),
      timeoutMinutes: asNumber(r, "timeoutMinutes", 90),
    };
  }
  return {
    profile,
    repo,
    remoteName,
    baseBranch,
    checkout: abs(checkout),
    stateDir: abs(asString(q, "stateDir") ?? path.join(profile.stateDir, "queue")),
    mergeLog: asString(q, "mergeLog") ? abs(asString(q, "mergeLog")!) : undefined,
    install: parseInstall(asString(q, "install")),
    browserPortBase: asNumber(q, "browserPortBase", 53660),
    laneTimeoutMinutes: asNumber(q, "laneTimeoutMinutes", 60),
    tools: {
      git: profile.tools.git,
      gh: profile.tools.gh ?? "gh",
      bun: profile.tools.bun ?? "bun",
      node: asString(tools, "node") ?? "node",
    },
    remote,
  };
}

export function loadQueueConfig(env: NodeJS.ProcessEnv = process.env): QueueConfig {
  const profile = loadProfile(env);
  const raw = JSON.parse(fs.readFileSync(profile.profilePath, "utf8").replace(/^﻿/, ""));
  return parseQueueConfig(profile, raw);
}
