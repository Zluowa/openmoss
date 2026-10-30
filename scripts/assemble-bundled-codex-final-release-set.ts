#!/usr/bin/env node
// FILE: assemble-bundled-codex-final-release-set.ts
// Purpose: Creates the exact, attested GitHub release upload directory from platform receipts.
// Layer: Release/build script

import { parseArgs } from "node:util";

import { assembleBundledCodexFinalReleaseSet } from "./lib/bundled-codex-final-release-set.ts";

const { positionals, values } = parseArgs({
  allowPositionals: true,
  options: {
    channel: { type: "string" },
  },
});

const [componentRoot, outputDir] = positionals;
if (!componentRoot || !outputDir || !values.channel) {
  throw new Error(
    "Usage: assemble-bundled-codex-final-release-set.ts <component-root> <output-dir> --channel <channel>",
  );
}

const receipt = assembleBundledCodexFinalReleaseSet({
  componentRoot,
  outputDir,
  updateChannel: values.channel,
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
