#!/usr/bin/env node

import { createInterface } from "node:readline";

const [command] = process.argv.slice(2);

if (command === "--version") {
  process.stdout.write("codex-cli 0.163.0\n");
  process.exit(0);
}

if (command !== "app-server") {
  process.stderr.write(`unexpected command: ${String(command)}\n`);
  process.exit(2);
}

const input = createInterface({ input: process.stdin });
input.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    process.stdout.write(
      `${JSON.stringify({ id: message.id, result: { codexHome: process.env.CODEX_HOME } })}\n`,
    );
  }
});
