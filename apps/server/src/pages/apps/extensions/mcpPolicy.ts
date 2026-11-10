// FILE: mcpPolicy.ts
// Purpose: The safety rules every 应用页 connector call passes before it
// leaves Moss: the page's own allowlist (servers and tools it declared), an
// administrator's managed policy, which tools count as destructive, and a
// per-page rate limit.
// Layer: Server pages/apps extensions

import { readFile } from "node:fs/promises";
import * as nodePath from "node:path";

import {
  PAGE_APP_MCP_MAX_SERVERS,
  PAGE_APP_MCP_MAX_TOOLS_PER_SERVER,
  type PageAppMcpConfig,
  type PageAppMcpServerDeclaration,
} from "@moss/contracts";

import type { PageAppMcpTool } from "./mcpSources";

const TOOL_NAME = /^[A-Za-z0-9_.:/-]{1,128}$/u;
const SERVER_NAME = /^[\p{L}\p{N} _.:-]{1,64}$/u;

const isRecord = (value: unknown): value is Record<string, unknown> =>
  value !== null && typeof value === "object" && !Array.isArray(value);

/** Reads `capabilities.mcp`; null with a reason when it is malformed. */
export function parsePageAppMcpConfig(
  config: unknown,
): { config: PageAppMcpConfig } | { problem: string } {
  if (!isRecord(config)) return { problem: "mcp config must be an object with servers." };
  const servers = config.servers;
  if (!Array.isArray(servers) || servers.length === 0)
    return { problem: "mcp.servers must list at least one server." };
  if (servers.length > PAGE_APP_MCP_MAX_SERVERS)
    return { problem: `mcp.servers allows at most ${PAGE_APP_MCP_MAX_SERVERS}.` };
  const out: PageAppMcpServerDeclaration[] = [];
  const seen = new Set<string>();
  for (const entry of servers) {
    if (
      !isRecord(entry) ||
      typeof entry.server !== "string" ||
      !SERVER_NAME.test(entry.server.trim())
    )
      return { problem: "Each mcp server needs a name (letters, digits, space, _ . : -)." };
    const key = entry.server.trim().toLowerCase();
    if (seen.has(key)) return { problem: `mcp server "${entry.server}" is listed twice.` };
    seen.add(key);
    if (!Array.isArray(entry.tools) || entry.tools.length === 0)
      return { problem: `mcp server "${entry.server}" must list the tools the page calls.` };
    if (entry.tools.length > PAGE_APP_MCP_MAX_TOOLS_PER_SERVER)
      return {
        problem: `mcp server "${entry.server}" lists more than ${PAGE_APP_MCP_MAX_TOOLS_PER_SERVER} tools.`,
      };
    const tools: string[] = [];
    for (const tool of entry.tools) {
      if (typeof tool !== "string" || !TOOL_NAME.test(tool) || tools.includes(tool))
        return { problem: `mcp server "${entry.server}" has an invalid or repeated tool name.` };
      tools.push(tool);
    }
    out.push({ server: entry.server.trim(), tools });
  }
  return { config: { servers: out } };
}

export function findDeclaredServer(
  config: PageAppMcpConfig,
  server: string,
): PageAppMcpServerDeclaration | null {
  const wanted = server.trim().toLowerCase();
  return config.servers.find((entry) => entry.server.toLowerCase() === wanted) ?? null;
}

// ---------------------------------------------------------------------------
// Destructive classification
// ---------------------------------------------------------------------------

const READ_VERBS =
  /^(?:get|list|search|find|fetch|read|query|describe|lookup|look_up|show|view|count|check|retrieve|download|export|preview|stat)(?:_|-|\.|$)/iu;
const DESTRUCTIVE_VERBS =
  /(?:^|_|-|\.)(?:delete|remove|destroy|drop|purge|erase|wipe|truncate|revoke|archive|trash|overwrite|reset|force_push|merge|close|cancel|terminate|kill|uninstall|unpublish|transfer|pay|send|post|publish|deploy|execute|exec|run)(?:_|-|\.|$)/iu;

export interface PageAppMcpToolClass {
  readonly readOnly: boolean;
  readonly destructive: boolean;
}

/**
 * Annotations win when the server gives them. Without them, a tool whose name
 * reads like a lookup is read-only, one whose name says it removes, sends or
 * runs something is destructive, and anything else is a plain write (not
 * cached, not confirmed). Unknown tools are treated as destructive.
 */
export function classifyMcpTool(name: string, tool: PageAppMcpTool | null): PageAppMcpToolClass {
  const bare = name.replace(/^[A-Z0-9]+_(?=[A-Z])/u, "").toLowerCase();
  const annotations = tool?.annotations ?? {};
  if (annotations.readOnlyHint === true) return { readOnly: true, destructive: false };
  if (annotations.destructiveHint === true) return { readOnly: false, destructive: true };
  if (annotations.destructiveHint === false) return { readOnly: false, destructive: false };
  if (!tool) return { readOnly: false, destructive: true };
  if (DESTRUCTIVE_VERBS.test(bare) || DESTRUCTIVE_VERBS.test(name.toLowerCase()))
    return { readOnly: false, destructive: true };
  if (READ_VERBS.test(bare)) return { readOnly: true, destructive: false };
  // Spec default for a tool that says it is not read-only is "may destroy".
  if (annotations.readOnlyHint === false) return { readOnly: false, destructive: true };
  return { readOnly: false, destructive: false };
}

// ---------------------------------------------------------------------------
// Managed policy
// ---------------------------------------------------------------------------

/**
 * An administrator's rules for connector calls from pages, read from
 * `<moss base>/policy/page-apps.json` (or `MOSS_PAGE_APPS_POLICY` as JSON):
 * `{ "mcp": { "disabled": bool, "allowServers": [..], "blockServers": [..],
 *   "blockTools": ["server/tool", "*\/delete_*"], "confirmTools": [..],
 *   "maxCallsPerMinute": n } }`. Names match case-insensitively; `*` is a wildcard.
 */
export interface PageAppMcpManagedPolicy {
  readonly disabled: boolean;
  readonly allowServers: readonly string[] | null;
  readonly blockServers: readonly string[];
  readonly blockTools: readonly string[];
  readonly confirmTools: readonly string[];
  readonly maxCallsPerMinute: number | null;
}

export const OPEN_POLICY: PageAppMcpManagedPolicy = {
  disabled: false,
  allowServers: null,
  blockServers: [],
  blockTools: [],
  confirmTools: [],
  maxCallsPerMinute: null,
};

const strings = (value: unknown): string[] =>
  Array.isArray(value)
    ? value.filter((item): item is string => typeof item === "string" && item.length <= 200)
    : [];

export function parseManagedPolicy(raw: string | null | undefined): PageAppMcpManagedPolicy {
  if (!raw) return OPEN_POLICY;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    // A broken policy file closes connector calls rather than opening them.
    return { ...OPEN_POLICY, disabled: true };
  }
  const mcp = isRecord(parsed) && isRecord(parsed.mcp) ? parsed.mcp : null;
  if (!mcp) return OPEN_POLICY;
  const max = mcp.maxCallsPerMinute;
  return {
    disabled: mcp.disabled === true,
    allowServers: Array.isArray(mcp.allowServers) ? strings(mcp.allowServers) : null,
    blockServers: strings(mcp.blockServers),
    blockTools: strings(mcp.blockTools),
    confirmTools: strings(mcp.confirmTools),
    maxCallsPerMinute:
      typeof max === "number" && Number.isFinite(max) && max > 0 ? Math.floor(max) : null,
  };
}

function wildcard(pattern: string, value: string): boolean {
  const escaped = pattern
    .toLowerCase()
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/gu, "\\$&"))
    .join(".*");
  return new RegExp(`^${escaped}$`, "u").test(value.toLowerCase());
}

export type PageAppMcpPolicyVerdict =
  | { readonly kind: "allow"; readonly confirm: boolean }
  | { readonly kind: "block"; readonly reason: string };

export function evaluateManagedPolicy(
  policy: PageAppMcpManagedPolicy,
  server: { readonly name: string; readonly label: string },
  tool: string,
): PageAppMcpPolicyVerdict {
  const names = [server.name, server.label];
  const target = names.map((name) => `${name}/${tool}`);
  if (policy.disabled) return { kind: "block", reason: "管理员关闭了应用页调用连接的工具。" };
  if (
    policy.allowServers &&
    !names.some((name) => policy.allowServers!.some((pattern) => wildcard(pattern, name)))
  )
    return { kind: "block", reason: `管理员不允许应用页使用「${server.label}」。` };
  if (names.some((name) => policy.blockServers.some((pattern) => wildcard(pattern, name))))
    return { kind: "block", reason: `管理员不允许应用页使用「${server.label}」。` };
  if (target.some((value) => policy.blockTools.some((pattern) => wildcard(pattern, value))))
    return { kind: "block", reason: `管理员不允许应用页调用「${tool}」。` };
  return {
    kind: "allow",
    confirm: target.some((value) =>
      policy.confirmTools.some((pattern) => wildcard(pattern, value)),
    ),
  };
}

export function makeManagedPolicyReader(baseDir: string, env: NodeJS.ProcessEnv = process.env) {
  let cached: { at: number; policy: PageAppMcpManagedPolicy } | null = null;
  return async (): Promise<PageAppMcpManagedPolicy> => {
    if (env.MOSS_PAGE_APPS_POLICY) return parseManagedPolicy(env.MOSS_PAGE_APPS_POLICY);
    if (cached && Date.now() - cached.at < 10_000) return cached.policy;
    const raw = await readFile(nodePath.join(baseDir, "policy", "page-apps.json"), "utf8").catch(
      () => null,
    );
    const policy = parseManagedPolicy(raw);
    cached = { at: Date.now(), policy };
    return policy;
  };
}

// ---------------------------------------------------------------------------
// Rate limit (server side; the shell keeps its own, this one cannot be skipped)
// ---------------------------------------------------------------------------

export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  admit(key: string, limit: number): boolean {
    const at = this.now();
    const recent = (this.hits.get(key) ?? []).filter((time) => at - time < this.windowMs);
    if (recent.length >= limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(at);
    this.hits.set(key, recent);
    if (this.hits.size > 2_000) {
      for (const [entry, times] of this.hits)
        if (times.every((time) => at - time >= this.windowMs)) this.hits.delete(entry);
    }
    return true;
  }
}
