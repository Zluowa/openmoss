import * as fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { randomUUID } from "node:crypto";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DevsHandoffError } from "./devsHandoff";
import { parseNameStatus, verifyRepairOnMirror } from "./devsMirrorVerification";
import { runRepairCommand, type RepairCommand } from "./devsRepairRunner";
import type { DevsFetch } from "./devsReports";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 30_000 });
const directories: string[] = [];
afterEach(async () => {
  for (const directory of directories.splice(0))
    await fs.rm(directory, { recursive: true, force: true });
});
// Fake values only: nothing here is a real credential.
const FAKE_GITHUB_TOKEN = "fixture-github-token-not-real-0002";
const SNAPSHOT = "5".repeat(40);
const git = (cwd: string, args: string[]) =>
  runRepairCommand(
    "git",
    ["-c", "user.name=Fixture", "-c", "user.email=fixture@example.test", ...args],
    { cwd },
  );

/** A job checkout with one repair commit, a trusted tool checkout and a mirror clone. */
async function fixture(files: Record<string, string>, mirrorFiles: Record<string, string> = {}) {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), "moss-devs-mirror-"));
  directories.push(root);
  const reportId = randomUUID();
  const jobDir = path.join(root, "job");
  const toolRoot = path.join(root, "tool");
  const clone = path.join(root, "clone");
  for (const directory of [jobDir, toolRoot, clone]) {
    await fs.mkdir(directory);
    await git(directory, ["init", "-q", "--initial-branch=main"]);
  }
  await fs.writeFile(path.join(jobDir, "README.md"), "fixture\n");
  await fs.writeFile(path.join(jobDir, "gone.ts"), "export {};\n");
  await git(jobDir, ["add", "."]);
  await git(jobDir, ["commit", "-q", "-m", "base"]);
  const baseSha = (await git(jobDir, ["rev-parse", "HEAD"])).trim();
  await git(jobDir, ["checkout", "-q", "-b", `devs/${reportId}`]);
  for (const [name, text] of Object.entries(files)) {
    await fs.mkdir(path.dirname(path.join(jobDir, name)), { recursive: true });
    if (text === "<deleted>") await fs.rm(path.join(jobDir, name));
    else await fs.writeFile(path.join(jobDir, name), text);
  }
  await git(jobDir, ["add", "--all"]);
  await git(jobDir, ["commit", "-q", "-m", "repair"]);
  const sourceSha = (await git(jobDir, ["rev-parse", "HEAD"])).trim();
  await fs.writeFile(path.join(clone, "README.md"), "public\n");
  for (const [name, text] of Object.entries(mirrorFiles)) {
    await fs.mkdir(path.dirname(path.join(clone, name)), { recursive: true });
    await fs.writeFile(path.join(clone, name), text);
  }
  await git(clone, ["add", "."]);
  await git(clone, ["commit", "-q", "-m", "mirror main"]);
  await git(clone, ["update-ref", "refs/remotes/origin/main", "HEAD"]);
  const changed = parseNameStatus(
    await git(jobDir, ["diff", "--name-status", "--no-renames", "-z", baseSha, sourceSha]),
  );
  return { root, reportId, jobDir, toolRoot, clone, sourceSha, baseSha, changed };
}

/**
 * Stands in for the export tool and the snapshot push. `exported` decides what the guarded
 * export holds; every other command is real Git.
 */
function commands(options: {
  exported: (jobDir: string) => Record<string, string | null>;
  jobDir: string;
  exportError?: string;
}) {
  const pushes: string[][] = [];
  const exports: string[][] = [];
  const run: RepairCommand = async (file, args, commandOptions) => {
    if (file === process.execPath) {
      exports.push([...args]);
      expect(Object.keys(commandOptions.env ?? {}).join(" ")).not.toMatch(/TOKEN/i);
      if (options.exportError) throw new Error(options.exportError);
      const outDir = args[args.indexOf("--out") + 1]!;
      await fs.rm(outDir, { recursive: true, force: true });
      for (const [name, text] of Object.entries(options.exported(options.jobDir))) {
        if (text === null) continue;
        await fs.mkdir(path.dirname(path.join(outDir, name)), { recursive: true });
        await fs.writeFile(path.join(outDir, name), text);
      }
      return `committed ${SNAPSHOT}; not pushed (pass --push after reviewing it)\n`;
    }
    if (args.includes("push")) {
      pushes.push([...args]);
      return "";
    }
    return runRepairCommand(file, args, commandOptions);
  };
  return { run, pushes, exports };
}

function runsApi(conclusions: Array<{ status: string; conclusion?: string | null } | null>) {
  const calls: string[] = [];
  const fetcher = vi.fn<DevsFetch>(async (url) => {
    calls.push(String(url));
    const next = conclusions.length > 1 ? conclusions.shift()! : conclusions[0]!;
    return Response.json({
      workflow_runs: next
        ? [
            {
              name: "Cua Linux checks",
              head_sha: SNAPSHOT,
              status: "completed",
              conclusion: "failure",
            },
            {
              name: "CI",
              head_sha: SNAPSHOT,
              html_url: "https://github.com/fixture/public/actions/runs/7",
              ...next,
            },
          ]
        : [],
    });
  });
  return { fetcher, calls };
}

function clock() {
  let time = 1_000_000;
  return { now: () => time, delay: async (ms: number) => void (time += ms) };
}

describe("repair verification on the public mirror", () => {
  it("exports a guarded snapshot, pushes it to ci/<name> and takes the CI run's conclusion", async () => {
    const job = await fixture(
      { "src/fix.ts": "fixed\n", "src/fix.test.ts": "test\n", "gone.ts": "<deleted>" },
      { "gone.ts": "export {};\n" },
    );
    const { run, pushes, exports } = commands({
      jobDir: job.jobDir,
      exported: () => ({
        "README.md": "public\n",
        "src/fix.ts": "fixed\n",
        "src/fix.test.ts": "test\n",
      }),
    });
    const { fetcher, calls } = runsApi([
      null,
      { status: "in_progress" },
      { status: "completed", conclusion: "success" },
    ]);
    const time = clock();
    const result = await verifyRepairOnMirror({
      mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
      githubToken: FAKE_GITHUB_TOKEN,
      reportId: job.reportId,
      sourceSha: job.sourceSha,
      baseSha: job.baseSha,
      jobDir: job.jobDir,
      changed: job.changed,
      run,
      fetcher,
      ...time,
    });
    expect(result).toEqual({
      runUrl: "https://github.com/fixture/public/actions/runs/7",
      snapshot: SNAPSHOT,
    });
    const name = `devs-${job.reportId.slice(0, 8)}-${job.sourceSha.slice(0, 9)}`;
    // The trusted checkout's own tool exports the repair commit, fetched into its objects.
    expect(exports[0]).toEqual(
      expect.arrayContaining(["ci", "--ref", job.sourceSha, "--name", name, "--target", job.clone]),
    );
    // The export tool runs from a worktree of the trusted checkout at the repair's base.
    const toolDir = path.join(job.toolRoot, ".tmp", "devs-export-tool");
    expect(exports[0]![0]).toBe(path.join(toolDir, "scripts", "public-mirror", "cli.ts"));
    expect((await git(toolDir, ["rev-parse", "HEAD"])).trim()).toBe(job.baseSha);
    expect(exports[0]).not.toContain("--push");
    expect((await git(job.toolRoot, ["cat-file", "-t", job.sourceSha])).trim()).toBe("commit");
    expect(pushes).toHaveLength(1);
    expect(pushes[0]!.slice(-2)).toEqual([
      "https://github.com/fixture/public.git",
      `${SNAPSHOT}:refs/heads/ci/${name}`,
    ]);
    expect(calls[0]).toContain(`branch=${encodeURIComponent(`ci/${name}`)}`);
    expect(calls).toHaveLength(3);
    await expect(fs.stat(`${job.clone}.push-lock`)).rejects.toThrow();
  });

  it("rebuilds a broken tool worktree without touching the packages it links", async () => {
    const job = await fixture({ "src/fix.test.ts": "test" + String.fromCharCode(10) });
    await fs.mkdir(path.join(job.toolRoot, "node_modules"));
    await fs.writeFile(path.join(job.toolRoot, "node_modules", "keep.txt"), "packages");
    const { run } = commands({
      jobDir: job.jobDir,
      exported: () => ({ "src/fix.test.ts": "test" + String.fromCharCode(10) }),
    });
    const verify = () =>
      verifyRepairOnMirror({
        mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
        githubToken: FAKE_GITHUB_TOKEN,
        reportId: job.reportId,
        sourceSha: job.sourceSha,
        baseSha: job.baseSha,
        jobDir: job.jobDir,
        changed: job.changed,
        run,
        fetcher: runsApi([{ status: "completed", conclusion: "success" }]).fetcher,
        ...clock(),
      });
    await verify();
    const toolDir = path.join(job.toolRoot, ".tmp", "devs-export-tool");
    expect(await fs.readFile(path.join(toolDir, "node_modules", "keep.txt"), "utf8")).toBe(
      "packages",
    );
    // A worktree that lost its Git link is removed and added again.
    await fs.rm(path.join(toolDir, ".git"));
    await verify();
    expect(await fs.readFile(path.join(job.toolRoot, "node_modules", "keep.txt"), "utf8")).toBe(
      "packages",
    );
    expect((await git(toolDir, ["rev-parse", "HEAD"])).trim()).toBe(job.baseSha);
  });

  it("fails a repair the export guard refuses, without pushing anything", async () => {
    const job = await fixture({ "src/fix.ts": "fixed\n" });
    const { run, pushes } = commands({
      jobDir: job.jobDir,
      exported: () => ({}),
      exportError:
        "Repair command failed (bun, exit 1): source x\n\n1 guard violation(s); nothing may be published:\n  private-key  src/fix.ts:1",
    });
    const error = await verifyRepairOnMirror({
      mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
      githubToken: FAKE_GITHUB_TOKEN,
      reportId: job.reportId,
      sourceSha: job.sourceSha,
      baseSha: job.baseSha,
      jobDir: job.jobDir,
      changed: job.changed,
      run,
      fetcher: runsApi([null]).fetcher,
      ...clock(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(Error);
    expect(error).not.toBeInstanceOf(DevsHandoffError);
    expect((error as Error).message).toContain("forbids");
    expect((error as Error).message).toContain("private-key  src/fix.ts:1");
    expect(pushes).toEqual([]);
  });

  it("hands off when the guard refuses files the repair did not change", async () => {
    const job = await fixture({ "src/fix.test.ts": "test" + String.fromCharCode(10) });
    const { run, pushes } = commands({
      jobDir: job.jobDir,
      exported: () => ({}),
      exportError: [
        "Repair command failed (bun, exit 1): source x",
        "",
        "1 guard violation(s); nothing may be published:",
        "  open-icon-missing-alias  scripts/public-mirror/open-icon-aliases.json#file-edit",
      ].join(String.fromCharCode(10)),
    });
    const error = await verifyRepairOnMirror({
      mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
      githubToken: FAKE_GITHUB_TOKEN,
      reportId: job.reportId,
      sourceSha: job.sourceSha,
      baseSha: job.baseSha,
      jobDir: job.jobDir,
      changed: job.changed,
      run,
      fetcher: runsApi([null]).fetcher,
      ...clock(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevsHandoffError);
    expect((error as Error).message).toContain("refused files the repair did not change");
    expect(pushes).toEqual([]);
  });

  it("hands off a change the mirror does not publish, or publishes altered, without pushing", async () => {
    const job = await fixture({
      "src/fix.ts": "fixed\n",
      "src/fix.test.ts": "test\n",
      "supabase/functions/report/index.ts": "server\n",
    });
    const { run, pushes } = commands({
      jobDir: job.jobDir,
      // The test file is replaced by an open substitute; the function is not exported.
      exported: () => ({ "src/fix.ts": "fixed\n", "src/fix.test.ts": "substitute\n" }),
    });
    const error = await verifyRepairOnMirror({
      mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
      githubToken: FAKE_GITHUB_TOKEN,
      reportId: job.reportId,
      sourceSha: job.sourceSha,
      baseSha: job.baseSha,
      jobDir: job.jobDir,
      changed: job.changed,
      run,
      fetcher: runsApi([null]).fetcher,
      ...clock(),
    }).catch((caught: unknown) => caught);
    expect(error).toBeInstanceOf(DevsHandoffError);
    expect((error as Error).message).toBe(
      "Cannot verify on the public mirror: it does not publish src/fix.test.ts, supabase/functions/report/index.ts.",
    );
    expect((error as DevsHandoffError).details).toEqual({
      commit: job.sourceSha,
      jobDir: job.jobDir,
    });
    expect(pushes).toEqual([]);
  });

  it("hands off a deletion of a file the mirror never had", async () => {
    const job = await fixture({ "src/fix.test.ts": "test\n", "gone.ts": "<deleted>" });
    const { run } = commands({
      jobDir: job.jobDir,
      exported: () => ({ "src/fix.test.ts": "test\n" }),
    });
    await expect(
      verifyRepairOnMirror({
        mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
        githubToken: FAKE_GITHUB_TOKEN,
        reportId: job.reportId,
        sourceSha: job.sourceSha,
        baseSha: job.baseSha,
        jobDir: job.jobDir,
        changed: job.changed,
        run,
        fetcher: runsApi([null]).fetcher,
        ...clock(),
      }),
    ).rejects.toThrow("it does not publish gone.ts");
  });

  it("fails on a failed CI run and hands off a cancelled, missing or unfinished one", async () => {
    const outcomes: Array<
      [Array<{ status: string; conclusion?: string | null } | null>, string, boolean]
    > = [
      [
        [{ status: "completed", conclusion: "failure" }],
        "failed the public mirror's checks",
        false,
      ],
      [[{ status: "completed", conclusion: "cancelled" }], "its CI run ended cancelled", true],
      [[null], "no CI run started", true],
      [[{ status: "queued" }], "did not finish in time", true],
    ];
    for (const [conclusions, message, handoff] of outcomes) {
      const job = await fixture({ "src/fix.test.ts": "test\n" });
      const { run } = commands({
        jobDir: job.jobDir,
        exported: () => ({ "src/fix.test.ts": "test\n" }),
      });
      const error = await verifyRepairOnMirror({
        mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
        githubToken: FAKE_GITHUB_TOKEN,
        reportId: job.reportId,
        sourceSha: job.sourceSha,
        baseSha: job.baseSha,
        jobDir: job.jobDir,
        changed: job.changed,
        run,
        fetcher: runsApi(conclusions).fetcher,
        ...clock(),
      }).catch((caught: unknown) => caught);
      expect((error as Error).message).toContain(message);
      expect(error instanceof DevsHandoffError).toBe(handoff);
    }
  });

  it("takes over a lock whose holder has ended and waits for a live one, then hands off", async () => {
    const job = await fixture({ "src/fix.test.ts": "test\n" });
    const { run, pushes } = commands({
      jobDir: job.jobDir,
      exported: () => ({ "src/fix.test.ts": "test\n" }),
    });
    const lock = `${job.clone}.push-lock`;
    const verify = () =>
      verifyRepairOnMirror({
        mirror: { toolRoot: job.toolRoot, clone: job.clone, repository: "fixture/public" },
        githubToken: FAKE_GITHUB_TOKEN,
        reportId: job.reportId,
        sourceSha: job.sourceSha,
        baseSha: job.baseSha,
        jobDir: job.jobDir,
        changed: job.changed,
        run,
        fetcher: runsApi([{ status: "completed", conclusion: "success" }]).fetcher,
        ...clock(),
      });
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "pid"), "2147483646");
    await expect(verify()).resolves.toMatchObject({ snapshot: SNAPSHOT });
    await fs.mkdir(lock);
    await fs.writeFile(path.join(lock, "pid"), String(process.pid));
    await expect(verify()).rejects.toThrow("stayed locked by another push");
    expect(pushes).toHaveLength(1);
    expect(await fs.readFile(path.join(lock, "pid"), "utf8")).toBe(String(process.pid));
  });
});
