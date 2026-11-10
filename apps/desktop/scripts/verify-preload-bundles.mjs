// Electron's sandbox cannot load relative chunks or arbitrary Node packages.
// Inspect the emitted files so a shared-chunk regression fails the build.
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import path from "node:path";

const sandboxModules = new Set([
  "electron",
  "events",
  "node:events",
  "timers",
  "node:timers",
  "url",
  "node:url",
]);
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../dist-electron");
const entries = ["preload.js", "sshWorkspacePreload.js", "guestPreload.js", "mcpSandboxPreload.js"];

for (const entry of entries) {
  const source = readFileSync(path.join(directory, entry), "utf8");
  const imports = [...source.matchAll(/\brequire\s*\(\s*["']([^"']+)["']\s*\)/gu)];
  for (const [, module] of imports) {
    if (!sandboxModules.has(module)) {
      throw new Error(`Sandbox preload ${entry} requires unsupported module ${module}`);
    }
  }
  if (imports.length === 0 || !imports.some(([, module]) => module === "electron")) {
    throw new Error(`Sandbox preload ${entry} has no Electron bridge import`);
  }
  console.log(`Verified self-contained sandbox preload: ${entry}`);
}
