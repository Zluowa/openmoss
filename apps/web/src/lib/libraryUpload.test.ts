import { afterEach, describe, expect, it, vi } from "vitest";

import { uploadLibraryFiles, uploadPickedLibraryFiles } from "./libraryUpload";

const THREE_MB = 3 * 1024 * 1024;

function item(id: string, title: string) {
  return {
    id,
    title,
    kind: "document",
    source: "user:import",
    sourceCli: "moss",
    path: `/library/${title}`,
    mimeType: "text/csv",
    size: THREE_MB,
    favorite: false,
    folderId: null,
    trashedAt: null,
    originationThreadId: null,
    createdAt: "2026-11-13T00:00:00.000Z",
    updatedAt: "2026-11-13T00:00:00.000Z",
  };
}

function answer(body: unknown, status = 201) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("uploadLibraryFiles", () => {
  // A 3 MB file is over the WebSocket's 2 MiB message cap even before base64.
  it("sends a 3 MB file as its own raw bytes to the import route", async () => {
    const file = new File([new Uint8Array(THREE_MB).fill(65)], "sales.csv", { type: "text/csv" });
    const fetchMock = vi.fn(async () =>
      answer({ items: [item("lib-1", "sales.csv")], imported: 1, skipped: 0 }),
    );
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadPickedLibraryFiles([file]);

    expect(fetchMock).toHaveBeenCalledOnce();
    const [url, init] = fetchMock.mock.calls[0] as unknown as [string, RequestInit];
    const target = new URL(url, "http://localhost");
    expect(target.pathname).toBe("/api/library/import");
    expect(target.searchParams.get("name")).toBe("sales.csv");
    expect(target.searchParams.get("mimeType")).toBe("text/csv");
    expect(init.method).toBe("POST");
    expect(init.credentials).toBe("include");
    expect(init.body).toBe(file);
    expect((init.body as Blob).size).toBe(THREE_MB);
    expect(result).toMatchObject({ imported: 1, skipped: 0, items: [{ id: "lib-1" }] });
  });

  it("uploads several files one at a time and adds up what came back", async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(answer({ items: [item("lib-1", "a.csv")], imported: 1, skipped: 0 }))
      .mockResolvedValueOnce(answer({ items: [], imported: 0, skipped: 1 }));
    vi.stubGlobal("fetch", fetchMock);

    const result = await uploadLibraryFiles([
      { name: "a.csv", data: new Blob(["a"]) },
      { name: "b.csv", data: new Blob(["b"]) },
    ]);

    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({ imported: 1, skipped: 1 });
    expect(result.items.map((entry) => entry.id)).toEqual(["lib-1"]);
  });

  it("passes the server's reason on when it refuses a file", async () => {
    vi.stubGlobal(
      "fetch",
      vi.fn(async () => answer({ error: "Owner authorization is required." }, 403)),
    );
    await expect(uploadLibraryFiles([{ name: "a.csv", data: new Blob(["a"]) }])).rejects.toThrow(
      "Owner authorization is required.",
    );
  });

  it("refuses a picked file over the 64 MB limit before sending anything", async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);
    const huge = new File(["x"], "huge.csv");
    Object.defineProperty(huge, "size", { value: 64 * 1024 * 1024 + 1 });
    await expect(uploadPickedLibraryFiles([huge])).rejects.toThrow("huge.csv");
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
