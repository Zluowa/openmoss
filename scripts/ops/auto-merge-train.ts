// FILE: auto-merge-train.ts
// Purpose: Layer 4 Auto-Merge Train. Evaluates open PRs against MOSS-GATES: PASS, MOSS-REVIEW: APPROVE,
//          clean mergeability, non-escalation path filtering, and set-back safety, then performs
//          pinned-SHA serial merges with post-merge tree verification, mirror sync, and merge logging.
// Layer: Factory 2.0 Merge Automation
// Exports: evaluatePullRequest, findEscalationPaths, parseLatestVerdictComment, runAutoMergeTrain

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, existsSync } from "node:fs";
import { resolve } from "node:path";
import { pathToFileURL } from "node:url";

export interface PrComment {
  readonly body: string;
  readonly author?: { readonly login?: string };
}

export interface PullRequestCandidate {
  readonly number: number;
  readonly title: string;
  readonly headRefOid: string;
  readonly baseRefName: string;
  readonly state: string;
  readonly isDraft: boolean;
  readonly mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
  readonly labels: readonly string[];
  readonly changedFiles: readonly string[];
  readonly comments: readonly PrComment[];
}

export interface EscalationMatch {
  readonly path: string;
  readonly reason: string;
}

export interface MergeTrainDecision {
  readonly pr: number;
  readonly head: string;
  readonly action: "merge" | "skip" | "escalate";
  readonly reasons: readonly string[];
  readonly escalations: readonly EscalationMatch[];
}

const DEFAULT_ESCALATION_PATTERNS: ReadonlyArray<{
  readonly pattern: RegExp;
  readonly reason: string;
}> = [
  { pattern: /^apps\/server\/src\/persistence\/Migrations\.ts$/, reason: "database migration" },
  { pattern: /^scripts\/public-mirror\//, reason: "public-mirror export tool/guard" },
  { pattern: /^scripts\/publish-.*\.ts$/, reason: "release publish script" },
  { pattern: /^scripts\/release-update-policy\.json$/, reason: "release update policy" },
  { pattern: /^release\//, reason: "release directory" },
  { pattern: /^scripts\/lib\/moss-canvas-source-pin\.json$/, reason: "canvas source pin" },
  { pattern: /^supabase\//, reason: "supabase backend/gateway/pay" },
  { pattern: /^apps\/(?:cloudflare-[^/]+|realtime-relay)\//, reason: "production relay/gateway" },
  { pattern: /^apps\/server\/src\/(?:account|auth)\//, reason: "account/sign-in lane" },
  {
    pattern: /^(?:package\.json|bun\.lock|apps\/mobile\/app\.json)$/,
    reason: "root or app manifest",
  },
];

export function findEscalationPaths(changedFiles: readonly string[]): EscalationMatch[] {
  const matches: EscalationMatch[] = [];
  for (const rawPath of changedFiles) {
    const file = rawPath.replaceAll("\\", "/");
    for (const rule of DEFAULT_ESCALATION_PATTERNS) {
      if (rule.pattern.test(file)) {
        matches.push({ path: file, reason: rule.reason });
        break;
      }
    }
  }
  return matches;
}

export function parseLatestVerdictComment(
  comments: readonly PrComment[],
  prefix: "MOSS-GATES" | "MOSS-REVIEW",
  headSha: string,
): "PASS" | "FAIL" | "ERROR" | "APPROVE" | "REJECT" | "NONE" {
  const matching = comments.filter(
    (c) => c.body.startsWith(`${prefix}:`) && c.body.includes(headSha),
  );
  const latest = matching.at(-1);
  if (!latest) return "NONE";
  const firstLine = latest.body.split(/\r?\n/, 1)[0]?.trim() ?? "";
  const token = firstLine.slice(`${prefix}:`.length).trim().split(/\s+/)[0];
  if (
    token === "PASS" ||
    token === "FAIL" ||
    token === "ERROR" ||
    token === "APPROVE" ||
    token === "REJECT"
  ) {
    return token;
  }
  return "NONE";
}

export function hasLeadSignOff(comments: readonly PrComment[], headSha: string): boolean {
  return comments.some((c) => /\bLEAD-SIGN-OFF\b/.test(c.body) && c.body.includes(headSha));
}

export function evaluatePullRequest(pr: PullRequestCandidate): MergeTrainDecision {
  const reasons: string[] = [];
  if (pr.state !== "OPEN") reasons.push(`state=${pr.state}`);
  if (pr.isDraft) reasons.push("draft PR");
  if (pr.baseRefName !== "main") reasons.push(`base=${pr.baseRefName} (expected main)`);
  if (pr.mergeable !== "MERGEABLE") reasons.push(`mergeable=${pr.mergeable}`);
  if (pr.labels.some((l) => /^hold$/i.test(l)) || /\[HOLD\]|DO NOT MERGE/i.test(pr.title)) {
    reasons.push("explicit hold label/title");
  }

  const gates = parseLatestVerdictComment(pr.comments, "MOSS-GATES", pr.headRefOid);
  if (gates !== "PASS") reasons.push(`MOSS-GATES=${gates}`);

  const review = parseLatestVerdictComment(pr.comments, "MOSS-REVIEW", pr.headRefOid);
  if (review !== "APPROVE") reasons.push(`MOSS-REVIEW=${review}`);

  const escalations = findEscalationPaths(pr.changedFiles);
  if (escalations.length > 0 && !hasLeadSignOff(pr.comments, pr.headRefOid)) {
    return {
      pr: pr.number,
      head: pr.headRefOid,
      action: "escalate",
      reasons: [
        ...reasons,
        `touches escalation paths without LEAD-SIGN-OFF on ${pr.headRefOid.slice(0, 9)}`,
      ],
      escalations,
    };
  }

  if (reasons.length > 0) {
    return {
      pr: pr.number,
      head: pr.headRefOid,
      action: "skip",
      reasons,
      escalations,
    };
  }

  return {
    pr: pr.number,
    head: pr.headRefOid,
    action: "merge",
    reasons: ["MOSS-GATES: PASS", "MOSS-REVIEW: APPROVE", "MERGEABLE", "non-escalation clean"],
    escalations,
  };
}

const DEFAULT_GH = process.env.MOSS_GH ?? "E:/Utopia/migration/tools/gh-2.102.0/bin/gh.exe";

function runGh(repoRoot: string, args: readonly string[]): string {
  const gh = existsSync(DEFAULT_GH) ? DEFAULT_GH : "gh";
  return execFileSync(gh, args, {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 60_000,
  });
}

function runGit(repoRoot: string, args: readonly string[]): string {
  const gh = existsSync(DEFAULT_GH) ? DEFAULT_GH : "gh";
  return execFileSync(
    "git",
    ["-c", "credential.helper=", "-c", `credential.helper=!'${gh}' auth git-credential`, ...args],
    {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
      timeout: 60_000,
      env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GCM_INTERACTIVE: "never" },
    },
  );
}

export function detectSetBackFiles(
  repoRoot: string,
  baseSha: string,
  headSha: string,
  changedFiles: readonly string[],
): string[] {
  const setBack: string[] = [];
  for (const file of changedFiles) {
    const headRes = spawnSync("git", ["rev-parse", "-q", "--verify", `${headSha}:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    const baseRes = spawnSync("git", ["rev-parse", "-q", "--verify", `${baseSha}:${file}`], {
      cwd: repoRoot,
      encoding: "utf8",
      windowsHide: true,
    });
    if (headRes.status !== 0) continue;
    const headBlob = headRes.stdout.trim();
    const baseBlob = baseRes.status === 0 ? baseRes.stdout.trim() : "";
    if (!headBlob || headBlob === baseBlob) continue;
    const revList = runGit(repoRoot, ["rev-list", "-n", "40", baseSha, "--", file])
      .trim()
      .split(/\r?\n/)
      .slice(1);
    for (const prevCommit of revList) {
      if (!prevCommit) continue;
      const oldRes = spawnSync("git", ["rev-parse", "-q", "--verify", `${prevCommit}:${file}`], {
        cwd: repoRoot,
        encoding: "utf8",
        windowsHide: true,
      });
      if (oldRes.status === 0 && oldRes.stdout.trim() === headBlob) {
        setBack.push(file);
        break;
      }
    }
  }
  return setBack;
}

export function computeMergeTree(
  repoRoot: string,
  baseSha: string,
  headSha: string,
): string | null {
  const res = spawnSync("git", ["merge-tree", "--write-tree", baseSha, headSha], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
  });
  if (res.status !== 0) return null;
  return res.stdout.trim().split(/\r?\n/)[0]?.trim() ?? null;
}

export interface TrainRunSummary {
  readonly dryRun: boolean;
  readonly evaluated: readonly MergeTrainDecision[];
  readonly merged: readonly {
    readonly pr: number;
    readonly mainSha: string;
    readonly tree: string;
  }[];
}

export function runAutoMergeTrain(options: {
  readonly repoRoot: string;
  readonly repo: string;
  readonly dryRun: boolean;
  readonly prNumber?: number;
  readonly maxMerges?: number;
  readonly logFile?: string;
}): TrainRunSummary {
  const listRaw = runGh(options.repoRoot, [
    "pr",
    "list",
    "-R",
    options.repo,
    "--state",
    "open",
    "--base",
    "main",
    "--json",
    "number,title,headRefOid,baseRefName,state,isDraft,mergeable,labels,files,comments",
    "--limit",
    "30",
  ]);
  const prs = (
    JSON.parse(listRaw) as Array<{
      number: number;
      title: string;
      headRefOid: string;
      baseRefName: string;
      state: string;
      isDraft: boolean;
      mergeable: "MERGEABLE" | "CONFLICTING" | "UNKNOWN";
      labels?: Array<{ name: string }>;
      files?: Array<{ path: string }>;
      comments?: PrComment[];
    }>
  )
    .filter((p) => (options.prNumber === undefined ? true : p.number === options.prNumber))
    .map(
      (p): PullRequestCandidate => ({
        number: p.number,
        title: p.title,
        headRefOid: p.headRefOid,
        baseRefName: p.baseRefName,
        state: p.state,
        isDraft: p.isDraft,
        mergeable: p.mergeable,
        labels: (p.labels ?? []).map((l) => l.name),
        changedFiles: (p.files ?? []).map((f) => f.path),
        comments: p.comments ?? [],
      }),
    );

  const evaluated: MergeTrainDecision[] = [];
  const merged: Array<{ pr: number; mainSha: string; tree: string }> = [];
  const maxMerges = options.maxMerges ?? 5;

  for (const pr of prs) {
    const decision = evaluatePullRequest(pr);
    evaluated.push(decision);
    if (options.dryRun || decision.action !== "merge" || merged.length >= maxMerges) {
      continue;
    }

    runGit(options.repoRoot, ["fetch", "-q", "origin", "main", `pull/${pr.number}/head`]);
    const preMain = runGit(options.repoRoot, ["rev-parse", "origin/main"]).trim();
    const expectedTree = computeMergeTree(options.repoRoot, preMain, pr.headRefOid);
    if (!expectedTree) {
      throw new Error(
        `PR #${pr.number} conflicts with current origin/main (${preMain.slice(0, 9)})`,
      );
    }

    const setBack = detectSetBackFiles(options.repoRoot, preMain, pr.headRefOid, pr.changedFiles);
    if (setBack.length > 0) {
      throw new Error(`PR #${pr.number} sets back older file(s): ${setBack.join(", ")}`);
    }

    runGh(options.repoRoot, [
      "api",
      "-X",
      "PUT",
      `repos/${options.repo}/pulls/${pr.number}/merge`,
      "-f",
      `sha=${pr.headRefOid}`,
      "-f",
      "merge_method=merge",
      "-f",
      `commit_title=${pr.title} (#${pr.number})`,
    ]);

    runGit(options.repoRoot, ["fetch", "-q", "origin", "main"]);
    const mainSha = runGit(options.repoRoot, ["rev-parse", "origin/main"]).trim();
    const actualTree = runGit(options.repoRoot, ["rev-parse", "origin/main^{tree}"]).trim();
    if (actualTree !== expectedTree) {
      throw new Error(
        `TREE-MISMATCH after merging #${pr.number}: expected ${expectedTree}, got ${actualTree}`,
      );
    }

    runGh(options.repoRoot, ["api", `repos/${options.repo}/commits/${mainSha}`, "--silent"]);

    const mirrorCli = resolve(options.repoRoot, "scripts", "public-mirror", "cli.ts");
    if (existsSync(mirrorCli)) {
      spawnSync("node", [mirrorCli, "publish", "--push"], {
        cwd: options.repoRoot,
        encoding: "utf8",
        windowsHide: true,
        timeout: 180_000,
      });
    }

    if (options.logFile) {
      appendFileSync(
        options.logFile,
        `Merged ${new Date().toISOString()} (moss-train): #${pr.number} \`${pr.headRefOid.slice(0, 9)}\` -> main \`${mainSha}\` (tree \`${actualTree.slice(0, 10)}\`); gates + APPROVE on head; set-back & tree check clean.\n`,
      );
    }
    merged.push({ pr: pr.number, mainSha, tree: actualTree });
  }

  return { dryRun: options.dryRun, evaluated, merged };
}

function main(): void {
  const args = process.argv.slice(2);
  const dryRun = !args.includes("--merge");
  const prIdx = args.indexOf("--pr");
  const prNumber = prIdx >= 0 && args[prIdx + 1] ? Number(args[prIdx + 1]) : undefined;
  const logIdx = args.indexOf("--log-file");
  const logFile = logIdx >= 0 ? args[logIdx + 1] : undefined;
  const repoRoot = resolve(import.meta.dirname, "..", "..");

  const summary = runAutoMergeTrain({
    repoRoot,
    repo: process.env.MOSS_REPO ?? "Zluowa/moss-synara",
    dryRun,
    ...(prNumber !== undefined ? { prNumber } : {}),
    ...(logFile ? { logFile } : {}),
  });

  if (args.includes("--json")) {
    console.log(JSON.stringify(summary, null, 2));
    return;
  }
  console.log(
    `Auto-Merge Train (${summary.dryRun ? "dry-run" : "live"}): evaluated ${summary.evaluated.length} PR(s), merged ${summary.merged.length}.`,
  );
  for (const d of summary.evaluated) {
    console.log(`- #${d.pr} (${d.head.slice(0, 9)}): ${d.action} [${d.reasons.join("; ")}]`);
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main();
}
