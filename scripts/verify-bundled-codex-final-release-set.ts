#!/usr/bin/env node
// FILE: verify-bundled-codex-final-release-set.ts
// Purpose: Reconstructs component receipts and rehashes the exact GitHub release upload directory.
// Layer: Release/build script

import { parseArgs } from "node:util";

import { verifyBundledCodexFinalReleaseSet } from "./lib/bundled-codex-final-release-set.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    "require-publish-eligible": { type: "boolean", default: false },
  },
});

const outputDir = positionals[0];
if (!outputDir) {
  throw new Error(
    "Usage: verify-bundled-codex-final-release-set.ts <output-dir> [--require-publish-eligible]",
  );
}

const receipt = verifyBundledCodexFinalReleaseSet({
  outputDir,
  requirePublishEligible: values["require-publish-eligible"],
});

process.stdout.write(
  `${JSON.stringify({
    status: "passed",
    publishEligible: receipt.publishEligible,
    componentCount: receipt.components.length,
    artifactCount: receipt.artifacts.length,
    updateChannel: receipt.updateChannel,
  })}\n`,
);
