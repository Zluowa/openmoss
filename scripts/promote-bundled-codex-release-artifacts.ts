#!/usr/bin/env node
// FILE: promote-bundled-codex-release-artifacts.ts
// Purpose: Securely promotes verified desktop candidates into the exact CI upload directory.
// Layer: Release/build script

import { parseArgs } from "node:util";

import {
  type BundledCodexReleaseReceipt,
  promoteBundledCodexReleaseArtifacts,
} from "./lib/bundled-codex-release-compliance.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string" },
    arch: { type: "string" },
    rename: { type: "string", multiple: true, default: [] },
    "require-publish-eligible": { type: "boolean", default: false },
  },
});

const [sourceDir, outputDir] = positionals;
const platform = values.platform;
const arch = values.arch;
if (!sourceDir || !outputDir) {
  throw new Error(
    "Usage: promote-bundled-codex-release-artifacts.ts <source-dir> <output-dir> --platform <platform> --arch <arch> [--rename source=target] [--require-publish-eligible]",
  );
}
if (platform !== "linux" && platform !== "mac" && platform !== "win") {
  throw new Error(`Invalid receipt platform: ${String(platform)}.`);
}
if (arch !== "arm64" && arch !== "x64" && arch !== "universal") {
  throw new Error(`Invalid receipt architecture: ${String(arch)}.`);
}

const artifactRenames: Record<string, string> = {};
for (const mapping of values.rename) {
  const separator = mapping.indexOf("=");
  if (separator <= 0 || separator === mapping.length - 1) {
    throw new Error(`Invalid artifact rename: ${mapping}.`);
  }
  const sourceName = mapping.slice(0, separator);
  const targetName = mapping.slice(separator + 1);
  if (Object.hasOwn(artifactRenames, sourceName)) {
    throw new Error(`Duplicate artifact rename source: ${sourceName}.`);
  }
  artifactRenames[sourceName] = targetName;
}

const promoted: {
  readonly receipt: BundledCodexReleaseReceipt;
  readonly receiptPath: string;
} = promoteBundledCodexReleaseArtifacts({
  sourceDir,
  outputDir,
  expectedPlatform: platform,
  expectedArch: arch,
  requirePublishEligible: values["require-publish-eligible"],
  artifactRenames,
});

process.stdout.write(
  `${JSON.stringify({
    status: "passed",
    platform: promoted.receipt.platform,
    arch: promoted.receipt.arch,
    publishEligible: promoted.receipt.publishEligible,
    artifactCount: promoted.receipt.artifacts.length,
    receiptPath: promoted.receiptPath,
  })}\n`,
);
