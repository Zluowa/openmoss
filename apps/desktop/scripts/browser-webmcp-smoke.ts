// Real-Electron check of Moss's WebMCP host (browser_webmcp_tools / browser_webmcp_call).
//
// A page in a real guest registers tools through Moss's own shim (the guest bridge
// preload), and the host functions the agent tools use list and call them. The guest
// is parked exactly as BrowserManager parks a hidden pane (an invisible WebContentsView
// in a window), and the window is never shown: nothing appears on screen, and the
// calls must still finish. Loopback only; no network, no profile, no sign-in.
//
// Fixtures: the vendored UI SDK project-settings page (third_party/ui-sdk-webmcp-fixture,
// @ui-sdk/* 0.1.0-beta.6) and a plain hand-written WebMCP page.
import { strict as assert } from "node:assert";
import { once } from "node:events";
import { readFile, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { join, resolve } from "node:path";
import { app, BrowserWindow, ipcMain, WebContentsView, type WebContents } from "electron";

import type {
  BrowserWebMcpDiscoveryId,
  BrowserWebMcpToolId,
  BrowserWebMcpToolsOutput,
  ThreadId,
} from "@moss/contracts";
import { BROWSER_IPC_CHANNELS } from "../src/ipcChannels";
import type { BrowserAutomationVisibleRuntime } from "../src/browserManager";
import {
  discoverWebMcpTools,
  invokeWebMcpTool,
  keepGuestFramesRunning,
  type WebMcpDiscoveryHandle,
} from "../src/browserAutomation/webMcp";

const fixtureRoot = resolve(
  process.env.MOSS_WEBMCP_FIXTURE_DIR ?? "../../third_party/ui-sdk-webmcp-fixture",
);
const preloadPath = resolve(process.env.MOSS_WEBMCP_PRELOAD ?? ".smoke/webmcp-preload.cjs");
const deadline = setTimeout(() => {
  console.error("WebMCP smoke timed out.");
  app.exit(1);
}, 120_000);

const PLAIN_PAGE = `<!doctype html><meta charset="utf-8"><title>Plain WebMCP</title>
<p id="out">idle</p>
<script>
  document.modelContext.registerTool({
    name: "greet",
    description: "Return a greeting for a name.",
    inputSchema: { type: "object", properties: { name: { type: "string" } }, required: ["name"] },
    annotations: { readOnlyHint: true },
    execute: async ({ name }) => ({ greeting: "Hello, " + name }),
  });
  document.modelContext.registerTool({
    name: "set_note",
    description: "Write a note on the page.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    execute: async ({ text }) => { document.getElementById("out").textContent = text; return { ok: true }; },
  });
  // Never answers: the host must stop waiting at its deadline.
  document.modelContext.registerTool({
    name: "hang",
    description: "Never finishes.",
    annotations: { readOnlyHint: true },
    execute: () => new Promise(() => {}),
  });
</script>`;

async function startServer(): Promise<string> {
  const files: Record<string, { readonly path: string; readonly type: string }> = {
    "/index.html": { path: join(fixtureRoot, "index.html"), type: "text/html; charset=utf-8" },
    "/dist/main.js": { path: join(fixtureRoot, "dist/main.js"), type: "text/javascript" },
  };
  const server = createServer((request, response) => {
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    if (url.pathname === "/plain.html") {
      response.setHeader("Content-Type", "text/html; charset=utf-8");
      response.end(PLAIN_PAGE);
      return;
    }
    const file = files[url.pathname];
    if (!file) {
      response.statusCode = 404;
      response.end();
      return;
    }
    void readFile(file.path).then(
      (body) => {
        response.setHeader("Content-Type", file.type);
        response.end(body);
      },
      () => {
        response.statusCode = 500;
        response.end();
      },
    );
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  return `http://127.0.0.1:${(server.address() as { port: number }).port}`;
}

/** An invisible guest attached to a window, as BrowserManager parks a hidden pane's tab. */
async function parkedGuest(window: BrowserWindow, url: string): Promise<WebContents> {
  const view = new WebContentsView({
    webPreferences: { preload: preloadPath, sandbox: true, contextIsolation: true },
  });
  window.contentView.addChildView(view);
  view.setBounds({ x: 0, y: 0, width: 1280, height: 800 });
  view.setVisible(false);
  await view.webContents.loadURL(url);
  return view.webContents;
}

const runtimeFor = (contents: WebContents, tabId: string): BrowserAutomationVisibleRuntime =>
  ({
    threadId: "smoke-thread" as ThreadId,
    tabId,
    webContents: contents,
  }) as BrowserAutomationVisibleRuntime;

async function discoverWhenReady(
  runtime: BrowserAutomationVisibleRuntime,
  minimumTools: number,
): Promise<{ output: BrowserWebMcpToolsOutput; handle: WebMcpDiscoveryHandle }> {
  const until = Date.now() + 15_000;
  for (;;) {
    const discovery = await discoverWebMcpTools(
      runtime,
      { limit: 8 },
      0,
      new AbortController().signal,
    );
    if (discovery.handle && discovery.output.tools.length >= minimumTools) {
      return { output: discovery.output, handle: discovery.handle };
    }
    await discovery.handle?.release();
    if (Date.now() > until) {
      throw new Error(`Page tools never appeared: ${JSON.stringify(discovery.output)}`);
    }
    await new Promise((done) => setTimeout(done, 100));
  }
}

async function call(
  runtime: BrowserAutomationVisibleRuntime,
  discovery: { output: BrowserWebMcpToolsOutput; handle: WebMcpDiscoveryHandle },
  name: string,
  args: Record<string, unknown>,
  timeoutMs = 10_000,
) {
  const tool = discovery.output.tools.find((entry) => entry.name === name);
  assert.ok(tool, `tool ${name} was discovered`);
  const controller = new AbortController();
  const timer = setTimeout(
    () => controller.abort(new Error(`${name} did not finish in ${timeoutMs} ms`)),
    timeoutMs,
  );
  const started = performance.now();
  try {
    const outcome = await invokeWebMcpTool(
      runtime,
      {
        discoveryId: discovery.output.discoveryId as BrowserWebMcpDiscoveryId,
        toolId: tool.toolId as BrowserWebMcpToolId,
        origin: tool.origin,
        arguments: args,
      },
      discovery.handle,
      controller.signal,
    );
    return { ...outcome, ms: Math.round(performance.now() - started) };
  } finally {
    clearTimeout(timer);
  }
}

const pageText = (contents: WebContents, expression: string) =>
  contents.executeJavaScript(expression, false) as Promise<unknown>;

/** Whether the page gets an animation frame within 1.5 s right now. */
const framesRun = (contents: WebContents) =>
  contents.executeJavaScript(
    `new Promise((done) => { requestAnimationFrame(() => done(true)); setTimeout(() => done(false), 1500); })`,
    false,
  ) as Promise<boolean>;

/** Calls UI SDK's act through the bridge directly, without Moss's per-call frames lease. */
async function actWithoutLease(
  contents: WebContents,
  discovery: { output: BrowserWebMcpToolsOutput; handle: WebMcpDiscoveryHandle },
  steps: unknown[],
  waitMs: number,
): Promise<string> {
  const actTool = discovery.output.tools.find((tool) => tool.name === "act")!;
  const entry = discovery.handle.entries.get(actTool.toolId as BrowserWebMcpToolId)!;
  const raw = contents.debugger.sendCommand("Runtime.callFunctionOn", {
    objectId: discovery.handle.contextObjectId,
    functionDeclaration: "async function(i, s, a, id) { return await this.invoke(i, s, a, id); }",
    arguments: [
      { value: entry.index },
      { value: entry.signature },
      { value: JSON.stringify({ steps }) },
      { value: `control-${Date.now()}` },
    ],
    awaitPromise: true,
    returnByValue: true,
  });
  return (await Promise.race([
    raw.then(
      (value) =>
        `returned ${JSON.stringify((value as { result?: { value?: unknown } }).result?.value).slice(0, 400)}`,
    ),
    new Promise((done) => setTimeout(() => done(`stalled (no result after ${waitMs} ms)`), waitMs)),
  ])) as string;
}

async function smoke() {
  ipcMain.on(BROWSER_IPC_CHANNELS.webMcpCompatibilityPolicy, (event) => {
    event.returnValue = true;
  });
  await app.whenReady();
  const origin = await startServer();
  // Never shown: the whole check runs off screen.
  const window = new BrowserWindow({ show: false, width: 1280, height: 800 });
  const report: Record<string, unknown> = {};

  // --- UI SDK page, guest hidden ---------------------------------------------
  const guest = await parkedGuest(window, `${origin}/index.html`);
  assert.equal(guest.getBackgroundThrottling(), true, "a parked guest starts throttled");
  assert.equal(await pageText(guest, "document.visibilityState"), "hidden", "the guest is hidden");
  const runtime = runtimeFor(guest, "tab-uisdk");
  const discovery = await discoverWhenReady(runtime, 3);
  const byName = Object.fromEntries(discovery.output.tools.map((tool) => [tool.name, tool]));
  assert.equal(discovery.output.implementation, "compatibility");
  assert.deepEqual(Object.keys(byName).toSorted(), ["act", "query", "snapshot"]);
  assert.equal(byName.snapshot!.origin, origin);
  assert.deepEqual(byName.snapshot!.annotations, {
    readOnlyHint: true,
    consequentialHint: false,
    untrustedContentHint: true,
  });
  assert.equal(byName.act!.annotations.readOnlyHint, false);
  // UI SDK marks act consequential; the bridge must keep that through.
  assert.equal(byName.act!.annotations.consequentialHint, true);
  // The recorded copy the gateway's approval test reads must match what the
  // real page declares through Moss's shim (names, hints, schemas).
  const recordedPath = join(fixtureRoot, "discovery.json");
  const live = discovery.output.tools
    .map(({ name, description, inputSchema, annotations }) => ({
      name,
      description,
      inputSchema,
      annotations,
    }))
    .toSorted((left, right) => left.name.localeCompare(right.name));
  if (process.env.MOSS_WEBMCP_RECORD === "1") {
    await writeFile(
      recordedPath,
      `${JSON.stringify({ tools: live }, null, 2)}
`,
    );
  }
  assert.deepEqual(live, JSON.parse(await readFile(recordedPath, "utf8")).tools);

  const snapshot = await call(runtime, discovery, "snapshot", {});
  assert.equal(snapshot.status, "completed", JSON.stringify(snapshot));
  const snapshotText = JSON.stringify(snapshot.status === "completed" ? snapshot.result : null);
  for (const label of ["Project name", "Visibility", "Save", "Delete project"]) {
    assert.ok(snapshotText.includes(label), `snapshot lists ${label}: ${snapshotText}`);
  }
  assert.ok(snapshotText.includes("confirm"), "the delete button carries confirm");
  report.snapshot = { ms: snapshot.ms, chars: snapshotText.length };
  assert.equal(guest.getBackgroundThrottling(), true, "throttling restored after snapshot");

  const save = await call(runtime, discovery, "act", {
    steps: [
      { ref: "Project name", action: "setValue", args: ["Atlas"] },
      { ref: "Visibility", action: "setValue", args: ["Team"] },
      { ref: "Email notifications", action: "setChecked", args: [true] },
      { ref: "Save", action: "press" },
    ],
  });
  assert.equal(save.status, "completed", JSON.stringify(save));
  const saveText = JSON.stringify(save.status === "completed" ? save.result : null);
  assert.ok(saveText.includes('"ok":true'), `act reports ok: ${saveText}`);
  assert.equal(await pageText(guest, `document.querySelector("ui-input input").value`), "Atlas");
  assert.match(
    String(await pageText(guest, `document.querySelector("#status").textContent`)),
    /已保存/u,
  );
  assert.equal(guest.getBackgroundThrottling(), true, "throttling restored after act");
  report.act = { ms: save.ms, result: saveText.slice(0, 300) };

  // The page's own allow() refuses confirm-marked steps; Moss does not answer for the person.
  const remove = await call(runtime, discovery, "act", {
    steps: [{ ref: "Delete project", action: "press" }],
  });
  const removeText = JSON.stringify(remove);
  assert.ok(/refused/iu.test(removeText), `delete is refused by the page: ${removeText}`);
  report.deleteRefused = removeText.slice(0, 300);

  const secret = await call(runtime, discovery, "act", {
    steps: [{ ref: "Visibility", action: "setValue", args: ["Secret"] }],
  });
  const secretText = JSON.stringify(secret);
  assert.ok(secretText.includes("Private") && secretText.includes("Public"), secretText);
  report.unknownChoice = secretText.slice(0, 300);
  await discovery.handle.release();

  // --- Plain hand-written WebMCP page ----------------------------------------
  const plain = await parkedGuest(window, `${origin}/plain.html`);
  const plainRuntime = runtimeFor(plain, "tab-plain");
  const plainDiscovery = await discoverWhenReady(plainRuntime, 3);
  const greet = plainDiscovery.output.tools.find((tool) => tool.name === "greet")!;
  const setNote = plainDiscovery.output.tools.find((tool) => tool.name === "set_note")!;
  assert.equal(greet.annotations.consequentialHint, false);
  // No hints at all counts as consequential.
  assert.equal(setNote.annotations.consequentialHint, true);
  const greeting = await call(plainRuntime, plainDiscovery, "greet", { name: "Moss" });
  assert.deepEqual(greeting.status === "completed" ? greeting.result : null, {
    greeting: "Hello, Moss",
  });
  await call(plainRuntime, plainDiscovery, "set_note", { text: "from agent" });
  assert.equal(await pageText(plain, `document.getElementById("out").textContent`), "from agent");

  // A page tool that never answers: the call ends at the deadline, frames go back to
  // the guest's own setting, and the same guest still answers and navigates.
  const hangStarted = performance.now();
  const hung = await call(plainRuntime, plainDiscovery, "hang", {}, 800).then(
    () => "answered",
    (error: unknown) => String(error),
  );
  const hangMs = Math.round(performance.now() - hangStarted);
  assert.match(hung, /did not finish in 800 ms/u);
  assert.ok(hangMs < 2_000, `the hung call returned after ${hangMs} ms`);
  assert.equal(plain.getBackgroundThrottling(), true, "throttling restored after the hung call");
  const afterHang = await call(plainRuntime, plainDiscovery, "greet", { name: "again" });
  assert.deepEqual(afterHang.status === "completed" ? afterHang.result : null, {
    greeting: "Hello, again",
  });
  report.hungToolReturnedAfterMs = hangMs;
  await plainDiscovery.handle.release();
  await plain.loadURL(`${origin}/index.html`);
  assert.equal(await pageText(plain, "location.pathname"), "/index.html");

  // --- A window that stops painting (what minimising or hiding Moss does) -----
  // paintWhenInitiallyHidden:false keeps this never-shown window's renderers
  // inactive, as a minimised window's are. Nothing is shown on screen.
  const asleep = new BrowserWindow({
    show: false,
    width: 1280,
    height: 800,
    paintWhenInitiallyHidden: false,
  });
  const sleeping = await parkedGuest(asleep, `${origin}/index.html`);
  const sleepingRuntime = runtimeFor(sleeping, "tab-asleep");
  const sleepingDiscovery = await discoverWhenReady(sleepingRuntime, 3);
  report.framesWhenAsleep = await framesRun(sleeping);
  {
    const restore = keepGuestFramesRunning(sleeping);
    report.framesWhenAsleepWithLease = await framesRun(sleeping);
    restore();
  }
  report.actWhenAsleepWithoutLease = await actWithoutLease(
    sleeping,
    sleepingDiscovery,
    [
      { ref: "Project name", action: "setValue", args: ["Control"] },
      { ref: "Visibility", action: "setValue", args: ["Team"] },
      { ref: "Email notifications", action: "setChecked", args: [true] },
      { ref: "Save", action: "press" },
    ],
    6_000,
  );
  // A fresh page for the real call, so a stalled control cannot hold it up.
  const sleepingAgain = await parkedGuest(asleep, `${origin}/index.html`);
  const againRuntime = runtimeFor(sleepingAgain, "tab-asleep-2");
  const againDiscovery = await discoverWhenReady(againRuntime, 3);
  assert.equal(sleepingAgain.getBackgroundThrottling(), true);
  const asleepAct = await call(
    againRuntime,
    againDiscovery,
    "act",
    {
      steps: [
        { ref: "Project name", action: "setValue", args: ["Atlas"] },
        { ref: "Visibility", action: "setValue", args: ["Team"] },
        { ref: "Email notifications", action: "setChecked", args: [true] },
        { ref: "Save", action: "press" },
      ],
    },
    10_000,
  );
  assert.equal(asleepAct.status, "completed", JSON.stringify(asleepAct));
  assert.ok(JSON.stringify(asleepAct).includes('"ok":true'), JSON.stringify(asleepAct));
  assert.match(
    String(await pageText(sleepingAgain, `document.querySelector("#status").textContent`)),
    /已保存/u,
  );
  // The lease ends with the call: the guest is throttled again afterwards.
  assert.equal(sleepingAgain.getBackgroundThrottling(), true, "throttling restored");
  report.actWhenAsleepWithLease = { ms: asleepAct.ms };
  asleep.destroy();

  console.log(`WEBMCP_SMOKE_REPORT ${JSON.stringify(report)}`);
  window.destroy();
}

void smoke().then(
  () => {
    clearTimeout(deadline);
    console.log("WebMCP smoke passed.");
    app.exit(0);
  },
  (error: unknown) => {
    clearTimeout(deadline);
    console.error("WebMCP smoke failed:", error);
    app.exit(1);
  },
);
