// FILE: mcpCatalog.ts
// Purpose: Unified cross-engine MCP server discovery. Aggregates the canonical
//          Moss `.moss/mcp/config.json` with every engine's native MCP config
//          (Codex `config.toml [mcp_servers.*]`, Claude `.mcp.json` /
//          `~/.claude.json` mcpServers) into a single deduped catalog. The
//          Moss-canonical origin wins name-dedup so the runtime catalog mirrors
//          the projected bridges (SY4 parity), matching how `skillsCatalog.ts`
//          treats the `.moss/skills` origin as the single source of truth.
// Layer: Server provider discovery helper
// Exports: discoverMcpCatalog, parseCodexMcpServers, normalizeMcpServerMap

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type { ProviderKind, ProviderMcpServerDescriptor } from "@synara/contracts";
import { MOSS_RELATIVE_PATHS } from "@synara/shared/mossSourceLayout";

import { ancestorsFromDeepest } from "./skillsCatalog.ts";

// ── Types ────────────────────────────────────────────────────────────

type Transport = ProviderMcpServerDescriptor["transport"];

export interface McpCatalogInput {
  /** Optional workspace cwd; project-level `.moss/mcp` + `.mcp.json` are included. */
  readonly cwd?: string | null;
  readonly homeDir: string;
  /** Moss base dir (usually `~/.moss`); MCP config lives at `{base}/mcp/config.json`. */
  readonly mossBaseDir: string;
  /** Reserved for future per-provider ordering; the catalog is provider-neutral today. */
  readonly provider?: ProviderKind | null;
}

interface RawMcpServer {
  readonly command?: string;
  readonly args?: readonly string[];
  readonly url?: string;
  readonly envKeys?: readonly string[];
  readonly enabled: boolean;
  readonly type?: string;
}

const RESERVED_INTERNAL_MCP_SERVER_NAMES = new Set(["moss"]);
const AGENT_GATEWAY_STDIO_PROXY_FILE_NAME = "agent-gateway-mcp-proxy.mjs";

function isLoopbackHostname(hostname: string): boolean {
  const normalized = hostname.toLowerCase().replace(/^\[|\]$/g, "");
  return normalized === "localhost" || normalized === "127.0.0.1" || normalized === "::1";
}

function controlPlaneIdentity(name: string, raw: RawMcpServer): string | undefined {
  if (RESERVED_INTERNAL_MCP_SERVER_NAMES.has(mcpNameKey(name))) {
    return `reserved internal server name '${name}'`;
  }
  if (
    raw.envKeys?.some(
      (key) => key === "MOSS_AGENT_GATEWAY_TOKEN" || key === "MOSS_AGENT_GATEWAY_BOOTSTRAP_TOKEN",
    )
  ) {
    return "internal Agent Gateway credential environment";
  }
  if (
    raw.args?.some(
      (argument) => nodePath.basename(argument) === AGENT_GATEWAY_STDIO_PROXY_FILE_NAME,
    )
  ) {
    return "internal Agent Gateway stdio proxy";
  }
  const args = raw.args ?? [];
  const mcpServeIndex = args.findIndex(
    (argument, index) => argument === "mcp" && args[index + 1] === "serve",
  );
  if (mcpServeIndex >= 0 && args.includes("--integration", mcpServeIndex + 2)) {
    return "authoritative External MCP stdio bridge";
  }
  if (raw.url) {
    try {
      const url = new URL(raw.url);
      if (url.protocol === "http:" && isLoopbackHostname(url.hostname)) {
        const pathname = url.pathname.replace(/\/+$/, "") || "/";
        if (pathname === "/mcp") return "internal Agent Gateway endpoint";
        if (pathname === "/mcp/external") return "External MCP endpoint";
      }
    } catch {
      // Invalid outbound URLs remain visible for the owning provider to report.
    }
  }
  return undefined;
}

// ── Shared helpers ───────────────────────────────────────────────────

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.trim().length > 0;
}

function inferTransport(server: Pick<RawMcpServer, "command" | "url" | "type">): Transport {
  const explicit = server.type?.trim().toLowerCase();
  if (explicit === "http" || explicit === "sse" || explicit === "stdio") {
    return explicit;
  }
  if (isNonEmptyString(server.url)) return "http";
  if (isNonEmptyString(server.command)) return "stdio";
  return "unknown";
}

function mcpNameKey(name: string): string {
  return name.trim().toLowerCase();
}

async function readFileOrNull(path: string): Promise<string | null> {
  try {
    return await fs.readFile(path, "utf8");
  } catch {
    return null;
  }
}

function toDescriptor(input: {
  readonly name: string;
  readonly origin: string;
  readonly path: string;
  readonly raw: RawMcpServer;
}): ProviderMcpServerDescriptor {
  const { name, origin, path, raw } = input;
  return {
    name,
    transport: inferTransport(raw),
    origin,
    path,
    enabled: raw.enabled,
    ...(isNonEmptyString(raw.command) ? { command: raw.command } : {}),
    ...(raw.args && raw.args.length > 0
      ? { args: raw.args.filter((a): a is string => isNonEmptyString(a)) }
      : {}),
    ...(isNonEmptyString(raw.url) ? { url: raw.url } : {}),
    ...(raw.envKeys && raw.envKeys.length > 0 ? { envKeys: [...raw.envKeys] } : {}),
  };
}

// ── JSON server-map normalization (Moss / Claude / Moss) ───────────
// Shared shape `{ mcpServers | servers: { <name>: { command, args, url, env } } }`.

export function normalizeMcpServerMap(parsed: unknown): Map<string, RawMcpServer> {
  const out = new Map<string, RawMcpServer>();
  if (!isRecord(parsed)) return out;
  const source = parsed.mcpServers ?? parsed.servers;
  if (!isRecord(source)) return out;

  for (const [name, value] of Object.entries(source)) {
    if (!isNonEmptyString(name)) continue;
    const config = isRecord(value) ? value : {};
    const args = Array.isArray(config.args)
      ? config.args.filter((a): a is string => typeof a === "string")
      : undefined;
    const envKeys = isRecord(config.env) ? Object.keys(config.env) : undefined;
    out.set(name, {
      ...(isNonEmptyString(config.command) ? { command: config.command } : {}),
      ...(args ? { args } : {}),
      ...(isNonEmptyString(config.url) ? { url: config.url } : {}),
      ...(envKeys ? { envKeys } : {}),
      ...(isNonEmptyString(config.type) ? { type: config.type } : {}),
      // A server is disabled only when explicitly `enabled: false`.
      enabled: config.enabled !== false,
    });
  }
  return out;
}

async function readJsonServerMap(path: string): Promise<Map<string, RawMcpServer>> {
  const raw = await readFileOrNull(path);
  if (raw === null) return new Map();
  try {
    return normalizeMcpServerMap(JSON.parse(raw));
  } catch {
    return new Map();
  }
}

/** Refuses canonical outbound config that would impersonate either MCP control plane. */
export async function assertNoReservedMossMcpServerIdentity(
  cwd: string | null | undefined,
): Promise<void> {
  const workspace = cwd?.trim();
  if (!workspace) return;
  for (const ancestor of ancestorsFromDeepest(workspace)) {
    const configPath = nodePath.join(ancestor, MOSS_RELATIVE_PATHS.mcpConfig);
    const servers = await readJsonServerMap(configPath);
    for (const [name, raw] of servers) {
      const reservedIdentity = controlPlaneIdentity(name, raw);
      if (reservedIdentity) {
        throw new Error(
          `Moss MCP config at ${configPath} declares ${reservedIdentity}; control-plane MCP identities are reserved.`,
        );
      }
    }
  }
}

// ── Codex `config.toml [mcp_servers.*]` parser ───────────────────────
// A focused parser (no TOML dependency, matching ProviderHealth's approach)
// that understands the exact shape Codex writes / the SY2 bridge emits:
//   [mcp_servers.<name>]
//   command = "npx"
//   args = ["-y", "server"]
//   url = "http://..."
//   env = { KEY = "val" }
//   enabled = false

function stripInlineComment(line: string): string {
  // Strip `#` comments that are not inside a quoted string.
  let inString = false;
  let quote = "";
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inString) {
      if (ch === quote) inString = false;
    } else if (ch === '"' || ch === "'") {
      inString = true;
      quote = ch;
    } else if (ch === "#") {
      return line.slice(0, i);
    }
  }
  return line;
}

function parseTomlScalarString(value: string): string | undefined {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    const inner = trimmed.slice(1, -1);
    if (trimmed.startsWith('"')) {
      try {
        return JSON.parse(`"${inner.replace(/\\?"/g, '\\"')}"`) as string;
      } catch {
        return inner;
      }
    }
    return inner;
  }
  return undefined;
}

function parseTomlStringArray(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("[") || !trimmed.endsWith("]")) return [];
  const inner = trimmed.slice(1, -1);
  const out: string[] = [];
  const matches = inner.matchAll(/"((?:[^"\\]|\\.)*)"|'([^']*)'/g);
  for (const match of matches) {
    if (match[1] !== undefined) {
      try {
        out.push(JSON.parse(`"${match[1]}"`) as string);
      } catch {
        out.push(match[1]);
      }
    } else if (match[2] !== undefined) {
      out.push(match[2]);
    }
  }
  return out;
}

function parseTomlInlineTableKeys(value: string): string[] {
  const trimmed = value.trim();
  if (!trimmed.startsWith("{") || !trimmed.endsWith("}")) return [];
  const inner = trimmed.slice(1, -1);
  const keys: string[] = [];
  for (const pair of inner.split(",")) {
    const eq = pair.indexOf("=");
    if (eq === -1) continue;
    const key = pair
      .slice(0, eq)
      .trim()
      .replace(/^["']|["']$/g, "");
    if (key.length > 0) keys.push(key);
  }
  return keys;
}

/** Section header name for `[mcp_servers.<name>]`; supports bare + quoted names. */
function matchMcpSectionName(header: string): string | null {
  const inner = header
    .trim()
    .replace(/^\[|\]$/g, "")
    .trim();
  if (inner === "mcp_servers") return null;
  const prefix = "mcp_servers.";
  if (!inner.startsWith(prefix)) return null;
  const rest = inner.slice(prefix.length).trim();
  if (rest.length === 0) return null;
  // Quoted table name: mcp_servers."my server"
  const quoted = parseTomlScalarString(rest);
  if (quoted !== undefined) return quoted;
  // Bare dotted names beyond one segment are sub-tables (e.g. `.env`); the
  // server name is the first segment.
  return rest.split(".")[0]?.replace(/^["']|["']$/g, "") ?? null;
}

export function parseCodexMcpServers(content: string): Map<string, RawMcpServer> {
  const out = new Map<string, RawMcpServer>();
  let current: string | null = null;
  let acc: {
    command?: string;
    args?: string[];
    url?: string;
    envKeys?: string[];
    enabled: boolean;
    type?: string;
  } | null = null;

  const flush = () => {
    if (current && acc) out.set(current, acc);
    current = null;
    acc = null;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripInlineComment(rawLine).trim();
    if (line.length === 0) continue;

    if (line.startsWith("[")) {
      flush();
      const name = matchMcpSectionName(line);
      if (name) {
        current = name;
        acc = { enabled: true };
      }
      continue;
    }

    if (!current || !acc) continue;
    const eq = line.indexOf("=");
    if (eq === -1) continue;
    const key = line.slice(0, eq).trim();
    const value = line.slice(eq + 1).trim();

    switch (key) {
      case "command": {
        const parsed = parseTomlScalarString(value);
        if (parsed !== undefined) acc.command = parsed;
        break;
      }
      case "url": {
        const parsed = parseTomlScalarString(value);
        if (parsed !== undefined) acc.url = parsed;
        break;
      }
      case "args":
        acc.args = parseTomlStringArray(value);
        break;
      case "env":
        acc.envKeys = parseTomlInlineTableKeys(value);
        break;
      case "type":
      case "transport": {
        const parsed = parseTomlScalarString(value);
        if (parsed !== undefined) acc.type = parsed;
        break;
      }
      case "enabled":
        acc.enabled = value.trim() !== "false";
        break;
      default:
        break;
    }
  }
  flush();
  return out;
}

async function readCodexMcpServers(homeDir: string): Promise<Map<string, RawMcpServer>> {
  const codexHome = process.env.CODEX_HOME || nodePath.join(homeDir, ".codex");
  const content = await readFileOrNull(nodePath.join(codexHome, "config.toml"));
  if (content === null) return new Map();
  return parseCodexMcpServers(content);
}

// ── Origin ordering ──────────────────────────────────────────────────
// Moss-canonical wins name-dedup, then engine-native configs. This mirrors
// `skillsCatalog`'s "moss origin is the single source of truth" precedence.
interface OriginResult {
  readonly origin: string;
  readonly path: string;
  readonly servers: Map<string, RawMcpServer>;
}

/**
 * Discover every MCP server across the canonical Moss source and each engine's
 * native config, deduped by name with Moss winning. Env values are never
 * surfaced — only the declared key names travel to the client.
 */
export async function discoverMcpCatalog(
  input: McpCatalogInput,
): Promise<ProviderMcpServerDescriptor[]> {
  const cwd = input.cwd?.trim();
  const results: OriginResult[] = [];

  // 1. Moss canonical — per workspace ancestor (deepest first).
  if (cwd) {
    for (const ancestor of ancestorsFromDeepest(cwd)) {
      const mossConfig = nodePath.join(ancestor, MOSS_RELATIVE_PATHS.mcpConfig);
      const servers = await readJsonServerMap(mossConfig);
      if (servers.size > 0) results.push({ origin: "moss", path: mossConfig, servers });
    }
  }

  // 2. Moss portable MCP config.
  const mossConfig = nodePath.join(input.mossBaseDir, "mcp", "config.json");
  const mossServers = await readJsonServerMap(mossConfig);
  if (mossServers.size > 0) {
    results.push({ origin: "moss", path: mossConfig, servers: mossServers });
  }

  // 3. Codex native `config.toml`.
  const codexHome = process.env.CODEX_HOME || nodePath.join(input.homeDir, ".codex");
  const codexServers = await readCodexMcpServers(input.homeDir);
  if (codexServers.size > 0) {
    results.push({
      origin: "codex",
      path: nodePath.join(codexHome, "config.toml"),
      servers: codexServers,
    });
  }

  // 4. Claude native — project `.mcp.json` then home `~/.claude.json`.
  if (cwd) {
    const projectMcp = nodePath.join(cwd, ".mcp.json");
    const projectServers = await readJsonServerMap(projectMcp);
    if (projectServers.size > 0) {
      results.push({ origin: "claude", path: projectMcp, servers: projectServers });
    }
  }
  const claudeHome = nodePath.join(input.homeDir, ".claude.json");
  const claudeHomeServers = await readJsonServerMap(claudeHome);
  if (claudeHomeServers.size > 0) {
    results.push({ origin: "claude", path: claudeHome, servers: claudeHomeServers });
  }

  const byName = new Map<string, ProviderMcpServerDescriptor>();
  for (const result of results) {
    for (const [name, raw] of result.servers) {
      const reservedIdentity = controlPlaneIdentity(name, raw);
      if (reservedIdentity) {
        if (result.origin === "moss") {
          throw new Error(
            `Moss MCP config at ${result.path} declares ${reservedIdentity}; control-plane MCP identities are reserved.`,
          );
        }
        continue;
      }
      const key = mcpNameKey(name);
      if (byName.has(key)) continue;
      byName.set(key, toDescriptor({ name, origin: result.origin, path: result.path, raw }));
    }
  }
  return [...byName.values()].toSorted((a, b) => a.name.localeCompare(b.name));
}
