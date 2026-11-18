// Time-aware shards for the component browser tests in CI.
//
// Vitest's default sharding sorts files by a hash of their path and cuts the list into equal
// counts, so the heaviest files can land together: on run 44257808420 shard 4/4 drew
// ProvidersSettingsPanel (96 s), EventRouter (86 s) and ThemeCssHooks (62 s) and took 473 s while
// shard 2/4 took 189 s. This sequencer assigns files by their recorded time instead, longest first,
// each to the least-loaded shard (shard 1 starts with the compiler and geometry steps it also runs).
// Every shard computes the same partition, so each file runs exactly once; a file without a record
// gets the median time. `--shard=k/n` keeps working.
//
// Regenerate the times from the browser job logs of a mirror run:
//   node apps/web/src/test/durationShardSequencer.ts <job log> [<job log> ...]
import { readFileSync, writeFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { BaseSequencer, type TestSpecification } from "vitest/node";

const DURATIONS_FILE = fileURLToPath(new URL("./browserFileDurations.json", import.meta.url));

export interface FileDurations {
  readonly perFileOverheadSeconds: number;
  readonly shardOneExtraSeconds: number;
  readonly seconds: Readonly<Record<string, number>>;
}

export function readFileDurations(file = DURATIONS_FILE): FileDurations {
  return JSON.parse(readFileSync(file, "utf8")) as FileDurations;
}

function median(values: readonly number[]): number {
  if (values.length === 0) return 1;
  const sorted = values.toSorted((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)]!;
}

/**
 * Splits `keys` into `count` shards of about equal total time: longest first, each to the shard
 * with the least load so far (lowest index on a tie). Deterministic for a given input.
 */
export function partitionByDuration(
  keys: readonly string[],
  count: number,
  durations: FileDurations,
): string[][] {
  const fallback = median(Object.values(durations.seconds));
  const cost = (key: string) =>
    (durations.seconds[key] ?? fallback) + durations.perFileOverheadSeconds;
  const shards = Array.from({ length: count }, () => [] as string[]);
  const load = Array.from({ length: count }, (_, index) =>
    index === 0 ? durations.shardOneExtraSeconds : 0,
  );
  const ordered = [...new Set(keys)].toSorted((a, b) => cost(b) - cost(a) || a.localeCompare(b));
  for (const key of ordered) {
    let target = 0;
    for (let index = 1; index < count; index += 1) {
      if (load[index]! < load[target]!) target = index;
    }
    shards[target]!.push(key);
    load[target]! += cost(key);
  }
  return shards;
}

export class DurationShardSequencer extends BaseSequencer {
  override async shard(files: TestSpecification[]): Promise<TestSpecification[]> {
    const shard = this.ctx.config.shard;
    if (!shard) return files;
    const root = this.ctx.config.root;
    const keyOf = (spec: TestSpecification) => relative(root, spec.moduleId).replaceAll("\\", "/");
    const mine = new Set(
      partitionByDuration(files.map(keyOf), shard.count, readFileDurations())[shard.index - 1],
    );
    return files.filter((spec) => mine.has(keyOf(spec)));
  }
}

/** Per-file seconds from Vitest's default reporter lines in CI job logs. */
export function parseFileDurations(log: string): Record<string, number> {
  const seconds: Record<string, number> = {};
  // oxlint-disable-next-line no-control-regex
  const plain = log.replace(/\u001b\[[0-9;]*m/g, "");
  for (const match of plain.matchAll(
    /(?:✓|❯|×)\s+(?:[a-z]+ \(chromium\)\s+)?(\S+\.browser\.tsx?)\s+\(\d+ tests?[^)]*\)\s+([\d.]+)\s*(ms|s)\b/g,
  )) {
    const value = Number(match[2]) / (match[3] === "ms" ? 1000 : 1);
    seconds[match[1]!] = Math.round(value * 10) / 10;
  }
  return seconds;
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const logs = process.argv.slice(2);
  if (logs.length === 0) throw new Error("usage: durationShardSequencer.ts <job log>...");
  const seconds = Object.assign(
    {},
    ...logs.map((file) => parseFileDurations(readFileSync(file, "utf8"))),
  ) as Record<string, number>;
  const current = readFileDurations();
  writeFileSync(
    DURATIONS_FILE,
    `${JSON.stringify(
      {
        ...current,
        seconds: Object.fromEntries(
          Object.entries(seconds).toSorted(([a], [b]) => a.localeCompare(b)),
        ),
      },
      null,
      2,
    )}\n`,
  );
  console.log(`${Object.keys(seconds).length} file times written to ${DURATIONS_FILE}`);
}
