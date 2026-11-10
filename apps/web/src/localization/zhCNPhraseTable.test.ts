// FILE: zhCNPhraseTable.test.ts
// Purpose: Locks that the zh-CN tables answer only for their own keys. A plain object also holds
//          `constructor`, `toString` and the rest of Object.prototype, and whatever the chain
//          returns is written straight into the page.
// Layer: Pure localization tests

import { describe, expect, it } from "vitest";

import { translateZhCnPresentationText } from "./zhCN";
import { lookupPhrase, phraseTranslator } from "./zhCNPhraseTable";

const OBJECT_MEMBER_NAMES = Object.getOwnPropertyNames(Object.prototype);

describe("lookupPhrase", () => {
  const phrases: Readonly<Record<string, string>> = { Save: "保存", Empty: "" };

  it("returns a table's own phrases, including an empty one", () => {
    expect(lookupPhrase(phrases, "Save")).toBe("保存");
    expect(lookupPhrase(phrases, "Empty")).toBe("");
  });

  it("finds nothing for a missing key or an Object.prototype member", () => {
    expect(lookupPhrase(phrases, "Cancel")).toBeUndefined();
    for (const name of OBJECT_MEMBER_NAMES) {
      expect(lookupPhrase(phrases, name)).toBeUndefined();
    }
  });
});

describe("phraseTranslator", () => {
  it("falls through to its patterns for an Object.prototype member", () => {
    const translate = phraseTranslator({ Save: "保存" }, [[/^(\w+)Of$/, "$1 属于"]]);
    expect(translate("Save")).toBe("保存");
    expect(translate("valueOf")).toBe("value 属于");
    expect(translate("constructor")).toBe("constructor");
  });
});

describe("translateZhCnPresentationText with Object.prototype member names", () => {
  it.each(["constructor", "toString", "valueOf", "hasOwnProperty", "__proto__"])(
    "returns %s unchanged and as a string",
    (name) => {
      const translated: unknown = translateZhCnPresentationText(name);
      expect(typeof translated).toBe("string");
      expect(translated).toBe(name);
    },
  );

  it("returns every other member name unchanged", () => {
    for (const name of OBJECT_MEMBER_NAMES) {
      expect(translateZhCnPresentationText(name)).toBe(name);
    }
  });

  it("leaves a member name in a slot as the text it is", () => {
    for (const name of OBJECT_MEMBER_NAMES) {
      const rows: ReadonlyArray<readonly [string, string]> = [
        [`Reset ${name} to default`, `将${name}恢复为默认值`],
        [`${name} hex value`, `${name} 十六进制值`],
        [`, mostly in the ${name}`, `，主要集中在${name}`],
        [`Show ${name}`, `显示 ${name}`],
        [`${name}: ${name}. Click to change permissions.`, `${name}：${name}。点击更改权限。`],
        [`⌘K ${name}. Try another.`, `⌘K ${name}. Try another.`],
        [
          `Codex CLI is installed but failed to run. ${name}`,
          `Codex CLI 已安装，但运行失败。${name}`,
        ],
        [
          `Moss Computer Use needs permission: ${name}. Then retry Computer Use.`,
          `Moss Computer Use needs permission: ${name}. Then retry Computer Use.`,
        ],
      ];
      for (const [english, chinese] of rows) {
        expect(translateZhCnPresentationText(english)).toBe(chinese);
      }
    }
  });
});
