import JSZip from "jszip";

/** A real zipped OOXML document with two pages, revisions and hyperlink relationships. */
export async function createDocxPreviewFixture(): Promise<ArrayBuffer> {
  const zip = new JSZip();
  zip.file(
    "[Content_Types].xml",
    `<?xml version="1.0" encoding="UTF-8"?><Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/></Types>`,
  );
  zip.file(
    "_rels/.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`,
  );
  zip.file(
    "word/_rels/document.xml.rels",
    `<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="safe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/document" TargetMode="External"/><Relationship Id="unsafe" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="javascript:alert(1)" TargetMode="External"/></Relationships>`,
  );
  zip.file(
    "word/document.xml",
    `<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><w:body>
    <w:p><w:r><w:t>Document preview fixture</w:t></w:r></w:p>
    <w:p><w:ins w:id="1" w:author="Preview test"><w:r><w:t>Inserted wording</w:t></w:r></w:ins><w:del w:id="2" w:author="Preview test"><w:r><w:delText>Deleted wording</w:delText></w:r></w:del></w:p>
    <w:p><w:hyperlink r:id="safe"><w:r><w:t>Safe link</w:t></w:r></w:hyperlink><w:hyperlink r:id="unsafe"><w:r><w:t>Unsafe link</w:t></w:r></w:hyperlink></w:p>
    <w:p><w:r><w:br w:type="page"/></w:r></w:p><w:p><w:r><w:t>Second page selection</w:t></w:r></w:p>
    <w:sectPr><w:pgSz w:w="12240" w:h="15840"/><w:pgMar w:top="1440" w:right="1440" w:bottom="1440" w:left="1440"/></w:sectPr>
  </w:body></w:document>`,
  );
  return zip.generateAsync({ type: "arraybuffer" });
}
