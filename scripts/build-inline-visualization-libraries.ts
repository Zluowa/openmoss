// FILE: build-inline-visualization-libraries.ts
// Purpose: Rebuild the local browser-global assets used by offline Codex visualization frames.
// Layer: Developer build utility

import { copyFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const webNodeModules = path.join(repositoryRoot, "apps", "web", "node_modules");
const outputDirectory = path.join(
  repositoryRoot,
  "apps",
  "web",
  "public",
  "inline-visualization-libs",
);

async function main() {
  await Promise.all([
    copyFile(
      path.join(webNodeModules, "d3", "dist", "d3.min.js"),
      path.join(outputDirectory, "d3.min.js"),
    ),
    copyFile(
      path.join(webNodeModules, "chart.js", "dist", "chart.umd.js"),
      path.join(outputDirectory, "chart.umd.js"),
    ),
    copyFile(
      path.join(webNodeModules, "three", "build", "three.module.js"),
      path.join(outputDirectory, "three.module.js"),
    ),
  ]);

  const scratch = await mkdtemp(path.join(os.tmpdir(), "moss-inline-visualization-libs-"));
  try {
    const entry = path.join(scratch, "three-global.ts");
    await writeFile(
      entry,
      `import * as THREE from ${JSON.stringify(
        path.join(webNodeModules, "three", "build", "three.module.js"),
      )};\nglobalThis.THREE = THREE;\n`,
    );
    const bundle = await Bun.build({
      entrypoints: [entry],
      outdir: scratch,
      format: "iife",
      minify: true,
      target: "browser",
    });
    if (!bundle.success) {
      throw new Error(bundle.logs.map((log) => log.message).join("\n"));
    }
    const output = bundle.outputs.find((candidate) => candidate.path.endsWith(".js"));
    if (!output) throw new Error("Bun did not produce the three.js global bundle.");
    await copyFile(output.path, path.join(outputDirectory, "three.min.js"));
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
