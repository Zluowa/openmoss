import type { ModelSelection, ProviderKind } from "@moss/contracts";
import { describe, expect, it } from "vitest";

import {
  resolveAuxiliaryTextGenerationSelection,
  supportsTextGeneration,
} from "./textGenerationCapabilities";

describe("auxiliary text-generation capabilities", () => {
  // Droid is retired: a stale Droid chat falls back like any provider without text generation.
  it.each(["antigravity", "grok", "pi", "devin", "droid"] satisfies ProviderKind[])(
    "falls back to configured text generation for unsupported %s chats",
    (provider) => {
      const modelSelection = {
        instanceId: `${provider}_work`,
        model: `${provider}-model`,
      } as ModelSelection;

      expect(supportsTextGeneration(provider)).toBe(false);
      expect(resolveAuxiliaryTextGenerationSelection({ provider, modelSelection })).toBeNull();
    },
  );

  it.each(["codex", "claudeAgent", "cursor", "opencode"] satisfies ProviderKind[])(
    "preserves the exact %s instance override",
    (provider) => {
      const modelSelection = {
        instanceId: `${provider}_work`,
        model: `${provider}-model`,
      } as ModelSelection;

      expect(resolveAuxiliaryTextGenerationSelection({ provider, modelSelection })).toBe(
        modelSelection,
      );
    },
  );
});
