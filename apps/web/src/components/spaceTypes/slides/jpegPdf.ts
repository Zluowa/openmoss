// FILE: jpegPdf.ts
// Purpose: Writes a PDF whose pages are full-bleed JPEG images (one per slide).
// Layer: 资料空间 幻灯片 export
// Why: The deck is painted by the same DOM painter as the editor and rasterized per slide; a
//      PDF needs only an image XObject per page, so no PDF library is pulled into the bundle.

export interface JpegPage {
  /** Baseline or progressive JPEG bytes. */
  readonly jpeg: Uint8Array;
  /** Pixel size of the JPEG. */
  readonly width: number;
  readonly height: number;
}

const encoder = new TextEncoder();

/** Page size in PDF points; slides keep their 16:9 ratio at 960×540pt (1280×720px at 96dpi). */
export function writeJpegPdf(
  pages: readonly JpegPage[],
  pageSize = { width: 960, height: 540 },
): Uint8Array {
  if (pages.length === 0) throw new Error("A PDF needs at least one page");
  const chunks: Uint8Array[] = [];
  const offsets: number[] = [];
  let length = 0;
  const push = (part: string | Uint8Array) => {
    const bytes = typeof part === "string" ? encoder.encode(part) : part;
    chunks.push(bytes);
    length += bytes.length;
  };
  const object = (id: number, body: () => void) => {
    offsets[id] = length;
    push(`${id} 0 obj\n`);
    body();
    push("\nendobj\n");
  };

  // Object ids: 1 catalog, 2 page tree, then per page: page, content stream, image.
  const pageId = (index: number) => 3 + index * 3;
  push("%PDF-1.4\n%âãÏÓ\n");
  object(1, () => push("<< /Type /Catalog /Pages 2 0 R >>"));
  object(2, () =>
    push(
      `<< /Type /Pages /Count ${pages.length} /Kids [${pages.map((_, i) => `${pageId(i)} 0 R`).join(" ")}] >>`,
    ),
  );
  pages.forEach((page, index) => {
    const id = pageId(index);
    const draw = `q ${pageSize.width} 0 0 ${pageSize.height} 0 0 cm /Im0 Do Q`;
    object(id, () =>
      push(
        `<< /Type /Page /Parent 2 0 R /MediaBox [0 0 ${pageSize.width} ${pageSize.height}] ` +
          `/Resources << /XObject << /Im0 ${id + 2} 0 R >> >> /Contents ${id + 1} 0 R >>`,
      ),
    );
    object(id + 1, () => push(`<< /Length ${draw.length} >>\nstream\n${draw}\nendstream`));
    object(id + 2, () => {
      push(
        `<< /Type /XObject /Subtype /Image /Width ${page.width} /Height ${page.height} ` +
          `/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length ${page.jpeg.length} >>\nstream\n`,
      );
      push(page.jpeg);
      push("\nendstream");
    });
  });
  const total = 3 + pages.length * 3;
  const xref = length;
  push(`xref\n0 ${total}\n0000000000 65535 f \n`);
  for (let id = 1; id < total; id++) push(`${String(offsets[id]).padStart(10, "0")} 00000 n \n`);
  push(`trailer\n<< /Size ${total} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`);

  const out = new Uint8Array(length);
  let at = 0;
  for (const chunk of chunks) {
    out.set(chunk, at);
    at += chunk.length;
  }
  return out;
}
