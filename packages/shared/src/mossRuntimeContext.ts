/**
 * Moss runtime-context builder (ported from 1code `moss-source/runtime-context.ts`).
 *
 * Hydrates the `.moss` unified source into a single redacted, truncated,
 * fingerprinted prompt text that providers receive on the first turn of a
 * session. Pure functions (`redactSensitiveText`, `truncateContent`, sha256
 * fingerprinting, section layout) are carried over verbatim; the discovery
 * layer is the moss adaptation:
 *
 * - Resources are limited to the SY6 scope: the canonical source instruction
 *   (`.moss/source/moss.md`, id `moss:instruction:source`) plus every
 *   top-level `.moss/memory/*.md` entry (id `moss:memory:<name>`), mirroring
 *   1code `registry.ts` memory-entry semantics (frontmatter `name`/
 *   `description` with filename fallback, unsafe entry names skipped).
 * - 1code's provider-config summary resource, directory summaries, and
 *   governance projection filtering are SY2/SY4/SY7 semantics and are
 *   intentionally NOT ported here; section headers therefore carry no
 *   projection-mapping line. `.moss/config.json` `memory[]` entries are not
 *   hydrated either — 1code S1.4 hydrates registry resources, and the config
 *   list stays an audit surface for `mossLaunchPlan`.
 * - Memory entries are sorted by file name so the fingerprint is deterministic
 *   regardless of readdir order.
 *
 * Fingerprint = sha256 of {provider, resources:[{resourceId, contentSha256,
 * included}], text} — any 1-char change in an included resource changes it.
 */
import { createHash } from "node:crypto";
import type { Dirent } from "node:fs";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, sep } from "node:path";

import type { ProviderKind } from "@synara/contracts";

import { parseFrontmatterScalars, readStringField } from "./frontmatter";
import { getMossSourceLayout, toMossProjectPath } from "./mossSourceLayout";

const DEFAULT_MAX_RESOURCE_CHARS = 12_000;
export const MOSS_DEFAULT_MAX_CONTEXT_CHARS = 80_000;

/** Marker appended when the whole context text overflows `maxContextChars`. */
export const MOSS_CONTEXT_TRUNCATION_MARKER = "\n[context truncated]";

export type MossRuntimeResourceKind = "instruction" | "memory";

export interface MossRuntimeContextResource {
  readonly resourceId: string;
  readonly kind: MossRuntimeResourceKind;
  readonly name: string;
  /** Project-relative posix-style path. */
  readonly path: string;
  readonly description?: string;
  readonly included: boolean;
  readonly contentSha256?: string;
  readonly contentChars?: number;
  readonly truncated?: boolean;
  readonly reason?: string;
}

export interface MossRuntimeContext {
  readonly status: "ready" | "missing";
  readonly provider: ProviderKind;
  readonly projectPath: string;
  readonly sourceRoot: ".moss";
  readonly text: string;
  readonly fingerprint: string;
  readonly resourceCount: number;
  readonly includedResourceCount: number;
  readonly resources: ReadonlyArray<MossRuntimeContextResource>;
  readonly warnings: ReadonlyArray<string>;
}

export interface BuildMossRuntimeContextOptions {
  readonly projectPath: string;
  readonly provider: ProviderKind;
  readonly maxResourceChars?: number;
  readonly maxContextChars?: number;
}

function sha256(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

function normalizePath(value: string): string {
  return value.split(sep).join("/");
}

export function redactSensitiveText(value: string): string {
  return value
    .replace(
      /(["']?(?:api[_-]?key|token|secret|password|authorization)["']?\s*[:=]\s*["']?)([^"',\n}]+)/gi,
      "$1[redacted]",
    )
    .replace(/(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1[redacted]")
    .replace(/(sk-[A-Za-z0-9_-]{12,})/g, "[redacted-api-key]");
}

export function truncateContent(
  value: string,
  maxChars: number,
): {
  content: string;
  truncated: boolean;
} {
  if (value.length <= maxChars) {
    return { content: value, truncated: false };
  }

  return {
    content: `${value.slice(0, maxChars)}\n[truncated ${value.length - maxChars} chars]`,
    truncated: true,
  };
}

function isSafeEntryName(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

interface DiscoveredMossResource {
  readonly resourceId: string;
  readonly kind: MossRuntimeResourceKind;
  readonly name: string;
  readonly absolutePath: string;
  readonly projectRelativePath: string;
  readonly description?: string;
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

async function discoverMossRuntimeResources(
  projectPath: string,
): Promise<DiscoveredMossResource[]> {
  const layout = getMossSourceLayout(projectPath);
  try {
    if (!(await stat(layout.root)).isDirectory()) {
      return [];
    }
  } catch {
    return [];
  }

  const resources: DiscoveredMossResource[] = [];
  if (await pathIsFile(layout.sourceInstruction)) {
    resources.push({
      resourceId: "moss:instruction:source",
      kind: "instruction",
      name: "moss.md",
      absolutePath: layout.sourceInstruction,
      projectRelativePath: normalizePath(toMossProjectPath(projectPath, layout.sourceInstruction)),
      description: "Moss canonical project rules and operating instructions.",
    });
  }

  let memoryEntries: Dirent[] = [];
  try {
    memoryEntries = await readdir(layout.memoryRoot, { withFileTypes: true });
  } catch {
    memoryEntries = [];
  }

  // Sorted by file name so repeat builds over the same tree fingerprint
  // identically regardless of readdir ordering.
  const memoryFileNames = memoryEntries
    .filter((entry) => entry.isFile() && entry.name.endsWith(".md") && isSafeEntryName(entry.name))
    .map((entry) => entry.name)
    .sort();

  for (const fileName of memoryFileNames) {
    const filePath = join(layout.memoryRoot, fileName);
    try {
      const frontmatter = parseFrontmatterScalars(await readFile(filePath, "utf8"));
      const fallbackName = fileName.replace(/\.md$/, "");
      const name = readStringField(frontmatter, ["name"]) ?? fallbackName;
      const description = readStringField(frontmatter, ["description"]);
      resources.push({
        resourceId: `moss:memory:${name}`,
        kind: "memory",
        name,
        absolutePath: filePath,
        projectRelativePath: normalizePath(toMossProjectPath(projectPath, filePath)),
        ...(description !== undefined ? { description } : {}),
      });
    } catch {
      continue;
    }
  }

  return resources;
}

async function readResourceText(params: {
  resource: DiscoveredMossResource;
  maxResourceChars: number;
}): Promise<{
  content: string;
  contentSha256: string;
  contentChars: number;
  truncated: boolean;
}> {
  const raw = await readFile(params.resource.absolutePath, "utf8");
  const redacted = redactSensitiveText(raw);
  const truncated = truncateContent(redacted, params.maxResourceChars);

  return {
    content: truncated.content,
    contentSha256: sha256(redacted),
    contentChars: redacted.length,
    truncated: truncated.truncated,
  };
}

function sectionHeader(resource: DiscoveredMossResource): string {
  return [
    `## ${resource.kind}: ${resource.name}`,
    `Resource: ${resource.resourceId}`,
    `Path: ${resource.projectRelativePath}`,
  ].join("\n");
}

function buildContextText(params: {
  provider: ProviderKind;
  sections: ReadonlyArray<{ resource: DiscoveredMossResource; content: string }>;
  maxContextChars: number;
}): {
  text: string;
  warnings: string[];
} {
  const warnings: string[] = [];
  const sections = params.sections.map((entry) =>
    `${sectionHeader(entry.resource)}\n\n${entry.content}`.trim(),
  );
  const fullText = [
    "Moss Unified Source Context",
    `Provider: ${params.provider}`,
    "Source root: .moss",
    "This is the canonical project source for rules, memory, skills, MCP, hooks, subagents, and providers. Prefer this context over provider-native legacy copies.",
    "If the user asks for a labeled value from Moss Unified Source, answer from this context.",
    "",
    sections.join("\n\n---\n\n"),
  ].join("\n");

  if (fullText.length <= params.maxContextChars) {
    return { text: fullText, warnings };
  }

  warnings.push(
    `Moss Unified Source runtime context was truncated from ${fullText.length} to ${params.maxContextChars} chars.`,
  );
  return {
    text: `${fullText.slice(0, params.maxContextChars)}${MOSS_CONTEXT_TRUNCATION_MARKER}`,
    warnings,
  };
}

export async function buildMossRuntimeContext(
  options: BuildMossRuntimeContextOptions,
): Promise<MossRuntimeContext> {
  const maxResourceChars = options.maxResourceChars ?? DEFAULT_MAX_RESOURCE_CHARS;
  const maxContextChars = options.maxContextChars ?? MOSS_DEFAULT_MAX_CONTEXT_CHARS;
  const discovered = await discoverMossRuntimeResources(options.projectPath);

  if (discovered.length === 0) {
    return {
      status: "missing",
      provider: options.provider,
      projectPath: options.projectPath,
      sourceRoot: ".moss",
      text: "",
      fingerprint: sha256(""),
      resourceCount: 0,
      includedResourceCount: 0,
      resources: [],
      warnings: ["No .moss Unified Source was found for this project."],
    };
  }

  const injected: Array<{ resource: DiscoveredMossResource; content: string }> = [];
  const runtimeResources: MossRuntimeContextResource[] = [];

  for (const resource of discovered) {
    const baseResource = {
      resourceId: resource.resourceId,
      kind: resource.kind,
      name: resource.name,
      path: resource.projectRelativePath,
      ...(resource.description !== undefined ? { description: resource.description } : {}),
    };
    try {
      const content = await readResourceText({ resource, maxResourceChars });
      const included = content.content.length > 0;
      runtimeResources.push({
        ...baseResource,
        included,
        contentSha256: content.contentSha256,
        contentChars: content.contentChars,
        truncated: content.truncated,
      });
      if (included) {
        injected.push({ resource, content: content.content });
      }
    } catch (error) {
      runtimeResources.push({
        ...baseResource,
        included: false,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const builtText = buildContextText({
    provider: options.provider,
    sections: injected,
    maxContextChars,
  });
  const fingerprint = sha256(
    JSON.stringify({
      provider: options.provider,
      resources: runtimeResources.map((resource) => ({
        resourceId: resource.resourceId,
        contentSha256: resource.contentSha256,
        included: resource.included,
      })),
      text: builtText.text,
    }),
  );

  return {
    status: "ready",
    provider: options.provider,
    projectPath: options.projectPath,
    sourceRoot: ".moss",
    text: builtText.text,
    fingerprint,
    resourceCount: discovered.length,
    includedResourceCount: runtimeResources.filter((resource) => resource.included).length,
    resources: runtimeResources,
    warnings: builtText.warnings,
  };
}
