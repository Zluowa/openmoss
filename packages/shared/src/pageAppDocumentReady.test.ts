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

  it("keeps the frame runtime as the first script the page runs", () => {
    const out = injectPageAppFrameRuntime(app("<script>mine()</script>"), "runtime()");
    expect(out.indexOf("runtime()")).toBeLessThan(out.indexOf("mine()"));
    expect(out.indexOf('<div id="root">')).toBeLessThan(out.indexOf("mine()"));
  });
});
