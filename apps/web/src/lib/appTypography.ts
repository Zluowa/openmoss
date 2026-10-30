import {
  DEFAULT_CHAT_FONT_SIZE_PX,
  MAX_CHAT_FONT_SIZE_PX,
  normalizeChatFontSizePx,
} from "../appSettings";

export interface AppTypographyScale {
  basePx: number;
  uiPx: number;
  uiLgPx: number;
  uiSmPx: number;
  uiXsPx: number;
  ui2XsPx: number;
  uiMetaPx: number;
  uiTimestampPx: number;
  chatPx: number;
  chatCodePx: number;
  chatMetaPx: number;
  chatTinyPx: number;
}

function clampTypographyPx(value: number, min: number, max = MAX_CHAT_FONT_SIZE_PX + 2): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

export function getAppTypographyScale(
  baseFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX,
): AppTypographyScale {
  const basePx = normalizeChatFontSizePx(baseFontSizePx);

  return {
    basePx,
    uiPx: basePx,
    uiLgPx: clampTypographyPx(basePx * 1.08, basePx),
    uiSmPx: clampTypographyPx(basePx * 0.92, 10),
    uiXsPx: clampTypographyPx(basePx * 0.84, 10),
    ui2XsPx: clampTypographyPx(basePx * 0.76, 9),
    uiMetaPx: clampTypographyPx(basePx * 0.84, 10),
    uiTimestampPx: clampTypographyPx(basePx * 0.76, 9),
    // Prose reads one step above the chrome, and code one step below prose: 14 and 12 on a 13 base.
    chatPx: basePx + 1,
    chatCodePx: clampTypographyPx(basePx - 1, 10),
    chatMetaPx: clampTypographyPx(basePx * 0.84, 10),
    chatTinyPx: clampTypographyPx(basePx * 0.76, 9),
  };
}
