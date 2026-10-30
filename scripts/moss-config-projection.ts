import { readFile } from "node:fs/promises";
import { relative } from "node:path";
import { pathToFileURL } from "node:url";

import type { MossCanonicalConfig, MossConfigProjectionTarget } from "@synara/contracts";
import {
  MOSS_PROJECTION_TARGETS,
  parseMossCanonicalConfig,
  projectAllMossConfig,
  projectMossConfig,
  type MossProjectionReportOptions,
} from "@synara/shared/mossConfigProjection";
import { MOSS_RELATIVE_PATHS, getMossSourceLayout } from "@synara/shared/mossSourceLayout";

export {
  MOSS_PROJECTION_TARGETS,
  parseMossCanonicalConfig,
  projectAllMossConfig,
  projectMossConfig,
} from "@synara/shared/mossConfigProjection";

export async function loadMossCanonicalConfig(
  repoRoot = process.cwd(),
): Promise<MossCanonicalConfig> {
  const sourcePath = getMossSourceLayout(repoRoot).workspaceConfig;
  return parseMossCanonicalConfig(
    await readFile(sourcePath, "utf8"),
    relative(repoRoot, sourcePath),
  );
}

export async function readMossProjectionReport(
  repoRoot = process.cwd(),
  options: MossProjectionReportOptions = {},
) {
  const config = await loadMossCanonicalConfig(repoRoot);
  const targets = options.targets ?? MOSS_PROJECTION_TARGETS;
  return targets.map((target) =>
    projectMossConfig(config, {
      target,
      dryRun: options.dryRun ?? true,
      ...(options.createdAt ? { createdAt: options.createdAt } : {}),
    }),
  );
}

function isProjectionTarget(value: string): value is MossConfigProjectionTarget {
  return MOSS_PROJECTION_TARGETS.includes(value as MossConfigProjectionTarget);
}

function parseTargets(argv: ReadonlyArray<string>): ReadonlyArray<MossConfigProjectionTarget> {
  const targetIndex = argv.findIndex((arg) => arg === "--target");
  if (targetIndex === -1) {
    return MOSS_PROJECTION_TARGETS;
  }
  const value = argv[targetIndex + 1];
  if (!value || value === "all") {
    return MOSS_PROJECTION_TARGETS;
  }
  const targets = value
    .split(",")
    .map((target) => target.trim())
    .filter(Boolean);
  const invalid = targets.find((target) => !isProjectionTarget(target));
  if (invalid) {
    throw new Error(`unknown Moss projection target: ${invalid}`);
  }
  return targets as ReadonlyArray<MossConfigProjectionTarget>;
}

async function main(): Promise<void> {
  const targets = parseTargets(process.argv.slice(2));
  const projections = await readMossProjectionReport(process.cwd(), { targets, dryRun: true });
  process.stdout.write(
    `${JSON.stringify(
      {
        source: MOSS_RELATIVE_PATHS.workspaceConfig,
        dryRun: true,
        projections,
      },
      null,
      2,
    )}\n`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error);
    process.exitCode = 1;
  });
}
