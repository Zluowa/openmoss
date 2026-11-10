#!/usr/bin/env node
// FILE: node-pty-smoke.mjs
// Purpose: Verifies that the native node-pty dependency can load and spawn a PTY.
// Layer: Release/CI smoke check

import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { waitForSuccessfulPtyExit } from "./lib/node-pty-smoke.ts";

const scriptDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(scriptDir, "..");
const requireRoot =
  process.env.MOSS_NODE_PTY_SMOKE_REQUIRE_ROOT?.trim() || resolve(repoRoot, "apps/server");
const requireFromTarget = createRequire(resolve(requireRoot, "package.json"));
const expectedOutput = "moss-node-pty-smoke";

function fail(message, detail) {
  console.error(`[node-pty-smoke] ${message}`);
  if (detail) console.error(detail);
  process.exit(1);
}

let nodePty;
try {
  nodePty = requireFromTarget("node-pty");
} catch (error) {
  fail("Failed to load node-pty.", error instanceof Error ? error.stack : String(error));
}

const isWindows = process.platform === "win32";
// Windows node-pty defers writes until its first output frame. The child
// announces that its line reader is installed and repeats until the parent
// responds, so neither side depends on an incidental ConPTY startup frame.
const readyOutput = "moss-pty-input-ready";
const windowsProbe = [
  "const rl = require('node:readline').createInterface({ input: process.stdin, terminal: false });",
  `const announce = () => console.log('${readyOutput}');`,
  "const announcements = setInterval(announce, 150);",
  "const deadline = setTimeout(() => process.exit(1), 5000);",
  "rl.once('line', line => {",
  "  clearTimeout(deadline);",
  "  clearInterval(announcements);",
  `  if (line === 'probe') console.log('${expectedOutput}'); else process.exitCode = 1;`,
  "  rl.close();",
  "});",
  "announce();",
].join(" ");
const shell = isWindows ? process.execPath : "/bin/sh";
const args = isWindows ? ["-e", windowsProbe] : ["-lc", `printf '${expectedOutput}'`];

let terminal;
try {
  terminal = nodePty.spawn(shell, args, {
    cols: 80,
    rows: 24,
    cwd: requireRoot,
    env: process.env,
    name: isWindows ? "xterm-color" : "xterm-256color",
  });
} catch (error) {
  fail("Failed to spawn node-pty process.", error instanceof Error ? error.stack : String(error));
}

try {
  const completed = waitForSuccessfulPtyExit({
    terminal,
    expectedOutput,
    timeoutMs: isWindows ? 8_000 : 5_000,
    ...(isWindows
      ? { inputHandshake: { readyOutput, send: () => terminal.write("probe\r") } }
      : {}),
  });
  await completed;
  if (!isWindows) {
    terminal.kill();
  }
  console.log("[node-pty-smoke] node-pty loaded and spawned successfully.");
  // A Windows reader worker can remain referenced even after its child has
  // exited. Do not start an asynchronous kill here: the observed child has
  // already exited, and abandoning that kill used to strand cmd and conhost.
  process.exit(0);
} catch (error) {
  try {
    terminal.kill();
  } catch {
    // The PTY may already have exited; preserve the actionable smoke error.
  }
  fail(error instanceof Error ? error.message : String(error));
}
