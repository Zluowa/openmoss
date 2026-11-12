#!/usr/bin/env node
// FILE: server.mjs
// Purpose: Dependency-free MCP Apps fixture server for Moss's interactive connectors: one UI tool,
//   widget-only and model-only tools, a UI resource with resource-level `_meta.ui` (csp,
//   permissions, prefersBorder, domain), structuredContent, a downloadable file, a template and a
//   prompt. Speaks stdio (default) or Streamable HTTP (`--http <port>`). Used by integration tests
//   and the coordinator's acceptance runs; see README.md.
// Layer: Test fixture (plain Node, no network beyond the loopback listener)

import { appendFileSync, existsSync, readFileSync } from "node:fs";
import http from "node:http";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const args = process.argv.slice(2);
const httpIndex = args.indexOf("--http");
const httpPort = httpIndex >= 0 ? Number(args[httpIndex + 1] ?? 0) : undefined;
const traceIndex = args.indexOf("--trace");
const tracePath = traceIndex >= 0 ? args[traceIndex + 1] : process.env.MOSS_MCP_APPS_FIXTURE_TRACE;
const trace = (kind, data) => {
  if (tracePath) appendFileSync(tracePath, `${JSON.stringify({ t: Date.now(), kind, data })}\n`);
};

export const WIDGET_URI = "ui://fixture/widget.html";
export const FILE_URI = "fixture://files/report.txt";

/** The ext-apps 1.7.5 `App` SDK bundle, read (never copied) from the repo's node_modules. */
function appSdkSource() {
  const candidates = [
    join(
      here,
      "../../../web/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
    ),
    join(here, "../../../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"),
    join(here, "../../node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js"),
  ];
  const found = candidates.find((candidate) => existsSync(candidate));
  if (!found) throw new Error("ext-apps App SDK not found in node_modules");
  // Inline <script> text must not close early.
  return readFileSync(found, "utf8").replaceAll("</script", "<\\/script");
}

let cachedWidget;
export function widgetHtml() {
  cachedWidget ??= readFileSync(join(here, "widget.html"), "utf8").replace(
    "<!--MOSS_EXT_APPS_SDK-->",
    // A replacer function: the SDK source contains `$&` and `` $` ``, which a replacement
    // string would expand.
    () => `<script type="text/plain" id="ext-apps-sdk">${appSdkSource()}</script>`,
  );
  return cachedWidget;
}

const ui = (visibility) => ({
  ui: { resourceUri: WIDGET_URI, ...(visibility ? { visibility } : {}) },
});

export const tools = [
  {
    name: "fixture_show_widget",
    title: "Fixture widget",
    description: "Shows the Moss fixture widget with a greeting and a counter.",
    inputSchema: {
      type: "object",
      properties: { name: { type: "string" }, count: { type: "number" } },
    },
    annotations: { readOnlyHint: true },
    _meta: { ...ui(["model", "app"]), "ui/resourceUri": WIDGET_URI },
  },
  {
    name: "fixture_app_increment",
    title: "Increment",
    description: "Widget-only: adds one to the counter.",
    inputSchema: { type: "object", properties: { count: { type: "number" } } },
    _meta: ui(["app"]),
  },
  {
    name: "fixture_app_read",
    title: "Read state",
    description: "Widget-only, read-only: returns the counter.",
    inputSchema: { type: "object", properties: {} },
    annotations: { readOnlyHint: true },
    _meta: ui(["app"]),
  },
  {
    name: "fixture_model_only",
    title: "Model only",
    description: "Model-only helper; a widget must not be able to call it.",
    inputSchema: { type: "object", properties: { text: { type: "string" } } },
    _meta: { ui: { visibility: ["model"] } },
  },
  {
    name: "fixture_bad_structured",
    title: "Bad structured content",
    description: "Returns structuredContent that is not an object (a host must refuse it).",
    inputSchema: { type: "object", properties: {} },
    _meta: { ...ui(["model", "app"]) },
  },
];

let counter = 0;

function callTool(params) {
  const name = params?.name;
  const input = params?.arguments ?? {};
  switch (name) {
    case "fixture_show_widget": {
      counter = typeof input.count === "number" ? input.count : counter;
      const greeting = `Hello, ${typeof input.name === "string" ? input.name : "Moss"}!`;
      return {
        content: [{ type: "text", text: `${greeting} The counter is ${counter}.` }],
        structuredContent: { greeting, count: counter, items: ["one", "two", "three"] },
        _meta: {
          "fixture/renderedAt": new Date(0).toISOString(),
          "moss/internal": "must be stripped",
          "anthropic/internal": "must be stripped",
        },
      };
    }
    case "fixture_app_increment":
      counter = (typeof input.count === "number" ? input.count : counter) + 1;
      return {
        content: [{ type: "text", text: `Counter is now ${counter}.` }],
        structuredContent: { count: counter },
      };
    case "fixture_app_read":
      return {
        content: [{ type: "text", text: String(counter) }],
        structuredContent: { count: counter },
      };
    case "fixture_model_only":
      return { content: [{ type: "text", text: `echo: ${String(input.text ?? "")}` }] };
    case "fixture_bad_structured":
      return { content: [{ type: "text", text: "array" }], structuredContent: [1, 2, 3] };
    default:
      return undefined;
  }
}

function handle(message) {
  trace("in", message);
  const { id, method, params } = message ?? {};
  if (id === undefined || id === null) return undefined; // notification
  const ok = (result) => ({ jsonrpc: "2.0", id, result });
  const fail = (code, text) => ({ jsonrpc: "2.0", id, error: { code, message: text } });
  switch (method) {
    case "initialize":
      return ok({
        protocolVersion: params?.protocolVersion ?? "2025-06-18",
        capabilities: {
          tools: { listChanged: false },
          resources: { listChanged: false },
          prompts: {},
        },
        serverInfo: { name: "moss-mcp-apps-fixture", version: "1.0.0" },
      });
    case "ping":
      return ok({});
    case "tools/list":
      return ok({ tools });
    case "tools/call": {
      const result = callTool(params);
      return result ? ok(result) : fail(-32602, `Unknown tool: ${String(params?.name)}`);
    }
    case "resources/list":
      return ok({
        resources: [
          { uri: WIDGET_URI, name: "fixture-widget", mimeType: "text/html;profile=mcp-app" },
          { uri: FILE_URI, name: "report.txt", mimeType: "text/plain" },
        ],
      });
    case "resources/templates/list":
      return ok({
        resourceTemplates: [
          { uriTemplate: "fixture://files/{name}", name: "fixture-file", mimeType: "text/plain" },
        ],
      });
    case "resources/read": {
      if (params?.uri === WIDGET_URI) {
        return ok({
          contents: [
            {
              uri: WIDGET_URI,
              mimeType: "text/html;profile=mcp-app",
              text: widgetHtml(),
              _meta: {
                ui: {
                  csp: {
                    connectDomains: ["https://api.fixture.example"],
                    resourceDomains: ["https://cdn.fixture.example"],
                  },
                  permissions: { clipboardWrite: {} },
                  prefersBorder: true,
                  domain: "fixture.example",
                },
              },
            },
          ],
        });
      }
      if (params?.uri === FILE_URI) {
        return ok({
          contents: [{ uri: FILE_URI, mimeType: "text/plain", text: "Fixture report\n" }],
        });
      }
      return fail(-32002, `Resource not found: ${String(params?.uri)}`);
    }
    case "prompts/list":
      return ok({ prompts: [{ name: "fixture_prompt", description: "A fixture prompt." }] });
    default:
      return fail(-32601, `Method not found: ${String(method)}`);
  }
}

function respond(message) {
  if (Array.isArray(message)) {
    const answers = message.map(handle).filter(Boolean);
    return answers.length > 0 ? answers : undefined;
  }
  return handle(message);
}

function startStdio() {
  const lines = createInterface({ input: process.stdin });
  lines.on("line", (line) => {
    if (!line.trim()) return;
    let message;
    try {
      message = JSON.parse(line);
    } catch {
      return;
    }
    const answer = respond(message);
    if (answer) {
      trace("out", answer);
      process.stdout.write(`${JSON.stringify(answer)}\n`);
    }
  });
}

export function startHttp(port, host = "127.0.0.1") {
  const sessions = new Set();
  const server = http.createServer((request, response) => {
    if (request.url !== "/mcp") {
      response.writeHead(404).end();
      return;
    }
    if (request.method === "DELETE") {
      sessions.delete(request.headers["mcp-session-id"]);
      response.writeHead(204).end();
      return;
    }
    if (request.method !== "POST") {
      response.writeHead(405, { allow: "POST, DELETE" }).end();
      return;
    }
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      let message;
      try {
        message = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      } catch {
        response.writeHead(400).end();
        return;
      }
      const headers = { "content-type": "application/json" };
      if (!Array.isArray(message) && message?.method === "initialize") {
        const sessionId = `fixture-${sessions.size + 1}-${Date.now()}`;
        sessions.add(sessionId);
        headers["mcp-session-id"] = sessionId;
      } else {
        const sessionId = request.headers["mcp-session-id"];
        if (sessionId && !sessions.has(sessionId)) {
          response.writeHead(404, headers).end(JSON.stringify({ error: "unknown session" }));
          return;
        }
      }
      const answer = respond(message);
      if (!answer) {
        response.writeHead(202).end();
        return;
      }
      trace("out", answer);
      response.writeHead(200, headers).end(JSON.stringify(answer));
    });
  });
  return new Promise((resolve) => {
    server.listen(port, host, () => resolve(server));
  });
}

const isMain =
  process.argv[1] !== undefined &&
  resolve(process.argv[1]).toLowerCase() === fileURLToPath(import.meta.url).toLowerCase();
if (isMain) {
  if (httpPort !== undefined) {
    const server = await startHttp(httpPort);
    const address = server.address();
    process.stderr.write(
      `moss-mcp-apps-fixture listening on http://127.0.0.1:${address.port}/mcp\n`,
    );
  } else {
    startStdio();
  }
}
