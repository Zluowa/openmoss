// FILE: mossCreateResource.ts
// Purpose: Write a canonical Moss resource (skill / plugin / MCP server) under
//          the workspace `.moss` tree. This is the backend of the uniform
//          "Create" surface: authoring always targets the single canonical
//          source, and existing discovery fans it out to every engine — the
//          skills catalog cross-scans `.moss/skills`, and `.moss/mcp/config.json`
//          is injected into Codex/Claude sessions. Never overwrites an existing
//          artifact; returns `created: false` when the name is already taken.
// Layer: Server provider helper
// Exports: createMossResource

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

import type {
  MossCreateResourcePayload,
  MossCreateResourceResult,
  MossDeleteResourcePayload,
  MossDeleteResourceResult,
  MossUpdateResourcePayload,
  MossUpdateResourceResult,
} from "@synara/contracts";
import { getMossSourceLayout } from "@synara/shared/mossSourceLayout";
import { isSafeEntryName } from "@synara/shared/mossResourceRegistry";
import { discoverMossPluginRuntime } from "./mossPluginRuntime.ts";
import { notifyMossPluginApprovalChanged } from "./mossPluginApprovalService.ts";

export class MossCreateResourceError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MossCreateResourceError";
  }
}

/** Filesystem-safe slug for a directory/server name; preserves readability. */
export function slugifyResourceName(name: string): string {
  return name
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64);
}

async function pathExists(path: string): Promise<boolean> {
  try {
    await fs.access(path);
    return true;
  } catch {
    return false;
  }
}

function skillMarkdown(input: { name: string; description: string }): string {
  const description = input.description || `The ${input.name} skill.`;
  return [
    "---",
    `name: ${input.name}`,
    `description: ${description}`,
    "enabled: true",
    "---",
    "",
    `# ${input.name}`,
    "",
    description,
    "",
    "## Steps",
    "",
    "1. Describe what this skill does, step by step.",
    "",
  ].join("\n");
}

async function createSkill(
  layout: ReturnType<typeof getMossSourceLayout>,
  input: MossCreateResourcePayload,
  slug: string,
): Promise<MossCreateResourceResult> {
  const dir = nodePath.join(layout.skillsRoot, slug);
  const skillPath = nodePath.join(dir, "SKILL.md");
  if (await pathExists(skillPath)) {
    return { kind: "skill", name: input.name, path: skillPath, created: false };
  }
  await fs.mkdir(dir, { recursive: true });
  await fs.writeFile(
    skillPath,
    skillMarkdown({ name: input.name, description: input.description ?? "" }),
    "utf8",
  );
  return { kind: "skill", name: input.name, path: skillPath, created: true };
}

async function createPlugin(
  layout: ReturnType<typeof getMossSourceLayout>,
  input: MossCreateResourcePayload,
  slug: string,
): Promise<MossCreateResourceResult> {
  const dir = nodePath.join(layout.pluginsRoot, slug);
  const manifestPath = nodePath.join(dir, "plugin.json");
  if (await pathExists(manifestPath)) {
    return { kind: "plugin", name: input.name, path: manifestPath, created: false };
  }
  await fs.mkdir(dir, { recursive: true });
  const plugin = input.plugin;
  const manifest = {
    ...(plugin?.id ? { id: plugin.id } : {}),
    name: input.name,
    ...(input.description ? { description: input.description } : {}),
    enabled: true,
    source: "moss-unified-source",
    ...(input.provider ? { provider: input.provider } : {}),
    ...(plugin?.marketplaceName || plugin?.marketplacePath || plugin?.sourcePath
      ? {
          providerSource: {
            ...(plugin.marketplaceName ? { marketplaceName: plugin.marketplaceName } : {}),
            ...(plugin.marketplacePath ? { marketplacePath: plugin.marketplacePath } : {}),
            ...(plugin.sourcePath ? { path: plugin.sourcePath } : {}),
          },
        }
      : {}),
    ...(plugin?.authPolicy ? { authPolicy: plugin.authPolicy } : {}),
    ...(plugin?.interface ? { interface: plugin.interface } : {}),
    ...(plugin?.apps && plugin.apps.length > 0 ? { apps: plugin.apps } : {}),
    ...(plugin?.skills && plugin.skills.length > 0 ? { skills: plugin.skills } : {}),
    ...(plugin?.mcpServers && plugin.mcpServers.length > 0
      ? { mcpServers: plugin.mcpServers }
      : {}),
  };
  await fs.writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, "utf8");
  return { kind: "plugin", name: input.name, path: manifestPath, created: true };
}

async function createMcp(
  layout: ReturnType<typeof getMossSourceLayout>,
  input: MossCreateResourcePayload,
): Promise<MossCreateResourceResult> {
  if (!input.command && !input.url) {
    throw new MossCreateResourceError("An MCP server needs a command or a url.");
  }
  const configPath = layout.mcpConfig;
  let config: { mcpServers?: Record<string, unknown> } = {};
  const existingRaw = await fs.readFile(configPath, "utf8").catch(() => null);
  if (existingRaw !== null) {
    try {
      const parsed = JSON.parse(existingRaw) as unknown;
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
        config = parsed as { mcpServers?: Record<string, unknown> };
      }
    } catch {
      throw new MossCreateResourceError(
        `Existing ${configPath} is not valid JSON; fix it before adding a server.`,
      );
    }
  }
  const servers: Record<string, unknown> = { ...config.mcpServers };
  if (Object.prototype.hasOwnProperty.call(servers, input.name)) {
    return { kind: "mcp", name: input.name, path: configPath, created: false };
  }
  servers[input.name] = {
    ...(input.command ? { command: input.command } : {}),
    ...(input.args && input.args.length > 0 ? { args: [...input.args] } : {}),
    ...(input.url ? { url: input.url } : {}),
  };
  const next = { ...config, mcpServers: servers };
  await fs.mkdir(nodePath.dirname(configPath), { recursive: true });
  await fs.writeFile(configPath, `${JSON.stringify(next, null, 2)}\n`, "utf8");
  return { kind: "mcp", name: input.name, path: configPath, created: true };
}

export async function createMossResource(
  input: MossCreateResourcePayload,
): Promise<MossCreateResourceResult> {
  const projectPath = input.cwd.trim();
  if (projectPath.length === 0) {
    throw new MossCreateResourceError("A workspace path is required to create a Moss resource.");
  }
  const name = input.name.trim();
  if (name.length === 0) {
    throw new MossCreateResourceError("A name is required.");
  }

  const layout = getMossSourceLayout(projectPath);

  if (input.kind === "mcp") {
    // MCP server names live in a JSON map, so they only need to be non-empty
    // (not a filesystem-safe directory name).
    return createMcp(layout, { ...input, name });
  }

  const slug = slugifyResourceName(name);
  if (slug.length === 0 || !isSafeEntryName(slug)) {
    throw new MossCreateResourceError(`"${name}" is not a valid resource name.`);
  }

  return input.kind === "skill"
    ? createSkill(layout, { ...input, name }, slug)
    : createPlugin(layout, { ...input, name }, slug);
}

// ── Uninstall (delete canonical) ─────────────────────────────────────

/** True when `target` is strictly inside `root` (never equal, never outside). */
function isStrictlyUnder(root: string, target: string): boolean {
  const rootResolved = nodePath.resolve(root);
  const targetResolved = nodePath.resolve(target);
  return (
    targetResolved !== rootResolved && targetResolved.startsWith(`${rootResolved}${nodePath.sep}`)
  );
}

async function deleteMcpServer(
  layout: ReturnType<typeof getMossSourceLayout>,
  name: string,
): Promise<MossDeleteResourceResult> {
  const configPath = layout.mcpConfig;
  const raw = await fs.readFile(configPath, "utf8").catch(() => null);
  if (raw === null) return { kind: "mcp", name, removed: false, path: configPath };
  let config: { mcpServers?: Record<string, unknown> };
  try {
    const parsed = JSON.parse(raw) as unknown;
    config = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new MossCreateResourceError(`Existing ${configPath} is not valid JSON.`);
  }
  const servers: Record<string, unknown> = { ...config.mcpServers };
  if (!Object.prototype.hasOwnProperty.call(servers, name)) {
    return { kind: "mcp", name, removed: false, path: configPath };
  }
  delete servers[name];
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, mcpServers: servers }, null, 2)}\n`,
  );
  return { kind: "mcp", name, removed: true, path: configPath };
}

/**
 * Remove a canonical Moss resource. Deletion is confined to the workspace
 * `.moss/{skills,plugins}` directory or a server entry in `.moss/mcp/config.json`
 * — a hard safety boundary that refuses any target outside the Moss root, so an
 * engine-native copy (e.g. `~/.codex/skills/x`) can never be deleted here.
 */
export async function deleteMossResource(
  input: MossDeleteResourcePayload,
): Promise<MossDeleteResourceResult> {
  const projectPath = input.cwd.trim();
  if (projectPath.length === 0) {
    throw new MossCreateResourceError("A workspace path is required.");
  }
  const layout = getMossSourceLayout(projectPath);

  if (input.kind === "mcp") {
    return deleteMcpServer(layout, input.name.trim());
  }

  const root = input.kind === "skill" ? layout.skillsRoot : layout.pluginsRoot;
  // Prefer the descriptor path (its parent dir is the resource dir); otherwise
  // derive the dir from the slugified name under the canonical root.
  const targetDir = input.path
    ? nodePath.dirname(nodePath.resolve(input.path))
    : nodePath.join(root, slugifyResourceName(input.name.trim()));

  if (!isStrictlyUnder(root, targetDir)) {
    throw new MossCreateResourceError(
      "Refusing to delete outside the Moss canonical root; disable the provider copy instead.",
    );
  }
  if (!(await pathExists(targetDir))) {
    return { kind: input.kind, name: input.name, removed: false, path: targetDir };
  }
  const deletedPluginId =
    input.kind === "plugin"
      ? (await discoverMossPluginRuntime({ cwd: projectPath })).plugins.find(
          (plugin) => nodePath.resolve(plugin.absolutePluginRoot) === nodePath.resolve(targetDir),
        )?.id
      : undefined;
  await fs.rm(targetDir, { recursive: true, force: true });
  if (deletedPluginId) {
    await notifyMossPluginApprovalChanged({
      cwd: projectPath,
      pluginId: deletedPluginId,
      enabled: false,
    });
  }
  return { kind: input.kind, name: input.name, removed: true, path: targetDir };
}

// ── Enable / disable (canonical only) ─────────────────────────────────

async function readJsonObject(path: string): Promise<Record<string, unknown> | null> {
  const raw = await fs.readFile(path, "utf8").catch(() => null);
  if (raw === null) return null;
  try {
    const parsed = JSON.parse(raw) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    throw new MossCreateResourceError(`Existing ${path} is not valid JSON.`);
  }
}

async function updatePluginEnabled(
  layout: ReturnType<typeof getMossSourceLayout>,
  input: MossUpdateResourcePayload,
): Promise<MossUpdateResourceResult> {
  const manifestPath = input.path
    ? nodePath.resolve(input.path)
    : nodePath.join(layout.pluginsRoot, slugifyResourceName(input.name.trim()), "plugin.json");

  if (!isStrictlyUnder(layout.pluginsRoot, manifestPath)) {
    throw new MossCreateResourceError(
      "Refusing to update outside the Moss canonical plugins root.",
    );
  }

  const manifest = await readJsonObject(manifestPath);
  if (manifest === null) {
    return {
      kind: "plugin",
      name: input.name,
      enabled: input.enabled,
      updated: false,
      path: manifestPath,
    };
  }
  await fs.writeFile(
    manifestPath,
    `${JSON.stringify({ ...manifest, enabled: input.enabled }, null, 2)}\n`,
    "utf8",
  );
  const projectPath = nodePath.dirname(layout.root);
  const pluginId = (await discoverMossPluginRuntime({ cwd: projectPath })).plugins.find(
    (plugin) => nodePath.resolve(plugin.absoluteManifestPath) === nodePath.resolve(manifestPath),
  )?.id;
  if (pluginId) {
    await notifyMossPluginApprovalChanged({
      cwd: projectPath,
      pluginId,
      enabled: input.enabled,
    });
  }
  return {
    kind: "plugin",
    name: input.name,
    enabled: input.enabled,
    updated: true,
    path: manifestPath,
  };
}

async function updateMcpEnabled(
  layout: ReturnType<typeof getMossSourceLayout>,
  input: MossUpdateResourcePayload,
): Promise<MossUpdateResourceResult> {
  const configPath = layout.mcpConfig;
  const config = await readJsonObject(configPath);
  if (config === null) {
    return {
      kind: "mcp",
      name: input.name,
      enabled: input.enabled,
      updated: false,
      path: configPath,
    };
  }
  const servers = config.mcpServers;
  if (!servers || typeof servers !== "object" || Array.isArray(servers)) {
    return {
      kind: "mcp",
      name: input.name,
      enabled: input.enabled,
      updated: false,
      path: configPath,
    };
  }
  const current = (servers as Record<string, unknown>)[input.name];
  if (!current || typeof current !== "object" || Array.isArray(current)) {
    return {
      kind: "mcp",
      name: input.name,
      enabled: input.enabled,
      updated: false,
      path: configPath,
    };
  }

  const nextServers = {
    ...(servers as Record<string, unknown>),
    [input.name]: { ...(current as Record<string, unknown>), enabled: input.enabled },
  };
  await fs.writeFile(
    configPath,
    `${JSON.stringify({ ...config, mcpServers: nextServers }, null, 2)}\n`,
    "utf8",
  );
  return { kind: "mcp", name: input.name, enabled: input.enabled, updated: true, path: configPath };
}

export async function updateMossResource(
  input: MossUpdateResourcePayload,
): Promise<MossUpdateResourceResult> {
  const projectPath = input.cwd.trim();
  if (projectPath.length === 0) {
    throw new MossCreateResourceError("A workspace path is required.");
  }
  const name = input.name.trim();
  if (name.length === 0) {
    throw new MossCreateResourceError("A name is required.");
  }
  const layout = getMossSourceLayout(projectPath);
  return input.kind === "plugin"
    ? updatePluginEnabled(layout, { ...input, name })
    : updateMcpEnabled(layout, { ...input, name });
}
