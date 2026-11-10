// FILE: localLibraries.bundle.test.ts
// Purpose: The production tsdown configuration includes the vendored parser.
// Layer: Focused server artifact test; no full server build or provider startup.

import { mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { build } from "tsdown";
import { expect, it } from "vitest";

import productionConfig from "../../../tsdown.config";

it("executes real local-library preparation from a production-config tsdown artifact", async () => {
  const parent = path.resolve(os.tmpdir());
  const output = await mkdtemp(path.join(parent, "moss-app-library-bundle-"));
  try {
    await build({
      ...productionConfig[0],
      config: false,
      entry: [fileURLToPath(new URL("./localLibraries.ts", import.meta.url))],
      format: ["esm"],
      outDir: output,
      clean: false,
      sourcemap: false,
    });
    const files = await readdir(output);
    const entry = files.find((file) => /^localLibraries\.(?:m?js)$/u.test(file));
    expect(entry).toBeDefined();
    const source = await readFile(path.join(output, entry!), "utf8");
    expect(source).toContain("es-module-lexer");
    expect(source).toContain("Copyright (C) 2018-2022 Guy Bedford");
    expect(source).toContain("THE SOFTWARE IS PROVIDED");
    expect(source).not.toMatch(/from\s+["'][^"']*(?:vendor|es-module-lexer)[^"']*["']/u);
    const artifact = (await import(pathToFileURL(path.join(output, entry!)).href)) as {
      preparePageAppLibraries: (
        html: string,
        staticDir: undefined,
        read: (name: string) => Promise<{ contents: Uint8Array; contentType: string }>,
      ) => Promise<{ html: string; offlineReady: boolean }>;
    };
    const html =
      '<script type="module">import {select} from "https://cdn.jsdelivr.net/npm/d3@7.9.0/+esm";const text="import x from unknown";</script>';
    const result = await artifact.preparePageAppLibraries(html, undefined, async (name) => ({
      contents: await readFile(
        new URL(`../../../../web/public/inline-visualization-libs/${name}`, import.meta.url),
      ),
      contentType: "text/javascript",
    }));
    expect(result.offlineReady).toBe(true);
    expect(result.html).toContain("data-moss-local-modules");
    expect(result.html).toContain(html);
  } finally {
    const relative = path.relative(parent, output);
    if (!relative.startsWith("moss-app-library-bundle-") || relative.includes(path.sep))
      throw new Error("Unexpected bundle scratch path");
    await rm(output, { recursive: true, force: true });
  }
}, 15_000);
