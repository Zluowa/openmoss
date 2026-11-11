// `bun run test-quarantine:check` (part of `bun run lint`): fails on an invalid, expired,
// ownerless or oversized quarantine list. `--today YYYY-MM-DD` overrides the date.
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { MAX_ENTRIES, QUARANTINE_FILE, utcToday, validateQuarantine } from "./quarantine.ts";

export function checkQuarantineFile(
  repoRoot: string,
  today: string,
): { readonly problems: string[]; readonly count: number } {
  const file = resolve(repoRoot, QUARANTINE_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (error) {
    return { problems: [`${QUARANTINE_FILE}: ${(error as Error).message}`], count: 0 };
  }
  const problems = validateQuarantine(raw, {
    today,
    fileExists: (path) => existsSync(resolve(repoRoot, path)),
  });
  return { problems, count: Array.isArray(raw) ? raw.length : 0 };
}

function main(argv: readonly string[]): number {
  const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
  const todayIndex = argv.indexOf("--today");
  const today = todayIndex === -1 ? utcToday() : (argv[todayIndex + 1] ?? "");
  const { problems, count } = checkQuarantineFile(repoRoot, today);
  if (problems.length > 0) {
    console.error(`${QUARANTINE_FILE} has ${problems.length} problem(s):`);
    for (const problem of problems) console.error(`- ${problem}`);
    return 1;
  }
  console.log(`${QUARANTINE_FILE}: ${count}/${MAX_ENTRIES} entries, none expired (${today}).`);
  return 0;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  process.exitCode = main(process.argv.slice(2));
}
