// FILE: localModuleLibraries.test.ts
// Purpose: Exact ESM imports, atomic fallback and blob lifetime boundaries.
// Layer: Server app tests

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { runInNewContext } from "node:vm";

import { describe, expect, it, vi } from "vitest";

import { readInlineVisualizationLibrary } from "../../inlineVisualizationAccess";
import { preparePageAppLibraries } from "./localLibraries";
import { buildPageAppModuleBootstrap, PAGE_APP_LOCAL_MODULES } from "./localModuleLibraries";

const d3 = PAGE_APP_LOCAL_MODULES[0].urls[0];
const three = PAGE_APP_LOCAL_MODULES[2].urls[0];
const moduleTag = (code: string, attributes = "") =>
  `<script type="module" ${attributes}>${code}</script>`;
const prepare = (html: string) =>
  preparePageAppLibraries(html, undefined, readInlineVisualizationLibrary);

describe("page app local modules", () => {
  it("places one import map bootstrap before any app script and preserves the original imports", async () => {
    const module = moduleTag(`import {select} from '${d3}';import * as THREE from '${three}';`);
    const html = `<html><head><script>window.before=true;</script>${module}</head><body></body></html>`;
    const result = await prepare(html);
    expect(result.offlineReady).toBe(true);
    expect(result.html.indexOf("data-moss-local-modules")).toBeLessThan(
      result.html.indexOf("window.before"),
    );
    expect(result.html).toContain(module);
    expect(result.html.match(/data-moss-local-modules/gu)).toHaveLength(1);
    expect(result.html).toContain("three.core.js");
  });

  it("ignores imports in code strings/comments, raw text and templates", async () => {
    const code = `const text="import x from '${d3}'";/* import x from '${three}'; */`;
    const html = `<textarea>${moduleTag(`import '${d3}'`)}</textarea><template>${moduleTag(`import '${three}'`)}</template>${moduleTag(code)}`;
    const read = vi.fn(async () => null);
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: true,
    });
    expect(read).not.toHaveBeenCalled();
  });

  it.each([
    `import('${d3}')`,
    `import name from '${d3}' with {type:'json'};`,
    `import name from '${d3.replace("7.9.0", "7")}';`,
    "import name from './module.js';",
    "import name from 'unknown';",
    "console.log(import.meta.url);",
    "import '",
  ])("leaves unsupported module syntax or resources unchanged: %s", async (code) => {
    const html = moduleTag(code);
    expect(await prepare(html)).toEqual({ html, offlineReady: false });
  });

  it.each([
    `<script type="importmap">{"imports":{}}</script>${moduleTag(`import '${d3}';`)}`,
    moduleTag("", `src="${d3}"`),
    moduleTag(`import '${d3}';`, "async"),
    moduleTag(`import '${d3}';`, 'integrity="sha256-test"'),
    moduleTag(`import '${d3}';`).repeat(17),
  ])("does not partially modify an unsupported module document", async (html) => {
    expect(await prepare(html)).toEqual({ html, offlineReady: false });
  });

  it("rolls back classic localization too if a module dependency is missing", async () => {
    const html = `<script src="https://cdn.jsdelivr.net/npm/d3@7.9.0/dist/d3.min.js"></script>${moduleTag(`import '${three}'`)}`;
    const read = vi.fn(async (name: string, root: string | undefined) =>
      name === "three.core.js" ? null : readInlineVisualizationLibrary(name, root),
    );
    expect(await preparePageAppLibraries(html, undefined, read)).toEqual({
      html,
      offlineReady: false,
    });
  });

  it("keeps the complete upstream lexer bytes and license", async () => {
    const bytes = await readFile(new URL("./vendor/es-module-lexer.js", import.meta.url));
    expect(bytes.byteLength).toBe(27257);
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(
      "95f6b0530ab27cb146e89bc33acfa45f606c66ee589d16469b414942fc1b4864",
    );
    expect(
      await readFile(new URL("./vendor/es-module-lexer.LICENSE.txt", import.meta.url), "utf8"),
    ).toContain("Copyright (C) 2018-2022 Guy Bedford");
  });

  it.each([false, true])(
    "cleans every blob on pagehide or initialization failure (failure=%s)",
    (fail) => {
      const listeners = new Map<string, () => void>();
      const created: string[] = [];
      const revoked: string[] = [];
      const maps: Array<{ type: string; textContent: string; remove: () => void }> = [];
      const removed = vi.fn();
      const bootstrap = buildPageAppModuleBootstrap([
        { urls: [three], source: "import './core';", core: "export const core=1;" },
      ]);
      runInNewContext(bootstrap.slice(bootstrap.indexOf(">") + 1, -9), {
        Blob,
        URL: {
          createObjectURL: () => {
            if (fail && created.length === 1) throw new Error("fixture allocation failure");
            const url = `blob:fixture-${created.length}`;
            created.push(url);
            return url;
          },
          revokeObjectURL: (url: string) => revoked.push(url),
        },
        document: {
          currentScript: { before: (map: (typeof maps)[number]) => maps.push(map) },
          createElement: () => ({ type: "", textContent: "", remove: removed }),
        },
        addEventListener: (name: string, callback: () => void) => listeners.set(name, callback),
        removeEventListener: (name: string) => listeners.delete(name),
      });
      if (!fail) {
        expect(maps).toHaveLength(1);
        expect(JSON.parse(maps[0]!.textContent).imports[three]).toBe(created[1]);
        expect(revoked).toHaveLength(0);
        listeners.get("pagehide")!();
        expect(removed).toHaveBeenCalledOnce();
      } else expect(maps).toHaveLength(0);
      expect(revoked).toEqual(created);
      expect(listeners.size).toBe(0);
    },
  );
});
