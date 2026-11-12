// FILE: tools/queue/cli.ts
// Purpose: `bun run queue <plan|verify|merge|status>`: the coordinator's merge queue as one tool.
// Layer: tool entry point
// Exports: main
// Why: see tools/queue/README.md; every external action goes through lib/runner.ts.

import path from "node:path";
import { fileURLToPath } from "node:url";
import { flagString, parseArgs, type ParsedArgs } from "../ws/lib/args.ts";
import { samePath } from "../ws/lib/paths.ts";
import { isAlive } from "../ws/lib/proc.ts";
import { ProfileError } from "../ws/lib/profile.ts";
import { loadQueueConfig, type QueueConfig } from "./lib/config.ts";
import { LocalExecutor, wsHeavyLock, type HeavyLock } from "./lib/executor.ts";
import { Git, GitError } from "./lib/git.ts";
import { GitHub, GitHubError } from "./lib/github.ts";
import { mergeCandidate } from "./lib/merge.ts";
import { buildCandidate } from "./lib/plan.ts";
import { RemoteExecutor } from "./lib/remote.ts";
import { realRunner, stopAllChildren, type Runner } from "./lib/runner.ts";
import { CandidateStore, readJson, type Candidate, type Progress } from "./lib/state.ts";
import { statusLines } from "./lib/status.ts";
import { summarize, verify, type Verdict } from "./lib/verify.ts";

const USAGE = `usage: bun run queue <command>

  plan <pr> [<pr>...]                       build the candidate: the PRs merged onto the base in order
  verify [<candidate>] [--only <lane,...>] [--no-remote] [--resume] [--owner <session>]
                                            every lane, then the judgement; writes verdict.json
  merge [<candidate>] [--dry-run] [--allow-base-red] [--note <text>]
                                            merge a green candidate one PR at a time
  status [<candidate>]                      current candidate, what is running, last verdict

<candidate> is a candidate SHA (7+ characters); default the last one planned.
Configuration: the "queue" section of the ws machine profile (see tools/queue/README.md).`;

export interface Io {
  out(line: string): void;
  err(line: string): void;
}

const consoleIo: Io = {
  out: (l) => process.stdout.write(`${l}\n`),
  err: (l) => process.stderr.write(`${l}\n`),
};

export interface MainDeps {
  readonly runner?: Runner;
  readonly config?: QueueConfig;
  readonly lock?: HeavyLock;
  readonly sleep?: (ms: number) => Promise<void>;
}

function owner(args: ParsedArgs): string {
  return (
    flagString(args, "owner") ??
    process.env.MOSS_WS_OWNER ??
    process.env.CLAUDE_SESSION_NAME ??
    "queue"
  );
}

/** git with gh as the credential helper for fetches, so no prompt and no stored token. */
export function queueGit(runner: Runner, cfg: QueueConfig): Git {
  return new Git(runner, cfg.tools.git, cfg.checkout, [
    "-c",
    "credential.helper=",
    "-c",
    `credential.helper=!'${cfg.tools.gh}' auth git-credential`,
  ]);
}

function loadCandidate(
  store: CandidateStore,
  ref: string | undefined,
  io: Io,
): Candidate | undefined {
  const found = store.resolve(ref);
  if ("error" in found) {
    io.err(found.error);
    return undefined;
  }
  return found;
}

export async function main(
  argv: readonly string[],
  io: Io = consoleIo,
  deps: MainDeps = {},
): Promise<number> {
  const [command, ...rest] = argv;
  if (!command || command === "help" || command === "--help" || command === "-h") {
    io.out(USAGE);
    return command ? 0 : 2;
  }
  let args: ParsedArgs;
  let cfg: QueueConfig;
  try {
    args = parseArgs(rest, ["only", "owner", "note"]);
    cfg = deps.config ?? loadQueueConfig();
  } catch (error) {
    io.err((error as Error).message);
    return 2;
  }
  const runner = deps.runner ?? realRunner;
  const store = new CandidateStore(cfg.stateDir);
  const git = queueGit(runner, cfg);
  const github = new GitHub(runner, cfg.tools.gh, cfg.repo);
  try {
    switch (command) {
      case "plan": {
        const prs = args.positionals.map((p) => Number(p.replace(/^#/, "")));
        if (prs.length === 0 || prs.some((n) => !Number.isInteger(n) || n <= 0)) {
          io.err("usage: queue plan <pr> [<pr>...]");
          return 2;
        }
        const outcome = await buildCandidate(
          { git, github, remoteName: cfg.remoteName, baseBranch: cfg.baseBranch },
          prs,
        );
        if (outcome.kind === "error") {
          io.err(outcome.message);
          return 1;
        }
        if (outcome.kind === "conflict") {
          io.out(
            `CONFLICT: #${outcome.pr} does not merge onto ${outcome.before.length ? outcome.before.map((n) => `#${n}`).join(" + ") + " on " : ""}${cfg.remoteName}/${cfg.baseBranch}`,
          );
          for (const f of outcome.files) io.out(`  ${f}`);
          return 1;
        }
        const c = outcome.candidate;
        store.save(c);
        io.out(`candidate ${c.sha}`);
        io.out(`tree      ${c.tree}`);
        io.out(`base      ${c.base.ref} ${c.base.sha} (tree ${c.base.tree})`);
        for (const s of c.steps)
          io.out(
            `  #${s.pr} head ${s.head} -> ${s.commit.slice(0, 12)} tree ${s.tree.slice(0, 12)}${s.baseRef !== cfg.baseBranch ? ` (stacked on ${s.baseRef})` : ""}  ${s.title}`,
          );
        io.out(`state     ${store.file(c.sha, "candidate.json")}`);
        return 0;
      }
      case "verify": {
        const candidate = loadCandidate(store, args.positionals[0], io);
        if (!candidate) return 2;
        const progress = readJson<Progress>(store.file(candidate.sha, "progress.json"));
        if (
          progress &&
          !progress.phase.startsWith("done") &&
          progress.pid !== process.pid &&
          isAlive(progress.pid)
        ) {
          io.err(
            `candidate ${candidate.sha.slice(0, 9)} is already being verified (pid ${progress.pid})`,
          );
          return 1;
        }
        const only = flagString(args, "only")
          ?.split(",")
          .map((s) => s.trim())
          .filter(Boolean);
        const logsDir = store.logsDir(candidate.sha);
        const log = (line: string) => io.out(line);
        const local = new LocalExecutor({
          runner,
          git,
          cfg,
          lock: deps.lock ?? wsHeavyLock(cfg, owner(args), io.err),
          logsDir,
        });
        const remote =
          cfg.remote && !args.flags.has("no-remote")
            ? new RemoteExecutor({
                runner,
                git,
                cfg: cfg.remote,
                logsDir,
                log,
                ...(deps.sleep ? { sleep: deps.sleep } : {}),
              })
            : undefined;
        io.out(
          `verifying ${candidate.sha.slice(0, 9)} (${candidate.steps.map((s) => `#${s.pr}`).join(" ")}) in ${cfg.checkout}` +
            (remote ? `; remote lanes on ${cfg.remote!.ssh}` : "; no remote machine"),
        );
        const verdict = await verify(
          { candidate, store, git, local, remote, log },
          { only, resume: args.flags.has("resume") },
        );
        io.out("");
        io.out(summarize(candidate, verdict));
        io.out(`verdict   ${store.file(candidate.sha, "verdict.json")}`);
        return verdict.result === "green" ? 0 : 1;
      }
      case "merge": {
        const candidate = loadCandidate(store, args.positionals[0], io);
        if (!candidate) return 2;
        return await mergeCandidate({
          candidate,
          verdict: readJson<Verdict>(store.file(candidate.sha, "verdict.json")),
          store,
          git,
          github,
          remoteName: cfg.remoteName,
          baseBranch: cfg.baseBranch,
          mergeLog: cfg.mergeLog,
          log: (l) => io.out(l),
          dryRun: args.flags.has("dry-run"),
          allowBaseRed: args.flags.has("allow-base-red"),
          note: flagString(args, "note"),
          ...(deps.sleep ? { sleep: deps.sleep } : {}),
        });
      }
      case "status": {
        const found = store.resolve(args.positionals[0]);
        for (const line of statusLines(
          store,
          cfg.profile.stateDir,
          "error" in found ? undefined : found,
        ))
          io.out(line);
        return 0;
      }
      default:
        io.err(`unknown command ${command}\n${USAGE}`);
        return 2;
    }
  } catch (error) {
    if (
      error instanceof GitError ||
      error instanceof GitHubError ||
      error instanceof ProfileError
    ) {
      io.err(`queue ${command}: ${error.message}`);
      return 1;
    }
    throw error;
  }
}

const invokedDirectly =
  process.argv[1] !== undefined &&
  samePath(path.resolve(process.argv[1]), fileURLToPath(import.meta.url));

if (invokedDirectly) {
  const stop = () => {
    stopAllChildren();
    process.exit(130);
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
  main(process.argv.slice(2)).then(
    (code) => process.exit(code),
    (error: unknown) => {
      stopAllChildren();
      process.stderr.write(
        `queue: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
      );
      process.exit(1);
    },
  );
}
