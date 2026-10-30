// Purpose: Produce the offline 1000-candidate catalog selection/ticket-verify receipt consumed by
//          the Moss control-plane integration gate.
// Scope: local deterministic benchmark only; it never contacts a catalog or paid provider.

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";

import { makeMossCatalogSelectionRpc } from "../apps/server/src/provider/mossCatalogSelectionRpc.ts";

const REPO_ROOT = resolve(import.meta.dir, "..");
const BUDGET_PATH = "scripts/fixtures/moss-control-plane-integration/performance-budgets.json";
const DEFAULT_OUTPUT_PATH = ".moss/ledger/evidence/moss-catalog-selection-1000.json";

interface CatalogSelectionBudget {
  readonly candidateCount: number;
  readonly requiredRuns: number;
  readonly maxP50Ms: number;
  readonly maxP95Ms: number;
  readonly maxMaxMs: number;
  readonly maxRssDeltaBytes: number;
  readonly maxCpuMs: number;
}

interface CatalogSelectionReceipt {
  readonly schemaVersion: 1;
  readonly kind: "moss-catalog-selection-1000-benchmark";
  readonly commitSha: string;
  readonly network: "disabled-by-construction";
  readonly paidProviders: false;
  readonly candidateCount: number;
  readonly selectionCount: number;
  readonly ticketVerifyCount: number;
  readonly requiredRuns: number;
  readonly runs: ReadonlyArray<{
    readonly run: number;
    readonly candidateCount: number;
    readonly selectionCount: number;
    readonly ticketVerifyCount: number;
    readonly elapsedMs: number;
    readonly rssBeforeBytes: number;
    readonly rssAfterBytes: number;
    readonly rssDeltaBytes: number;
    readonly cpuMs: number;
  }>;
  readonly summary: {
    readonly p50Ms: number;
    readonly p95Ms: number;
    readonly maxMs: number;
    readonly maxRssDeltaBytes: number;
    readonly maxCpuMs: number;
  };
}

function loadBudget(): CatalogSelectionBudget {
  const root = JSON.parse(readFileSync(resolve(REPO_ROOT, BUDGET_PATH), "utf8")) as {
    readonly budgets?: { readonly catalogSelection1000?: Partial<CatalogSelectionBudget> };
  };
  const budget = root.budgets?.catalogSelection1000;
  const candidateCount = budget?.candidateCount;
  const requiredRuns = budget?.requiredRuns;
  const maxP50Ms = budget?.maxP50Ms;
  const maxP95Ms = budget?.maxP95Ms;
  const maxMaxMs = budget?.maxMaxMs;
  const maxRssDeltaBytes = budget?.maxRssDeltaBytes;
  const maxCpuMs = budget?.maxCpuMs;
  if (
    candidateCount !== 1_000 ||
    typeof requiredRuns !== "number" ||
    !Number.isInteger(requiredRuns) ||
    requiredRuns < 3 ||
    typeof maxP50Ms !== "number" ||
    !Number.isFinite(maxP50Ms) ||
    typeof maxP95Ms !== "number" ||
    !Number.isFinite(maxP95Ms) ||
    typeof maxMaxMs !== "number" ||
    !Number.isFinite(maxMaxMs) ||
    typeof maxRssDeltaBytes !== "number" ||
    !Number.isFinite(maxRssDeltaBytes) ||
    typeof maxCpuMs !== "number" ||
    !Number.isFinite(maxCpuMs)
  ) {
    throw new Error("The catalog selection performance budget is missing or malformed.");
  }
  return {
    candidateCount,
    requiredRuns,
    maxP50Ms,
    maxP95Ms,
    maxMaxMs,
    maxRssDeltaBytes,
    maxCpuMs,
  };
}

function parseOutputPath(argv: ReadonlyArray<string>): string {
  for (let index = 0; index < argv.length; index += 1) {
    if (argv[index] !== "--output") continue;
    const value = argv[index + 1];
    if (!value || value.startsWith("--")) throw new Error("--output requires a value");
    return value;
  }
  return DEFAULT_OUTPUT_PATH;
}

function percentile(values: ReadonlyArray<number>, fraction: number): number {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.ceil(sorted.length * fraction) - 1)]!;
}

async function run(): Promise<CatalogSelectionReceipt> {
  const budget = loadBudget();
  const snapshotSha256 = "b".repeat(64);
  const runs: Array<CatalogSelectionReceipt["runs"][number]> = [];

  for (let runNumber = 1; runNumber <= budget.requiredRuns; runNumber += 1) {
    const rpc = makeMossCatalogSelectionRpc({
      now: () => new Date("2026-08-09T00:00:00.000Z"),
      resolveCandidate: async ({ kind, candidateId }) => ({
        artifact: {
          url: `https://catalog.example/artifacts/${candidateId}.tgz`,
          sha256: "a".repeat(64),
        },
        snapshotSha256,
        resourceIds: [`${kind}:${candidateId}`],
      }),
      issueTicket: async ({ candidateId }) => ({
        token: `ticket-${candidateId}`,
        expiresAt: "2099-08-09T00:00:00.000Z",
      }),
      verifyTicket: async ({ candidateId }) => ({ candidateId, verified: true }),
    });
    const rssBeforeBytes = process.memoryUsage().rss;
    const cpuBefore = process.cpuUsage();
    const startedAt = performance.now();
    const tickets = await Promise.all(
      Array.from({ length: budget.candidateCount }, (_, index) => {
        const candidateId = `candidate-${index}`;
        return rpc.select(
          { kind: "plugin", candidateId },
          {
            actorId: "offline-benchmark-actor",
            workspaceId: "offline-benchmark-workspace",
            workspaceRoot: "/offline/benchmark-workspace",
          },
        );
      }),
    );
    await Promise.all(
      tickets.map((ticket, index) =>
        rpc.verify({
          ticket: ticket.token,
          ownerId: "offline-benchmark-actor",
          workspaceId: "offline-benchmark-workspace",
          workspaceRoot: "/offline/benchmark-workspace",
          selectionSnapshotSha256: snapshotSha256,
          resourceIds: [`plugin:candidate-${index}`],
        }),
      ),
    );
    const elapsedMs = performance.now() - startedAt;
    const cpu = process.cpuUsage(cpuBefore);
    const rssAfterBytes = process.memoryUsage().rss;
    runs.push({
      run: runNumber,
      candidateCount: budget.candidateCount,
      selectionCount: tickets.length,
      ticketVerifyCount: tickets.length,
      elapsedMs: Number(elapsedMs.toFixed(3)),
      rssBeforeBytes,
      rssAfterBytes,
      rssDeltaBytes: rssAfterBytes - rssBeforeBytes,
      cpuMs: Number(((cpu.user + cpu.system) / 1_000).toFixed(3)),
    });
  }

  const elapsed = runs.map((run) => run.elapsedMs);
  return {
    schemaVersion: 1,
    kind: "moss-catalog-selection-1000-benchmark",
    commitSha: execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: REPO_ROOT,
      encoding: "utf8",
    }).trim(),
    network: "disabled-by-construction",
    paidProviders: false,
    candidateCount: budget.candidateCount,
    selectionCount: budget.candidateCount,
    ticketVerifyCount: budget.candidateCount,
    requiredRuns: budget.requiredRuns,
    runs,
    summary: {
      p50Ms: percentile(elapsed, 0.5),
      p95Ms: percentile(elapsed, 0.95),
      maxMs: Math.max(...elapsed),
      maxRssDeltaBytes: Math.max(...runs.map((run) => run.rssDeltaBytes)),
      maxCpuMs: Math.max(...runs.map((run) => run.cpuMs)),
    },
  };
}

async function main(): Promise<void> {
  const outputPath = resolve(REPO_ROOT, parseOutputPath(process.argv.slice(2)));
  const receipt = await run();
  mkdirSync(dirname(outputPath), { recursive: true });
  writeFileSync(outputPath, `${JSON.stringify(receipt, null, 2)}\n`, {
    encoding: "utf8",
    mode: 0o600,
  });
  process.stdout.write(`${JSON.stringify({ outputPath, ...receipt }, null, 2)}\n`);
}

main().catch((error: unknown) => {
  process.stderr.write(
    `${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 1;
});
