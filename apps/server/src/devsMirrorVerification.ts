import * as fs from "node:fs/promises";
import path from "node:path";
import { DevsHandoffError } from "./devsHandoff";
import type { RepairCommand } from "./devsRepairRunner";
import type { DevsFetch } from "./devsReports";
import { githubTransport, trustedGitArgs, trustedGitEnvironment } from "./devsTrustedGit";

const MINUTE = 60_000;

/** Where repairs are verified: the public mirror's CI, which runs on pushes to `ci/**`. */
export interface MirrorCiConfig {
  /**
   * The worker's checkout: its object store receives the repair commit, and the export tool
   * runs from a worktree of it at the repair's base, so the tool and its icon table match
   * the source they export (main, never the repair's own version of the tool).
   */
  toolRoot: string;
  /** The worker's own clone of the public mirror; `<clone>.push-lock` serialises its use. */
  clone: string;
  /** The public mirror, for example `Zluowa/openmoss`. */
  repository: string;
}

export interface ChangedPath {
  name: string;
  deleted: boolean;
}

/** Parses `git diff --name-status --no-renames -z`. */
export function parseNameStatus(output: string): ChangedPath[] {
  const fields = output.split("\0");
  const changed: ChangedPath[] = [];
  for (let index = 0; index + 1 < fields.length; index += 2) {
    const status = fields[index]!;
    if (!status) break;
    changed.push({ name: fields[index + 1]!, deleted: status.startsWith("D") });
  }
  return changed;
}

/** The trusted Git settings as environment configuration, for a tool that runs Git itself. */
function gitConfigEnvironment(): NodeJS.ProcessEnv {
  const args = trustedGitArgs();
  const environment: NodeJS.ProcessEnv = {};
  let count = 0;
  for (let index = 0; index + 1 < args.length; index += 2) {
    const setting = args[index + 1]!;
    const split = setting.indexOf("=");
    environment[`GIT_CONFIG_KEY_${count}`] = setting.slice(0, split);
    environment[`GIT_CONFIG_VALUE_${count}`] = setting.slice(split + 1);
    count++;
  }
  environment.GIT_CONFIG_COUNT = String(count);
  return environment;
}

/**
 * The export tool's environment: no credential at all (it only reads the public mirror),
 * Git hardened as for every controller command, and on Windows the system `tar` ahead of
 * any other, which the export needs to unpack into a drive path. The tool's worktree has no
 * packages of its own; it resolves them from the worker checkout's isolated install.
 */
function exportEnvironment(toolRoot: string): NodeJS.ProcessEnv {
  const environment: NodeJS.ProcessEnv = {
    ...trustedGitEnvironment(),
    ...gitConfigEnvironment(),
    NODE_PATH: path.join(toolRoot, "node_modules", ".bun", "node_modules"),
  };
  if (process.platform === "win32") {
    const key = Object.keys(environment).find((name) => name.toUpperCase() === "PATH") ?? "PATH";
    const system = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32");
    environment[key] = `${system};${environment[key] ?? ""}`;
  }
  return environment;
}

/** Paths named by the export guard's violation lines (`  rule  path[:line][#part]  [digest x]`). */
export function guardViolationPaths(output: string): string[] {
  const start = output.search(/\d+ guard violation/);
  if (start < 0) return [];
  return output
    .slice(start)
    .split(/\r?\n/)
    .slice(1)
    .map((line) => /^\s+\S+\s+(\S+)/.exec(line)?.[1])
    .filter((entry): entry is string => Boolean(entry))
    .map((entry) => entry.replace(/#.*$/, "").replace(/:\d+$/, ""));
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM";
  }
}

/** The same lock directory the maintainers' mirror scripts use, broken only when its holder has ended. */
async function acquireLock(
  lock: string,
  what: string,
  options: { waitMs: number; now: () => number; delay: (ms: number) => Promise<void> },
): Promise<() => Promise<void>> {
  const deadline = options.now() + options.waitMs;
  for (;;) {
    try {
      await fs.mkdir(lock);
      await fs.writeFile(path.join(lock, "pid"), String(process.pid));
      await fs.writeFile(path.join(lock, "what"), what);
      return () => fs.rm(lock, { recursive: true, force: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
    }
    const holder = Number(
      (await fs.readFile(path.join(lock, "pid"), "utf8").catch(() => "")).trim(),
    );
    if (Number.isSafeInteger(holder) && holder > 0 && !processAlive(holder)) {
      await fs.rm(lock, { recursive: true, force: true });
      continue;
    }
    if (options.now() >= deadline)
      throw new DevsHandoffError(
        "Cannot verify on the public mirror: its clone stayed locked by another push.",
      );
    await options.delay(10_000);
  }
}

/** Changed paths whose bytes the mirror would not test as the repair wrote them. */
async function unpublishedChanges(options: {
  changed: readonly ChangedPath[];
  outDir: string;
  jobDir: string;
  clone: string;
  run: RepairCommand;
}): Promise<string[]> {
  const missing: string[] = [];
  for (const change of options.changed) {
    const exported = path.resolve(options.outDir, change.name);
    if (!exported.startsWith(path.resolve(options.outDir) + path.sep)) {
      missing.push(change.name);
      continue;
    }
    const published = await fs.readFile(exported).catch(() => null);
    if (!change.deleted) {
      const written = await fs.readFile(path.join(options.jobDir, change.name));
      if (!published || !published.equals(written)) missing.push(change.name);
      continue;
    }
    // A deletion is tested only when the mirror has the file now and the snapshot drops it.
    const onMirror = await options
      .run("git", [...trustedGitArgs(), "cat-file", "-e", `origin/main:${change.name}`], {
        cwd: options.clone,
        env: trustedGitEnvironment(),
        timeoutMs: 30_000,
      })
      .then(
        () => true,
        () => false,
      );
    if (published || !onMirror) missing.push(change.name);
  }
  return missing;
}

/**
 * Verifies a repair commit on the public mirror's CI, the way maintainers test unmerged
 * commits there: the trusted export tool takes a guarded snapshot of the commit into the
 * worker's mirror clone, the worker pushes it to `ci/<name>`, and the conclusion of the
 * mirror's `CI` run is the result.
 *
 * - A snapshot the guard refuses fails the repair: it would publish something forbidden.
 * - A failed run fails the repair.
 * - A change the mirror does not publish, or checks that could not run or finish, is a
 *   {@link DevsHandoffError}: the repair is unverified, not wrong.
 */
export async function verifyRepairOnMirror(options: {
  mirror: MirrorCiConfig;
  githubToken: string;
  reportId: string;
  sourceSha: string;
  /** The repair's parent, a commit of main: the export tool runs at this revision. */
  baseSha: string;
  jobDir: string;
  changed: readonly ChangedPath[];
  run: RepairCommand;
  fetcher?: DevsFetch;
  /** Longest wait for the run to finish, from the push. */
  timeoutMs?: number;
  /** Longest wait for the run to appear after the push. */
  startTimeoutMs?: number;
  pollMs?: number;
  now?: () => number;
  delay?: (ms: number) => Promise<void>;
}): Promise<{ runUrl: string; snapshot: string }> {
  const { mirror, run } = options;
  const fetcher = options.fetcher ?? fetch;
  const now = options.now ?? Date.now;
  const delay =
    options.delay ?? ((ms: number) => new Promise((resolve) => setTimeout(resolve, ms)));
  const details = { commit: options.sourceSha, jobDir: options.jobDir };
  const name =
    `devs-${options.reportId.slice(0, 8)}-${options.sourceSha.slice(0, 9)}`.toLowerCase();
  const branch = `ci/${name}`;
  const toolDir = path.join(mirror.toolRoot, ".tmp", "devs-export-tool");
  const outDir = path.join(toolDir, ".tmp", "devs-mirror-export");
  const git = (cwd: string, args: readonly string[], timeoutMs = 5 * MINUTE) =>
    run("git", [...trustedGitArgs(), ...args], { cwd, env: trustedGitEnvironment(), timeoutMs });
  const transport = githubTransport(mirror.repository, options.githubToken);
  const release = await acquireLock(`${mirror.clone}.push-lock`, `devs ${name}`, {
    waitMs: 30 * MINUTE,
    now,
    delay,
  });
  let snapshot: string;
  try {
    // The export reads the commit from the trusted checkout's object store.
    await run(
      "git",
      [
        ...trustedGitArgs(),
        "fetch",
        "--no-tags",
        "--quiet",
        options.jobDir,
        `refs/heads/devs/${options.reportId}`,
      ],
      { cwd: mirror.toolRoot, env: trustedGitEnvironment(), timeoutMs: 5 * MINUTE },
    );
    const fetched = (
      await run("git", [...trustedGitArgs(), "rev-parse", "FETCH_HEAD"], {
        cwd: mirror.toolRoot,
        env: trustedGitEnvironment(),
        timeoutMs: 30_000,
      })
    ).trim();
    if (fetched !== options.sourceSha)
      throw new Error("The repair commit changed before verification; nothing was published.");
    if (
      (await git(mirror.toolRoot, ["rev-parse", `${options.sourceSha}~1`])).trim() !==
      options.baseSha
    )
      throw new Error("The repair commit does not sit on its base; nothing was published.");
    // The export tool at the base revision, in a worktree the worker reuses between jobs.
    const modules = path.join(toolDir, "node_modules");
    const reuse = await fs
      .stat(path.join(toolDir, ".git"))
      .then(() => true)
      .catch(() => false);
    if (reuse) {
      await git(toolDir, ["checkout", "--quiet", "--detach", "--force", options.baseSha]);
      await git(toolDir, ["clean", "--quiet", "-d", "--force"]);
    } else {
      // The package link goes first, so removing the folder can never reach the packages.
      await fs.unlink(modules).catch(() => {});
      await fs.rm(toolDir, { recursive: true, force: true });
      await git(mirror.toolRoot, ["worktree", "prune"]);
      await git(mirror.toolRoot, [
        "worktree",
        "add",
        "--quiet",
        "--detach",
        "--force",
        toolDir,
        options.baseSha,
      ]);
    }
    // The tool runs the checkout's formatter from its own node_modules: link the worker's.
    if (
      !(await fs.readlink(modules).then(
        () => true,
        () => false,
      ))
    )
      await fs.symlink(path.join(mirror.toolRoot, "node_modules"), modules, "junction");
    if ((await git(toolDir, ["rev-parse", "HEAD"])).trim() !== options.baseSha)
      throw new DevsHandoffError(
        "Cannot verify on the public mirror: its export tool is not at the repair's base.",
        details,
      );
    let output: string;
    try {
      // Without --push the tool commits the guarded snapshot and leaves the clone as it was.
      output = await run(
        process.execPath,
        [
          path.join(toolDir, "scripts", "public-mirror", "cli.ts"),
          "ci",
          "--target",
          mirror.clone,
          "--ref",
          options.sourceSha,
          "--name",
          name,
          "--out",
          outDir,
        ],
        { cwd: toolDir, env: exportEnvironment(mirror.toolRoot), timeoutMs: 20 * MINUTE },
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : "";
      const refused = guardViolationPaths(message);
      const violations = message.slice(Math.max(0, message.search(/\d+ guard violation/)));
      const changedNames = new Set(options.changed.map((change) => change.name));
      // The repair is at fault only for files it changed; anything else is the base's or the tool's.
      if (refused.some((name) => changedNames.has(name)))
        throw new Error(
          `The fix would publish something the public mirror forbids; nothing was published. ${violations}`,
          { cause: error },
        );
      if (/guard violation/.test(message))
        throw new DevsHandoffError(
          `Cannot verify on the public mirror: its export guard refused files the repair did not change. ${violations.slice(0, 600)}`,
          details,
        );
      throw new DevsHandoffError(
        `Cannot verify on the public mirror: its export failed (${message.slice(0, 600)}).`,
        details,
      );
    }
    if (/nothing to test/.test(output))
      throw new DevsHandoffError(
        "Cannot verify on the public mirror: none of the change is published there.",
        details,
      );
    const committed = /^committed ([0-9a-f]{40}); not pushed/m.exec(output)?.[1];
    if (!committed)
      throw new DevsHandoffError(
        "Cannot verify on the public mirror: its export produced no snapshot.",
        details,
      );
    snapshot = committed;
    const missing = await unpublishedChanges({
      changed: options.changed,
      outDir,
      jobDir: options.jobDir,
      clone: mirror.clone,
      run,
    });
    if (missing.length)
      throw new DevsHandoffError(
        `Cannot verify on the public mirror: it does not publish ${missing.slice(0, 10).join(", ")}${missing.length > 10 ? ` and ${missing.length - 10} more` : ""}.`,
        details,
      );
    try {
      await run(
        "git",
        [
          ...transport.args,
          "push",
          "--quiet",
          "--force",
          transport.url,
          `${snapshot}:refs/heads/${branch}`,
        ],
        {
          cwd: mirror.clone,
          env: transport.env,
          timeoutMs: 15 * MINUTE,
          secrets: [options.githubToken],
        },
      );
    } catch (error) {
      throw new DevsHandoffError(
        `Cannot verify on the public mirror: the snapshot push failed (${(error as Error).message.slice(0, 300)}).`,
        details,
      );
    }
  } finally {
    await release();
  }
  const pushedAt = now();
  const deadline = pushedAt + (options.timeoutMs ?? 60 * MINUTE);
  const startDeadline = pushedAt + (options.startTimeoutMs ?? 10 * MINUTE);
  const api = `https://api.github.com/repos/${mirror.repository}/actions/runs?branch=${encodeURIComponent(branch)}&event=push&head_sha=${snapshot}&per_page=20`;
  let runUrl = "";
  for (;;) {
    let found: { status: string; conclusion: string | null; html_url: string } | undefined;
    try {
      const response = await fetcher(api, {
        redirect: "error",
        signal: AbortSignal.timeout(30_000),
        headers: {
          authorization: `Bearer ${options.githubToken}`,
          accept: "application/vnd.github+json",
        },
      });
      if (response.ok) {
        const body = (await response.json()) as {
          workflow_runs?: Array<{
            name?: string;
            head_sha?: string;
            status?: string;
            conclusion?: string | null;
            html_url?: string;
          }>;
        };
        const runs = (body.workflow_runs ?? []).filter(
          (entry) => entry.name === "CI" && entry.head_sha === snapshot,
        );
        if (runs.length > 1)
          throw new DevsHandoffError(
            "Cannot verify on the public mirror: more than one CI run for the snapshot.",
            details,
          );
        if (runs[0])
          found = {
            status: String(runs[0].status),
            conclusion: runs[0].conclusion ?? null,
            html_url: String(runs[0].html_url ?? ""),
          };
      } else await response.body?.cancel();
    } catch (error) {
      if (error instanceof DevsHandoffError) throw error;
      // A failed poll is retried until the deadline.
    }
    if (found) {
      runUrl = found.html_url;
      if (found.status === "completed") {
        if (found.conclusion === "success") return { runUrl, snapshot };
        if (found.conclusion === "failure")
          throw new Error(
            `The repair failed the public mirror's checks (${runUrl}); no PR was created.`,
          );
        throw new DevsHandoffError(
          `Cannot verify on the public mirror: its CI run ended ${found.conclusion ?? "without a result"} (${runUrl}).`,
          { ...details, runUrl },
        );
      }
    }
    const time = now();
    if (!found && time >= startDeadline)
      throw new DevsHandoffError(
        `Cannot verify on the public mirror: no CI run started for ${branch}.`,
        details,
      );
    if (time >= deadline)
      throw new DevsHandoffError(
        `Cannot verify on the public mirror: its CI run did not finish in time (${runUrl}).`,
        { ...details, runUrl },
      );
    await delay(options.pollMs ?? 20_000);
  }
}
