// FILE: bundledFonts.browser.ts
// Purpose: The screens drawn before the app, and the theme presets that name a face, draw in
//          the fonts Moss ships, loaded from Moss itself (WALK-11/WALK-12 N11-2).
// Layer: Browser test

import "../bundledFonts";

import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { renderSignedOutScreen } from "../authSignedOut";
import { renderPairingFailure } from "../pairingBootstrap";
import {
  DEFAULT_THEME_STATE,
  buildThemeCssVariables,
  resolveThemePack,
  setThemeCodeThemeId,
} from "../theme/theme.logic";

const THEME_FONT_VARIABLES = ["--theme-font-ui-family", "--theme-font-code-family"] as const;
// Room for every request of the run, so the font files this file loads are in the timeline.
performance.setResourceTimingBufferSize(100_000);

function unquote(face: string): string {
  return face.trim().replace(/^(["'])(.*)\1$/u, "$2");
}

/** The face the element asks for first. */
function firstFace(element: Element): string {
  return unquote(getComputedStyle(element).fontFamily.split(",")[0] ?? "");
}

/** Loads what the element's own text needs from its first face; returns the faces that drew it. */
async function facesDrawing(element: HTMLElement) {
  const style = getComputedStyle(element);
  const font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} "${firstFace(element)}"`;
  const faces = await document.fonts.load(font, element.textContent ?? "");
  return faces.map((face) => ({ family: unquote(face.family), status: face.status }));
}

async function expectDrawnIn(element: HTMLElement, family: string) {
  expect(element.textContent?.trim()).not.toBe("");
  expect(firstFace(element)).toBe(family);
  const faces = await facesDrawing(element);
  expect(faces.length).toBeGreaterThan(0);
  expect(faces).toEqual(faces.map(() => ({ family, status: "loaded" })));
}

function expectFontFilesFromMoss() {
  const fontFiles = performance
    .getEntriesByType("resource")
    .map((entry) => new URL(entry.name))
    .filter((url) => /\.woff2?$/u.test(url.pathname));
  expect(fontFiles.length).toBeGreaterThan(0);
  expect(fontFiles.filter((url) => url.origin !== window.location.origin)).toEqual([]);
}

/** Applies a preset's font variables the way the theme applier does (empty removes). */
function applyThemeFonts(codeThemeId: string) {
  const state = setThemeCodeThemeId(DEFAULT_THEME_STATE, "dark", codeThemeId);
  const { variables } = buildThemeCssVariables(resolveThemePack(state, "dark"), "dark", {
    systemUiFont: false,
  });
  for (const name of THEME_FONT_VARIABLES) {
    const value = variables[name] ?? "";
    if (value) document.documentElement.style.setProperty(name, value);
    else document.documentElement.style.removeProperty(name);
  }
}

function sample(token: "--font-ui-family" | "--font-mono-family", text: string): HTMLElement {
  const element = document.createElement("p");
  element.style.fontFamily = `var(${token})`;
  element.textContent = text;
  document.getElementById("root")!.append(element);
  return element;
}

describe("N11-2: Moss draws in the fonts it ships", () => {
  beforeEach(() => {
    document.getElementById("root")?.remove();
    const root = document.createElement("div");
    root.id = "root";
    document.body.append(root);
  });

  afterEach(() => {
    document.getElementById("root")?.remove();
    for (const name of THEME_FONT_VARIABLES) document.documentElement.style.removeProperty(name);
    document.documentElement.lang = "en";
    document.documentElement.removeAttribute("data-moss-locale");
    document.title = "";
  });

  it("draws the pairing-failure screen in Inter and its label in JetBrains Mono", async () => {
    renderPairingFailure("en");

    await expectDrawnIn(document.querySelector("h1")!, "Inter Variable");
    await expectDrawnIn(document.querySelector("section > p")!, "JetBrains Mono Variable");
    expectFontFilesFromMoss();
  });

  it("draws the signed-out screen in Inter and its label in JetBrains Mono", async () => {
    renderSignedOutScreen("en");

    await expectDrawnIn(document.querySelector("h1")!, "Inter Variable");
    await expectDrawnIn(document.querySelector("section > p")!, "JetBrains Mono Variable");
    expectFontFilesFromMoss();
  });

  it("draws the Indigo preset, which names Inter, in the Inter Moss ships", async () => {
    applyThemeFonts("linear");

    await expectDrawnIn(sample("--font-ui-family", "Indigo preset"), "Inter");
    expectFontFilesFromMoss();
  });

  it("draws the Monochrome preset in the Inter and JetBrains Mono Moss ships", async () => {
    applyThemeFonts("vercel");

    await expectDrawnIn(sample("--font-ui-family", "Monochrome preset"), "Inter Variable");
    await expectDrawnIn(
      sample("--font-mono-family", "const preset = 1;"),
      "JetBrains Mono Variable",
    );
    expectFontFilesFromMoss();
  });
});
