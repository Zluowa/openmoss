// Isolated component hosts use the same theme, type and spacing projection as the app.
import { afterEach, beforeEach, expect } from "vitest";
import { page } from "vitest/browser";
import { getAppTypographyCssVariables } from "~/lib/appTypography";
import { getDensityCssVariables } from "~/lib/appDensity";
import { buildThemeCssVariables, getCodeThemeSeed } from "~/theme/theme.logic";

export function useConnectionSettingsBrowserTheme() {
  const style = document.documentElement.getAttribute("style");
  const dark = document.documentElement.classList.contains("dark");
  beforeEach(() => {
    const theme = buildThemeCssVariables(
      { codeThemeId: "one", theme: getCodeThemeSeed("one", "dark") },
      "dark",
    );
    for (const [key, value] of Object.entries({
      ...theme.variables,
      ...getAppTypographyCssVariables(),
      ...getDensityCssVariables(),
    })) {
      document.documentElement.style.setProperty(key, value);
    }
    document.documentElement.classList.add("dark");
  });
  afterEach(() => {
    if (style === null) document.documentElement.removeAttribute("style");
    else document.documentElement.setAttribute("style", style);
    document.documentElement.classList.toggle("dark", dark);
  });
}

export async function captureConnectionDialog(path: string) {
  await expect
    .poll(() =>
      [...document.querySelectorAll<HTMLElement>('[data-slot="dialog-popup"][data-open]')].every(
        (element) => Number(getComputedStyle(element).opacity) >= 0.99,
      ),
    )
    .toBe(true);
  await page.screenshot({ path });
}
