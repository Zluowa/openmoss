/**
 * Moss projection governance (ported from 1code
 * `shared-resources/governance.ts`, Moss-scope subset).
 *
 * Maps discovered `.moss` resources onto provider-native target paths per
 * engine. The matrix covers every active Moss provider: the two
 * lead engines (codex, claudeAgent) keep their full native surface, and the
 * remaining engines get an explicit per-kind mapping instead of a blanket
 * `unsupported` short-circuit.
 *
 * Two engine constants exist on purpose:
 *   - {@link MOSS_PROJECTION_ENGINE_IDS} — the engines the SY2 materializer
 *     actually writes files for (symlink/copy/managed-bridge/adapter-inject).
 *     Kept at the two lead engines so real session startup (SY3
 *     `refreshMossWorkspaceProjections`) never writes projection files into the
 *     ACP-family / opencode / pi native trees. Those engines land their
 *     one wired surface (MCP) through the runtime, not the filesystem.
 *   - {@link MOSS_GOVERNANCE_ENGINE_IDS} — every active provider. This is the
 *     coverage set the governance table and its tests iterate: every engine has
 *     a real mapping row, and no engine returns `unsupported` with empty
 *     mappings (SY8 A1).
 *
 * Native-surface model per engine family (SY8 A2):
 *   - codex / claudeAgent: full native trees (symlink / managed-bridge /
 *     adapter-inject), materialized by SY2.
 *   - cursor / gemini / grok / devin (ACP family): MCP lands natively through the ACP
 *     `session/new` (and `session/load`) `mcpServers` handshake — expressed as
 *     `adapter-inject` and wired for real in SY8 A3 via
 *     `deriveMossAcpMcpServers` at the ACP session runtime. Every other kind has
 *     no native project surface in moss's ACP integration, so it falls back to
 *     `prompt-inject` with a warning that names the engine + resource.
 *   - opencode / pi: MCP lands natively through each engine's own config
 *     surface (`managed-bridge` to `opencode.json` / `.pi/config.json`).
 *     Instruction files that these engines read natively
 *     (`AGENTS.md`) map to `symlink`. Everything else falls back to
 *     `prompt-inject` with a named warning. These bridges are declarative target
 *     mappings surfaced to the projection summary; the SY2 materializer does not
 *     write them (they are outside `MOSS_PROJECTION_ENGINE_IDS`), so no runtime
 *     path claims an unwired file bridge.
 *
 * Deliberately not ported from 1code: scope precedence ranks, approval
 * machinery, and conflict-winner resolution. Moss currently projects
 * moss-scope resources only, where those mechanisms are behavior-neutral
 * (every 1code moss resource had rank 0/no approval); porting them now would
 * create dormant code with no caller (review rule R1).
 */
import { basename, dirname, join } from "node:path";

import {
  ProviderKind,
  SUPPORTED_PROVIDER_KINDS,
  isSupportedProviderKind,
  type MossProjectionAction,
  type SupportedProviderKind,
} from "@synara/contracts";

import {
  MOSS_PLUGIN_COMPONENT_KINDS,
  type MossPluginComponentKind,
  type MossSharedResource,
} from "./mossResourceRegistry";

export { MOSS_PLUGIN_COMPONENT_KINDS } from "./mossResourceRegistry";

/**
 * Engines the SY2 materializer writes projection files for. Kept at the two
 * lead engines so real session startup never touches the ACP / opencode
 * / pi native trees on disk. Do NOT widen this to the full provider set — that
 * would make `refreshMossWorkspaceProjections` write bridges into every other
 * providers' directories on every session start.
 */
export const MOSS_PROJECTION_ENGINE_IDS = [
  "codex",
  "claudeAgent",
] as const satisfies ReadonlyArray<ProviderKind>;
export type MossProjectionEngineId = (typeof MOSS_PROJECTION_ENGINE_IDS)[number];

/**
 * Full governance coverage set: every `ProviderKind` engine has a mapping row.
 * This is the set the governance table and its tests iterate for SY8 A1
 * (no engine returns `unsupported` + empty mappings).
 */
export const MOSS_GOVERNANCE_ENGINE_IDS = SUPPORTED_PROVIDER_KINDS;
export type MossGovernanceEngineId = (typeof MOSS_GOVERNANCE_ENGINE_IDS)[number];

/** Engine families that share a native-surface strategy. */
type MossEngineFamily = "codex" | "claude" | "acp" | "config-file";

export interface MossEngineNativeTargets {
  /** Human label used in mapping reason strings. */
  readonly label: string;
  /** Native-surface family that drives which kinds land natively. */
  readonly family: MossEngineFamily;
  /** Project instruction file the engine reads natively (undefined = none). */
  readonly instructionFile?: string;
  readonly memoryRoot?: string;
  readonly skillsRoot?: string;
  readonly subagentsRoot?: string;
  readonly hooksRoot?: string;
  /** Native target for the canonical Moss MCP config. */
  readonly mcpBridge?: string;
  /** Native target for provider routing/credentials. */
  readonly providerBridge?: string;
}

/**
 * Single source for provider-native target paths (repo-relative). Every
 * projection mapping and every test asserts through these constants. Every one
 * `ProviderKind` engine has an entry.
 *
 * Uses `satisfies` (not a `Record<…>` annotation) so per-engine literal types
 * are preserved: the two lead engines' required fields (`hooksRoot`,
 * `skillsRoot`, …) stay typed `string`, not `string | undefined`, for callers
 * that materialize them.
 */
export const MOSS_ENGINE_NATIVE_TARGETS = {
  codex: {
    label: "Codex",
    family: "codex",
    instructionFile: "AGENTS.md",
    memoryRoot: ".codex/memories",
    skillsRoot: ".codex/skills",
    subagentsRoot: ".codex/agents",
    hooksRoot: ".codex/hooks",
    mcpBridge: ".codex/config.toml",
    providerBridge: ".codex/config.toml",
  },
  claudeAgent: {
    label: "Claude Agent",
    family: "claude",
    instructionFile: "CLAUDE.md",
    memoryRoot: ".claude/memory",
    skillsRoot: ".claude/skills",
    subagentsRoot: ".claude/agents",
    hooksRoot: ".claude/hooks",
    mcpBridge: ".mcp.json",
    providerBridge: ".claude/settings.local.json",
  },
  cursor: {
    label: "Cursor",
    family: "acp",
    // ACP family: MCP is injected through the session/new handshake, not a
    // file. See deriveMossAcpMcpServers + AcpSessionRuntime (SY8 A3).
    mcpBridge: "session/new mcpServers",
  },
  gemini: {
    label: "Gemini",
    family: "acp",
    mcpBridge: "session/new mcpServers",
  },
  antigravity: {
    label: "Antigravity",
    family: "acp",
    mcpBridge: "session/new mcpServers",
  },
  hermes: { label: "Hermes", family: "acp", mcpBridge: "session/new mcpServers" },
  grok: {
    label: "Grok",
    family: "acp",
    mcpBridge: "session/new mcpServers",
  },
  devin: {
    label: "Devin",
    family: "acp",
    mcpBridge: "session/new mcpServers",
  },
  opencode: {
    label: "OpenCode",
    family: "config-file",
    instructionFile: "AGENTS.md",
    mcpBridge: "opencode.json",
  },
  pi: {
    label: "Pi",
    family: "config-file",
    mcpBridge: ".pi/config.json",
  },
  omp: {
    label: "Oh My Pi",
    family: "config-file",
    mcpBridge: ".pi/config.json",
  },
  kimi: { label: "Kimi Code", family: "acp", mcpBridge: "session/new mcpServers" },
  minimax: { label: "MiniMax Code", family: "acp", mcpBridge: "session/new mcpServers" },
  zcode: { label: "ZCode", family: "acp", mcpBridge: "session/new mcpServers" },
} satisfies Record<SupportedProviderKind, MossEngineNativeTargets>;

export type MossPluginProjectionMode = "native" | "adapter" | "display-only";
export type MossPluginExecutionMode = "native" | "adapter" | "none";

export interface MossPluginProviderCapability {
  /** How Moss can surface this component to the provider. */
  readonly projection: MossPluginProjectionMode;
  /** What is actually executable, independent of catalog/UI visibility. */
  readonly execution: MossPluginExecutionMode;
  readonly target?: string | undefined;
  readonly reason: string;
}

function pluginCapability(
  projection: MossPluginProjectionMode,
  execution: MossPluginExecutionMode,
  reason: string,
  target?: string,
): MossPluginProviderCapability {
  return { projection, execution, ...(target ? { target } : {}), reason };
}

const CODEX_PLUGIN_CAPABILITIES: Record<MossPluginComponentKind, MossPluginProviderCapability> = {
  skill: pluginCapability(
    "native",
    "native",
    "Codex reads projected Moss skill directories.",
    ".codex/skills",
  ),
  mcp: pluginCapability(
    "adapter",
    "native",
    "Moss injects MCP into Codex's native MCP surface.",
    ".codex/config.toml",
  ),
  hook: pluginCapability(
    "adapter",
    "adapter",
    "Moss hook trust/runtime adapts hook events for Codex.",
    ".codex/hooks",
  ),
  app: pluginCapability(
    "display-only",
    "none",
    "Plugin apps are catalog metadata; no Moss app connector executor is wired.",
  ),
  subagent: pluginCapability(
    "native",
    "native",
    "Codex reads projected Moss subagent definitions.",
    ".codex/agents",
  ),
  asset: pluginCapability(
    "display-only",
    "none",
    "Plugin assets are presentation inputs and are never executable.",
  ),
  permission: pluginCapability(
    "adapter",
    "adapter",
    "Moss translates plugin permission declarations into the Codex launch policy.",
    ".codex/config.toml",
  ),
};

const CLAUDE_PLUGIN_CAPABILITIES: Record<MossPluginComponentKind, MossPluginProviderCapability> = {
  skill: pluginCapability(
    "native",
    "native",
    "Claude Agent reads projected Moss skill directories.",
    ".claude/skills",
  ),
  mcp: pluginCapability(
    "adapter",
    "native",
    "Moss injects MCP into Claude Agent's native MCP surface.",
    ".mcp.json",
  ),
  hook: pluginCapability(
    "adapter",
    "adapter",
    "Moss hook trust/runtime adapts hook events for Claude Agent.",
    ".claude/hooks",
  ),
  app: pluginCapability(
    "display-only",
    "none",
    "Plugin apps are catalog metadata; no Moss app connector executor is wired.",
  ),
  subagent: pluginCapability(
    "native",
    "native",
    "Claude Agent reads projected Moss subagent definitions.",
    ".claude/agents",
  ),
  asset: pluginCapability(
    "display-only",
    "none",
    "Plugin assets are presentation inputs and are never executable.",
  ),
  permission: pluginCapability(
    "adapter",
    "adapter",
    "Moss translates plugin permission declarations into Claude Agent settings.",
    ".claude/settings.local.json",
  ),
};

const ACP_PLUGIN_CAPABILITIES: Record<MossPluginComponentKind, MossPluginProviderCapability> = {
  skill: pluginCapability(
    "adapter",
    "adapter",
    "ACP providers have no native Moss plugin skill loader; Moss injects validated Skill text into the session prompt.",
  ),
  mcp: pluginCapability(
    "adapter",
    "native",
    "Moss injects MCP through the ACP session/new mcpServers handshake.",
    "session/new mcpServers",
  ),
  hook: pluginCapability(
    "display-only",
    "none",
    "ACP hook execution is not wired; displaying the declaration is not execution.",
  ),
  app: pluginCapability("display-only", "none", "ACP plugin apps are catalog metadata only."),
  subagent: pluginCapability(
    "display-only",
    "none",
    "ACP subagent definitions do not create Moss threads or native ACP agents.",
  ),
  asset: pluginCapability(
    "display-only",
    "none",
    "Plugin assets are presentation inputs and are never executable.",
  ),
  permission: pluginCapability(
    "display-only",
    "none",
    "ACP permission declarations are advisory until an adapter owns enforcement.",
  ),
};

function configFilePluginCapabilities(
  mcpTarget: string,
): Record<MossPluginComponentKind, MossPluginProviderCapability> {
  return {
    skill: pluginCapability(
      "adapter",
      "adapter",
      "The config-file provider has no native Moss plugin skill loader; Moss injects validated Skill text into the session prompt.",
    ),
    mcp: pluginCapability(
      "adapter",
      "native",
      "Moss writes or injects the provider MCP bridge through its adapter.",
      mcpTarget,
    ),
    hook: pluginCapability(
      "display-only",
      "none",
      "Provider hook execution is not wired for bundled plugin hooks.",
    ),
    app: pluginCapability("display-only", "none", "Plugin apps are catalog metadata only."),
    subagent: pluginCapability(
      "display-only",
      "none",
      "Bundled subagents do not create Moss threads or provider-native agents.",
    ),
    asset: pluginCapability(
      "display-only",
      "none",
      "Plugin assets are presentation inputs and are never executable.",
    ),
    permission: pluginCapability(
      "display-only",
      "none",
      "Permission declarations are advisory until a provider adapter owns enforcement.",
    ),
  };
}

/**
 * Explicit plugin component capability matrix for active Moss providers.
 * `projection` describes visibility/bridging; `execution` is a separate gate
 * so a catalog row or prompt context can never be reported as execution.
 */
export const MOSS_PLUGIN_CAPABILITY_MATRIX = {
  codex: CODEX_PLUGIN_CAPABILITIES,
  claudeAgent: CLAUDE_PLUGIN_CAPABILITIES,
  cursor: ACP_PLUGIN_CAPABILITIES,
  gemini: ACP_PLUGIN_CAPABILITIES,
  antigravity: {
    ...ACP_PLUGIN_CAPABILITIES,
    mcp: pluginCapability(
      "display-only",
      "none",
      "Antigravity has no provider-owned plugin MCP handshake or installation adapter; plugin MCP stays unsupported.",
    ),
  },
  grok: ACP_PLUGIN_CAPABILITIES,
  hermes: ACP_PLUGIN_CAPABILITIES,
  devin: ACP_PLUGIN_CAPABILITIES,
  opencode: configFilePluginCapabilities("opencode.json"),
  pi: configFilePluginCapabilities(".pi/config.json"),
  omp: configFilePluginCapabilities(".pi/config.json"),
  kimi: ACP_PLUGIN_CAPABILITIES,
  minimax: ACP_PLUGIN_CAPABILITIES,
  zcode: ACP_PLUGIN_CAPABILITIES,
} satisfies Record<
  SupportedProviderKind,
  Record<MossPluginComponentKind, MossPluginProviderCapability>
>;

export function getMossPluginCapability(
  engineId: ProviderKind,
  componentKind: MossPluginComponentKind,
): MossPluginProviderCapability {
  if (!isSupportedProviderKind(engineId)) {
    return pluginCapability(
      "display-only",
      "none",
      `Provider '${engineId}' is no longer supported by Moss.`,
    );
  }
  return MOSS_PLUGIN_CAPABILITY_MATRIX[engineId][componentKind];
}

/** A small invariant helper used by importers before they accept a component. */
export function isMossPluginComponentKind(value: string): value is MossPluginComponentKind {
  return (MOSS_PLUGIN_COMPONENT_KINDS as ReadonlyArray<string>).includes(value);
}

export interface MossResourcePathMapping {
  readonly resourceId: string;
  readonly action: MossProjectionAction;
  readonly sourcePath?: string;
  readonly targetPath?: string;
  readonly reason?: string;
}

export interface MossEngineResourceProjection {
  readonly engineId: ProviderKind;
  readonly status: "ready" | "partial" | "unsupported";
  readonly mappings: ReadonlyArray<MossResourcePathMapping>;
  readonly warnings: ReadonlyArray<string>;
}

/**
 * Whether an engine is materialized on disk by the SY2 materializer. The
 * governance table covers every engine; only these two are written to the
 * filesystem during session startup.
 */
export function isMossProjectionEngineId(
  engineId: ProviderKind,
): engineId is MossProjectionEngineId {
  return (MOSS_PROJECTION_ENGINE_IDS as ReadonlyArray<ProviderKind>).includes(engineId);
}

function getMossRole(resource: MossSharedResource): string | undefined {
  const role = resource.metadata.mossRole;
  return typeof role === "string" ? role : undefined;
}

function getMossEntryName(resource: MossSharedResource): string {
  const entryName = resource.metadata.entryName;
  if (typeof entryName === "string" && entryName.trim()) {
    return entryName;
  }
  if (resource.path) return basename(resource.path);
  return resource.name;
}

/**
 * Skills are projected as whole directories: the registry records the
 * `SKILL.md` file but the symlink target is its parent skill directory.
 */
function getMossProjectionSourcePath(resource: MossSharedResource): string | undefined {
  const sourcePath = resource.path;
  if (!sourcePath) return undefined;
  if (resource.kind === "skill" && basename(sourcePath) === "SKILL.md") {
    return dirname(sourcePath);
  }
  return sourcePath;
}

/**
 * Prompt-inject fallback for a resource that has no native surface on this
 * engine. Records a warning that names the engine + resource so the SY8 A2 test
 * can observe the action/warning pair.
 */
function promptInjectFallback(
  resource: MossSharedResource,
  sourcePath: string,
  targets: MossEngineNativeTargets,
  warnings: string[],
): MossResourcePathMapping {
  const pluginCatalogOnly = resource.kind === "plugin";
  warnings.push(
    pluginCatalogOnly
      ? `${targets.label} plugin ${resource.id} is catalog/runtime plan only; no provider execution is claimed by filesystem projection.`
      : `${targets.label} has no native surface for ${resource.kind} resource ${resource.id}; injecting it as shared prompt/context instead.`,
  );
  return {
    resourceId: resource.id,
    action: "prompt-inject",
    sourcePath,
    reason: pluginCatalogOnly
      ? `Moss plugin metadata is available to the dedicated runtime/catalog for ${targets.label}; filesystem projection does not execute it.`
      : `Moss source is injected as shared prompt/context for ${targets.label}.`,
  };
}

/**
 * Full-native mapping for the two lead engines (codex, claudeAgent). Semantics
 * track 1code `buildMossProjectionMapping` row-for-row (minus plugins, which
 * moss does not have).
 */
function buildLeadEngineMapping(
  resource: MossSharedResource,
  sourcePath: string,
  role: string | undefined,
  entryName: string,
  targets: MossEngineNativeTargets,
  warnings: string[],
): MossResourcePathMapping {
  const engineLabel = targets.label;

  if (resource.kind === "instruction" && role === "source-instruction" && targets.instructionFile) {
    return {
      resourceId: resource.id,
      action: "symlink",
      sourcePath,
      targetPath: targets.instructionFile,
      reason: `${engineLabel} reads project instructions from ${targets.instructionFile}.`,
    };
  }
  if (resource.kind === "memory" && targets.memoryRoot) {
    if (role === "memory-entry") {
      return {
        resourceId: resource.id,
        action: "native",
        sourcePath,
        targetPath: join(targets.memoryRoot, entryName),
        reason: `${engineLabel} sees this entry through the projected Moss memory root.`,
      };
    }
    return {
      resourceId: resource.id,
      action: "symlink",
      sourcePath,
      targetPath: targets.memoryRoot,
      reason: `${engineLabel} project memory is mapped to Moss memory.`,
    };
  }
  if (resource.kind === "skill" && targets.skillsRoot) {
    return {
      resourceId: resource.id,
      action: "symlink",
      sourcePath,
      targetPath: join(targets.skillsRoot, entryName.replace(/\/SKILL\.md$/, "")),
      reason: `${engineLabel} skills are projected from Moss skills.`,
    };
  }
  if (resource.kind === "subagent" && targets.subagentsRoot) {
    return {
      resourceId: resource.id,
      action: "symlink",
      sourcePath,
      targetPath: join(targets.subagentsRoot, entryName),
      reason: `${engineLabel} subagents are projected from Moss subagents.`,
    };
  }
  if (resource.kind === "mcp" && targets.mcpBridge) {
    return {
      resourceId: resource.id,
      action: "managed-bridge",
      sourcePath,
      targetPath: targets.mcpBridge,
      reason: `Moss writes ${engineLabel}-compatible MCP config from the canonical Moss MCP config.`,
    };
  }
  if (resource.kind === "hook" && targets.hooksRoot) {
    return {
      resourceId: resource.id,
      action: "adapter-inject",
      sourcePath,
      targetPath: targets.hooksRoot,
      reason: `Moss adapts hook events to ${engineLabel}-compatible hooks without duplicating user config.`,
    };
  }
  if (resource.kind === "provider" && targets.providerBridge) {
    return {
      resourceId: resource.id,
      action: "managed-bridge",
      sourcePath,
      targetPath: targets.providerBridge,
      reason: `Moss bridges provider routing into ${engineLabel} native config.`,
    };
  }

  return promptInjectFallback(resource, sourcePath, targets, warnings);
}

/**
 * Mapping for the ACP family (cursor, gemini, grok, devin). The only native surface is
 * MCP, injected through the ACP `session/new` handshake (`adapter-inject`,
 * wired in SY8 A3). Every other kind falls back to prompt-inject.
 */
function buildAcpEngineMapping(
  engineId: SupportedProviderKind,
  resource: MossSharedResource,
  sourcePath: string,
  targets: MossEngineNativeTargets,
  warnings: string[],
): MossResourcePathMapping {
  if (
    resource.kind === "mcp" &&
    targets.mcpBridge &&
    MOSS_PLUGIN_CAPABILITY_MATRIX[engineId].mcp.execution !== "none"
  ) {
    return {
      resourceId: resource.id,
      action: "adapter-inject",
      sourcePath,
      targetPath: targets.mcpBridge,
      reason: `Moss injects the canonical Moss MCP config into ${targets.label}'s ACP session/new mcpServers handshake.`,
    };
  }
  if (resource.kind === "mcp" && engineId === "antigravity") {
    warnings.push(
      `${targets.label} plugin MCP ${resource.id} is unsupported: no Antigravity plugin MCP adapter or session handshake is wired.`,
    );
    return {
      resourceId: resource.id,
      action: "unsupported",
      sourcePath,
      reason: "Antigravity has no provider-owned plugin MCP execution surface.",
    };
  }
  return promptInjectFallback(resource, sourcePath, targets, warnings);
}

/**
 * Mapping for config-file engines (opencode, pi). MCP lands natively
 * through each engine's own config surface (declarative `managed-bridge`
 * target; not materialized by SY2). Instruction files that these engines read
 * natively map to `symlink`. Everything else falls back to prompt-inject.
 */
function buildConfigFileEngineMapping(
  resource: MossSharedResource,
  sourcePath: string,
  role: string | undefined,
  targets: MossEngineNativeTargets,
  warnings: string[],
): MossResourcePathMapping {
  if (resource.kind === "instruction" && role === "source-instruction" && targets.instructionFile) {
    return {
      resourceId: resource.id,
      action: "symlink",
      sourcePath,
      targetPath: targets.instructionFile,
      reason: `${targets.label} reads project instructions from ${targets.instructionFile}.`,
    };
  }
  if (resource.kind === "mcp" && targets.mcpBridge) {
    return {
      resourceId: resource.id,
      action: "managed-bridge",
      sourcePath,
      targetPath: targets.mcpBridge,
      reason: `Moss maps the canonical Moss MCP config onto ${targets.label}'s native ${targets.mcpBridge} config surface.`,
    };
  }
  return promptInjectFallback(resource, sourcePath, targets, warnings);
}

/**
 * Per-resource projection mapping for one engine. Dispatches on the engine's
 * native-surface family.
 */
function buildMossProjectionMapping(
  engineId: SupportedProviderKind,
  resource: MossSharedResource,
  warnings: string[],
): MossResourcePathMapping | null {
  const sourcePath = getMossProjectionSourcePath(resource);
  if (!sourcePath) return null;

  const role = getMossRole(resource);

  // The workspace config (`.moss/config.json`) drives the SY3 launch plan, not
  // provider prompt/context. It is not a projectable resource on any engine, so
  // it produces neither a mapping nor a warning.
  if (role === "workspace-config") return null;

  const entryName = getMossEntryName(resource);
  const targets = MOSS_ENGINE_NATIVE_TARGETS[engineId];

  switch (targets.family) {
    case "codex":
    case "claude":
      return buildLeadEngineMapping(resource, sourcePath, role, entryName, targets, warnings);
    case "acp":
      return buildAcpEngineMapping(engineId, resource, sourcePath, targets, warnings);
    case "config-file":
      return buildConfigFileEngineMapping(resource, sourcePath, role, targets, warnings);
  }
}

/**
 * Build the projection mapping set for one engine. Resources with
 * `enabled === false` are withheld silently (mirrors 1code
 * `canProjectResource`). Retired providers return an explicit unsupported
 * result; active engines emit real mappings or named prompt-injection fallbacks.
 */
export function buildMossEngineProjection(
  engineId: ProviderKind,
  resources: ReadonlyArray<MossSharedResource>,
): MossEngineResourceProjection {
  if (!isSupportedProviderKind(engineId)) {
    return {
      engineId,
      status: "unsupported",
      mappings: [],
      warnings: [`Provider '${engineId}' is no longer supported by Moss.`],
    };
  }
  const mappings: MossResourcePathMapping[] = [];
  const warnings: string[] = [];

  for (const resource of resources) {
    if (!resource.path) continue;
    if (resource.enabled === false) continue;

    const mapping = buildMossProjectionMapping(engineId, resource, warnings);
    if (mapping) mappings.push(mapping);
  }

  return {
    engineId,
    status: warnings.length > 0 ? "partial" : "ready",
    mappings,
    warnings,
  };
}
