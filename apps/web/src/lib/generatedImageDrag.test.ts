import { afterEach, describe, expect, it, vi } from "vitest";

import {
  consumeGeneratedImageDrag,
  GENERATED_IMAGE_DRAG_TYPE,
  hasGeneratedImageDrag,
  setGeneratedImageDragData,
} from "./generatedImageDrag";

function makeDataTransfer(): DataTransfer {
  const values = new Map<string, string>();
  const transfer = {
    effectAllowed: "none",
    types: [] as string[],
    setData(type: string, value: string) {
      values.set(type, value);
      this.types = [...values.keys()];
    },
    clearData(type?: string) {
      if (type === undefined) values.clear();
      else values.delete(type);
      this.types = [...values.keys()];
    },
    getData(type: string) {
      return values.get(type) ?? "";
    },
  };
  return transfer as unknown as DataTransfer;
}

function makeDragEndWindow() {
  const listeners: Array<() => void> = [];
  return {
    addEventListener(type: string, listener: () => void) {
      if (type === "dragend") listeners.push(listener);
    },
    dispatchDragEnd() {
      for (const listener of listeners.splice(0)) listener();
    },
  };
}

describe("generated image drag", () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("publishes only the private nonce and a generic filename", () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-1" });
    const transfer = makeDataTransfer();
    const source = "/tmp/generated.png?token=secret&cwd=/Users/me/project";
    transfer.setData("text/plain", source);
    transfer.setData("text/uri-list", source);
    transfer.setData("DownloadURL", `image/png:generated.png:${source}`);

    expect(setGeneratedImageDragData(transfer, { src: source, imageNumber: 3 })).toBe(true);
    expect(transfer.effectAllowed).toBe("copy");
    expect(transfer.types).toEqual([GENERATED_IMAGE_DRAG_TYPE]);
    expect(hasGeneratedImageDrag(transfer)).toBe(true);

    const raw = transfer.getData(GENERATED_IMAGE_DRAG_TYPE);
    expect(JSON.parse(raw)).toEqual({ dragId: "drag-1", filename: "generated-image-3" });
    expect(raw).not.toContain("generated.png");
    expect(raw).not.toContain("token");
    expect(raw).not.toContain("cwd");
    expect(raw).not.toContain("src");
  });

  it("consumes a matching nonce into an image file and never exposes the source in payload", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-2" });
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);
    const transfer = makeDataTransfer();
    const source = "/tmp/generated.png?token=secret";

    setGeneratedImageDragData(transfer, { src: source, imageNumber: 7 });
    const file = await consumeGeneratedImageDrag(transfer);

    expect(file).not.toBeNull();
    expect(file?.name).toBe("generated-image-7.png");
    expect(file?.type).toBe("image/png");
    expect(file?.size).toBeGreaterThan(0);
    expect(fetchMock).toHaveBeenCalledWith(source, {
      credentials: "omit",
      referrerPolicy: "no-referrer",
    });
  });

  it("rejects forged and external payloads without fetching", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-3" });
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const external = makeDataTransfer();
    external.setData(
      GENERATED_IMAGE_DRAG_TYPE,
      JSON.stringify({ dragId: "external", filename: "generated-image-1" }),
    );
    expect(await consumeGeneratedImageDrag(external)).toBeNull();

    const active = makeDataTransfer();
    setGeneratedImageDragData(active, { src: "/tmp/generated.png", imageNumber: 1 });
    const forged = makeDataTransfer();
    forged.setData(
      GENERATED_IMAGE_DRAG_TYPE,
      JSON.stringify({ dragId: "wrong", filename: "generated-image-1" }),
    );
    expect(await consumeGeneratedImageDrag(forged)).toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("clears the active nonce on dragend and after the first consume", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-4" });
    const fakeWindow = makeDragEndWindow();
    vi.stubGlobal("window", fakeWindow);
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(new Blob(["png"], { type: "image/png" }), { status: 200 }));
    vi.stubGlobal("fetch", fetchMock);

    const expired = makeDataTransfer();
    setGeneratedImageDragData(expired, { src: "/tmp/expired.png", imageNumber: 1 });
    fakeWindow.dispatchDragEnd();
    expect(await consumeGeneratedImageDrag(expired)).toBeNull();

    const consumed = makeDataTransfer();
    setGeneratedImageDragData(consumed, { src: "/tmp/consumed.png", imageNumber: 2 });
    expect(await consumeGeneratedImageDrag(consumed)).not.toBeNull();
    expect(await consumeGeneratedImageDrag(consumed)).toBeNull();
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it("rejects empty and non-image blobs", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-5" });
    const fetchMock = vi
      .fn()
      .mockResolvedValueOnce(new Response(new Blob(["text"], { type: "text/plain" })))
      .mockResolvedValueOnce(new Response(new Blob([], { type: "image/png" })));
    vi.stubGlobal("fetch", fetchMock);

    const textTransfer = makeDataTransfer();
    setGeneratedImageDragData(textTransfer, { src: "/tmp/text", imageNumber: 1 });
    expect(await consumeGeneratedImageDrag(textTransfer)).toBeNull();

    const emptyTransfer = makeDataTransfer();
    setGeneratedImageDragData(emptyTransfer, { src: "/tmp/empty", imageNumber: 2 });
    expect(await consumeGeneratedImageDrag(emptyTransfer)).toBeNull();
  });

  it("fails closed when clearing, writing, or generating a nonce fails", async () => {
    vi.stubGlobal("crypto", { randomUUID: () => "drag-failure-active" });
    const active = makeDataTransfer();
    setGeneratedImageDragData(active, { src: "/tmp/active", imageNumber: 1 });

    const clearFailure = makeDataTransfer();
    Object.defineProperty(clearFailure, "clearData", {
      configurable: true,
      value: () => {
        throw new Error("clear failed");
      },
    });
    expect(setGeneratedImageDragData(clearFailure, { src: "/tmp/clear", imageNumber: 2 })).toBe(
      false,
    );
    expect(await consumeGeneratedImageDrag(active)).toBeNull();

    vi.stubGlobal("crypto", { randomUUID: () => "drag-failure-write" });
    const writeFailure = makeDataTransfer();
    Object.defineProperty(writeFailure, "setData", {
      configurable: true,
      value: () => {
        throw new Error("write failed");
      },
    });
    expect(setGeneratedImageDragData(writeFailure, { src: "/tmp/write", imageNumber: 3 })).toBe(
      false,
    );
    expect(writeFailure.types).toEqual([]);

    vi.stubGlobal("crypto", {});
    const nonceFailure = makeDataTransfer();
    expect(setGeneratedImageDragData(nonceFailure, { src: "/tmp/nonce", imageNumber: 4 })).toBe(
      false,
    );
    expect(nonceFailure.types).toEqual([]);
  });
});
