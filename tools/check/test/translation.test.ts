import { describe, expect, it } from "vitest";

import { diffStrings, isTranslationTable, isTranslationTest } from "../lib/graph.ts";

describe("translation tables", () => {
  it("names the web client's tables but not their tests or other modules", () => {
    // localization.tsx also holds the translate code every screen runs: it follows the graph.
    expect(isTranslationTable("apps/web/src/localization.tsx")).toBe(false);
    expect(isTranslationTable("apps/web/src/localization/zhCNSettingsCopy.ts")).toBe(true);
    expect(isTranslationTable("apps/web/src/localization/zhCNSettingsCopy.test.ts")).toBe(false);
    expect(isTranslationTable("apps/web/src/components/ChatView.tsx")).toBe(false);
    expect(isTranslationTest("apps/web/src/localization/zhCNPhraseTable.test.ts")).toBe(true);
    expect(isTranslationTest("apps/web/src/localization.test.ts")).toBe(true);
    expect(isTranslationTest("apps/web/src/components/ChatView.test.tsx")).toBe(false);
  });
});

describe("diffStrings", () => {
  it("takes the strings of added and removed lines, keys and texts, not context or headers", () => {
    const diff = [
      "diff --git a/apps/web/src/localization.tsx b/apps/web/src/localization.tsx",
      "--- a/apps/web/src/localization.tsx",
      "+++ b/apps/web/src/localization.tsx",
      "@@ -10,2 +10,2 @@",
      '-  "settings.voice.description": "语音设置会保存在这台电脑上。",',
      '+  "settings.voice.description": "语音",',
      '   "settings.voice.title": "语音",',
      "+  hint: 'Don\\'t lose it',",
      "+  note: `已保存`,",
      '+  "x": "a",',
    ].join("\n");
    expect(diffStrings(diff)).toEqual([
      "Don\\'t lose it",
      "settings.voice.description",
      "已保存",
      "语音",
      "语音设置会保存在这台电脑上。",
    ]);
  });

  it("skips template literals with substitutions, whose text never appears whole in a test", () => {
    expect(diffStrings("+  label: `已删除 ${count} 个`,")).toEqual([]);
  });
});
