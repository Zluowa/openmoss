// FILE: PluginManagementPanel.type.test.ts
// Purpose: Locks the public data props behind Settings › Plugins' Skills and Marketplaces tabs.

import { fileURLToPath } from "node:url";

import ts from "typescript";
import { describe, expect, it } from "vitest";

const TAB_DATA_PROPS = [
  "marketplaces",
  "marketplaceLoadErrors",
  "marketplacesLoading",
  "marketplacesError",
  "marketplacesRetrying",
  "pendingRemoveMarketplaceName",
  "pendingUpgradeMarketplaceName",
  "upgradingAllMarketplaces",
  "onRetryMarketplaces",
  "onRemoveMarketplace",
  "onUpgradeMarketplace",
  "onUpgradeAllMarketplaces",
  "onCopyMarketplacePath",
  "skills",
  "disabledSkillNames",
  "onToggleSkill",
] as const;

describe("PluginManagementPanel public type contract", () => {
  it("keeps the Skills and Marketplaces tab data as live, undeprecated props", () => {
    const fileName = fileURLToPath(new URL("./PluginManagementPanel.tsx", import.meta.url));
    const program = ts.createProgram([fileName], {
      jsx: ts.JsxEmit.ReactJSX,
      module: ts.ModuleKind.ESNext,
      skipLibCheck: true,
      target: ts.ScriptTarget.ESNext,
    });
    const checker = program.getTypeChecker();
    const sourceFile = program.getSourceFile(fileName);
    expect(sourceFile).toBeDefined();

    const moduleSymbol = checker.getSymbolAtLocation(sourceFile!);
    expect(moduleSymbol).toBeDefined();
    const propsSymbol = checker
      .getExportsOfModule(moduleSymbol!)
      .find((symbol) => symbol.name === "PluginManagementPanelProps");
    expect(propsSymbol).toBeDefined();
    const propsType = checker.getDeclaredTypeOfSymbol(propsSymbol!);

    // Codex's Settings › Plugins shows Skills and Marketplaces tabs, so these
    // props feed live tabs rather than a deprecated compatibility surface.
    for (const propertyName of TAB_DATA_PROPS) {
      const property = propsType.getProperty(propertyName);
      expect(property, `${propertyName} must remain part of the panel contract`).toBeDefined();
      expect(
        property!.getJsDocTags(checker).map((tag) => tag.name),
        `${propertyName} backs a live tab and must not be deprecated`,
      ).not.toContain("deprecated");
    }
  });
});
