// FILE: pluginImportError.ts
// Purpose: Map import failures to safe, localized UI keys without exposing native details.
// Layer: Web lib

import type { TranslationKey } from "~/localization";
import {
  isPluginImportAdapterError,
  isPluginImportDirectWriteError,
  type PluginImportFileAdapter,
  type PluginImportResourceKind,
} from "./pluginImportAdapter";

export type PluginImportFallbackKey =
  | "plugins.import.scan.failed"
  | "plugins.import.read.failed"
  | "plugins.import.progress.failed"
  | "plugins.import.rollback.failed";

export interface PluginImportAdapterResolution {
  readonly adapter: PluginImportFileAdapter | null;
  readonly errorKey: TranslationKey | null;
}

export function pluginImportErrorKey(
  error: unknown,
  fallbackKey: PluginImportFallbackKey,
  kind?: PluginImportResourceKind,
): TranslationKey {
  if (isPluginImportDirectWriteError(error)) {
    return kind === "mcp" ? "plugins.import.mcpApplyUnavailable" : "plugins.import.casUnavailable";
  }
  if (isPluginImportAdapterError(error)) return error.key;
  return fallbackKey;
}

export function resolvePluginImportAdapter(
  resolve: () => PluginImportFileAdapter | null,
  fallbackKey: PluginImportFallbackKey,
  kind?: PluginImportResourceKind,
): PluginImportAdapterResolution {
  try {
    return { adapter: resolve(), errorKey: null };
  } catch (error) {
    return { adapter: null, errorKey: pluginImportErrorKey(error, fallbackKey, kind) };
  }
}
