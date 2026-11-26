import { execFileSync, spawn } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import http from "node:http";
import https from "node:https";
import net from "node:net";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";
import { build as buildBundle } from "tsdown";
import { describe, expect, it } from "vitest";

function resolveOpenssl(): string {
  const candidates = [
    "openssl",
    process.platform === "win32" ? "C:\\Program Files\\Git\\usr\\bin\\openssl.exe" : undefined,
    process.platform === "win32" ? "C:\\Program Files\\Git\\mingw64\\bin\\openssl.exe" : undefined,
  ];
  for (const candidate of candidates) {
    if (!candidate) continue;
    try {
      execFileSync(candidate, ["version"], { stdio: "ignore" });
      return candidate;
    } catch {
      // try next candidate
    }
  }
  throw new Error("openssl binary not found for TLS E2E fixture");
}

function generateTlsCert(dir: string): { certPath: string; keyPath: string } {
  const openssl = resolveOpenssl();
  const keyPath = join(dir, "key.pem");
  const certPath = join(dir, "cert.pem");
  const confPath = join(dir, "openssl.cnf");
  writeFileSync(
    confPath,
    [
      "[req]",
      "distinguished_name = req_distinguished_name",
      "x509_extensions = v3_req",
      "prompt = no",
      "[req_distinguished_name]",
      "CN = moss-cn-models.inkcomicai.com",
      "[v3_req]",
      "subjectAltName = @alt_names",
      "basicConstraints = CA:TRUE",
      "[alt_names]",
      "DNS.1 = moss-cn-models.inkcomicai.com",
      "DNS.2 = api.mossbotai.com",
    ].join("\n"),
  );
  execFileSync(
    openssl,
    [
      "req",
      "-x509",
      "-newkey",
      "rsa:2048",
      "-keyout",
      keyPath,
      "-out",
      certPath,
      "-days",
      "1",
      "-nodes",
      "-config",
      confPath,
      "-extensions",
      "v3_req",
    ],
    { stdio: "ignore" },
  );
  return { certPath, keyPath };
}

describe("MossAppsRuntime end-to-end over TLS + HTTP CONNECT proxy", () => {
  it("connects a Composio app, lists tools, and executes tools/call across CN and Global gateways via HTTPS_PROXY", async () => {
    const dir = mkdtempSync(join(tmpdir(), "moss-apps-e2e-"));
    const { certPath, keyPath } = generateTlsCert(dir);
    const { readFileSync } = await import("node:fs");
    const cert = readFileSync(certPath);
    const key = readFileSync(keyPath);

    let connected = false;
    const executedCalls: string[] = [];
    const gatewayPaths: string[] = [];

    const tlsServer = https.createServer({ key, cert }, (req, res) => {
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const pathname = new URL(req.url ?? "/", "https://moss-cn-models.inkcomicai.com").pathname;
        gatewayPaths.push(pathname);
        const raw = Buffer.concat(chunks).toString("utf8");
        const body = raw ? (JSON.parse(raw) as Record<string, unknown>) : {};
        res.setHeader("content-type", "application/json");
        res.setHeader("connection", "close");

        if (pathname.endsWith("/v1/apps/status")) {
          res.end(JSON.stringify({ availability: "ready" }));
          return;
        }
        if (pathname.endsWith("/v1/apps/toolkits")) {
          res.end(
            JSON.stringify({
              toolkits: [
                {
                  slug: "github",
                  name: "GitHub",
                  description: "GitHub issues and repos",
                  logoUrl: null,
                  categories: ["Developer Tools"],
                  toolsCount: 2,
                  signIn: "managed",
                },
              ],
              nextCursor: null,
              totalItems: 1,
            }),
          );
          return;
        }
        if (pathname.endsWith("/v1/apps/connections")) {
          res.end(
            JSON.stringify({
              connections: connected
                ? [
                    {
                      connectionId: "ca_github_e2e",
                      toolkitSlug: "github",
                      status: "active",
                      createdAt: "2026-11-26T00:00:00.000Z",
                    },
                  ]
                : [],
            }),
          );
          return;
        }
        if (pathname.endsWith("/v1/apps/connect")) {
          res.end(
            JSON.stringify({
              connection: {
                connectionId: "ca_github_e2e",
                toolkitSlug: "github",
                status: "pending",
                createdAt: "2026-11-26T00:00:00.000Z",
              },
              signInUrl: "https://connect.composio.dev/link/e2e",
              callbackState: "e2e-state",
            }),
          );
          return;
        }
        if (pathname.endsWith("/v1/apps/complete")) {
          connected = true;
          res.end(JSON.stringify({ ok: true }));
          return;
        }
        if (pathname.endsWith("/v1/apps/mcp")) {
          if (body.method === "tools/list") {
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? 1,
                result: {
                  tools: [{ name: "GITHUB_GET_USER", description: "Read profile" }],
                },
              }),
            );
            return;
          }
          if (body.method === "tools/call") {
            const params = (body.params ?? {}) as { name?: string };
            executedCalls.push(String(params.name ?? ""));
            res.end(
              JSON.stringify({
                jsonrpc: "2.0",
                id: body.id ?? 2,
                result: {
                  content: [{ type: "text", text: JSON.stringify({ login: "moss-e2e-user" }) }],
                },
              }),
            );
            return;
          }
        }
        res.statusCode = 404;
        res.end(JSON.stringify({ error: { code: "not_found" } }));
      });
    });

    await new Promise<void>((resolve) => tlsServer.listen(0, "127.0.0.1", () => resolve()));
    const tlsAddr = tlsServer.address();
    if (!tlsAddr || typeof tlsAddr === "string") throw new Error("Expected TLS port");

    const connectTargets: string[] = [];
    const openSockets = new Set<import("node:stream").Duplex>();
    const proxyServer = http.createServer((_req, res) => res.writeHead(405).end());
    proxyServer.on("connect", (req, clientSocket, head) => {
      connectTargets.push(req.url ?? "");
      openSockets.add(clientSocket);
      const upstream = net.connect(tlsAddr.port, "127.0.0.1", () => {
        openSockets.add(upstream);
        clientSocket.write("HTTP/1.1 200 Connection Established\r\n\r\n");
        if (head.length > 0) upstream.write(head);
        upstream.pipe(clientSocket);
        clientSocket.pipe(upstream);
      });
      const cleanup = () => {
        openSockets.delete(clientSocket);
        openSockets.delete(upstream);
      };
      upstream.on("close", cleanup);
      clientSocket.on("close", cleanup);
      upstream.on("error", () => clientSocket.destroy());
      clientSocket.on("error", () => upstream.destroy());
    });
    await new Promise<void>((resolve) => proxyServer.listen(0, "127.0.0.1", () => resolve()));
    const proxyAddr = proxyServer.address();
    if (!proxyAddr || typeof proxyAddr === "string") throw new Error("Expected proxy port");

    const repoRoot = join(import.meta.dirname, "../../../..");
    const scriptPath = join(dir, "run-e2e.ts");
    writeFileSync(
      scriptPath,
      [
        `import { MossAppsGatewayClient, appsAuthorityKey } from ${JSON.stringify(join(repoRoot, "apps/server/src/mossApps/gatewayClient.ts"))};`,
        `import { MossAppsRuntime } from ${JSON.stringify(join(repoRoot, "apps/server/src/mossApps/runtime.ts"))};`,
        `const makeRuntime = (realm, baseUrl) => {`,
        `  const cred = { realm, accessToken: "e2e-token", gatewayBaseUrl: baseUrl, account: { id: "u1", realm } };`,
        `  const client = new MossAppsGatewayClient(async () => cred);`,
        `  const published = [];`,
        `  const runtime = new MossAppsRuntime({ client, callbackUrl: () => "http://127.0.0.1:53851/oauth/moss-apps/callback", publish: (entry) => published.push(entry), logWarning: () => {} });`,
        `  return { cred, runtime, published };`,
        `};`,
        `const runLane = async (realm, baseUrl) => {`,
        `  const { cred, runtime, published } = makeRuntime(realm, baseUrl);`,
        `  let step = "status";`,
        `  try {`,
        `    const status = await runtime.status({ fresh: true, signal: new AbortController().signal });`,
        `    step = "toolkits";`,
        `    const toolkits = await runtime.listToolkits({});`,
        `    step = "connect";`,
        `    const conn = await runtime.connect("github");`,
        `    step = "complete";`,
        `    const completed = await runtime.completeAuthorization({ state: "e2e-state" });`,
        `    const auth = { authorityKey: appsAuthorityKey(cred), isAuthorized: () => true };`,
        `    step = "tools/list";`,
        `    const listed = await runtime.forward({ ...auth, method: "POST", body: { jsonrpc: "2.0", id: 1, method: "tools/list" }, signal: new AbortController().signal });`,
        `    step = "tools/call";`,
        `    const called = await runtime.forward({ ...auth, method: "POST", body: { jsonrpc: "2.0", id: 2, method: "tools/call", params: { name: "GITHUB_GET_USER", arguments: {} } }, signal: new AbortController().signal });`,
        `    return { status, toolkitsCount: toolkits.toolkits.length, connectUrl: conn.signInUrl, completed, publishedCount: published.length, listed, called };`,
        `  } catch (err) {`,
        `    console.error("FAIL STEP:", realm, step, err);`,
        `    try { await new MossAppsGatewayClient(async () => cred).status(cred, new AbortController().signal); } catch (rawErr) { console.error("RAW ERR:", rawErr); }`,
        `    throw err;`,
        `  }`,
        `};`,
        `const cn = await runLane("memfire-phone", "https://moss-cn-models.inkcomicai.com/functions/v1/moss-model-gateway/v1");`,
        `const global = await runLane("supabase-google", "https://api.mossbotai.com/functions/v1/moss-model-gateway/v1");`,
        `console.log(JSON.stringify({ cn, global }));`,
        `process.exit(0);`,
      ].join("\n"),
    );

    try {
      const bundledPath = join(dir, "run-e2e.mjs");
      await buildBundle({
        entry: { "run-e2e": scriptPath },
        cwd: repoRoot,
        outDir: dir,
        format: "esm",
        platform: "node",
        target: "node22",
        dts: false,
        clean: false,
        config: false,
        logLevel: "silent",
      });
      const output = await new Promise<string>((resolve, reject) => {
        const child = spawn(process.execPath, [bundledPath], {
          cwd: repoRoot,
          env: {
            ...process.env,
            NODE_PATH: [
              join(repoRoot, "packages/shared/node_modules"),
              join(repoRoot, "apps/server/node_modules"),
              join(repoRoot, "node_modules"),
            ].join(delimiter),
            HTTPS_PROXY: `http://127.0.0.1:${proxyAddr.port}`,
            HTTP_PROXY: `http://127.0.0.1:${proxyAddr.port}`,
            NO_PROXY: "",
            NODE_EXTRA_CA_CERTS: certPath,
          },
          stdio: ["ignore", "pipe", "pipe"],
        });
        let stdout = "";
        let stderr = "";
        child.stdout.on("data", (d) => (stdout += String(d)));
        child.stderr.on("data", (d) => (stderr += String(d)));
        child.on("exit", (code) => {
          if (code === 0) resolve(stdout.trim());
          else reject(new Error(`E2E child exited ${code}: ${stderr}\n${stdout}`));
        });
      });

      const parsed = JSON.parse(output) as {
        cn: {
          status: { availability: string };
          toolkitsCount: number;
          connectUrl: string;
          completed: boolean;
          publishedCount: number;
          listed: {
            status: number;
            body: { value: { result: { tools: Array<{ name: string }> } } };
          };
          called: {
            status: number;
            body: { value: { result: { content: Array<{ text: string }> } } };
          };
        };
        global: {
          status: { availability: string };
          toolkitsCount: number;
          listed: { status: number };
          called: { status: number };
        };
      };

      expect(parsed.cn.status.availability).toBe("ready");
      expect(parsed.cn.toolkitsCount).toBe(1);
      expect(parsed.cn.connectUrl).toBe("https://connect.composio.dev/link/e2e");
      expect(parsed.cn.completed).toBe(true);
      expect(parsed.cn.publishedCount).toBeGreaterThan(0);
      expect(parsed.cn.listed.body.value.result.tools.map((t) => t.name)).toEqual([
        "GITHUB_GET_USER",
      ]);
      expect(parsed.cn.called.body.value.result.content[0]?.text).toContain("moss-e2e-user");

      expect(parsed.global.status.availability).toBe("ready");
      expect(parsed.global.toolkitsCount).toBe(1);
      expect(parsed.global.listed.status).toBe(200);
      expect(parsed.global.called.status).toBe(200);

      expect(executedCalls).toEqual(["GITHUB_GET_USER", "GITHUB_GET_USER"]);
      expect(connectTargets).toContain("moss-cn-models.inkcomicai.com:443");
      expect(connectTargets).toContain("api.mossbotai.com:443");
    } finally {
      for (const socket of openSockets) socket.destroy();
      proxyServer.closeAllConnections();
      tlsServer.closeAllConnections();
      proxyServer.close();
      tlsServer.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
