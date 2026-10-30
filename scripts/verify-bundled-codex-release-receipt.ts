#!/usr/bin/env node
// FILE: verify-bundled-codex-release-receipt.ts
// Purpose: Rehashes copied desktop artifacts and gates their machine-readable Codex receipt.
// Layer: Release/build script

import { parseArgs } from "node:util";

import {
  type BundledCodexReleaseReceipt,
  verifyBundledCodexReleaseReceipt,
} from "./lib/bundled-codex-release-compliance.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    platform: { type: "string" },
    arch: { type: "string" },
    "require-publish-eligible": { type: "boolean", default: false },
  },
});

const outputDir = positionals[0];
const platform = values.platform;
const arch = values.arch;
if (!outputDir) {
  throw new Error(
    "Usage: verify-bundled-codex-release-receipt.ts <output-dir> --platform <platform> --arch <arch> [--require-publish-eligible]",
  );
}
if (platform !== "linux" && platform !== "mac" && platform !== "win") {
  throw new Error(`Invalid receipt platform: ${String(platform)}.`);
}
if (arch !== "arm64" && arch !== "x64" && arch !== "universal") {
  throw new Error(`Invalid receipt architecture: ${String(arch)}.`);
}

const receipt: BundledCodexReleaseReceipt = verifyBundledCodexReleaseReceipt({
  outputDir,
  expectedPlatform: platform,
  expectedArch: arch,
  requirePublishEligible: values["require-publish-eligible"],
});

process.stdout.write(
  `${JSON.stringify({
    status: "passed",
    platform: receipt.platform,
    arch: receipt.arch,
    publishEligible: receipt.publishEligible,
    artifactCount: receipt.artifacts.length,
    complianceBundleRootSha256: receipt.complianceBundleRootSha256,
  })}\n`,
);
