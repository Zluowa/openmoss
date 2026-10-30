// FILE: mossContextInjection.ts
// Purpose: Wraps the shared Moss runtime-context builder into the provider
//          bootstrap text channel. Mirrors skillPromptInjection.ts: a pure
//          async helper the ProviderCommandReactor calls while assembling the
//          first turn of a session, with a hard char budget so the moss block
//          can never overflow the provider turn limit.
// Layer: Server provider helper
// Exports: buildMossContextBootstrapText, MOSS_CONTEXT_BLOCK_PREFIX

import type { ProviderKind } from "@synara/contracts";
import {
  MOSS_CONTEXT_TRUNCATION_MARKER,
  MOSS_DEFAULT_MAX_CONTEXT_CHARS,
  buildMossRuntimeContext,
} from "@synara/shared/mossRuntimeContext";

export const MOSS_CONTEXT_BLOCK_PREFIX = '<moss_context fingerprint="sha256:';

// Wrapper size with a 64-hex fingerprint and empty body; the builder budget is
// reduced by this so `block.length <= maxChars` holds by construction.
const MOSS_CONTEXT_WRAPPER_OVERHEAD =
  `${MOSS_CONTEXT_BLOCK_PREFIX}${"0".repeat(64)}">\n\n</moss_context>`.length;

// Below this many usable context chars the hydrated block would be all header
// and no memory; skip injection instead of sending a useless stub.
const MOSS_CONTEXT_MIN_CONTEXT_CHARS = 256;

export interface MossContextBootstrap {
  /** Full `<moss_context fingerprint="sha256:...">...</moss_context>` block. */
  readonly text: string;
  /** 64-hex sha256 fingerprint of the hydrated context (no `sha256:` prefix). */
  readonly fingerprint: string;
  readonly resourceCount: number;
  readonly includedResourceCount: number;
  readonly warnings: ReadonlyArray<string>;
}

// Returns null when there is nothing to inject: no `.moss` source, an empty
// hydrated text, or a budget too small to carry meaningful context. Builder
// errors are NOT caught here — the reactor owns degradation (log + dispatch
// the turn without moss context), mirroring the inline-skill error handling.
export async function buildMossContextBootstrapText(input: {
  readonly cwd: string;
  readonly provider: ProviderKind;
  readonly maxChars: number;
}): Promise<MossContextBootstrap | null> {
  // Clamp to the builder default so an uncrowded first turn produces exactly
  // the same text/fingerprint as a default-parameter rebuild over the same
  // `.moss` tree (keeps logged fingerprints independently verifiable).
  const maxContextChars = Math.min(
    MOSS_DEFAULT_MAX_CONTEXT_CHARS,
    input.maxChars - MOSS_CONTEXT_WRAPPER_OVERHEAD - MOSS_CONTEXT_TRUNCATION_MARKER.length,
  );
  if (maxContextChars < MOSS_CONTEXT_MIN_CONTEXT_CHARS) {
    return null;
  }

  const context = await buildMossRuntimeContext({
    projectPath: input.cwd,
    provider: input.provider,
    maxContextChars,
  });
  if (
    context.status !== "ready" ||
    context.includedResourceCount === 0 ||
    context.text.trim().length === 0
  ) {
    return null;
  }

  return {
    text: `${MOSS_CONTEXT_BLOCK_PREFIX}${context.fingerprint}">\n${context.text}\n</moss_context>`,
    fingerprint: context.fingerprint,
    resourceCount: context.resourceCount,
    includedResourceCount: context.includedResourceCount,
    warnings: context.warnings,
  };
}
