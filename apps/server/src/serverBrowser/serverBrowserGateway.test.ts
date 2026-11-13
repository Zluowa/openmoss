/**
 * The server browser behind the real agent gateway tools: every tool's output
 * must pass the same strict host-output schemas the desktop browser does.
 */
import { existsSync, readdirSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { Effect } from "effect";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { makeAgentGatewayBrowserTools } from "../agentGateway/browserTools.ts";
import type { ToolContext } from "../agentGateway/toolRuntime.ts";
import { makeServerBrowserAutomationHost } from "../browserAutomation/Layers/BrowserAutomationHost.ts";

import { ServerBrowserRuntime } from "./ServerBrowserRuntime.ts";
import { ServerBrowserViewerHub } from "./ServerBrowserViewers.ts";

const headlessShell = (() => {
  const explicit = process.env.MOSS_TEST_CHROMIUM?.trim();
  if (explicit && existsSync(explicit)) return explicit;
  const root = process.env.PLAYWRIGHT_BROWSERS_PATH ?? "/opt/pw-browsers";
  try {
    for (const entry of readdirSync(root).filter((name) =>
      /^chromium_headless_shell-\d+$/u.test(name),
    )) {
      const candidate = join(root, entry, "chrome-headless-shell-linux64", "chrome-headless-shell");
      if (existsSync(candidate)) return candidate;
    }
  } catch {
    // No browsers directory.
  }
  return "";
})();

const context: ToolContext = {
  principal: {
    kind: "provider-session",
    sessionKey: "gateway-session:server-browser",
    threadId: "thread-gateway",
    provider: "claudeAgent",
    turnId: "turn-a",
  },
  callerThreadId: "thread-gateway",
  callerThreadLabel: null,
  callerSessionKey: "gateway-session:server-browser",
  callerProvider: "claudeAgent",
  callerCapabilities: new Set(["browser:control"]),
  callerTurnId: "turn-a",
  assertCallerTurnActive: () => Effect.void,
  jsonRpcRequestId: 1,
};

const PAGE = `<!doctype html><title>Gateway</title>
<form><input type="file" id="file"><button type="button" onclick="document.title='pressed'">Press</button></form>
<script>console.warn("page warning")</script>`;

describe.skipIf(headlessShell === "")("server browser through the agent gateway tools", () => {
  let server: Server;
  let origin: string;
  let home: string;
  let workspace: string;
  let runtime: ServerBrowserRuntime;
  let tools: ReturnType<typeof makeAgentGatewayBrowserTools>;
  let requestId = 1;

  beforeAll(async () => {
    server = createServer((_request, response) => {
      response.writeHead(200, { "content-type": "text/html" }).end(PAGE);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    origin = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}`;
    home = await mkdtemp(join(tmpdir(), "moss-server-browser-gw-"));
    workspace = await mkdtemp(join(tmpdir(), "moss-server-browser-ws-"));
    await writeFile(join(workspace, "notes.txt"), "hello");
    runtime = new ServerBrowserRuntime({
      betterwrightHome: home,
      resolveExecutable: async () => headlessShell,
      // The fixture is on loopback, which the server browser otherwise refuses.
      navigationGuard: async (url) => url.origin === origin,
    });
    const host = makeServerBrowserAutomationHost({
      enabled: true,
      runtime,
      hub: new ServerBrowserViewerHub(runtime),
    });
    tools = makeAgentGatewayBrowserTools(host, {
      resolveWorkspaceRoot: () => Effect.succeed(workspace),
      saveProof: async () => join(workspace, "proof.png"),
    });
  });

  afterAll(async () => {
    await runtime.dispose();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
  });

  const call = async (name: string, args: Record<string, unknown> = {}) => {
    const tool = tools.find((entry) => entry.definition.name === name);
    if (!tool) throw new Error(`missing tool ${name}`);
    const result = await Effect.runPromise(
      tool.handler(args, { ...context, jsonRpcRequestId: requestId++ }),
    );
    const text = result.content.find((entry) => entry.type === "text");
    return {
      isError: result.isError === true,
      structured: (result.structuredContent ?? {}) as Record<string, unknown>,
      text: text?.type === "text" ? text.text : "",
      images: result.content.filter((entry) => entry.type === "image").length,
    };
  };

  it("serves every browser tool with schema-valid output", async () => {
    const status = await call("browser_status");
    expect(status.isError).toBe(false);
    expect(status.structured).toMatchObject({
      available: true,
      physicalScope: "server-headless-chromium",
    });

    const opened = await call("browser_open", { url: origin });
    expect(opened.isError, opened.text).toBe(false);
    const tabId = opened.structured.tabId as string;
    expect(opened.structured).toMatchObject({ disposition: "created", finalUrl: `${origin}/` });

    for (const [name, args] of [
      ["browser_tabs", {}],
      ["browser_navigate", { url: `${origin}/second` }],
      ["browser_back", {}],
      ["browser_forward", {}],
      ["browser_reload", {}],
      ["browser_reload", { ignoreCache: true }],
      ["browser_resize", { width: 1024, height: 700 }],
      ["browser_logs", {}],
      ["browser_upload", { target: { selector: "#file" }, paths: ["notes.txt"] }],
    ] as const) {
      const result = await call(name, args);
      expect(result.isError, `${name}: ${result.text}`).toBe(false);
    }

    const shot = await call("browser_screenshot", { kind: "proof" });
    expect(shot.isError, shot.text).toBe(false);
    expect(shot.images).toBe(1);
    expect(shot.structured).toMatchObject({ tabId, artifactPath: join(workspace, "proof.png") });

    const run = await call("browser_run", {
      code: 'await human.click(page.getByRole("button", { name: "Press" })); return await page.title();',
    });
    expect(run.isError, run.text).toBe(false);
    expect(run.structured).toMatchObject({ tabId, value: "pressed" });
    expect(run.text.startsWith("Untrusted browser data")).toBe(true);

    const upload = await call("browser_upload", {
      target: { selector: "#file" },
      paths: ["../escape.txt"],
    });
    expect(upload.isError).toBe(true);
  }, 90_000);

  it("tells the agent on its next call that a person released control", async () => {
    const opened = await call("browser_open", {});
    const tab = runtime.thread("thread-gateway")!.tabs.get(opened.structured.tabId as string)!;
    await tab.control.take("viewer");
    const refused = await call("browser_navigate", { url: origin });
    expect(refused.isError).toBe(true);
    expect(refused.text).toContain("BrowserInterruptedByHuman");
    await tab.control.release("viewer");
    const next = await call("browser_tabs");
    expect(next.isError).toBe(false);
    expect(next.text).toContain("has released it");
    const after = await call("browser_tabs");
    expect(after.text).not.toContain("has released it");
  }, 30_000);
});
