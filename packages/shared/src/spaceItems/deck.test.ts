import { describe, expect, it } from "vitest";

import { applyDeckOps, deckFromOutline, diffDecks } from "./deckOps";
import { exportDeckToPptx, importPptxToDeck } from "./deckPptx";
import { DECK_TEMPLATES, deckTemplateData } from "./deckTemplates";
import { DECK_THEMES } from "./deckThemes";
import {
  bodyText,
  createSlidesDeck,
  parseSlidesDeck,
  projectSlidesDeck,
  resolveColor,
  resolveDeckColors,
  type TextElement,
} from "./slidesDeck";

const withElement = (element: object) => ({
  version: 2,
  slides: [{ id: "s1", elements: [{ id: "e1", x: 0, y: 0, w: 10, h: 10, ...element }] }],
});

describe("deck v2 model", () => {
  it("normalizes a deck and rejects unsafe or malformed content", () => {
    const deck = createSlidesDeck("季度回顾");
    const parsed = parseSlidesDeck(JSON.stringify(deck));
    expect(parsed.slides).toHaveLength(1);
    expect(parsed.size).toEqual({ width: 1920, height: 1080 });
    expect(projectSlidesDeck(parsed)).toContain("## 1. 季度回顾");

    expect(() =>
      parseSlidesDeck(withElement({ type: "image", src: "javascript:alert(1)" })),
    ).toThrow(/https URL/);
    expect(() =>
      parseSlidesDeck(withElement({ type: "image", src: "http://example.com/a.png" })),
    ).toThrow();
    expect(() =>
      parseSlidesDeck(withElement({ type: "image", src: "/api/../etc/passwd" })),
    ).toThrow();
    expect(
      parseSlidesDeck(withElement({ type: "image", src: "/api/moss/media/assets/job1/0" }))
        .slides[0]!.elements,
    ).toHaveLength(1);
    expect(() =>
      parseSlidesDeck(withElement({ type: "shape", shape: "rect", fill: "red" })),
    ).toThrow(/#RRGGBB/);
    expect(() =>
      parseSlidesDeck(withElement({ type: "text", text: "x", link: { url: "javascript:1" } })),
    ).toThrow(/link/);
    expect(() =>
      parseSlidesDeck('{"version":2,"slides":[{"id":"a","elements":[]},{"id":"a","elements":[]}]}'),
    ).toThrow(/duplicate/);
    expect(() => parseSlidesDeck({ version: 3, slides: [] })).toThrow(/version/);
  });

  it("expands plain text into paragraphs and lists, and accepts theme color references", () => {
    const deck = parseSlidesDeck(
      withElement({ type: "text", text: "要点\n- 一\n- 二\n1. 第一步", color: "@accent" }),
    );
    const element = deck.slides[0]!.elements[0] as TextElement;
    expect(element.body.paragraphs.map((p) => p.list ?? null)).toEqual([
      null,
      "bullet",
      "bullet",
      "number",
    ]);
    expect(element.body.color).toBe("@accent");
    expect(resolveColor("@accent", deck.theme)).toBe(deck.theme.colors.accent);
    expect(resolveColor("@inverse.background", deck.theme)).toBe(deck.theme.colors.text);
    const resolved = resolveDeckColors(deck).slides[0]!.elements[0] as TextElement;
    expect(resolved.body.color).toBe(deck.theme.colors.accent);
    expect(bodyText(element.body)).toBe("要点\n一\n二\n第一步");
  });

  it("upgrades #378's v1 decks onto the 1920×1080 stage", () => {
    const v1 = {
      version: 1,
      theme: { background: "#FFFFFF", text: "#111111", accent: "#2F6F5E", muted: "#666666" },
      slides: [
        {
          id: "s1",
          layout: "title-content",
          background: "#FAFAFA",
          notes: "备注",
          elements: [
            {
              id: "t",
              type: "text",
              role: "title",
              x: 80,
              y: 60,
              w: 1120,
              h: 100,
              text: "议程",
              fontSize: 44,
              bold: true,
              align: "left",
            },
            {
              id: "r",
              type: "shape",
              shape: "rightArrow",
              x: 0,
              y: 0,
              w: 100,
              h: 50,
              fill: "#2F6F5E",
              text: "下一步",
            },
          ],
        },
      ],
    };
    const deck = parseSlidesDeck(v1);
    expect(deck.version).toBe(2);
    const slide = deck.slides[0]!;
    expect(slide.layout).toBe("title-body");
    expect(slide.background).toEqual({ type: "solid", color: "#FAFAFA" });
    expect(slide.notes).toBe("备注");
    const title = slide.elements[0] as TextElement;
    expect([title.x, title.y, title.w, title.h]).toEqual([120, 90, 1680, 150]);
    expect(title.body.size).toBe(66);
    expect(title.body.weight).toBe(700);
    expect(bodyText(title.body)).toBe("议程");
    const arrow = slide.elements[1]!;
    expect(arrow.type === "shape" && arrow.shape).toBe("arrowRight");
  });

  it("applies ordered deck ops and re-validates the result", () => {
    const deck = createSlidesDeck("封面");
    const added = applyDeckOps(deck, [
      { op: "add-slide", layout: "bullets", content: { title: "议程", bullets: ["一", "二"] } },
      { op: "add-slide", layout: "section", index: 1, content: { title: "附录" } },
      { op: "upsert-section", section: { id: "sec1", title: "第一部分" } },
    ]);
    expect(added.slides.map((s) => s.layout)).toEqual(["title", "section", "bullets"]);
    const agenda = added.slides[2]!;
    const body = agenda.elements.find((e) => e.type === "text" && e.role === "body") as TextElement;
    expect(body.body.paragraphs.every((p) => p.list === "bullet")).toBe(true);

    const edited = applyDeckOps(added, [
      { op: "set-text", slideId: agenda.id, elementId: body.id, text: "三\n四\n五" },
      {
        op: "update-element",
        slideId: agenda.id,
        elementId: body.id,
        set: { color: "@muted", x: 200 },
      },
      {
        op: "update-slide",
        slideId: agenda.id,
        set: { sectionId: "sec1", hidden: true, transition: "fade" },
      },
      {
        op: "add-element",
        slideId: agenda.id,
        element: {
          type: "chart",
          kind: "column",
          x: 1000,
          y: 300,
          w: 700,
          h: 500,
          labels: ["Q1", "Q2"],
          series: [{ name: "收入", values: [1, 2] }],
        },
      },
      { op: "duplicate-slide", slideId: agenda.id },
      { op: "set-cover", slideId: agenda.id },
    ]);
    const after = edited.slides[2]!.elements.find((e) => e.id === body.id) as TextElement;
    // A list stays a list when the new lines have no markers.
    expect(after.body.paragraphs.map((p) => p.list)).toEqual(["bullet", "bullet", "bullet"]);
    expect(after.body.color).toBe("@muted");
    expect(after.x).toBe(200);
    expect(edited.slides[2]!.sectionId).toBe("sec1");
    expect(edited.slides).toHaveLength(4);
    expect(new Set(edited.slides[3]!.elements.map((e) => e.id)).size).toBe(
      edited.slides[3]!.elements.length,
    );
    expect(edited.slides[3]!.id).not.toBe(agenda.id);
    expect(edited.coverSlideId).toBe(agenda.id);

    const diff = diffDecks(added, edited);
    expect(diff.changedSlides).toContain(agenda.id);
    expect(diff.addedSlides).toHaveLength(1);
    expect(diff.changedElements[agenda.id]).toContain(body.id);

    expect(() => applyDeckOps(deck, [{ op: "delete-slide", slideId: "missing" }])).toThrow(
      /no slide/,
    );
    expect(() =>
      applyDeckOps(deck, [
        {
          op: "update-element",
          slideId: deck.slides[0]!.id,
          elementId: deck.slides[0]!.elements[0]!.id,
          set: { color: "blue" },
        },
      ]),
    ).toThrow(/color/);
  });

  it("applies a theme and recolors the colors the old theme used", () => {
    const deck = applyDeckOps(createSlidesDeck("x"), [
      { op: "add-slide", layout: "section", content: { title: "章节" } },
    ]);
    const ink = applyDeckOps(deck, [{ op: "apply-theme", theme: "ink" }]);
    expect(ink.theme.name).toBe("夜墨");
    expect(ink.slides[0]!.background).toEqual({
      type: "solid",
      color: ink.theme.colors.background,
    });
    const bar = ink.slides[1]!.elements.find((e) => e.type === "shape")!;
    expect(bar.fill).toEqual({ type: "solid", color: ink.theme.colors.accent });
    expect(() => applyDeckOps(deck, [{ op: "apply-theme", theme: "nope" }])).toThrow(
      /unknown theme/,
    );
  });

  it("builds a deck from an outline with sections, a cover and a closing slide", () => {
    const deck = deckFromOutline({
      title: "提案",
      theme: "sea",
      sections: [
        { title: "为什么", slides: [{ title: "问题", bullets: ["a"] }, { quote: "一句话" }] },
        {
          title: "怎么做",
          slides: [
            { title: "方案", left: "a", right: "b" },
            { title: "数据", table: [["x", "y"]] },
          ],
        },
      ],
    });
    expect(deck.theme.name).toBe("海盐");
    expect(deck.sections.map((s) => s.title)).toEqual(["为什么", "怎么做"]);
    expect(deck.slides.map((s) => s.layout)).toEqual([
      "title",
      "section",
      "bullets",
      "quote",
      "section",
      "two-columns",
      "table",
      "closing",
    ]);
    expect(deck.slides.every((s) => s.sectionId !== null)).toBe(true);
  });

  it("ships valid templates and themes", () => {
    for (const template of DECK_TEMPLATES)
      expect(() => parseSlidesDeck(deckTemplateData(template))).not.toThrow();
    expect(DECK_THEMES.length).toBeGreaterThanOrEqual(6);
  });

  it("round-trips a deck through PowerPoint with text, lists, tables, charts, notes and sections", async () => {
    const deck = deckFromOutline({
      title: "回顾",
      sections: [
        {
          title: "结果",
          slides: [
            { title: "要点", bullets: ["一", "二"], notes: "讲 30 秒" },
            {
              title: "表",
              table: [
                ["a", "b"],
                ["1", "2"],
              ],
            },
          ],
        },
      ],
    });
    const withChart = applyDeckOps(deck, [
      {
        op: "add-element",
        slideId: deck.slides[2]!.id,
        element: {
          type: "chart",
          kind: "column",
          x: 1000,
          y: 400,
          w: 600,
          h: 400,
          labels: ["Q1", "Q2"],
          series: [{ name: "收入", values: [3, 5] }],
        },
      },
      {
        op: "add-element",
        slideId: deck.slides[2]!.id,
        element: {
          type: "line",
          x: 100,
          y: 1000,
          w: 800,
          h: 0,
          points: [
            { x: 100, y: 1000 },
            { x: 900, y: 1000 },
          ],
          stroke: { color: "#C4623F", width: 4 },
          endArrow: "arrow",
        },
      },
    ]);
    const report = await exportDeckToPptx(withChart);
    expect(report.bytes.length).toBeGreaterThan(5_000);
    const back = await importPptxToDeck(report.bytes);
    expect(back.deck.slides).toHaveLength(withChart.slides.length);
    expect(back.deck.sections.map((s) => s.title)).toEqual(["结果"]);
    const bullets = back.deck.slides[2]!;
    expect(bullets.notes).toBe("讲 30 秒");
    const texts = bullets.elements.filter((e): e is TextElement => e.type === "text");
    expect(texts.map((t) => bodyText(t.body))).toContain("一\n二");
    const list = texts.find((t) => bodyText(t.body) === "一\n二")!;
    expect(list.body.paragraphs[0]!.list).toBe("bullet");
    const chart = bullets.elements.find((e) => e.type === "chart");
    expect(chart && chart.type === "chart" && chart.series[0]!.values).toEqual([3, 5]);
    const title = texts.find((t) => bodyText(t.body) === "要点")!;
    // Geometry survives within a pixel.
    const original = withChart.slides[2]!.elements.find(
      (e) => e.type === "text" && bodyText(e.body) === "要点",
    )!;
    expect(Math.abs(title.x - original.x)).toBeLessThanOrEqual(1);
    expect(Math.abs(title.w - original.w)).toBeLessThanOrEqual(1);
    const table = back.deck.slides[3]!.elements.find((e) => e.type === "table");
    expect(table && table.type === "table" && bodyText(table.rows[1]!.cells[1]!.body)).toBe("2");
  });
});
