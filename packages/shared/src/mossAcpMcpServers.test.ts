import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deriveMossAcpMcpServers } from "./mossAcpMcpServers";
import { MOSS_RELATIVE_PATHS } from "./mossSourceLayout";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(OS.tmpdir(), "moss-acp-mcp-"));
  tempDirs.push(dir);
  return dir;
}

async function writeMcpConfig(projectPath: string, config: unknown): Promise<void> {
  const configPath = join(projectPath, MOSS_RELATIVE_PATHS.mcpConfig);
  await mkdir(join(projectPath, ".moss", "mcp"), { recursive: true });
  await writeFile(configPath, `${JSON.stringify(config, null, 2)}\n`, "utf8");
}

async function writeRawMcpConfig(projectPath: string, raw: string): Promise<void> {
  await mkdir(join(projectPath, ".moss", "mcp"), { recursive: true });
  await writeFile(join(projectPath, MOSS_RELATIVE_PATHS.mcpConfig), raw, "utf8");
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("deriveMossAcpMcpServers (SY8)", () => {
  it("projects a stdio server (command/args/env) into an ACP stdio McpServer", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: {
        "moss-probe": {
          command: "moss-probe-bin",
          args: ["--stdio", "--verbose"],
          env: { MOSS_MCP: "1", TOKEN: "abc" },
        },
      },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.serverNames).toEqual(["moss-probe"]);
    expect(derived.warnings).toEqual([]);
    expect(derived.servers).toEqual([
      {
        name: "moss-probe",
        command: "moss-probe-bin",
        args: ["--stdio", "--verbose"],
        env: [
          { name: "MOSS_MCP", value: "1" },
          { name: "TOKEN", value: "abc" },
        ],
      },
    ]);
  });

  it("defaults stdio args/env to empty arrays when omitted", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: { bare: { command: "bare-bin" } },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.servers).toEqual([{ name: "bare", command: "bare-bin", args: [], env: [] }]);
  });

  it("projects a url server into an http McpServer by default", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: {
        remote: {
          url: "https://mcp.example.com",
          headers: { Authorization: "Bearer xyz" },
        },
      },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.serverNames).toEqual(["remote"]);
    expect(derived.servers).toEqual([
      {
        type: "http",
        name: "remote",
        url: "https://mcp.example.com",
        headers: [{ name: "Authorization", value: "Bearer xyz" }],
      },
    ]);
  });

  it("projects a url server with type sse into an sse McpServer", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: { streamed: { type: "sse", url: "https://sse.example.com" } },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.servers).toEqual([
      { type: "sse", name: "streamed", url: "https://sse.example.com", headers: [] },
    ]);
  });

  it("reads the legacy `servers` key (same source as codex overrides + bridges)", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      servers: { legacy: { command: "legacy-bin" } },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.serverNames).toEqual(["legacy"]);
    expect(derived.servers).toEqual([{ name: "legacy", command: "legacy-bin", args: [], env: [] }]);
  });

  it("warns (no throw) on a server with neither command nor url", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: { broken: { note: "no command or url" } },
    });

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.servers).toEqual([]);
    expect(derived.serverNames).toEqual([]);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain("broken");
  });

  // A3 reverse: degrade, not block. Missing/malformed config -> [] and no throw.
  it("returns [] for a missing project path", async () => {
    const derived = await deriveMossAcpMcpServers(undefined);
    expect(derived).toEqual({ servers: [], serverNames: [], warnings: [] });
  });

  it("returns [] for a whitespace-only project path", async () => {
    const derived = await deriveMossAcpMcpServers("   ");
    expect(derived).toEqual({ servers: [], serverNames: [], warnings: [] });
  });

  it("returns [] with no warning when the config file is absent (ENOENT)", async () => {
    const projectPath = await makeTempWorkspace();
    const derived = await deriveMossAcpMcpServers(projectPath);
    expect(derived).toEqual({ servers: [], serverNames: [], warnings: [] });
  });

  it("returns [] with a warning (no throw) on malformed JSON", async () => {
    const projectPath = await makeTempWorkspace();
    await writeRawMcpConfig(projectPath, "{ not valid json");

    const derived = await deriveMossAcpMcpServers(projectPath);

    expect(derived.servers).toEqual([]);
    expect(derived.serverNames).toEqual([]);
    expect(derived.warnings).toHaveLength(1);
    expect(derived.warnings[0]).toContain("Failed to parse");
  });

  it("returns [] when the servers table is not an object", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { mcpServers: [] });

    const derived = await deriveMossAcpMcpServers(projectPath);
    expect(derived).toEqual({ servers: [], serverNames: [], warnings: [] });
  });
});
