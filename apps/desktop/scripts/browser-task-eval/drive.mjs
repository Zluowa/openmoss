#!/usr/bin/env node
// FILE: drive.mjs
// Purpose: Live-model A/B driver for the browser task eval. Each variant is a
// running serve.ts (built from a different checkout); this script asks it for
// a fresh run, lets the local `claude` CLI solve the task through that
// server's MCP browser tools, then asks the server to grade the page-recorded
// effect. Variants are interleaved per task so provider or machine drift hits
// both alike. Every run, transcript and tool trace is kept; nothing is
// cherry-picked. Each run spends real model usage; credentials are never read.
// Layer: Desktop browser task eval (development tool, not shipped)
// Exports: none (command-line entry point)
//
//   node drive.mjs --servers A=http://127.0.0.1:47001,B=http://127.0.0.1:47002 \
//     --model sonnet --repeats 2 [--tasks form,badge] [--parallel 2] [--out dir]

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseArgs } from "node:util";

const { values } = parseArgs({
  options: {
    servers: { type: "string" },
    model: { type: "string", default: "sonnet" },
    repeats: { type: "string", default: "1" },
    tasks: {
      type: "string",
      default: "form,catalog,orders,report,settings,vault,badge,iframe,directory",
    },
    parallel: { type: "string", default: "2" },
    out: { type: "string" },
    "max-turns": { type: "string", default: "40" },
  },
});
if (!values.servers) throw new Error("--servers A=url[,B=url] is required");
const servers = values.servers.split(",").map((entry) => {
  const [name, url] = entry.split("=");
  return { name, url };
});
const tasks = values.tasks.split(",");
const repeats = Number(values.repeats);
const out = values.out ?? (await mkdtemp(join(tmpdir(), "moss-browser-eval-run-")));
await mkdir(out, { recursive: true });

const SYSTEM_BASE =
  "你是 Moss，一个帮助用户完成请求的桌面助手。用中文简洁回答，事实以实际读取的内容为准。";

async function json(url, init) {
  const response = await fetch(url, init);
  return response.json();
}

async function runOne(task, server, repetition) {
  const dir = join(out, `${task}-${server.name}-${repetition}`);
  await mkdir(join(dir, "cwd"), { recursive: true });
  const { policy } = await json(`${server.url}/policy`);
  const run = await json(`${server.url}/run`, { method: "POST", body: JSON.stringify({ task }) });
  const config = join(dir, "mcp.json");
  await writeFile(
    config,
    JSON.stringify({ mcpServers: { moss: { type: "http", url: run.mcpUrl } } }),
  );
  const started = Date.now();
  const child = spawn(
    "claude",
    [
      "-p",
      run.prompt,
      "--output-format",
      "stream-json",
      "--verbose",
      "--model",
      values.model,
      "--system-prompt",
      `${SYSTEM_BASE}\n${policy}`,
      "--tools",
      "",
      "--strict-mcp-config",
      "--mcp-config",
      config,
      "--allowedTools",
      "mcp__moss",
      "--no-session-persistence",
      "--setting-sources",
      "project",
      "--max-turns",
      values["max-turns"],
    ],
    {
      cwd: join(dir, "cwd"),
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, MCP_TIMEOUT: "90000", CLAUDE_CODE_MAX_MCP_DESCRIPTION_LENGTH: "4096" },
    },
  );
  let stdout = "";
  let stderr = "";
  child.stdout.on("data", (chunk) => {
    stdout += chunk;
  });
  child.stderr.on("data", (chunk) => {
    stderr += chunk;
  });
  const timer = setTimeout(() => child.kill("SIGTERM"), 8 * 60_000);
  const exit = await new Promise((resolve) => child.on("close", resolve));
  clearTimeout(timer);
  await writeFile(join(dir, "stream.jsonl"), stdout);
  if (stderr) await writeFile(join(dir, "stderr.txt"), stderr);
  const events = stdout
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
  const result = events.find((event) => event.type === "result");
  const toolCalls = [];
  for (const event of events) {
    if (event.type !== "assistant") continue;
    for (const block of event.message?.content ?? []) {
      if (block.type === "tool_use") toolCalls.push(block.name.replace(/^mcp__moss__/u, ""));
    }
  }
  const reply = typeof result?.result === "string" ? result.result : "";
  const verdict = await json(`${server.url}/check`, {
    method: "POST",
    body: JSON.stringify({ runId: run.runId, reply }),
  });
  const usage = result?.usage ?? {};
  const row = {
    task,
    variant: server.name,
    repetition,
    pass: exit === 0 && result?.is_error === false && verdict.pass === true,
    error:
      exit !== 0 ? `claude exited ${exit}` : result?.is_error ? String(result.subtype) : undefined,
    turns: result?.num_turns ?? null,
    browserCalls: toolCalls.length,
    failedCalls: (verdict.trace ?? []).filter((entry) => entry.isError).length,
    costUsd: result?.total_cost_usd ?? null,
    durationMs: result?.duration_ms ?? Date.now() - started,
    inputTokens:
      (usage.input_tokens ?? 0) +
      (usage.cache_creation_input_tokens ?? 0) +
      (usage.cache_read_input_tokens ?? 0),
    outputTokens: usage.output_tokens ?? null,
    toolCalls,
    reply,
  };
  await writeFile(
    join(dir, "result.json"),
    JSON.stringify({ ...row, trace: verdict.trace }, null, 2),
  );
  console.log(
    JSON.stringify({
      task,
      variant: server.name,
      repetition,
      pass: row.pass,
      turns: row.turns,
      calls: row.browserCalls,
      failed: row.failedCalls,
      cost: row.costUsd,
      s: Math.round(row.durationMs / 1000),
      seq: toolCalls.join(" → "),
    }),
  );
  return row;
}

const queue = [];
for (let repetition = 1; repetition <= repeats; repetition += 1) {
  for (const task of tasks) {
    const order = repetition % 2 === 0 ? servers.toReversed() : servers;
    for (const server of order) queue.push(() => runOne(task, server, repetition));
  }
}
const rows = [];
await Promise.all(
  Array.from({ length: Number(values.parallel) }, async () => {
    while (queue.length > 0) rows.push(await queue.shift()());
  }),
);

const mean = (list) =>
  list.length ? list.reduce((sum, value) => sum + value, 0) / list.length : null;
const summarize = (subset) => ({
  runs: subset.length,
  passRate: mean(subset.map((row) => (row.pass ? 1 : 0))),
  browserCalls: mean(subset.map((row) => row.browserCalls)),
  failedCalls: mean(subset.map((row) => row.failedCalls)),
  turns: mean(subset.map((row) => row.turns ?? 0)),
  costUsd: mean(subset.map((row) => row.costUsd ?? 0)),
  seconds: mean(subset.map((row) => row.durationMs / 1000)),
  inputTokens: mean(subset.map((row) => row.inputTokens)),
});
const summary = {
  model: values.model,
  repeats,
  byVariant: Object.fromEntries(
    servers.map((server) => [
      server.name,
      summarize(rows.filter((row) => row.variant === server.name)),
    ]),
  ),
  byTask: Object.fromEntries(
    tasks.map((task) => [
      task,
      Object.fromEntries(
        servers.map((server) => [
          server.name,
          summarize(rows.filter((row) => row.task === task && row.variant === server.name)),
        ]),
      ),
    ]),
  ),
};
await writeFile(join(out, "summary.json"), JSON.stringify({ summary, rows }, null, 2));
console.log(JSON.stringify(summary.byVariant, null, 2));
console.log(`results: ${out}`);
