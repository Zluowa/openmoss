// PNG clipboard encoding must not wait for the renderer's canvas idle tasks.
const workerScope = self as unknown as {
  addEventListener: (type: "message", listener: (event: MessageEvent<ImageBitmap>) => void) => void;
  postMessage: (message: unknown) => void;
};

workerScope.addEventListener("message", ({ data: bitmap }) => {
  void (async () => {
    const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
    try {
      const context = canvas.getContext("2d");
      if (!context) throw new Error("Image copying is unavailable in this worker.");
      context.drawImage(bitmap, 0, 0);
      const blob = await canvas.convertToBlob({ type: "image/png" });
      workerScope.postMessage({ ok: true, blob });
    } finally {
      bitmap.close();
      canvas.width = 0;
      canvas.height = 0;
    }
  })().catch(() => workerScope.postMessage({ ok: false }));
});

export {};
