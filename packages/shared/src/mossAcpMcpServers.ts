/**
 * ACP MCP injection derivation (slice SY8 — sibling of
 * {@link file://./mossCodexMcpOverrides.ts}).
 *
 * The canonical Moss MCP source is `<projectPath>/.moss/mcp/config.json`
 * (layout constant `MOSS_RELATIVE_PATHS.mcpConfig`), read here with exactly the
 * same `mcpServers ?? servers` resolution the codex overrides and the SY2
 * materializer bridges use — so the ACP `session/new` handshake, the codex
 * `-c mcp_servers.*` args, and the write-only file bridges never diverge
 * (single source of truth, SY8 A4).
 *
 * ACP agents (cursor / gemini / grok) receive MCP servers as a typed array on
 * the ACP `session/new` and `session/load` requests (effect-acp `McpServer`
 * union: `stdio` = command/args/env, `http`/`sse` = url/headers). This helper
 * projects each declared Moss MCP server into that shape:
 *   - a `command` (with optional `args`/`env`) -> stdio `McpServer`
 *   - a `url` with `type: "http" | "sse"` (default http) -> http/sse `McpServer`
 *
 * Every reader here is read-only and NEVER throws: a missing project path,
 * missing file, or malformed JSON degrades to an empty array (SY8 A3 — degrade,
 * not block) with an optional warning, matching the SY4 degradation contract.
 */
import { readFile } from "node:fs/promises";
import path from "node:path";

import { MOSS_RELATIVE_PATHS } from "./mossSourceLayout";

/**
 * Structural mirror of the effect-acp `McpServer` union. Kept as a local type
 * (not an `effect-acp/schema` import) so `packages/shared` does not depend on
 * the ACP protocol package — this file is only imported server-side, but the
 * shared package must stay resolvable from web too. The server call site passes
 * the derived value straight into `EffectAcpSchema.McpServer[]`, where
 * TypeScript's structural typing confirms the shapes match.
 */
export interface MossAcpEnvVariable {
  readonly name: string;
  readonly value: string;
}
export interface MossAcpHttpHeader {
  readonly name: string;
  readonly value: string;
}
export type MossAcpMcpServer =
  | {
      readonly type: "http";
      readonly headers: ReadonlyArray<MossAcpHttpHeader>;
      readonly name: string;
      readonly url: string;
    }
  | {
      readonly type: "sse";
      readonly headers: ReadonlyArray<MossAcpHttpHeader>;
      readonly name: string;
      readonly url: string;
    }
  | {
      readonly args: ReadonlyArray<string>;
      readonly command: string;
      readonly env: ReadonlyArray<MossAcpEnvVariable>;
      readonly name: string;
    };

export interface DerivedMossAcpMcpServers {
  /** effect-acp `McpServer[]`-compatible array, ready to spread into a request. */
  readonly servers: MossAcpMcpServer[];
  /** Server names that produced at least one server (for logging/evidence). */
  readonly serverNames: string[];
  /** Non-fatal problems encountered while deriving servers. */
  readonly warnings: string[];
}

function emptyResult(): DerivedMossAcpMcpServers {
  return { servers: [], serverNames: [], warnings: [] };
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
 * the canonical `mcpServers` (or legacy `servers`) key. Mirrors
 * `mossCodexMcpOverrides.readMossMcpServerTable` byte-for-byte so both live
 * injection paths share one source of truth.
 *
 * Returns `{ kind: "empty" }` on a missing project path or missing file
 * (ENOENT) so the caller can distinguish "no config" (silent) from a parse
 * failure (warned).
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

function toEnvVariables(env: unknown): MossAcpEnvVariable[] {
  const entries: MossAcpEnvVariable[] = [];
  if (isRecord(env)) {
    for (const [name, value] of Object.entries(env)) {
      if (typeof value === "string") {
        entries.push({ name, value });
      }
    }
  }
  return entries;
}

function toHttpHeaders(headers: unknown): MossAcpHttpHeader[] {
  const entries: MossAcpHttpHeader[] = [];
  if (isRecord(headers)) {
    for (const [name, value] of Object.entries(headers)) {
      if (typeof value === "string") {
        entries.push({ name, value });
      }
    }
  }
  return entries;
}

/**
 * Project a single Moss MCP server definition into an ACP `McpServer` shape.
 * Returns `null` when the config has neither a `command` (stdio) nor a `url`
 * (http/sse), so the caller can warn on a no-op server.
 */
function toAcpMcpServer(name: string, config: Record<string, unknown>): MossAcpMcpServer | null {
  if (isNonEmptyString(config.command)) {
    return {
      name,
      command: config.command,
      args: isStringArray(config.args) ? config.args : [],
      env: toEnvVariables(config.env),
    };
  }

  if (isNonEmptyString(config.url)) {
    const transport = config.type === "sse" ? "sse" : "http";
    return {
      type: transport,
      name,
      url: config.url,
      headers: toHttpHeaders(config.headers),
    };
  }

  return null;
}

/**
 * Read `<projectPath>/.moss/mcp/config.json` and derive the effect-acp
 * `McpServer[]` to inject into an ACP `session/new` / `session/load` request
 * (SY8 A3). Never throws: a missing project path, missing file, or malformed
 * JSON degrades to an empty array so an unconfigured project sees zero
 * behavioral change (payload `mcpServers === []`).
 */
export async function deriveMossAcpMcpServers(
  projectPath: string | null | undefined,
): Promise<DerivedMossAcpMcpServers> {
  const table = await readMossMcpServerTable(projectPath);
  if (table.kind === "empty") return emptyResult();
  if (table.kind === "error") return { ...emptyResult(), warnings: [table.warning] };

  const servers: MossAcpMcpServer[] = [];
  const serverNames: string[] = [];
  const warnings: string[] = [];

  for (const [serverName, serverConfig] of Object.entries(table.servers)) {
    if (!isNonEmptyString(serverName)) continue;
    const config = isRecord(serverConfig) ? serverConfig : {};
    const server = toAcpMcpServer(serverName, config);
    if (server) {
      servers.push(server);
      serverNames.push(serverName);
    } else {
      warnings.push(
        `Moss MCP server "${serverName}" produced no ACP server (missing command/url).`,
      );
    }
  }

  return { servers, serverNames, warnings };
}
