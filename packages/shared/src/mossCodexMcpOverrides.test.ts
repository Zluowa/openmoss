import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import OS from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { deriveCodexMcpServerOverrides, deriveMossMcpServerNames } from "./mossCodexMcpOverrides";
import { MOSS_RELATIVE_PATHS } from "./mossSourceLayout";

const tempDirs: string[] = [];

async function makeTempWorkspace(): Promise<string> {
  const dir = await mkdtemp(join(OS.tmpdir(), "moss-mcp-override-"));
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

describe("deriveCodexMcpServerOverrides (SY4)", () => {
  it("derives -c mcp_servers.* overrides for a stdio server", async () => {
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

    const overrides = await deriveCodexMcpServerOverrides(projectPath);

    expect(overrides.serverNames).toEqual(["moss-probe"]);
    expect(overrides.warnings).toEqual([]);
    expect(overrides.args).toEqual([
      "-c",
      'mcp_servers.moss-probe.command="moss-probe-bin"',
      "-c",
      'mcp_servers.moss-probe.args=["--stdio", "--verbose"]',
      "-c",
      'mcp_servers.moss-probe.env={MOSS_MCP = "1", TOKEN = "abc"}',
    ]);
    // Reverse-proof anchor: the derived args carry the `mcp_servers.` token the
    // downstream detector recognizes; a broken derivation would drop it.
    expect(overrides.args.some((arg) => arg.includes("mcp_servers."))).toBe(true);
  });

  it("derives a url override for an http server", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: { remote: { url: "http://127.0.0.1:8931/mcp" } },
    });

    const overrides = await deriveCodexMcpServerOverrides(projectPath);

    expect(overrides.serverNames).toEqual(["remote"]);
    expect(overrides.args).toEqual(["-c", 'mcp_servers.remote.url="http://127.0.0.1:8931/mcp"']);
  });

  it("accepts the `servers` alias key like buildCodexTomlBridge", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { servers: { alias: { command: "alias-bin" } } });

    const overrides = await deriveCodexMcpServerOverrides(projectPath);
    expect(overrides.serverNames).toEqual(["alias"]);
    expect(overrides.args).toContain('mcp_servers.alias.command="alias-bin"');
  });

  it("quotes values with JSON.stringify to match the TOML bridge", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: { quoted: { command: 'a "b" c', args: ["x\\y"] } },
    });

    const overrides = await deriveCodexMcpServerOverrides(projectPath);
    expect(overrides.args).toEqual([
      "-c",
      'mcp_servers.quoted.command="a \\"b\\" c"',
      "-c",
      'mcp_servers.quoted.args=["x\\\\y"]',
    ]);
  });

  it("returns nothing for a missing project path", async () => {
    expect(await deriveCodexMcpServerOverrides(undefined)).toEqual({
      args: [],
      serverNames: [],
      warnings: [],
    });
    expect(await deriveCodexMcpServerOverrides("")).toEqual({
      args: [],
      serverNames: [],
      warnings: [],
    });
  });

  it("returns nothing (no warning) when the config file is absent", async () => {
    const projectPath = await makeTempWorkspace();
    expect(await deriveCodexMcpServerOverrides(projectPath)).toEqual({
      args: [],
      serverNames: [],
      warnings: [],
    });
  });

  it("returns nothing when mcpServers is empty (A6 empty override)", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { mcpServers: {} });
    expect(await deriveCodexMcpServerOverrides(projectPath)).toEqual({
      args: [],
      serverNames: [],
      warnings: [],
    });
  });

  it("warns but does not throw on malformed JSON (A6 degrade)", async () => {
    const projectPath = await makeTempWorkspace();
    await writeRawMcpConfig(projectPath, "{ not json");

    const overrides = await deriveCodexMcpServerOverrides(projectPath);
    expect(overrides.args).toEqual([]);
    expect(overrides.serverNames).toEqual([]);
    expect(overrides.warnings.length).toBe(1);
    expect(overrides.warnings[0]).toContain("Failed to parse");
  });

  it("warns for a server with neither command nor url", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { mcpServers: { empty: { note: "no transport" } } });

    const overrides = await deriveCodexMcpServerOverrides(projectPath);
    expect(overrides.args).toEqual([]);
    expect(overrides.serverNames).toEqual([]);
    expect(overrides.warnings.length).toBe(1);
    expect(overrides.warnings[0]).toContain("empty");
  });

  it("falsification probe: removing command yields no override", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { mcpServers: { probe: {} } });
    expect((await deriveCodexMcpServerOverrides(projectPath)).args).toEqual([]);

    await writeMcpConfig(projectPath, { mcpServers: { probe: { command: "x" } } });
    expect((await deriveCodexMcpServerOverrides(projectPath)).args.length).toBeGreaterThan(0);
  });
});

describe("deriveMossMcpServerNames (SY4)", () => {
  it("returns the declared server names from the canonical source", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: {
        "moss-probe": { command: "moss-probe-bin" },
        remote: { url: "http://127.0.0.1:8931/mcp" },
      },
    });

    const derived = await deriveMossMcpServerNames(projectPath);
    expect(derived.serverNames).toEqual(["moss-probe", "remote"]);
    expect(derived.warnings).toEqual([]);
  });

  it("accepts the `servers` alias key", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, { servers: { alias: { command: "alias-bin" } } });
    expect((await deriveMossMcpServerNames(projectPath)).serverNames).toEqual(["alias"]);
  });

  it("returns nothing (no warning) for missing path / file / empty table (A6)", async () => {
    expect(await deriveMossMcpServerNames(undefined)).toEqual({ serverNames: [], warnings: [] });
    const projectPath = await makeTempWorkspace();
    expect(await deriveMossMcpServerNames(projectPath)).toEqual({ serverNames: [], warnings: [] });
    await writeMcpConfig(projectPath, { mcpServers: {} });
    expect(await deriveMossMcpServerNames(projectPath)).toEqual({ serverNames: [], warnings: [] });
  });

  it("warns but does not throw on malformed JSON (A6 degrade)", async () => {
    const projectPath = await makeTempWorkspace();
    await writeRawMcpConfig(projectPath, "{ not json");
    const derived = await deriveMossMcpServerNames(projectPath);
    expect(derived.serverNames).toEqual([]);
    expect(derived.warnings.length).toBe(1);
    expect(derived.warnings[0]).toContain("Failed to parse");
  });

  it("shares the canonical source with deriveCodexMcpServerOverrides (A5 parity)", async () => {
    const projectPath = await makeTempWorkspace();
    await writeMcpConfig(projectPath, {
      mcpServers: {
        "moss-probe": { command: "moss-probe-bin" },
        remote: { url: "http://127.0.0.1:8931/mcp" },
      },
    });

    const codex = await deriveCodexMcpServerOverrides(projectPath);
    const names = await deriveMossMcpServerNames(projectPath);
    // The codex -c override server set and the claude approval name set are the
    // same set, read from the single .moss/mcp/config.json source.
    expect([...names.serverNames].toSorted()).toEqual([...codex.serverNames].toSorted());
  });
});
