// FILE: serve.ts
// Purpose: Electron host for the browser task eval. It runs the production
// browser chain end to end — server gateway browser_* tools → browser host RPC
// pipe → DesktopBrowserAutomationHost → BetterWright → a real WebContentsView —
// and exposes it over MCP streamable HTTP so a live model drives exactly what
// Moss ships. Everything is synthetic and loopback-only; no profile, account
// or external site is touched.
// Layer: Desktop browser task eval (development tool, not shipped)
// Exports: none (Electron entry point)
//
// Control endpoints (JSON):
//   POST /run    {task}            → {runId, prompt, mcpUrl}
//   POST /check  {runId, reply}    → {pass, trace}
//   GET  /policy                   → {policy} browser lines of the harness policy
// `--check` instead solves every task with fixed scripts through the same MCP
// tool handlers (no model, no usage) and exits non-zero on any failure.

import { randomBytes } from "node:crypto";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { app, BrowserWindow, webContents as allWebContents } from "electron";
import { configureElectronNetwork } from "betterwright/electron";
import { Effect } from "effect";
import { ThreadId } from "@moss/contracts";

import { DesktopBrowserManager } from "../../src/browserManager";
import { BrowserHostPipeServer } from "../../src/browserUsePipeServer";
import { makeBrowserAutomationHost } from "../../../server/src/browserAutomation/Layers/BrowserAutomationHost.ts";
import { makeAgentGatewayBrowserTools } from "../../../server/src/agentGateway/browserTools.ts";
import { renderMossHarnessPolicy } from "../../../server/src/agentGateway/harnessPolicy.ts";
import type { ToolContext, ToolEntry } from "../../../server/src/agentGateway/toolRuntime.ts";
import { startFixtureSite, TASKS, type FixtureRun } from "./fixtures";

configureElectronNetwork();

const args = new Set(process.argv.slice(2));
const checkOnly = args.has("--check");
const requestedPort = Number(process.env.MOSS_EVAL_PORT ?? 0);

interface TraceEntry {
  readonly tool: string;
  readonly ms: number;
  readonly isError: boolean;
  readonly argChars: number;
  readonly resultChars: number;
  readonly code?: string;
  readonly errorCode?: string;
}

interface EvalRun {
  readonly fixture: FixtureRun;
  readonly taskId: string;
  readonly threadId: string;
  readonly trace: TraceEntry[];
}

const readJson = (request: IncomingMessage): Promise<Record<string, unknown>> =>
  new Promise((resolve) => {
    let raw = "";
    request.on("data", (chunk) => {
      raw += chunk;
    });
    request.on("end", () => {
      try {
        resolve(JSON.parse(raw || "{}") as Record<string, unknown>);
      } catch {
        resolve({});
      }
    });
  });

async function main() {
  const home = await mkdtemp(join(tmpdir(), "moss-browser-eval-"));
  process.env.MOSS_HOME = home;
  app.setPath("userData", join(home, "electron"));
  await app.whenReady();

  const site = await startFixtureSite();
  const window = new BrowserWindow({
    show: true,
    width: 1280,
    height: 900,
    webPreferences: { sandbox: true, contextIsolation: true, nodeIntegration: false },
  });
  await window.loadURL("data:text/html,<title>Moss eval shell</title>");
  const manager = new DesktopBrowserManager();
  manager.setWindow(window);

  // The pipe server requires a private (0700) parent directory.
  const pipeDir = await mkdtemp(join("/tmp", "moss-eval-pipe-"));
  const pipePath = join(pipeDir, "host.sock");
  const capability = randomBytes(32).toString("hex");
  const pipe = new BrowserHostPipeServer(manager, {
    pipePath,
    capability,
    // Production reveals the panel when the owning thread is active; every
    // eval thread is the active one while it runs.
    requestOpenPanel: (threadId) => {
      manager.setPanelBounds({
        threadId,
        surface: "native",
        bounds: { x: 0, y: 60, width: 1280, height: 840 },
      });
    },
  });
  await pipe.start();
  const host = makeBrowserAutomationHost({
    MOSS_BROWSER_HOST_PIPE_PATH: pipePath,
    MOSS_BROWSER_HOST_CAPABILITY: capability,
  });
  const proofs = join(home, "proofs");
  await mkdir(proofs, { recursive: true });
  const tools: ReadonlyArray<ToolEntry> = makeAgentGatewayBrowserTools(host, {
    saveProof: async (threadId, data) => {
      const file = join(proofs, `${threadId}-${Date.now()}.png`);
      await writeFile(file, Buffer.from(data, "base64"));
      return file;
    },
  });
  const byName = new Map(tools.map((entry) => [entry.definition.name, entry]));
  const runs = new Map<string, EvalRun>();

  const contextFor = (run: EvalRun, id: string | number | null): ToolContext =>
    ({
      principal: {} as ToolContext["principal"],
      callerThreadId: run.threadId,
      callerThreadLabel: null,
      callerSessionKey: `eval-session-${run.fixture.id}`,
      callerProvider: "claudeAgent",
      callerCapabilities: new Set(["browser:control"]),
      callerTurnId: `eval-turn-${run.fixture.id}`,
      assertCallerTurnActive: () => Effect.void,
      jsonRpcRequestId: id,
    }) as unknown as ToolContext;

  async function callTool(
    run: EvalRun,
    name: string,
    toolArgs: Record<string, unknown>,
    id: string | number | null,
  ) {
    const entry = byName.get(name);
    if (!entry) return { content: [{ type: "text", text: `Unknown tool ${name}` }], isError: true };
    const started = Date.now();
    const result = await Effect.runPromise(entry.handler(toolArgs, contextFor(run, id)));
    const text = result.content
      .map((block) => (block.type === "text" ? block.text : `[image ${block.data.length}]`))
      .join("\n");
    const errorCode = result.isError ? /"code"\s*:\s*"([A-Za-z]+)"/u.exec(text)?.[1] : undefined;
    run.trace.push({
      tool: name,
      ms: Date.now() - started,
      isError: result.isError === true,
      argChars: JSON.stringify(toolArgs).length,
      resultChars: text.length,
      ...(typeof toolArgs.code === "string" ? { code: toolArgs.code } : {}),
      ...(errorCode ? { errorCode } : {}),
    });
    return result;
  }

  function newRun(taskId: string): EvalRun {
    const fixture = site.newRun();
    const run: EvalRun = { fixture, taskId, threadId: `eval-${fixture.id}`, trace: [] };
    runs.set(fixture.id, run);
    return run;
  }

  async function finishRun(run: EvalRun): Promise<void> {
    runs.delete(run.fixture.id);
    site.dropRun(run.fixture.id);
    try {
      manager.close({ threadId: ThreadId.makeUnsafe(run.threadId) });
    } catch {
      // Already closed by the agent.
    }
  }

  if (checkOnly) {
    const failures = await runScriptedChecks({ newRun, callTool, finishRun, base: site.base });
    await pipe.dispose();
    app.exit(failures === 0 ? 0 : 1);
    return;
  }

  const control = createServer((request, response) => {
    void (async () => {
      const url = new URL(request.url ?? "/", "http://eval");
      const reply = (status: number, body: unknown) => {
        response.writeHead(status, { "content-type": "application/json" });
        response.end(JSON.stringify(body));
      };
      if (request.method === "GET" && url.pathname === "/policy") {
        const policy = renderMossHarnessPolicy({ gatewayControlAvailable: true })
          .split("\n")
          .filter((line) => /browser/iu.test(line))
          .join("\n");
        return reply(200, { policy });
      }
      if (request.method === "POST" && url.pathname === "/run") {
        const body = await readJson(request);
        const task = TASKS.find((entry) => entry.id === body.task);
        if (!task) return reply(404, { error: "unknown task" });
        const run = newRun(task.id);
        const port = (control.address() as { port: number }).port;
        return reply(200, {
          runId: run.fixture.id,
          prompt: task.prompt(run.fixture, site.base),
          mcpUrl: `http://127.0.0.1:${port}/mcp/${run.fixture.id}`,
        });
      }
      if (request.method === "POST" && url.pathname === "/check") {
        const body = await readJson(request);
        const run = runs.get(String(body.runId));
        const task = TASKS.find((entry) => entry.id === run?.taskId);
        if (!run || !task) return reply(404, { error: "unknown run" });
        const pass = task.check(run.fixture, String(body.reply ?? ""));
        const trace = run.trace;
        await finishRun(run);
        return reply(200, { pass, trace });
      }
      const mcp = /^\/mcp\/([0-9a-f]+)$/u.exec(url.pathname);
      if (mcp) {
        if (request.method !== "POST") return reply(405, { error: "POST only" });
        const run = runs.get(mcp[1] ?? "");
        if (!run) return reply(404, { error: "unknown run" });
        const message = await readJson(request);
        const id = (message.id ?? null) as string | number | null;
        const method = String(message.method ?? "");
        if (message.id === undefined) {
          response.writeHead(202).end();
          return;
        }
        const params = (message.params ?? {}) as Record<string, unknown>;
        const ok = (result: unknown) => reply(200, { jsonrpc: "2.0", id, result });
        switch (method) {
          case "initialize":
            return ok({
              protocolVersion: String(params.protocolVersion ?? "2025-06-18"),
              capabilities: { tools: {} },
              serverInfo: { name: "moss", version: "eval" },
            });
          case "ping":
            return ok({});
          case "tools/list":
            return ok({ tools: tools.map((entry) => entry.definition) });
          case "tools/call": {
            const result = await callTool(
              run,
              String(params.name),
              (params.arguments ?? {}) as Record<string, unknown>,
              id,
            );
            return ok(result);
          }
          default:
            return reply(200, {
              jsonrpc: "2.0",
              id,
              error: { code: -32601, message: `Method not found: ${method}` },
            });
        }
      }
      reply(404, { error: "not found" });
    })().catch((error: unknown) => {
      if (!response.headersSent) response.writeHead(500);
      response.end(String(error));
    });
  });
  control.listen(requestedPort, "127.0.0.1", () => {
    const port = (control.address() as { port: number }).port;
    console.log(JSON.stringify({ ready: true, port, home }));
  });
}

interface ScriptedDeps {
  readonly base: string;
  newRun(taskId: string): EvalRun;
  callTool(
    run: EvalRun,
    name: string,
    toolArgs: Record<string, unknown>,
    id: string | number | null,
  ): Promise<{ content: ReadonlyArray<{ type: string; text?: string }>; isError?: boolean }>;
  finishRun(run: EvalRun): Promise<void>;
}

/** Viewport point of an outline line such as `textbox "Door PIN" @498,172`. */
function outlinePoint(outline: string, role: string, name: string): string {
  const match = new RegExp(`${role} ${JSON.stringify(name)}[^\\n]*?@(\\d+),(\\d+)`, "u").exec(
    outline,
  );
  if (!match) throw new Error(`No outline coordinates for ${role} "${name}"`);
  return `${match[1]}, ${match[2]}`;
}

/**
 * Deterministic solutions that use only what a model is offered: the tool
 * results it would see, including the navigation result's page outline.
 */
const SCRIPTED: Record<string, (run: FixtureRun, outline: string) => string> = {
  vault: (
    _run,
    outline,
  ) => `await page.mouse.click(${outlinePoint(outline, "button", "Reveal access code")});
return true;`,
  badge: (
    run,
    outline,
  ) => `await page.mouse.click(${outlinePoint(outline, "textbox", "Employee ID")});
await page.keyboard.type('${run.badge.employee}');
await page.mouse.click(${outlinePoint(outline, "textbox", "Door PIN")});
await page.keyboard.type('${run.badge.pin}');
await page.mouse.click(${outlinePoint(outline, "button", "Issue badge")});
return true;`,
  form: (run) => `await page.getByLabel('Full name').fill('Ada Lovelace');
await page.getByLabel('Email').fill('ada@example.test');
await page.getByLabel('Plan').selectOption('Team');
await page.getByLabel('Seats').fill('7');
await page.getByLabel('APAC').check();
await page.getByLabel('Subscribe to product updates').check();
await page.getByLabel('Notes').fill('${run.form.note}');
await human.click(page.getByRole('button', {name: 'Create account'}));
await page.waitForURL(/form\\/submit/);
return await page.locator('strong').textContent();`,
  catalog: () => `const out = {};
for (const name of ['Alpha Lamp', 'Cobalt Desk', 'Echo Chair', 'Garnet Shelf']) {
  await human.click(page.getByRole('link', {name}));
  out[name] = await page.locator('#sku').textContent();
  await page.goBack();
}
return out;`,
  orders: () => `for (let i = 0; i < 5; i++) {
  const row = page.locator('tr', {hasText: 'REFUNDED'});
  if (await row.count()) return await row.textContent();
  await human.click(page.getByRole('button', {name: 'Next'}));
  await page.getByText('Page ' + (i + 2) + ' of 5').waitFor();
}
return null;`,
  report: () => `await human.click(page.getByRole('button', {name: 'Generate report'}));
await page.locator('#total').waitFor();
return await page.locator('#total').textContent();`,
  settings: () => `await human.click(page.getByRole('button', {name: 'More'}));
await human.click(page.getByRole('menuitem', {name: 'Notification settings'}));
await page.getByLabel('Email notifications').uncheck();
await page.getByLabel('Weekly digest').check();
await page.getByLabel('Frequency').selectOption('Monthly');
await human.click(page.getByRole('button', {name: 'Save changes'}));
await page.getByText(/receipt/).waitFor();
return await page.locator('#saved').textContent();`,
  iframe: () => `return await page.frameLocator('iframe').locator('strong').textContent();`,
  directory: () => `await page.getByLabel('Search by surname').fill('Okafor');
await page.getByText(/Okafor/).waitFor();
return await page.locator('#hits').textContent();`,
};

async function runScriptedChecks(deps: ScriptedDeps): Promise<number> {
  let failures = 0;
  for (const task of TASKS) {
    const script = SCRIPTED[task.id];
    if (!script) continue;
    const run = deps.newRun(task.id);
    const url = new URL(task.prompt(run.fixture, deps.base).match(/https?:\/\/\S+/u)?.[0] ?? "");
    await deps.callTool(run, "browser_open", {}, 1);
    const navigated = await deps.callTool(run, "browser_navigate", { url: url.toString() }, 2);
    const outline = navigated.content.map((block) => block.text ?? "").join("\n");
    let code: string;
    try {
      code = script(run.fixture, outline);
    } catch (error) {
      failures += 1;
      console.log(JSON.stringify({ task: task.id, pass: false, text: String(error), outline }));
      await deps.finishRun(run);
      continue;
    }
    const result = await deps.callTool(
      run,
      "browser_run",
      { code, timeoutMs: 20_000, observe: true },
      3,
    );
    const text = result.content.map((block) => block.text ?? "").join("\n");
    const pass = TASKS.find((entry) => entry.id === task.id)!.check(run.fixture, text);
    if (!pass) failures += 1;
    console.log(
      JSON.stringify({ task: task.id, pass, trace: run.trace, ...(pass ? {} : { text }) }),
    );
    await deps.finishRun(run);
  }
  failures += await runRegressionChecks(deps);
  failures += await runConnectionIsolationCheck(deps);
  return failures;
}

const waitUntilValue = async <T>(
  read: () => Promise<T> | T,
  done: (value: T) => boolean,
  timeoutMs: number,
): Promise<T> => {
  const deadline = Date.now() + timeoutMs;
  let value = await read();
  while (!done(value) && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 50));
    value = await read();
  }
  return value;
};

const waitUntil = async (test: () => boolean, timeoutMs: number): Promise<boolean> => {
  const deadline = Date.now() + timeoutMs;
  while (!test()) {
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return true;
};

/**
 * An agent run in one tab must not cut off another tab's own traffic. The
 * guard proxy is session-wide, and resetting the session's connections on
 * each run used to drop every tab's sockets and requests in flight.
 */
async function runConnectionIsolationCheck(deps: ScriptedDeps): Promise<number> {
  const background = deps.newRun("live");
  const live = background.fixture.live;
  await deps.callTool(
    background,
    "browser_open",
    { url: `${deps.base}/live?run=${background.fixture.id}` },
    1,
  );
  const socketOpened = await waitUntil(() => live.socketsOpened === 1, 5_000);

  const agent = deps.newRun("form");
  await deps.callTool(
    agent,
    "browser_open",
    { url: `${deps.base}/form?run=${agent.fixture.id}` },
    2,
  );
  // The person keeps using the background tab while the agent works: a
  // request it starts mid-run travels through that run's guard proxy.
  const backgroundPage = allWebContents
    .getAllWebContents()
    .find((contents) => contents.getURL().includes(`/live?run=${background.fixture.id}`));
  const running = deps.callTool(
    agent,
    "browser_run",
    {
      code: "await page.getByLabel('Full name').fill('Isolation check'); await page.evaluate(() => new Promise((resolve) => setTimeout(resolve, 1500))); return true;",
    },
    3,
  );
  await new Promise((resolve) => setTimeout(resolve, 600));
  await backgroundPage?.executeJavaScript("window.startLate(); true");
  const ran = await running;
  const slowServed = await waitUntil(() => live.slowServed === 1, 6_000);
  const lateStarted = live.lateStarted === 1;
  const lateText = await waitUntilValue(
    () => backgroundPage?.executeJavaScript("document.getElementById('late').textContent") ?? "",
    (text) => text === "late done" || text.startsWith("failed"),
    8_000,
  );
  const read = await deps.callTool(
    background,
    "browser_run",
    {
      code: "await page.getByText('slow done').waitFor({timeout: 4000}); return await page.locator('#socket').textContent();",
    },
    4,
  );
  const readText = read.content.map((block) => block.text ?? "").join("\n");
  const checks = {
    agentRunSucceeded: ran.isError !== true,
    backgroundSocketOpened: socketOpened,
    // The background tab's own browser_run above replaces the guard once
    // more; its socket must still be the one opened before any agent run.
    backgroundSocketSurvived: live.socketsClosed === 0 && live.socketsOpened === 1,
    backgroundSlowRequestCompleted:
      slowServed && read.isError !== true && readText.includes("open"),
    backgroundRequestStartedMidRunCompleted: lateStarted && lateText === "late done",
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify({
      task: "connection-isolation",
      pass,
      checks,
      trace: [...background.trace, ...agent.trace],
      ...(pass ? {} : { text: `${readText}\nlate: ${lateText}` }),
    }),
  );
  await deps.finishRun(agent);
  await deps.finishRun(background);
  return pass ? 0 : 1;
}

/**
 * Regressions found by this eval. A script that clicks and returns before the
 * page's request finishes used to cut that request off (the worker's guard
 * proxy shut down with it), and a script without `return` used to report a
 * failure although every action ran.
 */
async function runRegressionChecks(deps: ScriptedDeps): Promise<number> {
  const run = deps.newRun("report");
  const url = `${deps.base}/report?run=${run.fixture.id}`;
  await deps.callTool(run, "browser_open", { url }, 1);
  const clicked = await deps.callTool(
    run,
    "browser_run",
    { code: "await human.click(page.getByRole('button', {name: 'Generate report'}));" },
    2,
  );
  const read = await deps.callTool(
    run,
    "browser_run",
    {
      code: "await page.locator('#total').waitFor({timeout: 4000}); return await page.locator('#total').textContent();",
    },
    3,
  );
  const clickText = clicked.content.map((block) => block.text ?? "").join("\n");
  const readText = read.content.map((block) => block.text ?? "").join("\n");
  const checks = {
    noReturnIsSuccess: clicked.isError !== true && clickText.includes('"value":null'),
    inFlightRequestSurvived: read.isError !== true && readText.includes(run.fixture.report),
  };
  const pass = Object.values(checks).every(Boolean);
  console.log(
    JSON.stringify({
      task: "regressions",
      pass,
      checks,
      trace: run.trace,
      ...(pass ? {} : { text: `${clickText}\n${readText}` }),
    }),
  );
  await deps.finishRun(run);
  return pass ? 0 : 1;
}

void main().catch((error: unknown) => {
  console.error(error);
  app.exit(1);
});
