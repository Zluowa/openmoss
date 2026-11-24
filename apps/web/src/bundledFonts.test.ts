// FILE: bundledFonts.test.ts
// Purpose: Moss asks no other site for a font at start, its policy still lets Design artboards load
//          Google Fonts, and every face a theme preset names is one Moss ships or one the system
//          has (WALK-11/WALK-12 N11-2).
// Layer: Unit test

import * as FS from "node:fs";
import { createRequire } from "node:module";
import * as Path from "node:path";

import { describe, expect, it } from "vitest";

import { THEME_SEED_CATALOG } from "./theme/theme.seed.generated";

const WEB_ROOT = Path.resolve(import.meta.dirname, "..");
const require = createRequire(import.meta.url);
const read = (file: string) => FS.readFileSync(file, "utf8");

const GOOGLE_FONTS_HOST = /fonts\.(?:googleapis|gstatic)\.com/u;
// The policy for pages a person or an agent made, shown in a sandboxed frame: what such a page
// may load is its own business, not something Moss requests at start.
const FRAME_CONTENT_POLICIES = new Set([
  "public/space-app-preview.html",
  "src/components/spaceTypes/design/designDocument.ts",
]);
// index.html's policy line. Design artboards render in srcdoc frames, which run under this policy
// as well as their own, so it allows what designDocument.ts allows them; allowing a host requests
// nothing.
const SHELL_POLICY = /<meta\s+http-equiv="Content-Security-Policy"\s+content="([^"]*)"\s*\/>/u;
// A stylesheet that imports or points at another site: `@import "https://…"`, `url(//…)`.
const REMOTE_CSS = /(?:@import\s+(?:url\(\s*)?|url\(\s*)["']?(?:https?:)?\/\//u;
const SHIPPED_SOURCE = /\.(?:html|js|mjs|css|ts|tsx|json|webmanifest)$/u;
const TEST_SOURCE = /\.(?:test|browser)\.[^/]+$/u;

/** Faces every Windows, macOS or Linux machine has, and the CSS generic families. */
const SYSTEM_FACES = new Set(
  [
    "serif",
    "sans-serif",
    "monospace",
    "system-ui",
    "ui-sans-serif",
    "ui-serif",
    "ui-monospace",
    "ui-rounded",
    "-apple-system",
    "BlinkMacSystemFont",
    "Segoe UI",
    "Microsoft YaHei",
    "Microsoft YaHei UI",
    "PingFang SC",
    "PingFang TC",
    "Hiragino Sans",
    "Apple SD Gothic Neo",
    "Noto Sans CJK SC",
    "Noto Sans SC",
    "SF Mono",
    "SFMono-Regular",
    "Menlo",
    "Consolas",
    "Cascadia Mono",
    "Liberation Mono",
    "DejaVu Sans Mono",
  ].map((face) => face.toLowerCase()),
);

function shippedSources(dir: string): string[] {
  return FS.readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = Path.join(dir, entry.name);
    if (entry.isDirectory()) {
      return entry.name === "node_modules" || entry.name.startsWith(".")
        ? []
        : shippedSources(path);
    }
    return SHIPPED_SOURCE.test(entry.name) && !TEST_SOURCE.test(entry.name) ? [path] : [];
  });
}

/** index.html's policy, directive by directive. */
function shellPolicy(): Map<string, string[]> {
  const policy = SHELL_POLICY.exec(read(Path.join(WEB_ROOT, "index.html")))?.[1] ?? "";
  return new Map(
    policy
      .split(";")
      .map((directive) => directive.trim().split(/\s+/u))
      .filter(([name]) => name)
      .map(([name = "", ...sources]): [string, string[]] => [name, sources]),
  );
}

/** A shipped file's text, without index.html's policy line: what the file itself loads. */
function shellSource(file: string): string {
  const text = read(Path.join(WEB_ROOT, file));
  return file === "index.html" ? text.replace(SHELL_POLICY, "") : text;
}

function families(stack: string): string[] {
  return stack
    .split(",")
    .map((face) => face.trim().replace(/^(["'])(.*)\1$/u, "$2"))
    .filter((face) => face.length > 0);
}

interface FontFaceRule {
  readonly family: string;
  readonly file: string;
  readonly weight: string;
  readonly range: string;
}

function fontFaces(css: string): FontFaceRule[] {
  return [...css.matchAll(/@font-face\s*\{([^}]*)\}/gu)].map(([, body = ""]) => ({
    family: /font-family:\s*["']([^"']+)["']/u.exec(body)?.[1] ?? "",
    file: Path.basename(/url\(["']?([^"')]+)["']?\)/u.exec(body)?.[1] ?? ""),
    weight: /font-weight:\s*([^;]+);/u.exec(body)?.[1]?.trim() ?? "",
    range: /unicode-range:\s*([^;]+);/u.exec(body)?.[1]?.replaceAll(/\s+/gu, "") ?? "",
  }));
}

/** A face without its family name: which file draws which characters at which weights. */
function withoutFamily({ file, weight, range }: FontFaceRule) {
  return { file, weight, range };
}

/** The stylesheets bundledFonts.ts loads, as files on disk. */
function bundledFontStylesheets(): string[] {
  const source = read(Path.join(WEB_ROOT, "src/bundledFonts.ts"));
  return [...source.matchAll(/^import "([^"]+)";$/gmu)].map(([, specifier = ""]) =>
    specifier.startsWith(".")
      ? Path.join(WEB_ROOT, "src", specifier)
      : require.resolve(specifier, { paths: [WEB_ROOT] }),
  );
}

describe("N11-2: Moss loads no font from another site", () => {
  it("names no Google Fonts host in anything the web app ships", () => {
    const sources = [
      Path.join(WEB_ROOT, "index.html"),
      Path.join(WEB_ROOT, "guest.html"),
      ...shippedSources(Path.join(WEB_ROOT, "public")),
      ...shippedSources(Path.join(WEB_ROOT, "src")),
    ];
    expect(sources.length).toBeGreaterThan(1000);
    const offenders = sources
      .map((file) => Path.relative(WEB_ROOT, file).replaceAll("\\", "/"))
      .filter((file) => !FRAME_CONTENT_POLICIES.has(file))
      .filter((file) => GOOGLE_FONTS_HOST.test(shellSource(file)));
    expect(offenders).toEqual([]);
  });

  it("starts with styles and fonts from Moss itself only", () => {
    const shell = shellSource("index.html");
    expect(shell).not.toMatch(/<link\b[^>]*\bhref=["']?(?:https?:)?\/\//u);
    expect(shell).not.toMatch(/<script\b[^>]*\bsrc=["']?(?:https?:)?\/\//u);
    expect(shell).not.toMatch(/\brel=["']?(?:preconnect|dns-prefetch)\b/u);
    const stylesheets = [
      ...shippedSources(Path.join(WEB_ROOT, "src")).filter((file) => file.endsWith(".css")),
      ...bundledFontStylesheets(),
    ];
    expect(stylesheets.length).toBeGreaterThan(3);
    const remote = stylesheets.filter((file) => REMOTE_CSS.test(read(file)));
    expect(remote).toEqual([]);
    expect(shell).not.toMatch(REMOTE_CSS);
    expect(FS.existsSync(Path.join(WEB_ROOT, "public/font-loader.js"))).toBe(false);
  });

  it("still lets Design artboards, framed under the shell's policy, load Google Fonts", () => {
    const googleSources = [...shellPolicy()].flatMap(([directive, sources]) =>
      sources.filter((source) => GOOGLE_FONTS_HOST.test(source)).map((s) => `${directive} ${s}`),
    );
    expect(googleSources).toEqual([
      "style-src https://fonts.googleapis.com",
      "font-src https://fonts.gstatic.com",
    ]);
    const artboard = read(
      Path.join(WEB_ROOT, "src/components/spaceTypes/design/designDocument.ts"),
    );
    expect(artboard).toMatch(/style-src [^;`]*https:\/\/fonts\.googleapis\.com/u);
    expect(artboard).toMatch(/font-src [^;`]*https:\/\/fonts\.gstatic\.com/u);
  });

  it("loads the faces Moss ships before the screens drawn before the app", () => {
    const bootstrap = read(Path.join(WEB_ROOT, "src/bootstrap.ts"));
    const fonts = bootstrap.indexOf('import "./bundledFonts";');
    expect(fonts).toBeGreaterThan(bootstrap.indexOf('import "./storageOriginMigration";'));
    expect(fonts).toBeLessThan(bootstrap.indexOf('from "./authSignedOut"'));
    expect(fonts).toBeLessThan(bootstrap.indexOf('from "./pairingBootstrap"'));
  });

  it("answers to Inter with the package's own Inter files, subset for subset", () => {
    const [packageFaces, aliasFaces] = [
      require.resolve("@fontsource-variable/inter/wght.css", { paths: [WEB_ROOT] }),
      Path.join(WEB_ROOT, "src/fonts.css"),
    ].map((file) => fontFaces(read(file)));
    expect(packageFaces!.length).toBeGreaterThan(0);
    expect(packageFaces!.every((face) => face.family === "Inter Variable")).toBe(true);
    expect(aliasFaces!.every((face) => face.family === "Inter")).toBe(true);
    expect(aliasFaces!.map(withoutFamily)).toEqual(packageFaces!.map(withoutFamily));
  });

  it("names in every theme preset only faces Moss ships or the system has", () => {
    const shipped = new Set(
      bundledFontStylesheets()
        .flatMap((file) => fontFaces(read(file)))
        .map((face) => face.family.toLowerCase()),
    );
    expect([...shipped].toSorted()).toEqual(["inter", "inter variable", "jetbrains mono variable"]);

    const unknown = Object.entries(THEME_SEED_CATALOG).flatMap(([id, variants]) =>
      Object.entries(variants).flatMap(([variant, seed]) =>
        [seed?.fonts.ui, seed?.fonts.code]
          .flatMap((stack) => (stack ? families(stack) : []))
          .filter((face) => !shipped.has(face.toLowerCase()))
          .filter((face) => !SYSTEM_FACES.has(face.toLowerCase()))
          .map((face) => `${id} ${variant}: ${face}`),
      ),
    );
    expect(unknown).toEqual([]);
  });
});
