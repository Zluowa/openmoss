import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

export const MOSS_CHAINED_REFRESH_PROVENANCE_KIND = "release-artifact-chain-freshness" as const;

export type MossChainedRefreshProvenanceSource =
  | "task-ledger-metadata"
  | "event-payload-metadata"
  | "loop-packet-task-metadata";

export interface MossChainedRefreshProvenance {
  readonly kind: typeof MOSS_CHAINED_REFRESH_PROVENANCE_KIND;
  readonly expected: true;
  readonly taskId: string;
  readonly source: MossChainedRefreshProvenanceSource;
}

export const MOSS_EXPLICIT_CHAINED_PROVENANCE_BOOTSTRAP_MARKERS = [
  "cannot prove explicit chained freshness provenance for loop packet freshness report",
  "cannot prove explicit chained freshness provenance for loop packet refresh-plan report",
  "has stale chained observed evidence for release freshness refresh-plan report",
  "has stale chained observed evidence for loop packet freshness report",
  "has stale chained observed evidence for loop packet refresh-plan report",
  "has stale chained observed evidence for loop packet freshness report: readinessStatus=fail",
  "has stale chained provenance for loop packet freshness report",
  "has stale chained provenance for loop packet refresh-plan report",
] as const;

const TASK_LEDGER_PATH = ".moss/ledger/tasks.jsonl";
const EVENT_LEDGER_PATH = ".moss/ledger/events.jsonl";

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function provenanceSource(value: unknown): MossChainedRefreshProvenanceSource | undefined {
  if (
    value === "task-ledger-metadata" ||
    value === "event-payload-metadata" ||
    value === "loop-packet-task-metadata"
  ) {
    return value;
  }
  return undefined;
}

export function isMossExplicitChainedProvenanceBootstrapMessage(message: string): boolean {
  return MOSS_EXPLICIT_CHAINED_PROVENANCE_BOOTSTRAP_MARKERS.some((marker) =>
    message.includes(marker),
  );
}

function explicitProvenanceValue(value: unknown): unknown {
  if (!isObject(value)) {
    return undefined;
  }
  if (isObject(value.chainedRefreshProvenance)) {
    return value.chainedRefreshProvenance;
  }
  if (isObject(value.latestChainedRefreshProvenance)) {
    return value.latestChainedRefreshProvenance;
  }
  return isObject(value.metadata) && isObject(value.metadata.chainedRefreshProvenance)
    ? value.metadata.chainedRefreshProvenance
    : undefined;
}

export function parseMossTaskNumber(taskId: string | undefined): number | null {
  if (!taskId) {
    return null;
  }
  const match = /^moss-task-(\d+)$/.exec(taskId);
  return match?.[1] ? Number.parseInt(match[1], 10) : null;
}

export function mossTaskIdIsOlder(left: string, right: string): boolean {
  const leftNumber = parseMossTaskNumber(left);
  const rightNumber = parseMossTaskNumber(right);
  return leftNumber !== null && rightNumber !== null && leftNumber < rightNumber;
}

export function parseMossChainedRefreshProvenance(input: {
  readonly value: unknown;
  readonly fallbackTaskId?: string | undefined;
  readonly fallbackSource: MossChainedRefreshProvenanceSource;
}): MossChainedRefreshProvenance | undefined {
  const provenance = explicitProvenanceValue(input.value);
  if (!isObject(provenance)) {
    return undefined;
  }
  const taskId =
    typeof provenance.taskId === "string" && provenance.taskId.length > 0
      ? provenance.taskId
      : input.fallbackTaskId;
  if (
    provenance.kind !== MOSS_CHAINED_REFRESH_PROVENANCE_KIND ||
    provenance.expected !== true ||
    !taskId
  ) {
    return undefined;
  }

  return {
    kind: MOSS_CHAINED_REFRESH_PROVENANCE_KIND,
    expected: true,
    taskId,
    source: provenanceSource(provenance.source) ?? input.fallbackSource,
  };
}

function readJsonLines(path: string): ReadonlyArray<unknown> {
  if (!existsSync(path)) {
    return [];
  }

  return readFileSync(path, "utf8")
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .flatMap((line) => {
      try {
        return [JSON.parse(line) as unknown];
      } catch {
        return [];
      }
    });
}

function latestProvenance(
  candidates: ReadonlyArray<MossChainedRefreshProvenance>,
): MossChainedRefreshProvenance | undefined {
  let latest: MossChainedRefreshProvenance | undefined;
  let latestTaskNumber = -1;

  for (const candidate of candidates) {
    const taskNumber = parseMossTaskNumber(candidate.taskId);
    if (taskNumber !== null && taskNumber > latestTaskNumber) {
      latest = candidate;
      latestTaskNumber = taskNumber;
    }
  }

  return latest;
}

export function readExpectedMossChainedRefreshProvenance(
  repoRoot: string,
): MossChainedRefreshProvenance | undefined {
  const taskCandidates = readJsonLines(join(repoRoot, TASK_LEDGER_PATH)).flatMap((entry) => {
    if (!isObject(entry) || typeof entry.taskId !== "string") {
      return [];
    }
    const provenance = parseMossChainedRefreshProvenance({
      value: entry,
      fallbackTaskId: entry.taskId,
      fallbackSource: "task-ledger-metadata",
    });
    return provenance ? [provenance] : [];
  });

  const eventCandidates = readJsonLines(join(repoRoot, EVENT_LEDGER_PATH)).flatMap((entry) => {
    if (!isObject(entry) || !isObject(entry.payload)) {
      return [];
    }
    const fallbackTaskId =
      typeof entry.payload.taskId === "string" ? entry.payload.taskId : undefined;
    const provenance = parseMossChainedRefreshProvenance({
      value: entry.payload,
      fallbackTaskId,
      fallbackSource: "event-payload-metadata",
    });
    return provenance ? [provenance] : [];
  });

  return latestProvenance([...taskCandidates, ...eventCandidates]);
}
