import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { pathToFileURL } from "node:url";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ensureMossPiExtensionFile,
  isMossPiBridgeTitle,
  MOSS_PI_BRIDGE_ENV_KEY,
  MOSS_PI_EXTENSION_SOURCE,
  MOSS_PI_GATEWAY_SYNC_COMMAND,
  MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY,
  MOSS_PI_RELOAD_COMMAND,
  parseMossPiBridgeRequest,
  writeMossPiGatewayToolsFile,
} from "./mossPiExtension.ts";

interface RegisteredTool {
  readonly name: string;
  readonly exposure?: string;
  readonly parameters: unknown;
  readonly execute: (
    toolCallId: string,
    params: unknown,
    signal: AbortSignal | undefined,
    onUpdate: unknown,
    ctx: unknown,
  ) => Promise<{ content: unknown; details: unknown }>;
}

function fakePi() {
  const providers = new Map<string, Record<string, unknown>>();
  const tools = new Map<string, RegisteredTool>();
  const commands = new Map<string, { handler: (args: string, ctx: unknown) => Promise<void> }>();
  return {
    providers,
    tools,
    commands,
    api: {
      registerProvider: (name: string, config: Record<string, unknown>) =>
        providers.set(name, config),
      registerTool: (tool: RegisteredTool) => tools.set(tool.name, tool),
      registerCommand: (
        name: string,
        command: { handler: (args: string, ctx: unknown) => Promise<void> },
      ) => commands.set(name, command),
    },
  };
}

const STATE = Symbol.for("moss.pi.extension.state");
const dirs: string[] = [];
let extensionModule: { default: (pi: unknown) => void };
const ENV_KEYS = [
  "MOSS_PI_CONFIG_CONTENT",
  "MOSS_ACCESS_TOKEN",
  MOSS_PI_BRIDGE_ENV_KEY,
  MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY,
];

beforeEach(async () => {
  delete (globalThis as Record<symbol, unknown>)[STATE];
  const dir = mkdtempSync(path.join(tmpdir(), "moss-pi-extension-"));
  dirs.push(dir);
  const file = await ensureMossPiExtensionFile(dir);
  extensionModule = (await import(pathToFileURL(file).href)) as typeof extensionModule;
});

afterEach(() => {
  delete (globalThis as Record<symbol, unknown>)[STATE];
  for (const key of ENV_KEYS) delete process.env[key];
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("Moss Pi extension", () => {
  it("is written once per content and reused", async () => {
    const dir = dirs[0]!;
    const first = await ensureMossPiExtensionFile(dir);
    const second = await ensureMossPiExtensionFile(dir);
    expect(first).toBe(second);
    expect(readFileSync(first, "utf8")).toBe(MOSS_PI_EXTENSION_SOURCE);
  });

  it("registers the Moss lane from the environment and removes the token from it", () => {
    process.env.MOSS_PI_CONFIG_CONTENT = JSON.stringify({
      realm: "cn",
      provider: { baseUrl: "http://127.0.0.1:1/v1", api: "openai-completions", models: [] },
    });
    process.env.MOSS_ACCESS_TOKEN = "moss_sk_test";
    const pi = fakePi();
    extensionModule.default(pi.api);
    expect(pi.providers.get("moss")).toMatchObject({
      name: "Moss",
      baseUrl: "http://127.0.0.1:1/v1",
      apiKey: "moss_sk_test",
    });
    // Shell commands and MCP servers Pi starts never inherit them.
    expect(process.env.MOSS_ACCESS_TOKEN).toBeUndefined();
    expect(process.env.MOSS_PI_CONFIG_CONTENT).toBeUndefined();
    // A reload re-runs the factory with the environment already cleared.
    const reloaded = fakePi();
    extensionModule.default(reloaded.api);
    expect(reloaded.providers.get("moss")).toMatchObject({ apiKey: "moss_sk_test" });
  });

  it("registers no Moss lane and no gateway tools for a plain Pi session", () => {
    const pi = fakePi();
    extensionModule.default(pi.api);
    expect(pi.providers.size).toBe(0);
    expect(pi.tools.size).toBe(0);
    expect([...pi.commands.keys()]).toEqual([MOSS_PI_RELOAD_COMMAND]);
  });

  it("bridges gateway tool calls through a Moss dialog and syncs a changed catalog", async () => {
    const toolsFile = path.join(dirs[0]!, "tools.json");
    await writeMossPiGatewayToolsFile(toolsFile, [
      { name: "moss_list_threads", description: "List threads", inputSchema: { type: "object" } },
      { name: "moss_old", description: "Old", inputSchema: { type: "object" } },
    ]);
    process.env[MOSS_PI_BRIDGE_ENV_KEY] = "nonce-1";
    process.env[MOSS_PI_GATEWAY_TOOLS_FILE_ENV_KEY] = toolsFile;
    const pi = fakePi();
    extensionModule.default(pi.api);
    expect([...pi.tools.keys()]).toEqual(["moss_list_threads", "moss_old"]);
    expect(process.env[MOSS_PI_BRIDGE_ENV_KEY]).toBeUndefined();

    const input = vi.fn(async (title: string, placeholder: string) => {
      const request = parseMossPiBridgeRequest(title, placeholder, "nonce-1");
      expect(request).toEqual({
        op: "call",
        toolCallId: "call-1",
        name: "moss_list_threads",
        arguments: { limit: 2 },
      });
      return JSON.stringify({ ok: true, content: [{ type: "text", text: "two threads" }] });
    });
    const result = await pi.tools
      .get("moss_list_threads")!
      .execute("call-1", { limit: 2 }, undefined, undefined, { ui: { input } });
    expect(result.content).toEqual([{ type: "text", text: "two threads" }]);
    expect(isMossPiBridgeTitle(input.mock.calls[0]![0])).toBe(true);

    const failing = vi.fn(async () => JSON.stringify({ ok: false, error: "Denied by Moss" }));
    await expect(
      pi.tools.get("moss_list_threads")!.execute("call-2", {}, undefined, undefined, {
        ui: { input: failing },
      }),
    ).rejects.toThrow("Denied by Moss");

    writeFileSync(
      toolsFile,
      JSON.stringify([
        { name: "moss_list_threads", description: "List", inputSchema: { type: "object" } },
        { name: "moss_new", description: "New", inputSchema: { type: "object" } },
      ]),
    );
    await pi.commands.get(MOSS_PI_GATEWAY_SYNC_COMMAND)!.handler("", {});
    expect(pi.tools.get("moss_new")).toBeDefined();
    expect(pi.tools.get("moss_old")?.exposure).toBe("hidden");
  });

  it("reloads Pi without touching the stale command context afterwards", async () => {
    const pi = fakePi();
    extensionModule.default(pi.api);
    const reload = vi.fn(async () => undefined);
    const ctx = new Proxy(
      { reload },
      {
        get(target, key) {
          if (key === "reload") return target.reload;
          throw new Error(`stale ctx.${String(key)}`);
        },
      },
    );
    await pi.commands.get(MOSS_PI_RELOAD_COMMAND)!.handler("", ctx);
    expect(reload).toHaveBeenCalledOnce();
  });
});

describe("parseMossPiBridgeRequest", () => {
  it("accepts only the session's own nonce", () => {
    const payload = JSON.stringify({ op: "call", toolCallId: "c", name: "t", arguments: [] });
    expect(parseMossPiBridgeRequest("moss-bridge:a", payload, "a")).toEqual({
      op: "call",
      toolCallId: "c",
      name: "t",
      arguments: {},
    });
    expect(parseMossPiBridgeRequest("moss-bridge:b", payload, "a")).toBeUndefined();
    expect(parseMossPiBridgeRequest("moss-bridge:a", payload, undefined)).toBeUndefined();
    expect(parseMossPiBridgeRequest("moss-bridge:a", "{not json", "a")).toBeUndefined();
  });
});
