// FILE: piCliModels.ts
// Purpose: Reads the default model a person picked in their own Pi: `defaultProvider` +
//          `defaultModel` in `<agentDir>/settings.json`.
// Layer: Provider model discovery (server).
//
// Moss lists Pi's models by asking the person's Pi CLI (`get_available_models`), which reads
// their models.json itself. Pi's own `get_state` always names some model, even one the person
// never chose, so the picker's default comes only from an explicit setting. Never reads auth.json.

import * as fs from "node:fs/promises";
import * as nodePath from "node:path";

/** `provider/model` from Pi's settings.json, if the person picked a default there. */
export function readPiDefaultModelFromSettings(settings: unknown): string | undefined {
  if (!settings || typeof settings !== "object" || Array.isArray(settings)) return undefined;
  const record = settings as Record<string, unknown>;
  const provider = typeof record.defaultProvider === "string" ? record.defaultProvider.trim() : "";
  const model = typeof record.defaultModel === "string" ? record.defaultModel.trim() : "";
  if (!model) return undefined;
  // Pi also accepts a provider-qualified defaultModel on its own.
  if (!provider) return model.includes("/") ? model : undefined;
  return model.startsWith(`${provider}/`) ? model : `${provider}/${model}`;
}

export async function readPiSettingsDefaultModel(agentDir: string): Promise<string | undefined> {
  try {
    const text = await fs.readFile(nodePath.join(agentDir, "settings.json"), "utf8");
    return readPiDefaultModelFromSettings(JSON.parse(text));
  } catch {
    return undefined;
  }
}
