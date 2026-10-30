// FILE: frontmatter.ts
// Purpose: YAML frontmatter parser shared by Agent Skill discovery
//          (apps/server skillsCatalog), the resource importer, and the Moss
//          unified-source resource registry.
// Layer: Shared runtime utility (no Effect, no I/O)
// Exports: FrontmatterValue, parseScalarFrontmatter, parseSkillFrontmatter,
//          readStringField, readBooleanField

import YAML from "yaml";

export type FrontmatterValue = string | boolean;

function stripYamlQuotes(value: string): string {
  const trimmed = value.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

function parseYamlScalar(value: string): FrontmatterValue {
  const unquoted = stripYamlQuotes(value);
  const normalized = unquoted.toLowerCase();
  if (normalized === "true") return true;
  if (normalized === "false") return false;
  return unquoted;
}

function readMetadataShortDescription(parsed: object): string | undefined {
  const metadata = (parsed as { metadata?: unknown }).metadata;
  if (typeof metadata !== "object" || metadata === null || Array.isArray(metadata)) {
    return undefined;
  }
  const value = (metadata as Record<string, unknown>)["short-description"];
  return typeof value === "string" ? value.trim() : undefined;
}

function parseLenientFrontmatter(block: string): Record<string, FrontmatterValue> {
  const record: Record<string, FrontmatterValue> = {};
  for (const line of block.split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) {
      continue;
    }
    const separatorIndex = trimmed.indexOf(":");
    if (separatorIndex <= 0) {
      continue;
    }
    const key = trimmed.slice(0, separatorIndex).trim();
    const value = trimmed.slice(separatorIndex + 1).trim();
    if (!key || !value) {
      continue;
    }
    record[key] = parseYamlScalar(value);
  }
  return record;
}

// Reads Agent Skill and Moss source frontmatter as YAML so block scalars
// (`description: >-`) and nested maps parse correctly. Frontmatter that is not
// valid YAML falls back to the historical lenient line reader.
export function parseScalarFrontmatter(markdown: string): Record<string, FrontmatterValue> {
  const normalized = markdown.replace(/\r\n/g, "\n");
  const match = /^---\s*\n([\s\S]*?)\n---\s*(?:\n|$)/.exec(normalized);
  if (!match) {
    return {};
  }
  const block = match[1] ?? "";

  try {
    // Frontmatter may come from untrusted repositories: `uniqueKeys: false` skips
    // the quadratic duplicate-key check, and `logLevel: "error"` avoids warnings
    // from unusual YAML tags reaching process output.
    const parsed: unknown = YAML.parse(block, { uniqueKeys: false, logLevel: "error" });
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }

    const record: Record<string, FrontmatterValue> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!key) {
        continue;
      }
      if (typeof value === "string") {
        record[key] = value.trim();
      } else if (typeof value === "boolean") {
        record[key] = value;
      }
    }
    const shortDescription = readMetadataShortDescription(parsed);
    if (shortDescription !== undefined && record["short-description"] === undefined) {
      record["short-description"] = shortDescription;
    }
    return record;
  } catch {
    return parseLenientFrontmatter(block);
  }
}

/** Historical alias kept for skill-catalog callers; identical behavior. */
export const parseSkillFrontmatter = parseScalarFrontmatter;

export function readStringField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): string | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "string" && value.trim().length > 0) {
      return value.trim();
    }
  }
  return undefined;
}

export function readBooleanField(
  frontmatter: Record<string, FrontmatterValue>,
  keys: ReadonlyArray<string>,
): boolean | undefined {
  for (const key of keys) {
    const value = frontmatter[key];
    if (typeof value === "boolean") {
      return value;
    }
  }
  return undefined;
}

/** Alias for the scalar frontmatter parser — Moss hook discovery (`mossHooks.ts`)
 *  imports this name; identical to {@link parseScalarFrontmatter}. */
export const parseFrontmatterScalars = parseScalarFrontmatter;
