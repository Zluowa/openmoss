// FILE: zhCNNameSlot.test.ts
// Purpose: Locks the word-level zh-CN rules to names, and proves no literal in the app's source
//          comes out of them half translated.
// Layer: Pure localization and source-scan tests

import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";

const WEB_SOURCE_ROOT = join(import.meta.dirname, "..");
const WORD_LEVEL_VERBS =
  "Close|Connect|Copy|Could not update|Disable|Enable|Hide|Implement|Pin|Preview|Remove|Restart|Run|Select|Show|Sign in to|Start using|Starting|Stop|Thread|Unable to open|Unarchive|Waiting for";
const SOURCE_LITERAL = new RegExp(`["'\`]((?:${WORD_LEVEL_VERBS}) [a-z][^"'\`$\\n]*)["'\`]`, "g");
// A package script and a document fixture's author, which are names after all.
const WHOLE_NAME_LITERALS = new Set(["Stop dev", "Preview test"]);

function appSourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    // `test/` holds browser-test harnesses and fixtures, test code like `*.test.*` and `*.browser.*`.
    if (entry.isDirectory()) {
      return entry.name === "localization" || entry.name === "test" ? [] : appSourceFiles(path);
    }
    // `localization.tsx` keeps its own Chinese table, so its English keys never reach these rules.
    if (entry.name === "localization.tsx") return [];
    return /\.tsx?$/.test(entry.name) && !/\.(test|browser)\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

describe("word-level zh-CN rules", () => {
  it("still translates a name after the verb and keeps it byte for byte", () => {
    expect(translateZhCnPresentationText("Close index.ts")).toBe("关闭 index.ts");
    expect(translateZhCnPresentationText("Close 修复登录")).toBe("关闭 修复登录");
    expect(translateZhCnPresentationText("Close Why is it failing?")).toBe(
      "关闭 Why is it failing?",
    );
    expect(translateZhCnPresentationText("Stop Local server")).toBe("停止 Local server");
    expect(translateZhCnPresentationText("Enable Work")).toBe("启用 Work");
    expect(translateZhCnPresentationText("Show Moss")).toBe("显示 Moss");
    expect(translateZhCnPresentationText("Starting Codex…")).toBe("正在启动 Codex…");
    expect(translateZhCnPresentationText("Waiting for Claude…")).toBe("正在等待 Claude…");
    expect(translateZhCnPresentationText("Thread abc-123")).toBe("对话 abc-123");
    expect(translateZhCnPresentationText("source Work / Fallback")).toBe("来源 Work / Fallback");
  });

  it("leaves an unknown English sentence whole instead of half translating it", () => {
    for (const sentence of [
      "Stop the unknown thing from happening.",
      "Hide a thing from view",
      "Close this for now",
      "Show the new thing somewhere",
      "Enable and restart the thing",
      "Thread metadata is unknown",
      "Changes applied elsewhere.",
      "Starting the unknown thing…",
      "Waiting for the unknown thing…",
      "From one place to another",
      "Daily unknown summary",
    ]) {
      expect(translateZhCnPresentationText(sentence)).toBe(sentence);
    }
  });

  it("answers the default-branch questions instead of treating them as branch names", () => {
    expect(translateZhCnPresentationText("Push to default branch?")).toBe("推送到默认分支？");
    expect(translateZhCnPresentationText("Commit & push to default branch?")).toBe(
      "提交并推送到默认分支？",
    );
    expect(translateZhCnPresentationText("Push to main")).toBe("推送到 main");
  });

  it("keeps schedules and diff summaries, which always carry a number", () => {
    expect(translateZhCnPresentationText("Daily at 9:00 AM")).toBe("每天 9:00 AM");
    expect(translateZhCnPresentationText("Changes 3 files")).toBe("更改 3 files");
  });

  it("has a whole translation for every phrase in the app that opens with one of these verbs", () => {
    const halfTranslated: string[] = [];
    for (const file of appSourceFiles(WEB_SOURCE_ROOT)) {
      for (const [, literal = ""] of readFileSync(file, "utf8").matchAll(SOURCE_LITERAL)) {
        if (WHOLE_NAME_LITERALS.has(literal)) continue;
        const translated = translateZhCnPresentationText(literal);
        // A short label has no room for a code term, so one English word beside Chinese is a miss.
        const isShort = literal.split(" ").length <= 5;
        const halfPattern = isShort ? /[一-鿿] ?[a-z]{2,}/ : /[一-鿿].*[a-z]{2,} [a-z]{2,}/;
        if (halfPattern.test(translated)) {
          halfTranslated.push(`${literal} => ${translated}`);
        }
      }
    }
    expect(halfTranslated).toEqual([]);
  });
});
