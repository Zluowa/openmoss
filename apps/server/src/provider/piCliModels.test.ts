import { describe, expect, it } from "vitest";

import { readPiDefaultModelFromSettings } from "./piCliModels.ts";

describe("the person's own Pi", () => {
  it("reads the default from settings.json", () => {
    expect(
      readPiDefaultModelFromSettings({ defaultProvider: "magpie", defaultModel: "glm-5.2" }),
    ).toBe("magpie/glm-5.2");
    expect(readPiDefaultModelFromSettings({ defaultModel: "openai/gpt-5.5" })).toBe(
      "openai/gpt-5.5",
    );
    expect(readPiDefaultModelFromSettings({ defaultModel: "gpt-5.5" })).toBeUndefined();
    expect(readPiDefaultModelFromSettings(null)).toBeUndefined();
  });
});
