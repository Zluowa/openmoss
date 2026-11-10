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
  titlePx: number;
  geometryScale: number;
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
    uiLgPx: clampTypographyPx((basePx * 15) / 14, basePx),
    uiSmPx: clampTypographyPx((basePx * 13) / 14, 10),
    uiXsPx: clampTypographyPx((basePx * 12) / 14, 10),
    ui2XsPx: clampTypographyPx((basePx * 11) / 14, 9),
    uiMetaPx: clampTypographyPx((basePx * 12) / 14, 10),
    uiTimestampPx: clampTypographyPx((basePx * 11) / 14, 9),
    titlePx: clampTypographyPx((basePx * 22) / 14, basePx, 32),
    // Smaller text choices retain comfortable hit areas; larger choices also
    // enlarge controls, icons and spacing instead of squeezing a larger line box.
    geometryScale: Math.max(1, basePx / 14),
    chatPx: clampTypographyPx((basePx * 16) / 14, 12, 22),
    chatCodePx: clampTypographyPx((basePx * 13) / 14, 10),
    chatMetaPx: clampTypographyPx((basePx * 12) / 14, 10),
    chatTinyPx: clampTypographyPx((basePx * 11) / 14, 9),
  };
}

/** The hook and isolated component hosts share the same role-to-CSS mapping. */
export function getAppTypographyCssVariables(baseFontSizePx = DEFAULT_CHAT_FONT_SIZE_PX) {
  const scale = getAppTypographyScale(baseFontSizePx);
  return {
    "--app-font-size-base": `${scale.basePx}px`,
    "--app-font-size-ui": `${scale.uiPx}px`,
    "--app-font-size-ui-lg": `${scale.uiLgPx}px`,
    "--app-font-size-ui-sm": `${scale.uiSmPx}px`,
    "--app-font-size-ui-xs": `${scale.uiXsPx}px`,
    "--app-font-size-ui-2xs": `${scale.ui2XsPx}px`,
    "--app-font-size-ui-meta": `${scale.uiMetaPx}px`,
    "--app-font-size-ui-timestamp": `${scale.uiTimestampPx}px`,
    "--app-font-size-title": `${scale.titlePx}px`,
    "--app-font-size-chat": `${scale.chatPx}px`,
    "--app-font-size-chat-code": `${scale.chatCodePx}px`,
    "--app-font-size-chat-meta": `${scale.chatMetaPx}px`,
    "--app-font-size-chat-tiny": `${scale.chatTinyPx}px`,
    "--app-ui-scale": String(scale.geometryScale),
  } as const;
}
