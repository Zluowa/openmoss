import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, describe, expect, it } from "vitest";

import {
  countCopy,
  grownFiles,
  isCandidate,
  nextBaseline,
  stringsIn,
  type Baseline,
} from "./check-copy-ratchet.ts";

describe("isCandidate", () => {
  it("counts sentences of 14 or more characters with Chinese punctuation", () => {
    expect(isCandidate({ text: "连接已断开，请检查网络后再试一次。" })).toBe(true);
    expect(isCandidate({ text: "连接已断开，请重试" })).toBe(false);
    expect(isCandidate({ text: "这是一个没有标点但是足够长的标签文字" })).toBe(false);
  });

  it("counts helper-named keys, long placeholders and empty-state openers", () => {
    expect(isCandidate({ text: "保存后生效", key: "description" })).toBe(true);
    expect(isCandidate({ text: "保存后生效", key: "label" })).toBe(false);
    expect(isCandidate({ text: "输入你想让 Moss 做的事情", key: "placeholder" })).toBe(true);
    expect(isCandidate({ text: "搜索", key: "placeholder" })).toBe(false);
    expect(isCandidate({ text: "暂无记录" })).toBe(true);
  });

  it("ignores text with no Chinese", () => {
    expect(
      isCandidate({ text: "Something went wrong, please try again later.", key: "description" }),
    ).toBe(false);
  });
});

describe("stringsIn", () => {
  it("finds literals, templates and JSX text with the key each is assigned to", () => {
    const source = [
      'const copy = { title: "设置", description: "这里可以修改所有设置。" };',
      'const Empty = () => <p className="x">暂无内容</p>;',
      'const Field = () => <input placeholder={"输入你想让 Moss 做的事情"} />;',
      "const n = 2; const line = `已删除 ${n} 个文件，可以在回收站找回。`;",
      'const table = { "设置": "Settings" };',
    ].join("\n");
    expect(stringsIn("x.tsx", source)).toEqual([
      { text: "设置", key: "title" },
      { text: "这里可以修改所有设置。", key: "description" },
      { text: "暂无内容" },
      { text: "输入你想让 Moss 做的事情", key: "placeholder" },
      { text: "已删除 X 个文件，可以在回收站找回。", key: "line" },
    ]);
  });

  it("parses generic arrow functions in .ts files", () => {
    const source =
      'export const pick = <T,>(value: T) => value;\nexport const note = "这段说明文字很长，用来解释这个页面。";';
    expect(stringsIn("x.ts", source).map((s) => s.text)).toEqual([
      "这段说明文字很长，用来解释这个页面。",
    ]);
  });
});

describe("countCopy", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("counts scanned files only and attributes each string to its file", () => {
    root = mkdtempSync(join(tmpdir(), "copy-ratchet-"));
    mkdirSync(join(root, "components"));
    writeFileSync(
      join(root, "components", "Panel.tsx"),
      'export const a = { hint: "按住 Shift 可以多选。" };\n',
    );
    writeFileSync(
      join(root, "components", "Panel.test.tsx"),
      'export const a = { hint: "测试里的说明文字。" };\n',
    );
    writeFileSync(join(root, "components", "Label.tsx"), 'export const b = "设置";\n');
    const count = countCopy(root);
    expect(count.total).toBe(1);
    expect([...count.byFile.keys()]).toEqual(["components/Panel.tsx"]);
  });
});

const counted = (files: Record<string, string[]>) => ({
  total: Object.values(files).flat().length,
  byFile: new Map(Object.entries(files)),
});
const baseline = (files: Record<string, number>): Baseline => ({
  note: "",
  total: Object.values(files).reduce((a, b) => a + b, 0),
  files,
});

describe("grownFiles", () => {
  it("fails only a file above its own number, naming the strings it may have gained", () => {
    const grown = grownFiles(
      counted({ "a.tsx": ["一", "二", "新加的说明。"], "b.tsx": ["三"] }),
      baseline({ "a.tsx": 2, "b.tsx": 4 }),
    );
    expect(grown).toEqual(["  a.tsx: 2 -> 3", "    + 新加的说明。"]);
  });

  it("holds a file the baseline does not list to none", () => {
    expect(grownFiles(counted({ "new.tsx": ["说明"] }), baseline({}))).toEqual([
      "  new.tsx: 0 -> 1",
      "    + 说明",
    ]);
  });

  it("is not moved by main lowering other files meanwhile: the tree is held to its own baseline", () => {
    // The pull request branched when a.tsx had 3 and changed only b.tsx; main later cut a.tsx to 1.
    // Its own tree still carries the baseline it branched from, so a.tsx at 3 passes.
    const ownTree = counted({ "a.tsx": ["一", "二", "三"], "b.tsx": [] });
    expect(grownFiles(ownTree, baseline({ "a.tsx": 3, "b.tsx": 1 }))).toEqual([]);
  });
});

describe("nextBaseline", () => {
  it("records lower counts, and a string moved between files when the total holds", () => {
    const next = nextBaseline(
      counted({ "a.tsx": ["一"], "c.tsx": ["二"] }),
      baseline({ "a.tsx": 2, "b.tsx": 1 }),
    );
    expect(next?.total).toBe(2);
    expect(next?.files).toEqual({ "a.tsx": 1, "c.tsx": 1 });
  });

  it("refuses a higher total", () => {
    expect(nextBaseline(counted({ "a.tsx": ["一", "二"] }), baseline({ "a.tsx": 1 }))).toBe(
      undefined,
    );
  });
});

describe("release notes", () => {
  let root = "";
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  it("leaves out the whatsNew data files but still counts its components", () => {
    root = mkdtempSync(join(tmpdir(), "copy-ratchet-"));
    mkdirSync(join(root, "whatsNew"));
    writeFileSync(
      join(root, "whatsNew", "mossReleases.ts"),
      'export const notes = ["Windows 更新时显示进度，装完自动重新打开"];\n',
    );
    writeFileSync(
      join(root, "whatsNew", "FeatureSection.tsx"),
      'export const a = { hint: "这里会显示每个版本的变化。" };\n',
    );
    expect([...countCopy(root).byFile.keys()]).toEqual(["whatsNew/FeatureSection.tsx"]);
  });
});
