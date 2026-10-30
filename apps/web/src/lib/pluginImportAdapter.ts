// FILE: pluginImportAdapter.ts
// Purpose: Parse a local plugin/skill source and adapt the existing typed Moss
//          filesystem/resource APIs into a safe import + rollback workflow.
// Layer: Web lib (pure parsing plus a native adapter)

import type { MossResourceImportApplyResult, ProjectReadFileResult } from "@synara/contracts";

import { ensureNativeApi } from "~/nativeApi";
import { requireDurableMossResourceImportReceipt } from "./mossResourceImportReceiptAdapter";

export type PluginImportResourceKind = "plugin" | "skill" | "mcp";

export const PLUGIN_IMPORT_MAX_BYTES = 1_000_000;

export interface PluginImportSourceInput {
  readonly kind: PluginImportResourceKind;
  readonly sourceName: string;
  readonly contents: string;
}

export type PluginImportErrorKey =
  | "plugins.import.error.emptySource"
  | "plugins.import.error.pluginExtension"
  | "plugins.import.error.pluginJson"
  | "plugins.import.error.pluginObject"
  | "plugins.import.error.skillExtension"
  | "plugins.import.error.skillName"
  | "plugins.import.error.mcpExtension"
  | "plugins.import.error.mcpJson"
  | "plugins.import.error.mcpName"
  | "plugins.import.error.invalidMcpName"
  | "plugins.import.error.destinationTooLarge"
  | "plugins.import.error.invalidCanonicalMcp"
  | "plugins.import.source.tooLarge";

export type PluginImportMetadataKey =
  | "plugins.import.metadata.plugin"
  | "plugins.import.metadata.skill"
  | "plugins.import.metadata.mcp";

export type PluginImportPreviewKey = "plugins.import.preview.mcp";

export class PluginImportAdapterError extends Error {
  readonly key: PluginImportErrorKey;

  constructor(key: PluginImportErrorKey) {
    super(key);
    this.name = "PluginImportAdapterError";
    Object.setPrototypeOf(this, new.target.prototype);
    this.key = key;
  }
}

export function isPluginImportAdapterError(error: unknown): error is PluginImportAdapterError {
  return error instanceof PluginImportAdapterError;
}

export interface PluginImportCandidate {
  readonly kind: PluginImportResourceKind;
  readonly sourceName: string;
  readonly name: string;
  readonly description: string | null;
  /** Preview mirror of the #116 plan operation targetPath; final apply must use the server plan. */
  readonly targetRelativePath: string;
  /** Stable MCP source selector carried into the eventual server plan. */
  readonly sourceSelector?: string | undefined;
  readonly contents: string;
  readonly previewText: string | null;
  readonly previewKey?: PluginImportPreviewKey | undefined;
  readonly previewValues?:
    | {
        readonly table: string;
        readonly name: string;
      }
    | undefined;
  readonly metadataLabelKey: PluginImportMetadataKey;
  readonly operation: "copy" | "merge";
}

export interface PluginImportReadFile {
  readonly contents: string;
  readonly truncated: boolean;
}

export type PluginImportExpectedState =
  | { readonly kind: "absent" }
  | { readonly kind: "sha256"; readonly sha256: string };

export interface PluginImportWriteReceipt {
  readonly transactionId: NonNullable<MossResourceImportApplyResult["receipt"]>["transactionId"];
  readonly operationId: NonNullable<MossResourceImportApplyResult["receipt"]>["operationId"];
  readonly planHash: NonNullable<MossResourceImportApplyResult["receipt"]>["planHash"];
  readonly afterState: NonNullable<MossResourceImportApplyResult["receipt"]>["afterState"];
}

export interface PluginImportFileAdapter {
  readonly readFile: (relativePath: string) => Promise<PluginImportReadFile>;
  readonly apply: (input: {
    readonly kind: PluginImportResourceKind;
    readonly sourceName: string;
    readonly sourceSelector?: string | undefined;
    readonly contents: string;
    readonly replaceExisting?: boolean | undefined;
  }) => Promise<PluginImportWriteReceipt>;
  /** Only server-issued receipts with compare-and-swap rollback may expose this method. */
  readonly rollback?: (input: {
    readonly receipt: PluginImportWriteReceipt;
  }) => Promise<{ readonly rolledBack: boolean }>;
}

export type PluginImportConflict =
  | {
      readonly status: "missing";
      readonly expected: { readonly kind: "absent" };
    }
  | {
      readonly status: "existing";
      readonly expected: { readonly kind: "sha256"; readonly sha256: string };
    }
  | {
      /** MCP config exists, but the named server is absent and should be merged. */
      readonly status: "merge";
      readonly expected: { readonly kind: "sha256"; readonly sha256: string };
    };

export type PluginImportParseResult =
  | { readonly ok: true; readonly candidate: PluginImportCandidate }
  | { readonly ok: false; readonly errorKey: PluginImportErrorKey };

function stringValue(value: unknown): string | null {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : null;
}

function basename(value: string): string {
  const parts = value.split(/[\\/]/u);
  return parts.at(-1) ?? value;
}

function withoutExtension(value: string): string {
  return value.replace(/\.(?:json|markdown?|md)$/iu, "");
}

function slugifyImportName(value: string, kind: PluginImportResourceKind): string {
  const ascii = value
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/gu, "")
    .replace(/[^a-zA-Z0-9]+/gu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase()
    .slice(0, 64);
  return ascii || `imported-${kind}`;
}

function readFrontmatterValue(contents: string, key: string): string | null {
  const match = /^---\s*\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/u.exec(contents);
  if (!match?.[1]) return null;
  for (const line of match[1].split(/\r?\n/u)) {
    const separator = line.indexOf(":");
    if (separator < 0 || line.slice(0, separator).trim() !== key) continue;
    return stringValue(
      line
        .slice(separator + 1)
        .trim()
        .replace(/^(['"])(.*)\1$/u, "$2"),
    );
  }
  return null;
}

function previewText(contents: string): string {
  const normalized = contents.replace(/^\uFEFF/u, "").trim();
  return normalized.slice(0, 2_400);
}

const MCP_SELECTOR_TABLES = new Set(["mcpServers", "mcp_servers", "servers", "mcp.servers", "mcp"]);

const MCP_RESERVED_NAMES = new Set(["__proto__", "prototype", "constructor"]);

function checkedMcpServerName(value: string): string {
  const normalized = value.normalize("NFKC");
  if (
    normalized !== value ||
    normalized.length === 0 ||
    MCP_RESERVED_NAMES.has(normalized.toLowerCase()) ||
    /[\\/]/u.test(normalized) ||
    /[\p{C}\p{Zl}\p{Zp}]/u.test(normalized) ||
    normalized.includes("::")
  ) {
    throw new PluginImportAdapterError("plugins.import.error.invalidMcpName");
  }
  return normalized;
}

function checkedMcpSourceSelector(value: string): string {
  const normalized = value.normalize("NFKC");
  const separator = normalized.indexOf("::");
  if (
    normalized !== value ||
    separator < 1 ||
    separator !== normalized.lastIndexOf("::") ||
    !MCP_SELECTOR_TABLES.has(normalized.slice(0, separator))
  ) {
    throw new PluginImportAdapterError("plugins.import.error.invalidMcpName");
  }
  const table = normalized.slice(0, separator);
  const name = checkedMcpServerName(normalized.slice(separator + 2));
  return `${table}::${name}`;
}

function byteLength(contents: string): number {
  return new TextEncoder().encode(contents).byteLength;
}

export async function sha256Text(contents: string): Promise<string> {
  const digest = await globalThis.crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(contents),
  );
  return Array.from(new Uint8Array(digest), (byte) => byte.toString(16).padStart(2, "0")).join("");
}

export const PLUGIN_IMPORT_RECEIPT_REQUIRED_ERROR = "PLUGIN_IMPORT_RECEIPT_REQUIRED";
/** @deprecated Kept as a compatibility alias for existing error mappers. */
export const PLUGIN_IMPORT_DIRECT_WRITE_ERROR = PLUGIN_IMPORT_RECEIPT_REQUIRED_ERROR;

export function isPluginImportDirectWriteError(error: unknown): boolean {
  return (
    typeof error === "object" &&
    error !== null &&
    "code" in error &&
    (error as { readonly code?: unknown }).code === PLUGIN_IMPORT_DIRECT_WRITE_ERROR
  );
}

function parsePluginSource(input: PluginImportSourceInput): PluginImportParseResult {
  if (!/\.json$/iu.test(input.sourceName)) {
    return { ok: false, errorKey: "plugins.import.error.pluginExtension" };
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(input.contents.replace(/^\uFEFF/u, ""));
  } catch {
    return { ok: false, errorKey: "plugins.import.error.pluginJson" };
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    return { ok: false, errorKey: "plugins.import.error.pluginObject" };
  }

  const manifest = parsed as Record<string, unknown>;
  const interfaceValue =
    manifest.interface !== null &&
    typeof manifest.interface === "object" &&
    !Array.isArray(manifest.interface)
      ? (manifest.interface as Record<string, unknown>)
      : null;
  const idName = stringValue(manifest.id)?.split("@")[0];
  const name =
    stringValue(manifest.name) ??
    stringValue(idName) ??
    withoutExtension(basename(input.sourceName));
  const description =
    stringValue(manifest.description) ?? stringValue(interfaceValue?.shortDescription);
  const targetRelativePath = `.moss/plugins/${slugifyImportName(name, "plugin")}/plugin.json`;

  return {
    ok: true,
    candidate: {
      kind: "plugin",
      sourceName: basename(input.sourceName),
      name,
      description,
      targetRelativePath,
      contents: input.contents,
      previewText: previewText(input.contents),
      metadataLabelKey: "plugins.import.metadata.plugin",
      operation: "copy",
    },
  };
}

function parseSkillSource(input: PluginImportSourceInput): PluginImportParseResult {
  if (!/\.(?:markdown?|md)$/iu.test(input.sourceName)) {
    return { ok: false, errorKey: "plugins.import.error.skillExtension" };
  }

  const name =
    readFrontmatterValue(input.contents, "name") ??
    withoutExtension(basename(input.sourceName)).trim();
  if (!name) return { ok: false, errorKey: "plugins.import.error.skillName" };
  const description = readFrontmatterValue(input.contents, "description");
  const targetRelativePath = `.moss/skills/${slugifyImportName(name, "skill")}/SKILL.md`;

  return {
    ok: true,
    candidate: {
      kind: "skill",
      sourceName: basename(input.sourceName),
      name,
      description,
      targetRelativePath,
      contents: input.contents,
      previewText: previewText(input.contents),
      metadataLabelKey: "plugins.import.metadata.skill",
      operation: "copy",
    },
  };
}

function recordValue(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) return false;
  return !["__proto__", "prototype", "constructor"].some((key) =>
    Object.prototype.hasOwnProperty.call(value, key),
  );
}

function parseCanonicalMcpConfig(contents: string): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(contents.replace(/^\uFEFF/u, ""));
  } catch {
    throw new PluginImportAdapterError("plugins.import.error.invalidCanonicalMcp");
  }
  if (!isPlainRecord(parsed)) {
    throw new PluginImportAdapterError("plugins.import.error.invalidCanonicalMcp");
  }
  if (!Object.prototype.hasOwnProperty.call(parsed, "mcpServers")) return {};
  const servers = parsed.mcpServers;
  if (!isPlainRecord(servers)) {
    throw new PluginImportAdapterError("plugins.import.error.invalidCanonicalMcp");
  }
  for (const entry of Object.values(servers)) {
    if (!isPlainRecord(entry)) {
      throw new PluginImportAdapterError("plugins.import.error.invalidCanonicalMcp");
    }
  }
  return servers;
}

interface McpServerSelection {
  readonly table: string;
  readonly name: string;
  readonly selector: string;
}

function mcpServerSelections(value: unknown): McpServerSelection[] {
  const root = recordValue(value);
  if (!root) return [];
  const mcp = recordValue(root.mcp);
  const tables: Array<readonly [string, unknown]> = [
    ["mcpServers", root.mcpServers],
    ["mcp_servers", root.mcp_servers],
    ["servers", root.servers],
  ];
  if (mcp) {
    const nestedServers = recordValue(mcp.servers);
    tables.push(nestedServers ? ["mcp.servers", nestedServers] : ["mcp", mcp]);
  }
  const selections: McpServerSelection[] = [];
  for (const [tableName, table] of tables) {
    const entries = recordValue(table);
    if (!entries) continue;
    for (const [name, entry] of Object.entries(entries)) {
      if (name.trim().length === 0 || !recordValue(entry)) continue;
      const checkedName = checkedMcpServerName(name);
      selections.push({
        table: tableName,
        name: checkedName,
        selector: checkedMcpSourceSelector(`${tableName}::${checkedName}`),
      });
    }
  }
  return selections.filter(
    (selection, index) =>
      selections.findIndex((candidate) => candidate.selector === selection.selector) === index,
  );
}

function firstMcpServerSelection(value: unknown): McpServerSelection | null {
  return mcpServerSelections(value)[0] ?? null;
}

function mcpConfigContainsServer(contents: string, name: string): boolean {
  const canonicalServers = parseCanonicalMcpConfig(contents);
  return Object.prototype.hasOwnProperty.call(canonicalServers, name);
}

function firstMcpTomlServerSelection(contents: string): McpServerSelection | null {
  const tablePattern =
    /^\s*\[((?:mcpServers|mcp_servers|servers|mcp\.servers|mcp)\.([^\]\r\n]+))\]\s*$/gim;
  const match = tablePattern.exec(contents);
  const table = match?.[1]?.split(".")[0];
  const rawName = match?.[2]?.trim();
  if (!table || !rawName) return null;
  const name = checkedMcpServerName(
    rawName.replace(
      /^(?:"([^"]+)"|'([^']+)')$/u,
      (_, doubleQuoted, singleQuoted) => doubleQuoted ?? singleQuoted,
    ),
  );
  const selectorTable = match[1]!.slice(0, match[1]!.length - rawName.length).replace(/\.$/u, "");
  return {
    table: selectorTable,
    name,
    selector: checkedMcpSourceSelector(`${selectorTable}::${name}`),
  };
}

function parseMcpSource(input: PluginImportSourceInput): PluginImportParseResult {
  if (!/\.(?:json|toml)$/iu.test(input.sourceName)) {
    return { ok: false, errorKey: "plugins.import.error.mcpExtension" };
  }

  let selection: McpServerSelection | null = null;
  if (/\.json$/iu.test(input.sourceName)) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(input.contents.replace(/^\uFEFF/u, ""));
    } catch {
      return { ok: false, errorKey: "plugins.import.error.mcpJson" };
    }
    try {
      selection = firstMcpServerSelection(parsed);
    } catch (error) {
      if (isPluginImportAdapterError(error)) return { ok: false, errorKey: error.key };
      throw error;
    }
  } else {
    // This is deliberately a bounded preview parser. The #116 server importer
    // remains authoritative for full TOML semantics and secret-field handling.
    try {
      selection = firstMcpTomlServerSelection(input.contents);
    } catch (error) {
      if (isPluginImportAdapterError(error)) return { ok: false, errorKey: error.key };
      throw error;
    }
  }
  if (!selection) {
    return { ok: false, errorKey: "plugins.import.error.mcpName" };
  }

  return {
    ok: true,
    candidate: {
      kind: "mcp",
      sourceName: basename(input.sourceName),
      name: selection.name,
      description: null,
      targetRelativePath: ".moss/mcp/config.json",
      sourceSelector: selection.selector,
      contents: input.contents,
      previewText: null,
      previewKey: "plugins.import.preview.mcp",
      previewValues: { table: selection.table, name: selection.name },
      metadataLabelKey: "plugins.import.metadata.mcp",
      operation: "merge",
    },
  };
}

export function parsePluginImportSource(input: PluginImportSourceInput): PluginImportParseResult {
  if (input.sourceName.trim().length === 0) {
    return { ok: false, errorKey: "plugins.import.error.emptySource" };
  }
  if (byteLength(input.contents) > PLUGIN_IMPORT_MAX_BYTES) {
    return { ok: false, errorKey: "plugins.import.source.tooLarge" };
  }
  if (input.kind === "plugin") return parsePluginSource(input);
  if (input.kind === "skill") return parseSkillSource(input);
  return parseMcpSource(input);
}

export function isMissingPluginImportFileError(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  return /ENOENT|no such file|does not exist|not found|cannot find the path/iu.test(message);
}

export async function inspectPluginImportConflict(
  adapter: PluginImportFileAdapter,
  candidate: PluginImportCandidate,
): Promise<PluginImportConflict> {
  if (candidate.kind === "mcp") {
    checkedMcpServerName(candidate.name);
    if (candidate.sourceSelector) checkedMcpSourceSelector(candidate.sourceSelector);
  }
  try {
    const existing = await adapter.readFile(candidate.targetRelativePath);
    if (existing.truncated) {
      throw new PluginImportAdapterError("plugins.import.error.destinationTooLarge");
    }
    const expected = { kind: "sha256" as const, sha256: await sha256Text(existing.contents) };
    if (candidate.kind === "mcp" && !mcpConfigContainsServer(existing.contents, candidate.name)) {
      return { status: "merge", expected };
    }
    return { status: "existing", expected };
  } catch (error) {
    if (isMissingPluginImportFileError(error)) {
      return {
        status: "missing",
        expected: { kind: "absent" },
      };
    }
    throw error;
  }
}

export function createPluginImportAdapter(cwd: string): PluginImportFileAdapter {
  const api = ensureNativeApi();
  return {
    readFile: async (relativePath) => {
      const result: ProjectReadFileResult = await api.projects.readFile({
        cwd,
        relativePath,
        maxBytes: PLUGIN_IMPORT_MAX_BYTES,
      });
      return { contents: result.contents, truncated: result.truncated };
    },
    apply: async (input) => {
      const planned = await api.provider.resourceImportPlan({
        cwd,
        selectionOrigin: "local",
        localSource: {
          kind: input.kind,
          sourceName: input.sourceName,
          contents: input.contents,
          ...(input.sourceSelector ? { sourceSelector: input.sourceSelector } : {}),
          ...(input.replaceExisting ? { replaceExisting: true } : {}),
        },
      });
      const operation = planned.plan.operations[0];
      if (
        !operation ||
        (operation.action !== "copy" &&
          operation.action !== "merge" &&
          operation.action !== "replace")
      ) {
        const error = new Error(PLUGIN_IMPORT_RECEIPT_REQUIRED_ERROR) as Error & {
          readonly code: string;
        };
        Object.defineProperty(error, "code", {
          configurable: false,
          enumerable: true,
          value: PLUGIN_IMPORT_RECEIPT_REQUIRED_ERROR,
          writable: false,
        });
        throw error;
      }
      const applied = await api.provider.resourceImportApply({
        cwd,
        plan: planned.plan,
      });
      return requireDurableMossResourceImportReceipt(applied);
    },
    rollback: async ({ receipt }) => {
      const rolledBack = await api.provider.resourceImportRollback({
        cwd,
        transactionId: receipt.transactionId,
      });
      return { rolledBack: rolledBack.status === "rolled-back" };
    },
  };
}
