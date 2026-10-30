import type { DesktopAppSnapCapture } from "@synara/contracts";
import { describe, expect, it } from "vitest";

import { encodeRealtimeVoiceScreenContext } from "./realtimeVoiceScreenContext";

function canvasPng(canvas: HTMLCanvasElement): Promise<Uint8Array> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(async (blob) => {
      if (!blob) {
        reject(new Error("Synthetic screen context did not encode"));
        return;
      }
      resolve(new Uint8Array(await blob.arrayBuffer()));
    }, "image/png");
  });
}

describe("encodeRealtimeVoiceScreenContext", () => {
  it("converts AppSnap PNG bytes into one bounded JPEG data URL", async () => {
    const canvas = document.createElement("canvas");
    canvas.width = 1_600;
    canvas.height = 900;
    const context = canvas.getContext("2d");
    if (!context) throw new Error("Canvas unavailable");
    const gradient = context.createLinearGradient(0, 0, canvas.width, canvas.height);
    gradient.addColorStop(0, "#5834d8");
    gradient.addColorStop(1, "#eafcff");
    context.fillStyle = gradient;
    context.fillRect(0, 0, canvas.width, canvas.height);
    context.fillStyle = "#101010";
    context.font = "80px sans-serif";
    context.fillText("Moss screen context", 100, 450);

    const capture: DesktopAppSnapCapture = {
      id: "capture-screen-1",
      capturedAt: "2026-07-26T00:00:00.000Z",
      name: "screen.png",
      mimeType: "image/png",
      sizeBytes: 0,
      bytes: await canvasPng(canvas),
      sourceAppName: "Safari",
      sourceBundleIdentifier: "com.apple.Safari",
      sourceAppIconDataUrl: null,
      sourceWindowTitle: "Moss docs",
    };
    const encoded = await encodeRealtimeVoiceScreenContext(capture);

    expect(encoded.imageDataUrl.startsWith("data:image/jpeg;base64,")).toBe(true);
    expect(encoded.imageDataUrl.length).toBeLessThan(1_000_000);
    expect(encoded).toMatchObject({ sourceAppName: "Safari", sourceWindowTitle: "Moss docs" });
  });
});
