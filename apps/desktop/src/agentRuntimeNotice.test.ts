import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";

import { afterEach, describe, expect, it } from "vitest";

import { DESKTOP_AGENT_RUNTIMES_ROUTE_PATH } from "@moss/shared/codexRuntime";

import { notifyBackendAgentRuntimeReady } from "./agentRuntimeNotice";

const servers: Server[] = [];
afterEach(async () => {
  for (const server of servers.splice(0)) await new Promise((resolve) => server.close(resolve));
});

describe("agent runtime notice", () => {
  it("posts the ready runtime with the desktop credential, retrying while the server starts", async () => {
    const received: Array<{ path: string; authorization: string; body: string }> = [];
    let answers = [503, 202];
    const server = createServer((request, response) => {
      let body = "";
      request.on("data", (chunk) => (body += chunk));
      request.on("end", () => {
        received.push({
          path: request.url ?? "",
          authorization: request.headers.authorization ?? "",
          body,
        });
        response.writeHead(answers.shift() ?? 202).end();
      });
    });
    servers.push(server);
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const delivered = await notifyBackendAgentRuntimeReady({
      backendHttpUrl: () => `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      shutdownToken: "t".repeat(64),
      ready: [{ name: "codex", executablePath: "C:/Moss/runtimes/codex.exe" }],
      sleep: async () => undefined,
    });
    expect(delivered).toBe(true);
    expect(received).toHaveLength(2);
    expect(received[1]).toEqual({
      path: DESKTOP_AGENT_RUNTIMES_ROUTE_PATH,
      authorization: `Bearer ${"t".repeat(64)}`,
      body: JSON.stringify({
        ready: [{ name: "codex", executablePath: "C:/Moss/runtimes/codex.exe" }],
      }),
    });
  });

  it("never sends the credential anywhere but the loopback backend", async () => {
    const errors: string[] = [];
    const delivered = await notifyBackendAgentRuntimeReady({
      backendHttpUrl: () => "http://example.com:3773",
      shutdownToken: "t".repeat(64),
      ready: [{ name: "codex", executablePath: "C:/Moss/runtimes/codex.exe" }],
      sleep: async () => undefined,
      onError: (message) => errors.push(message),
    });
    expect(delivered).toBe(false);
    expect(errors.every((message) => message.includes("loopback"))).toBe(true);
  });
});
