import { MOSS_IMAGE_MODEL_IDS, MOSS_VIDEO_MODEL_IDS } from "@moss/shared/mossMediaPlugins";
import { describe, expect, it } from "vitest";

import { hoolaCanvasModelKind } from "../hoolaCanvasBridge";
import {
  MOSS_MEDIA_MODELS,
  mossMediaModelExample,
  mossMediaModelPrice,
} from "./mossMediaModelCatalog";

describe("Moss media model catalog", () => {
  it("covers exactly the models the Canvas bridge can generate, each with a price", () => {
    expect(MOSS_MEDIA_MODELS.map((model) => model.id).toSorted()).toEqual(
      [...MOSS_IMAGE_MODEL_IDS, ...MOSS_VIDEO_MODEL_IDS].toSorted(),
    );
    for (const model of MOSS_MEDIA_MODELS) {
      expect(hoolaCanvasModelKind(model.id)).toBe(model.kind);
      expect(mossMediaModelPrice(model.id)).toMatch(/积分/u);
    }
  });

  it("states credits from the reviewed cards: 100 credits per CNY", () => {
    // Wan 3.0 is billed in CNY per second: 480P CNY 0.3 = 30 credits.
    expect(mossMediaModelPrice("wan3.0-video")).toBe(
      "480P 约 30 积分/秒，720P 约 60 积分/秒，1080P 约 120 积分/秒",
    );
    expect(mossMediaModelExample("wan3.0-video")).toBe("5 秒 480P 约 150 积分");
    // Seedream at USD 0.0366 per 1K image, at the reference USD 7.1.
    expect(mossMediaModelPrice("seedream-5-0")).toBe(
      "1K/1.5K 约 26 积分/张，2K 约 52 积分/张；前 1 张参考图免费，之后每张参考图约 2 积分",
    );
    expect(mossMediaModelPrice("gemini-flash-image")).toContain("每张参考图约 1 积分");
    expect(mossMediaModelPrice("wan2.7-image-pro")).toContain("参考图免费");
    expect(mossMediaModelPrice("kling-v3-omni")).toContain(
      "720P 无声约 89 积分/秒、有声约 119 积分/秒",
    );
    expect(mossMediaModelPrice("gpt-image-2.5-flare")).toContain("每张最多预留约 710 积分");
    expect(mossMediaModelPrice("unknown-model")).toBeNull();
    expect(mossMediaModelExample("seedream-5-0")).toBeNull();
  });
});
