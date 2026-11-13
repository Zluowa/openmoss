// FILE: dashboard.test.ts
// Purpose: The 数据看板 payload: parsing, store writes, reading files into rows, filters against
//          their rules, the static check, the projection, and the built-in template.

import { describe, expect, it } from "vitest";

import {
  applyDashboardSystem,
  applyDashboardWrites,
  builtInSystemRef,
  storedSystemTokens,
  blanksOf,
  checkDashboard,
  checkRuleValue,
  createDashboard,
  DASHBOARD_LOOKS,
  dashboardWithDraft,
  diffDashboards,
  diffLines,
  discardDashboardDraft,
  fillCallArgs,
  isDashboardPayload,
  parseDashboard,
  projectDashboard,
  readDatasetFile,
  rowsToCsv,
  saveDashboardDraft,
  type DashboardCallSource,
  type DashboardItem,
} from "./dashboard";
import {
  buildDashboardFrameDocument,
  buildDashboardSnapshotDocument,
  dashboardTokensCss,
} from "./dashboardFrame";
import { salesDashboardData } from "./dashboardTemplates";
import { parseItemData } from "./itemData";
import { findBuiltInTemplate } from "./templates";

const compile = (code: string) => {
  try {
    // oxlint-disable-next-line no-new-func -- compiles only, never runs
    new Function(code);
    return null;
  } catch (error) {
    return (error as Error).message;
  }
};

const withPage = (html: string, extra: Partial<DashboardItem> = {}): DashboardItem => ({
  ...createDashboard("Test"),
  files: { "index.html": { text: html } },
  ...extra,
});

describe("dashboard payload", () => {
  it("round-trips and is told apart from a v1 应用页", () => {
    const dashboard = createDashboard("周报");
    const json = JSON.stringify(dashboard);
    expect(isDashboardPayload(json)).toBe(true);
    expect(
      isDashboardPayload(JSON.stringify({ version: 1, html: "<p>x</p>", capabilities: [] })),
    ).toBe(false);
    expect(isDashboardPayload("not json")).toBe(false);
    expect(parseDashboard(json)).toEqual(dashboard);
  });

  it("stores through the app kind with a searchable projection; v1 pages still parse", () => {
    const parsed = parseItemData("app", JSON.stringify(salesDashboardData()), "销售看板");
    expect(parsed.content).toContain("# 销售看板");
    expect(parsed.content).toContain("示例：各区域月度销售");
    expect(parsed.content).not.toContain("dash.calc");
    const v1 = parseItemData(
      "app",
      JSON.stringify({ version: 1, html: "<h1>旧</h1>", capabilities: ["db"] }),
    );
    expect(JSON.parse(v1.data).version).toBe(1);
  });

  it("rejects bad ids, file names, colours and rule words with a plain reason", () => {
    const base = createDashboard();
    expect(() => parseDashboard({ ...base, datasets: { "bad id": {} } })).toThrow(/dataset id/u);
    expect(() => parseDashboard({ ...base, files: { "../x.html": { text: "" } } })).toThrow(
      /flat name/u,
    );
    expect(() =>
      parseDashboard({
        ...base,
        datasets: {
          q: {
            title: "Q",
            source: {
              kind: "call",
              connector: "c",
              tool: "t",
              args: {},
              rules: { n: { format: "x" } },
            },
          },
        },
      }),
    ).toThrow(/unknown word/u);
    expect(() =>
      parseDashboard({
        ...base,
        look: { name: "x", light: { ground: "red", charts: ["#000000"] }, dark: {} },
      }),
    ).toThrow(/#rrggbb/u);
  });

  it("keeps the refresh window to known choices or minutes", () => {
    expect(
      parseDashboard({ ...createDashboard(), settings: { updates: "hour" } }).settings.updates,
    ).toBe("hour");
    expect(
      parseDashboard({ ...createDashboard(), settings: { updates: 90 } }).settings.updates,
    ).toBe(90);
    expect(
      parseDashboard({ ...createDashboard(), settings: { updates: "soon" } }).settings.updates,
    ).toBe("viewed");
  });
});

describe("applyDashboardWrites", () => {
  it("sets, deep-merges and deletes by path", () => {
    let item = applyDashboardWrites(createDashboard(), [
      { op: "set", path: "meta", data: { title: "看板", lang: "zh-CN" } },
      { op: "set", path: "params", data: { region: "" } },
      {
        op: "set",
        path: "datasets/sales",
        data: {
          title: "销售",
          source: { kind: "file", name: "s.csv", text: "a,b\n1,2\n" },
          updated: { at: "2026-11-13T00:00:00Z", by: "Moss" },
        },
      },
      { op: "set", path: "files/index.html", data: { text: "<p>hi</p>" } },
    ]);
    expect(item.meta.title).toBe("看板");
    item = applyDashboardWrites(item, [
      {
        op: "update",
        path: "datasets/sales",
        data: { description: "一句话", updated: { by: "我" } },
      },
      { op: "update", path: "settings", data: { updates: "day" } },
    ]);
    expect(item.datasets.sales!.description).toBe("一句话");
    expect(item.datasets.sales!.updated).toEqual({ at: "2026-11-13T00:00:00Z", by: "我" });
    expect(item.settings.updates).toBe("day");
    item = applyDashboardWrites(item, [
      { op: "update", path: "datasets/sales", data: { description: { __delete__: true } } },
      { op: "delete", path: "files/index.html" },
    ]);
    expect(item.datasets.sales!.description).toBeUndefined();
    expect(item.files["index.html"]).toBeUndefined();
  });

  it("refuses an update of something missing and unknown paths", () => {
    expect(() =>
      applyDashboardWrites(createDashboard(), [{ op: "update", path: "datasets/x", data: {} }]),
    ).toThrow(/use set/u);
    expect(() =>
      applyDashboardWrites(createDashboard(), [{ op: "set", path: "secrets", data: {} }]),
    ).toThrow(/paths are/u);
    expect(() =>
      applyDashboardWrites(createDashboard(), [{ op: "set", path: "datasets/a/b", data: {} }]),
    ).toThrow(/paths are/u);
  });

  it("validates the result, so a bad write leaves nothing half-applied", () => {
    expect(() =>
      applyDashboardWrites(createDashboard(), [
        { op: "set", path: "datasets/q", data: { title: "Q", source: { kind: "sql" } } },
      ]),
    ).toThrow(/source.kind/u);
  });
});

describe("readDatasetFile", () => {
  it("reads CSV as text cells with quotes, commas, newlines, BOM and empty cells as null", () => {
    const read = readDatasetFile({
      kind: "file",
      name: "x.csv",
      text: '﻿name,note,n\r\n"Lee, A","said ""hi""\nthen",3\r\nB,,\r\n',
    });
    expect(read.columns).toEqual(["name", "note", "n"]);
    expect(read.rows).toEqual([
      { name: "Lee, A", note: 'said "hi"\nthen', n: "3" },
      { name: "B", note: null, n: null },
    ]);
  });

  it("reads TSV by extension and JSON rows bare or under data/rows/results", () => {
    expect(readDatasetFile({ kind: "file", name: "x.tsv", text: "a\tb\n1\t2\n" }).rows).toEqual([
      { a: "1", b: "2" },
    ]);
    expect(
      readDatasetFile({ kind: "file", name: "x.json", text: '{"data":[{"a":1,"b":{"c":2}}]}' })
        .rows,
    ).toEqual([{ a: 1, b: '{"c":2}' }]);
    const record = readDatasetFile({ kind: "file", name: "x.json", text: '{"total":5}' });
    expect(record.rows).toEqual([]);
    expect(record.value).toEqual({ total: 5 });
    expect(() => readDatasetFile({ kind: "file", name: "x.json", text: "{" })).toThrow(/JSON/u);
  });

  it("writes CSV back with quoting", () => {
    expect(rowsToCsv(["a", "b"], [{ a: 'x,"y"', b: null }])).toBe('a,b\r\n"x,""y""",');
  });
});

describe("filters", () => {
  const source = (
    args: Record<string, unknown>,
    rules: DashboardCallSource["rules"] = {},
  ): DashboardCallSource => ({
    kind: "call",
    connector: "BigQuery",
    tool: "query",
    args,
    rules,
  });

  it("fills whole-argument blanks with the value and text blanks with its characters", () => {
    const filled = fillCallArgs(
      source(
        { limit: "{{n}}", sql: "SELECT * FROM t WHERE r IN ('{{regions}}') AND d >= '{{start}}'" },
        {
          n: { type: "number", minimum: 1 },
          regions: { items: { enum: ["a", "b"] }, minItems: 1 },
          start: { pattern: "[0-9]{4}-[0-9]{2}-[0-9]{2}" },
        },
      ),
      { n: 10, regions: ["a", "b"], start: "2026-01-01" },
    );
    expect(filled).toEqual({
      args: { limit: 10, sql: "SELECT * FROM t WHERE r IN ('a,b') AND d >= '2026-01-01'" },
    });
    expect(blanksOf({ q: "{{ a }} {{b}}" })).toEqual(["a", "b"]);
  });

  it("checks every value against its rule before any call", () => {
    expect(
      fillCallArgs(source({ n: "{{n}}" }, { n: { type: "number", maximum: 5 } }), { n: 9 }),
    ).toEqual({ error: "筛选「n」的值不能大于 5" });
    expect(
      fillCallArgs(source({ q: "x = '{{r}}'" }, { r: { enum: ["east"] } }), {
        r: "west' OR 1=1 --",
      }),
    ).toHaveProperty("error");
  });

  it("refuses quotes in a blank no rule pins", () => {
    expect(
      fillCallArgs(source({ q: "name = '{{who}}'" }, { who: { type: "string" } }), {
        who: "o'neil",
      }),
    ).toHaveProperty("error");
    expect(
      fillCallArgs(source({ q: "name = '{{who}}'" }, { who: { type: "string" } }), {
        who: "oneil",
      }),
    ).toEqual({ args: { q: "name = 'oneil'" } });
  });

  it("knows the rule words", () => {
    expect(checkRuleValue("2026-13-01", { pattern: "[0-9]{4}-[01][0-9]-[0-3][0-9]" })).toBeNull();
    expect(checkRuleValue("26-1-1", { pattern: "[0-9]{4}-[01][0-9]-[0-3][0-9]" })).toBe("格式不对");
    expect(checkRuleValue(1.5, { type: "integer" })).toBe("需要一个整数");
    expect(checkRuleValue(["a"], { type: "string" })).toBe("这个筛选只接受一个值");
    expect(checkRuleValue("ab", { maxLength: 1 })).toBe("最多 1 个字");
  });
});

describe("checkDashboard", () => {
  it("finds what can be found without running the page", () => {
    const faults = checkDashboard(
      withPage(
        '<div data-source="ghost"></div><iframe src="x"></iframe><script src="https://cdn.example/x.js"></script><script>const a = ;</script><p onclick="x()">x</p>',
        {
          params: {},
          datasets: {
            q: {
              title: "Q",
              source: { kind: "call", connector: "c", tool: "t", args: { sql: "{{n}}" } },
            },
          },
        },
      ),
      compile,
    ).map((fault) => fault.message);
    expect(faults.some((m) => m.includes("没有这个数据来源"))).toBe(true);
    expect(faults.some((m) => m.includes("<iframe>"))).toBe(true);
    expect(faults.some((m) => m.includes("不是看板里的文件"))).toBe(true);
    expect(faults.some((m) => m.includes("语法错误"))).toBe(true);
    expect(faults.some((m) => m.includes("on…="))).toBe(true);
    expect(faults.some((m) => m.includes("没有默认值"))).toBe(true);
    expect(faults.some((m) => m.includes("没有规则"))).toBe(true);
    expect(checkDashboard(createDashboard()).map((f) => f.where)).toEqual(["files/index.html"]);
  });
});

describe("built-in 销售看板", () => {
  it("is a valid dashboard the static check passes", () => {
    const template = findBuiltInTemplate("builtin:sales-dashboard");
    expect(template?.kind).toBe("app");
    const dashboard = parseDashboard(template!.data!);
    expect(checkDashboard(dashboard, compile)).toEqual([]);
    expect(readDatasetFile(dashboard.datasets.sales!.source as never).rows).toHaveLength(18);
    expect(projectDashboard(dashboard)).toContain("销售看板");
  });
});

describe("frame document", () => {
  it("carries tokens for the theme, the page files and no script tags with a src", () => {
    const html = buildDashboardFrameDocument({
      nonce: "0123456789abcdef0123",
      item: salesDashboardData(),
      d3: "window.d3={};",
      mode: "dark",
      params: { region: "" },
    });
    expect(html).toContain("--dash-bg:#1c1c1b");
    expect(html).toContain('"datasets":["sales"]');
    // The page's own scripts travel inside the boot data, never as external tags.
    expect(html).not.toMatch(/<script[^>]+src=/u);
    expect(dashboardTokensCss(undefined, "light")).toContain("--dash-chart-1:#2a78d6");
  });
});

describe("drafts", () => {
  it("writes a remix beside the dashboard and saves or discards it", () => {
    const base = salesDashboardData();
    let item = applyDashboardWrites(base, [
      { op: "set", path: "draft", data: { shape: "scroll-story" } },
      { op: "set", path: "draft/files/index.html", data: { text: "<p id='a'>story</p>" } },
      {
        op: "set",
        path: "draft/datasets/extra",
        data: {
          title: "新的",
          source: { kind: "file", name: "e.csv", text: "a\n1\n" },
          updated: { at: "2026-11-13T00:00:00Z", by: "Moss" },
        },
      },
      { op: "set", path: "draft/params", data: { region: "华东" } },
    ]);
    expect(item.files["index.html"]!.text).toContain("dash-one-writer");
    expect(item.draft?.shape).toBe("scroll-story");
    const shown = dashboardWithDraft(item);
    expect(shown.files["index.html"]!.text).toContain("story");
    expect(Object.keys(shown.datasets).toSorted()).toEqual(["extra", "sales"]);
    expect(shown.params).toEqual({ region: "华东" });
    expect(shown.meta.shape).toBe("scroll-story");
    const saved = saveDashboardDraft(item);
    expect(saved.draft).toBeUndefined();
    expect(saved.files["index.html"]!.text).toContain("story");
    const discarded = discardDashboardDraft(item);
    expect(discarded.draft).toBeUndefined();
    expect(discarded.files["index.html"]!.text).toContain("dash-one-writer");
    item = applyDashboardWrites(item, [{ op: "delete", path: "draft" }]);
    expect(item.draft).toBeUndefined();
  });

  it("refuses draft paths with no draft open", () => {
    expect(() =>
      applyDashboardWrites(createDashboard(), [
        { op: "set", path: "draft/files/index.html", data: { text: "x" } },
      ]),
    ).toThrow(/no draft is open/u);
  });
});

describe("history diff and style tweaks", () => {
  it("diffs two versions document by document", () => {
    const before = salesDashboardData();
    const after = applyDashboardWrites(before, [
      { op: "update", path: "datasets/sales", data: { title: "改名了" } },
      { op: "update", path: "settings", data: { updates: "day" } },
    ]);
    const diff = diffDashboards(before, after);
    expect(diff.map((doc) => doc.path).toSorted()).toEqual(["datasets/sales", "settings"]);
    const settings = diff.find((doc) => doc.path === "settings")!;
    expect(settings.added).toBe(1);
    expect(settings.removed).toBe(1);
    expect(diffLines("a\nb\nc", "a\nc\nd")).toEqual([
      { mark: " ", text: "a" },
      { mark: "−", text: "b" },
      { mark: " ", text: "c" },
      { mark: "+", text: "d" },
    ]);
  });

  it("keeps a tweaked look's font and size and puts them in the tokens", () => {
    const look = { ...DASHBOARD_LOOKS[0]!, font: "serif" as const, size: 16, tweaked: true };
    const item = parseDashboard({ ...createDashboard(), look });
    expect(item.look).toMatchObject({ font: "serif", size: 16, tweaked: true });
    const css = dashboardTokensCss(item.look, "light");
    expect(css).toContain("--dash-size-body:16px");
    expect(css).toContain("Noto Serif SC");
  });

  it("keeps up to five earlier saved queries", () => {
    const item = parseDashboard({
      ...createDashboard(),
      datasets: {
        q: {
          title: "Q",
          source: { kind: "call", connector: "c", tool: "t", args: { a: 1 } },
          saved: Array.from({ length: 7 }, (_, i) => ({
            at: `2026-11-1${i}T00:00:00Z`,
            args: { a: i },
          })),
        },
      },
    });
    expect(item.datasets.q!.saved).toHaveLength(5);
  });

  it("builds a share-link snapshot with the file rows inlined and live queries marked", () => {
    const html = buildDashboardSnapshotDocument(
      salesDashboardData(),
      "https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js",
    );
    expect(html).toContain(
      '<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>',
    );
    expect(html).toContain('"inline":{"sales":{"status":"ok"');
    expect(html).toContain("@media (prefers-color-scheme: dark)");
  });
});

describe("资料库 files", () => {
  it("accepts a file kept in the 资料库 by id and skips reading it in the static check", () => {
    const item = parseDashboard({
      ...createDashboard(),
      datasets: {
        big: {
          title: "大表",
          source: { kind: "file", name: "big.csv", library: { itemId: "lib-1", size: 3_000_000 } },
          updated: { at: "2026-11-13T00:00:00Z", by: "Moss" },
        },
      },
      files: { "index.html": { text: '<p data-source="big" data-field="a">—</p>' } },
    });
    expect(item.datasets.big!.source).toEqual({
      kind: "file",
      name: "big.csv",
      text: "",
      library: { itemId: "lib-1", size: 3_000_000 },
    });
    expect(checkDashboard(item)).toEqual([]);
    expect(() =>
      parseDashboard({
        ...createDashboard(),
        datasets: {
          big: {
            title: "x",
            source: { kind: "file", name: "b.csv", library: { itemId: "x", size: 99_000_000 } },
          },
        },
      }),
    ).toThrow(/15 MB/u);
  });
});

describe("design systems", () => {
  it("wears a built-in system: tokens copied, look derived, --ds-* in the page", () => {
    const ref = builtInSystemRef("editorial", "2026-11-13T00:00:00Z")!;
    expect(ref.source).toBe("builtin:editorial");
    const worn = applyDashboardSystem(salesDashboardData(), ref, DASHBOARD_LOOKS[0]!);
    expect(worn.system?.name).toBe(ref.name);
    expect(worn.look?.light.ground).toBe("#f7f3ea");
    expect(worn.look?.light.text).toBe("#2a241c");
    expect(worn.look?.light.charts[0]).toBe("#9a3412");
    const roundTrip = parseDashboard(JSON.stringify(worn));
    expect(roundTrip.system?.source).toBe("builtin:editorial");
    const html = buildDashboardFrameDocument({
      nonce: "0123456789abcdef0123",
      item: roundTrip,
      d3: "",
      mode: "light",
      params: {},
    });
    expect(html).toContain("--ds-paper:");
    const plain = applyDashboardSystem(worn, null, DASHBOARD_LOOKS[0]!);
    expect(plain.system).toBeUndefined();
    expect(plain.look).toBeUndefined();
  });

  it("reads a 设计 item's own system and refuses bad sources", () => {
    const tokens = builtInSystemRef("moss")!.tokens;
    expect(storedSystemTokens(JSON.stringify({ ownSystem: tokens }))).toEqual(tokens);
    expect(storedSystemTokens(JSON.stringify({ artboards: [] }))).toBeNull();
    expect(() =>
      parseDashboard({ ...createDashboard(), system: { source: "https://x", name: "x", tokens } }),
    ).toThrow(/builtin/u);
    const written = applyDashboardWrites(createDashboard(), [
      { op: "set", path: "system", data: builtInSystemRef("night") },
    ]);
    expect(written.system?.source).toBe("builtin:night");
    expect(
      applyDashboardWrites(written, [{ op: "delete", path: "system" }]).system,
    ).toBeUndefined();
  });
});
