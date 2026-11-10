import { useEffect } from "react";
import { resolveTerminalFontFamilyStack, useAppSettings } from "../appSettings";
import { getAppTypographyCssVariables } from "../lib/appTypography";

const TERMINAL_FONT_FAMILY_CSS_VARIABLE = "--terminal-font-family";

export function useAppTypography() {
  const { settings } = useAppSettings();

  useEffect(() => {
    const rootStyle = document.documentElement.style;
    const variableValues = {
      ...getAppTypographyCssVariables(settings.chatFontSizePx),
      "--app-font-size-terminal": `${settings.terminalFontSizePx}px`,
    };

    for (const [cssVariable, value] of Object.entries(variableValues)) {
      rootStyle.setProperty(cssVariable, value);
    }

    // Terminal font family overrides the bundled default only when a non-default
    // font is chosen; otherwise leave the index.css value in place. The terminal
    // runtime observes inline `style` mutations and re-applies the font live.
    const terminalFontFamilyStack = resolveTerminalFontFamilyStack(settings.terminalFontFamily);
    if (terminalFontFamilyStack) {
      rootStyle.setProperty(TERMINAL_FONT_FAMILY_CSS_VARIABLE, terminalFontFamilyStack);
    } else {
      rootStyle.removeProperty(TERMINAL_FONT_FAMILY_CSS_VARIABLE);
    }

    return () => {
      for (const cssVariable of Object.keys(variableValues)) {
        rootStyle.removeProperty(cssVariable);
      }
      rootStyle.removeProperty(TERMINAL_FONT_FAMILY_CSS_VARIABLE);
    };
  }, [settings.chatFontSizePx, settings.terminalFontSizePx, settings.terminalFontFamily]);
}
