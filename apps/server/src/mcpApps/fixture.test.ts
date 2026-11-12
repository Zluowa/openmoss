// FILE: fixture.test.ts
// Purpose: The MCP Apps fixture serves a widget whose scripts parse: the inlined ext-apps SDK must
//   be byte-for-byte the SDK (a `String.replace` replacement string once expanded its `$&` / `` $` ``
//   and broke every widget), and the widget's own module script must be valid JavaScript.
import { readFileSync } from "node:fs";
import path from "node:path";

import ts from "typescript";
import { describe, expect, it } from "vitest";

import { widgetHtml } from "../../test-fixtures/mcp-apps/server.mjs";

const sdkPath = path.resolve(
  import.meta.dirname,
  "../../../web/node_modules/@modelcontextprotocol/ext-apps/dist/src/app-with-deps.js",
);

function syntaxErrors(source: string): string[] {
  const output = ts.transpileModule(source, {
    reportDiagnostics: true,
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
  });
  return (output.diagnostics ?? []).map((diagnostic) =>
    ts.flattenDiagnosticMessageText(diagnostic.messageText, "\n"),
  );
}

describe("MCP Apps fixture widget", () => {
  const html = widgetHtml();
  const sdkMatch = /<script type="text\/plain" id="ext-apps-sdk">([\s\S]*?)<\/script>/u.exec(html);

  it("inlines the ext-apps App SDK unchanged", () => {
    expect(sdkMatch).not.toBeNull();
    const original = readFileSync(sdkPath, "utf8");
    // The only change is the `</script` escape inside the inline block.
    expect(sdkMatch![1]!.replaceAll("<\/script", "</script")).toBe(original);
    expect(original).toContain("$&");
  });

  it("serves scripts that parse", () => {
    expect(syntaxErrors(sdkMatch![1]!.replaceAll("<\/script", "</script"))).toEqual([]);
    const moduleScript = /<script type="module">([\s\S]*?)<\/script>/u.exec(html)?.[1];
    expect(moduleScript).toBeDefined();
    expect(syntaxErrors(moduleScript!)).toEqual([]);
  });
});
