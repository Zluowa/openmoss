import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import { AppSettingsSchema, normalizeStoredAppSettings } from "../appSettings";
import { getAppTypographyCssVariables, getAppTypographyScale } from "./appTypography";

describe("comfortable typography", () => {
  it("uses the measured roles for a new profile", () => {
    const settings = Schema.decodeUnknownSync(AppSettingsSchema)({});
    expect(settings.chatFontSizePx).toBe(14);
    expect(getAppTypographyScale(settings.chatFontSizePx)).toEqual({
      basePx: 14,
      uiPx: 14,
      uiLgPx: 15,
      uiSmPx: 13,
      uiXsPx: 12,
      ui2XsPx: 11,
      uiMetaPx: 12,
      uiTimestampPx: 11,
      titlePx: 22,
      geometryScale: 1,
      chatPx: 16,
      chatCodePx: 13,
      chatMetaPx: 12,
      chatTinyPx: 11,
    });
  });

  it.each([11, 13, 16, 18])("preserves an explicitly stored size %s", (fontSize) => {
    const stored = Schema.decodeUnknownSync(AppSettingsSchema)({
      chatFontSizePx: fontSize,
      terminalFontSizePx: 17,
      terminalFontFamily: "custom",
    });
    const normalized = normalizeStoredAppSettings(stored);
    expect(normalized.chatFontSizePx).toBe(fontSize);
    expect(normalized.terminalFontSizePx).toBe(17);
    expect(normalized.terminalFontFamily).toBe("custom");
    expect(getAppTypographyScale(normalized.chatFontSizePx).uiPx).toBe(fontSize);
  });

  it("links enlarged text, large titles and control geometry to the same setting", () => {
    const variables = getAppTypographyCssVariables(18);
    expect(variables["--app-font-size-ui"]).toBe("18px");
    expect(variables["--app-font-size-ui-sm"]).toBe("17px");
    expect(variables["--app-font-size-title"]).toBe("28px");
    expect(variables["--app-font-size-chat"]).toBe("21px");
    expect(Number(variables["--app-ui-scale"])).toBeCloseTo(18 / 14);
    expect(variables).not.toHaveProperty("--font-ui-family");
    expect(variables).not.toHaveProperty("--app-font-size-terminal");
  });

  it("keeps useful hit areas when a user chooses smaller text", () => {
    expect(getAppTypographyScale(11).geometryScale).toBe(1);
    expect(getAppTypographyScale(13).uiPx).toBe(13);
    expect(getAppTypographyScale(13).geometryScale).toBe(1);
  });
});
