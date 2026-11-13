import { describe, expect, it, vi } from "vitest";

const THREE_MB = 3 * 1024 * 1024;

const upload = vi.hoisted(() =>
  vi.fn(async (_files: readonly { name: string; mimeType?: string; data: Blob }[]) => ({
    items: [{ previewPath: "/api/library/preview/photo.png", title: "photo.png" }],
    imported: 1,
    skipped: 0,
  })),
);

vi.mock("~/lib/libraryUpload", () => ({ uploadLibraryFiles: upload }));

// The shared converter is stubbed: it hands one 3 MB picture to the web side's storeImage.
vi.mock("@moss/shared/spaceItems/deckPptx", () => ({
  exportDeckToPptx: vi.fn(),
  importPptxToDeck: vi.fn(
    async (
      _bytes: ArrayBuffer,
      options: {
        storeImage: (data: Uint8Array, mime: string, name: string) => Promise<string | null>;
      },
    ) => ({ stored: await options.storeImage(new Uint8Array(THREE_MB), "image/png", "photo") }),
  ),
}));

const { importPptxToDeck } = await import("./slidesPptx");

describe("importPptxToDeck", () => {
  // A 3 MB picture is over the WebSocket's 2 MiB message cap even before base64.
  it("stores a 3 MB picture in 资料库 as raw bytes over HTTP", async () => {
    const report = (await importPptxToDeck(new ArrayBuffer(8))) as unknown as { stored: string };
    expect(report.stored).toBe("/api/library/preview/photo.png");
    expect(upload).toHaveBeenCalledTimes(1);
    const [files] = upload.mock.calls[0]!;
    expect(files).toHaveLength(1);
    expect(files[0]!.name).toBe("photo.png");
    expect(files[0]!.mimeType).toBe("image/png");
    expect(files[0]!.data.size).toBe(THREE_MB);
  });
});
