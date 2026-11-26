// FILE: iconBuilder.ts
// Purpose: Builds multi-resolution Windows ICO (16..64px 32-bit BMP + 256px PNG) and PNG icons
//          using offscreen Canvas2D (`Intl.Segmenter` CJK/Emoji/Latin), `<link rel="apple-touch-icon">`
//          page icon extraction (5s race + late update), and pure-Buffer deterministic fallback.
// Layer: Desktop pageApps

import * as Crypto from "node:crypto";
import * as Zlib from "node:zlib";

import { encodeWindowsShellIco, type ShellIcoBitmap } from "../windowsShellIco";

export const PAGE_APP_ICO_BMP_SIZES = [16, 20, 24, 32, 40, 48, 64] as const;
export const PAGE_APP_ICO_PNG_SIZE = 256;
export const PAGE_APP_CANVAS_ICON_SIZE = 1024;
export const PAGE_APP_ICON_DATA_URL_PREFIX = "data:image/png;base64,";
export const PAGE_APP_ICON_MAX_BYTES = 262_144; // 256 KB

const GRADIENT_PALETTES: readonly (readonly [
  readonly [number, number, number],
  readonly [number, number, number],
])[] = [
  [
    [59, 130, 246],
    [37, 99, 235],
  ],
  [
    [16, 185, 129],
    [5, 150, 105],
  ],
  [
    [245, 158, 11],
    [217, 119, 6],
  ],
  [
    [139, 92, 246],
    [109, 40, 217],
  ],
  [
    [236, 72, 153],
    [219, 39, 119],
  ],
  [
    [20, 184, 166],
    [13, 148, 136],
  ],
  [
    [249, 115, 22],
    [234, 88, 12],
  ],
  [
    [99, 102, 241],
    [79, 70, 229],
  ],
];

// 5x7 crisp pixel glyphs for A-Z and 0-9 when offscreen Canvas2D is unavailable (unit tests).
const FONT_5X7: Readonly<Record<string, readonly string[]>> = {
  A: ["01110", "10001", "10001", "11111", "10001", "10001", "10001"],
  B: ["11110", "10001", "10001", "11110", "10001", "10001", "11110"],
  C: ["01111", "10000", "10000", "10000", "10000", "10000", "01111"],
  D: ["11110", "10001", "10001", "10001", "10001", "10001", "11110"],
  E: ["11111", "10000", "10000", "11110", "10000", "10000", "11111"],
  F: ["11111", "10000", "10000", "11110", "10000", "10000", "10000"],
  G: ["01111", "10000", "10000", "10111", "10001", "10001", "01110"],
  H: ["10001", "10001", "10001", "11111", "10001", "10001", "10001"],
  I: ["01110", "00100", "00100", "00100", "00100", "00100", "01110"],
  J: ["00111", "00010", "00010", "00010", "10010", "10010", "01100"],
  K: ["10001", "10010", "10100", "11000", "10100", "10010", "10001"],
  L: ["10000", "10000", "10000", "10000", "10000", "10000", "11111"],
  M: ["10001", "11011", "10101", "10101", "10001", "10001", "10001"],
  N: ["10001", "11001", "10101", "10011", "10001", "10001", "10001"],
  O: ["01110", "10001", "10001", "10001", "10001", "10001", "01110"],
  P: ["11110", "10001", "10001", "11110", "10000", "10000", "10000"],
  Q: ["01110", "10001", "10001", "10001", "10101", "10010", "01101"],
  R: ["11110", "10001", "10001", "11110", "10100", "10010", "10001"],
  S: ["01111", "10000", "10000", "01110", "00001", "00001", "11110"],
  T: ["11111", "00100", "00100", "00100", "00100", "00100", "00100"],
  U: ["10001", "10001", "10001", "10001", "10001", "10001", "01110"],
  V: ["10001", "10001", "10001", "10001", "01010", "01010", "00100"],
  W: ["10001", "10001", "10001", "10101", "10101", "11011", "10001"],
  X: ["10001", "10001", "01010", "00100", "01010", "10001", "10001"],
  Y: ["10001", "10001", "01010", "00100", "00100", "00100", "00100"],
  Z: ["11111", "00001", "00010", "00100", "01000", "10000", "11111"],
  "0": ["01110", "10001", "10011", "10101", "11001", "10001", "01110"],
  "1": ["00100", "01100", "00100", "00100", "00100", "00100", "01110"],
  "2": ["01110", "10001", "00001", "00110", "01000", "10000", "11111"],
  "3": ["11110", "00001", "00001", "01110", "00001", "00001", "11110"],
  "4": ["00010", "00110", "01010", "10010", "11111", "00010", "00010"],
  "5": ["11111", "10000", "11110", "00001", "00001", "10001", "01110"],
  "6": ["01110", "10000", "10000", "11110", "10001", "10001", "01110"],
  "7": ["11111", "00001", "00010", "00100", "01000", "01000", "01000"],
  "8": ["01110", "10001", "10001", "01110", "10001", "10001", "01110"],
  "9": ["01110", "10001", "10001", "01111", "00001", "00001", "01110"],
  "*": ["00100", "10101", "01110", "11111", "01110", "10101", "00100"],
};

const CRC32_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i += 1) {
    let c = i;
    for (let k = 0; k < 8; k += 1) {
      c = (c & 1) !== 0 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

function crc32(buffer: Buffer): number {
  let crc = 0xffffffff;
  for (let i = 0; i < buffer.length; i += 1) {
    crc = CRC32_TABLE[(crc ^ buffer[i]!) & 0xff]! ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function makePngChunk(type: string, data: Buffer): Buffer {
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  chunk.write(type, 4, 4, "ascii");
  data.copy(chunk, 8);
  const crcValue = crc32(chunk.subarray(4, 8 + data.length));
  chunk.writeUInt32BE(crcValue, 8 + data.length);
  return chunk;
}

/** Encodes a raw RGBA buffer (width * height * 4) into a valid PNG buffer. */
export function encodeRgbaToPng(width: number, height: number, rgba: Buffer): Buffer {
  if (rgba.length !== width * height * 4) {
    throw new Error(`Invalid RGBA buffer length for ${width}x${height}`);
  }
  const signature = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; // bit depth
  ihdr[9] = 6; // RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc((stride + 1) * height);
  for (let y = 0; y < height; y += 1) {
    const rowStart = y * (stride + 1);
    raw[rowStart] = 0;
    rgba.copy(raw, rowStart + 1, y * stride, (y + 1) * stride);
  }
  const compressed = Zlib.deflateSync(raw);
  return Buffer.concat([
    signature,
    makePngChunk("IHDR", ihdr),
    makePngChunk("IDAT", compressed),
    makePngChunk("IEND", Buffer.alloc(0)),
  ]);
}

function bgraToRgba(bgra: Buffer): Buffer {
  const rgba = Buffer.alloc(bgra.length);
  for (let i = 0; i < bgra.length; i += 4) {
    rgba[i] = bgra[i + 2]!;
    rgba[i + 1] = bgra[i + 1]!;
    rgba[i + 2] = bgra[i]!;
    rgba[i + 3] = bgra[i + 3]!;
  }
  return rgba;
}

/**
 * Extracts the first grapheme cluster (supporting CJK, Emoji, and Latin) and a deterministic
 * hue `[0..359]` from `seedUuid` using `Intl.Segmenter` (`cr` in `UJzilp8j`).
 */
export function extractIconLetterAndHue(
  title: string,
  seedUuid: string,
): readonly [string, number] {
  const segmenter = new Intl.Segmenter(undefined, { granularity: "grapheme" });
  const firstSegment = [...segmenter.segment(title.trim())][0]?.segment ?? "";
  let hue = 0;
  for (let i = 0; i < seedUuid.length; i += 1) {
    hue = (hue * 31 + seedUuid.charCodeAt(i)) % 360;
  }
  return [firstSegment.toLocaleUpperCase(), hue];
}

function resolveGlyphPattern(title: string): readonly string[] {
  const trimmed = title.trim();
  const firstAscii = trimmed.match(/[A-Za-z0-9]/u)?.[0]?.toUpperCase();
  if (firstAscii && FONT_5X7[firstAscii]) {
    return FONT_5X7[firstAscii]!;
  }
  return FONT_5X7["*"]!;
}

/** Renders a rounded-square gradient icon with a centered glyph in BGRA pixel order. */
export function renderFallbackIconBgra(title: string, seedUuid: string, size: number): Buffer {
  const digest = Crypto.createHash("sha256").update(seedUuid).digest();
  const palette = GRADIENT_PALETTES[digest[0]! % GRADIENT_PALETTES.length]!;
  const [c1, c2] = palette;
  const glyph = resolveGlyphPattern(title);
  const glyphRows = glyph.length;
  const glyphCols = glyph[0]?.length ?? 5;

  const bgra = Buffer.alloc(size * size * 4);
  const radius = Math.max(2, Math.round(size * 0.22));
  const half = (size - 1) / 2;
  const innerLimit = half - radius;

  const glyphBoxSize = size * 0.52;
  const glyphOrigin = (size - glyphBoxSize) / 2;

  for (let y = 0; y < size; y += 1) {
    for (let x = 0; x < size; x += 1) {
      const dx = Math.max(0, Math.abs(x - half) - innerLimit);
      const dy = Math.max(0, Math.abs(y - half) - innerLimit);
      const dist = Math.hypot(dx, dy);
      const edgeDelta = radius - dist;
      if (edgeDelta <= -0.75) continue;

      const alpha = edgeDelta >= 0.75 ? 255 : Math.round(((edgeDelta + 0.75) / 1.5) * 255);
      const t = (x + y) / Math.max(1, 2 * (size - 1));
      let r = Math.round(c1[0] + (c2[0] - c1[0]) * t);
      let g = Math.round(c1[1] + (c2[1] - c1[1]) * t);
      let b = Math.round(c1[2] + (c2[2] - c1[2]) * t);

      const gx = Math.floor(((x - glyphOrigin) / glyphBoxSize) * glyphCols);
      const gy = Math.floor(((y - glyphOrigin) / glyphBoxSize) * glyphRows);
      if (gx >= 0 && gx < glyphCols && gy >= 0 && gy < glyphRows && glyph[gy]?.[gx] === "1") {
        r = 255;
        g = 255;
        b = 255;
      }

      const idx = (y * size + x) * 4;
      bgra[idx] = b;
      bgra[idx + 1] = g;
      bgra[idx + 2] = r;
      bgra[idx + 3] = alpha;
    }
  }
  return bgra;
}

/** Appends a 256x256 PNG entry to an ICO generated by `encodeWindowsShellIco`. */
export function appendPngEntryToIco(bmpIco: Buffer, png256: Buffer): Buffer {
  const existingCount = bmpIco.readUInt16LE(4);
  const oldHeaderSize = 6 + existingCount * 16;
  const newCount = existingCount + 1;
  const newHeaderSize = 6 + newCount * 16;
  const payloadSize = bmpIco.length - oldHeaderSize;
  const totalSize = newHeaderSize + payloadSize + png256.length;

  const out = Buffer.alloc(totalSize);
  out.writeUInt16LE(0, 0);
  out.writeUInt16LE(1, 2);
  out.writeUInt16LE(newCount, 4);

  for (let index = 0; index < existingCount; index += 1) {
    const srcEntry = 6 + index * 16;
    const dstEntry = 6 + index * 16;
    bmpIco.copy(out, dstEntry, srcEntry, srcEntry + 12);
    const oldOffset = bmpIco.readUInt32LE(srcEntry + 12);
    out.writeUInt32LE(oldOffset + 16, dstEntry + 12);
  }

  const pngOffset = newHeaderSize + payloadSize;
  const pngEntry = 6 + existingCount * 16;
  out[pngEntry] = 0;
  out[pngEntry + 1] = 0;
  out[pngEntry + 2] = 0;
  out[pngEntry + 3] = 0;
  out.writeUInt16LE(1, pngEntry + 4);
  out.writeUInt16LE(32, pngEntry + 6);
  out.writeUInt32LE(png256.length, pngEntry + 8);
  out.writeUInt32LE(pngOffset, pngEntry + 12);

  bmpIco.copy(out, newHeaderSize, oldHeaderSize);
  png256.copy(out, pngOffset);
  return out;
}

/**
 * Generates the Canvas2D script (`sr` in `UJzilp8j`) that renders a 1024x1024 rounded-gradient
 * icon with radial sheen, drop shadow, and crisp CJK/Emoji/Latin initial typography.
 */
export function buildCanvas2dIconScript(title: string, seedUuid: string): string {
  const [letter, hue] = extractIconLetterAndHue(title, seedUuid);
  const nextHue = (hue + 28) % 360;
  const size = PAGE_APP_CANVAS_ICON_SIZE;
  return `(() => {
  const S = ${size}, c = document.createElement("canvas");
  c.width = c.height = S;
  const g = c.getContext("2d");
  const radius = Math.round(S * 0.225);
  g.beginPath();
  g.roundRect(0, 0, S, S, radius);
  g.clip();
  const fill = g.createLinearGradient(0, 0, 0, S);
  fill.addColorStop(0, "hsl(${hue} 78% 64%)");
  fill.addColorStop(1, "hsl(${nextHue} 74% 42%)");
  g.fillStyle = fill;
  g.fillRect(0, 0, S, S);
  const sheen = g.createRadialGradient(S * 0.3, S * 0.12, 0, S * 0.3, S * 0.12, S * 0.9);
  sheen.addColorStop(0, "rgba(255,255,255,0.32)");
  sheen.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = sheen;
  g.fillRect(0, 0, S, S);
  const letter = ${JSON.stringify(letter)};
  g.font = '600 ' + S * 0.56 + 'px ui-rounded, -apple-system, "Microsoft YaHei UI", system-ui, sans-serif';
  const wide = g.measureText(letter).width;
  if (wide > S * 0.7) g.font = '600 ' + (S * 0.56 * S * 0.7) / wide + 'px ui-rounded, -apple-system, "Microsoft YaHei UI", system-ui, sans-serif';
  const m = g.measureText(letter);
  g.textAlign = "center";
  g.shadowColor = "rgba(0,0,0,0.18)";
  g.shadowBlur = S * 0.03;
  g.shadowOffsetY = S * 0.012;
  g.fillStyle = "#fff";
  g.fillText(letter, S / 2, S / 2 + (m.actualBoundingBoxAscent - m.actualBoundingBoxDescent) / 2);
  return c.toDataURL("image/png");
})()`;
}

/** Validates a square PNG buffer (`16..1024px`, `<= maxBytes`) and reads its PNG dimensions. */
export function parseSquarePngDimensions(
  png: Buffer,
  maxBytes = PAGE_APP_ICON_MAX_BYTES,
): { readonly width: number; readonly height: number } | null {
  if (png.length < 24 || png.length > maxBytes) return null;
  if (
    png[0] !== 137 ||
    png[1] !== 80 ||
    png[2] !== 78 ||
    png[3] !== 71 ||
    png[4] !== 13 ||
    png[5] !== 10 ||
    png[6] !== 26 ||
    png[7] !== 10
  ) {
    return null;
  }
  const width = png.readUInt32BE(16);
  const height = png.readUInt32BE(20);
  if (width < 16 || width > 1024 || height !== width) return null;
  return { width, height };
}

/** Validates a `data:image/png;base64,...` icon URL into a raw PNG Buffer. */
export function decodeSquarePngDataUrl(
  dataUrl: string,
  maxBytes = PAGE_APP_ICON_MAX_BYTES,
): Buffer | null {
  if (typeof dataUrl !== "string" || !dataUrl.startsWith(PAGE_APP_ICON_DATA_URL_PREFIX)) {
    return null;
  }
  if (dataUrl.length > PAGE_APP_ICON_DATA_URL_PREFIX.length + Math.ceil((maxBytes * 4) / 3) + 4) {
    return null;
  }
  const buf = Buffer.from(dataUrl.slice(PAGE_APP_ICON_DATA_URL_PREFIX.length), "base64");
  return parseSquarePngDimensions(buf, maxBytes) ? buf : null;
}

/**
 * Renders a crisp 1024x1024 fallback PNG data URL using an offscreen sandboxed Electron
 * `WebContentsView` (`partition: "moss-app-icon-draw"`), returning `null` if unavailable.
 */
export async function renderCanvas2dIconDataUrl(
  title: string,
  seedUuid: string,
  timeoutMs = 3_000,
): Promise<string | null> {
  try {
    const electron = await import("electron");
    const ViewCtor = electron.WebContentsView;
    if (typeof ViewCtor !== "function") return null;

    const view = new ViewCtor({
      webPreferences: {
        partition: "moss-app-icon-draw",
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        webviewTag: false,
        backgroundThrottling: false,
        disableDialogs: true,
        devTools: false,
      },
    });
    const wc = view.webContents;
    try {
      wc.setWindowOpenHandler(() => ({ action: "deny" }));
      wc.on("will-navigate", (event) => event.preventDefault());
      const script = buildCanvas2dIconScript(title, seedUuid);
      const dataUrl = await Promise.race([
        wc.loadURL("about:blank").then(() => wc.executeJavaScript(script)),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), timeoutMs)),
      ]);
      if (typeof dataUrl !== "string") return null;
      const decoded = decodeSquarePngDataUrl(dataUrl, 4 * 1024 * 1024);
      return decoded ? dataUrl : null;
    } finally {
      if (!wc.isDestroyed()) wc.close();
    }
  } catch {
    return null;
  }
}

export const EXTRACT_PAGE_ICON_LINK_SCRIPT = `(() => {
  const l =
    document.querySelector('link[rel="apple-touch-icon"][data-moss-icon]') ||
    document.querySelector('link[rel="apple-touch-icon"][data-artifact-icon]') ||
    document.querySelector('link[rel="apple-touch-icon"][href^="data:image/png;base64,"]');
  if (!l) return null;
  const tag = l.getAttribute("data-moss-icon") ?? l.getAttribute("data-artifact-icon") ?? "1";
  return [tag, l.href || ""];
})()`;

/**
 * Polls an open WebContents (or subframes) for `<link rel="apple-touch-icon">` (`data-moss-icon` /
 * `data-artifact-icon`) up to `maxWaitMs`, returning a validated square PNG data URL if found.
 */
export async function pollWebContentsAppleTouchIconDataUrl(
  webContents: {
    isDestroyed(): boolean;
    executeJavaScript(script: string): Promise<unknown>;
    mainFrame?: {
      frames?: readonly {
        isDestroyed?: () => boolean;
        executeJavaScript(script: string): Promise<unknown>;
      }[];
    };
  },
  maxWaitMs = 10_000,
): Promise<string | null> {
  const deadline = Date.now() + maxWaitMs;
  const pollOnce = async (): Promise<string | null> => {
    if (webContents.isDestroyed()) return null;
    const frames = [
      webContents,
      ...(webContents.mainFrame?.frames ?? []).filter((f) => !f.isDestroyed?.()),
    ];
    for (const target of frames) {
      try {
        const res = await target.executeJavaScript(EXTRACT_PAGE_ICON_LINK_SCRIPT);
        if (Array.isArray(res) && typeof res[1] === "string" && res[0] !== "") {
          if (decodeSquarePngDataUrl(res[1])) {
            return res[1];
          }
        }
      } catch {
        // Ignore transient execution errors.
      }
    }
    return null;
  };

  while (Date.now() < deadline && !webContents.isDestroyed()) {
    const found = await pollOnce();
    if (found) return found;
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export interface BuildPageAppIconInput {
  readonly title: string;
  readonly seedUuid: string;
  readonly thumbnailDataUrl?: string | null;
  /** Optional platform image decoder (e.g. Electron nativeImage) returning BGRA of exact size. */
  readonly decodeThumbnailToBgra?: (dataUrl: string, size: number) => Buffer | null;
}

export interface BuiltPageAppIcons {
  readonly ico: Buffer;
  readonly png256: Buffer;
  readonly usedThumbnail: boolean;
}

/** Builds both a multi-resolution Windows .ico and a 256x256 .png for a Page App. */
export function buildPageAppIcons(input: BuildPageAppIconInput): BuiltPageAppIcons {
  let usedThumbnail = false;
  const resolveBgra = (size: number): Buffer => {
    if (input.thumbnailDataUrl && input.decodeThumbnailToBgra) {
      try {
        const decoded = input.decodeThumbnailToBgra(input.thumbnailDataUrl, size);
        if (decoded && decoded.length === size * size * 4) {
          usedThumbnail = true;
          return decoded;
        }
      } catch {
        // Fall back to deterministic gradient icon.
      }
    }
    return renderFallbackIconBgra(input.title, input.seedUuid, size);
  };

  const bitmaps: ShellIcoBitmap[] = PAGE_APP_ICO_BMP_SIZES.map((size) => ({
    width: size,
    height: size,
    bgra: resolveBgra(size),
  }));
  const bmpIco = encodeWindowsShellIco(bitmaps);
  const bgra256 = resolveBgra(PAGE_APP_ICO_PNG_SIZE);
  const png256 = encodeRgbaToPng(PAGE_APP_ICO_PNG_SIZE, PAGE_APP_ICO_PNG_SIZE, bgraToRgba(bgra256));
  const ico = appendPngEntryToIco(bmpIco, png256);

  return { ico, png256, usedThumbnail };
}

/**
 * Races an optional page icon fetch (`timeoutMs = 5000`) against Canvas2D rendering (with pure-Buffer
 * fallback), invoking `onLateArrival` if the page's own icon resolves after the 5s cutoff.
 */
export async function buildPageAppIconsWithRace(options: {
  readonly title: string;
  readonly seedUuid: string;
  readonly thumbnailDataUrl?: string | null;
  readonly decodeThumbnailToBgra?: (dataUrl: string, size: number) => Buffer | null;
  readonly pageIconPromise?: Promise<string | null> | null;
  readonly timeoutMs?: number;
  readonly onLateArrival?: (icons: BuiltPageAppIcons) => void | Promise<void>;
}): Promise<BuiltPageAppIcons> {
  const timeoutMs = options.timeoutMs ?? 5_000;
  const directThumbnail = options.thumbnailDataUrl ?? null;

  if (directThumbnail) {
    return buildPageAppIcons({
      title: options.title,
      seedUuid: options.seedUuid,
      thumbnailDataUrl: directThumbnail,
      ...(options.decodeThumbnailToBgra
        ? { decodeThumbnailToBgra: options.decodeThumbnailToBgra }
        : {}),
    });
  }

  const canvasPromise = renderCanvas2dIconDataUrl(options.title, options.seedUuid).catch(
    () => null,
  );
  const pagePromise = options.pageIconPromise ?? Promise.resolve(null);

  const raced = await Promise.race([
    pagePromise.then((url) => ({ kind: "page" as const, url })),
    new Promise<{ kind: "timeout" }>((resolve) =>
      setTimeout(() => resolve({ kind: "timeout" }), timeoutMs),
    ),
  ]);

  if (raced.kind === "page" && raced.url) {
    return buildPageAppIcons({
      title: options.title,
      seedUuid: options.seedUuid,
      thumbnailDataUrl: raced.url,
      ...(options.decodeThumbnailToBgra
        ? { decodeThumbnailToBgra: options.decodeThumbnailToBgra }
        : {}),
    });
  }

  if (options.pageIconPromise && options.onLateArrival) {
    void pagePromise.then((lateUrl) => {
      if (!lateUrl) return;
      const rebuilt = buildPageAppIcons({
        title: options.title,
        seedUuid: options.seedUuid,
        thumbnailDataUrl: lateUrl,
        ...(options.decodeThumbnailToBgra
          ? { decodeThumbnailToBgra: options.decodeThumbnailToBgra }
          : {}),
      });
      if (rebuilt.usedThumbnail) {
        void options.onLateArrival?.(rebuilt);
      }
    });
  }

  const canvasDataUrl = await canvasPromise;
  return buildPageAppIcons({
    title: options.title,
    seedUuid: options.seedUuid,
    thumbnailDataUrl: canvasDataUrl,
    ...(options.decodeThumbnailToBgra
      ? { decodeThumbnailToBgra: options.decodeThumbnailToBgra }
      : {}),
  });
}
