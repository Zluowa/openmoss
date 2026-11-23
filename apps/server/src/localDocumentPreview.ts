import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import zlib from "node:zlib";

import { Effect, FileSystem, Layer } from "effect";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/unstable/http";

import { authErrorResponse, makeEffectAuthRequest } from "./auth/effectHttp";
import { ServerAuth } from "./auth/Services/ServerAuth";
import { ServerConfig, type ServerConfigShape } from "./config";
import {
  renewLocalPreviewGrant,
  resolveAllowedLocalPreviewFile,
  resolveLocalPreviewGrantRealPath,
} from "./localImageFiles";
import { streamedFileResponseWithRange } from "./localPreviewRange";
import { resolveScratchWorkspacesRoot } from "./scratchWorkspaces";
import { isLocalOnlyAccess, isLoopbackStartupBearer, requestPeer } from "./startupAccess";
import { isTrustedAppOrigin, normalizeCorsOrigin } from "./trustedOrigins";

const inflateRawAsync = promisify(zlib.inflateRaw);

export const LOCAL_DOC_PREVIEW_ROUTE_PATH = "/api/local-doc-preview" as const;
export const LOCAL_PDF_VIEWER_ROUTE_PREFIX = "/api/local-pdf-viewer/" as const;

export const MAX_DOCUMENT_PREVIEW_FILE_BYTES = 16 * 1024 * 1024;
export const MAX_ZIP_ENTRY_BYTES = 8 * 1024 * 1024;
const MAX_ZIP_ENTRIES = 10_000;
const MAX_EXCEL_ROWS = 200;
const MAX_EXCEL_COLS = 40;
const MAX_CSV_ROWS = 500;

const SUPPORTED_DOC_PREVIEW_EXTENSIONS = new Set([
  ".docx",
  ".xlsx",
  ".xlsm",
  ".pptx",
  ".csv",
  ".tsv",
]);

export type WordDocumentBlock =
  | { readonly type: "heading"; readonly level: number; readonly text: string }
  | { readonly type: "paragraph"; readonly text: string }
  | { readonly type: "list-item"; readonly text: string }
  | { readonly type: "table"; readonly rows: readonly (readonly string[])[] };

export interface WordDocumentPreview {
  readonly kind: "word";
  readonly title: string;
  readonly blocks: readonly WordDocumentBlock[];
}

export interface ExcelSheetPreview {
  readonly name: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
}

export interface ExcelDocumentPreview {
  readonly kind: "excel";
  readonly title: string;
  readonly sheets: readonly ExcelSheetPreview[];
}

export interface PowerPointSlidePreview {
  readonly index: number;
  readonly title: string;
  readonly bullets: readonly string[];
}

export interface PowerPointDocumentPreview {
  readonly kind: "powerpoint";
  readonly title: string;
  readonly slides: readonly PowerPointSlidePreview[];
}

export interface CsvDocumentPreview {
  readonly kind: "csv";
  readonly title: string;
  readonly headers: readonly string[];
  readonly rows: readonly (readonly string[])[];
  readonly totalRows: number;
}

export type LocalDocumentPreviewResult =
  | WordDocumentPreview
  | ExcelDocumentPreview
  | PowerPointDocumentPreview
  | CsvDocumentPreview;

export class LocalDocumentPreviewError extends Error {
  readonly status: number;

  constructor(message: string, status = 415) {
    super(message);
    this.name = "LocalDocumentPreviewError";
    this.status = status;
  }
}

function decodeXmlEntities(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#\d+|#x[0-9a-fA-F]+);/gu, (entity) => {
    switch (entity) {
      case "&amp;":
        return "&";
      case "&lt;":
        return "<";
      case "&gt;":
        return ">";
      case "&quot;":
        return '"';
      case "&apos;":
        return "'";
      default: {
        if (entity.startsWith("&#x") || entity.startsWith("&#X")) {
          const codePoint = Number.parseInt(entity.slice(3, -1), 16);
          return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
            ? String.fromCodePoint(codePoint)
            : "";
        }
        const codePoint = Number.parseInt(entity.slice(2, -1), 10);
        return Number.isSafeInteger(codePoint) && codePoint > 0 && codePoint <= 0x10ffff
          ? String.fromCodePoint(codePoint)
          : "";
      }
    }
  });
}

type XmlToken =
  | { readonly kind: "text"; readonly value: string }
  | {
      readonly kind: "tag";
      readonly name: string;
      readonly rawName: string;
      readonly attrs: string;
      readonly closing: boolean;
      readonly selfClosing: boolean;
    };

function findTagEnd(xml: string, start: number): number {
  let quote: string | null = null;
  for (let i = start; i < xml.length; i += 1) {
    const ch = xml[i]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === ">") {
      return i;
    }
  }
  return -1;
}

function* iterateXmlTokens(xml: string): Generator<XmlToken> {
  let i = 0;
  while (i < xml.length) {
    const lt = xml.indexOf("<", i);
    if (lt < 0) {
      if (i < xml.length) {
        yield { kind: "text", value: decodeXmlEntities(xml.slice(i)) };
      }
      break;
    }
    if (lt > i) {
      yield { kind: "text", value: decodeXmlEntities(xml.slice(i, lt)) };
    }
    if (xml.startsWith("<!--", lt)) {
      const end = xml.indexOf("-->", lt + 4);
      i = end < 0 ? xml.length : end + 3;
      continue;
    }
    if (xml.startsWith("<![CDATA[", lt)) {
      const end = xml.indexOf("]]>", lt + 9);
      if (end < 0) {
        yield { kind: "text", value: xml.slice(lt + 9) };
        break;
      }
      yield { kind: "text", value: xml.slice(lt + 9, end) };
      i = end + 3;
      continue;
    }
    if (xml.startsWith("<?", lt) || xml.startsWith("<!", lt)) {
      const end = findTagEnd(xml, lt + 2);
      i = end < 0 ? xml.length : end + 1;
      continue;
    }
    const gt = findTagEnd(xml, lt + 1);
    if (gt < 0) {
      yield { kind: "text", value: decodeXmlEntities(xml.slice(lt)) };
      break;
    }
    const raw = xml.slice(lt + 1, gt).trim();
    i = gt + 1;
    if (!raw) continue;
    const closing = raw.startsWith("/");
    const selfClosing = !closing && raw.endsWith("/");
    const inner = closing ? raw.slice(1).trim() : selfClosing ? raw.slice(0, -1).trim() : raw;
    const match = /^([^\s/>]+)([\s\S]*)$/u.exec(inner);
    if (!match) continue;
    const rawName = match[1]!;
    const colon = rawName.indexOf(":");
    const name = colon >= 0 ? rawName.slice(colon + 1) : rawName;
    yield {
      kind: "tag",
      name,
      rawName,
      attrs: match[2] ?? "",
      closing,
      selfClosing,
    };
  }
}

function readXmlAttr(attrs: string, attrLocalName: string): string | undefined {
  const escaped = attrLocalName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(
    `(?:^|\\s)(?:[A-Za-z_][\\w-]*:)?${escaped}\\s*=\\s*(?:"([^"]*)"|'([^']*)')`,
    "u",
  );
  const match = pattern.exec(attrs);
  if (!match) return undefined;
  return decodeXmlEntities(match[1] ?? match[2] ?? "");
}

function normalizeZipEntryName(name: string): string {
  return name.replaceAll("\\", "/").replace(/^\/+/u, "");
}

function findZipEocdOffset(buf: Buffer): number {
  if (buf.length < 22) return -1;
  const minOffset = Math.max(0, buf.length - 22 - 65_535);
  for (let pos = buf.length - 22; pos >= minOffset; pos -= 1) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      const commentLen = buf.readUInt16LE(pos + 20);
      if (pos + 22 + commentLen === buf.length) {
        return pos;
      }
    }
  }
  for (let pos = buf.length - 22; pos >= minOffset; pos -= 1) {
    if (buf.readUInt32LE(pos) === 0x06054b50) {
      return pos;
    }
  }
  return -1;
}

export async function extractZipEntries(
  zipBuffer: Buffer,
  wanted: (entryName: string) => boolean,
): Promise<Map<string, Buffer>> {
  const eocdOffset = findZipEocdOffset(zipBuffer);
  if (eocdOffset < 0) {
    throw new LocalDocumentPreviewError("Invalid ZIP archive.", 415);
  }
  const totalEntries = zipBuffer.readUInt16LE(eocdOffset + 10);
  const cdSize = zipBuffer.readUInt32LE(eocdOffset + 12);
  const cdOffset = zipBuffer.readUInt32LE(eocdOffset + 16);

  if (totalEntries > MAX_ZIP_ENTRIES) {
    throw new LocalDocumentPreviewError("Archive exceeds entry limit.", 415);
  }
  if (cdOffset + cdSize > eocdOffset) {
    throw new LocalDocumentPreviewError("Corrupt ZIP central directory.", 415);
  }

  const results = new Map<string, Buffer>();
  let cursor = cdOffset;
  const cdEnd = cdOffset + cdSize;

  for (let idx = 0; idx < totalEntries && cursor + 46 <= cdEnd; idx += 1) {
    if (zipBuffer.readUInt32LE(cursor) !== 0x02014b50) {
      throw new LocalDocumentPreviewError("Corrupt ZIP central directory entry.", 415);
    }
    const method = zipBuffer.readUInt16LE(cursor + 10);
    const compressedSize = zipBuffer.readUInt32LE(cursor + 20);
    const uncompressedSize = zipBuffer.readUInt32LE(cursor + 24);
    const nameLen = zipBuffer.readUInt16LE(cursor + 28);
    const extraLen = zipBuffer.readUInt16LE(cursor + 30);
    const commentLen = zipBuffer.readUInt16LE(cursor + 32);
    const localHeaderOffset = zipBuffer.readUInt32LE(cursor + 42);

    const entryRecordEnd = cursor + 46 + nameLen + extraLen + commentLen;
    if (entryRecordEnd > cdEnd) {
      throw new LocalDocumentPreviewError("Truncated ZIP entry header.", 415);
    }

    const name = normalizeZipEntryName(
      zipBuffer.toString("utf8", cursor + 46, cursor + 46 + nameLen),
    );
    cursor = entryRecordEnd;

    if (!name || name.endsWith("/") || !wanted(name)) {
      continue;
    }
    if (uncompressedSize > MAX_ZIP_ENTRY_BYTES || compressedSize > MAX_ZIP_ENTRY_BYTES) {
      throw new LocalDocumentPreviewError("Document entry exceeds size limit.", 415);
    }
    if (localHeaderOffset + 30 > cdOffset) {
      throw new LocalDocumentPreviewError("Invalid ZIP local header offset.", 415);
    }
    if (zipBuffer.readUInt32LE(localHeaderOffset) !== 0x04034b50) {
      throw new LocalDocumentPreviewError("Corrupt ZIP local file header.", 415);
    }
    const lhNameLen = zipBuffer.readUInt16LE(localHeaderOffset + 26);
    const lhExtraLen = zipBuffer.readUInt16LE(localHeaderOffset + 28);
    const dataStart = localHeaderOffset + 30 + lhNameLen + lhExtraLen;
    const dataEnd = dataStart + compressedSize;
    if (dataEnd > cdOffset) {
      throw new LocalDocumentPreviewError("Truncated ZIP entry data.", 415);
    }

    const payload = zipBuffer.subarray(dataStart, dataEnd);
    if (method === 0) {
      results.set(name, Buffer.from(payload));
    } else if (method === 8) {
      const inflated = await inflateRawAsync(payload, {
        maxOutputLength: MAX_ZIP_ENTRY_BYTES,
      }).catch(() => {
        throw new LocalDocumentPreviewError("Failed to decompress document entry.", 415);
      });
      if (inflated.byteLength > MAX_ZIP_ENTRY_BYTES) {
        throw new LocalDocumentPreviewError("Document entry exceeds decompressed limit.", 415);
      }
      results.set(name, inflated);
    } else {
      throw new LocalDocumentPreviewError("Unsupported ZIP compression method.", 415);
    }
  }

  return results;
}

function parseCoreTitle(coreXml: Buffer | undefined): string | null {
  if (!coreXml) return null;
  const xml = coreXml.toString("utf8");
  let inTitle = false;
  let value = "";
  for (const token of iterateXmlTokens(xml)) {
    if (token.kind === "tag") {
      if (token.name === "title") {
        if (token.closing) break;
        if (!token.selfClosing) inTitle = true;
      }
    } else if (inTitle) {
      value += token.value;
    }
  }
  const trimmed = value.trim();
  return trimmed.length > 0 ? trimmed : null;
}

function headingLevelFromStyle(style: string | undefined): number | null {
  if (!style) return null;
  const trimmed = style.trim();
  const headingMatch = /^(?:heading|h)\s*([1-6])$/iu.exec(trimmed);
  if (headingMatch) return Number(headingMatch[1]);
  const zhMatch = /^标题\s*([1-6])$/u.exec(trimmed);
  if (zhMatch) return Number(zhMatch[1]);
  if (/^title$/iu.test(trimmed)) return 1;
  if (/^subtitle$/iu.test(trimmed)) return 2;
  if (/^[1-6]$/u.test(trimmed)) return Number(trimmed);
  return null;
}

export function parseDocxXml(
  documentXml: string,
  fallbackTitle: string,
  coreTitle?: string | null,
): WordDocumentPreview {
  const blocks: WordDocumentBlock[] = [];
  let tblDepth = 0;
  let currentTableRows: string[][] | null = null;
  let currentRowCells: string[] | null = null;
  let currentCellParagraphs: string[] | null = null;
  let inParagraph = false;
  let paragraphText = "";
  let paragraphStyle: string | undefined;
  let paragraphIsList = false;
  let inText = false;
  let skipTextDepth = 0;

  for (const token of iterateXmlTokens(documentXml)) {
    if (token.kind === "text") {
      if (inParagraph && inText && skipTextDepth === 0) {
        paragraphText += token.value;
      }
      continue;
    }

    const { name, attrs, closing, selfClosing } = token;
    if (name === "instrText" || name === "delText" || name === "del") {
      if (!selfClosing) {
        if (closing) skipTextDepth = Math.max(0, skipTextDepth - 1);
        else skipTextDepth += 1;
      }
      continue;
    }

    if (name === "tbl") {
      if (!selfClosing) {
        if (!closing) {
          if (tblDepth === 0) currentTableRows = [];
          tblDepth += 1;
        } else if (tblDepth > 0) {
          if (tblDepth === 1 && currentTableRows && currentTableRows.length > 0) {
            blocks.push({ type: "table", rows: currentTableRows });
          }
          if (tblDepth === 1) {
            currentTableRows = null;
            currentRowCells = null;
            currentCellParagraphs = null;
          }
          tblDepth -= 1;
        }
      }
      continue;
    }

    if (tblDepth === 1 && name === "tr" && !selfClosing) {
      if (!closing) {
        currentRowCells = [];
      } else if (currentRowCells && currentTableRows) {
        currentTableRows.push(currentRowCells);
        currentRowCells = null;
      }
      continue;
    }

    if (tblDepth === 1 && name === "tc" && !selfClosing) {
      if (!closing) {
        currentCellParagraphs = [];
      } else if (currentCellParagraphs && currentRowCells) {
        currentRowCells.push(currentCellParagraphs.join("\n"));
        currentCellParagraphs = null;
      }
      continue;
    }

    if (name === "p") {
      if (selfClosing) continue;
      if (!closing) {
        inParagraph = true;
        paragraphText = "";
        paragraphStyle = undefined;
        paragraphIsList = false;
      } else if (inParagraph) {
        const cleaned = paragraphText.trim();
        inParagraph = false;
        inText = false;
        if (cleaned.length > 0) {
          if (tblDepth > 0) {
            currentCellParagraphs?.push(cleaned);
          } else {
            const level = headingLevelFromStyle(paragraphStyle);
            if (level !== null) {
              blocks.push({ type: "heading", level, text: cleaned });
            } else if (paragraphIsList) {
              blocks.push({ type: "list-item", text: cleaned });
            } else {
              blocks.push({ type: "paragraph", text: cleaned });
            }
          }
        }
      }
      continue;
    }

    if (!inParagraph) continue;
    if (name === "pStyle" && !closing) {
      paragraphStyle = readXmlAttr(attrs, "val");
    } else if (name === "numPr" && !closing) {
      paragraphIsList = true;
    } else if (name === "t" && !selfClosing) {
      inText = !closing;
    } else if (name === "tab" && !closing) {
      paragraphText += "\t";
    } else if ((name === "br" || name === "cr") && !closing) {
      paragraphText += "\n";
    }
  }

  const firstHeading = blocks.find(
    (block): block is Extract<WordDocumentBlock, { type: "heading" }> => block.type === "heading",
  );
  return {
    kind: "word",
    title: coreTitle ?? firstHeading?.text ?? fallbackTitle,
    blocks,
  };
}

function colIndexFromCellRef(ref: string): number | null {
  const match = /^([A-Za-z]+)\d+$/u.exec(ref.trim());
  if (!match) return null;
  const letters = match[1]!.toUpperCase();
  let col = 0;
  for (let i = 0; i < letters.length; i += 1) {
    col = col * 26 + (letters.charCodeAt(i) - 64);
  }
  return col > 0 ? col - 1 : null;
}

function parseSharedStringsXml(xml: string): string[] {
  const strings: string[] = [];
  let inSi = false;
  let inText = false;
  let rPhDepth = 0;
  let current = "";
  for (const token of iterateXmlTokens(xml)) {
    if (token.kind === "text") {
      if (inSi && inText && rPhDepth === 0) current += token.value;
      continue;
    }
    const { name, closing, selfClosing } = token;
    if (name === "rPh" && !selfClosing) {
      rPhDepth = closing ? Math.max(0, rPhDepth - 1) : rPhDepth + 1;
      continue;
    }
    if (name === "si") {
      if (selfClosing) {
        strings.push("");
      } else if (!closing) {
        inSi = true;
        current = "";
        inText = false;
      } else if (inSi) {
        strings.push(current);
        inSi = false;
        inText = false;
      }
      continue;
    }
    if (inSi && name === "t" && !selfClosing) {
      inText = !closing;
    }
  }
  return strings;
}

function parseWorkbookSheets(workbookXml: string, relsXml: string | undefined) {
  const targetsByRelId = new Map<string, string>();
  if (relsXml) {
    for (const token of iterateXmlTokens(relsXml)) {
      if (token.kind === "tag" && !token.closing && token.name === "Relationship") {
        const id = readXmlAttr(token.attrs, "Id");
        const target = readXmlAttr(token.attrs, "Target");
        if (id && target) {
          const normalized = normalizeZipEntryName(target);
          targetsByRelId.set(
            id,
            normalized.startsWith("xl/") ? normalized : `xl/${normalized.replace(/^\.\//u, "")}`,
          );
        }
      }
    }
  }
  const sheets: Array<{ name: string; path: string }> = [];
  for (const token of iterateXmlTokens(workbookXml)) {
    if (token.kind === "tag" && !token.closing && token.name === "sheet") {
      const name = readXmlAttr(token.attrs, "name") ?? `Sheet${sheets.length + 1}`;
      const relId = readXmlAttr(token.attrs, "id");
      const pathFromRel = relId ? targetsByRelId.get(relId) : undefined;
      sheets.push({
        name,
        path: pathFromRel ?? `xl/worksheets/sheet${sheets.length + 1}.xml`,
      });
    }
  }
  return sheets;
}

function parseWorksheetXml(
  xml: string,
  sharedStrings: readonly string[],
  name: string,
): ExcelSheetPreview {
  const parsedRows: string[][] = [];
  let totalRows = 0;
  let inRow = false;
  let currentCells: string[] = [];
  let nextCol = 0;
  let inCell = false;
  let cellCol = 0;
  let cellType = "";
  let inValue = false;
  let cellValue = "";
  let inInlineStr = false;
  let inInlineText = false;
  let inlineText = "";

  for (const token of iterateXmlTokens(xml)) {
    if (token.kind === "text") {
      if (inCell && inValue) cellValue += token.value;
      else if (inCell && inInlineStr && inInlineText) inlineText += token.value;
      continue;
    }
    const { name: tagName, attrs, closing, selfClosing } = token;
    if (tagName === "row") {
      if (selfClosing) {
        totalRows += 1;
        if (parsedRows.length < MAX_EXCEL_ROWS) parsedRows.push([]);
      } else if (!closing) {
        totalRows += 1;
        if (parsedRows.length < MAX_EXCEL_ROWS) {
          inRow = true;
          currentCells = [];
          nextCol = 0;
        }
      } else if (inRow) {
        inRow = false;
        parsedRows.push(currentCells);
      }
      continue;
    }

    if (!inRow) continue;

    if (tagName === "c") {
      if (selfClosing) {
        const ref = readXmlAttr(attrs, "r");
        const col = (ref ? colIndexFromCellRef(ref) : null) ?? nextCol;
        nextCol = col + 1;
        if (col < MAX_EXCEL_COLS) currentCells[col] = "";
      } else if (!closing) {
        inCell = true;
        const ref = readXmlAttr(attrs, "r");
        cellCol = (ref ? colIndexFromCellRef(ref) : null) ?? nextCol;
        nextCol = cellCol + 1;
        cellType = readXmlAttr(attrs, "t") ?? "";
        cellValue = "";
        inlineText = "";
        inValue = false;
        inInlineStr = false;
        inInlineText = false;
      } else if (inCell) {
        inCell = false;
        if (cellCol < MAX_EXCEL_COLS) {
          let resolved = cellValue;
          if (cellType === "s") {
            const idx = Number.parseInt(cellValue.trim(), 10);
            resolved =
              Number.isInteger(idx) && idx >= 0 && idx < sharedStrings.length
                ? sharedStrings[idx]!
                : "";
          } else if (cellType === "inlineStr") {
            resolved = inlineText;
          } else if (cellType === "b") {
            resolved = cellValue.trim() === "1" ? "TRUE" : cellValue.trim() === "0" ? "FALSE" : "";
          }
          currentCells[cellCol] = resolved;
        }
      }
      continue;
    }

    if (!inCell) continue;
    if (tagName === "v" && !selfClosing) {
      inValue = !closing;
    } else if (tagName === "is" && !selfClosing) {
      inInlineStr = !closing;
    } else if (inInlineStr && tagName === "t" && !selfClosing) {
      inInlineText = !closing;
    }
  }

  const maxCols = Math.min(
    MAX_EXCEL_COLS,
    parsedRows.reduce((max, row) => Math.max(max, row.length), 0),
  );
  const normalizedRows = parsedRows.map((row) => {
    const out: string[] = [];
    for (let col = 0; col < maxCols; col += 1) {
      out.push(row[col] ?? "");
    }
    return out;
  });

  return {
    name,
    headers: normalizedRows[0] ?? [],
    rows: normalizedRows.slice(1),
    totalRows,
  };
}

function parseSlideXml(xml: string, index: number): PowerPointSlidePreview {
  const titleParagraphs: string[] = [];
  const bodyParagraphs: string[] = [];
  let inShape = false;
  let isTitleShape = false;
  let shapeParagraphs: string[] = [];
  let inParagraph = false;
  let paragraphText = "";
  let inText = false;

  for (const token of iterateXmlTokens(xml)) {
    if (token.kind === "text") {
      if (inParagraph && inText) paragraphText += token.value;
      continue;
    }
    const { name, attrs, closing, selfClosing } = token;
    if (name === "sp") {
      if (selfClosing) continue;
      if (!closing) {
        inShape = true;
        isTitleShape = false;
        shapeParagraphs = [];
      } else if (inShape) {
        inShape = false;
        if (isTitleShape) titleParagraphs.push(...shapeParagraphs);
        else bodyParagraphs.push(...shapeParagraphs);
      }
      continue;
    }

    if (inShape && name === "ph" && !closing) {
      const phType = readXmlAttr(attrs, "type")?.toLowerCase();
      if (phType === "title" || phType === "ctrtitle") {
        isTitleShape = true;
      }
      continue;
    }

    if (name === "p") {
      if (selfClosing) continue;
      if (!closing) {
        inParagraph = true;
        paragraphText = "";
        inText = false;
      } else if (inParagraph) {
        inParagraph = false;
        inText = false;
        const cleaned = paragraphText.trim();
        if (cleaned.length > 0) {
          if (inShape) shapeParagraphs.push(cleaned);
          else bodyParagraphs.push(cleaned);
        }
      }
      continue;
    }

    if (!inParagraph) continue;
    if (name === "t" && !selfClosing) {
      inText = !closing;
    } else if (name === "br" && !closing) {
      paragraphText += "\n";
    }
  }

  if (titleParagraphs.length > 0) {
    return {
      index,
      title: titleParagraphs.join(" ").trim(),
      bullets: bodyParagraphs,
    };
  }
  return {
    index,
    title: bodyParagraphs[0] ?? "",
    bullets: bodyParagraphs.slice(1),
  };
}

export function parseCsvText(
  rawText: string,
  delimiter: "," | "\t",
  title: string,
): CsvDocumentPreview {
  const text = rawText.startsWith("\uFEFF") ? rawText.slice(1) : rawText;
  if (text.length === 0) {
    return { kind: "csv", title, headers: [], rows: [], totalRows: 0 };
  }

  const parsedRows: string[][] = [];
  let totalRows = 0;
  let currentRow: string[] = [];
  let currentField = "";
  let inQuotes = false;
  let hasRowContent = false;

  const flushRow = () => {
    currentRow.push(currentField);
    totalRows += 1;
    if (parsedRows.length < MAX_CSV_ROWS) {
      parsedRows.push(currentRow);
    }
    currentRow = [];
    currentField = "";
    hasRowContent = false;
  };

  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          currentField += '"';
          i += 1;
        } else {
          inQuotes = false;
        }
      } else {
        currentField += ch;
      }
      continue;
    }

    if (ch === '"' && currentField.length === 0) {
      inQuotes = true;
      hasRowContent = true;
      continue;
    }
    if (ch === delimiter) {
      currentRow.push(currentField);
      currentField = "";
      hasRowContent = true;
      continue;
    }
    if (ch === "\r" || ch === "\n") {
      if (ch === "\r" && text[i + 1] === "\n") i += 1;
      flushRow();
      continue;
    }
    currentField += ch;
    hasRowContent = true;
  }

  if (hasRowContent || currentRow.length > 0) {
    flushRow();
  }

  return {
    kind: "csv",
    title,
    headers: parsedRows[0] ?? [],
    rows: parsedRows.slice(1),
    totalRows,
  };
}

export async function parseLocalDocumentPreview(
  filePath: string,
): Promise<LocalDocumentPreviewResult> {
  const ext = path.extname(filePath).toLowerCase();
  if (!SUPPORTED_DOC_PREVIEW_EXTENSIONS.has(ext)) {
    throw new LocalDocumentPreviewError(`Unsupported document extension: ${ext || "none"}`, 415);
  }
  const stat = await fs.stat(filePath).catch(() => null);
  if (!stat?.isFile()) {
    throw new LocalDocumentPreviewError("Document not found.", 404);
  }
  if (stat.size > MAX_DOCUMENT_PREVIEW_FILE_BYTES) {
    throw new LocalDocumentPreviewError("Document exceeds maximum preview size (16 MiB).", 415);
  }

  const fileName = path.basename(filePath);
  const rawBuffer = await fs.readFile(filePath);
  if (rawBuffer.byteLength > MAX_DOCUMENT_PREVIEW_FILE_BYTES) {
    throw new LocalDocumentPreviewError("Document exceeds maximum preview size (16 MiB).", 415);
  }

  if (ext === ".csv" || ext === ".tsv") {
    return parseCsvText(rawBuffer.toString("utf8"), ext === ".tsv" ? "\t" : ",", fileName);
  }

  if (ext === ".docx") {
    const entries = await extractZipEntries(
      rawBuffer,
      (name) => name === "word/document.xml" || name === "docProps/core.xml",
    );
    const documentXml = entries.get("word/document.xml");
    if (!documentXml) {
      throw new LocalDocumentPreviewError("Missing word/document.xml in DOCX archive.", 415);
    }
    return parseDocxXml(
      documentXml.toString("utf8"),
      fileName,
      parseCoreTitle(entries.get("docProps/core.xml")),
    );
  }

  if (ext === ".xlsx" || ext === ".xlsm") {
    const entries = await extractZipEntries(
      rawBuffer,
      (name) =>
        name === "xl/workbook.xml" ||
        name === "xl/_rels/workbook.xml.rels" ||
        name === "xl/sharedStrings.xml" ||
        name === "docProps/core.xml" ||
        /^xl\/worksheets\/sheet\d+\.xml$/iu.test(name),
    );
    const workbookBuf = entries.get("xl/workbook.xml");
    const sharedStringsBuf = entries.get("xl/sharedStrings.xml");
    const sharedStrings = sharedStringsBuf
      ? parseSharedStringsXml(sharedStringsBuf.toString("utf8"))
      : [];
    const relsText = entries.get("xl/_rels/workbook.xml.rels")?.toString("utf8");
    let sheetEntries = workbookBuf
      ? parseWorkbookSheets(workbookBuf.toString("utf8"), relsText)
      : [];
    if (sheetEntries.length === 0) {
      sheetEntries = Array.from(entries.keys())
        .filter((name) => /^xl\/worksheets\/sheet\d+\.xml$/iu.test(name))
        .toSorted((a, b) => a.localeCompare(b, undefined, { numeric: true }))
        .map((sheetPath, idx) => ({ name: `Sheet${idx + 1}`, path: sheetPath }));
    }
    if (sheetEntries.length === 0) {
      throw new LocalDocumentPreviewError("No worksheets found in workbook.", 415);
    }
    const sheets: ExcelSheetPreview[] = [];
    for (const sheet of sheetEntries) {
      const sheetBuf = entries.get(sheet.path);
      if (!sheetBuf) continue;
      sheets.push(parseWorksheetXml(sheetBuf.toString("utf8"), sharedStrings, sheet.name));
    }
    if (sheets.length === 0) {
      throw new LocalDocumentPreviewError("No readable worksheet XML found in workbook.", 415);
    }
    return {
      kind: "excel",
      title: parseCoreTitle(entries.get("docProps/core.xml")) ?? fileName,
      sheets,
    };
  }

  // .pptx
  const entries = await extractZipEntries(
    rawBuffer,
    (name) => name === "docProps/core.xml" || /^ppt\/slides\/slide\d+\.xml$/iu.test(name),
  );
  const slidePaths = Array.from(entries.keys())
    .map((name) => {
      const match = /^ppt\/slides\/slide(\d+)\.xml$/iu.exec(name);
      return match ? { name, index: Number(match[1]) } : null;
    })
    .filter((entry): entry is { name: string; index: number } => entry !== null)
    .toSorted((a, b) => a.index - b.index);

  if (slidePaths.length === 0) {
    throw new LocalDocumentPreviewError("No slides found in PowerPoint presentation.", 415);
  }
  const slides = slidePaths.map((entry) =>
    parseSlideXml(entries.get(entry.name)!.toString("utf8"), entry.index),
  );
  return {
    kind: "powerpoint",
    title: parseCoreTitle(entries.get("docProps/core.xml")) ?? fileName,
    slides,
  };
}

function docPreviewCorsHeaders(input: {
  readonly config: ServerConfigShape;
  readonly request: HttpServerRequest.HttpServerRequest;
  readonly url: URL;
}): Record<string, string> {
  const origin = normalizeCorsOrigin(input.request.headers.origin);
  if (
    !origin ||
    !isTrustedAppOrigin({ origin, requestOrigin: input.url.origin, config: input.config })
  ) {
    return { Vary: "Origin" };
  }
  return {
    "Access-Control-Allow-Origin": origin,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}

function isLegacyTokenAuthorizedForDoc(input: {
  readonly config: ServerConfigShape;
  readonly url: URL;
  readonly request: HttpServerRequest.HttpServerRequest;
}): boolean {
  if (!isLocalOnlyAccess(input.config, requestPeer(input.request))) {
    return false;
  }
  const legacyToken = input.url.searchParams.get("token");
  return !input.config.authToken || legacyToken === input.config.authToken;
}

const requireAuthenticatedDocRequest = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const config = yield* ServerConfig;
  if (
    isLoopbackStartupBearer({
      ...config,
      authorization: request.headers.authorization,
      peer: requestPeer(request),
    })
  ) {
    return;
  }
  const serverAuth = yield* ServerAuth;
  yield* serverAuth.authenticateHttpRequest(makeEffectAuthRequest(request));
});

function resolveGrantedPdfRealPath(grant: string | undefined): string | null {
  if (!grant) return null;
  const realPath = resolveLocalPreviewGrantRealPath({ token: grant });
  if (!realPath || !/\.pdf$/iu.test(realPath)) return null;
  renewLocalPreviewGrant(grant);
  return realPath;
}

async function resolvePdfJsBuildAssetPath(
  assetName: "pdf.min.mjs" | "pdf.worker.min.mjs",
): Promise<{ readonly path: string; readonly sizeBytes: number } | null> {
  const relativeRoots = [
    path.resolve(import.meta.dirname, "../../web/node_modules/pdfjs-dist/legacy/build"),
    path.resolve(import.meta.dirname, "../../web/node_modules/pdfjs-dist/build"),
    path.resolve(import.meta.dirname, "../../../node_modules/pdfjs-dist/legacy/build"),
    path.resolve(import.meta.dirname, "../../../node_modules/pdfjs-dist/build"),
    path.resolve(import.meta.dirname, "../node_modules/pdfjs-dist/legacy/build"),
    path.resolve(import.meta.dirname, "../node_modules/pdfjs-dist/build"),
    path.resolve(process.cwd(), "apps/web/node_modules/pdfjs-dist/legacy/build"),
    path.resolve(process.cwd(), "apps/web/node_modules/pdfjs-dist/build"),
    path.resolve(process.cwd(), "../web/node_modules/pdfjs-dist/legacy/build"),
    path.resolve(process.cwd(), "../web/node_modules/pdfjs-dist/build"),
  ];
  for (const dir of relativeRoots) {
    const candidate = path.join(dir, assetName);
    const stat = await fs.stat(candidate).catch(() => null);
    if (stat?.isFile()) {
      return { path: candidate, sizeBytes: stat.size };
    }
  }
  return null;
}

function buildOfflinePdfViewerHtml(grant: string, nonce: string): string {
  const encodedGrant = encodeURIComponent(grant);
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=5.0, user-scalable=yes">
  <base href="${LOCAL_PDF_VIEWER_ROUTE_PREFIX}${encodedGrant}/">
  <title>PDF Preview</title>
  <style>
    :root {
      color-scheme: light dark;
      --bg: #f4f4f2;
      --card: #ffffff;
      --ink: #1c1917;
      --badge-bg: rgba(24, 24, 27, 0.78);
      --badge-fg: #fafaf9;
    }
    @media (prefers-color-scheme: dark) {
      :root {
        --bg: #141413;
        --card: #1f1f1d;
        --ink: #f5f5f4;
        --badge-bg: rgba(39, 39, 42, 0.85);
      }
    }
    * { box-sizing: border-box; }
    html, body {
      margin: 0;
      padding: 0;
      background: var(--bg);
      color: var(--ink);
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      -webkit-text-size-adjust: 100%;
    }
    #viewer {
      display: flex;
      flex-direction: column;
      align-items: center;
      gap: 12px;
      padding: 12px 8px 72px;
      min-height: 100vh;
    }
    .page-wrap {
      background: var(--card);
      box-shadow: 0 2px 10px rgba(0, 0, 0, 0.12);
      border-radius: 4px;
      overflow: hidden;
    }
    canvas {
      display: block;
    }
    #hud {
      position: fixed;
      left: 50%;
      bottom: max(14px, env(safe-area-inset-bottom));
      transform: translateX(-50%);
      display: inline-flex;
      align-items: center;
      gap: 10px;
      padding: 6px 12px;
      border-radius: 999px;
      background: var(--badge-bg);
      color: var(--badge-fg);
      font-size: 13px;
      font-variant-numeric: tabular-nums;
      backdrop-filter: blur(8px);
      z-index: 10;
      user-select: none;
    }
    #hud button {
      appearance: none;
      border: 0;
      background: transparent;
      color: inherit;
      font-size: 16px;
      line-height: 1;
      padding: 4px 6px;
      cursor: pointer;
    }
    #status {
      padding: 24px 16px;
      font-size: 14px;
      text-align: center;
      opacity: 0.78;
    }
  </style>
</head>
<body>
  <div id="status">Loading PDF…</div>
  <main id="viewer" aria-label="PDF document"></main>
  <div id="hud" hidden>
    <button type="button" id="zoom-out" aria-label="Zoom out">−</button>
    <span id="page-badge">1 / 1</span>
    <button type="button" id="zoom-in" aria-label="Zoom in">+</button>
  </div>
  <script nonce="${nonce}">
    if (typeof Map !== "undefined" && typeof Map.prototype.getOrInsertComputed !== "function") {
      Object.defineProperty(Map.prototype, "getOrInsertComputed", {
        value(key, cb) {
          if (this.has(key)) return this.get(key);
          const v = cb(key);
          this.set(key, v);
          return v;
        },
        configurable: true,
        writable: true
      });
    }
    if (typeof WeakMap !== "undefined" && typeof WeakMap.prototype.getOrInsertComputed !== "function") {
      Object.defineProperty(WeakMap.prototype, "getOrInsertComputed", {
        value(key, cb) {
          if (this.has(key)) return this.get(key);
          const v = cb(key);
          this.set(key, v);
          return v;
        },
        configurable: true,
        writable: true
      });
    }
  </script>
  <script type="module" nonce="${nonce}">
    import * as pdfjsLib from "./pdf.min.mjs";

    pdfjsLib.GlobalWorkerOptions.workerSrc = "./pdf.worker.min.mjs";

    const viewer = document.getElementById("viewer");
    const statusEl = document.getElementById("status");
    const hud = document.getElementById("hud");
    const pageBadge = document.getElementById("page-badge");
    const zoomInBtn = document.getElementById("zoom-in");
    const zoomOutBtn = document.getElementById("zoom-out");

    let pdfDoc = null;
    let userScale = 1;
    let currentPage = 1;
    let renderGeneration = 0;

    function updateBadge() {
      if (!pdfDoc) return;
      pageBadge.textContent = currentPage + " / " + pdfDoc.numPages;
    }

    function updateVisiblePage() {
      const wraps = viewer.querySelectorAll(".page-wrap");
      if (!wraps.length) return;
      const midY = window.innerHeight * 0.4;
      let bestPage = 1;
      let bestDist = Infinity;
      for (const wrap of wraps) {
        const rect = wrap.getBoundingClientRect();
        const dist = Math.abs((rect.top + rect.bottom) * 0.5 - midY);
        if (dist < bestDist) {
          bestDist = dist;
          bestPage = Number(wrap.dataset.page || "1");
        }
      }
      if (bestPage !== currentPage) {
        currentPage = bestPage;
        updateBadge();
      }
    }

    async function renderAllPages() {
      if (!pdfDoc) return;
      const gen = ++renderGeneration;
      viewer.innerHTML = "";
      const containerWidth = Math.max(260, (document.documentElement.clientWidth || window.innerWidth) - 16);
      const dpr = Math.min(window.devicePixelRatio || 1, 3);

      for (let pageNumber = 1; pageNumber <= pdfDoc.numPages; pageNumber += 1) {
        if (gen !== renderGeneration) return;
        const page = await pdfDoc.getPage(pageNumber);
        const baseViewport = page.getViewport({ scale: 1 });
        const fitScale = (containerWidth / baseViewport.width) * userScale;
        const viewport = page.getViewport({ scale: fitScale });

        const wrap = document.createElement("div");
        wrap.className = "page-wrap";
        wrap.dataset.page = String(pageNumber);

        const canvas = document.createElement("canvas");
        canvas.width = Math.max(1, Math.floor(viewport.width * dpr));
        canvas.height = Math.max(1, Math.floor(viewport.height * dpr));
        canvas.style.width = viewport.width + "px";
        canvas.style.height = viewport.height + "px";
        wrap.appendChild(canvas);
        viewer.appendChild(wrap);

        const ctx = canvas.getContext("2d");
        await page.render({
          canvas,
          canvasContext: ctx,
          viewport,
          transform: dpr !== 1 ? [dpr, 0, 0, dpr, 0, 0] : undefined
        }).promise;
      }
      updateVisiblePage();
    }

    let pinchStartDist = 0;
    let pinchStartScale = 1;
    function touchDist(t0, t1) {
      return Math.hypot(t0.clientX - t1.clientX, t0.clientY - t1.clientY);
    }
    viewer.addEventListener("touchstart", (ev) => {
      if (ev.touches.length === 2) {
        pinchStartDist = touchDist(ev.touches[0], ev.touches[1]);
        pinchStartScale = userScale;
      }
    }, { passive: true });
    viewer.addEventListener("touchend", (ev) => {
      if (pinchStartDist > 0 && ev.changedTouches.length > 0 && ev.touches.length < 2) {
        pinchStartDist = 0;
      }
    }, { passive: true });
    viewer.addEventListener("touchmove", (ev) => {
      if (ev.touches.length === 2 && pinchStartDist > 0) {
        const nextDist = touchDist(ev.touches[0], ev.touches[1]);
        const nextScale = Math.min(3, Math.max(0.6, pinchStartScale * (nextDist / pinchStartDist)));
        if (Math.abs(nextScale - userScale) >= 0.12) {
          userScale = nextScale;
          void renderAllPages();
        }
      }
    }, { passive: true });

    zoomInBtn.addEventListener("click", () => {
      userScale = Math.min(3, userScale + 0.25);
      void renderAllPages();
    });
    zoomOutBtn.addEventListener("click", () => {
      userScale = Math.max(0.6, userScale - 0.25);
      void renderAllPages();
    });
    window.addEventListener("scroll", updateVisiblePage, { passive: true });

    try {
      const response = await fetch("./file.pdf");
      if (!response.ok) throw new Error("HTTP " + response.status);
      const data = new Uint8Array(await response.arrayBuffer());
      pdfDoc = await pdfjsLib.getDocument({ data }).promise;
      statusEl.remove();
      hud.hidden = false;
      updateBadge();
      await renderAllPages();
    } catch (error) {
      statusEl.textContent = "Failed to load PDF: " + (error instanceof Error ? error.message : String(error));
    }
  </script>
</body>
</html>`;
}

function pdfViewerSecurityHeaders(nonce: string): Record<string, string> {
  return {
    "Cache-Control": "no-store",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": [
      "default-src 'self'",
      "base-uri 'self'",
      "object-src 'none'",
      `script-src 'self' 'nonce-${nonce}' 'wasm-unsafe-eval'`,
      "style-src 'self' 'unsafe-inline'",
      "img-src 'self' data: blob:",
      "connect-src 'self'",
      "worker-src 'self' blob:",
      "frame-ancestors 'self'",
      "form-action 'none'",
    ].join("; "),
  };
}

const localDocPreviewRoute = HttpRouter.add(
  "GET",
  LOCAL_DOC_PREVIEW_ROUTE_PATH,
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const url = HttpServerRequest.toURL(request);
    if (!url) return HttpServerResponse.text("Bad Request", { status: 400 });

    const config = yield* ServerConfig;
    const corsHeaders = docPreviewCorsHeaders({ config, request, url });
    if (!isLegacyTokenAuthorizedForDoc({ config, url, request })) {
      yield* requireAuthenticatedDocRequest;
    }

    const previewFile = yield* Effect.promise(() =>
      resolveAllowedLocalPreviewFile({
        requestedPath: url.searchParams.get("path"),
        cwd: url.searchParams.get("cwd"),
        codexHomePaths: [],
        scratchWorkspacesRoot: resolveScratchWorkspacesRoot(),
        allowAbsoluteLocalPreviewFile: true,
        previewGrant: url.searchParams.get("grant"),
        allowAnyExtension: true,
        threadId: url.searchParams.get("threadId"),
      }).catch(() => null),
    );
    if (!previewFile) {
      return HttpServerResponse.jsonUnsafe(
        { error: "Not Found" },
        { status: 404, headers: corsHeaders },
      );
    }

    const ext = path.extname(previewFile.path).toLowerCase();
    if (!SUPPORTED_DOC_PREVIEW_EXTENSIONS.has(ext)) {
      return HttpServerResponse.jsonUnsafe(
        { error: `Unsupported document type: ${ext || "unknown"}` },
        { status: 415, headers: corsHeaders },
      );
    }

    const parsed = yield* Effect.tryPromise({
      try: () => parseLocalDocumentPreview(previewFile.path),
      catch: (error) =>
        error instanceof LocalDocumentPreviewError
          ? error
          : new LocalDocumentPreviewError("Failed to parse document preview.", 415),
    }).pipe(Effect.result);

    if (parsed._tag === "Failure") {
      return HttpServerResponse.jsonUnsafe(
        { error: parsed.failure.message },
        { status: parsed.failure.status, headers: corsHeaders },
      );
    }

    return HttpServerResponse.jsonUnsafe(parsed.success, {
      status: 200,
      headers: {
        ...corsHeaders,
        "Cache-Control": "private, no-store",
        "X-Content-Type-Options": "nosniff",
      },
    });
  }).pipe(Effect.catchTag("AuthError", (error) => Effect.succeed(authErrorResponse(error)))),
);

const servePdfViewerHtml = Effect.gen(function* () {
  const params = yield* HttpRouter.params;
  const realPath = resolveGrantedPdfRealPath(params.grant);
  if (!realPath || !params.grant) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const nonce = crypto.randomBytes(16).toString("hex");
  return HttpServerResponse.text(buildOfflinePdfViewerHtml(params.grant, nonce), {
    status: 200,
    contentType: "text/html; charset=utf-8",
    headers: pdfViewerSecurityHeaders(nonce),
  });
});

const servePdfJsAsset = (assetName: "pdf.min.mjs" | "pdf.worker.min.mjs") =>
  Effect.gen(function* () {
    const request = yield* HttpServerRequest.HttpServerRequest;
    const params = yield* HttpRouter.params;
    const realPath = resolveGrantedPdfRealPath(params.grant);
    if (!realPath) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const asset = yield* Effect.promise(() => resolvePdfJsBuildAssetPath(assetName));
    if (!asset) {
      return HttpServerResponse.text("Not Found", { status: 404 });
    }
    const fileSystem = yield* FileSystem.FileSystem;
    return streamedFileResponseWithRange({
      request,
      fileSystem,
      path: asset.path,
      sizeBytes: asset.sizeBytes,
      contentType: "text/javascript; charset=utf-8",
      headers: {
        "Cache-Control": "private, max-age=3600",
        "X-Content-Type-Options": "nosniff",
      },
    });
  });

const serveGrantedPdfBytes = Effect.gen(function* () {
  const request = yield* HttpServerRequest.HttpServerRequest;
  const params = yield* HttpRouter.params;
  const realPath = resolveGrantedPdfRealPath(params.grant);
  if (!realPath) {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  const fileSystem = yield* FileSystem.FileSystem;
  const fileInfo = yield* fileSystem.stat(realPath).pipe(Effect.catch(() => Effect.succeed(null)));
  if (!fileInfo || fileInfo.type !== "File") {
    return HttpServerResponse.text("Not Found", { status: 404 });
  }
  return streamedFileResponseWithRange({
    request,
    fileSystem,
    path: realPath,
    sizeBytes: Number(fileInfo.size),
    contentType: "application/pdf",
    headers: {
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
    },
  });
});

export const localDocumentPreviewEffectRouteLayer = Layer.mergeAll(
  localDocPreviewRoute,
  HttpRouter.add("GET", `${LOCAL_PDF_VIEWER_ROUTE_PREFIX}:grant`, servePdfViewerHtml),
  HttpRouter.add(
    "GET",
    `${LOCAL_PDF_VIEWER_ROUTE_PREFIX}:grant/pdf.min.mjs`,
    servePdfJsAsset("pdf.min.mjs"),
  ),
  HttpRouter.add(
    "GET",
    `${LOCAL_PDF_VIEWER_ROUTE_PREFIX}:grant/pdf.worker.min.mjs`,
    servePdfJsAsset("pdf.worker.min.mjs"),
  ),
  HttpRouter.add("GET", `${LOCAL_PDF_VIEWER_ROUTE_PREFIX}:grant/file.pdf`, serveGrantedPdfBytes),
);
