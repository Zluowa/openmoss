/**
 * Live MCP injection derivation (slice SY4 — ported from 1code
 * `agent-runtime/codex-app-server-mcp-overrides.ts`, semantics per 1code S1.6).
 *
 * The canonical Moss MCP source is `<projectPath>/.moss/mcp/config.json`
 * (layout constant `MOSS_RELATIVE_PATHS.mcpConfig`). The SY2 materializer
 * mirrors that config into two WRITE-ONLY human-readable bridges:
 *   - codex: `.codex/config.toml` `[mcp_servers.*]` (`buildCodexTomlBridge`)
 *   - claudeAgent: `.mcp.json` passthrough.
 *
 * But the running engines do NOT read those project bridges:
 *   - The Codex app-server only reads `<codexHome>/config.toml` (1code S5.1 A4).
 *     Moss deliberately does NOT redirect `CODEX_HOME` at the project `.codex`
 *     (that would orphan auth.json / sessions / `<codexHome>/sqlite/codex.db`,
 *     all anchored to codexHome), so the project TOML bridge is invisible to it.
 *   - The Claude Agent SDK loads `<cwd>/.mcp.json` (SettingSource `project`) but
 *     leaves its servers pending approval unless a settings key enables them.
 *
 * SY4 closes both gaps FROM THE SAME CANONICAL SOURCE so the write-only bridges
 * and the live-injected config never diverge (acceptance A5):
 *   - `deriveCodexMcpServerOverrides` -> `-c mcp_servers.<name>...` app-server
 *     launch args (recognized downstream, no CODEX_HOME redirect).
 *   - `deriveMossMcpServerNames` -> the server-name list the ClaudeAdapter feeds
 *     to the SDK `settings.enabledMcpjsonServers` so exactly the Moss-declared
 *     servers in the projected `.mcp.json` are auto-approved (least privilege).
 *
 * Every reader here is PURE with respect to side effects (read-only) and NEVER
 * throws: a missing project path, missing file, or malformed JSON degrades to an
 * empty result (acceptance A6 — degrade, not block) with an optional warning.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MOSS_RELATIVE_PATHS } from "./mossSourceLayout";

export interface DerivedCodexMcpOverrides {
  /** `-c mcp_servers.<name>...` argument pairs, ready to spread into app-server argv. */
  readonly args: string[];
  /** Server names that produced at least one override (for logging/evidence). */
  readonly serverNames: string[];
  /** Non-fatal problems encountered while deriving overrides. */
  readonly warnings: string[];
}

function emptyOverrides(): DerivedCodexMcpOverrides {
  return { args: [], serverNames: [], warnings: [] };
}

/**
 * TOML basic-string literal. Uses `JSON.stringify` to match the materializer's
 * `quoteTomlString` (byte-parity with the `.codex/config.toml` bridge).
 */
function tomlString(value: string): string {
  return JSON.stringify(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function isStringArray(value: unknown): value is string[] {
  return Array.isArray(value) && value.every((item) => typeof item === "string");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/**
 * Read `<projectPath>/.moss/mcp/config.json` and return the server table under
 * the canonical `mcpServers` (or legacy `servers`) key. Mirrors the same read
 * `mossProjectionMaterializer.readMcpServers` / `buildCodexTomlBridge` perform,
 * so the live injection and the write-only bridges share one source of truth.
 *
 * Returns `null` on a missing project path or a missing file (ENOENT) so the
 * caller can distinguish "no config" (silent) from a parse failure (warned).
 */
async function readMossMcpServerTable(
  projectPath: string | null | undefined,
): Promise<
  | { readonly kind: "servers"; readonly servers: Record<string, unknown> }
  | { readonly kind: "empty" }
  | { readonly kind: "error"; readonly warning: string }
> {
  const trimmedProjectPath = projectPath?.trim();
  if (!trimmedProjectPath) return { kind: "empty" };

  const configPath = path.join(trimmedProjectPath, MOSS_RELATIVE_PATHS.mcpConfig);

  let raw: string;
  try {
    raw = await readFile(configPath, "utf-8");
  } catch (error) {
    const code = (error as NodeJS.ErrnoException | null)?.code;
    if (code === "ENOENT") return { kind: "empty" };
    return {
      kind: "error",
      warning: `Failed to read Moss MCP config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    return {
      kind: "error",
      warning: `Failed to parse Moss MCP config at ${configPath}: ${
        error instanceof Error ? error.message : String(error)
      }`,
    };
  }

  if (!isRecord(parsed)) return { kind: "empty" };
  const serversSource = parsed.mcpServers ?? parsed.servers;
  if (!isRecord(serversSource)) return { kind: "empty" };

  return { kind: "servers", servers: serversSource };
}

/**
 * Serialize a single MCP server definition into `-c mcp_servers.<name>.<key>=<toml>`
 * override pairs, mirroring the shape emitted by `buildCodexTomlBridge`
 * (`command` / `url` / `args` / `env`) so the `-c` path and the human-readable
 * bridge stay semantically identical. Returns `true` when at least one override
 * was emitted for the server.
 */
function appendServerOverrides(
  args: string[],
  serverName: string,
  config: Record<string, unknown>,
): boolean {
  const prefix = `mcp_servers.${serverName}`;
  let emitted = false;

  if (isNonEmptyString(config.command)) {
    args.push("-c", `${prefix}.command=${tomlString(config.command)}`);
    emitted = true;
  }
  if (isNonEmptyString(config.url)) {
    args.push("-c", `${prefix}.url=${tomlString(config.url)}`);
    emitted = true;
  }
  if (isStringArray(config.args)) {
    const rendered = config.args.map((item) => tomlString(item)).join(", ");
    args.push("-c", `${prefix}.args=[${rendered}]`);
    emitted = true;
  }
  if (isRecord(config.env)) {
    const entries: string[] = [];
    for (const [envKey, envValue] of Object.entries(config.env)) {
      if (typeof envValue === "string") {
        entries.push(`${envKey} = ${tomlString(envValue)}`);
      }
    }
    if (entries.length > 0) {
      args.push("-c", `${prefix}.env={${entries.join(", ")}}`);
      emitted = true;
    }
  }

  return emitted;
}

/**
 * Read `<projectPath>/.moss/mcp/config.json` and derive `-c mcp_servers.*`
 * config overrides for the Codex app-server (1code S1.6). Never throws: a
 * missing project path, missing file, or malformed JSON degrades to an empty
 * result so an unconfigured project sees zero behavioral change (A6).
 */
export async function deriveCodexMcpServerOverrides(
  projectPath: string | null | undefined,
): Promise<DerivedCodexMcpOverrides> {
  const table = await readMossMcpServerTable(projectPath);
  if (table.kind === "empty") return emptyOverrides();
  if (table.kind === "error") return { ...emptyOverrides(), warnings: [table.warning] };

  const args: string[] = [];
  const serverNames: string[] = [];
  const warnings: string[] = [];

  for (const [serverName, serverConfig] of Object.entries(table.servers)) {
    if (!isNonEmptyString(serverName)) continue;
    const config = isRecord(serverConfig) ? serverConfig : {};
    if (appendServerOverrides(args, serverName, config)) {
      serverNames.push(serverName);
    } else {
      warnings.push(`Moss MCP server "${serverName}" produced no override (missing command/url).`);
    }
  }

  return { args, serverNames, warnings };
}

export interface DerivedMossMcpServerNames {
  /** Declared Moss MCP server names (for `.mcp.json` approval). */
  readonly serverNames: string[];
  /** Non-fatal problems encountered while reading the source. */
  readonly warnings: string[];
}

/**
 * Read `<projectPath>/.moss/mcp/config.json` and return the declared server
 * names (same canonical source as `deriveCodexMcpServerOverrides` and the SY2
 * `.mcp.json` bridge). The ClaudeAdapter feeds these to the SDK
 * `settings.enabledMcpjsonServers` so exactly the Moss-declared servers in the
 * projected `.mcp.json` are auto-approved — no broader `enableAllProjectMcpServers`
 * grant, and the live approval set can never diverge from the bridged file.
 * Never throws (A6).
 */
export async function deriveMossMcpServerNames(
  projectPath: string | null | undefined,
): Promise<DerivedMossMcpServerNames> {
  const table = await readMossMcpServerTable(projectPath);
  if (table.kind === "empty") return { serverNames: [], warnings: [] };
  if (table.kind === "error") return { serverNames: [], warnings: [table.warning] };

  const serverNames = Object.keys(table.servers).filter((name) => isNonEmptyString(name));
  return { serverNames, warnings: [] };
}
