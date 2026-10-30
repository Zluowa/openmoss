// FILE: mac-codex-compliance-after-pack.mjs
// Purpose: Restore canonical POSIX modes on the audited Codex resource tree
// before electron-builder signs and archives the macOS app.

import { chmodSync, lstatSync, readdirSync } from "node:fs";
import path from "node:path";

const COMPLIANCE_RESOURCE_RELATIVE_PATH = [
  "Contents",
  "Resources",
  "third-party-licenses",
  "openai-codex",
];

function normalizeComplianceTree(directory) {
  const stat = lstatSync(directory);
  if (stat.isSymbolicLink() || !stat.isDirectory()) {
    throw new Error(`Packaged Codex compliance path must be a plain directory: ${directory}`);
  }
  chmodSync(directory, 0o755);
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const entryPath = path.join(directory, entry.name);
    const entryStat = lstatSync(entryPath);
    if (entryStat.isSymbolicLink()) {
      throw new Error(`Packaged Codex compliance tree rejects symbolic links: ${entryPath}`);
    }
    if (entryStat.isDirectory()) {
      normalizeComplianceTree(entryPath);
      continue;
    }
    if (!entryStat.isFile()) {
      throw new Error(`Packaged Codex compliance tree contains a special entry: ${entryPath}`);
    }
    // The pinned compliance bundle contains only audited text/archive files.
    // Set the mode explicitly because electron-builder copies extraResources
    // using the process umask (0600 on the release worker).
    chmodSync(entryPath, 0o644);
  }
}

function resolveMacAppBundle(appOutDir) {
  const outStat = lstatSync(appOutDir);
  if (outStat.isSymbolicLink() || !outStat.isDirectory()) {
    throw new Error(`macOS electron-builder appOutDir must be a plain directory: ${appOutDir}`);
  }
  if (path.basename(appOutDir).endsWith(".app")) return appOutDir;
  const appBundles = readdirSync(appOutDir, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.endsWith(".app"))
    .map((entry) => path.join(appOutDir, entry.name));
  if (appBundles.length !== 1) {
    throw new Error(
      `macOS Codex compliance hook expected one app bundle under ${appOutDir}, found ${appBundles.length}.`,
    );
  }
  return appBundles[0];
}

export default async function macCodexComplianceAfterPack(context) {
  if (context?.electronPlatformName !== "darwin") {
    throw new Error(
      `macOS Codex compliance hook requires electronPlatformName=darwin, got ${context?.electronPlatformName ?? "<missing>"}.`,
    );
  }
  if (typeof context.appOutDir !== "string" || !context.appOutDir.trim()) {
    throw new Error("macOS Codex compliance hook received no appOutDir.");
  }
  const appBundle = resolveMacAppBundle(context.appOutDir);
  const complianceRoot = path.join(appBundle, ...COMPLIANCE_RESOURCE_RELATIVE_PATH);
  normalizeComplianceTree(complianceRoot);
  console.log(`[mac-codex-compliance] Normalized packaged resource modes under ${complianceRoot}.`);
}
