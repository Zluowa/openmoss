// FILE: staged-diff-dependencies.ts
// Purpose: Verifies that staged packages resolve the exact diff versions their manifests declare.
// Layer: Release/build script support

import * as FS from "node:fs";
import { createRequire } from "node:module";
import * as Path from "node:path";

export const STAGED_DIFF_CONSUMERS = ["@earendil-works/pi-coding-agent", "@pierre/diffs"] as const;

export interface StagedDiffResolution {
  readonly consumer: (typeof STAGED_DIFF_CONSUMERS)[number];
  readonly diffVersion: string;
  readonly packageRoot: string;
}

function isWithin(parent: string, child: string): boolean {
  const relative = Path.relative(parent, child);
  return (
    relative !== "" &&
    !relative.startsWith(`..${Path.sep}`) &&
    relative !== ".." &&
    !Path.isAbsolute(relative)
  );
}

function readManifest(filePath: string): Record<string, unknown> {
  const stat = FS.lstatSync(filePath);
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new Error(`${filePath} must be a regular package manifest.`);
  }
  return JSON.parse(FS.readFileSync(filePath, "utf8")) as Record<string, unknown>;
}

export function assertStagedDiffDependencies(
  stageAppDir: string,
): ReadonlyArray<StagedDiffResolution> {
  const stageRoot = FS.realpathSync(stageAppDir);

  return STAGED_DIFF_CONSUMERS.map((consumer) => {
    const linkedPackageRoot = Path.join(stageRoot, "node_modules", ...consumer.split("/"));
    const packageRoot = FS.realpathSync(linkedPackageRoot);
    if (!isWithin(stageRoot, packageRoot)) {
      throw new Error(`${consumer} resolves outside the isolated stage directory.`);
    }

    const manifestPath = Path.join(packageRoot, "package.json");
    const manifest = readManifest(manifestPath);
    if (manifest.name !== consumer) {
      throw new Error(`Expected staged package ${consumer}, got ${String(manifest.name)}.`);
    }
    const declaredDiffVersion = (manifest.dependencies as Record<string, unknown> | undefined)
      ?.diff;
    if (
      typeof declaredDiffVersion !== "string" ||
      !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?$/.test(declaredDiffVersion)
    ) {
      throw new Error(`${consumer} must declare an exact diff dependency version.`);
    }

    const resolvedManifestPath = createRequire(manifestPath).resolve("diff/package.json");
    const resolvedPackageRoot = FS.realpathSync(Path.dirname(resolvedManifestPath));
    if (!isWithin(stageRoot, resolvedPackageRoot)) {
      throw new Error(`${consumer} resolves diff outside the isolated stage directory.`);
    }
    const resolvedManifest = readManifest(Path.join(resolvedPackageRoot, "package.json"));
    if (resolvedManifest.name !== "diff" || resolvedManifest.version !== declaredDiffVersion) {
      throw new Error(
        `${consumer} declares diff ${declaredDiffVersion} but resolves ${String(resolvedManifest.version)}.`,
      );
    }

    return {
      consumer,
      diffVersion: declaredDiffVersion,
      packageRoot: resolvedPackageRoot,
    };
  });
}
