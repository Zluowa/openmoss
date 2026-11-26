import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  loadGoldenJourneys,
  runGoldenSuite,
  summarizeGoldenResults,
  validateGoldenJourneys,
  type GoldenJourneyResult,
} from "./run-golden-suite.ts";

const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe("Layer 3 Golden 30 & Nightly QA Runner", () => {
  it("defines 30 valid journeys across desktop, mobile, and online with valid owners", () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const configPath = path.join(repoRoot, "scripts", "ops", "golden-journeys.json");
    const config = loadGoldenJourneys(configPath);
    expect(config.journeys).toHaveLength(30);

    const domains = new Set(config.journeys.map((j) => j.domain));
    expect(domains).toEqual(new Set(["desktop", "mobile", "online"]));

    const modulesPath = path.join(repoRoot, "docs", "factory", "modules.json");
    const validOwners = existsSync(modulesPath)
      ? new Set(
          (
            JSON.parse(readFileSync(modulesPath, "utf8")) as { modules: Array<{ id: string }> }
          ).modules.map((m) => m.id),
        )
      : undefined;

    expect(validateGoldenJourneys(config, validOwners)).toEqual([]);
  });

  it("summarizes domain, owner, passRate, and degraded status accurately", () => {
    const sample: GoldenJourneyResult[] = [
      {
        id: "GJ-01",
        title: "Chat",
        domain: "desktop",
        owner: "moss-desktop-core",
        featureMap: ".agents/feature-map/desktop-chat.md",
        status: "pass",
        durationMs: 100,
        detail: "ok",
      },
      {
        id: "GJ-16",
        title: "Mobile",
        domain: "mobile",
        owner: "moss-mobile-owner",
        featureMap: ".agents/feature-map/mobile-core.md",
        status: "skip",
        durationMs: 0,
        detail: "skipped",
      },
      {
        id: "GJ-27",
        title: "Voice",
        domain: "online",
        owner: "moss-ops-voice",
        featureMap: ".agents/feature-map/desktop-voice-plugins.md",
        status: "fail",
        durationMs: 50,
        detail: "HTTP 503",
      },
    ];

    const report = summarizeGoldenResults(sample, {
      mode: "smoke",
      commit: "abc1234",
      durationMs: 150,
    });
    expect(report.summary).toEqual({
      total: 3,
      executed: 2,
      passed: 1,
      failed: 1,
      skipped: 1,
      passRate: 50,
      durationMs: 150,
      status: "degraded",
    });
    expect(report.byDomain.desktop.passed).toBe(1);
    expect(report.byDomain.mobile.skipped).toBe(1);
    expect(report.byDomain.online.failed).toBe(1);
  });

  it("executes dry-run and atomically writes golden-latest.json", async () => {
    const repoRoot = path.resolve(import.meta.dirname, "..", "..");
    const outDir = mkdtempSync(path.join(tmpdir(), "moss-golden-out-"));
    tempDirs.push(outDir);
    const outputPath = path.join(outDir, "golden-latest.json");

    const report = await runGoldenSuite({ repoRoot, mode: "dry-run", outputPath });
    expect(report.summary.total).toBe(30);
    expect(report.summary.failed).toBe(0);
    expect(existsSync(outputPath)).toBe(true);
    const parsed = JSON.parse(readFileSync(outputPath, "utf8")) as { summary: { total: number } };
    expect(parsed.summary.total).toBe(30);
  });
});
