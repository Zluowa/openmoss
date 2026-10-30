import { describe, expect, it } from "vitest";

import {
  notebookCellTitle,
  notebookCodeFence,
  notebookHtmlDocument,
  parseNotebook,
} from "./notebook";

describe("Notebook preview document", () => {
  it("reads standard cells, execution counts and nested Codex metadata", () => {
    const document = parseNotebook(
      JSON.stringify({
        metadata: { title: "Experiment" },
        cells: [
          { cell_type: "markdown", source: ["# Results\n", "Summary"] },
          { cell_type: "raw", source: "raw input" },
          {
            cell_type: "code",
            execution_count: 7,
            source: ["print(42)\n"],
            metadata: {
              title: "Fallback title",
              codex: {
                title: "Calculation",
                descriptionMarkdown: "**Calculates** the answer",
                outputSummaries: [{ summaryMarkdown: "Answer is 42" }],
              },
            },
            outputs: [{ output_type: "stream", text: ["4", "2\n"] }],
          },
        ],
      }),
    );
    expect(document.title).toBe("Experiment");
    expect(document.cells).toHaveLength(3);
    expect(notebookCellTitle(document.cells[0]!, 0)).toBe("Results");
    expect(document.cells[2]).toMatchObject({
      title: "Calculation",
      executionCount: 7,
      descriptionMarkdown: "**Calculates** the answer",
      outputs: [{ type: "stream", text: "42\n", summaryMarkdown: "Answer is 42" }],
    });
  });

  it("selects the same supported MIME priority as the installed desktop reader", () => {
    const document = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            source: "",
            outputs: [
              {
                output_type: "display_data",
                data: {
                  "image/png": ["YW ", "Jj\n"],
                  "text/html": "<b>hidden</b>",
                  "text/plain": "hidden",
                },
              },
              {
                output_type: "display_data",
                data: {
                  "text/html": "<table><tr><td>42</td></tr></table>",
                  "text/markdown": "**hidden**",
                },
              },
              {
                output_type: "execute_result",
                data: { "text/markdown": ["# ", "Heading"], "text/plain": "hidden" },
              },
              {
                output_type: "execute_result",
                data: { "text/plain": "plain", "application/json": { hidden: true } },
              },
              { output_type: "display_data", data: { "application/json": { answer: 42 } } },
              {
                output_type: "error",
                ename: "ValueError",
                evalue: "bad",
                traceback: ["line1\n", "line2"],
              },
            ],
          },
        ],
      }),
    );
    expect(document.cells[0]!.outputs.map((output) => output.type)).toEqual([
      "image",
      "html",
      "markdown",
      "text",
      "json",
      "error",
    ]);
    expect(document.cells[0]!.outputs[0]).toMatchObject({
      dataUrl: "data:image/png;base64,YWJj",
      outputNumber: 1,
    });
    expect(document.cells[0]!.outputs[5]).toMatchObject({
      name: "ValueError",
      message: "bad",
      traceback: "line1\nline2",
    });
  });

  it("supports image-only SVG/JPEG and JSON fallbacks without executing renderer packages", () => {
    const document = parseNotebook(
      JSON.stringify({
        cells: [
          {
            cell_type: "code",
            outputs: [
              {
                output_type: "display_data",
                data: { "image/svg+xml": "<svg><text>safe image context</text></svg>" },
              },
              { output_type: "display_data", data: { "image/jpeg": "AA==" } },
              {
                output_type: "display_data",
                data: { "application/vnd.vega.v5+json": { mark: "bar" } },
              },
              { output_type: "display_data", data: { "application/javascript": "alert('no')" } },
            ],
          },
        ],
      }),
    );
    expect(document.cells[0]!.outputs).toHaveLength(3);
    expect(document.cells[0]!.outputs[0]).toMatchObject({
      dataUrl:
        "data:image/svg+xml;charset=utf-8,%3Csvg%3E%3Ctext%3Esafe%20image%20context%3C%2Ftext%3E%3C%2Fsvg%3E",
    });
    expect(document.cells[0]!.outputs[2]).toMatchObject({
      type: "json",
      text: '{\n  "mark": "bar"\n}',
    });
  });

  it("handles unknown/raw/empty cells and rejects malformed structures", () => {
    expect(parseNotebook('{"cells":[]}')).toEqual({ title: null, cells: [] });
    expect(
      parseNotebook('{"cells":[{"cell_type":"future","source":"raw"}]}').cells[0],
    ).toMatchObject({ cellType: "raw", source: "raw" });
    for (const source of [
      "broken",
      "[]",
      "{}",
      '{"cells":[null]}',
      '{"cells":[{"cell_type":"code","source":[1]}]}',
      '{"cells":[{"cell_type":"code","execution_count":1.5}]}',
    ]) {
      expect(() => parseNotebook(source)).toThrow();
    }
  });

  it("keeps large code cells inside one code fence without argument-count overflow", () => {
    const code = "`value`\n".repeat(150_000) + "````";
    const fenced = notebookCodeFence(code, "python");
    expect(fenced.startsWith("`````python\n")).toBe(true);
    expect(fenced.endsWith("\n`````")).toBe(true);
    expect(fenced).toContain(code);
  });

  it("wraps HTML outputs with script, network, form and nested-frame prohibitions", () => {
    const html = notebookHtmlDocument(
      "<table><tr><td>42</td></tr></table><script>window.parent.pwned=true</script>",
    );
    expect(html).toContain("script-src 'none'");
    expect(html).toContain("connect-src 'none'");
    expect(html).toContain("form-action 'none'");
    expect(html).toContain("frame-src 'none'");
    expect(html.indexOf("Content-Security-Policy")).toBeLessThan(html.indexOf("<script>"));
  });
});
