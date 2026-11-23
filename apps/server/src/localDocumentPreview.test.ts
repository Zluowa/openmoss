import http from "node:http";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";

import * as NodeHttpServer from "@effect/platform-node/NodeHttpServer";
import { DateTime, Effect, Exit, Layer, Scope } from "effect";
import { HttpRouter } from "effect/unstable/http";
import { afterEach, describe, expect, it } from "vitest";

import { AuthError, ServerAuth, type ServerAuthShape } from "./auth/Services/ServerAuth";
import {
  resolveDefaultChatWorkspaceRoot,
  resolveDefaultGroupsWorkspaceRoot,
  resolveDefaultStudioWorkspaceRoot,
  ServerConfig,
  type ServerConfigShape,
} from "./config";
import {
  localDocumentPreviewEffectRouteLayer,
  MAX_ZIP_ENTRY_BYTES,
  parseCsvText,
  parseLocalDocumentPreview,
} from "./localDocumentPreview";
import { createLocalPreviewGrant } from "./localImageFiles";

const tempDirs: string[] = [];

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => fs.rm(dir, { recursive: true, force: true })));
});

function crc32(buf: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buf.length; i += 1) {
    crc ^= buf[i]!;
    for (let bit = 0; bit < 8; bit += 1) {
      crc = (crc & 1) !== 0 ? (crc >>> 1) ^ 0xedb88320 : crc >>> 1;
    }
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function buildZip(
  entries: ReadonlyArray<{
    readonly name: string;
    readonly data: Buffer | string;
    readonly deflate?: boolean;
    readonly dataDescriptor?: boolean;
  }>,
): Buffer {
  const localParts: Buffer[] = [];
  const centralParts: Buffer[] = [];
  let offset = 0;

  for (const entry of entries) {
    const nameBuf = Buffer.from(entry.name, "utf8");
    const raw = typeof entry.data === "string" ? Buffer.from(entry.data, "utf8") : entry.data;
    const useDeflate = entry.deflate !== false;
    const compressed = useDeflate ? zlib.deflateRawSync(raw) : raw;
    const method = useDeflate ? 8 : 0;
    const crc = crc32(raw);
    const flags = 0x0800 | (entry.dataDescriptor ? 0x0008 : 0);

    const lh = Buffer.alloc(30);
    lh.writeUInt32LE(0x04034b50, 0);
    lh.writeUInt16LE(20, 4);
    lh.writeUInt16LE(flags, 6);
    lh.writeUInt16LE(method, 8);
    lh.writeUInt32LE(entry.dataDescriptor ? 0 : crc, 14);
    lh.writeUInt32LE(entry.dataDescriptor ? 0 : compressed.length, 18);
    lh.writeUInt32LE(entry.dataDescriptor ? 0 : raw.length, 22);
    lh.writeUInt16LE(nameBuf.length, 26);

    const dd = entry.dataDescriptor ? Buffer.alloc(16) : Buffer.alloc(0);
    if (entry.dataDescriptor) {
      dd.writeUInt32LE(0x08074b50, 0);
      dd.writeUInt32LE(crc, 4);
      dd.writeUInt32LE(compressed.length, 8);
      dd.writeUInt32LE(raw.length, 12);
    }

    localParts.push(lh, nameBuf, compressed, dd);

    const ch = Buffer.alloc(46);
    ch.writeUInt32LE(0x02014b50, 0);
    ch.writeUInt16LE(20, 4);
    ch.writeUInt16LE(20, 6);
    ch.writeUInt16LE(flags, 8);
    ch.writeUInt16LE(method, 10);
    ch.writeUInt32LE(crc, 16);
    ch.writeUInt32LE(compressed.length, 20);
    ch.writeUInt32LE(raw.length, 24);
    ch.writeUInt16LE(nameBuf.length, 28);
    ch.writeUInt32LE(offset, 42);
    centralParts.push(ch, nameBuf);

    offset += lh.length + nameBuf.length + compressed.length + dd.length;
  }

  const centralDir = Buffer.concat(centralParts);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(centralDir.length, 12);
  eocd.writeUInt32LE(offset, 16);

  return Buffer.concat([...localParts, centralDir, eocd]);
}

function makeServerConfig(overrides: Partial<ServerConfigShape> = {}): ServerConfigShape {
  const baseDir = overrides.baseDir ?? os.tmpdir();
  return {
    mode: "web",
    port: 0,
    host: "127.0.0.1",
    cwd: baseDir,
    homeDir: os.homedir(),
    chatWorkspaceRoot: resolveDefaultChatWorkspaceRoot({ homeDir: os.homedir() }),
    studioWorkspaceRoot: resolveDefaultStudioWorkspaceRoot({ homeDir: os.homedir() }),
    groupsWorkspaceRoot: resolveDefaultGroupsWorkspaceRoot({ homeDir: os.homedir() }),
    baseDir,
    keybindingsConfigPath: path.join(baseDir, "keybindings.json"),
    serverRuntimeStatePath: path.join(baseDir, "runtime.json"),
    serverSettingsPath: path.join(baseDir, "settings.json"),
    attachmentsDir: path.join(baseDir, "attachments"),
    sqlitePath: path.join(baseDir, "state.sqlite"),
    staticDir: undefined,
    devUrl: undefined,
    noBrowser: true,
    authToken: undefined,
    autoBootstrapProjectFromCwd: false,
    logProviderEvents: false,
    logWebSocketEvents: false,
    ...overrides,
  } as ServerConfigShape;
}

function makeFakeServerAuth(allow: boolean): ServerAuthShape {
  const expiresAt = Effect.runSync(DateTime.now);
  return {
    authenticateHttpRequest: () =>
      allow
        ? Effect.succeed({
            sessionId: "session-id" as never,
            subject: "owner",
            method: "bearer-session-token" as const,
            role: "owner" as const,
            expiresAt,
            credentialSource: "bearer" as const,
          })
        : Effect.fail(new AuthError({ message: "Authentication required.", status: 401 })),
  } as unknown as ServerAuthShape;
}

async function withDocServer(
  config: ServerConfigShape,
  allowAuth: boolean,
  run: (origin: string) => Promise<void>,
): Promise<void> {
  const scope = await Effect.runPromise(Scope.make("sequential"));
  let nodeServer: http.Server | null = null;
  const services = Layer.mergeAll(
    Layer.succeed(ServerConfig, config),
    Layer.succeed(ServerAuth, makeFakeServerAuth(allowAuth)),
    NodeHttpServer.layerHttpServices,
  );
  try {
    await Effect.runPromise(
      Scope.provide(
        Effect.gen(function* () {
          const httpServer = yield* NodeHttpServer.make(
            () => {
              nodeServer = http.createServer();
              return nodeServer;
            },
            { port: 0, host: "127.0.0.1" },
          );
          yield* httpServer.serve(
            yield* HttpRouter.toHttpEffect(localDocumentPreviewEffectRouteLayer),
          );
        }).pipe(Effect.provide(services)),
        scope,
      ),
    );
    const address = (nodeServer as http.Server | null)?.address();
    if (!address || typeof address !== "object") throw new Error("Expected server address");
    await run(`http://127.0.0.1:${address.port}`);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
}

describe("localDocumentPreview structured parsers", () => {
  it("parses .docx headings, paragraphs, list items, entities, and tables in reading order", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-docx-"));
    tempDirs.push(dir);
    const docxPath = path.join(dir, "spec.docx");
    const zip = buildZip([
      {
        name: "docProps/core.xml",
        data: `<cp:coreProperties xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:title>Design &amp; Spec</dc:title></cp:coreProperties>`,
        deflate: false,
      },
      {
        name: "word/document.xml",
        deflate: true,
        dataDescriptor: true,
        data: `<?xml version="1.0" encoding="UTF-8"?>
          <w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main">
            <w:body>
              <w:p><w:pPr><w:pStyle w:val="Heading1"/></w:pPr><w:r><w:t>Overview</w:t></w:r></w:p>
              <w:p><w:r><w:t xml:space="preserve">Hello &lt;world&gt; &#x4E2D;</w:t><w:instrText>PAGE</w:instrText></w:r></w:p>
              <w:p><w:pPr><w:numPr><w:ilvl w:val="0"/></w:numPr></w:pPr><w:r><w:t>Bullet item</w:t></w:r></w:p>
              <w:tbl>
                <w:tr>
                  <w:tc><w:p><w:r><w:t>Col A</w:t></w:r></w:p></w:tc>
                  <w:tc><w:p><w:r><w:t>Col B</w:t></w:r></w:p></w:tc>
                </w:tr>
                <w:tr>
                  <w:tc><w:p><w:r><w:t>1</w:t></w:r></w:p></w:tc>
                  <w:tc><w:p><w:r><w:t>2</w:t></w:r></w:p><w:p><w:r><w:t>3</w:t></w:r></w:p></w:tc>
                </w:tr>
              </w:tbl>
            </w:body>
          </w:document>`,
      },
    ]);
    await fs.writeFile(docxPath, zip);

    const result = await parseLocalDocumentPreview(docxPath);
    expect(result).toEqual({
      kind: "word",
      title: "Design & Spec",
      blocks: [
        { type: "heading", level: 1, text: "Overview" },
        { type: "paragraph", text: "Hello <world> 中" },
        { type: "list-item", text: "Bullet item" },
        {
          type: "table",
          rows: [
            ["Col A", "Col B"],
            ["1", "2\n3"],
          ],
        },
      ],
    });
  });

  it("parses .xlsx shared strings, sparse cells, and enforces 200x40 caps", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-xlsx-"));
    tempDirs.push(dir);
    const xlsxPath = path.join(dir, "budget.xlsx");

    const rowsXml: string[] = [];
    rowsXml.push(
      `<row r="1"><c r="A1" t="s"><v>0</v></c><c r="C1" t="inlineStr"><is><t>Status</t></is></c><c r="AP1"><v>42</v></c></row>`,
    );
    for (let r = 2; r <= 230; r += 1) {
      rowsXml.push(
        `<row r="${r}"><c r="A${r}" t="s"><v>1</v></c><c r="B${r}"><v>${r}</v></c><c r="C${r}" t="b"><v>1</v></c></row>`,
      );
    }

    const zip = buildZip([
      {
        name: "xl/workbook.xml",
        data: `<workbook xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"><sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets></workbook>`,
      },
      {
        name: "xl/_rels/workbook.xml.rels",
        data: `<Relationships><Relationship Id="rId1" Target="worksheets/sheet1.xml"/></Relationships>`,
      },
      {
        name: "xl/sharedStrings.xml",
        data: `<sst><si><t>Item</t><rPh><t>ignored</t></rPh></si><si><t>Widget</t></si></sst>`,
      },
      {
        name: "xl/worksheets/sheet1.xml",
        data: `<worksheet><sheetData>${rowsXml.join("")}</sheetData></worksheet>`,
      },
    ]);
    await fs.writeFile(xlsxPath, zip);

    const result = await parseLocalDocumentPreview(xlsxPath);
    expect(result.kind).toBe("excel");
    if (result.kind !== "excel") throw new Error("Expected excel");
    expect(result.sheets).toHaveLength(1);
    const sheet = result.sheets[0]!;
    expect(sheet.name).toBe("Summary");
    expect(sheet.headers).toEqual(["Item", "", "Status"]);
    expect(sheet.rows.length).toBe(199);
    expect(sheet.totalRows).toBe(230);
    expect(sheet.rows[0]).toEqual(["Widget", "2", "TRUE"]);
    expect(sheet.headers.length).toBeLessThanOrEqual(40);
  });

  it("parses .pptx slides sorted numerically with title and bullet shapes", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-pptx-"));
    tempDirs.push(dir);
    const pptxPath = path.join(dir, "deck.pptx");
    const slideXml = (title: string, bullet: string) =>
      `<p:sld xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main">
        <p:cSld><p:spTree>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="title"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${title}</a:t></a:r></a:p></p:txBody></p:sp>
          <p:sp><p:nvSpPr><p:nvPr><p:ph type="body"/></p:nvPr></p:nvSpPr><p:txBody><a:p><a:r><a:t>${bullet}</a:t></a:r></a:p></p:txBody></p:sp>
        </p:spTree></p:cSld>
      </p:sld>`;

    const zip = buildZip([
      { name: "ppt/slides/slide10.xml", data: slideXml("Tenth", "Ten point") },
      { name: "ppt/slides/slide2.xml", data: slideXml("Second", "Two point") },
      { name: "ppt/slides/slide1.xml", data: slideXml("Intro", "First bullet") },
    ]);
    await fs.writeFile(pptxPath, zip);

    const result = await parseLocalDocumentPreview(pptxPath);
    expect(result).toEqual({
      kind: "powerpoint",
      title: "deck.pptx",
      slides: [
        { index: 1, title: "Intro", bullets: ["First bullet"] },
        { index: 2, title: "Second", bullets: ["Two point"] },
        { index: 10, title: "Tenth", bullets: ["Ten point"] },
      ],
    });
  });

  it("parses RFC 4180 CSV/TSV with quotes, BOM, embedded newlines, and 500-row cap", () => {
    const lines = ['\uFEFFname,"note, quoted"', 'Alice,"line1\nline2 ""ok"""'];
    for (let i = 0; i < 600; i += 1) {
      lines.push(`Row${i},Val${i}`);
    }
    const parsed = parseCsvText(`${lines.join("\r\n")}\r\n`, ",", "data.csv");
    expect(parsed.kind).toBe("csv");
    expect(parsed.headers).toEqual(["name", "note, quoted"]);
    expect(parsed.rows[0]).toEqual(["Alice", 'line1\nline2 "ok"']);
    expect(parsed.rows.length).toBe(499);
    expect(parsed.totalRows).toBe(602);
  });

  it("rejects oversized ZIP entries (ZIP bomb cap)", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-zipbomb-"));
    tempDirs.push(dir);
    const bombPath = path.join(dir, "bomb.docx");
    const bigPayload = Buffer.alloc(MAX_ZIP_ENTRY_BYTES + 1024, 0x41);
    await fs.writeFile(
      bombPath,
      buildZip([{ name: "word/document.xml", data: bigPayload, deflate: true }]),
    );

    await expect(parseLocalDocumentPreview(bombPath)).rejects.toThrow();
  });
});

describe("document preview & offline PDF.js HTTP routes", () => {
  it("serves /api/local-doc-preview with auth, workspace/scratch/grant resolution, and 404/415 statuses", async () => {
    const workspace = await fs.mkdtemp(path.join(os.tmpdir(), "moss-doc-route-ws-"));
    tempDirs.push(workspace);
    await fs.writeFile(path.join(workspace, ".git"), "gitdir: .git");
    await fs.writeFile(path.join(workspace, "data.tsv"), "col1\tcol2\nv1\tv2\n");
    await fs.writeFile(path.join(workspace, "pic.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47]));

    const outsideDir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-doc-outside-"));
    tempDirs.push(outsideDir);
    const outsideCsv = path.join(outsideDir, "outside.csv");
    await fs.writeFile(outsideCsv, "a,b\n1,2\n");
    const grant = await createLocalPreviewGrant({ requestedPath: outsideCsv });

    const scratchRoot = path.join(os.tmpdir(), "moss-codex-workspaces");
    const threadId = `doc-thread-${process.pid}-${Date.now()}`;
    const threadDir = path.join(scratchRoot, threadId);
    tempDirs.push(threadDir);
    await fs.mkdir(threadDir, { recursive: true });
    await fs.writeFile(path.join(threadDir, "scratch.csv"), "x,y\n9,8\n");

    const config = makeServerConfig({
      cwd: workspace,
      baseDir: workspace,
      authToken: "desktop-secret",
    });

    await withDocServer(config, false, async (origin) => {
      const res = await fetch(
        `${origin}/api/local-doc-preview?path=data.tsv&cwd=${encodeURIComponent(workspace)}`,
      );
      expect(res.status).toBe(401);

      const legacyTokenRes = await fetch(
        `${origin}/api/local-doc-preview?path=data.tsv&cwd=${encodeURIComponent(workspace)}&token=desktop-secret`,
      );
      expect(legacyTokenRes.status).toBe(200);
    });

    await withDocServer(config, true, async (origin) => {
      const okRes = await fetch(
        `${origin}/api/local-doc-preview?path=data.tsv&cwd=${encodeURIComponent(workspace)}`,
      );
      expect(okRes.status).toBe(200);
      await expect(okRes.json()).resolves.toMatchObject({
        kind: "csv",
        title: "data.tsv",
        headers: ["col1", "col2"],
        rows: [["v1", "v2"]],
      });

      const grantedRes = await fetch(
        `${origin}/api/local-doc-preview?path=${encodeURIComponent(outsideCsv)}&cwd=${encodeURIComponent(workspace)}&grant=${encodeURIComponent(grant.grant)}`,
      );
      expect(grantedRes.status).toBe(200);
      await expect(grantedRes.json()).resolves.toMatchObject({ kind: "csv", title: "outside.csv" });

      const threadRes = await fetch(
        `${origin}/api/local-doc-preview?path=scratch.csv&threadId=${encodeURIComponent(threadId)}`,
      );
      expect(threadRes.status).toBe(200);
      await expect(threadRes.json()).resolves.toMatchObject({ kind: "csv", title: "scratch.csv" });

      const unsupportedRes = await fetch(
        `${origin}/api/local-doc-preview?path=pic.png&cwd=${encodeURIComponent(workspace)}`,
      );
      expect(unsupportedRes.status).toBe(415);

      const ungrantedOutside = await fetch(
        `${origin}/api/local-doc-preview?path=${encodeURIComponent(outsideCsv)}&cwd=${encodeURIComponent(workspace)}`,
      );
      expect(ungrantedOutside.status).toBe(404);
    });
  });

  it("serves self-contained offline PDF.js viewer HTML, module assets, and ranged PDF bytes by grant", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "moss-pdf-viewer-"));
    tempDirs.push(dir);
    const pdfPath = path.join(dir, "manual.pdf");
    const nonPdfPath = path.join(dir, "notes.txt");
    await fs.writeFile(pdfPath, Buffer.from("%PDF-1.7\n1 0 obj\n<<>>\nendobj\n"));
    await fs.writeFile(nonPdfPath, "hello");

    const pdfGrant = await createLocalPreviewGrant({ requestedPath: pdfPath });
    const nonPdfGrant = await createLocalPreviewGrant({ requestedPath: nonPdfPath });
    const config = makeServerConfig({
      baseDir: dir,
      cwd: dir,
      authToken: "secret-should-not-matter",
    });

    // Intentionally disable standard auth to verify capability-in-path works standalone (WebView).
    await withDocServer(config, false, async (origin) => {
      const htmlRes = await fetch(`${origin}/api/local-pdf-viewer/${pdfGrant.grant}`);
      expect(htmlRes.status).toBe(200);
      expect(htmlRes.headers.get("content-type")).toContain("text/html");
      const csp = htmlRes.headers.get("content-security-policy") ?? "";
      expect(csp).toContain("default-src 'self'");
      expect(csp).toContain("connect-src 'self'");
      expect(csp).not.toContain("https:");
      expect(csp).not.toContain("*");

      const html = await htmlRes.text();
      expect(html).toContain("./pdf.min.mjs");
      expect(html).toContain("./pdf.worker.min.mjs");
      expect(html).toContain("./file.pdf");
      expect(html).toContain('createElement("canvas")');
      expect(html).toContain("page-badge");
      expect(html).not.toMatch(/https?:\/\//iu);

      const libRes = await fetch(`${origin}/api/local-pdf-viewer/${pdfGrant.grant}/pdf.min.mjs`);
      expect(libRes.status).toBe(200);
      expect(libRes.headers.get("content-type")).toContain("text/javascript");
      expect((await libRes.text()).length).toBeGreaterThan(10_000);

      const workerRes = await fetch(
        `${origin}/api/local-pdf-viewer/${pdfGrant.grant}/pdf.worker.min.mjs`,
      );
      expect(workerRes.status).toBe(200);
      expect(workerRes.headers.get("content-type")).toContain("text/javascript");
      expect((await workerRes.text()).length).toBeGreaterThan(10_000);

      const headPdf = await fetch(`${origin}/api/local-pdf-viewer/${pdfGrant.grant}/file.pdf`, {
        method: "HEAD",
      });
      expect(headPdf.status).toBe(200);
      expect(headPdf.headers.get("accept-ranges")).toBe("bytes");
      expect(headPdf.headers.get("content-type")).toBe("application/pdf");

      const rangePdf = await fetch(`${origin}/api/local-pdf-viewer/${pdfGrant.grant}/file.pdf`, {
        headers: { Range: "bytes=0-3" },
      });
      expect(rangePdf.status).toBe(206);
      expect(rangePdf.headers.get("content-range")).toMatch(/^bytes 0-3\//u);
      expect(await rangePdf.text()).toBe("%PDF");

      // Non-PDF or unknown grants are refused.
      expect((await fetch(`${origin}/api/local-pdf-viewer/${nonPdfGrant.grant}`)).status).toBe(404);
      expect(
        (await fetch(`${origin}/api/local-pdf-viewer/${nonPdfGrant.grant}/file.pdf`)).status,
      ).toBe(404);
      expect((await fetch(`${origin}/api/local-pdf-viewer/unknown-grant`)).status).toBe(404);
    });
  });
});
