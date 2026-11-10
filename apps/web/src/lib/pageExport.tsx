// FILE: pageExport.tsx
// Purpose: Download a 资料空间 page as Markdown, HTML, Word (.docx) or PDF (through the print
//          dialog's "save as PDF"), from the page's Markdown projection.
// Layer: Space UI helper
// Why: The page's source of truth is rich JSON; every page also carries a Markdown projection
//      the server keeps in step. Exports read that projection, so they never need the editor.
//      Uses only dependencies Moss already ships (react-markdown + remark-gfm, jszip).

import JSZip from "jszip";
import { renderToStaticMarkup } from "react-dom/server";
import ReactMarkdown from "react-markdown";
import remarkGfm from "remark-gfm";

import { downloadBlob } from "./browserDownload";

export type PageExportFormat = "markdown" | "html" | "docx" | "pdf";

/** A file name that is safe on every desktop OS. */
export function exportFileName(title: string, extension: string): string {
  const base =
    title
      .replace(/[\\/:*?"<>|]+/g, " ")
      .replace(/\p{Cc}+/gu, " ")
      .trim()
      .slice(0, 120) || "页面";
  return `${base}.${extension}`;
}

function escapeHtml(text: string): string {
  return text
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

const EXPORT_STYLES = `body{font-family:"Inter",-apple-system,"Segoe UI","PingFang SC","Microsoft YaHei",sans-serif;max-width:46rem;margin:3rem auto;padding:0 1.5rem;line-height:1.6;color:#141413}
h1,h2,h3{line-height:1.3}pre,code{font-family:ui-monospace,Consolas,monospace;font-size:.9em}pre{background:#f3f2ef;padding:.75rem 1rem;border-radius:8px;overflow:auto}
table{border-collapse:collapse}th,td{border-bottom:1px solid #e3e2de;padding:.35rem .6rem;text-align:left}blockquote{margin:0;padding-left:1rem;border-left:3px solid #e3e2de;color:#55544f}img{max-width:100%}`;

/** A standalone HTML document for the page. */
export function pageToHtml(title: string, markdown: string): string {
  const body = renderToStaticMarkup(
    <ReactMarkdown remarkPlugins={[remarkGfm]} skipHtml>
      {markdown}
    </ReactMarkdown>,
  );
  return `<!doctype html>
<html lang="zh-CN">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)}</title>
<style>${EXPORT_STYLES}</style>
</head>
<body>
<h1>${escapeHtml(title)}</h1>
${body}
</body>
</html>
`;
}

function escapeXml(text: string): string {
  return escapeHtml(text).replaceAll("'", "&apos;");
}

type DocxBlock = {
  style: "Title" | "Heading1" | "Heading2" | "Heading3" | "Normal" | "Code";
  text: string;
  bullet?: string;
};

/** Line-level Markdown to Word paragraphs: headings, lists, quotes, code and plain text. */
export function markdownToDocxBlocks(title: string, markdown: string): DocxBlock[] {
  const blocks: DocxBlock[] = [{ style: "Title", text: title }];
  let inCode = false;
  for (const raw of markdown.replace(/\r\n?/g, "\n").split("\n")) {
    if (/^\s*```/.test(raw)) {
      inCode = !inCode;
      continue;
    }
    if (inCode) {
      blocks.push({ style: "Code", text: raw });
      continue;
    }
    const line = raw.trimEnd();
    if (line.trim() === "" || /^\s*(-{3,}|\*{3,})\s*$/.test(line)) continue;
    const heading = /^(#{1,6})\s+(.*)$/.exec(line);
    if (heading) {
      const level = Math.min(3, heading[1]!.length);
      blocks.push({
        style: `Heading${level}` as DocxBlock["style"],
        text: plainInline(heading[2]!),
      });
      continue;
    }
    const task = /^\s*[-*+]\s+\[([ xX])\]\s+(.*)$/.exec(line);
    if (task) {
      blocks.push({
        style: "Normal",
        text: plainInline(task[2]!),
        bullet: task[1] === " " ? "☐" : "☑",
      });
      continue;
    }
    const bullet = /^\s*[-*+]\s+(.*)$/.exec(line);
    if (bullet) {
      blocks.push({ style: "Normal", text: plainInline(bullet[1]!), bullet: "•" });
      continue;
    }
    const ordered = /^\s*(\d+)[.)]\s+(.*)$/.exec(line);
    if (ordered) {
      blocks.push({ style: "Normal", text: plainInline(ordered[2]!), bullet: `${ordered[1]}.` });
      continue;
    }
    const quote = /^\s*>\s?(.*)$/.exec(line);
    blocks.push({ style: "Normal", text: plainInline(quote ? quote[1]! : line) });
  }
  return blocks;
}

/** Drops inline Markdown marks; keeps link text and image alt text. */
function plainInline(text: string): string {
  return text
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]+)\]\([^)]*\)/g, "$1")
    .replace(/(\*\*|__)(.+?)\1/g, "$2")
    .replace(/(\*|_)(.+?)\1/g, "$2")
    .replace(/~~(.+?)~~/g, "$1")
    .replace(/`([^`]+)`/g, "$1");
}

const DOCX_STYLES = `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:styles xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
<w:docDefaults><w:rPrDefault><w:rPr><w:rFonts w:ascii="Calibri" w:hAnsi="Calibri" w:eastAsia="Microsoft YaHei"/><w:sz w:val="22"/></w:rPr></w:rPrDefault><w:pPrDefault><w:pPr><w:spacing w:after="120" w:line="300" w:lineRule="auto"/></w:pPr></w:pPrDefault></w:docDefaults>
<w:style w:type="paragraph" w:default="1" w:styleId="Normal"><w:name w:val="Normal"/></w:style>
<w:style w:type="paragraph" w:styleId="Title"><w:name w:val="Title"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="240"/></w:pPr><w:rPr><w:b/><w:sz w:val="40"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading1"><w:name w:val="heading 1"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="240"/><w:outlineLvl w:val="0"/></w:pPr><w:rPr><w:b/><w:sz w:val="32"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading2"><w:name w:val="heading 2"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:spacing w:before="200"/><w:outlineLvl w:val="1"/></w:pPr><w:rPr><w:b/><w:sz w:val="28"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Heading3"><w:name w:val="heading 3"/><w:basedOn w:val="Normal"/><w:pPr><w:keepNext/><w:outlineLvl w:val="2"/></w:pPr><w:rPr><w:b/><w:sz w:val="24"/></w:rPr></w:style>
<w:style w:type="paragraph" w:styleId="Code"><w:name w:val="Code"/><w:basedOn w:val="Normal"/><w:pPr><w:spacing w:after="0"/></w:pPr><w:rPr><w:rFonts w:ascii="Consolas" w:hAnsi="Consolas"/><w:sz w:val="20"/></w:rPr></w:style>
</w:styles>`;

/** A minimal, valid .docx (Office Open XML) built from the page's Markdown. */
export async function pageToDocx(title: string, markdown: string): Promise<Blob> {
  const paragraphs = markdownToDocxBlocks(title, markdown)
    .map((block) => {
      const text = block.bullet ? `${block.bullet} ${block.text}` : block.text;
      const indent = block.bullet ? '<w:ind w:left="360" w:hanging="240"/>' : "";
      return `<w:p><w:pPr><w:pStyle w:val="${block.style}"/>${indent}</w:pPr><w:r><w:t xml:space="preserve">${escapeXml(text)}</w:t></w:r></w:p>`;
    })
    .join("");
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/><Override PartName="/word/styles.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.styles+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/></Relationships>`,
  );
  zip.file("word/styles.xml", DOCX_STYLES);
  zip.file(
    "word/document.xml",
    `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body>${paragraphs}<w:sectPr><w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr></w:body></w:document>`,
  );
  return zip.generateAsync({
    type: "blob",
    mimeType: "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  });
}

/** Opens the system print dialog on the page, where "save as PDF" is one of the printers. */
function printHtml(html: string): void {
  const frame = document.createElement("iframe");
  frame.setAttribute("aria-hidden", "true");
  frame.style.cssText =
    "position:fixed;right:0;bottom:0;width:0;height:0;border:0;visibility:hidden";
  frame.srcdoc = html;
  frame.addEventListener("load", () => {
    try {
      frame.contentWindow?.focus();
      frame.contentWindow?.print();
    } finally {
      window.setTimeout(() => frame.remove(), 60_000);
    }
  });
  document.body.append(frame);
}

export async function exportPage(
  format: PageExportFormat,
  page: { title: string; markdown: string },
): Promise<void> {
  switch (format) {
    case "markdown":
      downloadBlob(
        new Blob([`# ${page.title}\n\n${page.markdown}`], { type: "text/markdown;charset=utf-8" }),
        exportFileName(page.title, "md"),
      );
      return;
    case "html":
      downloadBlob(
        new Blob([pageToHtml(page.title, page.markdown)], { type: "text/html;charset=utf-8" }),
        exportFileName(page.title, "html"),
      );
      return;
    case "docx":
      downloadBlob(await pageToDocx(page.title, page.markdown), exportFileName(page.title, "docx"));
      return;
    case "pdf":
      printHtml(pageToHtml(page.title, page.markdown));
      return;
  }
}
