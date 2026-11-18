// The ws commands. Each takes the profile, parsed arguments and an output sink, and returns an exit code.
import { spawn } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { flagString, type ParsedArgs } from "./args.ts";
import { classify, type TreeFacts, type Verdict } from "./classify.ts";
import { belowFloor, floorMessage, formatGB, freeSpace, waitForFloor } from "./disk.ts";
import { diskAlert, latestDiskAlert, type DiskAlertDeps } from "./diskAlert.ts";
import { fetchPullRequests, matchPullRequest, type PullRequest } from "./gh.ts";
import { branchExists, branchTip, listWorktrees, readTreeState, type GitWorktree } from "./git.ts";
import { linkDependencies, relinkDependencies } from "./linkDeps.ts";
import {
  acquireLock,
  formatMinutes,
  HEAVY_LOCK,
  LANE_ENV,
  liveTickets,
  lockPath,
  readOwner,
  staleReason,
} from "./lock.ts";
import { isInsideOrEqual, isStrictlyInside, normalize, pathKey, samePath } from "./paths.ts";
import {
  listProcesses,
  orphanedDevProcesses,
  processesUsing,
  stopProcessTree,
  type ProcessInfo,
} from "./proc.ts";
import { managedRoots, type Profile } from "./profile.ts";
import {
  BASE_SERVER_PORT,
  BASE_WEB_PORT,
  pickPortOffset,
  readRegistry,
  updateRegistry,
  type Lease,
} from "./registry.ts";
import { createRunTemp, sweepRunTemps } from "./runTemp.ts";
import { removeTreeSafe, UnsafeTargetError, countLinks } from "./safeRemove.ts";
import { formatSize, sizeDirs } from "./size.ts";
import { mapLimit, runSync } from "./run.ts";

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

export const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

/** Exit code when the disk floor refuses work (matches the design's heavy-lock contract). */
export const EXIT_DISK_FLOOR = 9;

const NAME = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/;
const BRANCH = /^[a-z][a-z0-9-]*\/[A-Za-z0-9][A-Za-z0-9._/-]*$/;

function ownerFrom(args: ParsedArgs): string {
  return (
    flagString(args, "owner") ??
    process.env.MOSS_WS_OWNER ??
    process.env.CLAUDE_SESSION_NAME ??
    "unknown"
  );
}

// ---------------------------------------------------------------------------------------------
// Gathering facts about every worktree

export interface TreeRow {
  facts: TreeFacts;
  verdict: Verdict;
  branch: string | undefined;
  lease: Lease | undefined;
  ageDays: number | undefined;
  sizeBytes: number | undefined;
  sizePartial: boolean;
  live: ProcessInfo[];
  isMain: boolean;
}

interface GatherOptions {
  sizes?: boolean;
  allSizes?: boolean;
  sizeBudgetMs?: number | undefined;
  /** false skips per-tree git status (doctor only needs the worktree list). */
  gitState?: boolean;
  freshSizes?: boolean;
  refreshPrs?: boolean;
  only?: (wt: { path: string; name: string }) => boolean;
}

function protectedList(profile: Profile, worktrees: readonly GitWorktree[]): string[] {
  const main = worktrees.find((w) => w.isMain);
  return [...profile.protectedPaths, ...(main ? [main.path] : [])];
}

function ageDaysOf(dir: string, lease: Lease | undefined): number | undefined {
  const created = lease ? Date.parse(lease.created) : undefined;
  if (created && Number.isFinite(created)) return (Date.now() - created) / 86_400_000;
  try {
    const st = fs.statSync(path.join(dir, ".git"));
    const t = st.birthtimeMs || st.mtimeMs;
    return (Date.now() - t) / 86_400_000;
  } catch {
    return undefined;
  }
}

/** Hours since the worktree's index, HEAD or HEAD reflog changed (git's own record of use). */
export function lastActivityHours(dir: string, now = Date.now()): number | undefined {
  let gitdir: string;
  try {
    const text = fs.readFileSync(path.join(dir, ".git"), "utf8");
    const m = /^gitdir:\s*(.+)$/m.exec(text);
    if (!m) return undefined;
    gitdir = path.resolve(dir, m[1]!.trim());
  } catch {
    return undefined;
  }
  let latest = 0;
  for (const f of ["index", "HEAD", path.join("logs", "HEAD")]) {
    try {
      latest = Math.max(latest, fs.statSync(path.join(gitdir, f)).mtimeMs);
    } catch {
      // not there
    }
  }
  return latest ? (now - latest) / 3600_000 : undefined;
}

export async function gather(
  profile: Profile,
  options: GatherOptions = {},
): Promise<{
  rows: TreeRow[];
  prSource: string | undefined;
  processes: ProcessInfo[];
  worktrees: GitWorktree[];
}> {
  const git = profile.tools.git;
  const worktrees = listWorktrees(git, profile.primaryCheckout);
  const registry = readRegistry(profile);
  const leases = Object.values(registry.leases);
  const roots = managedRoots(profile);
  const prot = protectedList(profile, worktrees);

  interface Entry {
    path: string;
    name: string;
    branch: string | undefined;
    lease: Lease | undefined;
    isMain: boolean;
    missing: boolean;
  }
  const entries: Entry[] = [];
  for (const w of worktrees) {
    const lease = leases.find((l) => samePath(l.path, w.path));
    entries.push({
      path: w.path,
      name: lease?.name ?? path.basename(w.path),
      branch: w.branch,
      lease,
      isMain: w.isMain,
      missing: !fs.existsSync(w.path),
    });
  }
  for (const l of leases) {
    if (!entries.some((e) => samePath(e.path, l.path))) {
      entries.push({
        path: l.path,
        name: l.name,
        branch: l.branch,
        lease: l,
        isMain: false,
        missing: !fs.existsSync(l.path),
      });
    }
  }
  const selected = options.only ? entries.filter((e) => options.only!(e)) : entries;

  const t0 = Date.now();
  const timed = <T>(label: string, p: Promise<T>): Promise<T> =>
    process.env.WS_TIMING
      ? p.finally(() => process.stderr.write(`[ws] ${label} ${Date.now() - t0} ms\n`))
      : p;
  const prPromise = timed(
    "pull requests",
    fetchPullRequests(profile, { refresh: options.refreshPrs }),
  );
  const procPromise = timed(
    "processes",
    listProcesses().catch(() => [] as ProcessInfo[]),
  );
  // Only trees ws may act on are measured unless asked: the main checkout alone holds over a
  // million files, and other roots may sit on slow USB drives.
  const inScope = (e: Entry) =>
    options.allSizes ||
    (!e.isMain &&
      roots.some((r) => isStrictlyInside(e.path, r)) &&
      !prot.some((p) => isInsideOrEqual(e.path, p) || isStrictlyInside(p, e.path)));
  const measurable = selected.filter((e) => !e.missing && inScope(e)).map((e) => e.path);
  const sizePromise = options.sizes
    ? timed(
        `sizes (${measurable.length} trees)`,
        sizeDirs(measurable, {
          cacheFile: path.join(profile.stateDir, "size-cache.json"),
          maxAgeMs: options.freshSizes ? 0 : undefined,
          budgetMs: options.sizeBudgetMs,
        }),
      )
    : Promise.resolve(undefined);
  const states = await timed(
    `git state (${selected.length} trees)`,
    mapLimit(selected, 6, (e) =>
      e.missing || options.gitState === false
        ? Promise.resolve(undefined)
        : readTreeState(git, e.path, profile.defaultBase),
    ),
  );
  const [prResult, processes, sizes] = await Promise.all([prPromise, procPromise, sizePromise]);

  const allPaths = entries.filter((e) => !e.missing).map((e) => e.path);
  const rows: TreeRow[] = selected.map((e, i) => {
    const state = states[i];
    const live = processesUsing(processes, e.path);
    const pr: PullRequest | undefined = prResult
      ? matchPullRequest(prResult.prs, e.branch, state?.head)
      : undefined;
    const isProtected =
      e.isMain || prot.some((p) => isInsideOrEqual(e.path, p) || isStrictlyInside(p, e.path));
    const facts: TreeFacts = {
      name: e.name,
      path: e.path,
      registered: Boolean(e.lease),
      protected: isProtected,
      insideRoots: roots.some((r) => isStrictlyInside(e.path, r)),
      kept: profile.keep.some((k) => k === e.name || samePath(k, e.path)),
      containsWorktree: allPaths.some((p) => isStrictlyInside(p, e.path)),
      missing: e.missing,
      gitOk: state?.ok ?? false,
      gitError: state?.error,
      head: state?.head,
      dirty: state?.dirty ?? 0,
      unpushed: state?.unpushed ?? 0,
      ahead: state?.ahead ?? 0,
      headInBase: state?.headInBase ?? false,
      pr,
      prUnknown: !prResult,
      livePids: live.map((p) => p.pid),
      lastActivityHours: e.missing ? undefined : lastActivityHours(e.path),
      recentHours: profile.limits.recentHours,
    };
    return {
      facts,
      verdict: classify(facts),
      branch: e.branch,
      lease: e.lease,
      ageDays: e.missing ? undefined : ageDaysOf(e.path, e.lease),
      sizeBytes: sizes?.get(pathKey(e.path))?.bytes,
      sizePartial: sizes?.get(pathKey(e.path))?.partial === true,
      live,
      isMain: e.isMain,
    };
  });
  return { rows, prSource: prResult?.source, processes, worktrees };
}

function prLabel(f: TreeFacts): string {
  if (f.pr) return `#${f.pr.number} ${f.pr.state.toLowerCase()}`;
  return f.prUnknown ? "?" : "-";
}

function pad(s: string, n: number): string {
  return s.length >= n ? s : s + " ".repeat(n - s.length);
}

function table(rows: string[][]): string[] {
  const widths = rows[0]!.map((_, c) =>
    Math.min(48, Math.max(...rows.map((r) => (r[c] ?? "").length))),
  );
  return rows.map((r) =>
    r
      .map((cell, c) => (c === r.length - 1 ? cell : pad(cell, widths[c]!)))
      .join("  ")
      .trimEnd(),
  );
}

// ---------------------------------------------------------------------------------------------
// ws list

function sizeBudget(args: ParsedArgs): number | undefined {
  const v = Number(flagString(args, "size-budget"));
  return Number.isFinite(v) && v > 0 ? v * 1000 : undefined;
}

export async function cmdList(profile: Profile, args: ParsedArgs, io: Io): Promise<number> {
  const started = Date.now();
  const { rows, prSource } = await gather(profile, {
    sizes: !args.flags.has("no-size"),
    allSizes: args.flags.has("all-sizes"),
    freshSizes: args.flags.has("fresh"),
    refreshPrs: args.flags.has("fresh"),
    sizeBudgetMs: sizeBudget(args),
  });
  if (args.flags.has("json")) {
    io.out(
      JSON.stringify(
        rows.map((r) => ({
          name: r.facts.name,
          path: r.facts.path,
          registered: r.facts.registered,
          main: r.isMain,
          insideRoots: r.facts.insideRoots,
          branch: r.branch ?? null,
          head: r.facts.head ?? null,
          pr: r.facts.pr ? { number: r.facts.pr.number, state: r.facts.pr.state } : null,
          ageDays: r.ageDays === undefined ? null : Number(r.ageDays.toFixed(2)),
          sizeBytes: r.sizeBytes ?? null,
          sizePartial: r.sizePartial,
          dirty: r.facts.dirty,
          ahead: r.facts.ahead,
          unpushed: r.facts.unpushed,
          missing: r.facts.missing,
          owner: r.lease?.owner ?? null,
          ports: r.lease?.ports ?? null,
          portOffset: r.lease?.portOffset ?? null,
          scratch: r.lease?.scratch ?? null,
          livePids: r.facts.livePids,
          reap: r.verdict,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  const header = ["NAME", "LEASE", "BRANCH", "PR", "AGE", "SIZE", "DIRTY", "PORTS", "PATH"];
  const body = rows.map((r) => [
    r.facts.name,
    r.isMain ? "main" : r.lease ? r.lease.owner : r.facts.insideRoots ? "unregistered" : "outside",
    r.branch ?? "(detached)",
    prLabel(r.facts),
    r.ageDays === undefined ? "?" : `${r.ageDays.toFixed(1)}d`,
    r.facts.missing ? "gone" : formatSize(r.sizeBytes, r.sizePartial),
    r.facts.gitOk ? String(r.facts.dirty) : "?",
    r.lease ? `${r.lease.ports.server}/${r.lease.ports.web}` : "-",
    r.facts.path,
  ]);
  for (const line of table([header, ...body])) io.out(line);
  const total = rows.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
  const partial = rows.filter((r) => r.sizePartial).length;
  io.out(
    `${rows.length} worktrees: ${rows.filter((r) => r.lease).length} leased, ` +
      `${rows.filter((r) => !r.lease && !r.isMain && r.facts.insideRoots).length} unregistered in managed roots, ` +
      `${rows.filter((r) => !r.lease && !r.isMain && !r.facts.insideRoots).length} outside them (not measured). ` +
      `Measured ${formatSize(total, partial > 0)}${partial ? ` (${partial} trees not finished in the time budget, shown as >; run again to finish them)` : ""}. ` +
      `PR state from ${prSource ?? "nowhere (gh unavailable)"}. ${((Date.now() - started) / 1000).toFixed(1)} s`,
  );
  return 0;
}

// ---------------------------------------------------------------------------------------------
// ws new

function portIsFree(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once("error", () => resolve(false));
    server.listen({ port, host: "127.0.0.1" }, () => server.close(() => resolve(true)));
  });
}

type Reaper = (profile: Profile, io: Io, label: string) => Promise<number>;

/**
 * Before the disk floor refuses `ws new` or `ws lane`: release what `ws reap --apply` releases
 * (clean worktrees whose work is merged or pushed, each checked again first), so space our own
 * finished worktrees hold is freed before anyone is turned away. MOSS_WS_NO_AUTO_REAP=1 skips it.
 */
export const reapForSpace: Reaper = async (profile, io, label) => {
  if (process.env.MOSS_WS_NO_AUTO_REAP === "1") return 0;
  io.err(
    `${label}: below the disk floor; first releasing clean, merged worktrees (ws reap --apply)`,
  );
  try {
    const { rows, worktrees } = await gather(profile, { sizes: false });
    const release = rows.filter(
      (r) => !r.isMain && (r.facts.insideRoots || r.lease) && r.verdict.release,
    );
    let done = 0;
    for (const r of release) {
      if (await releaseRow(profile, r, worktrees, { force: false, dryRun: false }, io)) done += 1;
    }
    io.err(`${label}: released ${done} of ${release.length} clean, merged worktrees`);
    return done;
  } catch (error) {
    io.err(`${label}: the automatic reap failed: ${String(error)}`);
    return 0;
  }
};

export async function cmdNew(
  profile: Profile,
  args: ParsedArgs,
  io: Io,
  deps: {
    isPortFree?: (port: number) => Promise<boolean>;
    measure?: typeof freeSpace;
    alert?: DiskAlertDeps;
    reap?: Reaper;
  } = {},
): Promise<number> {
  const name = args.positionals[0];
  if (!name || !NAME.test(name)) {
    io.err(
      "usage: ws new <name> [--base origin/main] [--branch <type>/<slug>] [--owner <session>]",
    );
    io.err("name: letters, digits, '.', '_' or '-', up to 64 characters");
    return 2;
  }
  const base = flagString(args, "base") ?? profile.defaultBase;
  const branch = flagString(args, "branch") ?? `wip/${name}`;
  if (!BRANCH.test(branch)) {
    io.err(`branch must look like <type>/<slug> (for example feat/${name}); got ${branch}`);
    return 2;
  }
  const target = path.join(profile.worktreeRoot, name);
  const registry = readRegistry(profile);
  if (registry.leases[name]) {
    io.err(`a lease named ${name} already exists (${registry.leases[name]!.path})`);
    return 1;
  }
  if (fs.existsSync(target)) {
    io.err(`${target} already exists; pick another name or release it first`);
    return 1;
  }
  let low = belowFloor([profile.worktreeRoot], profile.disk.floorGB, deps.measure);
  if (low.length) {
    await (deps.reap ?? reapForSpace)(profile, io, `ws new ${name}`);
    low = belowFloor([profile.worktreeRoot], profile.disk.floorGB, deps.measure);
  }
  if (low.length) {
    io.err(`ws new refused. ${floorMessage(low, profile.disk.floorGB)}`);
    const owner = ownerFrom(args);
    for (const line of await diskAlert(
      profile,
      low,
      { command: `ws new ${name}`, owner },
      deps.alert,
    ))
      io.err(line);
    return EXIT_DISK_FLOOR;
  }
  const git = profile.tools.git;
  const exists = branchExists(git, profile.primaryCheckout, branch);
  if (exists && !args.flags.has("reuse-branch")) {
    io.err(
      `branch ${branch} already exists; pass --reuse-branch to check it out as it is, or choose another`,
    );
    return 1;
  }
  fs.mkdirSync(profile.worktreeRoot, { recursive: true });
  const add = exists
    ? runSync(
        git,
        ["-C", profile.primaryCheckout, "worktree", "add", target, branch],
        undefined,
        600_000,
      )
    : runSync(
        git,
        ["-C", profile.primaryCheckout, "worktree", "add", "-b", branch, target, base],
        undefined,
        600_000,
      );
  if (add.code !== 0) {
    io.err(`git worktree add failed: ${add.stderr.trim()}`);
    return 1;
  }
  const scratch = path.join(profile.scratchRoot, name);
  const owner = ownerFrom(args);
  const isFree = deps.isPortFree ?? portIsFree;
  const lease = await updateRegistry(profile, async (reg) => {
    const portOffset = await pickPortOffset(profile, reg, isFree);
    const l: Lease = {
      name,
      path: normalize(target),
      branch,
      base,
      owner,
      created: new Date().toISOString(),
      portOffset,
      ports: { server: BASE_SERVER_PORT + portOffset, web: BASE_WEB_PORT + portOffset },
      scratch: normalize(scratch),
    };
    reg.leases[name] = l;
    return l;
  });
  fs.mkdirSync(scratch, { recursive: true });
  if (!args.flags.has("no-deps")) {
    try {
      const report = linkDependencies(profile.dependencySource, target);
      for (const w of report.warnings) io.err(`warning: ${w}`);
      io.out(
        `linked ${report.linked} dependency entries (copied ${report.copied} files) from ${profile.dependencySource}`,
      );
    } catch (error) {
      io.err(`linking dependencies failed: ${(error as Error).message}`);
      io.err(
        `the worktree and lease exist; fix the cause, then 'ws release ${name} --force' and try again`,
      );
      return 1;
    }
  }
  io.out(`worktree ${lease.path}`);
  io.out(`branch   ${branch} (from ${exists ? "existing branch" : base})`);
  io.out(`owner    ${owner}`);
  io.out(
    `ports    MOSS_PORT_OFFSET=${lease.portOffset} (server ${lease.ports.server}, web ${lease.ports.web})`,
  );
  io.out(`scratch  ${lease.scratch}`);
  return 0;
}

// ---------------------------------------------------------------------------------------------
// ws relink

/**
 * After the lead installs or upgrades a dependency in the source checkout, an existing worktree
 * lacks its links (or points at the old version). Adds what is missing; lists links whose target
 * moved and re-points them only with --update. Never removes a real file or folder.
 */
export function cmdRelink(profile: Profile, args: ParsedArgs, io: Io): number {
  const name = args.positionals[0];
  if (!name) {
    io.err("usage: ws relink <name|path> [--update]");
    return 2;
  }
  const lease = readRegistry(profile).leases[name];
  const target = lease ? lease.path : path.resolve(name);
  if (!fs.existsSync(path.join(target, "package.json"))) {
    io.err(`${target} is not a worktree of this repository (no lease named ${name})`);
    return 1;
  }
  if (samePath(target, profile.dependencySource)) {
    io.err(`${target} is the dependency source itself; install there instead`);
    return 1;
  }
  const report = relinkDependencies(profile.dependencySource, target, {
    update: args.flags.has("update"),
  });
  for (const w of report.warnings) io.err(`warning: ${w}`);
  const list = (title: string, items: string[]) => {
    if (items.length === 0) return;
    io.out(`${title} (${items.length}):`);
    for (const item of items.slice(0, 40)) io.out(`  ${item}`);
    if (items.length > 40) io.out(`  ... ${items.length - 40} more`);
  };
  list("added", report.added);
  list("re-pointed", report.retargeted);
  const notUpdated = report.stale.filter((item) => !report.retargeted.includes(item));
  list("links to an older target (run again with --update to re-point them)", notUpdated);
  list("files that differ from the source (left as they are)", report.differingFiles);
  if (report.added.length + report.stale.length + report.differingFiles.length === 0) {
    io.out(`${target}: dependencies already match ${profile.dependencySource}`);
  }
  return 0;
}

// ---------------------------------------------------------------------------------------------
// ws release

function findTarget(rows: TreeRow[], name: string): TreeRow | undefined {
  return (
    rows.find((r) => r.lease?.name === name) ??
    rows.find((r) => samePath(r.facts.path, path.resolve(name))) ??
    rows.find((r) => r.facts.name === name && r.facts.insideRoots)
  );
}

/** Work that would be lost: uncommitted files, or commits no remote has (unless merged by sha). */
function unsavedWork(f: TreeFacts): string | undefined {
  if (f.dirty > 0) return `${f.dirty} uncommitted/untracked files`;
  const mergedBySha = f.pr?.state === "MERGED" && f.pr.headRefOid === f.head;
  if (f.unpushed > 0 && !f.headInBase && !mergedBySha) return `${f.unpushed} commits not pushed`;
  return undefined;
}

export async function releaseRow(
  profile: Profile,
  row: TreeRow,
  worktrees: readonly GitWorktree[],
  opts: { force: boolean; dryRun: boolean },
  io: Io,
): Promise<boolean> {
  const f = row.facts;
  const label = `${f.name} (${f.path})`;
  if (f.protected || row.isMain) {
    io.err(`refused ${label}: protected checkout`);
    return false;
  }
  if (!f.insideRoots) {
    io.err(`refused ${label}: outside the configured roots`);
    return false;
  }
  if (f.containsWorktree) {
    io.err(`refused ${label}: another worktree lives inside it`);
    return false;
  }
  if (!f.missing && !f.gitOk && !opts.force) {
    io.err(
      `refused ${label}: git could not read it (${f.gitError ?? "unknown"}); use --force after checking`,
    );
    return false;
  }
  const unsaved = f.missing ? undefined : unsavedWork(f);
  if (unsaved && !opts.force) {
    io.err(`refused ${label}: ${unsaved}. Commit and push, or pass --force to discard.`);
    return false;
  }
  const guard = {
    roots: managedRoots(profile),
    protectedPaths: protectedList(profile, worktrees),
    otherWorktrees: worktrees.filter((w) => !samePath(w.path, f.path)).map((w) => w.path),
  };
  const scratch = row.lease?.scratch;
  const plan: string[] = [];
  for (const p of row.live)
    plan.push(`stop pid ${p.pid} ${p.name}: ${p.commandLine.slice(0, 160)}`);
  if (!f.missing)
    plan.push(`remove ${countLinks(f.path)} links (as links), then the directory ${f.path}`);
  plan.push("git worktree prune");
  if (scratch && fs.existsSync(scratch)) plan.push(`remove scratch ${scratch}`);
  if (row.lease)
    plan.push(`free ports ${row.lease.ports.server}/${row.lease.ports.web} and the lease`);
  const branch = row.branch;
  const tip = branch ? branchTip(profile.tools.git, profile.primaryCheckout, branch) : undefined;
  const deleteBranch =
    branch !== undefined &&
    tip !== undefined &&
    f.pr?.state === "MERGED" &&
    f.pr.headRefOid === tip;
  if (deleteBranch) plan.push(`delete local branch ${branch} (PR #${f.pr!.number} merged)`);
  if (opts.dryRun) {
    io.out(`would release ${label}${unsaved ? ` [--force discards: ${unsaved}]` : ""}:`);
    for (const step of plan) io.out(`  - ${step}`);
    return true;
  }
  io.out(`releasing ${label}`);
  for (const p of row.live) {
    io.out(`  stopping pid ${p.pid} ${p.name}: ${p.commandLine.slice(0, 160)}`);
    const error = stopProcessTree(p.pid);
    if (error) io.err(`  could not stop pid ${p.pid}: ${error}`);
  }
  if (row.live.length) {
    await new Promise((r) => setTimeout(r, 1000));
    const still = processesUsing(await listProcesses(), f.path);
    if (still.length) {
      io.err(`refused ${label}: processes still running (${still.map((p) => p.pid).join(", ")})`);
      return false;
    }
  }
  if (!f.missing) {
    try {
      const report = removeTreeSafe(f.path, guard);
      io.out(`  removed ${report.links} links, ${report.files} files, ${report.dirs} folders`);
      if (report.errors.length) {
        for (const e of report.errors.slice(0, 10)) io.err(`  could not remove ${e}`);
        io.err(
          `  ${report.errors.length} items left; the lease is kept. Close what holds them and run release again.`,
        );
        return false;
      }
    } catch (error) {
      if (error instanceof UnsafeTargetError) {
        io.err(`refused ${label}: ${error.message}`);
        return false;
      }
      throw error;
    }
  }
  runSync(profile.tools.git, ["-C", profile.primaryCheckout, "worktree", "prune"]);
  if (scratch && fs.existsSync(scratch)) {
    try {
      const r = removeTreeSafe(scratch, {
        roots: [profile.scratchRoot],
        protectedPaths: guard.protectedPaths,
      });
      if (r.errors.length) io.err(`  scratch partly left (${r.errors.length} items): ${scratch}`);
    } catch (error) {
      io.err(`  scratch kept: ${(error as Error).message}`);
    }
  }
  if (row.lease) {
    await updateRegistry(profile, (reg) => {
      delete reg.leases[row.lease!.name];
    });
  }
  if (deleteBranch) {
    const r = runSync(profile.tools.git, ["-C", profile.primaryCheckout, "branch", "-D", branch!]);
    io.out(
      r.code === 0 ? `  deleted branch ${branch}` : `  kept branch ${branch}: ${r.stderr.trim()}`,
    );
  }
  io.out(`  released ${f.name}`);
  return true;
}

export async function cmdRelease(profile: Profile, args: ParsedArgs, io: Io): Promise<number> {
  const name = args.positionals[0];
  if (!name) {
    io.err("usage: ws release <name> [--force] [--dry-run]");
    return 2;
  }
  const { rows, worktrees } = await gather(profile, {
    only: (e) =>
      e.name === name || samePath(e.path, path.resolve(name)) || path.basename(e.path) === name,
  });
  const row = findTarget(rows, name);
  if (!row) {
    io.err(`no lease or worktree named ${name}`);
    return 1;
  }
  const ok = await releaseRow(
    profile,
    row,
    worktrees,
    { force: args.flags.has("force"), dryRun: args.flags.has("dry-run") },
    io,
  );
  return ok ? 0 : 1;
}

// ---------------------------------------------------------------------------------------------
// ws reap

export async function cmdReap(profile: Profile, args: ParsedArgs, io: Io): Promise<number> {
  const apply = args.flags.has("apply") && !args.flags.has("dry-run");
  const { rows, worktrees, prSource } = await gather(profile, {
    sizes: !args.flags.has("no-size"),
    refreshPrs: args.flags.has("fresh"),
    sizeBudgetMs: sizeBudget(args),
  });
  const candidates = rows.filter((r) => !r.isMain && (r.facts.insideRoots || r.lease));
  const release = candidates.filter((r) => r.verdict.release);
  const keep = candidates.filter((r) => !r.verdict.release);
  const freed = release.reduce((s, r) => s + (r.sizeBytes ?? 0), 0);
  if (args.flags.has("json") && !apply) {
    io.out(
      JSON.stringify(
        candidates.map((r) => ({
          name: r.facts.name,
          path: r.facts.path,
          sizeBytes: r.sizeBytes ?? null,
          release: r.verdict.release,
          reason: r.verdict.reason,
        })),
        null,
        2,
      ),
    );
    return 0;
  }
  io.out(
    `${apply ? "Releasing" : "Would release"} ${release.length} (${formatSize(freed)}); keeping ${keep.length}. PR state from ${prSource ?? "nowhere (gh unavailable)"}.`,
  );
  const lines = [["VERDICT", "NAME", "SIZE", "REASON", "PATH"]];
  for (const r of [...release, ...keep]) {
    lines.push([
      r.verdict.release ? "RELEASE" : "KEEP",
      r.facts.name,
      r.facts.missing ? "gone" : formatSize(r.sizeBytes, r.sizePartial),
      r.verdict.reason,
      r.facts.path,
    ]);
  }
  for (const line of table(lines)) io.out(line);
  const outside = rows.filter((r) => !r.isMain && !r.facts.insideRoots && !r.lease).length;
  if (outside)
    io.out(`${outside} worktrees outside the configured roots are not considered (see ws list).`);
  if (!apply) {
    io.out("Dry run. Pass --apply to release the RELEASE rows (each is checked again first).");
    return 0;
  }
  let failed = 0;
  for (const r of release) {
    const ok = await releaseRow(profile, r, worktrees, { force: false, dryRun: false }, io);
    if (!ok) failed += 1;
  }
  io.out(`released ${release.length - failed}, failed ${failed}`);
  return failed ? 1 : 0;
}

// ---------------------------------------------------------------------------------------------
// ws lane

export async function cmdLane(
  profile: Profile,
  args: ParsedArgs,
  io: Io,
  deps: {
    measure?: typeof freeSpace;
    sleep?: (ms: number) => Promise<void>;
    alert?: DiskAlertDeps;
    reap?: Reaper;
  } = {},
): Promise<number> {
  const lane = args.positionals[0];
  const command = args.rest;
  if (!lane || command.length === 0) {
    io.err("usage: ws lane <name> [--owner <session>] [--shell] -- <command...>");
    return 2;
  }
  const drives = [
    ...new Set([...profile.disk.drives, ...(profile.tempRoot ? [profile.tempRoot] : [])]),
  ];
  let reaped = false;
  const checkFloor = async (when: string) => {
    if (!reaped && belowFloor(drives, profile.disk.floorGB, deps.measure).length) {
      reaped = true;
      await (deps.reap ?? reapForSpace)(profile, io, `ws lane ${lane}`);
    }
    const low = await waitForFloor(drives, profile.disk.floorGB, {
      waitMs: profile.disk.waitMinutes * 60_000,
      ...(deps.measure ? { measure: deps.measure } : {}),
      log: (line) => io.err(`ws lane ${lane}: ${line}`),
      ...(deps.sleep ? { sleep: deps.sleep } : {}),
    });
    if (low.length) {
      io.err(`ws lane ${lane} refused ${when}. ${floorMessage(low, profile.disk.floorGB)}`);
      const context = { command: `ws lane ${lane}`, owner: ownerFrom(args) };
      for (const line of await diskAlert(profile, low, context, deps.alert)) io.err(line);
    }
    return low.length === 0;
  };
  if (!(await checkFloor("before queueing"))) return EXIT_DISK_FLOOR;
  const shaRun = runSync(profile.tools.git, ["rev-parse", "HEAD"], process.cwd(), 10_000);
  const sha = shaRun.code === 0 ? shaRun.stdout.trim() : "";
  const lock = await acquireLock({
    dir: path.join(profile.stateDir, "locks"),
    name: HEAVY_LOCK,
    staleMs: profile.lock.staleHours * 3600_000,
    pollMs: profile.lock.pollSeconds * 1000,
    owner: { owner: ownerFrom(args), lane, sha, command: command.join(" ").slice(0, 300) },
    log: io.err,
    priorityOwners: profile.lock.priorityOwners,
  });
  let released = false;
  const release = () => {
    if (!released) {
      released = true;
      lock.release();
    }
  };
  process.once("exit", release);
  try {
    if (!(await checkFloor("after getting the lock"))) return EXIT_DISK_FLOOR;
    io.err(`ws lane ${lane}: lock held; running ${command.join(" ")}`);
    let runTemp: ReturnType<typeof createRunTemp> | undefined;
    if (profile.tempRoot) {
      const swept = sweepRunTemps(profile.tempRoot);
      if (swept.removed.length > 0) {
        io.err(
          `ws lane ${lane}: removed ${swept.removed.length} temp folder(s) of ended runs (${formatGB(swept.bytes / 1024 ** 3)})`,
        );
      }
      runTemp = createRunTemp(profile.tempRoot, lane);
      io.err(`ws lane ${lane}: TEMP for this run is ${runTemp.dir} (removed afterwards)`);
    }
    const started = Date.now();
    const code = await new Promise<number>((resolve) => {
      const child = spawn(command[0]!, command.slice(1), {
        // `bun run check` inside a lane must not wait for the lane it runs in.
        env: { ...process.env, ...runTemp?.env, [LANE_ENV]: lane },
        stdio: "inherit",
        shell: args.flags.has("shell"),
        windowsHide: false,
      });
      if (child.pid) lock.setChildPid(child.pid);
      // Tell the holder when the lane has been held a long time and who is waiting for it.
      const queueDir = `${lockPath(path.join(profile.stateDir, "locks"), HEAVY_LOCK)}.queue`;
      const warnAfter = profile.lock.warnMinutes * 60_000;
      let nextWarning = warnAfter;
      const warner = setInterval(
        () => {
          const held = Date.now() - started;
          if (held < nextWarning) return;
          nextWarning += 10 * 60_000;
          const waiting = liveTickets(queueDir, profile.lock.priorityOwners);
          const priority = waiting.filter((ticket) => ticket.priority);
          io.err(
            `ws lane ${lane}: you have held the heavy lane for ${formatMinutes(held)}; ` +
              (waiting.length === 0
                ? "nobody is waiting"
                : `${waiting.length} waiting` +
                  (priority.length
                    ? `, including ${priority.map((t) => t.owner).join(", ")} (priority): finish or split the run at the next step`
                    : "")),
          );
        },
        Math.min(30_000, Math.max(100, warnAfter / 4)),
      );
      warner.unref();
      child.on("exit", () => clearInterval(warner));
      const forward = (signal: NodeJS.Signals) => () => child.kill(signal);
      const onInt = forward("SIGINT");
      const onTerm = forward("SIGTERM");
      process.on("SIGINT", onInt);
      process.on("SIGTERM", onTerm);
      child.on("error", (error) => {
        io.err(`ws lane ${lane}: could not start ${command[0]}: ${error.message}`);
        resolve(127);
      });
      child.on("exit", (c, signal) => {
        process.off("SIGINT", onInt);
        process.off("SIGTERM", onTerm);
        resolve(c ?? (signal ? 128 + (os.constants.signals[signal] ?? 1) : 1));
      });
    });
    io.err(`ws lane ${lane}: exit ${code} after ${((Date.now() - started) / 1000).toFixed(1)} s`);
    if (runTemp) {
      const left = runTemp.finish();
      io.err(
        `ws lane ${lane}: the run left ${formatGB(left.bytes / 1024 ** 3)} in its temp folder` +
          (left.errors.length
            ? `; ${left.errors.length} item(s) could not be removed (in use), first: ${left.errors[0]}`
            : "; removed"),
      );
    }
    return code;
  } finally {
    release();
    process.off("exit", release);
  }
}

// ---------------------------------------------------------------------------------------------
// ws doctor

export async function cmdDoctor(profile: Profile, args: ParsedArgs, io: Io): Promise<number> {
  const problems: string[] = [];
  io.out(`machine ${profile.machine}; profile ${profile.profilePath}`);
  const drives = [...new Set([...profile.disk.drives, profile.worktreeRoot, profile.scratchRoot])];
  const seen = new Set<string>();
  for (const d of drives) {
    const s = freeSpace(fs.existsSync(d) ? d : path.dirname(d));
    if (seen.has(s.drive)) continue;
    seen.add(s.drive);
    const low = s.freeGB === undefined || s.freeGB < profile.disk.floorGB;
    io.out(
      `disk   ${s.drive} ${formatGB(s.freeGB)} free${low ? `  BELOW FLOOR ${profile.disk.floorGB} GB` : ""}`,
    );
    if (low) problems.push(`${s.drive} below the disk floor`);
  }
  const alert = latestDiskAlert(profile);
  if (alert) {
    io.out(
      `disk   last floor refusal ${alert.at}: ${alert.command} (${alert.owner}); largest: ` +
        (alert.largest
          .slice(0, 3)
          .map((e) => `${e.path} ${(e.bytes / 1024 ** 3).toFixed(1)} GB`)
          .join(", ") || "none measured"),
    );
  }
  io.out(
    `memory ${(os.freemem() / 1024 ** 3).toFixed(1)} GB free of ${(os.totalmem() / 1024 ** 3).toFixed(1)} GB`,
  );

  const lockDir = lockPath(path.join(profile.stateDir, "locks"), HEAVY_LOCK);
  if (fs.existsSync(lockDir)) {
    const owner = readOwner(lockDir);
    const stale = staleReason(lockDir, profile.lock.staleHours * 3600_000);
    io.out(
      `lock   heavy held by ${owner?.owner ?? "?"} (${owner?.lane ?? "?"}, pid ${owner?.pid ?? "?"}, since ${owner?.started ?? "?"})` +
        (stale ? `  STALE: ${stale}` : ""),
    );
    if (stale) problems.push("heavy lock is stale");
  } else io.out("lock   heavy is free");
  let waiting = 0;
  try {
    waiting = fs.readdirSync(`${lockDir}.queue`).filter((n) => n.endsWith(".json")).length;
  } catch {
    // no queue
  }
  if (waiting) io.out(`queue  ${waiting} waiting`);

  const { rows, processes } = await gather(profile, { sizes: false, gitState: false });
  const orphans = orphanedDevProcesses(processes);
  io.out(
    `orphaned dev/test processes: ${orphans.length}${orphans.length ? " (list only; nothing stopped)" : ""}`,
  );
  for (const p of orphans.slice(0, 30))
    io.out(`  pid ${p.pid} ${p.name}: ${p.commandLine.slice(0, 160)}`);
  if (orphans.length) problems.push(`${orphans.length} orphaned dev/test processes`);

  const managed = rows.filter((r) => !r.isMain && r.facts.insideRoots);
  const unregistered = managed.filter((r) => !r.lease);
  io.out(
    `worktrees: ${rows.length} known to git, ${managed.length} in managed roots, ${unregistered.length} unregistered`,
  );
  if (unregistered.length) {
    io.out(
      `  unregistered: ${unregistered
        .slice(0, 40)
        .map((r) => r.facts.name)
        .join(", ")}${unregistered.length > 40 ? ", ..." : ""}`,
    );
    problems.push(`${unregistered.length} unregistered worktrees`);
  }
  if (managed.length > profile.limits.maxWorktrees) {
    problems.push(`${managed.length} worktrees, over the limit of ${profile.limits.maxWorktrees}`);
  }
  const old = rows.filter((r) => r.lease && (r.ageDays ?? 0) > profile.limits.leaseMaxAgeDays);
  for (const r of old)
    io.out(
      `  lease ${r.facts.name} is ${r.ageDays!.toFixed(1)} days old (limit ${profile.limits.leaseMaxAgeDays})`,
    );
  if (old.length) problems.push(`${old.length} leases over the age limit`);
  const gone = rows.filter((r) => r.facts.missing);
  if (gone.length)
    problems.push(`${gone.length} worktree records whose folder is gone (ws reap prunes them)`);

  io.out(problems.length ? `over limits: ${problems.join("; ")}` : "everything within limits");
  return problems.length && !args.flags.has("no-fail") ? 1 : 0;
}
