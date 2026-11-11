// The machine profile: everything about this particular computer (drives, roots, tool paths).
// It lives outside the repository; its location comes from MOSS_WS_PROFILE or the default below.
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { normalize } from "./paths.ts";

export const PROFILE_ENV = "MOSS_WS_PROFILE";
export const DEFAULT_PROFILE_PATH = path.join(os.homedir(), ".moss-ws", "profile.json");

export interface Profile {
  readonly profilePath: string;
  readonly machine: string;
  /** The coordinator's checkout: git commands run here and dependencies are linked from it. Never removed. */
  readonly primaryCheckout: string;
  /** Where installed node_modules are read from by `ws new` (default: primaryCheckout). */
  readonly dependencySource: string;
  readonly githubRepo: string | undefined;
  readonly defaultBase: string;
  /** Where `ws new` creates worktrees. */
  readonly worktreeRoot: string;
  /** Older roots that `ws list` shows and `ws reap` may clean. `ws new` never uses them. */
  readonly legacyRoots: readonly string[];
  readonly scratchRoot: string;
  /** Lease registry, locks and caches. */
  readonly stateDir: string;
  /** Paths never removed, nor anything containing them. primaryCheckout and stateDir are always included. */
  readonly protectedPaths: readonly string[];
  /** Worktree names or paths that reap always keeps. */
  readonly keep: readonly string[];
  readonly disk: { readonly floorGB: number; readonly drives: readonly string[] };
  readonly ports: {
    readonly offsetFirst: number;
    readonly offsetLast: number;
    readonly offsetStep: number;
  };
  readonly lock: { readonly staleHours: number; readonly pollSeconds: number };
  readonly limits: {
    readonly leaseMaxAgeDays: number;
    readonly maxWorktrees: number;
    readonly recentHours: number;
  };
  readonly tools: {
    readonly git: string;
    readonly gh: string | undefined;
    readonly bun: string | undefined;
  };
  readonly prCacheMinutes: number;
}

export class ProfileError extends Error {}

export function profilePathFromEnv(env: NodeJS.ProcessEnv = process.env): string {
  const fromEnv = env[PROFILE_ENV]?.trim();
  return fromEnv ? path.resolve(fromEnv) : DEFAULT_PROFILE_PATH;
}

type Json = Record<string, unknown>;

function str(o: Json, key: string, required: true): string;
function str(o: Json, key: string, required?: false): string | undefined;
function str(o: Json, key: string, required = false): string | undefined {
  const v = o[key];
  if (v === undefined || v === null || v === "") {
    if (required) throw new ProfileError(`profile: "${key}" is required`);
    return undefined;
  }
  if (typeof v !== "string") throw new ProfileError(`profile: "${key}" must be a string`);
  return v;
}

function num(o: Json | undefined, key: string, fallback: number): number {
  const v = o?.[key];
  if (v === undefined) return fallback;
  if (typeof v !== "number" || !Number.isFinite(v) || v < 0) {
    throw new ProfileError(`profile: "${key}" must be a non-negative number`);
  }
  return v;
}

function strList(o: Json | undefined, key: string): string[] {
  const v = o?.[key];
  if (v === undefined) return [];
  if (!Array.isArray(v) || v.some((x) => typeof x !== "string")) {
    throw new ProfileError(`profile: "${key}" must be a list of strings`);
  }
  return v as string[];
}

function obj(o: Json, key: string): Json | undefined {
  const v = o[key];
  if (v === undefined) return undefined;
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new ProfileError(`profile: "${key}" must be an object`);
  }
  return v as Json;
}

export function parseProfile(raw: unknown, profilePath: string): Profile {
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new ProfileError("profile: top level must be an object");
  }
  const o = raw as Json;
  const base = path.dirname(profilePath);
  const abs = (p: string) => normalize(path.resolve(base, p));
  const primaryCheckout = abs(str(o, "primaryCheckout", true));
  const worktreeRoot = abs(str(o, "worktreeRoot", true));
  const stateDir = abs(str(o, "stateDir") ?? base);
  const scratchRoot = abs(
    str(o, "scratchRoot") ?? path.join(path.dirname(worktreeRoot), "moss-scratch"),
  );
  const disk = obj(o, "disk");
  const ports = obj(o, "ports");
  const lock = obj(o, "lock");
  const limits = obj(o, "limits");
  const tools = obj(o, "tools") ?? {};
  const profile: Profile = {
    profilePath,
    machine: str(o, "machine") ?? os.hostname(),
    primaryCheckout,
    dependencySource: abs(str(o, "dependencySource") ?? primaryCheckout),
    githubRepo: str(o, "githubRepo"),
    defaultBase: str(o, "defaultBase") ?? "origin/main",
    worktreeRoot,
    legacyRoots: strList(o, "legacyRoots").map(abs),
    scratchRoot,
    stateDir,
    protectedPaths: [
      ...new Set([primaryCheckout, stateDir, ...strList(o, "protectedPaths").map(abs)]),
    ],
    keep: strList(o, "keep"),
    disk: {
      floorGB: num(disk, "floorGB", 6),
      drives: strList(disk, "drives").length ? strList(disk, "drives") : [worktreeRoot],
    },
    ports: {
      offsetFirst: num(ports, "offsetFirst", 100),
      offsetLast: num(ports, "offsetLast", 990),
      offsetStep: Math.max(1, num(ports, "offsetStep", 10)),
    },
    lock: { staleHours: num(lock, "staleHours", 3), pollSeconds: num(lock, "pollSeconds", 10) },
    limits: {
      leaseMaxAgeDays: num(limits, "leaseMaxAgeDays", 7),
      maxWorktrees: num(limits, "maxWorktrees", 40),
      recentHours: num(limits, "recentHours", 4),
    },
    tools: {
      git: str(tools, "git") ?? "git",
      gh: str(tools, "gh"),
      bun: str(tools, "bun"),
    },
    prCacheMinutes: num(o, "prCacheMinutes", 10),
  };
  for (const root of [worktreeRoot, scratchRoot, ...profile.legacyRoots]) {
    if (path.parse(root).root === root)
      throw new ProfileError(`profile: a root cannot be a drive root (${root})`);
    for (const p of profile.protectedPaths) {
      if (normalize(p) === normalize(root))
        throw new ProfileError(`profile: root ${root} is also protected`);
    }
  }
  return profile;
}

export function loadProfile(env: NodeJS.ProcessEnv = process.env): Profile {
  const file = profilePathFromEnv(env);
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch {
    throw new ProfileError(
      `No machine profile at ${file}. Copy tools/ws/profile.example.json there and fill it in, ` +
        `or point ${PROFILE_ENV} at one.`,
    );
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text.replace(/^﻿/, ""));
  } catch (error) {
    throw new ProfileError(`profile ${file} is not valid JSON: ${(error as Error).message}`);
  }
  return parseProfile(raw, file);
}

/** Every root ws may act in, newest first. */
export function managedRoots(profile: Profile): string[] {
  return [profile.worktreeRoot, ...profile.legacyRoots];
}
