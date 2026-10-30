import * as FS from "node:fs";
import * as OS from "node:os";
import * as Path from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import {
  MOSS_CANVAS_BUNDLE_DIR,
  MOSS_CANVAS_BUNDLE_REQUIRED_PATHS,
  MOSS_CANVAS_EXTRA_RESOURCE,
  prepareMossCanvasBundle,
  validateMossCanvasBundle,
} from "./bundled-moss-canvas.ts";

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const cleanup of cleanups.splice(0)) cleanup();
});

function tempDir(): string {
  const directory = FS.mkdtempSync(Path.join(OS.tmpdir(), "moss-canvas-bundle-"));
  cleanups.push(() => FS.rmSync(directory, { recursive: true, force: true }));
  return directory;
}

function writeFixtureSource(root: string): void {
  const files: Record<string, string> = {
    LICENSE: "Fixture source license\n",
    NOTICE: "Fixture source notices\n",
    "apps/codex-canvas/src/HoolaMorphingTabs.LICENSE": "Fixture component MIT license\n",
    "COMMERCIAL_LICENSE.md": "Fixture commercial license information\n",
    "apps/codex-canvas/package.json": JSON.stringify({ name: "moss-canvas" }),
    "apps/codex-canvas/dist/index.html": "<html>canvas</html>",
    "apps/codex-canvas/dist/page-editor.html": "<html>page editor</html>",
    "apps/codex-canvas/electron/desktop-runtime.mjs": "export {};\n",
    "apps/codex-canvas/electron/preload.cjs": '"use strict";\n',
    "apps/codex-canvas/server/hosted-storage.mjs": "export {};\n",
    "apps/codex-canvas/electron/dev.mjs": "// dev only\n",
    "apps/codex-canvas/electron/main.test.mjs": "// test never ships\n",
    "electron/runtime.mjs": "export {};\n",
    "electron/native-renderer-api.mjs": "export {};\n",
    "electron/runtime.test.mjs": "// test never ships\n",
    ".env": "VITE_TLDRAW_LICENSE_KEY=never-bundled\n",
    "apps/codex-canvas/node_modules/sentry/package.json": "{}",
  };
  for (const [relative, content] of Object.entries(files)) {
    const absolute = Path.join(root, relative);
    FS.mkdirSync(Path.dirname(absolute), { recursive: true });
    FS.writeFileSync(absolute, content);
  }
}

describe("bundled-moss-canvas", () => {
  it("points electron-builder at the staged bundle as the moss-canvas resource", () => {
    expect(MOSS_CANVAS_EXTRA_RESOURCE).toEqual({
      from: "apps/desktop/canvas-bundle",
      to: "moss-canvas",
    });
    expect(MOSS_CANVAS_BUNDLE_DIR).toBe("apps/desktop/canvas-bundle");
  });

  it("prepares a self-contained bundle without tests, env files or node_modules", () => {
    const source = Path.join(tempDir(), "source");
    const target = Path.join(tempDir(), "target");
    writeFixtureSource(source);
    const validation = prepareMossCanvasBundle({ sourceDir: source, targetDir: target });
    for (const required of MOSS_CANVAS_BUNDLE_REQUIRED_PATHS)
      expect(FS.existsSync(Path.join(target, required)), required).toBe(true);
    expect(FS.existsSync(Path.join(target, "apps/codex-canvas/electron/main.test.mjs"))).toBe(
      false,
    );
    expect(FS.existsSync(Path.join(target, "electron/runtime.test.mjs"))).toBe(false);
    expect(FS.existsSync(Path.join(target, ".env"))).toBe(false);
    expect(FS.existsSync(Path.join(target, "apps/codex-canvas/node_modules"))).toBe(false);
    expect(validation.fileCount).toBeGreaterThan(0);
    expect(validation.sha256).toMatch(/^[0-9a-f]{64}$/u);
    const receipt = JSON.parse(
      FS.readFileSync(Path.join(target, "canvas-bundle-receipt.json"), "utf8"),
    ) as { sha256: string; fileCount: number };
    expect(receipt.sha256).toBe(validation.sha256);
  });

  it("fails closed when a required runtime file is missing", () => {
    const source = Path.join(tempDir(), "source");
    writeFixtureSource(source);
    FS.rmSync(Path.join(source, "apps/codex-canvas/electron/desktop-runtime.mjs"));
    const target = Path.join(tempDir(), "target");
    expect(() => prepareMossCanvasBundle({ sourceDir: source, targetDir: target })).toThrow(
      /desktop-runtime\.mjs/u,
    );
  });

  it("rejects an empty renderer entrypoint at validation time", () => {
    const source = Path.join(tempDir(), "source");
    writeFixtureSource(source);
    FS.writeFileSync(Path.join(source, "apps/codex-canvas/dist/index.html"), "");
    expect(() =>
      prepareMossCanvasBundle({ sourceDir: source, targetDir: Path.join(tempDir(), "target") }),
    ).toThrow(/dist\/index\.html/u);
  });

  it("requires the real Page editor entry when its source declares the Page host", () => {
    const source = Path.join(tempDir(), "source");
    writeFixtureSource(source);
    FS.writeFileSync(
      Path.join(source, "apps/codex-canvas/page-editor.html"),
      "<html>Page host source entry</html>",
    );
    FS.rmSync(Path.join(source, "apps/codex-canvas/dist/page-editor.html"));
    expect(() =>
      prepareMossCanvasBundle({ sourceDir: source, targetDir: Path.join(tempDir(), "target") }),
    ).toThrow(/page-editor\.html/u);
  });

  it("retains legacy bundle compatibility while enforcing declared Page entry receipts", () => {
    const source = Path.join(tempDir(), "source");
    const target = Path.join(tempDir(), "target");
    writeFixtureSource(source);
    FS.rmSync(Path.join(source, "apps/codex-canvas/dist/page-editor.html"));
    expect(() => prepareMossCanvasBundle({ sourceDir: source, targetDir: target })).not.toThrow();
    FS.writeFileSync(
      Path.join(source, "apps/codex-canvas/page-editor.html"),
      "<html>Page source</html>",
    );
    FS.writeFileSync(
      Path.join(source, "apps/codex-canvas/dist/page-editor.html"),
      "<html>Page runtime</html>",
    );
    prepareMossCanvasBundle({ sourceDir: source, targetDir: target });
    expect(
      JSON.parse(FS.readFileSync(Path.join(target, "canvas-bundle-receipt.json"), "utf8"))
        .requiredPaths,
    ).toContain("apps/codex-canvas/dist/page-editor.html");
    FS.rmSync(Path.join(target, "apps/codex-canvas/dist/page-editor.html"));
    expect(() => validateMossCanvasBundle(target)).toThrow(/page-editor\.html/u);
  });

  it("refuses to stage the bundle inside its own source checkout", () => {
    const source = Path.join(tempDir(), "source");
    writeFixtureSource(source);
    expect(() =>
      prepareMossCanvasBundle({
        sourceDir: source,
        targetDir: Path.join(source, "apps/desktop/canvas-bundle"),
      }),
    ).toThrow(/must not live inside/u);
  });

  it("validates an already staged bundle deterministically", () => {
    const source = Path.join(tempDir(), "source");
    const target = Path.join(tempDir(), "target");
    writeFixtureSource(source);
    const first = prepareMossCanvasBundle({ sourceDir: source, targetDir: target });
    const second = validateMossCanvasBundle(target);
    // The receipt is written after hashing, so both passes cover the same files.
    expect(second.fileCount).toBe(first.fileCount);
    expect(second.sha256).toBe(first.sha256);
  });

  it("preserves the previous bundle when the new renderer fails validation", () => {
    const source = Path.join(tempDir(), "source");
    const target = Path.join(tempDir(), "target");
    writeFixtureSource(source);
    const previous = prepareMossCanvasBundle({ sourceDir: source, targetDir: target });
    FS.writeFileSync(Path.join(source, "apps/codex-canvas/dist/index.html"), "");
    expect(() => prepareMossCanvasBundle({ sourceDir: source, targetDir: target })).toThrow();
    expect(validateMossCanvasBundle(target).sha256).toBe(previous.sha256);
    expect(FS.readdirSync(Path.dirname(target))).toEqual(["target"]);
  });

  it("refuses an unrelated target and a target containing the source", () => {
    const root = tempDir();
    const source = Path.join(root, "source");
    const target = Path.join(tempDir(), "target");
    writeFixtureSource(source);
    FS.mkdirSync(target);
    FS.writeFileSync(Path.join(target, "keep.txt"), "unrelated data");
    expect(() => prepareMossCanvasBundle({ sourceDir: source, targetDir: target })).toThrow(
      /not an owned/u,
    );
    expect(FS.readFileSync(Path.join(target, "keep.txt"), "utf8")).toBe("unrelated data");
    expect(() => prepareMossCanvasBundle({ sourceDir: source, targetDir: root })).toThrow(
      /must not contain/u,
    );
  });
});
