// FILE: run-golden-suite.ts
// Purpose: Layer 3 Golden 30 & Nightly QA Runner. Executes or smoke-checks the 30 core Moss journeys
//          defined in scripts/ops/golden-journeys.json and atomically writes golden-latest.json.
// Layer: Factory 2.0 QA Ops
// Exports: loadGoldenJourneys, validateGoldenJourneys, summarizeGoldenResults, writeAtomicJson, runGoldenSuite

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

export type GoldenDomain = "desktop" | "mobile" | "online";
export type GoldenRunMode = "dry-run" | "smoke" | "full";
export type GoldenJourneyStatus = "pass" | "fail" | "skip";

export interface GoldenCommandCheck {
  readonly kind: "command";
  readonly command: string;
  readonly args: readonly string[];
  readonly timeoutMs: number;
}

export interface GoldenHttpCheck {
  readonly kind: "http";
  readonly url: string;
  readonly expectedStatuses: readonly number[];
  readonly timeoutMs: number;
}

export type GoldenCheck = GoldenCommandCheck | GoldenHttpCheck;

export interface GoldenJourney {
  readonly id: string;
  readonly title: string;
  readonly domain: GoldenDomain;
  readonly owner: string;
  readonly featureMap: string;
  readonly smokeSafe: boolean;
  readonly check: GoldenCheck;
}

export interface GoldenJourneysConfig {
  readonly version: string;
  readonly journeys: readonly GoldenJourney[];
}

export interface GoldenJourneyResult {
  readonly id: string;
  readonly title: string;
  readonly domain: GoldenDomain;
  readonly owner: string;
  readonly featureMap: string;
  readonly status: GoldenJourneyStatus;
  readonly durationMs: number;
  readonly detail: string;
}

export interface GoldenDomainSummary {
  readonly total: number;
  readonly passed: number;
  readonly failed: number;
  readonly skipped: number;
}

export interface GoldenReport {
  readonly schemaVersion: 1;
  readonly generatedAt: string;
  readonly updatedAt: string;
  readonly mode: GoldenRunMode;
  readonly commit: string;
  readonly summary: {
    readonly total: number;
    readonly executed: number;
    readonly passed: number;
    readonly failed: number;
    readonly skipped: number;
    readonly passRate: number;
    readonly durationMs: number;
    readonly status: "green" | "degraded" | "red";
  };
  readonly byDomain: Readonly<Record<GoldenDomain, GoldenDomainSummary>>;
  readonly byOwner: Readonly<Record<string, GoldenDomainSummary>>;
  readonly journeys: readonly GoldenJourneyResult[];
}

export function defaultGoldenOutputPath(): string {
  if (process.env.MOSS_GOLDEN_OUTPUT) return process.env.MOSS_GOLDEN_OUTPUT;
  return process.platform === "win32"
    ? join("D:\\DevTemp", "moss-ops", "golden-latest.json")
    : join(tmpdir(), "moss-ops", "golden-latest.json");
}

export function loadGoldenJourneys(configPath: string): GoldenJourneysConfig {
  return JSON.parse(readFileSync(configPath, "utf8")) as GoldenJourneysConfig;
}

export function validateGoldenJourneys(
  config: GoldenJourneysConfig,
  validOwners?: ReadonlySet<string>,
): string[] {
  const errors: string[] = [];
  if (!Array.isArray(config.journeys) || config.journeys.length !== 30) {
    errors.push(
      `Expected exactly 30 golden journeys, found ${Array.isArray(config.journeys) ? config.journeys.length : 0}.`,
    );
  }
  const seen = new Set<string>();
  for (const journey of config.journeys ?? []) {
    if (!journey.id || !/^GJ-\d{2}$/.test(journey.id)) {
      errors.push(`Invalid journey id "${journey.id}".`);
    } else if (seen.has(journey.id)) {
      errors.push(`Duplicate journey id "${journey.id}".`);
    }
    seen.add(journey.id);
    if (!["desktop", "mobile", "online"].includes(journey.domain)) {
      errors.push(`${journey.id}: invalid domain "${journey.domain}".`);
    }
    if (validOwners && !validOwners.has(journey.owner)) {
      errors.push(`${journey.id}: unknown module owner "${journey.owner}".`);
    }
    if (!journey.check || (journey.check.kind !== "command" && journey.check.kind !== "http")) {
      errors.push(`${journey.id}: invalid check kind.`);
    }
  }
  return errors;
}

export function summarizeGoldenResults(
  results: readonly GoldenJourneyResult[],
  meta: { readonly mode: GoldenRunMode; readonly commit: string; readonly durationMs: number },
): GoldenReport {
  const domains: Record<
    GoldenDomain,
    { total: number; passed: number; failed: number; skipped: number }
  > = {
    desktop: { total: 0, passed: 0, failed: 0, skipped: 0 },
    mobile: { total: 0, passed: 0, failed: 0, skipped: 0 },
    online: { total: 0, passed: 0, failed: 0, skipped: 0 },
  };
  const owners: Record<string, { total: number; passed: number; failed: number; skipped: number }> =
    {};

  let passed = 0;
  let failed = 0;
  let skipped = 0;
  for (const r of results) {
    const d = domains[r.domain];
    const o = (owners[r.owner] ??= { total: 0, passed: 0, failed: 0, skipped: 0 });
    d.total += 1;
    o.total += 1;
    if (r.status === "pass") {
      passed += 1;
      d.passed += 1;
      o.passed += 1;
    } else if (r.status === "fail") {
      failed += 1;
      d.failed += 1;
      o.failed += 1;
    } else {
      skipped += 1;
      d.skipped += 1;
      o.skipped += 1;
    }
  }

  const executed = passed + failed;
  const passRate = executed > 0 ? Math.round((passed / executed) * 1000) / 10 : 100;
  const status = failed === 0 ? "green" : passed > 0 ? "degraded" : "red";

  const nowIso = new Date().toISOString();
  return {
    schemaVersion: 1,
    generatedAt: nowIso,
    updatedAt: nowIso,
    mode: meta.mode,
    commit: meta.commit,
    summary: {
      total: results.length,
      executed,
      passed,
      failed,
      skipped,
      passRate,
      durationMs: meta.durationMs,
      status,
    },
    byDomain: domains,
    byOwner: owners,
    journeys: results,
  };
}

export function writeAtomicJson(outputPath: string, data: unknown): void {
  const abs = resolve(outputPath);
  mkdirSync(dirname(abs), { recursive: true });
  const tempPath = `${abs}.${process.pid}.${Date.now()}.tmp`;
  writeFileSync(tempPath, `${JSON.stringify(data, null, 2)}\n`, "utf8");
  renameSync(tempPath, abs);
}

function resolveExecutable(command: string): string {
  if (command === "bun" && process.platform === "win32") {
    const pinnedBun = "E:/DevEnvs/moss-synara/bun-1.4.4/bun-windows-x64/bun.exe";
    if (existsSync(pinnedBun)) return pinnedBun;
  }
  return command;
}

function currentCommit(repoRoot: string): string {
  const res = spawnSync("git", ["rev-parse", "--short", "HEAD"], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: 5000,
  });
  return res.status === 0 ? res.stdout.trim() : "unknown";
}

async function runHttpCheck(check: GoldenHttpCheck): Promise<{ ok: boolean; detail: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), check.timeoutMs);
  try {
    const response = await fetch(check.url, {
      method: "GET",
      redirect: "follow",
      signal: controller.signal,
    });
    const ok = check.expectedStatuses.includes(response.status);
    return {
      ok,
      detail: `HTTP ${response.status} (${check.url})`,
    };
  } catch (error) {
    return {
      ok: false,
      detail: `Fetch failed (${check.url}): ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    clearTimeout(timer);
  }
}

function runCommandCheck(
  repoRoot: string,
  check: GoldenCommandCheck,
): { ok: boolean; detail: string } {
  const executable = resolveExecutable(check.command);
  const res = spawnSync(executable, [...check.args], {
    cwd: repoRoot,
    encoding: "utf8",
    windowsHide: true,
    timeout: check.timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  });
  const ok = res.status === 0 && !res.error;
  const tail = `${res.stdout ?? ""}\n${res.stderr ?? ""}`
    .trim()
    .split(/\r?\n/)
    .filter(Boolean)
    .slice(-2)
    .join(" | ")
    .slice(0, 220);
  if (ok) {
    return { ok: true, detail: tail || `${check.command} ${check.args.join(" ")} exited 0` };
  }
  const errDetail = res.error ? res.error.message : `exit ${res.status ?? "null"}`;
  return { ok: false, detail: `${errDetail}: ${tail}`.slice(0, 260) };
}

export async function runGoldenSuite(options: {
  readonly repoRoot: string;
  readonly mode: GoldenRunMode;
  readonly outputPath: string;
  readonly configPath?: string;
}): Promise<GoldenReport> {
  const configPath =
    options.configPath ?? join(options.repoRoot, "scripts", "ops", "golden-journeys.json");
  const config = loadGoldenJourneys(configPath);

  let validOwners: ReadonlySet<string> | undefined;
  const modulesPath = join(options.repoRoot, "docs", "factory", "modules.json");
  if (existsSync(modulesPath)) {
    const parsed = JSON.parse(readFileSync(modulesPath, "utf8")) as {
      modules?: Array<{ id: string }>;
    };
    validOwners = new Set((parsed.modules ?? []).map((m) => m.id));
  }

  const schemaErrors = validateGoldenJourneys(config, validOwners);
  if (schemaErrors.length > 0) {
    throw new Error(`Invalid golden-journeys.json:\n- ${schemaErrors.join("\n- ")}`);
  }

  const startedAt = Date.now();
  const results: GoldenJourneyResult[] = [];

  for (const journey of config.journeys) {
    const jStart = Date.now();
    if (options.mode === "dry-run") {
      const featureExists = existsSync(join(options.repoRoot, journey.featureMap));
      results.push({
        id: journey.id,
        title: journey.title,
        domain: journey.domain,
        owner: journey.owner,
        featureMap: journey.featureMap,
        status: featureExists ? "pass" : "fail",
        durationMs: Date.now() - jStart,
        detail: featureExists
          ? "dry-run validated schema, owner & featureMap"
          : `missing featureMap ${journey.featureMap}`,
      });
      continue;
    }

    if (options.mode === "smoke" && !journey.smokeSafe) {
      results.push({
        id: journey.id,
        title: journey.title,
        domain: journey.domain,
        owner: journey.owner,
        featureMap: journey.featureMap,
        status: "skip",
        durationMs: 0,
        detail: "skipped in --smoke mode (runs in --full nightly schedule)",
      });
      continue;
    }

    const outcome =
      journey.check.kind === "http"
        ? await runHttpCheck(journey.check)
        : runCommandCheck(options.repoRoot, journey.check);

    results.push({
      id: journey.id,
      title: journey.title,
      domain: journey.domain,
      owner: journey.owner,
      featureMap: journey.featureMap,
      status: outcome.ok ? "pass" : "fail",
      durationMs: Date.now() - jStart,
      detail: outcome.detail,
    });
  }

  const report = summarizeGoldenResults(results, {
    mode: options.mode,
    commit: currentCommit(options.repoRoot),
    durationMs: Date.now() - startedAt,
  });
  writeAtomicJson(options.outputPath, report);
  return report;
}

async function main(): Promise<void> {
  const args = process.argv.slice(2);
  const mode: GoldenRunMode = args.includes("--full")
    ? "full"
    : args.includes("--smoke")
      ? "smoke"
      : "dry-run";
  const outIdx = args.indexOf("--output");
  const outputPath =
    outIdx >= 0 && args[outIdx + 1] ? args[outIdx + 1]! : defaultGoldenOutputPath();
  const repoRoot = resolve(import.meta.dirname, "..", "..");

  const report = await runGoldenSuite({ repoRoot, mode, outputPath });
  if (args.includes("--json")) {
    console.log(JSON.stringify(report, null, 2));
  } else {
    console.log(
      `Golden 30 (${report.mode}): ${report.summary.passed}/${report.summary.executed} passed (${report.summary.skipped} skipped, ${report.summary.failed} failed) -> ${outputPath}`,
    );
  }
  if (args.includes("--strict") && report.summary.failed > 0) {
    process.exitCode = 1;
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  await main();
}
