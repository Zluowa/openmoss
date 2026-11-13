// FILE: designFontFaces.ts
// Purpose: Declares the fonts Moss ships (Inter, JetBrains Mono) inside every artboard frame, so
//          an artboard set in them renders the same with no network, on every Moss.
// Layer: 资料空间 设计 (web)
// Why: A frame does not see the app's own @font-face rules; the font files are part of the app
//      bundle, so the frame points at the same files (allowed by its content security policy).

import interLatinExt from "@fontsource-variable/inter/files/inter-latin-ext-wght-normal.woff2?url";
import interLatin from "@fontsource-variable/inter/files/inter-latin-wght-normal.woff2?url";
import monoLatin from "@fontsource-variable/jetbrains-mono/files/jetbrains-mono-latin-wght-normal.woff2?url";

function absolute(url: string): string {
  try {
    return new URL(url, window.location.href).toString();
  } catch {
    return url;
  }
}

/** The @font-face rules every artboard frame gets. */
export function bundledFontFaces(): string {
  return [
    `@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url("${absolute(interLatin)}") format("woff2-variations");unicode-range:U+0000-00FF,U+0131,U+0152-0153,U+02BB-02BC,U+02C6,U+02DA,U+02DC,U+0304,U+0308,U+0329,U+2000-206F,U+20AC,U+2122,U+2191,U+2193,U+2212,U+2215,U+FEFF,U+FFFD}`,
    `@font-face{font-family:"Inter Variable";font-style:normal;font-display:swap;font-weight:100 900;src:url("${absolute(interLatinExt)}") format("woff2-variations");unicode-range:U+0100-02BA,U+02BD-02C5,U+02C7-02CC,U+02CE-02D7,U+02DD-02FF,U+0304,U+0308,U+0329,U+1D00-1DBF,U+1E00-1E9F,U+1EF2-1EFF,U+2020,U+20A0-20AB,U+20AD-20C0,U+2113,U+2C60-2C7F,U+A720-A7FF}`,
    `@font-face{font-family:"JetBrains Mono Variable";font-style:normal;font-display:swap;font-weight:100 800;src:url("${absolute(monoLatin)}") format("woff2-variations")}`,
  ].join("");
}

/** Origins the bundled font files load from, for the frame's `font-src`. */
export function bundledFontOrigins(): string {
  const origins = new Set<string>();
  for (const url of [interLatin, interLatinExt, monoLatin]) {
    try {
      const origin = new URL(url, window.location.href).origin;
      if (origin && origin !== "null") origins.add(origin);
    } catch {
      // A relative path that cannot resolve stays covered by 'self'.
    }
  }
  return [...origins].join(" ");
}
