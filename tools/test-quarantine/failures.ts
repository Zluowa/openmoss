// `node tools/test-quarantine/failures.ts <log> [--dir <package dir>] [--platform <platform>]
// [--progress <file>]`: lists the failing tests in a Vitest (or turbo-prefixed Vitest)
// transcript and says, for each, whether test-quarantine.json covers it on that platform, on
// another platform only, or not at all. Prints Markdown, so CI can append it to the job summary
// and a person sees at once which test failed and whether it is a known one. With --progress
// (the file watchdog.ts writes) it also
// names the files the per-file time limit stopped and the files still running when the run was
// stopped, e.g. by a step timeout. Never fails the step itself.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  QUARANTINE_FILE,
  nameCovers,
  parseQuarantineId,
  type QuarantineEntry,
} from "./quarantine.ts";
import { parseProgress } from "./watchdog.ts";

export interface FailedTest {
  /** Repository-relative, forward slashes. */
  readonly file: string;
  /** Describe blocks and title joined by " > "; absent when the whole file failed to run. */
  readonly name?: string;
}

export type FailureStatus =
  | { readonly kind: "quarantined"; readonly entry: QuarantineEntry }
  | { readonly kind: "other-platform"; readonly entry: QuarantineEntry }
  | { readonly kind: "not-quarantined" };

/** Turbo task prefixes and the folders of the workspaces they name. */
const PACKAGE_DIRS: Readonly<Record<string, string>> = {
  "@moss/cli": "apps/server",
  "@moss/web": "apps/web",
  "@moss/desktop": "apps/desktop",
  "@moss/shared": "packages/shared",
  "@moss/contracts": "packages/contracts",
  "@moss/scripts": "scripts",
};

// ANSI colour codes in captured transcripts, also in the caret form (`^[[31m`) that
// `gh run view --log-failed` prints on Windows.
// oxlint-disable-next-line no-control-regex
const ANSI = /(?:\u001b|\^\[)\[[0-9;]*m/g;

export function parseVitestFailures(log: string, defaultDir = ""): FailedTest[] {
  const seen = new Set<string>();
  const failures: FailedTest[] = [];
  for (const raw of log.replace(ANSI, "").split(/\r?\n/)) {
    let line = raw;
    let dir = defaultDir;
    const prefix = /^\s*(@[\w-]+\/[\w-]+):[\w:-]+:\s?/.exec(line);
    if (prefix) {
      dir = PACKAGE_DIRS[prefix[1]!] ?? dir;
      line = line.slice(prefix[0].length);
    }
    // A browser run names its project before the file: "|components (chromium)|" in plain
    // output, "components (chromium)" once the colours are stripped.
    const match =
      /^\s*FAIL\s+(?:\|[^|]+\|\s+|[\w-]+ \([\w-]+\)\s+)?(\S[^>]*?)(?:\s+>\s+(.+?))?\s*(?:\[[^\]]*\])?\s*$/.exec(
        line,
      );
    if (!match) continue;
    const file = match[1]!.replaceAll("\\", "/");
    if (!/\.(test|spec|browser)\.[cm]?[jt]sx?$|\.test\.[cm]?[jt]sx?$/.test(file)) continue;
    const repoFile = dir && !file.startsWith(`${dir}/`) ? `${dir}/${file}` : file;
    const name = match[2]?.trim();
    const key = `${repoFile} > ${name ?? ""}`;
    if (seen.has(key)) continue;
    seen.add(key);
    failures.push(name ? { file: repoFile, name } : { file: repoFile });
  }
  return failures;
}

export function classifyFailure(
  failure: FailedTest,
  entries: readonly QuarantineEntry[],
  platform: string,
): FailureStatus {
  let otherPlatform: QuarantineEntry | undefined;
  for (const entry of entries) {
    const parsed = parseQuarantineId(entry.id);
    if (!parsed || parsed.file !== failure.file) continue;
    if (
      parsed.name !== undefined &&
      (failure.name === undefined || !nameCovers(parsed.name, failure.name))
    ) {
      continue;
    }
    if (entry.platform === "all" || entry.platform === platform)
      return { kind: "quarantined", entry };
    otherPlatform ??= entry;
  }
  return otherPlatform
    ? { kind: "other-platform", entry: otherPlatform }
    : { kind: "not-quarantined" };
}

const cell = (text: string) => text.replaceAll("|", "\\|").replace(/\s+/g, " ");

export function renderFailureSummary(
  failures: readonly FailedTest[],
  entries: readonly QuarantineEntry[],
  platform: string,
): string {
  if (failures.length === 0) return "No failing test names found in the transcript.\n";
  const rows = failures.map((failure) => {
    const status = classifyFailure(failure, entries, platform);
    const state =
      status.kind === "quarantined"
        ? `quarantined (${status.entry.owner}, until ${status.entry.expires})`
        : status.kind === "other-platform"
          ? `quarantined on ${status.entry.platform} only: a real failure here`
          : "not quarantined: a real failure";
    return `| \`${cell(failure.file)}\` | ${cell(failure.name ?? "(whole file)")} | ${state} |`;
  });
  const fresh = failures.filter(
    (f) => classifyFailure(f, entries, platform).kind !== "quarantined",
  );
  return [
    `### Failed tests (${failures.length}; ${fresh.length} not quarantined on ${platform})`,
    "",
    "| File | Test | Quarantine |",
    "| --- | --- | --- |",
    ...rows,
    "",
  ].join("\n");
}

/** Markdown for the files a stopped run left behind; empty when every started file finished. */
export function renderProgressSummary(progress: string): string {
  const { unfinished, overLimit } = parseProgress(progress);
  const lines: string[] = [];
  if (overLimit.length > 0) {
    lines.push(
      `### Stopped by the per-file time limit (${overLimit.length})`,
      "",
      "| File | Tests running at the limit |",
      "| --- | --- |",
      ...overLimit.map(
        ({ file, tests }) =>
          `| \`${cell(file)}\` | ${cell(tests || "(none started: hung while loading or in a hook)")} |`,
      ),
      "",
    );
  }
  if (unfinished.length > 0) {
    lines.push(
      `### Test files still running when the run stopped (${unfinished.length})`,
      "",
      ...unfinished.map((file) => `- \`${file}\``),
      "",
    );
  }
  return lines.join("\n");
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const args = process.argv.slice(2);
  const option = (name: string) => {
    const index = args.indexOf(name);
    return index === -1 ? undefined : args.splice(index, 2)[1];
  };
  const dir = option("--dir") ?? "";
  const platform = option("--platform") ?? process.platform;
  const progressFile = option("--progress");
  const logFile = args[0];
  try {
    if (!logFile)
      throw new Error(
        "usage: failures.ts <log> [--dir <package dir>] [--platform <platform>] [--progress <file>]",
      );
    const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
    const entries = JSON.parse(
      readFileSync(join(repoRoot, QUARANTINE_FILE), "utf8"),
    ) as QuarantineEntry[];
    const log = logFile === "-" ? readFileSync(0, "utf8") : readFileSync(logFile, "utf8");
    process.stdout.write(renderFailureSummary(parseVitestFailures(log, dir), entries, platform));
    if (progressFile && existsSync(progressFile)) {
      process.stdout.write(renderProgressSummary(readFileSync(progressFile, "utf8")));
    }
  } catch (error) {
    // A summary is a convenience: never turn a red run into a confusing second error.
    process.stdout.write(
      `Could not summarize failed tests: ${error instanceof Error ? error.message : String(error)}\n`,
    );
  }
}
