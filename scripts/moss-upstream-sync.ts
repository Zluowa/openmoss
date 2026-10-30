// FILE: moss-upstream-sync.ts
// Purpose: Merge upstream source updates into Moss and open/update a review PR.
// Layer: GitHub automation script
// Depends on: git and gh CLI.

import { execFileSync, spawnSync } from "node:child_process";
import { appendFileSync, mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

export type SyncPrKind = "merge" | "conflict";

export interface SyncOptions {
  upstreamRepo: string;
  upstreamRef: string;
  baseRef: string;
  remoteName: string;
  dryRun: boolean;
  createConflictPullRequest: boolean;
}

export interface PullRequestDescriptionInput {
  kind: SyncPrKind;
  upstreamRepo: string;
  upstreamRef: string;
  upstreamSha: string;
  baseRef: string;
  baseSha: string;
  branchName: string;
  conflictFiles: readonly string[];
}

export interface ManualPullRequestHandoffInput extends PullRequestDescriptionInput {
  targetRepository: string;
  githubServerUrl?: string;
  reportPath?: string;
}

export interface ManualPullRequestHandoff {
  status: "manual-pr-required";
  compareUrl: string;
  command: string;
  annotation: string;
  summary: string;
}

export interface SyncBranchPublicationEffects {
  pushBranch: () => void;
  upsertPullRequest: () => void;
  resolveTargetRepository: () => string;
  githubServerUrl?: string;
  writeActionsOutput: (values: Record<string, string>) => void;
  appendStepSummary: (markdown: string) => void;
  annotate: (annotation: string) => void;
}

const defaultUpstreamRepo = "Emanuele-web04/synara";
const defaultUpstreamRef = "main";
const defaultBaseRef = "main";
const defaultRemoteName = "moss-upstream";

function commandOutput(command: string, args: readonly string[]): string {
  return execFileSync(command, [...args], {
    cwd: process.cwd(),
    encoding: "utf8",
    stdio: ["ignore", "pipe", "pipe"],
  });
}

function runCommand(command: string, args: readonly string[]): void {
  execFileSync(command, [...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
}

function tryRunCommand(command: string, args: readonly string[]): boolean {
  const result = spawnSync(command, [...args], {
    cwd: process.cwd(),
    stdio: "inherit",
  });
  return result.status === 0;
}

function sleep(milliseconds: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds);
}

function runCommandWithRetry(command: string, args: readonly string[], attempts: number): void {
  let lastError: unknown;
  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      runCommand(command, args);
      return;
    } catch (error) {
      lastError = error;
      if (attempt === attempts) {
        break;
      }
      const delay = attempt * 2_000;
      console.log(
        `${command} ${args.join(" ")} failed on attempt ${attempt}; retrying in ${delay}ms.`,
      );
      sleep(delay);
    }
  }

  throw lastError;
}

function commandExists(command: string): boolean {
  const result = spawnSync(command, ["--version"], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  return result.status === 0;
}

function gitRemoteExists(remoteName: string): boolean {
  const result = spawnSync("git", ["remote", "get-url", remoteName], {
    cwd: process.cwd(),
    stdio: "ignore",
  });
  return result.status === 0;
}

export function parseBooleanFlag(value: string | undefined, fallback: boolean): boolean {
  if (value === undefined || value.trim() === "") {
    return fallback;
  }

  const normalized = value.trim().toLowerCase();
  if (["1", "true", "yes", "y", "on"].includes(normalized)) {
    return true;
  }
  if (["0", "false", "no", "n", "off"].includes(normalized)) {
    return false;
  }

  throw new Error(`Invalid boolean value: ${value}`);
}

export function normalizeOwnerRepo(value: string): string {
  let normalized = value.trim();
  if (!normalized) {
    throw new Error("Upstream repository is required.");
  }

  if (normalized.startsWith("git@github.com:")) {
    normalized = `https://github.com/${normalized.slice("git@github.com:".length)}`;
  }

  if (/^https?:\/\//u.test(normalized)) {
    const url = new URL(normalized);
    if (url.hostname !== "github.com") {
      throw new Error(`Only github.com upstream repositories are supported: ${value}`);
    }
    normalized = url.pathname;
  }

  normalized = normalized.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  const [owner, repo, extra] = normalized.split("/");
  if (!owner || !repo || extra !== undefined) {
    throw new Error(`Expected owner/repo upstream repository, got: ${value}`);
  }

  return `${owner}/${repo}`;
}

export function sanitizeRefSlug(value: string): string {
  const withoutPrefix = value.trim().replace(/^refs\/heads\//u, "");
  const slug = withoutPrefix
    .replace(/[^A-Za-z0-9._/-]+/gu, "-")
    .replace(/\/+/gu, "/")
    .replace(/^\/+|\/+$/gu, "")
    .replace(/[-/.]+$/gu, "")
    .slice(0, 96);
  return slug || defaultUpstreamRef;
}

export function shortSha(value: string): string {
  const normalized = value.trim().toLowerCase();
  if (!/^[0-9a-f]{7,40}$/u.test(normalized)) {
    throw new Error(`Invalid git sha: ${value}`);
  }
  return normalized.slice(0, 12);
}

export function buildSyncBranchName(input: {
  kind: SyncPrKind;
  upstreamRef: string;
  upstreamSha: string;
}): string {
  return `sync/moss-upstream/${input.kind}/${sanitizeRefSlug(input.upstreamRef)}-${shortSha(input.upstreamSha)}`;
}

export function buildPullRequestTitle(input: {
  kind: SyncPrKind;
  upstreamRef: string;
  upstreamSha: string;
}): string {
  const prefix = input.kind === "merge" ? "merge" : "manual merge required for";
  return `chore(sync): ${prefix} upstream source ${sanitizeRefSlug(input.upstreamRef)} ${shortSha(input.upstreamSha)}`;
}

export function buildPullRequestBody(input: PullRequestDescriptionInput): string {
  const summary =
    input.kind === "merge"
      ? "This automated PR merges the latest upstream source commit into Moss."
      : "This automated PR records that the upstream source merge needs manual conflict resolution.";
  const conflictSection =
    input.conflictFiles.length === 0
      ? "No merge conflicts were reported by git."
      : input.conflictFiles.map((file) => `- \`${file}\``).join("\n");

  return `${summary}

## Upstream

- Repository: \`${input.upstreamRepo}\`
- Ref: \`${input.upstreamRef}\`
- Commit: \`${input.upstreamSha}\`

## Target

- Base branch: \`${input.baseRef}\`
- Base commit: \`${input.baseSha}\`
- Sync branch: \`${input.branchName}\`

## Merge status

${input.kind === "merge" ? "The upstream merge completed cleanly. CI should be treated as the acceptance gate before merge." : `The automatic merge conflicted in:\n\n${conflictSection}`}

Generated by \`.github/workflows/moss-upstream-sync.yml\`.
`;
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/gu, `'"'"'`)}'`;
}

function escapeActionsCommandData(value: string): string {
  return value.replace(/%/gu, "%25").replace(/\r/gu, "%0D").replace(/\n/gu, "%0A");
}

export function buildManualPullRequestHandoff(
  input: ManualPullRequestHandoffInput,
): ManualPullRequestHandoff {
  const targetRepository = normalizeOwnerRepo(input.targetRepository);
  const githubServerUrl = (input.githubServerUrl?.trim() || "https://github.com").replace(
    /\/+$/gu,
    "",
  );
  const compareUrl = `${githubServerUrl}/${targetRepository}/compare/${input.baseRef}...${input.branchName}?expand=1`;
  const title = buildPullRequestTitle(input);
  const body =
    input.kind === "conflict"
      ? `Automated upstream source sync branch ${input.branchName} was preserved after PR automation failed. Resolve the conflicts documented in ${input.reportPath ?? "the committed sync report"} before merging.`
      : `Automated upstream source sync branch ${input.branchName} was preserved after PR automation failed. Review the branch diff and CI before merging.`;
  const command = [
    "gh pr create",
    `--repo ${shellQuote(targetRepository)}`,
    "--draft",
    `--base ${shellQuote(input.baseRef)}`,
    `--head ${shellQuote(input.branchName)}`,
    `--title ${shellQuote(title)}`,
    `--body ${shellQuote(body)}`,
  ].join(" ");
  const reportLine = input.reportPath ? `- Conflict report: \`${input.reportPath}\`\n` : "";
  const annotation = `::error title=Manual Draft PR required::${escapeActionsCommandData(`Branch ${input.branchName} was preserved, but PR creation or update failed. Open ${compareUrl} and create or update the Draft PR manually.`)}`;

  return {
    status: "manual-pr-required",
    compareUrl,
    command,
    annotation,
    summary: `## Manual Draft PR required

The sync branch was pushed successfully, but GitHub Actions could not create or update the pull request. The branch is preserved, and this workflow run intentionally fails to signal that maintainer action is required.

- Status: \`manual-pr-required\`
- Branch: \`${input.branchName}\`
- Base branch: \`${input.baseRef}\`
- Upstream commit: \`${input.upstreamSha}\`
${reportLine}- Draft PR / compare page: ${compareUrl}

If no pull request exists for this branch, copy and run:

\`\`\`sh
${command}
\`\`\`

If a pull request already exists, open the compare page and update that Draft PR manually. Do not merge automatically.
`,
  };
}

export function resolveSyncOptions(env: NodeJS.ProcessEnv): SyncOptions {
  return {
    upstreamRepo: normalizeOwnerRepo(env.SYNC_UPSTREAM_REPO ?? defaultUpstreamRepo),
    upstreamRef: sanitizeRefSlug(env.SYNC_UPSTREAM_REF ?? defaultUpstreamRef),
    baseRef: sanitizeRefSlug(env.SYNC_BASE_REF ?? defaultBaseRef),
    remoteName: env.SYNC_REMOTE_NAME?.trim() || defaultRemoteName,
    dryRun: parseBooleanFlag(env.SYNC_DRY_RUN, false),
    createConflictPullRequest: parseBooleanFlag(env.SYNC_CREATE_CONFLICT_PR, true),
  };
}

function writeActionsOutput(values: Record<string, string>): void {
  const outputPath = process.env.GITHUB_OUTPUT;
  if (!outputPath) {
    return;
  }

  for (const [key, value] of Object.entries(values)) {
    appendFileSync(outputPath, `${key}=${value.replace(/\n/gu, " ")}\n`);
  }
}

function appendStepSummary(markdown: string): void {
  const summaryPath = process.env.GITHUB_STEP_SUMMARY;
  if (!summaryPath) {
    return;
  }
  appendFileSync(summaryPath, `${markdown}\n`);
}

function ensureCleanWorktree(): void {
  const status = commandOutput("git", ["status", "--porcelain"]).trim();
  if (status) {
    throw new Error(
      "Refusing to run upstream source sync with a dirty worktree. Commit or discard local changes first.",
    );
  }
}

function configureGitIdentity(): void {
  runCommand("git", ["config", "user.name", "github-actions[bot]"]);
  runCommand("git", [
    "config",
    "user.email",
    "41898282+github-actions[bot]@users.noreply.github.com",
  ]);
}

function ensureRemote(remoteName: string, upstreamRepo: string): void {
  const upstreamUrl = `https://github.com/${upstreamRepo}.git`;
  const remoteExists = gitRemoteExists(remoteName);
  runCommand(
    "git",
    remoteExists
      ? ["remote", "set-url", remoteName, upstreamUrl]
      : ["remote", "add", remoteName, upstreamUrl],
  );
}

function resolveTargetRepository(): string {
  const configuredRepository =
    process.env.SYNC_TARGET_REPOSITORY?.trim() || process.env.GITHUB_REPOSITORY?.trim();
  if (configuredRepository) {
    return normalizeOwnerRepo(configuredRepository);
  }

  return normalizeOwnerRepo(commandOutput("git", ["remote", "get-url", "origin"]).trim());
}

function pushBranch(branchName: string, dryRun: boolean): void {
  if (dryRun) {
    console.log(`[dry-run] git push --force-with-lease origin ${branchName}:${branchName}`);
    return;
  }
  runCommand("git", ["push", "--force-with-lease", "origin", `${branchName}:${branchName}`]);
}

function upsertPullRequest(input: PullRequestDescriptionInput, dryRun: boolean): void {
  const title = buildPullRequestTitle({
    kind: input.kind,
    upstreamRef: input.upstreamRef,
    upstreamSha: input.upstreamSha,
  });
  const body = buildPullRequestBody(input);
  const bodyPath = resolve(".git", "moss-upstream-sync-pr-body.md");
  writeFileSync(bodyPath, body);

  if (dryRun) {
    console.log(`[dry-run] gh pr create/update ${input.branchName} -> ${input.baseRef}`);
    console.log(title);
    console.log(body);
    return;
  }

  if (!commandExists("gh")) {
    throw new Error("The gh CLI is required to create or update the upstream sync PR.");
  }

  const existingNumber = commandOutput("gh", [
    "pr",
    "list",
    "--state",
    "open",
    "--head",
    input.branchName,
    "--base",
    input.baseRef,
    "--json",
    "number",
    "--jq",
    '.[0].number // ""',
  ]).trim();

  if (existingNumber) {
    runCommand("gh", ["pr", "edit", existingNumber, "--title", title, "--body-file", bodyPath]);
    console.log(`Updated existing PR #${existingNumber}.`);
    return;
  }

  const args = [
    "pr",
    "create",
    "--base",
    input.baseRef,
    "--head",
    input.branchName,
    "--title",
    title,
    "--body-file",
    bodyPath,
  ];
  if (input.kind === "conflict") {
    args.push("--draft");
  }
  runCommand("gh", args);
}

export function publishSyncBranchWithPullRequest(
  input: PullRequestDescriptionInput,
  effects: SyncBranchPublicationEffects,
  reportPath?: string,
): void {
  effects.pushBranch();

  try {
    effects.upsertPullRequest();
  } catch (error) {
    const handoff = buildManualPullRequestHandoff({
      ...input,
      targetRepository: effects.resolveTargetRepository(),
      ...(effects.githubServerUrl ? { githubServerUrl: effects.githubServerUrl } : {}),
      ...(reportPath ? { reportPath } : {}),
    });
    effects.writeActionsOutput({
      status: handoff.status,
      branch: input.branchName,
      upstream_sha: input.upstreamSha,
      pr_kind: input.kind,
      compare_url: handoff.compareUrl,
      manual_pr_command: handoff.command,
      ...(reportPath ? { report_path: reportPath } : {}),
    });
    effects.appendStepSummary(handoff.summary);
    effects.annotate(handoff.annotation);
    throw new Error(
      `upstream source branch ${input.branchName} was pushed, but PR creation or update failed. Manual Draft PR required: ${handoff.compareUrl}`,
      { cause: error },
    );
  }
}

function publishBranchAndUpsertPullRequest(
  input: PullRequestDescriptionInput,
  dryRun: boolean,
  reportPath?: string,
): void {
  if (dryRun) {
    pushBranch(input.branchName, true);
    upsertPullRequest(input, true);
    return;
  }

  publishSyncBranchWithPullRequest(
    input,
    {
      pushBranch: () => pushBranch(input.branchName, false),
      upsertPullRequest: () => upsertPullRequest(input, false),
      resolveTargetRepository,
      ...(process.env.GITHUB_SERVER_URL ? { githubServerUrl: process.env.GITHUB_SERVER_URL } : {}),
      writeActionsOutput,
      appendStepSummary,
      annotate: (annotation) => console.error(annotation),
    },
    reportPath,
  );
}

function writeConflictReport(input: PullRequestDescriptionInput): string {
  const reportPath = `.moss/upstream-sync/${new Date().toISOString().replace(/[:.]/gu, "-")}-${shortSha(input.upstreamSha)}.md`;
  mkdirSync(dirname(reportPath), { recursive: true });
  writeFileSync(reportPath, buildPullRequestBody(input));
  return reportPath;
}

function main(): void {
  const options = resolveSyncOptions(process.env);
  ensureCleanWorktree();
  configureGitIdentity();
  ensureRemote(options.remoteName, options.upstreamRepo);

  runCommandWithRetry(
    "git",
    ["fetch", "origin", `+refs/heads/${options.baseRef}:refs/remotes/origin/${options.baseRef}`],
    3,
  );
  runCommandWithRetry(
    "git",
    [
      "fetch",
      options.remoteName,
      `+refs/heads/${options.upstreamRef}:refs/remotes/${options.remoteName}/${options.upstreamRef}`,
      "--prune",
    ],
    3,
  );

  const baseSha = commandOutput("git", [
    "rev-parse",
    `refs/remotes/origin/${options.baseRef}`,
  ]).trim();
  const upstreamRemoteRef = `refs/remotes/${options.remoteName}/${options.upstreamRef}`;
  const upstreamSha = commandOutput("git", ["rev-parse", upstreamRemoteRef]).trim();

  if (tryRunCommand("git", ["merge-base", "--is-ancestor", upstreamSha, baseSha])) {
    console.log(
      `No upstream source update to merge. ${options.baseRef} already contains ${upstreamSha}.`,
    );
    writeActionsOutput({ status: "up-to-date", upstream_sha: upstreamSha });
    appendStepSummary(
      `upstream source sync: no update needed. \`${options.baseRef}\` already contains \`${upstreamSha}\`.`,
    );
    return;
  }

  const mergeBranch = buildSyncBranchName({
    kind: "merge",
    upstreamRef: options.upstreamRef,
    upstreamSha,
  });
  runCommand("git", ["checkout", "-B", mergeBranch, baseSha]);

  if (tryRunCommand("git", ["merge", "--no-ff", "--no-edit", upstreamSha])) {
    const prInput: PullRequestDescriptionInput = {
      kind: "merge",
      upstreamRepo: options.upstreamRepo,
      upstreamRef: options.upstreamRef,
      upstreamSha,
      baseRef: options.baseRef,
      baseSha,
      branchName: mergeBranch,
      conflictFiles: [],
    };
    publishBranchAndUpsertPullRequest(prInput, options.dryRun);
    writeActionsOutput({ status: "pr-ready", branch: mergeBranch, upstream_sha: upstreamSha });
    appendStepSummary(
      `upstream source sync opened or updated \`${mergeBranch}\` for \`${upstreamSha}\`.`,
    );
    return;
  }

  const conflictFiles = commandOutput("git", ["diff", "--name-only", "--diff-filter=U"])
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
  tryRunCommand("git", ["merge", "--abort"]);

  if (!options.createConflictPullRequest) {
    throw new Error(`upstream source merge conflicted: ${conflictFiles.join(", ")}`);
  }

  const conflictBranch = buildSyncBranchName({
    kind: "conflict",
    upstreamRef: options.upstreamRef,
    upstreamSha,
  });
  const prInput: PullRequestDescriptionInput = {
    kind: "conflict",
    upstreamRepo: options.upstreamRepo,
    upstreamRef: options.upstreamRef,
    upstreamSha,
    baseRef: options.baseRef,
    baseSha,
    branchName: conflictBranch,
    conflictFiles,
  };

  runCommand("git", ["checkout", "-B", conflictBranch, baseSha]);
  const reportPath = writeConflictReport(prInput);
  runCommand("git", ["add", reportPath]);
  runCommand("git", [
    "commit",
    "-m",
    `chore(sync): record upstream source conflict ${shortSha(upstreamSha)}`,
  ]);
  publishBranchAndUpsertPullRequest(prInput, options.dryRun, reportPath);
  writeActionsOutput({
    status: "conflict-pr-ready",
    branch: conflictBranch,
    upstream_sha: upstreamSha,
  });
  appendStepSummary(
    `upstream source sync opened or updated conflict PR \`${conflictBranch}\` for \`${upstreamSha}\`.`,
  );
}

const thisFile = fileURLToPath(import.meta.url);
const invokedFile = process.argv[1] ? resolve(process.argv[1]) : "";
if (invokedFile === thisFile) {
  main();
}
