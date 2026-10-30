import { describe, expect, it } from "vitest";

import type {
  MaterializedMossEngineProjection,
  MaterializedMossWorkspaceProjections,
  MossProjectionManifestSummary,
} from "@synara/shared/mossProjectionMaterializer";

import {
  mossMaterializeExitCode,
  mossSummaryExitCode,
  parseMossMaterializeArgs,
} from "./moss-materialize";

function projection(
  partial: Partial<MaterializedMossEngineProjection>,
): MaterializedMossEngineProjection {
  return {
    engineId: "codex",
    projectPath: "/workspace/demo",
    projectionStatus: "ready",
    warnings: [],
    results: [],
    summary: { created: 0, updated: 0, skipped: 0, conflict: 0, unsupported: 0, total: 0 },
    ...partial,
  };
}

function output(
  projections: MaterializedMossEngineProjection[],
): MaterializedMossWorkspaceProjections {
  return { projectPath: "/workspace/demo", dryRun: false, projections };
}

describe("parseMossMaterializeArgs", () => {
  it("defaults to materializing the current working directory", () => {
    expect(parseMossMaterializeArgs([], "/fallback/cwd")).toEqual({
      workspace: "/fallback/cwd",
      mode: "materialize",
      dryRun: false,
    });
  });

  it("reads --workspace, --engines, and --dry-run", () => {
    expect(
      parseMossMaterializeArgs(
        ["--workspace", "/tmp/w", "--engines", "codex,claudeAgent", "--dry-run"],
        "/fallback/cwd",
      ),
    ).toEqual({
      workspace: "/tmp/w",
      mode: "materialize",
      engines: ["codex", "claudeAgent"],
      dryRun: true,
    });
  });

  it("rejects unknown providers and empty engine lists", () => {
    expect(() => parseMossMaterializeArgs(["--engines", "codex,nope"], "/cwd")).toThrow(
      "unknown provider kind: nope",
    );
    expect(() => parseMossMaterializeArgs(["--engines", " , "], "/cwd")).toThrow(
      "--engines requires a comma-separated provider list",
    );
  });

  it.each(["droid", "kilo"])("rejects retired %s providers", (provider) => {
    expect(() => parseMossMaterializeArgs(["--engines", provider], "/cwd")).toThrow(
      `unknown provider kind: ${provider}`,
    );
  });

  it("parses --summary mode", () => {
    expect(parseMossMaterializeArgs(["--summary"], "/cwd").mode).toBe("summary");
  });

  it("parses --remove with repeatable --target, --source, and --remove-targets", () => {
    expect(
      parseMossMaterializeArgs(
        [
          "--remove",
          "moss:skill:moss-workspace",
          "--source",
          "skills/moss-workspace",
          "--target",
          ".codex/skills/moss-workspace",
          "--target",
          ".claude/skills/moss-workspace",
          "--remove-targets",
        ],
        "/cwd",
      ),
    ).toEqual({
      workspace: "/cwd",
      mode: "remove",
      dryRun: false,
      remove: {
        resourceId: "moss:skill:moss-workspace",
        sourcePath: "skills/moss-workspace",
        targetPaths: [".codex/skills/moss-workspace", ".claude/skills/moss-workspace"],
        removeTargets: true,
      },
    });
  });

  it("rejects remove-only flags without --remove and missing values", () => {
    expect(() => parseMossMaterializeArgs(["--target", "x"], "/cwd")).toThrow(
      "--source/--target/--remove-targets require --remove <resourceId>",
    );
    expect(() => parseMossMaterializeArgs(["--remove"], "/cwd")).toThrow(
      "--remove requires a value",
    );
    expect(() => parseMossMaterializeArgs(["--workspace"], "/cwd")).toThrow(
      "--workspace requires a value",
    );
    expect(() => parseMossMaterializeArgs(["--nope"], "/cwd")).toThrow(
      "unknown moss materialize option: --nope",
    );
  });
});

describe("mossMaterializeExitCode", () => {
  it("exits zero when every engine is clean", () => {
    expect(mossMaterializeExitCode(output([projection({}), projection({})]))).toBe(0);
  });

  it("exits one on any conflict", () => {
    expect(
      mossMaterializeExitCode(
        output([
          projection({}),
          projection({
            summary: { created: 1, updated: 0, skipped: 0, conflict: 2, unsupported: 0, total: 3 },
          }),
        ]),
      ),
    ).toBe(1);
  });

  it("exits one when an engine projection failed", () => {
    expect(
      mossMaterializeExitCode(
        output([projection({ projectionStatus: "skipped", reason: "boom", failed: true })]),
      ),
    ).toBe(1);
  });

  it("keeps zero for benign skips (no .moss source)", () => {
    expect(
      mossMaterializeExitCode(
        output([
          projection({
            projectionStatus: "skipped",
            reason: "No .moss Unified Source was found for this project.",
          }),
        ]),
      ),
    ).toBe(0);
  });
});

function summary(status: MossProjectionManifestSummary["status"]): MossProjectionManifestSummary {
  return { status, sourcePath: "/workspace/demo", totalEntries: 0, engines: [] };
}

describe("mossSummaryExitCode", () => {
  it("exits one only for parse errors", () => {
    expect(mossSummaryExitCode(summary("found"))).toBe(0);
    expect(mossSummaryExitCode(summary("missing"))).toBe(0);
    expect(mossSummaryExitCode(summary("parse-error"))).toBe(1);
  });
});
