// FILE: claudeConfiguredModel.ts
// Purpose: The model a person set as their Claude Code default (`model` in
//          `<CLAUDE_CONFIG_DIR | ~/.claude>/settings.json`), matched onto the discovered catalog.
// Layer: Provider model discovery (server). Only settings.json is read, never credentials.

import * as fs from "node:fs/promises";
import { homedir } from "node:os";
import * as nodePath from "node:path";

import type { ProviderListModelsResult } from "@moss/contracts";

export function claudeSettingsPath(env: NodeJS.ProcessEnv): string {
  const configDir = env.CLAUDE_CONFIG_DIR?.trim();
  if (configDir) return nodePath.join(configDir, "settings.json");
  const home = env.HOME?.trim() || env.USERPROFILE?.trim() || homedir();
  return nodePath.join(home, ".claude", "settings.json");
}

export async function readClaudeSettingsModel(env: NodeJS.ProcessEnv): Promise<string | undefined> {
  try {
    const settings: unknown = JSON.parse(await fs.readFile(claudeSettingsPath(env), "utf8"));
    if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
    const model = (settings as Record<string, unknown>).model;
    return typeof model === "string" && model.trim().length > 0 ? model.trim() : undefined;
  } catch {
    return undefined;
  }
}

/**
 * The catalog entry the configured model names: an alias (`opus`), a full id the SDK resolves
 * an alias to (`claude-opus-4-8`), compared without case. Undefined when nothing matches.
 */
export function matchClaudeConfiguredModel(
  models: ProviderListModelsResult["models"],
  configured: string | undefined,
): string | undefined {
  const wanted = configured?.trim().toLowerCase();
  if (!wanted) return undefined;
  const bySlug = models.find((model) => model.slug.toLowerCase() === wanted);
  if (bySlug) return bySlug.slug;
  return models.find((model) => model.resolvedModel?.toLowerCase() === wanted)?.slug;
}
