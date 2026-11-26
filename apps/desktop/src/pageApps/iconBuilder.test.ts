import { describe, expect, it } from "vitest";

import { inspectIcoEntries } from "../windowsShellIco";
import {
  buildCanvas2dIconScript,
  buildPageAppIcons,
  buildPageAppIconsWithRace,
  decodeSquarePngDataUrl,
  encodeRgbaToPng,
  extractIconLetterAndHue,
  PAGE_APP_ICO_BMP_SIZES,
  PAGE_APP_ICO_PNG_SIZE,
  parseSquarePngDimensions,
} from "./iconBuilder";

describe("iconBuilder", () => {
  it("builds a multi-resolution ICO (16..64px BMP + 256px PNG) using deterministic fallback", () => {
    const result = buildPageAppIcons({
      title: "Orbit Tracker",
      seedUuid: "11111111-2222-3333-4444-555555555555",
    });

    expect(result.usedThumbnail).toBe(false);
    expect(result.png256.subarray(0, 8)).toEqual(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));

    const entries = inspectIcoEntries(result.ico);
    expect(entries).toHaveLength(PAGE_APP_ICO_BMP_SIZES.length + 1);
    expect(entries.slice(0, PAGE_APP_ICO_BMP_SIZES.length)).toEqual(
      PAGE_APP_ICO_BMP_SIZES.map((size) => ({ width: size, height: size, encoding: "bmp" })),
    );
    expect(entries.at(-1)).toEqual({
      width: PAGE_APP_ICO_PNG_SIZE,
      height: PAGE_APP_ICO_PNG_SIZE,
      encoding: "png",
    });
  });

  it("extracts Chinese and Emoji graphemes with Intl.Segmenter and builds 1024px Canvas2D script", () => {
    const [zhLetter, zhHue] = extractIconLetterAndHue("微信阅读", "app-uuid-1");
    expect(zhLetter).toBe("微");
    expect(zhHue).toBeGreaterThanOrEqual(0);
    expect(zhHue).toBeLessThan(360);

    const [emojiLetter] = extractIconLetterAndHue("📚书架", "app-uuid-2");
    expect(emojiLetter).toBe("📚");

    const script = buildCanvas2dIconScript("微信阅读", "app-uuid-1");
    expect(script).toContain("S = 1024");
    expect(script).toContain('"微"');
  });

  it("validates square PNGs and races page icon against 5s cutoff with late arrival callback", async () => {
    const png32 = encodeRgbaToPng(32, 32, Buffer.alloc(32 * 32 * 4, 255));
    expect(parseSquarePngDimensions(png32)).toEqual({ width: 32, height: 32 });
    const dataUrl = `data:image/png;base64,${png32.toString("base64")}`;
    expect(decodeSquarePngDataUrl(dataUrl)).not.toBeNull();
    expect(decodeSquarePngDataUrl("data:image/png;base64,invalid")).toBeNull();

    let lateCalled = false;
    const latePromise = new Promise<string | null>((resolve) =>
      setTimeout(() => resolve(dataUrl), 40),
    );
    const fastFallback = await buildPageAppIconsWithRace({
      title: "Timer",
      seedUuid: "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee",
      pageIconPromise: latePromise,
      timeoutMs: 10,
      decodeThumbnailToBgra: (_url, size) => Buffer.alloc(size * size * 4, 0x80),
      onLateArrival: () => {
        lateCalled = true;
      },
    });
    expect(fastFallback.usedThumbnail).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 60));
    expect(lateCalled).toBe(true);
  });
});
