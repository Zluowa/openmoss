// FILE: deck-model-type-compatibility.test.ts
// Purpose: Check the shared deck model under both Moss and Canvas nullability rules.
// Layer: Cross-repository model compatibility

import path from "node:path";
import ts from "typescript";
import { describe, expect, it } from "vitest";

const modelDir = path.resolve(import.meta.dirname, "../packages/shared/src/spaceItems");
const rootNames = ["slidesDeck", "deckOps", "deckLayouts", "deckThemes"].map((name) =>
  path.join(modelDir, `${name}.ts`),
);

describe("deck model compiler compatibility", () => {
  it.each([false, true])(
    "compiles with strictNullChecks=%s",
    (strict) => {
      const program = ts.createProgram(rootNames, {
        target: ts.ScriptTarget.ES2023,
        module: ts.ModuleKind.ESNext,
        moduleResolution: ts.ModuleResolutionKind.Bundler,
        strict,
        exactOptionalPropertyTypes: strict,
        noUncheckedIndexedAccess: strict,
        skipLibCheck: true,
        noEmit: true,
        types: [],
      });
      const diagnostics = ts.getPreEmitDiagnostics(program);
      expect(
        diagnostics.map((diagnostic) => ({
          code: diagnostic.code,
          file: diagnostic.file ? path.basename(diagnostic.file.fileName) : undefined,
          message: ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
        })),
      ).toEqual([]);
    },
    30_000,
  );
});
