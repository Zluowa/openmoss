// FILE: codexMossWebSearch.ts
// Purpose: The web search mode a Codex thread on Moss's own models runs with.
// Layer: Provider runtime policy (pure)
// Exports: mossCodexWebSearchMode, withMossCodexWebSearchMode

import type { RuntimeMode } from "@moss/contracts";

/**
 * Codex picks its web search mode from the sandbox: live in full access,
 * otherwise "cached", which is OpenAI's own offline search index. Moss's
 * models run on other vendors that have no such index, and gateways before
 * the 2026-11-05 translation refuse the whole turn when Codex asks for it
 * ("The model cannot represent these tool definitions or tool choices.").
 * Outside full access the safe equivalent of a cached-only search is no
 * hosted search at all, so a Moss thread says so explicitly; full access
 * keeps Codex's own live default.
 */
export function mossCodexWebSearchMode(input: {
  readonly accountId: string | undefined;
  readonly runtimeMode: RuntimeMode;
}): "disabled" | undefined {
  if (input.accountId?.trim() !== "moss") return undefined;
  return input.runtimeMode === "full-access" ? undefined : "disabled";
}

/** Adds the Moss web search mode to a thread's config overrides, when one applies. */
export function withMossCodexWebSearchMode<T extends Record<string, unknown>>(
  config: T | undefined,
  input: Parameters<typeof mossCodexWebSearchMode>[0],
): (T & { readonly web_search?: "disabled" }) | undefined {
  const mode = mossCodexWebSearchMode(input);
  if (mode === undefined) return config;
  return { ...config, web_search: mode } as T & { readonly web_search: "disabled" };
}
