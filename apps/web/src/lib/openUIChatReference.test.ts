// FILE: openUIChatReference.test.ts
// Purpose: Drift gate between the live @openuidev/react-ui chat library and the
//          generated catalog committed at
//          apps/server/src/agentGateway/openUIChatReference.generated.ts (served by
//          the openui_reference tool). If the library or the intro contract changes,
//          regenerate with: bun scripts/generateOpenUIChatReference.ts (from apps/web).

import { readFileSync } from "node:fs";

import { describe, expect, it } from "vitest";

import {
  buildOpenUIChatExamples,
  buildOpenUIChatReference,
  buildOpenUIChatReferenceCore,
  MOSS_OPENUI_REFERENCE_INTRO,
} from "./openUIChatReference";

const GENERATED_MODULE_PATH = new URL(
  "../../../server/src/agentGateway/openUIChatReference.generated.ts",
  import.meta.url,
);

function readCommittedExport(moduleText: string, name: string): string {
  const marker = `export const ${name} =`;
  const markerAt = moduleText.indexOf(marker);
  if (markerAt === -1) {
    throw new Error(
      `openUIChatReference.generated.ts lost its ${name} export — regenerate it from apps/web.`,
    );
  }
  // The committed file is formatter-normalized (quote style and line wrapping are
  // oxfmt's), so evaluate the exported string literal as JS instead of assuming a
  // serialization. The input is this repo's own generated artifact, not user data.
  // Stop at the next export (or EOF) so multi-constant modules parse cleanly.
  const nextExport = moduleText.indexOf("export const ", markerAt + marker.length);
  const literal = moduleText
    .slice(markerAt + marker.length, nextExport === -1 ? undefined : nextExport)
    .trim()
    .replace(/;\s*$/u, "");
  return new Function(`"use strict"; return (${literal});`)() as string;
}

function readCommittedModule(): { reference: string; examples: string } {
  const moduleText = readFileSync(GENERATED_MODULE_PATH, "utf8");
  return {
    reference: readCommittedExport(moduleText, "OPENUI_CHAT_REFERENCE"),
    examples: readCommittedExport(moduleText, "OPENUI_CHAT_REFERENCE_EXAMPLES"),
  };
}

describe("buildOpenUIChatReference", () => {
  it("opens with the Moss inline-chat contract and keeps the catalog sections", () => {
    const reference = buildOpenUIChatReference();
    expect(reference.startsWith(MOSS_OPENUI_REFERENCE_INTRO)).toBe(true);
    expect(reference).not.toContain("Your ENTIRE response must be valid openui-lang code");
    expect(reference).toContain("## Syntax Rules");
    expect(reference).toContain("## Component Signatures");
    expect(reference).toContain("## Examples");
    // The fence Moss's markdown pipeline recognizes is ```openui — never the
    // stock prompt's ```openui-lang inline-mode block (we do not enable it).
    expect(reference).toContain("```openui");
    expect(reference).not.toContain("## Inline Mode");
  });

  it("serves a compact core: signatures and rules without the worked examples", () => {
    const core = buildOpenUIChatReferenceCore();
    expect(core.startsWith(MOSS_OPENUI_REFERENCE_INTRO)).toBe(true);
    expect(core).toContain("## Component Signatures");
    expect(core).toContain("## Important Rules");
    // Examples are replaced by a pointer to the sectioned fetch.
    expect(core).not.toContain("Example 1 —");
    expect(core).toContain('"section": "examples"');
    // Container child unions collapse to the ContentBlock alias.
    expect(core).toContain("ContentBlock");
    expect(core.length).toBeLessThan(buildOpenUIChatReference().length);
  });

  it("keeps the worked examples intact in the on-demand section", () => {
    const examples = buildOpenUIChatExamples();
    expect(examples.startsWith("## Examples")).toBe(true);
    expect(examples).toContain("Example 1 —");
    expect(examples).toContain("root = Card(");
  });

  it("matches the committed generated module the server ships", () => {
    // When this fails after an @openuidev/react-ui bump, run the generator —
    // do not edit the generated file by hand.
    const committed = readCommittedModule();
    expect(committed.reference).toBe(buildOpenUIChatReferenceCore());
    expect(committed.examples).toBe(buildOpenUIChatExamples());
  });
});
