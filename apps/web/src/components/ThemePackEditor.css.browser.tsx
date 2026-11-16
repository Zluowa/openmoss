// FILE: ThemePackEditor.css.browser.tsx
// Purpose: The theme editor's custom CSS: live preview, saved with the pack, the safety notice,
//          Clear, the reset shortcut, and a theme an agent published.
// Layer: Web browser test

import "../index.css";

import { page, userEvent } from "vitest/browser";
import { afterEach, beforeEach, expect, it } from "vitest";
import { render } from "vitest-browser-react";

import { ThemePackEditor } from "./ThemePackEditor";
import { adoptPublishedTheme } from "~/hooks/useTheme";
import { DEFAULT_THEME_STATE, parseStoredThemeState, setThemeCss } from "~/theme/theme.logic";

const PROBE_CSS = "[data-theme-editor-probe] { color: rgb(9, 8, 7); }";
let previousTheme: string | null;
let previousRevision: string | null;
let probe: HTMLElement;

beforeEach(() => {
  previousTheme = localStorage.getItem("moss:theme");
  previousRevision = localStorage.getItem("moss:theme:agent-revision");
  localStorage.setItem("moss:theme", JSON.stringify({ ...DEFAULT_THEME_STATE, mode: "light" }));
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
  probe = document.createElement("div");
  probe.setAttribute("data-theme-editor-probe", "");
  probe.textContent = "probe";
  document.body.append(probe);
});

afterEach(() => {
  probe.remove();
  if (previousTheme === null) localStorage.removeItem("moss:theme");
  else localStorage.setItem("moss:theme", previousTheme);
  if (previousRevision === null) localStorage.removeItem("moss:theme:agent-revision");
  else localStorage.setItem("moss:theme:agent-revision", previousRevision);
  window.dispatchEvent(new StorageEvent("storage", { key: "moss:theme" }));
});

const storedLightCss = () =>
  parseStoredThemeState(localStorage.getItem("moss:theme")).chromeThemes.light.css;
const probeColor = () => getComputedStyle(probe).color;

async function openCssEditor() {
  await page.getByRole("button", { name: "Light theme custom CSS", exact: true }).click();
  return page.getByRole("textbox", { name: "Light theme custom CSS editor" });
}

it("previews CSS live, saves it with the pack, and shows it again after a reload", async () => {
  const screen = await render(<ThemePackEditor variant="light" />);
  const editor = await openCssEditor();
  await editor.fill(PROBE_CSS);

  await expect.poll(probeColor).toBe("rgb(9, 8, 7)");
  await expect.poll(storedLightCss).toBe(PROBE_CSS);
  expect(localStorage.getItem("moss:theme")).toContain("data-theme-editor-probe");

  await screen.unmount();
  const reloaded = await render(<ThemePackEditor variant="light" />);
  // A pack with CSS opens its CSS section on load.
  await expect
    .element(reloaded.getByRole("textbox", { name: "Light theme custom CSS editor" }))
    .toHaveValue(PROBE_CSS);
  expect(probeColor()).toBe("rgb(9, 8, 7)");
});

it("says when rules are removed, and Clear CSS restores the look", async () => {
  await render(<ThemePackEditor variant="light" />);
  const editor = await openCssEditor();
  await editor.fill(
    `${PROBE_CSS}\n[data-theme-editor-probe] { background-image: url(https://example.com/a.png); }`,
  );
  await expect
    .element(page.getByText("Rules that load files are removed", { exact: false }))
    .toBeVisible();
  await expect.element(page.getByText("Rules removed by the safety check:")).toBeVisible();
  await expect.poll(probeColor).toBe("rgb(9, 8, 7)");
  expect(getComputedStyle(probe).backgroundImage).toBe("none");

  await page.getByRole("button", { name: "Clear CSS" }).click();
  await expect.poll(probeColor).not.toBe("rgb(9, 8, 7)");
  await expect.poll(storedLightCss).toBeUndefined();
});

it("Ctrl+Alt+Shift+Backspace restores the default look from anywhere", async () => {
  await render(<ThemePackEditor variant="light" />);
  const editor = await openCssEditor();
  await editor.fill(PROBE_CSS);
  await expect.poll(probeColor).toBe("rgb(9, 8, 7)");

  // Focus outside the editor, as when theme CSS has hidden every control.
  (document.activeElement as HTMLElement | null)?.blur();
  await userEvent.keyboard("{Control>}{Alt>}{Shift>}{Backspace}{/Shift}{/Alt}{/Control}");

  await expect.poll(probeColor).not.toBe("rgb(9, 8, 7)");
  const stored = parseStoredThemeState(localStorage.getItem("moss:theme"));
  expect(stored.chromeThemes).toEqual(DEFAULT_THEME_STATE.chromeThemes);
  expect(stored.mode).toBe("light");
  // The box shows what is stored now, not the CSS typed before the reset.
  await expect.element(editor).toHaveValue("");
});

it("applies a theme an agent published once, and the person's Reset wins after it", async () => {
  await render(<ThemePackEditor variant="light" />);
  const editor = await openCssEditor();
  const published = {
    revision: `test-${Date.now()}`,
    publishedAt: "2026-11-17T00:00:00.000Z",
    light: { accent: "#123456", css: PROBE_CSS },
  };
  expect(adoptPublishedTheme(published)).toBe(true);
  await expect.poll(probeColor).toBe("rgb(9, 8, 7)");
  expect(parseStoredThemeState(localStorage.getItem("moss:theme")).chromeThemes.light.accent).toBe(
    "#123456",
  );
  // The editor shows it like any theme: its CSS is there to edit.
  await expect.element(editor).toHaveValue(PROBE_CSS);

  await page.getByRole("button", { name: "Reset", exact: true }).click();
  await expect.poll(probeColor).not.toBe("rgb(9, 8, 7)");
  // The same revision arriving again (a reconnect) does not undo the Reset.
  expect(adoptPublishedTheme(published)).toBe(false);
  expect(storedLightCss()).toBeUndefined();
});

it("paints a stored theme's CSS when the theme module loads, before anything renders", async () => {
  localStorage.setItem(
    "moss:theme",
    JSON.stringify(setThemeCss({ ...DEFAULT_THEME_STATE, mode: "light" }, "light", PROBE_CSS)),
  );
  // A second copy of the theme store module, as on launch: Vite serves a module with a query
  // as a new instance. Nothing renders and no hook runs before the check.
  const freshThemeModule = "/src/hooks/useTheme.ts?first-frame";
  await import(/* @vite-ignore */ freshThemeModule);
  expect(probeColor()).toBe("rgb(9, 8, 7)");
});
