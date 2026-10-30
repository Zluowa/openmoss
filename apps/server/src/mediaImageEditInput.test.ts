import { describe, expect, it } from "vitest";
import { mediaImageEditInputError } from "./mediaImageEditInput";

const PNG = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a6FAAAAAASUVORK5CYII=",
  "base64",
);
const data = (bytes = PNG) => `data:image/png;base64,${bytes.toString("base64")}`;
const input = {
  modelId: "gpt-image-2-official",
  referenceImages: [data()],
  maskImage: data(),
  background: "transparent",
  outputFormat: "png",
};

describe("media image edit admission", () => {
  it("accepts same-size inline PNG source and alpha mask for each supported model", () => {
    for (const modelId of ["gpt-image-2-official", "gpt-image-2.5-flare", "gpt-image-2.5-sunburst"])
      expect(mediaImageEditInputError({ ...input, modelId })).toBeUndefined();
    expect(
      mediaImageEditInputError({ modelId: input.modelId, background: "transparent" }),
    ).toBeUndefined();
  });
  it.each([
    ["missing original", { referenceImages: [] }],
    ["remote original", { referenceImages: ["https://assets.example/source.png"] }],
    ["non-PNG mask", { maskImage: "data:image/jpeg;base64,/9j/AA==" }],
    ["invalid base64", { maskImage: data().slice(0, -1) }],
    ["non-string mask", { maskImage: false }],
  ])("rejects %s", (_name, change) => {
    expect(mediaImageEditInputError({ ...input, ...change })).toBe("invalid_mask_image");
  });
  it("rejects unequal dimensions, a mask without alpha, and excessive dimensions", () => {
    for (const mutate of [
      (bytes: Buffer) => bytes.writeUInt32BE(2, 16),
      (bytes: Buffer) => {
        bytes[25] = 2;
      },
      (bytes: Buffer) => bytes.writeUInt32BE(8193, 16),
    ]) {
      const bytes = Buffer.from(PNG);
      mutate(bytes);
      expect(mediaImageEditInputError({ ...input, maskImage: data(bytes) })).toBe(
        "invalid_mask_image",
      );
    }
  });
  it("counts the mask together with references before allocating decoded bytes", () => {
    expect(
      mediaImageEditInputError({
        ...input,
        referenceImages: ["A".repeat(4 * 1024 * 1024)],
        maskImage: "A".repeat(4 * 1024 * 1024),
      }),
    ).toBe("request_too_large");
    const exact4MiB = Buffer.alloc(4 * 1024 * 1024);
    PNG.copy(exact4MiB);
    expect(mediaImageEditInputError({ ...input, maskImage: data(exact4MiB) })).toBe(
      "invalid_mask_image",
    );
  });
  it.each([
    { modelId: "seedream-5-0-pro" },
    { background: "invented" },
    { background: ["transparent"] },
    { outputFormat: "svg" },
    { outputFormat: "jpeg" },
  ])("rejects unsupported edit parameters %j", (change) => {
    expect(mediaImageEditInputError({ ...input, ...change })).toBe("invalid_request");
  });
});
