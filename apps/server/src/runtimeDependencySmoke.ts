// Updated: [2026-09-09 00:23:00] Asia/Shanghai
// Purpose: Exercises lazy runtime imports inside the packaged app without starting provider sessions.
// Layer: Release verification entrypoint

import { strict as assert } from "node:assert";

import { createOpencodeClient } from "@opencode-ai/sdk/v2";
import { Effect } from "effect";

import { parseCheckpointFilesFromUnifiedDiff } from "./checkpointing/Diffs.ts";
import { loadAcpSdk } from "./provider/acp/AcpSdk.ts";
import { loadClaudeAgentSdk } from "./provider/claudeAgentSdk.ts";
import { withOpenCodeV2Client } from "./provider/openCodeV2Client.ts";

function denyNetwork(): never {
  throw new Error("Packaged runtime dependency smoke must not open network connections.");
}

async function main(): Promise<void> {
  await loadAcpSdk();
  await loadClaudeAgentSdk();
  await import("open");
  await import("node-pty");
  await import("@xterm/headless");
  // Connectors load the MCP SDK's OAuth client on first use.
  await import("@modelcontextprotocol/sdk/client/auth.js");

  const checkpointFiles = await Effect.runPromise(
    parseCheckpointFilesFromUnifiedDiff(
      "diff --git a/smoke.txt b/smoke.txt\n--- a/smoke.txt\n+++ b/smoke.txt\n@@ -1 +1 @@\n-before\n+after\n",
    ),
  );
  assert.equal(checkpointFiles[0]?.path, "smoke.txt");

  // Exercise the bundled OpenCode V2 client offline without relying on
  // @opencode/{protocol,schema} or a nested Effect copy in node_modules.
  {
    const syntheticFetch: typeof fetch = Object.assign(
      async (resource: Parameters<typeof fetch>[0]) => {
        const url = new URL(
          typeof resource === "string"
            ? resource
            : resource instanceof URL
              ? resource.href
              : resource.url,
        );
        if (url.pathname === "/api/info") {
          return Response.json({
            version: "2.0.0-smoke",
            pid: 1,
            urls: [],
            paths: { tmp: "/tmp" },
          });
        }
        return Response.json({ error: `Unexpected smoke path ${url.pathname}` }, { status: 404 });
      },
      { preconnect: denyNetwork },
    );
    const legacy = createOpencodeClient({
      baseUrl: "http://127.0.0.1:1",
      fetch: syntheticFetch,
    });
    const v2 = withOpenCodeV2Client(legacy, {
      baseUrl: "http://127.0.0.1:1",
      directory: "/tmp/moss-opencode-smoke",
      fetch: syntheticFetch,
    });
    const health = await v2.global.health();
    assert.equal(health.data?.version, "2.0.0-smoke");
  }

  console.log("Packaged runtime dependency smoke passed.");
}

void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
