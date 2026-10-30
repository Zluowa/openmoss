/**
 * Moss unified-source resource registry (ported from 1code
 * `moss-source/registry.ts`).
 *
 * Scans the `.moss` tree resolved through {@link getMossSourceLayout} and
 * returns the flat list of shared resources the projection governance layer
 * maps onto provider-native paths. Moss-specific deltas vs 1code:
 *
 * - The workspace config resource points at the canonical `config.json`
 *   under the Moss root (moss's
 *   canonical `MossCanonicalConfig`), not a `source/workspace.yaml`.
 * - Plugins are scanned as one canonical bundle resource and decomposed into
 *   child component IR for the server-owned runtime; child components are not
 *   promoted to independent top-level source kinds.
 * - Frontmatter parsing uses the shared scalar-subset parser
 *   (`@synara/shared/frontmatter`) instead of gray-matter; all Moss starter
 *   entries only use scalar frontmatter.
 */
import { access, lstat, opendir, open, readFile, readdir, realpath, stat } from "node:fs/promises";
import { constants as fsConstants } from "node:fs";
import type { Dirent } from "node:fs";
import { basename, join, relative, resolve, sep } from "node:path";

import { Schema } from "effect";

import { parseScalarFrontmatter, readStringField } from "./frontmatter";
import { readHookTrustStore, computeHookTrustHash, resolveHookTrustState } from "./mossHookTrust";
import type { MossHookTrustStore } from "./mossHookTrust";
import { getMossSourceLayout, toMossProjectPath } from "./mossSourceLayout";

const MAX_PLUGIN_SOURCE_FILES = 1024;
const MAX_PLUGIN_SOURCE_BYTES = 16 * 1024 * 1024;
const MAX_PLUGIN_DIRECTORY_DEPTH = 32;

async function readBoundedPluginFile(
  filePath: string,
  maxBytes = MAX_PLUGIN_SOURCE_BYTES,
): Promise<Buffer> {
  const pathStat = await lstat(filePath);
  if (pathStat.isSymbolicLink()) throw new Error("plugin source may not be a symbolic link");
  if (!pathStat.isFile() || pathStat.size > maxBytes) {
    throw new Error("plugin source exceeds the bounded file limit");
  }
  const handle = await open(filePath, fsConstants.O_RDONLY | (fsConstants.O_NOFOLLOW ?? 0));
  try {
    const fileStat = await handle.stat();
    if (!fileStat.isFile() || fileStat.size > maxBytes) {
      throw new Error("plugin source exceeds the bounded file limit");
    }
    const size = Number(fileStat.size);
    const bytes = Buffer.allocUnsafe(size);
    let offset = 0;
    while (offset < size) {
      const result = await handle.read(bytes, offset, size - offset, offset);
      if (result.bytesRead === 0) break;
      offset += result.bytesRead;
    }
    const afterStat = await handle.stat();
    if (
      afterStat.dev !== fileStat.dev ||
      afterStat.ino !== fileStat.ino ||
      afterStat.size !== fileStat.size ||
      afterStat.mtimeMs !== fileStat.mtimeMs ||
      offset !== size
    ) {
      throw new Error("plugin source changed while it was being read");
    }
    return bytes;
  } finally {
    await handle.close();
  }
}

async function readBoundedPluginText(
  filePath: string,
  maxBytes = MAX_PLUGIN_SOURCE_BYTES,
): Promise<string> {
  const text = new TextDecoder("utf-8", { fatal: true }).decode(
    await readBoundedPluginFile(filePath, maxBytes),
  );
  if (text.includes("\0")) throw new Error("plugin source contains a NUL byte");
  return text;
}

async function readBoundedPluginDirectory(
  directoryPath: string,
  depth = 0,
): Promise<ReadonlyArray<Dirent>> {
  if (depth > MAX_PLUGIN_DIRECTORY_DEPTH) {
    throw new Error("plugin source directory nesting exceeds the safety limit");
  }
  const entries: Dirent[] = [];
  const directory = await opendir(directoryPath);
  try {
    for await (const entry of directory) {
      if (entries.length >= MAX_PLUGIN_SOURCE_FILES) {
        throw new Error("plugin source contains too many directory entries");
      }
      entries.push(entry);
    }
  } finally {
    await directory.close?.()?.catch(() => undefined);
  }
  return entries;
}

export type MossSharedResourceKind =
  | "instruction"
  | "memory"
  | "skill"
  | "mcp"
  | "hook"
  | "subagent"
  | "plugin"
  | "provider";

export interface MossSharedResource {
  readonly id: string;
  readonly kind: MossSharedResourceKind;
  readonly name: string;
  /** Project-relative source path (via {@link toMossProjectPath}). */
  readonly path: string;
  readonly enabled: boolean;
  readonly description?: string | undefined;
  readonly metadata: Record<string, unknown>;
}

/**
 * Plugin bundles are one canonical resource, but their runtime surface is
 * deliberately decomposed into these seven component kinds. Keeping the
 * component union separate from {@link MossSharedResourceKind} prevents a
 * bundled app/asset/permission from being mistaken for a top-level Moss
 * source that can be projected on its own.
 */
export const MOSS_PLUGIN_COMPONENT_KINDS = [
  "skill",
  "mcp",
  "hook",
  "app",
  "subagent",
  "asset",
  "permission",
] as const;
export type MossPluginComponentKind = (typeof MOSS_PLUGIN_COMPONENT_KINDS)[number];

export const MOSS_PLUGIN_MANIFEST_FORMATS = ["formal", "legacy", "missing"] as const;
export type MossPluginManifestFormat = (typeof MOSS_PLUGIN_MANIFEST_FORMATS)[number];

export const MOSS_PLUGIN_INSTALLATION_POLICIES = [
  "NOT_AVAILABLE",
  "AVAILABLE",
  "INSTALLED_BY_DEFAULT",
] as const;
export type MossPluginInstallationPolicy = (typeof MOSS_PLUGIN_INSTALLATION_POLICIES)[number];

export const MOSS_PLUGIN_AUTHENTICATION_POLICIES = ["ON_INSTALL", "ON_USE"] as const;
export type MossPluginAuthenticationPolicy = (typeof MOSS_PLUGIN_AUTHENTICATION_POLICIES)[number];

/**
 * This is intentionally a permissive wire schema. The plugin-creator
 * validator below applies the stricter manifest rules after parsing, while
 * keeping the importer independent from the contracts package.
 */
export const MossPluginManifestSchema = Schema.Struct({
  id: Schema.optional(Schema.String),
  name: Schema.optional(Schema.String),
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  author: Schema.optional(Schema.Unknown),
  homepage: Schema.optional(Schema.String),
  repository: Schema.optional(Schema.Unknown),
  license: Schema.optional(Schema.String),
  keywords: Schema.optional(Schema.Array(Schema.String)),
  skills: Schema.optional(Schema.Unknown),
  hooks: Schema.optional(Schema.Unknown),
  mcpServers: Schema.optional(Schema.Unknown),
  apps: Schema.optional(Schema.Unknown),
  subagents: Schema.optional(Schema.Unknown),
  assets: Schema.optional(Schema.Unknown),
  permissions: Schema.optional(Schema.Unknown),
  interface: Schema.optional(Schema.Unknown),
  defaultPrompt: Schema.optional(Schema.Unknown),
  default_prompt: Schema.optional(Schema.Unknown),
  websiteURL: Schema.optional(Schema.String),
  privacyPolicyURL: Schema.optional(Schema.String),
  termsOfServiceURL: Schema.optional(Schema.String),
  brandColor: Schema.optional(Schema.String),
  composerIcon: Schema.optional(Schema.String),
  logo: Schema.optional(Schema.String),
  logoDark: Schema.optional(Schema.String),
  screenshots: Schema.optional(Schema.Unknown),
  capabilities: Schema.optional(Schema.Array(Schema.String)),
  enabled: Schema.optional(Schema.Boolean),
  policy: Schema.optional(Schema.Unknown),
  marketplacePolicy: Schema.optional(Schema.Unknown),
});

export const MossPluginMarketplacePolicySchema = Schema.Struct({
  installation: Schema.Literals(MOSS_PLUGIN_INSTALLATION_POLICIES),
  authentication: Schema.Literals(MOSS_PLUGIN_AUTHENTICATION_POLICIES),
  category: Schema.String,
  products: Schema.optional(Schema.Array(Schema.String)),
});

export type MossPluginManifest = Readonly<Record<string, unknown>>;
export type MossPluginMarketplacePolicy = typeof MossPluginMarketplacePolicySchema.Type;

export interface MossPluginValidationIssue {
  readonly severity: "error" | "warning";
  readonly code: string;
  readonly message: string;
  readonly path?: string | undefined;
}

export interface MossPluginValidation {
  readonly ok: boolean;
  readonly errors: ReadonlyArray<MossPluginValidationIssue>;
  readonly warnings: ReadonlyArray<MossPluginValidationIssue>;
}

export interface MossPluginComponent {
  readonly id: string;
  readonly kind: MossPluginComponentKind;
  readonly name: string;
  readonly enabled: boolean;
  /** Path declaration from the plugin manifest, never an inferred target. */
  readonly sourcePath?: string | undefined;
  /** Descriptor data consumed by an explicitly registered runtime adapter. */
  readonly metadata: Record<string, unknown>;
}

export interface MossPluginIR {
  readonly id: string;
  readonly name: string;
  readonly version?: string | undefined;
  readonly description?: string | undefined;
  readonly manifestFormat: MossPluginManifestFormat;
  /** Project-relative root for a workspace plugin, or a relative escape for an external import. */
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly absolutePluginRoot: string;
  readonly absoluteManifestPath: string;
  readonly manifest: MossPluginManifest;
  readonly interface: Record<string, unknown> | undefined;
  readonly enabled: boolean;
  readonly components: ReadonlyArray<MossPluginComponent>;
  readonly permissions: ReadonlyArray<MossPluginComponent>;
  readonly marketplacePolicy: MossPluginMarketplacePolicy;
  readonly validation: MossPluginValidation;
}

export const MossPluginComponentSchema = Schema.Struct({
  id: Schema.String,
  kind: Schema.Literals(MOSS_PLUGIN_COMPONENT_KINDS),
  name: Schema.String,
  enabled: Schema.Boolean,
  sourcePath: Schema.optional(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
});

export const MossPluginValidationIssueSchema = Schema.Struct({
  severity: Schema.Literals(["error", "warning"]),
  code: Schema.String,
  message: Schema.String,
  path: Schema.optional(Schema.String),
});

export const MossPluginValidationSchema = Schema.Struct({
  ok: Schema.Boolean,
  errors: Schema.Array(MossPluginValidationIssueSchema),
  warnings: Schema.Array(MossPluginValidationIssueSchema),
});

/** Stable IR schema for importers; provider execution remains server-owned. */
export const MossPluginIRSchema = Schema.Struct({
  id: Schema.String,
  name: Schema.String,
  version: Schema.optional(Schema.String),
  description: Schema.optional(Schema.String),
  manifestFormat: Schema.Literals(MOSS_PLUGIN_MANIFEST_FORMATS),
  pluginRoot: Schema.String,
  manifestPath: Schema.String,
  absolutePluginRoot: Schema.String,
  absoluteManifestPath: Schema.String,
  manifest: Schema.Record(Schema.String, Schema.Unknown),
  interface: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  enabled: Schema.Boolean,
  components: Schema.Array(MossPluginComponentSchema),
  permissions: Schema.Array(MossPluginComponentSchema),
  marketplacePolicy: MossPluginMarketplacePolicySchema,
  validation: MossPluginValidationSchema,
});

interface PluginRecord {
  readonly [key: string]: unknown;
}

function isPluginRecord(value: unknown): value is PluginRecord {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function pluginString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim().length > 0 ? value.trim() : undefined;
}

function pluginStringArray(value: unknown): string[] {
  return Array.isArray(value)
    ? value.flatMap((entry) => {
        const result = pluginString(entry);
        return result ? [result] : [];
      })
    : [];
}

const FORMAL_PLUGIN_MANIFEST_KEYS = new Set([
  "id",
  "name",
  "version",
  "description",
  "skills",
  "apps",
  "mcpServers",
  "interface",
  "author",
  "homepage",
  "repository",
  "license",
  "keywords",
]);

const FORMAL_PLUGIN_INTERFACE_KEYS = new Set([
  "displayName",
  "shortDescription",
  "longDescription",
  "developerName",
  "category",
  "capabilities",
  "websiteURL",
  "privacyPolicyURL",
  "termsOfServiceURL",
  "brandColor",
  "composerIcon",
  "logo",
  "logoDark",
  "screenshots",
  "defaultPrompt",
  "default_prompt",
]);

const FORMAL_PLUGIN_AUTHOR_KEYS = new Set(["name", "email", "url"]);

function pushUnsupportedFieldIssues(
  issues: MossPluginValidationIssue[],
  record: PluginRecord,
  allowedKeys: ReadonlySet<string>,
  prefix: string,
): void {
  for (const key of Object.keys(record).toSorted()) {
    if (allowedKeys.has(key)) continue;
    issues.push(
      issue(
        "error",
        "manifest-unsupported-field",
        key === "hooks"
          ? "plugin-creator rejects hooks in plugin.json; keep hooks out of the formal manifest."
          : `${prefix}.${key} is not accepted by plugin-creator validation.`,
        `${prefix}.${key}`,
      ),
    );
  }
}

function isHttpsUrl(value: unknown): boolean {
  if (typeof value !== "string" || value.trim().length === 0) return false;
  try {
    const parsed = new URL(value);
    return parsed.protocol === "https:" && parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

function isHexColor(value: unknown): boolean {
  return typeof value === "string" && /^#[0-9A-F]{6}$/i.test(value);
}

function normalizedFormalPath(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined;
  const trimmed = value.trim();
  if (!isPluginRelativePath(trimmed)) return undefined;
  return trimmed.slice(2).replace(/[\\/]$/, "");
}

function issue(
  severity: MossPluginValidationIssue["severity"],
  code: string,
  message: string,
  path?: string,
): MossPluginValidationIssue {
  return { severity, code, message, ...(path ? { path } : {}) };
}

function validationFromIssues(
  issues: ReadonlyArray<MossPluginValidationIssue>,
): MossPluginValidation {
  return {
    ok: issues.every((entry) => entry.severity !== "error"),
    errors: issues.filter((entry) => entry.severity === "error"),
    warnings: issues.filter((entry) => entry.severity === "warning"),
  };
}

function mergeValidation(
  ...validations: ReadonlyArray<MossPluginValidation>
): MossPluginValidation {
  return validationFromIssues(
    validations.flatMap((validation) => [...validation.errors, ...validation.warnings]),
  );
}

/** Strict semver check matching the plugin-creator manifest requirement. */
export function isStrictMossPluginSemver(value: string): boolean {
  return /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?(?:\+[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/.test(
    value,
  );
}

function isPluginRelativePath(value: string): boolean {
  if (!value.startsWith("./") || value.includes("\0")) return false;
  return value.split(/[\\/]/).every((part) => part !== "..");
}

/**
 * Component names are later used as provider target path segments and as MCP
 * identifiers. Keep this check stricter than generic relative-path validation:
 * a component may never smuggle a separator, dot segment, drive prefix, or
 * normalization escape into a provider-owned target.
 */
export function isSafeMossPluginComponentName(name: string): boolean {
  return (
    name.length > 0 &&
    name.length <= 128 &&
    name === name.trim() &&
    name !== "." &&
    name !== ".." &&
    !name.includes("\0") &&
    !name.includes("..") &&
    !name.includes("/") &&
    !name.includes("\\") &&
    !name.includes(":") &&
    !name.startsWith("~")
  );
}

function hasTodoPlaceholder(value: unknown): boolean {
  if (typeof value === "string") return value.includes("[TODO:");
  if (Array.isArray(value)) return value.some((entry) => hasTodoPlaceholder(entry));
  if (isPluginRecord(value)) return Object.values(value).some((entry) => hasTodoPlaceholder(entry));
  return false;
}

function pluginInterface(manifest: PluginRecord): PluginRecord | undefined {
  return isPluginRecord(manifest.interface) ? manifest.interface : undefined;
}

function pathDeclarations(value: unknown): Array<{ value: string; path: string }> {
  if (typeof value === "string") return [{ value: value.trim(), path: "" }];
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry, index) => {
    if (typeof entry === "string") return [{ value: entry.trim(), path: String(index) }];
    if (!isPluginRecord(entry)) return [];
    const declared = pluginString(entry.path) ?? pluginString(entry.source);
    return declared ? [{ value: declared, path: String(index) }] : [];
  });
}

/**
 * Validate a manifest against the plugin-creator rules while retaining legacy
 * `.moss/plugins/{plugin}/plugin.json` compatibility. Legacy omissions are warnings;
 * formal `.codex-plugin/plugin.json` omissions or unsupported fields are
 * errors and therefore cannot be executed by the runtime.
 */
export function validateMossPluginManifest(
  rawManifest: unknown,
  options: {
    readonly format?: MossPluginManifestFormat;
    readonly expectedName?: string | undefined;
  } = {},
): MossPluginValidation {
  const format = options.format ?? "legacy";
  const issues: MossPluginValidationIssue[] = [];
  if (!isPluginRecord(rawManifest)) {
    return validationFromIssues([
      issue("error", "manifest-not-object", "plugin.json must contain a JSON object."),
    ]);
  }

  const formal = format === "formal";
  const required = (condition: boolean, code: string, message: string, path: string): void => {
    if (condition) return;
    issues.push(issue(formal ? "error" : "warning", code, message, path));
  };
  if (formal) {
    pushUnsupportedFieldIssues(issues, rawManifest, FORMAL_PLUGIN_MANIFEST_KEYS, "plugin.json");
  }
  if (Object.prototype.hasOwnProperty.call(rawManifest, "id") && !pluginString(rawManifest.id)) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-id-invalid",
        "Plugin id must be a non-empty string when provided.",
        "id",
      ),
    );
  }
  const name = pluginString(rawManifest.name);
  required(Boolean(name), "manifest-name-missing", "Plugin manifest must define name.", "name");
  if (name && options.expectedName && name !== options.expectedName) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-name-mismatch",
        "Plugin manifest name must match its plugin directory name.",
        "name",
      ),
    );
  }
  if (name && (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-name-invalid",
        "Plugin name must be lower-case hyphen-case and no longer than 64 characters.",
        "name",
      ),
    );
  }

  const version = pluginString(rawManifest.version);
  required(
    Boolean(version),
    "manifest-version-missing",
    "Plugin manifest must define version.",
    "version",
  );
  if (version && !isStrictMossPluginSemver(version)) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-version-invalid",
        "Plugin version must be strict semver.",
        "version",
      ),
    );
  }
  required(
    Boolean(pluginString(rawManifest.description)),
    "manifest-description-missing",
    "Plugin manifest must define description.",
    "description",
  );

  const author = isPluginRecord(rawManifest.author) ? rawManifest.author : undefined;
  if (rawManifest.author !== undefined && !author) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-author-invalid",
        "Plugin author must be an object.",
        "author",
      ),
    );
  }
  if (formal && author) {
    pushUnsupportedFieldIssues(issues, author, FORMAL_PLUGIN_AUTHOR_KEYS, "author");
  }
  required(
    Boolean(pluginString(author?.name)),
    "manifest-author-missing",
    "Plugin manifest must define author.name.",
    "author.name",
  );
  for (const field of ["email"] as const) {
    if (author?.[field] !== undefined && !pluginString(author[field])) {
      issues.push(
        issue(
          formal ? "error" : "warning",
          "manifest-author-field-invalid",
          `Plugin author.${field} must be a non-empty string when provided.`,
          `author.${field}`,
        ),
      );
    }
  }
  if (author?.url !== undefined && !isHttpsUrl(author.url)) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-author-url-invalid",
        "Plugin author.url must be an absolute https:// URL.",
        "author.url",
      ),
    );
  }

  for (const field of ["homepage", "repository", "license"] as const) {
    if (
      Object.prototype.hasOwnProperty.call(rawManifest, field) &&
      !pluginString(rawManifest[field])
    ) {
      issues.push(
        issue(
          formal ? "error" : "warning",
          "manifest-field-invalid",
          `Plugin ${field} must be a non-empty string when provided.`,
          field,
        ),
      );
    }
  }
  if (Object.prototype.hasOwnProperty.call(rawManifest, "keywords")) {
    const keywords = rawManifest.keywords;
    if (!Array.isArray(keywords) || keywords.some((entry) => !pluginString(entry))) {
      issues.push(
        issue(
          formal ? "error" : "warning",
          "manifest-keywords-invalid",
          "Plugin keywords must be an array of non-empty strings.",
          "keywords",
        ),
      );
    }
  }

  const iface = pluginInterface(rawManifest);
  for (const field of [
    "displayName",
    "shortDescription",
    "longDescription",
    "developerName",
    "category",
  ]) {
    required(
      Boolean(pluginString(iface?.[field])),
      "manifest-interface-field-missing",
      `Plugin interface must define ${field}.`,
      `interface.${field}`,
    );
  }
  if (rawManifest.interface !== undefined && !iface) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-interface-invalid",
        "Plugin interface must be an object.",
        "interface",
      ),
    );
  }
  if (formal && iface) {
    pushUnsupportedFieldIssues(issues, iface, FORMAL_PLUGIN_INTERFACE_KEYS, "interface");
  }

  const capabilities = iface?.capabilities;
  required(
    Array.isArray(capabilities) && capabilities.every((entry) => Boolean(pluginString(entry))),
    "manifest-interface-capabilities-invalid",
    "Plugin interface capabilities must be an array of non-empty strings.",
    "interface.capabilities",
  );

  const prompts = iface?.defaultPrompt ?? iface?.default_prompt ?? rawManifest.defaultPrompt;
  required(
    Array.isArray(prompts),
    "manifest-default-prompt-missing",
    "Plugin interface must define defaultPrompt as an array.",
    "interface.defaultPrompt",
  );

  if (format === "missing") {
    issues.push(issue("error", "manifest-missing", "Plugin directory has no plugin manifest."));
  }
  if (hasTodoPlaceholder(rawManifest)) {
    issues.push(
      issue(
        "error",
        "manifest-todo-placeholder",
        "Plugin manifest contains a [TODO: ...] placeholder.",
      ),
    );
  }

  if (formal) {
    if (rawManifest.skills !== undefined && normalizedFormalPath(rawManifest.skills) !== "skills") {
      issues.push(
        issue(
          "error",
          "manifest-skills-path-invalid",
          "Plugin skills must use the ./skills directory.",
          "skills",
        ),
      );
    }
    if (rawManifest.apps !== undefined && normalizedFormalPath(rawManifest.apps) !== ".app.json") {
      issues.push(
        issue(
          "error",
          "manifest-apps-path-invalid",
          "Plugin apps must use the ./.app.json companion file.",
          "apps",
        ),
      );
    }
    if (
      typeof rawManifest.mcpServers === "string" &&
      normalizedFormalPath(rawManifest.mcpServers) !== ".mcp.json"
    ) {
      issues.push(
        issue(
          "error",
          "manifest-mcp-path-invalid",
          "Plugin mcpServers must use the ./.mcp.json companion file or an inline object.",
          "mcpServers",
        ),
      );
    } else if (
      rawManifest.mcpServers !== undefined &&
      typeof rawManifest.mcpServers !== "string" &&
      !isPluginRecord(rawManifest.mcpServers)
    ) {
      issues.push(
        issue(
          "error",
          "manifest-mcp-invalid",
          "Plugin mcpServers must be a ./.mcp.json path or an object.",
          "mcpServers",
        ),
      );
    }
  } else {
    for (const [field, value] of [
      ["skills", rawManifest.skills],
      ["mcpServers", rawManifest.mcpServers],
      ["apps", rawManifest.apps],
      ["subagents", rawManifest.subagents],
      ["assets", rawManifest.assets],
      ["permissions", rawManifest.permissions],
    ] as const) {
      for (const declaration of pathDeclarations(value)) {
        if (declaration.value && !isPluginRelativePath(declaration.value)) {
          issues.push(
            issue(
              "warning",
              "manifest-path-invalid",
              "Plugin component paths should be relative to the plugin root and begin with ./.",
              `${field}${declaration.path ? `.${declaration.path}` : ""}`,
            ),
          );
        }
      }
    }
  }

  const assetFields = ["composerIcon", "logo", "logoDark", "screenshots"] as const;
  for (const field of assetFields) {
    const value = iface?.[field];
    const declarations = pathDeclarations(value);
    if (formal && value !== undefined && field !== "screenshots" && typeof value !== "string") {
      issues.push(
        issue(
          "error",
          "manifest-asset-invalid",
          `Plugin interface.${field} must be a relative asset path.`,
          `interface.${field}`,
        ),
      );
    }
    if (formal && field === "screenshots" && value !== undefined && !Array.isArray(value)) {
      issues.push(
        issue(
          "error",
          "manifest-screenshots-invalid",
          "Plugin interface.screenshots must be an array of relative asset paths.",
          "interface.screenshots",
        ),
      );
    }
    for (const declaration of declarations) {
      if (declaration.value && !isPluginRelativePath(declaration.value)) {
        issues.push(
          issue(
            formal ? "error" : "warning",
            "manifest-asset-path-invalid",
            "Plugin assets must be relative paths inside the plugin root.",
            `interface.${field}`,
          ),
        );
      }
      if (
        field === "screenshots" &&
        declaration.value &&
        !declaration.value.startsWith("./assets/")
      ) {
        issues.push(
          issue(
            formal ? "error" : "warning",
            "manifest-screenshot-path-invalid",
            "Plugin screenshots must be PNG files under ./assets/.",
            `interface.${field}`,
          ),
        );
      }
      if (
        field === "screenshots" &&
        declaration.value &&
        !declaration.value.toLowerCase().endsWith(".png")
      ) {
        issues.push(
          issue(
            formal ? "error" : "warning",
            "manifest-screenshot-extension-invalid",
            "Plugin screenshots must use the PNG extension.",
            `interface.${field}`,
          ),
        );
      }
    }
  }

  for (const [field, value] of [
    ["websiteURL", iface?.websiteURL ?? rawManifest.websiteURL],
    ["privacyPolicyURL", iface?.privacyPolicyURL ?? rawManifest.privacyPolicyURL],
    ["termsOfServiceURL", iface?.termsOfServiceURL ?? rawManifest.termsOfServiceURL],
  ] as const) {
    if (value !== undefined && !isHttpsUrl(value)) {
      issues.push(
        issue(
          formal ? "error" : "warning",
          "manifest-url-invalid",
          "Plugin website and policy URLs must be absolute https:// URLs.",
          field,
        ),
      );
    }
  }

  if (Array.isArray(prompts)) {
    if (prompts.length > 3) {
      issues.push(
        issue(
          formal ? "error" : "warning",
          "manifest-default-prompt-too-many",
          "Plugin defaultPrompt may contain at most three entries.",
          "interface.defaultPrompt",
        ),
      );
    }
    prompts.forEach((prompt, index) => {
      if (typeof prompt !== "string" || prompt.length > 128) {
        issues.push(
          issue(
            formal ? "error" : "warning",
            "manifest-default-prompt-invalid",
            "Each plugin defaultPrompt entry must be a string of at most 128 characters.",
            `interface.defaultPrompt.${index}`,
          ),
        );
      }
    });
  } else if (prompts !== undefined) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-default-prompt-invalid",
        "Plugin defaultPrompt must be an array.",
        "interface.defaultPrompt",
      ),
    );
  }

  if (isPluginRecord(rawManifest.mcpServers)) {
    validateInlineMcpServers(rawManifest.mcpServers, issues, "mcpServers");
  }

  const brandColor = iface?.brandColor;
  if (brandColor !== undefined && !isHexColor(brandColor)) {
    issues.push(
      issue(
        formal ? "error" : "warning",
        "manifest-brand-color-invalid",
        "Plugin interface.brandColor must use #RRGGBB.",
        "interface.brandColor",
      ),
    );
  }

  return validationFromIssues(issues);
}

/** Validate a plugin-creator marketplace entry, including all required policy fields. */
export function validateMossPluginMarketplaceEntry(
  rawEntry: unknown,
  expectedName?: string,
): MossPluginValidation {
  const issues: MossPluginValidationIssue[] = [];
  if (!isPluginRecord(rawEntry)) {
    return validationFromIssues([
      issue("error", "marketplace-entry-not-object", "Marketplace plugin entry must be an object."),
    ]);
  }
  const name = pluginString(rawEntry.name);
  if (!name)
    issues.push(
      issue("error", "marketplace-name-missing", "Marketplace entry must define name.", "name"),
    );
  if (name && (name.length > 64 || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(name))) {
    issues.push(
      issue(
        "error",
        "marketplace-name-invalid",
        "Marketplace plugin name must be lower-case hyphen-case and no longer than 64 characters.",
        "name",
      ),
    );
  }
  if (expectedName && name && name !== expectedName) {
    issues.push(
      issue(
        "error",
        "marketplace-name-mismatch",
        "Marketplace entry name must match plugin name.",
        "name",
      ),
    );
  }
  const source = isPluginRecord(rawEntry.source) ? rawEntry.source : undefined;
  const sourcePath = pluginString(source?.path);
  if (source?.source !== "local" || !isPluginRelativePath(sourcePath ?? "")) {
    issues.push(
      issue(
        "error",
        "marketplace-source-invalid",
        "Marketplace source must be local with a ./ relative path.",
        "source",
      ),
    );
  } else if (name && sourcePath !== `./plugins/${name}`) {
    issues.push(
      issue(
        "error",
        "marketplace-source-path-mismatch",
        "Marketplace source.path must be ./plugins/<plugin-name>.",
        "source.path",
      ),
    );
  }
  const policy = isPluginRecord(rawEntry.policy) ? rawEntry.policy : undefined;
  if (!policy) {
    issues.push(
      issue(
        "error",
        "marketplace-policy-missing",
        "Marketplace entry must include policy.",
        "policy",
      ),
    );
  } else {
    if (
      !MOSS_PLUGIN_INSTALLATION_POLICIES.includes(
        policy.installation as MossPluginInstallationPolicy,
      )
    ) {
      issues.push(
        issue(
          "error",
          "marketplace-installation-invalid",
          "Marketplace installation policy is invalid.",
          "policy.installation",
        ),
      );
    }
    if (
      !MOSS_PLUGIN_AUTHENTICATION_POLICIES.includes(
        policy.authentication as MossPluginAuthenticationPolicy,
      )
    ) {
      issues.push(
        issue(
          "error",
          "marketplace-authentication-invalid",
          "Marketplace authentication policy is invalid.",
          "policy.authentication",
        ),
      );
    }
    if (
      policy.products !== undefined &&
      (!Array.isArray(policy.products) || policy.products.some((product) => !pluginString(product)))
    ) {
      issues.push(
        issue(
          "error",
          "marketplace-products-invalid",
          "Marketplace policy.products must be an array of non-empty strings when provided.",
          "policy.products",
        ),
      );
    }
  }
  if (!pluginString(rawEntry.category)) {
    issues.push(
      issue(
        "error",
        "marketplace-category-missing",
        "Marketplace entry must include category.",
        "category",
      ),
    );
  }
  return validationFromIssues(issues);
}

/** Validate a complete plugin-creator marketplace document without installing it. */
export function validateMossPluginMarketplace(rawMarketplace: unknown): MossPluginValidation {
  const issues: MossPluginValidationIssue[] = [];
  if (!isPluginRecord(rawMarketplace)) {
    return validationFromIssues([
      issue("error", "marketplace-not-object", "marketplace.json must contain an object."),
    ]);
  }
  if (!pluginString(rawMarketplace.name)) {
    issues.push(
      issue("error", "marketplace-name-missing", "Marketplace must define name.", "name"),
    );
  }
  const iface = isPluginRecord(rawMarketplace.interface) ? rawMarketplace.interface : undefined;
  if (rawMarketplace.interface !== undefined && !iface) {
    issues.push(
      issue(
        "error",
        "marketplace-interface-invalid",
        "Marketplace interface must be an object when provided.",
        "interface",
      ),
    );
  } else if (iface?.displayName !== undefined && !pluginString(iface.displayName)) {
    issues.push(
      issue(
        "error",
        "marketplace-display-name-invalid",
        "Marketplace interface.displayName must be a non-empty string when provided.",
        "interface.displayName",
      ),
    );
  }
  if (!Array.isArray(rawMarketplace.plugins)) {
    issues.push(
      issue(
        "error",
        "marketplace-plugins-missing",
        "Marketplace must contain plugins[].",
        "plugins",
      ),
    );
  } else {
    const names = new Set<string>();
    for (const entry of rawMarketplace.plugins) {
      const validation = validateMossPluginMarketplaceEntry(entry);
      issues.push(...validation.errors, ...validation.warnings);
      const name = isPluginRecord(entry) ? pluginString(entry.name) : undefined;
      if (name && names.has(name)) {
        issues.push(
          issue(
            "error",
            "marketplace-duplicate-plugin",
            `Marketplace contains duplicate plugin entry ${name}.`,
            "plugins",
          ),
        );
      }
      if (name) names.add(name);
    }
  }
  return validationFromIssues(issues);
}

function resolveMossPluginMarketplacePolicy(input: {
  readonly manifest: PluginRecord;
  readonly format: MossPluginManifestFormat;
  readonly marketplaceEntry?: unknown;
}): { readonly policy: MossPluginMarketplacePolicy; readonly validation: MossPluginValidation } {
  const issues: MossPluginValidationIssue[] = [];
  const iface = pluginInterface(input.manifest);
  const fallbackCategory =
    pluginString(iface?.category) ?? (input.format === "formal" ? "Productivity" : "Moss");
  const entry = isPluginRecord(input.marketplaceEntry) ? input.marketplaceEntry : undefined;
  if (entry) {
    const entryValidation = validateMossPluginMarketplaceEntry(
      entry,
      pluginString(input.manifest.name),
    );
    issues.push(...entryValidation.errors, ...entryValidation.warnings);
  } else {
    issues.push(
      issue(
        "warning",
        "marketplace-policy-defaulted",
        "No marketplace entry was supplied; using the plugin-creator default policy for this source.",
      ),
    );
  }
  const rawPolicy =
    entry && isPluginRecord(entry.policy)
      ? entry.policy
      : isPluginRecord(input.manifest.policy)
        ? input.manifest.policy
        : isPluginRecord(input.manifest.marketplacePolicy)
          ? input.manifest.marketplacePolicy
          : input.manifest;
  const installation = MOSS_PLUGIN_INSTALLATION_POLICIES.includes(
    rawPolicy.installation as MossPluginInstallationPolicy,
  )
    ? (rawPolicy.installation as MossPluginInstallationPolicy)
    : input.format === "formal"
      ? "AVAILABLE"
      : "INSTALLED_BY_DEFAULT";
  const authentication = MOSS_PLUGIN_AUTHENTICATION_POLICIES.includes(
    (rawPolicy.authentication ?? rawPolicy.authPolicy) as MossPluginAuthenticationPolicy,
  )
    ? ((rawPolicy.authentication ?? rawPolicy.authPolicy) as MossPluginAuthenticationPolicy)
    : input.format === "formal"
      ? "ON_INSTALL"
      : "ON_USE";
  const category =
    pluginString(entry?.category) ?? pluginString(rawPolicy.category) ?? fallbackCategory;
  if (entry && !pluginString(entry.category)) {
    // The validator records this as an error; this warning keeps the normalized
    // IR useful for inspection without making a missing category executable.
    issues.push(
      issue(
        "warning",
        "marketplace-category-defaulted",
        "Marketplace category fell back to the manifest interface category.",
        "category",
      ),
    );
  }
  return {
    policy: {
      installation,
      authentication,
      category,
      ...(Array.isArray(rawPolicy.products)
        ? { products: pluginStringArray(rawPolicy.products) }
        : {}),
    },
    validation: validationFromIssues(issues),
  };
}

function componentName(value: unknown, fallback: string): string {
  if (isPluginRecord(value)) {
    return pluginString(value.name) ?? pluginString(value.id) ?? fallback;
  }
  if (typeof value === "string") {
    const trimmed = value.replace(/^\.\//, "").replace(/[\\/]$/, "");
    const leaf = trimmed.split(/[\\/]/).at(-1) ?? trimmed;
    return leaf.replace(/\.(json|md)$/i, "") || fallback;
  }
  return fallback;
}

function componentSourcePath(value: unknown): string | undefined {
  if (typeof value === "string")
    return isPluginRelativePath(value.trim()) ? value.trim() : undefined;
  if (isPluginRecord(value)) {
    const declared =
      pluginString(value.path) ?? pluginString(value.source) ?? pluginString(value.root);
    return declared && isPluginRelativePath(declared) ? declared : undefined;
  }
  return undefined;
}

function hasUnsafeComponentPath(value: unknown): boolean {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.startsWith("/") || trimmed.startsWith("~") || trimmed.includes("\0");
  }
  if (!isPluginRecord(value)) return false;
  const declared =
    pluginString(value.path) ?? pluginString(value.source) ?? pluginString(value.root);
  return declared !== undefined && !isPluginRelativePath(declared);
}

function makePluginComponent(
  kind: MossPluginComponentKind,
  value: unknown,
  fallbackName: string,
  index: number,
): MossPluginComponent {
  const name = componentName(value, `${kind}-${index + 1}`);
  const descriptor = isPluginRecord(value) ? value : undefined;
  const sourcePath = componentSourcePath(value);
  const unsafePath = hasUnsafeComponentPath(value);
  const unsafeName = !isSafeMossPluginComponentName(name);
  const disabledByNestedGate = descriptor !== undefined && pluginRecordQuarantined(descriptor);
  const disabledByNestedEnabled = descriptor !== undefined && !pluginRecordEnabled(descriptor);
  return {
    id: `plugin:${kind}:${name}`,
    kind,
    name,
    enabled:
      descriptor?.enabled !== false &&
      !disabledByNestedGate &&
      !disabledByNestedEnabled &&
      !unsafePath &&
      !unsafeName,
    ...(sourcePath ? { sourcePath } : {}),
    metadata: {
      ...(descriptor ? { definition: descriptor } : {}),
      ...(typeof value === "string" ? { declaration: value } : {}),
      ...(fallbackName ? { field: fallbackName } : {}),
      ...(unsafePath
        ? { disabledReason: "Component path is outside the plugin root or is not safely relative." }
        : {}),
      ...(unsafeName ? { disabledReason: "Component name must be one safe path segment." } : {}),
    },
  };
}

function pluginRecordQuarantined(value: unknown): boolean {
  if (!isPluginRecord(value)) return false;
  if (
    value.quarantine === true ||
    value.quarantined === true ||
    value.quarantine === "quarantined"
  ) {
    return true;
  }
  return pluginRecordQuarantined(value.definition);
}

function pluginRecordEnabled(value: unknown): boolean {
  if (!isPluginRecord(value)) return true;
  if (value.enabled === false) return false;
  return pluginRecordEnabled(value.definition);
}

function componentNameValidationIssues(
  components: ReadonlyArray<MossPluginComponent>,
): ReadonlyArray<MossPluginValidationIssue> {
  return components.flatMap((component) =>
    isSafeMossPluginComponentName(component.name)
      ? []
      : [
          issue(
            "error",
            "manifest-component-name-unsafe",
            `Plugin ${component.kind} name must be one safe path segment: ${component.name}.`,
            component.name,
          ),
        ],
  );
}

function componentsForField(
  kind: MossPluginComponentKind,
  fieldName: string,
  value: unknown,
): MossPluginComponent[] {
  if (value === undefined || value === null) return [];
  if (kind === "permission" && isPluginRecord(value)) {
    return [makePluginComponent(kind, { name: fieldName, definition: value }, fieldName, 0)];
  }
  if (isPluginRecord(value) && (kind === "mcp" || kind === "hook" || kind === "app")) {
    return Object.entries(value).map(([name, definition], index) =>
      makePluginComponent(kind, { name, definition }, fieldName, index),
    );
  }
  if (Array.isArray(value)) {
    return value.map((entry, index) => makePluginComponent(kind, entry, fieldName, index));
  }
  return [makePluginComponent(kind, value, fieldName, 0)];
}

export function decomposeMossPluginManifest(
  manifest: MossPluginManifest,
): ReadonlyArray<MossPluginComponent> {
  const components: MossPluginComponent[] = [];
  for (const [fieldName, kind] of [
    ["skills", "skill"],
    ["mcpServers", "mcp"],
    ["hooks", "hook"],
    ["apps", "app"],
    ["subagents", "subagent"],
    ["assets", "asset"],
    ["permissions", "permission"],
  ] as const) {
    components.push(...componentsForField(kind, fieldName, manifest[fieldName]));
  }
  const iface = pluginInterface(manifest);
  for (const field of ["composerIcon", "logo", "logoDark", "screenshots"] as const) {
    const values = field === "screenshots" ? iface?.[field] : iface?.[field];
    for (const [index, value] of (Array.isArray(values)
      ? values
      : values === undefined
        ? []
        : [values]
    ).entries()) {
      components.push(makePluginComponent("asset", value, `interface.${field}`, index));
    }
  }
  const unique = new Map<string, MossPluginComponent>();
  for (const component of components) {
    const key = `${component.kind}:${component.name}:${component.sourcePath ?? ""}`;
    if (!unique.has(key)) unique.set(key, component);
  }
  return [...unique.values()];
}

function addMissingPathIssues(
  issues: MossPluginValidationIssue[],
  pluginRoot: string,
  format: MossPluginManifestFormat,
  components: ReadonlyArray<MossPluginComponent>,
): Promise<void> {
  return (async () => {
    for (const component of components) {
      if (!component.sourcePath) continue;
      const absolutePath = resolve(pluginRoot, component.sourcePath.slice(2));
      if (await pathExists(absolutePath)) {
        if (await pathWithinPluginRoot(pluginRoot, absolutePath)) continue;
        issues.push(
          issue(
            format === "formal" ? "error" : "warning",
            "manifest-component-path-unsafe",
            `Plugin ${component.kind} source path resolves outside the plugin root: ${component.sourcePath}.`,
            component.sourcePath,
          ),
        );
        continue;
      }
      issues.push(
        issue(
          format === "formal" ? "error" : "warning",
          "manifest-component-path-missing",
          `Plugin ${component.kind} source path does not exist: ${component.sourcePath}.`,
          component.sourcePath,
        ),
      );
    }
  })();
}

function addFormalIssue(
  issues: MossPluginValidationIssue[],
  code: string,
  message: string,
  path: string,
): void {
  issues.push(issue("error", code, message, path));
}

function validateInlineMcpServers(
  value: unknown,
  issues: MossPluginValidationIssue[],
  path: string,
): void {
  if (!isPluginRecord(value)) {
    addFormalIssue(
      issues,
      "manifest-mcp-companion-invalid",
      "MCP servers must be an object.",
      path,
    );
    return;
  }
  for (const [name, definition] of Object.entries(value)) {
    if (!isPluginRecord(definition)) {
      addFormalIssue(
        issues,
        "manifest-mcp-server-invalid",
        `MCP server ${name} must be an object.`,
        `${path}.${name}`,
      );
      continue;
    }
    validateMcpSecretReferences(definition, issues, `${path}.${name}`);
  }
}

const SENSITIVE_MCP_KEY =
  /(?:secret|token|password|passwd|api[-_]?key|authorization|private[-_]?key|client[-_]?secret)/i;
const SECRET_REFERENCE = /^(?:\$\{)?(?:MOSS_SECRET_[A-Z0-9_]+|env:[A-Z][A-Z0-9_]*)(?:\})?$/;
const ENV_IDENTITY = /^[A-Z][A-Z0-9_]*$/;

function isMossSecretReference(value: string): boolean {
  return SECRET_REFERENCE.test(value);
}

function validateMcpSecretReferences(
  value: unknown,
  issues: MossPluginValidationIssue[],
  path: string,
): void {
  if (!isPluginRecord(value)) {
    if (Array.isArray(value)) {
      value.forEach((entry, index) =>
        validateMcpSecretReferences(entry, issues, `${path}.${index}`),
      );
    }
    return;
  }
  for (const [key, entry] of Object.entries(value)) {
    const entryPath = `${path}.${key}`;
    if (key === "url" && typeof entry === "string") {
      try {
        const parsed = new URL(entry);
        const credentialParameter = [...parsed.searchParams.entries()].find(
          ([name, value]) => SENSITIVE_MCP_KEY.test(name) && !isMossSecretReference(value),
        )?.[0];
        if (credentialParameter) {
          addFormalIssue(
            issues,
            "manifest-inline-secret",
            `${entryPath} must not contain inline credential query parameter ${credentialParameter}.`,
            entryPath,
          );
        }
      } catch {
        // URL shape validation is handled by the provider projection boundary.
      }
    }
    if (key === "bearer_token_env_var") {
      if (typeof entry !== "string" || !ENV_IDENTITY.test(entry)) {
        addFormalIssue(
          issues,
          "manifest-secret-reference-invalid",
          "bearer_token_env_var must be an environment variable name, never a secret value.",
          entryPath,
        );
      }
      continue;
    } else if (key === "env_http_headers") {
      if (!isPluginRecord(entry)) {
        addFormalIssue(
          issues,
          "manifest-secret-reference-invalid",
          "env_http_headers must map header names to environment variable names.",
          entryPath,
        );
      } else {
        for (const [header, envName] of Object.entries(entry)) {
          if (typeof envName !== "string" || !ENV_IDENTITY.test(envName)) {
            addFormalIssue(
              issues,
              "manifest-secret-reference-invalid",
              "env_http_headers values must be environment variable names.",
              `${entryPath}.${header}`,
            );
          }
        }
      }
      continue;
    } else if (SENSITIVE_MCP_KEY.test(key)) {
      if (typeof entry !== "string" || !isMossSecretReference(entry)) {
        addFormalIssue(
          issues,
          "manifest-inline-secret",
          `${entryPath} must use a Moss secret reference or environment identity, not an inline secret.`,
          entryPath,
        );
      }
    }
    validateMcpSecretReferences(entry, issues, entryPath);
  }
}

async function readPluginJsonIfPresent(filePath: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readBoundedPluginText(filePath)) as unknown;
  } catch {
    return undefined;
  }
}

async function validateFormalPluginFiles(
  pluginRoot: string,
  manifest: PluginRecord,
): Promise<ReadonlyArray<MossPluginValidationIssue>> {
  const issues: MossPluginValidationIssue[] = [];
  if (isPluginRecord(manifest.mcpServers)) {
    validateInlineMcpServers(manifest.mcpServers, issues, "mcpServers");
  }
  if (typeof manifest.mcpServers === "string") {
    const companionPath = join(pluginRoot, ".mcp.json");
    const companionSafe = await pathWithinPluginRoot(pluginRoot, companionPath);
    if (!companionSafe) {
      addFormalIssue(
        issues,
        "manifest-mcp-companion-unsafe",
        ".mcp.json must not resolve through a symbolic link or outside the plugin root.",
        "mcpServers",
      );
    }
    const companion = companionSafe ? await readPluginJsonIfPresent(companionPath) : undefined;
    if (companion !== undefined) {
      if (!isPluginRecord(companion)) {
        addFormalIssue(
          issues,
          "manifest-mcp-companion-invalid",
          ".mcp.json must contain an object.",
          "mcpServers",
        );
      } else {
        const unknownKeys = Object.keys(companion).filter((key) => key !== "mcpServers");
        for (const key of unknownKeys) {
          addFormalIssue(
            issues,
            "manifest-companion-unsupported-field",
            `.mcp.json field ${key} is not accepted by plugin-creator validation.`,
            `.mcp.json.${key}`,
          );
        }
        validateInlineMcpServers(companion.mcpServers, issues, ".mcp.json.mcpServers");
      }
    }
  }

  if (typeof manifest.apps === "string") {
    const companionPath = join(pluginRoot, ".app.json");
    const companionSafe = await pathWithinPluginRoot(pluginRoot, companionPath);
    if (!companionSafe) {
      addFormalIssue(
        issues,
        "manifest-app-companion-unsafe",
        ".app.json must not resolve through a symbolic link or outside the plugin root.",
        "apps",
      );
    }
    const companion = companionSafe ? await readPluginJsonIfPresent(companionPath) : undefined;
    if (companion !== undefined) {
      if (!isPluginRecord(companion)) {
        addFormalIssue(
          issues,
          "manifest-app-companion-invalid",
          ".app.json must contain an object.",
          "apps",
        );
      } else {
        for (const key of Object.keys(companion)) {
          if (key !== "apps") {
            addFormalIssue(
              issues,
              "manifest-companion-unsupported-field",
              `.app.json field ${key} is not accepted by plugin-creator validation.`,
              `.app.json.${key}`,
            );
          }
        }
        if (!isPluginRecord(companion.apps)) {
          addFormalIssue(
            issues,
            "manifest-apps-invalid",
            ".app.json field apps must be an object.",
            ".app.json.apps",
          );
        } else {
          for (const [name, definition] of Object.entries(companion.apps)) {
            if (!isPluginRecord(definition)) {
              addFormalIssue(
                issues,
                "manifest-app-invalid",
                `.app.json app ${name} must be an object.`,
                `.app.json.apps.${name}`,
              );
              continue;
            }
            for (const key of Object.keys(definition)) {
              if (key !== "id" && key !== "category") {
                addFormalIssue(
                  issues,
                  "manifest-companion-unsupported-field",
                  `.app.json app ${name} field ${key} is not accepted by plugin-creator validation.`,
                  `.app.json.apps.${name}.${key}`,
                );
              }
            }
            if (!pluginString(definition.id)) {
              addFormalIssue(
                issues,
                "manifest-app-id-missing",
                `.app.json app ${name} must define a non-empty id.`,
                `.app.json.apps.${name}.id`,
              );
            }
            if (definition.category !== undefined && !pluginString(definition.category)) {
              addFormalIssue(
                issues,
                "manifest-app-category-invalid",
                `.app.json app ${name} category must be a non-empty string when provided.`,
                `.app.json.apps.${name}.category`,
              );
            }
          }
        }
      }
    }
  }

  const iface = pluginInterface(manifest);
  for (const field of ["composerIcon", "logo", "logoDark", "screenshots"] as const) {
    const values = pathDeclarations(iface?.[field]);
    for (const declaration of values) {
      if (!isPluginRelativePath(declaration.value)) continue;
      const assetPath = resolve(pluginRoot, declaration.value.slice(2));
      if (!(await pathWithinPluginRoot(pluginRoot, assetPath))) {
        addFormalIssue(
          issues,
          "manifest-asset-path-unsafe",
          `Plugin interface.${field} resolves outside the plugin root.`,
          `interface.${field}`,
        );
        continue;
      }
      if (await pathIsFile(assetPath)) continue;
      addFormalIssue(
        issues,
        "manifest-asset-missing",
        `Plugin interface.${field} must point to an existing file.`,
        `interface.${field}`,
      );
    }
  }

  const skillsRoot = join(pluginRoot, "skills");
  if ((await pathExists(skillsRoot)) && !(await pathWithinPluginRoot(pluginRoot, skillsRoot))) {
    addFormalIssue(
      issues,
      "manifest-skills-path-unsafe",
      "Plugin skills directory resolves outside the plugin root.",
      "skills",
    );
    return issues;
  }
  const skillEntries = await readBoundedPluginDirectory(skillsRoot).catch((error) => {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  });
  for (const entry of skillEntries) {
    if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue;
    const skillPath = join(skillsRoot, entry.name, "SKILL.md");
    if (!(await pathExists(skillPath))) {
      addFormalIssue(
        issues,
        "manifest-skill-missing",
        `Skill ${entry.name} is missing SKILL.md.`,
        `skills.${entry.name}`,
      );
      continue;
    }
    if (!(await pathWithinPluginRoot(pluginRoot, skillPath))) {
      addFormalIssue(
        issues,
        "manifest-skill-path-unsafe",
        `Skill ${entry.name} SKILL.md resolves outside the plugin root.`,
        `skills.${entry.name}.SKILL.md`,
      );
      continue;
    }
    try {
      const frontmatter = await readFrontmatterFile(skillPath);
      if (!frontmatter.name) {
        addFormalIssue(
          issues,
          "manifest-skill-name-missing",
          `Skill ${entry.name} must define a non-empty frontmatter name.`,
          `skills.${entry.name}.SKILL.md`,
        );
      }
      if (!frontmatter.description) {
        addFormalIssue(
          issues,
          "manifest-skill-description-missing",
          `Skill ${entry.name} must define a non-empty frontmatter description.`,
          `skills.${entry.name}.SKILL.md`,
        );
      }
      const disableModelInvocation = frontmatter.data["disable-model-invocation"];
      if (disableModelInvocation !== undefined && disableModelInvocation !== false) {
        addFormalIssue(
          issues,
          "manifest-skill-invocation-invalid",
          `Skill ${entry.name} must not disable model invocation.`,
          `skills.${entry.name}.SKILL.md`,
        );
      }
    } catch {
      addFormalIssue(
        issues,
        "manifest-skill-invalid",
        `Skill ${entry.name} could not be read.`,
        `skills.${entry.name}.SKILL.md`,
      );
    }
  }
  return issues;
}

function toPluginRelativePath(pluginRoot: string, absolutePath: string): string {
  const value = relative(pluginRoot, absolutePath).replaceAll("\\", "/");
  return value ? `./${value}` : "./";
}

function pluginComponentQuarantined(component: MossPluginComponent): boolean {
  const definition = component.metadata.definition;
  return (
    component.metadata.quarantine === true ||
    component.metadata.quarantined === true ||
    component.metadata.quarantine === "quarantined" ||
    pluginRecordQuarantined(definition)
  );
}

async function expandPluginDirectoryComponent(
  pluginRoot: string,
  component: MossPluginComponent,
): Promise<ReadonlyArray<MossPluginComponent>> {
  if (!component.sourcePath || !["skill", "subagent", "asset"].includes(component.kind)) {
    return [];
  }
  const absolutePath = resolve(pluginRoot, component.sourcePath.slice(2));
  if (!(await pathWithinPluginRoot(pluginRoot, absolutePath))) return [];
  const entries = await readBoundedPluginDirectory(absolutePath).catch((error) => {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "ENOENT" || code === "ENOTDIR") return [];
    throw error;
  });
  const parentQuarantined = pluginComponentQuarantined(component);
  const parentEnabled = component.enabled && !parentQuarantined;
  const expanded: MossPluginComponent[] = [];
  for (const entry of entries.toSorted((left, right) => left.name.localeCompare(right.name))) {
    if (!isSafeEntryName(entry.name)) continue;
    const entryPath = join(absolutePath, entry.name);
    if (component.kind === "skill") {
      if (!entry.isDirectory() || !(await pathExists(join(entryPath, "SKILL.md")))) continue;
    } else if (!entry.isFile()) {
      continue;
    }
    let name = entry.name.replace(/\.(md|json|png|jpg|jpeg|webp)$/i, "");
    if (component.kind === "skill") {
      try {
        name = (await readFrontmatterFile(join(entryPath, "SKILL.md"))).name ?? name;
      } catch {
        // A skill without scalar frontmatter still has a safe directory name.
      }
    }
    const child = makePluginComponent(
      component.kind,
      { name, path: toPluginRelativePath(pluginRoot, entryPath) },
      String(component.metadata.field ?? component.kind),
      expanded.length,
    );
    expanded.push({
      ...child,
      metadata: {
        ...component.metadata,
        parentSourcePath: component.sourcePath,
        parentEnabled,
        parentQuarantined,
      },
      enabled: parentEnabled && child.enabled,
    });
  }
  return expanded;
}

async function expandPluginCompanionComponent(
  pluginRoot: string,
  component: MossPluginComponent,
): Promise<{
  readonly components: ReadonlyArray<MossPluginComponent>;
  readonly issues: ReadonlyArray<MossPluginValidationIssue>;
}> {
  if (!component.sourcePath || !["mcp", "hook", "app", "permission"].includes(component.kind)) {
    return { components: [], issues: [] };
  }
  const absolutePath = resolve(pluginRoot, component.sourcePath.slice(2));
  if (!(await pathWithinPluginRoot(pluginRoot, absolutePath))) {
    return {
      components: [],
      issues: [
        issue(
          "warning",
          "manifest-component-path-unsafe",
          `Plugin ${component.kind} source path resolves outside the plugin root: ${component.sourcePath}.`,
          component.sourcePath,
        ),
      ],
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(await readBoundedPluginText(absolutePath)) as unknown;
  } catch (error) {
    return {
      components: [],
      issues: [
        issue(
          "warning",
          "manifest-companion-invalid-json",
          `Plugin ${component.kind} companion could not be parsed: ${error instanceof Error ? error.message : String(error)}.`,
          component.sourcePath,
        ),
      ],
    };
  }
  let value: unknown = parsed;
  if (isPluginRecord(parsed)) {
    if (component.kind === "mcp") value = parsed.mcpServers ?? parsed.servers ?? parsed;
    if (component.kind === "hook") value = parsed.hooks ?? parsed;
    if (component.kind === "app") value = parsed.apps ?? parsed;
    if (component.kind === "permission") value = parsed.permissions ?? parsed;
  }
  const parentQuarantined = pluginComponentQuarantined(component);
  const parentEnabled = component.enabled && !parentQuarantined;
  const children = componentsForField(
    component.kind,
    String(component.metadata.field ?? component.kind),
    value,
  ).map((child) => ({
    ...child,
    enabled: parentEnabled && child.enabled && !pluginComponentQuarantined(child),
    sourcePath: component.sourcePath,
    metadata: {
      ...child.metadata,
      parentSourcePath: component.sourcePath,
      parentEnabled,
      parentQuarantined: parentQuarantined || pluginRecordQuarantined(child.metadata.definition),
    },
  }));
  return { components: children, issues: [] };
}

async function hydrateMossPluginComponents(
  pluginRoot: string,
  format: MossPluginManifestFormat,
  components: ReadonlyArray<MossPluginComponent>,
): Promise<{
  readonly components: ReadonlyArray<MossPluginComponent>;
  readonly issues: ReadonlyArray<MossPluginValidationIssue>;
}> {
  const hydrated: MossPluginComponent[] = [];
  const issues: MossPluginValidationIssue[] = [];
  for (const component of components) {
    const directoryChildren = await expandPluginDirectoryComponent(pluginRoot, component);
    if (directoryChildren.length > 0) {
      hydrated.push(...directoryChildren);
      continue;
    }
    const companion = await expandPluginCompanionComponent(pluginRoot, component);
    if (companion.components.length > 0) {
      hydrated.push(...companion.components);
      issues.push(...companion.issues);
      continue;
    }
    issues.push(
      ...companion.issues.map((entry) => ({
        ...entry,
        severity: format === "formal" ? "error" : entry.severity,
      })),
    );
    hydrated.push(component);
  }
  const unique = new Map<string, MossPluginComponent>();
  for (const component of hydrated) {
    const key = `${component.kind}:${component.name}:${component.sourcePath ?? ""}`;
    if (!unique.has(key)) unique.set(key, component);
  }
  return { components: [...unique.values()], issues };
}

export function parseMossPluginManifest(input: {
  readonly projectPath: string;
  readonly pluginRoot: string;
  readonly manifestPath: string;
  readonly manifest: unknown;
  readonly manifestFormat: MossPluginManifestFormat;
  readonly marketplaceEntry?: unknown;
  readonly extraIssues?: ReadonlyArray<MossPluginValidationIssue>;
  readonly expectedName?: string | undefined;
}): MossPluginIR {
  const projectPath = resolve(input.projectPath);
  const absolutePluginRoot = resolve(projectPath, input.pluginRoot);
  const absoluteManifestPath = resolve(projectPath, input.manifestPath);
  const manifest = isPluginRecord(input.manifest) ? input.manifest : {};
  const name = pluginString(manifest.name) ?? basename(absolutePluginRoot);
  const baseValidation = validateMossPluginManifest(manifest, {
    format: input.manifestFormat,
    expectedName: input.expectedName,
  });
  const marketplace = resolveMossPluginMarketplacePolicy({
    manifest,
    format: input.manifestFormat,
    marketplaceEntry: input.marketplaceEntry,
  });
  const components = decomposeMossPluginManifest(manifest);
  const validation = mergeValidation(
    baseValidation,
    marketplace.validation,
    validationFromIssues(componentNameValidationIssues(components)),
    validationFromIssues(input.extraIssues ?? []),
  );
  return {
    id: `moss:plugin:${name}`,
    name,
    ...(pluginString(manifest.version) ? { version: pluginString(manifest.version) } : {}),
    ...(pluginString(manifest.description)
      ? { description: pluginString(manifest.description) }
      : {}),
    manifestFormat: input.manifestFormat,
    pluginRoot: relative(projectPath, absolutePluginRoot) || ".",
    manifestPath: relative(projectPath, absoluteManifestPath) || basename(absoluteManifestPath),
    absolutePluginRoot,
    absoluteManifestPath,
    manifest,
    interface: pluginInterface(manifest),
    enabled: manifest.enabled !== false && validation.ok,
    components,
    permissions: components.filter((component) => component.kind === "permission"),
    marketplacePolicy: marketplace.policy,
    validation,
  };
}

export interface ReadMossPluginManifestOptions {
  readonly projectPath: string;
  readonly pluginRoot: string;
  readonly marketplaceEntry?: unknown;
}

function normalizeMossPluginRoot(projectPath: string, inputRoot: string): string {
  const absolute = resolve(projectPath, inputRoot);
  if (basename(absolute) === "plugin.json") {
    const manifestDirectory = resolve(absolute, "..");
    return basename(manifestDirectory) === ".codex-plugin"
      ? resolve(manifestDirectory, "..")
      : manifestDirectory;
  }
  return basename(absolute) === ".codex-plugin" ? resolve(absolute, "..") : absolute;
}

/** Read formal `.codex-plugin/plugin.json`, falling back to legacy plugin.json. */
export async function readMossPluginManifest(
  input: ReadMossPluginManifestOptions,
): Promise<MossPluginIR> {
  const projectPath = resolve(input.projectPath);
  const absolutePluginRoot = normalizeMossPluginRoot(projectPath, input.pluginRoot);
  try {
    const rootStat = await lstat(absolutePluginRoot);
    if (rootStat.isSymbolicLink()) {
      throw new Error("Plugin root symlinks are not allowed.");
    }
    if (!(await pathContainedByWorkspace(projectPath, absolutePluginRoot))) {
      throw new Error("Plugin root resolves outside the workspace.");
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  const formalPath = join(absolutePluginRoot, ".codex-plugin", "plugin.json");
  const legacyPath = join(absolutePluginRoot, "plugin.json");
  const formalExists = await pathExists(formalPath);
  const legacyExists = await pathExists(legacyPath);
  const manifestFormat: MossPluginManifestFormat = formalExists
    ? "formal"
    : legacyExists
      ? "legacy"
      : "missing";
  const manifestPath = formalExists ? formalPath : legacyPath;
  if (
    manifestFormat !== "missing" &&
    !(await pathHasNoSymlinkSegment(absolutePluginRoot, manifestPath))
  ) {
    throw new Error("Plugin manifest path contains a symbolic-link segment.");
  }
  const extraIssues: MossPluginValidationIssue[] = [];
  if (formalExists && legacyExists) {
    extraIssues.push(
      issue(
        "warning",
        "legacy-manifest-shadowed",
        "Formal .codex-plugin/plugin.json wins; legacy plugin.json is retained but not executed.",
        "plugin.json",
      ),
    );
  }
  let manifest: unknown = {};
  if (manifestFormat === "missing") {
    extraIssues.push(
      issue("error", "manifest-missing", "Plugin directory has no plugin manifest."),
    );
  } else {
    try {
      manifest = JSON.parse(await readBoundedPluginText(manifestPath)) as unknown;
    } catch (error) {
      extraIssues.push(
        issue(
          "error",
          "manifest-invalid-json",
          `Plugin manifest is not valid JSON: ${error instanceof Error ? error.message : String(error)}.`,
          relative(projectPath, manifestPath),
        ),
      );
    }
  }
  const parsed = parseMossPluginManifest({
    projectPath,
    pluginRoot: absolutePluginRoot,
    manifestPath,
    manifest,
    manifestFormat,
    marketplaceEntry: input.marketplaceEntry,
    extraIssues,
    expectedName: basename(absolutePluginRoot),
  });
  const hydrated = await hydrateMossPluginComponents(
    absolutePluginRoot,
    manifestFormat,
    parsed.components,
  );
  const formalFileIssues =
    manifestFormat === "formal"
      ? await validateFormalPluginFiles(
          absolutePluginRoot,
          isPluginRecord(manifest) ? manifest : {},
        )
      : [];
  const hydratedValidation = mergeValidation(
    parsed.validation,
    validationFromIssues(hydrated.issues),
    validationFromIssues(componentNameValidationIssues(hydrated.components)),
    validationFromIssues(formalFileIssues),
  );
  const hydratedParsed: MossPluginIR = {
    ...parsed,
    enabled: parsed.enabled && hydratedValidation.ok,
    components: hydrated.components,
    permissions: hydrated.components.filter((component) => component.kind === "permission"),
    validation: hydratedValidation,
  };
  const pathIssues: MossPluginValidationIssue[] = [];
  await addMissingPathIssues(pathIssues, absolutePluginRoot, manifestFormat, hydrated.components);
  if (pathIssues.length === 0) return hydratedParsed;
  const unsafeSourcePaths = new Set(
    pathIssues
      .filter((entry) => entry.code === "manifest-component-path-unsafe")
      .flatMap((entry) => (entry.path ? [entry.path] : [])),
  );
  const guardedComponents = hydratedParsed.components.map((component) =>
    component.sourcePath && unsafeSourcePaths.has(component.sourcePath)
      ? {
          ...component,
          enabled: false,
          metadata: {
            ...component.metadata,
            disabledReason: "Component path resolves outside the plugin root.",
          },
        }
      : component,
  );
  return {
    ...hydratedParsed,
    enabled: hydratedParsed.enabled && pathIssues.every((entry) => entry.severity !== "error"),
    components: guardedComponents,
    permissions: guardedComponents.filter((component) => component.kind === "permission"),
    validation: mergeValidation(hydratedParsed.validation, validationFromIssues(pathIssues)),
  };
}

function resourceId(parts: ReadonlyArray<string | undefined | null>): string {
  return parts.filter(Boolean).join(":");
}

async function pathExists(filePath: string): Promise<boolean> {
  try {
    await access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function pathIsFile(filePath: string): Promise<boolean> {
  try {
    return (await stat(filePath)).isFile();
  } catch {
    return false;
  }
}

/** Reject symlinked component roots that resolve outside the plugin bundle. */
async function pathWithinPluginRoot(pluginRoot: string, filePath: string): Promise<boolean> {
  if (!(await pathExists(filePath))) return true;
  try {
    if (!(await pathHasNoSymlinkSegment(pluginRoot, filePath))) return false;
    const [rootRealPath, fileRealPath] = await Promise.all([
      realpath(pluginRoot),
      realpath(filePath),
    ]);
    const relativePath = relative(rootRealPath, fileRealPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith("/"));
  } catch {
    return false;
  }
}

async function pathHasNoSymlinkSegment(rootPath: string, candidatePath: string): Promise<boolean> {
  const root = resolve(rootPath);
  const candidate = resolve(candidatePath);
  const candidateRelative = relative(root, candidate);
  if (candidateRelative.startsWith("..") || candidateRelative.startsWith(sep)) {
    return false;
  }
  try {
    if ((await lstat(root)).isSymbolicLink()) return false;
    let current = root;
    for (const segment of candidateRelative ? candidateRelative.split(sep) : []) {
      current = join(current, segment);
      if ((await lstat(current)).isSymbolicLink()) return false;
    }
    return true;
  } catch {
    return false;
  }
}

async function pathContainedByWorkspace(projectPath: string, candidate: string): Promise<boolean> {
  try {
    const [workspaceRealPath, candidateRealPath] = await Promise.all([
      realpath(projectPath),
      realpath(candidate),
    ]);
    const relativePath = relative(workspaceRealPath, candidateRealPath);
    return relativePath === "" || (!relativePath.startsWith("..") && !relativePath.startsWith(sep));
  } catch {
    return false;
  }
}

/** Canonical plugin roots are workspace-owned; a symlinked root is not a source boundary. */
async function isSafeCanonicalPluginsRoot(
  projectPath: string,
  pluginsRoot: string,
): Promise<boolean> {
  try {
    const rootStat = await lstat(pluginsRoot);
    if (rootStat.isSymbolicLink() || !rootStat.isDirectory()) return false;
    return pathContainedByWorkspace(projectPath, pluginsRoot);
  } catch {
    return false;
  }
}

export function isSafeEntryName(name: string): boolean {
  return !name.includes("..") && !name.includes("/") && !name.includes("\\");
}

interface ParsedFrontmatter {
  readonly name?: string | undefined;
  readonly description?: string | undefined;
  readonly data: Record<string, string | boolean>;
}

async function readFrontmatterFile(filePath: string): Promise<ParsedFrontmatter> {
  const raw = await readBoundedPluginText(filePath, 1024 * 1024);
  const data = parseScalarFrontmatter(raw);
  return {
    name: readStringField(data, ["name"]),
    description: readStringField(data, ["description"]),
    data,
  };
}

function withMossMetadata(metadata: Record<string, unknown>): Record<string, unknown> {
  return {
    ...metadata,
    sourceSystem: "moss-unified-source",
  };
}

async function addFileResource(
  resources: MossSharedResource[],
  params: {
    projectPath: string;
    filePath: string;
    kind: MossSharedResourceKind;
    name: string;
    description: string;
    metadata: Record<string, unknown>;
  },
): Promise<void> {
  if (!(await pathExists(params.filePath))) return;

  resources.push({
    id: resourceId(["moss", params.kind, params.name]),
    kind: params.kind,
    name: params.name,
    path: toMossProjectPath(params.projectPath, params.filePath),
    description: params.description,
    enabled: true,
    metadata: withMossMetadata(params.metadata),
  });
}

async function scanMossSkills(
  projectPath: string,
  skillsRoot: string,
): Promise<MossSharedResource[]> {
  if (!(await pathExists(skillsRoot))) return [];
  const entries = await readdir(skillsRoot, { withFileTypes: true });
  const resources: MossSharedResource[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue;
    const skillPath = join(skillsRoot, entry.name, "SKILL.md");
    if (!(await pathExists(skillPath))) continue;

    try {
      const parsed = await readFrontmatterFile(skillPath);
      const name = parsed.name || entry.name;
      const skillEnabled = parsed.data.enabled !== false;
      resources.push({
        id: resourceId(["moss", "skill", name]),
        kind: "skill",
        name,
        path: toMossProjectPath(projectPath, skillPath),
        description: parsed.description,
        enabled: skillEnabled,
        metadata: withMossMetadata({
          mossRole: "skill",
          entryName: entry.name,
          projectionUnit: "directory",
          skillEnabled,
        }),
      });
    } catch {
      continue;
    }
  }

  return resources;
}

async function scanMossMemoryEntries(
  projectPath: string,
  memoryRoot: string,
): Promise<MossSharedResource[]> {
  if (!(await pathExists(memoryRoot))) return [];
  const entries = await readdir(memoryRoot, { withFileTypes: true });
  const resources: MossSharedResource[] = [];

  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith(".md") || !isSafeEntryName(entry.name)) {
      continue;
    }

    const filePath = join(memoryRoot, entry.name);
    try {
      const parsed = await readFrontmatterFile(filePath);
      const fallbackName = entry.name.replace(/\.md$/, "");
      const name = parsed.name || fallbackName;
      resources.push({
        id: resourceId(["moss", "memory", name]),
        kind: "memory",
        name,
        path: toMossProjectPath(projectPath, filePath),
        description: parsed.description,
        enabled: true,
        metadata: withMossMetadata({
          mossRole: "memory-entry",
          entryName: entry.name,
          projectionUnit: "file",
        }),
      });
    } catch {
      continue;
    }
  }

  return resources;
}

async function scanMossMarkdownEntries(
  projectPath: string,
  root: string,
  kind: "subagent" | "hook",
  role: string,
  trustStore?: MossHookTrustStore,
): Promise<MossSharedResource[]> {
  if (!(await pathExists(root))) return [];
  const entries = await readdir(root, { withFileTypes: true });
  const resources: MossSharedResource[] = [];

  for (const entry of entries) {
    if (!isSafeEntryName(entry.name)) continue;
    if (entry.name.toLowerCase() === "readme" || entry.name.toLowerCase() === "readme.md") {
      continue;
    }
    const entryPath = join(root, entry.name);
    if (entry.isDirectory()) {
      resources.push({
        id: resourceId(["moss", kind, entry.name]),
        kind,
        name: entry.name,
        path: toMossProjectPath(projectPath, entryPath),
        enabled: true,
        metadata: withMossMetadata({
          mossRole: role,
          entryName: entry.name,
          projectionUnit: "directory",
        }),
      });
      continue;
    }

    if (!entry.isFile() || !entry.name.endsWith(".md")) continue;
    try {
      const parsed = await readFrontmatterFile(entryPath);
      const fallbackName = entry.name.replace(/\.md$/, "");
      const name = parsed.name || fallbackName;
      const hookCommand =
        kind === "hook" && typeof parsed.data.command === "string"
          ? parsed.data.command
          : undefined;
      const hookEvent =
        kind === "hook" && typeof parsed.data.event === "string" ? parsed.data.event : undefined;
      const hookTrustHash =
        kind === "hook"
          ? computeHookTrustHash({ command: hookCommand ?? "", event: hookEvent ?? "" })
          : undefined;
      const hookTrustState =
        kind === "hook"
          ? resolveHookTrustState({
              currentHash: hookTrustHash as string,
              entry: trustStore?.hooks[name],
            })
          : undefined;
      const hookMetadata =
        kind === "hook"
          ? {
              event: hookEvent,
              command: hookCommand,
              hookEnabled: parsed.data.enabled !== false,
              trustHash: hookTrustHash,
              trustState: hookTrustState,
              trustedHash: trustStore?.hooks[name]?.trustedHash,
              trustedAt: trustStore?.hooks[name]?.trustedAt,
            }
          : {};
      const subagentMetadata =
        kind === "subagent"
          ? {
              command: typeof parsed.data.command === "string" ? parsed.data.command : undefined,
              subagentEnabled: parsed.data.enabled !== false,
            }
          : {};
      resources.push({
        id: resourceId(["moss", kind, name]),
        kind,
        name,
        path: toMossProjectPath(projectPath, entryPath),
        description: parsed.description,
        enabled: parsed.data.enabled !== false,
        metadata: withMossMetadata({
          mossRole: role,
          entryName: entry.name,
          projectionUnit: "file",
          ...hookMetadata,
          ...subagentMetadata,
        }),
      });
    } catch {
      continue;
    }
  }

  return resources;
}

async function readMossMcpResources(
  projectPath: string,
  mcpConfigPath: string,
): Promise<MossSharedResource[]> {
  if (!(await pathExists(mcpConfigPath))) return [];

  try {
    const raw = await readFile(mcpConfigPath, "utf8");
    const parsed = JSON.parse(raw) as {
      mcpServers?: Record<string, unknown>;
      servers?: Record<string, unknown>;
    };
    const servers = parsed.mcpServers ?? parsed.servers ?? {};
    const entries = Object.entries(servers);

    if (entries.length === 0) {
      return [
        {
          id: "moss:mcp:config",
          kind: "mcp",
          name: "Moss MCP config",
          path: toMossProjectPath(projectPath, mcpConfigPath),
          description: "Moss Unified Source MCP config.",
          enabled: true,
          metadata: withMossMetadata({
            mossRole: "mcp-config",
            serverCount: 0,
          }),
        },
      ];
    }

    return entries.map(([serverName, serverConfig]) => ({
      id: resourceId(["moss", "mcp", serverName]),
      kind: "mcp" as const,
      name: serverName,
      path: toMossProjectPath(projectPath, mcpConfigPath),
      description: "Moss Unified Source MCP server.",
      enabled: true,
      metadata: withMossMetadata({
        mossRole: "mcp-config",
        serverConfig,
      }),
    }));
  } catch (error) {
    return [
      {
        id: "moss:mcp:config-error",
        kind: "mcp",
        name: "Moss MCP config parse error",
        path: toMossProjectPath(projectPath, mcpConfigPath),
        description: "Moss MCP config exists but could not be parsed.",
        enabled: false,
        metadata: withMossMetadata({
          mossRole: "mcp-config",
          error: error instanceof Error ? error.message : String(error),
        }),
      },
    ];
  }
}

async function readMossPluginMarketplaceEntries(
  pluginsRoot: string,
): Promise<Map<string, unknown>> {
  const marketplacePath = join(pluginsRoot, "marketplace.json");
  if (!(await pathExists(marketplacePath))) return new Map();
  try {
    const raw = JSON.parse(await readBoundedPluginText(marketplacePath)) as unknown;
    if (!isPluginRecord(raw) || !Array.isArray(raw.plugins)) return new Map();
    return new Map(
      raw.plugins.flatMap((entry) => {
        if (!isPluginRecord(entry) || !pluginString(entry.name)) return [];
        return [[pluginString(entry.name)!, entry] as const];
      }),
    );
  } catch {
    // Discovery still exposes plugin bundles; explicit importer calls retain
    // the marketplace validation error instead of blocking all source reads.
    return new Map();
  }
}

async function scanMossPlugins(
  projectPath: string,
  pluginsRoot: string,
): Promise<MossSharedResource[]> {
  if (!(await pathExists(pluginsRoot))) return [];
  if (!(await isSafeCanonicalPluginsRoot(projectPath, pluginsRoot))) return [];
  const entries = (await readBoundedPluginDirectory(pluginsRoot).catch(() => [])).toSorted(
    (left, right) => left.name.localeCompare(right.name),
  );
  const marketplaceEntries = await readMossPluginMarketplaceEntries(pluginsRoot);
  const resources: MossSharedResource[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory() || !isSafeEntryName(entry.name)) continue;
    let plugin: MossPluginIR;
    try {
      plugin = await readMossPluginManifest({
        projectPath,
        pluginRoot: join(pluginsRoot, entry.name),
        marketplaceEntry: marketplaceEntries.get(entry.name),
      });
    } catch (error) {
      resources.push({
        id: `moss:plugin:${entry.name}:error`,
        kind: "plugin",
        name: entry.name,
        path: toMossProjectPath(projectPath, join(pluginsRoot, entry.name)),
        enabled: false,
        metadata: withMossMetadata({
          mossRole: "plugin",
          entryName: entry.name,
          sourceError: `Plugin source could not be read: ${error instanceof Error ? error.message : String(error)}`,
        }),
      });
      continue;
    }
    resources.push({
      id: plugin.id,
      kind: "plugin",
      name: plugin.name,
      path: plugin.manifestPath,
      ...(plugin.description ? { description: plugin.description } : {}),
      enabled: plugin.enabled,
      metadata: withMossMetadata({
        mossRole: "plugin",
        entryName: entry.name,
        projectionUnit: "directory",
        pluginRoot: plugin.pluginRoot,
        manifestPath: plugin.manifestPath,
        manifestFormat: plugin.manifestFormat,
        components: plugin.components,
        permissions: plugin.permissions,
        marketplacePolicy: plugin.marketplacePolicy,
        validation: plugin.validation,
        plugin,
      }),
    });
  }
  return resources;
}

/**
 * Discover every projectable resource under the workspace's `.moss` tree.
 * Returns an empty list when the workspace has no `.moss` root.
 */
export async function discoverMossSourceResources(
  projectPath: string,
): Promise<MossSharedResource[]> {
  const layout = getMossSourceLayout(projectPath);
  if (!(await pathExists(layout.root))) return [];

  const resources: MossSharedResource[] = [];
  await addFileResource(resources, {
    projectPath,
    filePath: layout.sourceInstruction,
    kind: "instruction",
    name: basename(layout.sourceInstruction),
    description: "Moss canonical project rules and operating instructions.",
    metadata: {
      mossRole: "source-instruction",
      projectionTarget: "CLAUDE.md and AGENTS.md",
    },
  });
  await addFileResource(resources, {
    projectPath,
    filePath: layout.workspaceConfig,
    kind: "instruction",
    name: basename(layout.workspaceConfig),
    description: "Moss canonical workspace configuration.",
    metadata: {
      mossRole: "workspace-config",
    },
  });
  await addFileResource(resources, {
    projectPath,
    filePath: layout.memoryRoot,
    kind: "memory",
    name: "Moss memory",
    description: "Moss canonical memory root shared by all engines.",
    metadata: {
      mossRole: "memory-root",
      projectionTarget: "provider-native memory roots",
    },
  });
  await addFileResource(resources, {
    projectPath,
    filePath: layout.providersConfig,
    kind: "provider",
    name: basename(layout.providersConfig),
    description: "Moss canonical provider routing and credentials mapping.",
    metadata: {
      mossRole: "provider-config",
      projectionTarget: "engine-native auth/config bridges",
    },
  });

  const hookTrustStore = await readHookTrustStore(projectPath);

  resources.push(
    ...(await scanMossMemoryEntries(projectPath, layout.memoryRoot)),
    ...(await scanMossSkills(projectPath, layout.skillsRoot)),
    ...(await readMossMcpResources(projectPath, layout.mcpConfig)),
    ...(await scanMossMarkdownEntries(
      projectPath,
      layout.hooksRoot,
      "hook",
      "hook",
      hookTrustStore,
    )),
    ...(await scanMossMarkdownEntries(projectPath, layout.subagentsRoot, "subagent", "subagent")),
    ...(await scanMossPlugins(projectPath, layout.pluginsRoot)),
  );

  return resources;
}
