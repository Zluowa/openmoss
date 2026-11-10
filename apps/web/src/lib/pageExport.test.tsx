import JSZip from "jszip";
import { describe, expect, it } from "vitest";

import { exportFileName, markdownToDocxBlocks, pageToDocx, pageToHtml } from "./pageExport";

const markdown = `# Plan

Some **bold** text with [a link](https://example.com).

- first
- [x] done
1. numbered

\`\`\`
const a = 1 < 2;
\`\`\`
`;

describe("page export", () => {
  it("makes safe file names", () => {
    expect(exportFileName('a/b:c*"d', "md")).toBe("a b c d.md");
    expect(exportFileName("   ", "html")).toBe("页面.html");
  });

  it("renders a standalone HTML document without raw HTML from the page", () => {
    const html = pageToHtml("<Title>", `${markdown}\n<script>alert(1)</script>`);
    expect(html).toContain("<title>&lt;Title&gt;</title>");
    expect(html).toContain("<strong>bold</strong>");
    expect(html).toContain('<a href="https://example.com">a link</a>');
    expect(html).not.toContain("<script>");
  });

  it("maps Markdown lines to Word paragraphs", () => {
    expect(markdownToDocxBlocks("Doc", markdown)).toEqual([
      { style: "Title", text: "Doc" },
      { style: "Heading1", text: "Plan" },
      { style: "Normal", text: "Some bold text with a link." },
      { style: "Normal", text: "first", bullet: "•" },
      { style: "Normal", text: "done", bullet: "☑" },
      { style: "Normal", text: "numbered", bullet: "1." },
      { style: "Code", text: "const a = 1 < 2;" },
    ]);
  });

  it("builds a .docx package with escaped text", async () => {
    const blob = await pageToDocx("Doc & notes", markdown);
    const zip = await JSZip.loadAsync(await blob.arrayBuffer());
    expect(Object.keys(zip.files)).toEqual(
      expect.arrayContaining([
        "[Content_Types].xml",
        "_rels/.rels",
        "word/document.xml",
        "word/styles.xml",
      ]),
    );
    const document = await zip.file("word/document.xml")!.async("string");
    expect(document).toContain("Doc &amp; notes");
    expect(document).toContain("const a = 1 &lt; 2;");
  });
});
