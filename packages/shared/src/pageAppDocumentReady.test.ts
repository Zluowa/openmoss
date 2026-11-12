import { describe, expect, it } from "vitest";

import { runPageScriptsAfterBody } from "./pageAppDocumentReady";
import { injectPageAppFrameRuntime } from "./pageAppFrameRuntime";

const app = (head: string, body = '<div id="root"></div>') =>
  `<!doctype html><html><head><meta charset="utf-8">${head}</head><body>${body}</body></html>`;

describe("runPageScriptsAfterBody", () => {
  it("moves head scripts after #root, keeping their order", () => {
    const html = app(
      '<script src="/__moss_lib/echarts.js"></script><style>b{}</style><script>document.getElementById("root").textContent="ok"</script>',
    );
    const out = runPageScriptsAfterBody(html);
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf("echarts.js"));
    expect(out.indexOf("echarts.js")).toBeLessThan(out.indexOf('textContent="ok"'));
    expect(out.indexOf('textContent="ok"')).toBeLessThan(out.indexOf("</body>"));
    expect(out).toContain("<style>b{}</style>");
  });

  it("leaves modules, deferred and async scripts, import maps and data blocks in place", () => {
    const head =
      '<script type="importmap">{}</script><script type="module">x()</script><script defer src="a.js"></script><script async src="b.js"></script><script type="application/json">{"a":1}</script>';
    expect(runPageScriptsAfterBody(app(head))).toBe(app(head));
  });

  it("does not touch scripts in the body or text that only looks like a script", () => {
    const html = app(
      "<!-- <script>no()</script> --><title>&lt;script&gt;</title>",
      '<div id="root"></div><script>late()</script>',
    );
    expect(runPageScriptsAfterBody(html)).toBe(html);
  });

  it("runs head libraries before the body's own first script", () => {
    const out = runPageScriptsAfterBody(
      app('<script src="d3.js"></script>', '<svg></svg><script>d3.select("svg")</script>'),
    );
    expect(out.indexOf("<svg>")).toBeLessThan(out.indexOf("d3.js"));
    expect(out.indexOf("d3.js")).toBeLessThan(out.indexOf('d3.select("svg")'));
  });

  it("appends the scripts when the document has no </body>", () => {
    const out = runPageScriptsAfterBody(
      '<html><head><script>go()</script></head><body><div id="root"></div>',
    );
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf("go()"));
  });

  // Acceptance round 10: an 应用页 saved before #558 still threw `Cannot set properties of null
  // (setting 'innerHTML')`. #558 only moved scripts out of an explicit <head>; these are the
  // shapes it left alone, each with code that fills an element written after it.
  const fills = '<script>document.getElementById("root").innerHTML="<b>甲 3</b>"</script>';
  const runsAfterRoot = (out: string) => {
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf("getElementById"));
  };

  it("moves code out of a document that has no <head> or <body> tags", () => {
    runsAfterRoot(
      runPageScriptsAfterBody(
        `<!doctype html><meta charset="utf-8"><title>柱状图</title><style>b{}</style>${fills}<div id="root"></div>`,
      ),
    );
  });

  it("moves code out of a <head> that is never closed", () => {
    runsAfterRoot(
      runPageScriptsAfterBody(
        `<!DOCTYPE html><html lang="zh-CN"><head><meta charset="UTF-8">${fills}<div id="root"></div></html>`,
      ),
    );
  });

  it("moves scripts at the top of <body> after the markup, keeping their order", () => {
    const out = runPageScriptsAfterBody(
      app(fills, '<script src="chart.js"></script><div id="root"></div><canvas></canvas>'),
    );
    runsAfterRoot(out);
    expect(out.indexOf("<canvas>")).toBeLessThan(out.indexOf("getElementById"));
    expect(out.indexOf("chart.js")).toBeGreaterThan(out.indexOf("<canvas>"));
    expect(out.indexOf("getElementById")).toBeLessThan(out.indexOf("chart.js"));
    expect(out.indexOf("chart.js")).toBeLessThan(out.indexOf("</body>"));
  });

  it("keeps Moss's module bootstrap ahead of the page's modules", () => {
    const head =
      '<script data-moss-local-modules>installMap()</script><script type="module">import "d3"</script>';
    expect(runPageScriptsAfterBody(app(head))).toBe(app(head));
  });

  it("keeps the frame runtime as the first script the page runs", () => {
    const out = injectPageAppFrameRuntime(app("<script>mine()</script>"), "runtime()");
    expect(out.indexOf("runtime()")).toBeLessThan(out.indexOf("mine()"));
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf("mine()"));
  });
});
