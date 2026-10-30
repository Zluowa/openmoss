import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { discoverMcpCatalog, normalizeMcpServerMap, parseCodexMcpServers } from "./mcpCatalog.ts";

describe("parseCodexMcpServers", () => {
  it("parses command / args / url / env / enabled from [mcp_servers.*] sections", () => {
    const toml = [
      'model = "gpt-5.5"',
      "",
      "[mcp_servers.filesystem]",
      'command = "npx"',
      'args = ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"]',
      'env = { API_KEY = "secret", REGION = "us" }',
      "",
      "[mcp_servers.remote]",
      'url = "https://mcp.example.com/sse"',
      "enabled = false",
    ].join("\n");

    const servers = parseCodexMcpServers(toml);

    expect(servers.get("filesystem")).toMatchObject({
      command: "npx",
      args: ["-y", "@modelcontextprotocol/server-filesystem", "/tmp"],
      envKeys: ["API_KEY", "REGION"],
      enabled: true,
    });
    expect(servers.get("remote")).toMatchObject({
      url: "https://mcp.example.com/sse",
      enabled: false,
    });
  });

  it("ignores comments and unrelated sections", () => {
    const toml = [
      "[mcp_servers.a]",
      'command = "run" # inline comment',
      "# a comment line",
      "[other_section]",
      'command = "nope"',
    ].join("\n");
    const servers = parseCodexMcpServers(toml);
    expect(servers.get("a")?.command).toBe("run");
    expect(servers.has("other_section")).toBe(false);
    expect(servers.size).toBe(1);
  });
});

describe("normalizeMcpServerMap", () => {
  it("reads both mcpServers and legacy servers keys and redacts env values", () => {
    const parsed = {
      mcpServers: {
        fs: { command: "npx", args: ["-y", "srv"], env: { TOKEN: "abc" } },
        off: { command: "x", enabled: false },
      },
    };
    const map = normalizeMcpServerMap(parsed);
    expect(map.get("fs")).toMatchObject({
      command: "npx",
      args: ["-y", "srv"],
      envKeys: ["TOKEN"],
      enabled: true,
    });
    expect(map.get("off")?.enabled).toBe(false);
    // Env values never travel — only key names are retained.
    expect(map.get("fs")).not.toHaveProperty("env");
  });

  it("returns empty for non-object input", () => {
    expect(normalizeMcpServerMap(null).size).toBe(0);
    expect(normalizeMcpServerMap({ nope: 1 }).size).toBe(0);
  });
});

describe("discoverMcpCatalog", () => {
  let home: string;
  let workspace: string;

  beforeEach(async () => {
    home = await mkdtemp(join(tmpdir(), "t3-mcp-home-"));
    workspace = await mkdtemp(join(tmpdir(), "t3-mcp-ws-"));
  });

  afterEach(async () => {
    await rm(home, { recursive: true, force: true });
    await rm(workspace, { recursive: true, force: true });
    delete process.env.CODEX_HOME;
  });

  it("aggregates across Moss + Codex + Claude with the Moss origin winning name-dedup", async () => {
    // Moss canonical
    await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "mcp", "config.json"),
      JSON.stringify({
        mcpServers: { shared: { command: "moss-cmd" }, mossonly: { command: "m" } },
      }),
    );
    // Codex native (same "shared" name should lose to Moss)
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        "[mcp_servers.shared]",
        'command = "codex-cmd"',
        "[mcp_servers.codexonly]",
        'command = "c"',
      ].join("\n"),
    );
    process.env.CODEX_HOME = codexHome;
    // Claude project
    await writeFile(
      join(workspace, ".mcp.json"),
      JSON.stringify({ mcpServers: { claudeonly: { url: "https://c.example" } } }),
    );

    const servers = await discoverMcpCatalog({
      cwd: workspace,
      homeDir: home,
      mossBaseDir: join(home, ".moss"),
    });
    const byName = new Map(servers.map((s) => [s.name, s]));

    expect(byName.get("shared")?.origin).toBe("moss");
    expect(byName.get("shared")?.command).toBe("moss-cmd");
    expect(byName.get("mossonly")?.origin).toBe("moss");
    expect(byName.get("codexonly")?.origin).toBe("codex");
    expect(byName.get("claudeonly")).toMatchObject({ origin: "claude", transport: "http" });
  });

  it("returns an empty list when nothing is configured", async () => {
    const servers = await discoverMcpCatalog({
      cwd: workspace,
      homeDir: home,
      mossBaseDir: join(home, ".moss"),
    });
    expect(servers).toEqual([]);
  });

  it("filters internal and external control-plane records before name dedupe", async () => {
    const codexHome = join(home, ".codex");
    await mkdir(codexHome, { recursive: true });
    await writeFile(
      join(codexHome, "config.toml"),
      [
        "[mcp_servers.moss]",
        'url = "http://127.0.0.1:3773/mcp"',
        "[mcp_servers.external-control]",
        'url = "http://localhost:3773/mcp/external"',
        "[mcp_servers.ordinary]",
        'url = "https://mcp.example.com/api"',
      ].join("\n"),
    );
    process.env.CODEX_HOME = codexHome;
    await writeFile(
      join(workspace, ".mcp.json"),
      JSON.stringify({
        mcpServers: {
          proxy: { command: process.execPath, args: ["/state/agent-gateway-mcp-proxy.mjs"] },
          bridge: {
            command: process.execPath,
            args: ["/app/server.mjs", "mcp", "serve", "--integration", "integration-1"],
          },
        },
      }),
    );

    const servers = await discoverMcpCatalog({
      cwd: workspace,
      homeDir: home,
      mossBaseDir: join(home, ".moss"),
    });
    expect(servers.map((server) => server.name)).toEqual(["ordinary"]);
  });

  it("fails closed when canonical Moss config declares a reserved control-plane identity", async () => {
    await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "mcp", "config.json"),
      JSON.stringify({ mcpServers: { moss: { command: "user-server" } } }),
    );

    await expect(
      discoverMcpCatalog({
        cwd: workspace,
        homeDir: home,
        mossBaseDir: join(home, ".moss"),
      }),
    ).rejects.toThrow(/reserved internal server name/i);
  });

  it("fails closed when canonical config retains the stdio bootstrap credential env", async () => {
    await mkdir(join(workspace, ".moss", "mcp"), { recursive: true });
    await writeFile(
      join(workspace, ".moss", "mcp", "config.json"),
      JSON.stringify({
        mcpServers: {
          "gateway-copy": {
            command: "agent-gateway-mcp-proxy",
            env: { MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN: "$BOOTSTRAP" },
          },
        },
      }),
    );

    await expect(
      discoverMcpCatalog({
        cwd: workspace,
        homeDir: home,
        mossBaseDir: join(home, ".moss"),
      }),
    ).rejects.toThrow(/internal Agent Gateway credential environment/i);
  });
});
