// Updated: [2026-09-09 00:23:00] Asia/Shanghai
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";

import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";

async function main(): Promise<void> {
  await loadAcpSdk();
  await loadClaudeAgentSdk();
  await import("@earendil-works/pi-coding-agent");
  await import("open");
  await import("node-pty");
  await import("@xterm/headless");
  // Connectors load the MCP SDK's OAuth client on first use.
  await import("@modelcontextprotocol/sdk/client/auth.js");

  const { parsePatchFiles } = await import("@pierre/diffs");
  const patches = parsePatchFiles(
    "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
  );
  assert.equal(patches[0]?.files[0]?.name, "smoke.txt");
  console.log("Packaged runtime dependency smoke passed.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
