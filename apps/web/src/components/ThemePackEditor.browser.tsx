import "../index.css";

import { page } from "vitest/browser";
import { afterEach, beforeEach, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

// Windows/Linux desktop use the opaque projection, without macOS vibrancy.
vi.mock("~/env", () => ({ isElectron: true }));
vi.mock("~/lib/utils", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/lib/utils")>()),
  isMacNavigatorPlatform: () => false,
}));

import { ThemePackEditor } from "./ThemePackEditor";
import { DEFAULT_THEME_STATE, getCodeThemeSeed, parseStoredThemeState } from "~/theme/theme.logic";

const root = document.documentElement;
let previousTheme: string | null;

beforeEach(() => {
  previousTheme = localStorage.getItem("moss:theme");
});

afterEach(() => {
  if (previousTheme === null) localStorage.removeItem("moss:theme");
  else localStorage.setItem("moss:theme", previousTheme);
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

async function selectLightPreset(label: string) {
  await page.getByRole("combobox", { name: "Light theme code theme" }).click();
  await page.getByRole("option", { name: label, exact: true }).click();
}

it("preserves saved Codex on mount, applies and persists Vercel, then restores Codex", async () => {
  const stored = JSON.stringify({
    ...DEFAULT_THEME_STATE,
    codeThemeIds: { dark: "codex", light: "codex" },
    chromeThemes: {
      dark: getCodeThemeSeed("codex", "dark"),
      light: getCodeThemeSeed("codex", "light"),
    },
    mode: "light",
  });
  localStorage.setItem("moss:theme", stored);
  await render(<ThemePackEditor variant="light" />);
  await expect.poll(() => root.getAttribute("data-code-theme-id")).toBe("codex");
  expect(root.getAttribute("data-window-material")).toBe("opaque");
  expect(localStorage.getItem("moss:theme")).toBe(stored);

  await selectLightPreset("Monochrome");
  await expect.poll(() => root.style.getPropertyValue("--codex-base-accent")).toBe("#006aff");
  expect(getComputedStyle(root).getPropertyValue("--color-text-foreground").trim()).toBe("#171717");
  expect(root.style.getPropertyValue("--codex-base-surface")).toBe("#ffffff");
  expect(parseStoredThemeState(localStorage.getItem("moss:theme")).codeThemeIds.light).toBe(
    "vercel",
  );
  await expect
    .element(page.getByRole("img", { name: "Light theme preview: Monochrome" }))
    .toBeVisible();

  await selectLightPreset("Classic");
  // Moss 品牌真值：Codex 主题 accent 为 #339cff、ink 派生前景色 #1a1c1f
  // （theme.seed.generated.ts 的 codex 条目与 theme.logic.test.ts 同步维护），
  // 与上游 #0169cc/#0d0d0d 不同。
  await expect.poll(() => root.style.getPropertyValue("--codex-base-accent")).toBe("#339cff");
  expect(root.style.getPropertyValue("--color-text-foreground")).toBe("#1a1c1f");
});

it("keeps Import and Copy on one line when the code theme select takes the row", async () => {
  await render(
    <div style={{ width: 360 }}>
      <ThemePackEditor variant="light" />
    </div>,
  );
  for (const name of ["Import", "Copy"]) {
    const action = page.getByRole("button", { name, exact: true }).element();
    const lineHeight = Number.parseFloat(getComputedStyle(action).lineHeight);
    expect(getComputedStyle(action).whiteSpace).toBe("nowrap");
    expect(action.getBoundingClientRect().height).toBeLessThan(lineHeight * 2);
  }
});

it("previews an inactive light preset without switching the app to it", async () => {
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "dark" }));
  await render(<ThemePackEditor variant="light" />);
  await selectLightPreset("Monochrome");

  expect(root.getAttribute("data-theme-variant")).toBe("dark");
  expect(root.getAttribute("data-code-theme-id")).toBe("moss");
  const preview = page.getByRole("img", { name: "Light theme preview: Monochrome" });
  expect(getComputedStyle(preview.element()).backgroundColor).toBe("rgb(255, 255, 255)");
  expect(getComputedStyle(preview.element()).color).toBe("rgb(23, 23, 23)");

  // Settings shows only the theme in use; switching is the 浅色 / 深色 picker's job, so the
  // editor carries no second "use this theme" button or sentence about which slot it is.
  expect(page.getByRole("button", { name: "Use light theme" }).elements()).toHaveLength(0);
  const saved = parseStoredThemeState(localStorage.getItem("moss:theme"));
  expect(saved.mode).toBe("dark");
  expect(saved.codeThemeIds.dark).toBe("moss");
});

it.each(["dark", "light"] as const)(
  "replaces Linear completely with the Moss paper preset when selecting Moss (%s)",
  async (variant) => {
    const title = variant === "dark" ? "Dark" : "Light";
    const accent = variant === "dark" ? "#3987e5" : "#2a78d6";
    const otherVariant = variant === "dark" ? "light" : "dark";
    const stored = {
      ...DEFAULT_THEME_STATE,
      mode: variant,
      systemUiFont: false,
      codeThemeIds: { ...DEFAULT_THEME_STATE.codeThemeIds, [variant]: "linear" },
      chromeThemes: {
        ...DEFAULT_THEME_STATE.chromeThemes,
        [variant]: {
          ...getCodeThemeSeed("linear", variant),
          contrast: 22,
          fonts: { ui: "Inter", code: "Menlo" },
        },
      },
    };
    localStorage.setItem("moss:theme", JSON.stringify(stored));
    await render(<ThemePackEditor variant={variant} />);
    window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
    await expect.poll(() => root.getAttribute("data-code-theme-id")).toBe("linear");

    await page.getByRole("combobox", { name: `${title} theme code theme` }).click();
    await page.getByRole("option", { name: "Moss", exact: true }).click();
    await expect.poll(() => root.getAttribute("data-code-theme-id")).toBe("moss");

    const saved = parseStoredThemeState(localStorage.getItem("moss:theme"));
    // The Moss preset is the paper palette: Codex material with Claude's warm sheet, ink and blue.
    const mossSeed = getCodeThemeSeed("moss", variant);
    expect(saved.chromeThemes[variant]).toEqual(mossSeed);
    expect(saved.chromeThemes[otherVariant]).toEqual(stored.chromeThemes[otherVariant]);
    expect(root.style.getPropertyValue("--codex-base-accent")).toBe(accent);
    expect(root.style.getPropertyValue("--codex-base-surface")).toBe(mossSeed.surface);
    expect(root.style.getPropertyValue("--codex-base-ink")).toBe(mossSeed.ink);
    expect(root.style.getPropertyValue("--color-accent-purple")).toBe(
      mossSeed.semanticColors.skill,
    );
    expect(root.style.getPropertyValue("--theme-font-ui-family")).toBe("");
    const preview = page.getByRole("img", { name: `${title} theme preview: Moss` });
    const fontFamily = getComputedStyle(preview.element()).fontFamily;
    // The theme font is cleared (above), so the preview falls back to Moss's default stack.
    expect(fontFamily).toContain('"Inter Variable"');
    expect(fontFamily).toContain('"PingFang SC"');
  },
);

it("shows each colour as a round swatch, not a hex string", async () => {
  await render(
    <div style={{ width: 640 }}>
      <ThemePackEditor variant="light" />
    </div>,
  );
  const swatch = page.getByRole("button", { name: "Light theme accent color", exact: true });
  await expect.element(swatch).toBeVisible();
  const box = swatch.element().getBoundingClientRect();
  expect(box.width).toBeGreaterThan(20);
  expect(Math.abs(box.width - box.height)).toBeLessThan(1);
  // The swatch paints the colour; no hex text on the control itself.
  expect(swatch.element().textContent).toBe("");
  expect(getComputedStyle(swatch.element()).backgroundColor).not.toBe("rgba(0, 0, 0, 0)");
  const card = swatch.element().closest("[data-slot], div")!.parentElement!;
  expect(card.textContent ?? "").not.toMatch(/#[0-9a-f]{6}/i);
});
