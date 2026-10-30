import { createHash } from "node:crypto";

import { Schema } from "effect";

import {
  MossCanonicalConfig as MossCanonicalConfigSchema,
  MossProjectionResult as MossProjectionResultSchema,
  type MossCanonicalConfig,
  type MossConfigEntry,
  type MossConfigProjectionTarget,
  type MossProjectionResult,
  type MossProjectionWarning,
  type MossProjectionWrite,
} from "@synara/contracts";

export const MOSS_PROJECTION_TARGETS = [
  "moss",
  "codex",
  "claude",
  "hermes",
  "acp",
  "custom-cli",
] as const satisfies ReadonlyArray<MossConfigProjectionTarget>;

const decodeCanonicalConfig = Schema.decodeUnknownSync(MossCanonicalConfigSchema);
const decodeProjectionResult = Schema.decodeUnknownSync(MossProjectionResultSchema);

export interface MossProjectionOptions {
  readonly target: MossConfigProjectionTarget;
  readonly dryRun?: boolean;
  readonly createdAt?: string;
  readonly outputRoot?: string;
}

export interface MossProjectionReportOptions {
  readonly targets?: ReadonlyArray<MossConfigProjectionTarget>;
  readonly dryRun?: boolean;
  readonly createdAt?: string;
}

function stableJson(value: unknown): string {
  if (value === null || typeof value !== "object") {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item)).join(",")}]`;
  }
  const record = value as Record<string, unknown>;
  return `{${Object.keys(record)
    .toSorted()
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key])}`)
    .join(",")}}`;
}

export function hashMossProjectionValue(value: unknown): string {
  return `sha256:${createHash("sha256").update(stableJson(value)).digest("hex")}`;
}

function warning(code: string, message: string, path?: string): MossProjectionWarning {
  const result: MossProjectionWarning = { code, message };
  if (path) {
    return { ...result, path };
  }
  return result;
}

function writePlan(dryRun: boolean, outputPath: string, reason: string): MossProjectionWrite {
  return {
    action: dryRun ? "would-update" : "update",
    path: outputPath,
    reason,
  };
}

function entryToRecord(entry: MossConfigEntry): Record<string, unknown> {
  const rendered: Record<string, unknown> = {
    enabled: entry.enabled ?? true,
  };
  if (entry.source) {
    rendered.source = entry.source;
  }
  if (entry.metadata) {
    rendered.metadata = entry.metadata;
  }
  return rendered;
}

function entriesByName(entries: ReadonlyArray<MossConfigEntry>): Record<string, unknown> {
  const rendered: Record<string, unknown> = {};
  for (const entry of entries) {
    rendered[entry.name] = entryToRecord(entry);
  }
  return rendered;
}

function providerModel(config: MossCanonicalConfig, provider: string): string | null {
  const providerConfig = config.providers[provider];
  if (providerConfig === null || typeof providerConfig !== "object") {
    return null;
  }
  const model = (providerConfig as Record<string, unknown>).model;
  return typeof model === "string" && model.trim().length > 0 ? model : null;
}

function targetOutputPath(target: MossConfigProjectionTarget, outputRoot: string): string {
  const filename =
    target === "codex" ? "config.toml" : target === "claude" ? "settings.json" : "config.json";
  return `${outputRoot}/${target}/${filename}`;
}

function baseWarnings(
  config: MossCanonicalConfig,
  target: MossConfigProjectionTarget,
): ReadonlyArray<MossProjectionWarning> {
  const warnings: MossProjectionWarning[] = [];
  if (!config.providers[config.defaultProvider]) {
    warnings.push(
      warning(
        "missing-default-provider",
        `Default provider ${config.defaultProvider} has no provider config.`,
        `providers.${config.defaultProvider}`,
      ),
    );
  }
  if (target !== "moss" && config.skills.length > 0) {
    warnings.push(
      warning(
        "lossy-skills",
        `${target} projection keeps skills as references; native installation is target-specific.`,
        "skills",
      ),
    );
  }
  if (target !== "moss" && config.memory.length > 0) {
    warnings.push(
      warning(
        "manual-memory-wire",
        `${target} projection keeps memory sources as references; memory hydration remains a Moss responsibility.`,
        "memory",
      ),
    );
  }
  if (!["moss", "codex", "claude"].includes(target) && config.hooks.length > 0) {
    warnings.push(
      warning(
        "lossy-hooks",
        `${target} projection cannot guarantee native hook semantics.`,
        "hooks",
      ),
    );
  }
  return warnings;
}

function renderMoss(config: MossCanonicalConfig): Record<string, unknown> {
  const rendered: Record<string, unknown> = {
    version: config.version,
    name: config.name,
    defaultProvider: config.defaultProvider,
    providers: config.providers,
    mcp: entriesByName(config.mcp),
    skills: entriesByName(config.skills),
    memory: entriesByName(config.memory),
    hooks: entriesByName(config.hooks),
    tools: config.tools,
  };
  if (config.overlays) {
    rendered.overlays = config.overlays;
  }
  return rendered;
}

function renderCodex(config: MossCanonicalConfig): Record<string, unknown> {
  return {
    configToml: {
      model: providerModel(config, "codex") ?? providerModel(config, config.defaultProvider),
      approval_policy: "on-request",
      sandbox_mode: "workspace-write",
      mcp_servers: entriesByName(config.mcp),
    },
    tools: config.tools,
    skills: config.skills.map((entry) => entry.name),
    memory: config.memory.map((entry) => entry.source ?? entry.name),
    hooks: entriesByName(config.hooks),
  };
}

function renderClaude(config: MossCanonicalConfig): Record<string, unknown> {
  return {
    settingsJson: {
      model: providerModel(config, "claudeAgent") ?? providerModel(config, config.defaultProvider),
      permissions: {
        allow: config.tools.allow,
        deny: config.tools.deny,
      },
      mcpServers: entriesByName(config.mcp),
      hooks: entriesByName(config.hooks),
    },
    skills: config.skills.map((entry) => entry.source ?? entry.name),
    memory: config.memory.map((entry) => entry.source ?? entry.name),
  };
}

function renderHermes(config: MossCanonicalConfig): Record<string, unknown> {
  return {
    provider: "hermes",
    upstreamProvider: config.defaultProvider,
    upstreamModel: providerModel(config, config.defaultProvider),
    tools: config.tools,
    mcp: entriesByName(config.mcp),
    skills: config.skills.map((entry) => entry.name),
    memory: config.memory.map((entry) => entry.source ?? entry.name),
  };
}

function renderAcp(config: MossCanonicalConfig): Record<string, unknown> {
  return {
    protocol: "acp",
    defaultAgent: {
      provider: config.defaultProvider,
      model: providerModel(config, config.defaultProvider),
    },
    capabilities: {
      tools: config.tools,
      mcp: entriesByName(config.mcp),
    },
    context: {
      memory: config.memory.map((entry) => entry.source ?? entry.name),
      skills: config.skills.map((entry) => entry.source ?? entry.name),
    },
  };
}

function renderCustomCli(config: MossCanonicalConfig): Record<string, unknown> {
  return {
    agent: {
      provider: config.defaultProvider,
      model: providerModel(config, config.defaultProvider),
    },
    env: {
      MOSS_CONFIG: ".moss/config.json",
      MOSS_CONTEXT: ".moss/context/current.md",
    },
    tools: config.tools,
    mcp: entriesByName(config.mcp),
    skills: config.skills.map((entry) => entry.source ?? entry.name),
    memory: config.memory.map((entry) => entry.source ?? entry.name),
    hooks: entriesByName(config.hooks),
  };
}

function renderTarget(
  config: MossCanonicalConfig,
  target: MossConfigProjectionTarget,
): Record<string, unknown> {
  switch (target) {
    case "moss":
      return renderMoss(config);
    case "codex":
      return renderCodex(config);
    case "claude":
      return renderClaude(config);
    case "hermes":
      return renderHermes(config);
    case "acp":
      return renderAcp(config);
    case "custom-cli":
      return renderCustomCli(config);
  }
}

function targetWarnings(
  config: MossCanonicalConfig,
  target: MossConfigProjectionTarget,
): ReadonlyArray<MossProjectionWarning> {
  if (target === "claude" && !config.providers.claudeAgent) {
    return [
      warning(
        "missing-target-provider",
        "Claude projection has no claudeAgent provider config.",
        "providers.claudeAgent",
      ),
    ];
  }
  if (target === "codex" && !config.providers.codex) {
    return [
      warning(
        "missing-target-provider",
        "Codex projection has no codex provider config.",
        "providers.codex",
      ),
    ];
  }
  if (target === "hermes") {
    return [
      warning(
        "adapter-required",
        "Hermes projection is a Moss-side adapter contract until a native Hermes config writer is wired.",
      ),
    ];
  }
  if (target === "acp") {
    return [
      warning(
        "adapter-required",
        "ACP projection is dry-run protocol intent until an ACP adapter writer is wired.",
      ),
    ];
  }
  return [];
}

export function parseMossCanonicalConfig(content: string, source: string): MossCanonicalConfig {
  let parsed: unknown;
  try {
    parsed = JSON.parse(content);
  } catch (error) {
    throw new Error(`${source}: invalid JSON: ${String(error)}`, { cause: error });
  }

  try {
    return decodeCanonicalConfig(parsed);
  } catch (error) {
    throw new Error(`${source}: invalid Moss canonical config: ${String(error)}`, {
      cause: error,
    });
  }
}

export function projectMossConfig(
  config: MossCanonicalConfig,
  options: MossProjectionOptions,
): MossProjectionResult {
  const dryRun = options.dryRun ?? true;
  const createdAt = options.createdAt ?? new Date().toISOString();
  const outputRoot = options.outputRoot ?? ".moss/projections";
  const outputPath = targetOutputPath(options.target, outputRoot);
  const result = {
    target: options.target,
    dryRun,
    createdAt,
    sourceHash: hashMossProjectionValue(config),
    outputPath,
    rendered: renderTarget(config, options.target),
    warnings: [...baseWarnings(config, options.target), ...targetWarnings(config, options.target)],
    writes: [
      writePlan(
        dryRun,
        outputPath,
        dryRun
          ? "dry-run projection only; no config file was written"
          : "projection renderer selected this target path",
      ),
    ],
  };
  return decodeProjectionResult(result);
}

export function projectAllMossConfig(
  config: MossCanonicalConfig,
  options: Omit<MossProjectionOptions, "target"> = {},
): ReadonlyArray<MossProjectionResult> {
  return MOSS_PROJECTION_TARGETS.map((target) =>
    projectMossConfig(config, {
      target,
      ...(options.dryRun !== undefined ? { dryRun: options.dryRun } : {}),
      ...(options.createdAt !== undefined ? { createdAt: options.createdAt } : {}),
      ...(options.outputRoot !== undefined ? { outputRoot: options.outputRoot } : {}),
    }),
  );
}
