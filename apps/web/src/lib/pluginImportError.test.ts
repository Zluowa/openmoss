// FILE: pluginImportError.test.ts
// Purpose: Keeps import failures localized and prevents raw native details from reaching users.
// Layer: Web lib test

import { describe, expect, it } from "vitest";

import { translateMoss } from "../localization";
import { PluginImportAdapterError, PLUGIN_IMPORT_DIRECT_WRITE_ERROR } from "./pluginImportAdapter";
import { pluginImportErrorKey, resolvePluginImportAdapter } from "./pluginImportError";

describe("plugin import error mapping", () => {
  it("uses localized safe fallbacks for ordinary scan, read, and rollback errors", () => {
    const cases = [
      {
        fallback: "plugins.import.scan.failed" as const,
        en: "The source could not be scanned.",
        zh: "无法扫描此来源。",
      },
      {
        fallback: "plugins.import.read.failed" as const,
        en: "The canonical destination could not be checked.",
        zh: "无法检查规范目标。",
      },
      {
        fallback: "plugins.import.rollback.failed" as const,
        en: "Rollback could not be completed.",
        zh: "无法完成回滚。",
      },
    ];

    for (const testCase of cases) {
      const key = pluginImportErrorKey(
        new Error("native path=/private/secret stack=raw-details"),
        testCase.fallback,
      );
      expect(key).toBe(testCase.fallback);
      expect(translateMoss("en", key)).toBe(testCase.en);
      expect(translateMoss("zh-CN", key)).toBe(testCase.zh);
      expect(translateMoss("en", key)).not.toContain("/private/secret");
      expect(translateMoss("zh-CN", key)).not.toContain("raw-details");
    }
  });

  it("maps typed adapter and direct-write errors without exposing their messages", () => {
    expect(
      pluginImportErrorKey(
        new PluginImportAdapterError("plugins.import.error.invalidCanonicalMcp"),
        "plugins.import.scan.failed",
      ),
    ).toBe("plugins.import.error.invalidCanonicalMcp");
    expect(
      pluginImportErrorKey(
        Object.assign(new Error("PLUGIN_IMPORT_DIRECT_WRITE_REQUIRES_SERVER_CAS"), {
          code: PLUGIN_IMPORT_DIRECT_WRITE_ERROR,
        }),
        "plugins.import.progress.failed",
        "mcp",
      ),
    ).toBe("plugins.import.mcpApplyUnavailable");
  });

  it("maps adapter-resolution throws to the operation-specific safe fallback", () => {
    const cases = [
      "plugins.import.scan.failed",
      "plugins.import.read.failed",
      "plugins.import.progress.failed",
      "plugins.import.rollback.failed",
    ] as const;

    for (const fallbackKey of cases) {
      const resolution = resolvePluginImportAdapter(
        () => {
          throw new Error("Native API not found");
        },
        fallbackKey,
        "mcp",
      );
      expect(resolution).toEqual({ adapter: null, errorKey: fallbackKey });
    }
  });
});
