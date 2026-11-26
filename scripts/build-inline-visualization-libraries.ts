// FILE: build-inline-visualization-libraries.ts
// Purpose: Rebuild the local browser-global assets used by offline Codex visualization frames.
// Layer: Developer build utility

import { createHash } from "node:crypto";
import { copyFile, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { MOSS_UI_KIT_TOKENS_CSS } from "@moss/shared/pageAppUiKitTokens";

const repositoryRoot = path.resolve(import.meta.dir, "..");
const webNodeModules = path.join(repositoryRoot, "apps", "web", "node_modules");
const outputDirectory = path.join(
  repositoryRoot,
  "apps",
  "web",
  "public",
  "inline-visualization-libs",
);

async function buildMossUiKit(scratch: string) {
  const uiKitEntry = path.join(
    repositoryRoot,
    "packages",
    "shared",
    "src",
    "pageAppUiKit",
    "index.ts",
  );
  const [uiKitEsm, uiKitUmd] = await Promise.all([
    Bun.build({
      entrypoints: [uiKitEntry],
      outdir: path.join(scratch, "uikit-esm"),
      format: "esm",
      minify: true,
      target: "browser",
    }),
    Bun.build({
      entrypoints: [uiKitEntry],
      outdir: path.join(scratch, "uikit-umd"),
      format: "iife",
      minify: true,
      target: "browser",
    }),
  ]);
  if (!uiKitEsm.success) {
    throw new Error(uiKitEsm.logs.map((log) => log.message).join("\n"));
  }
  if (!uiKitUmd.success) {
    throw new Error(uiKitUmd.logs.map((log) => log.message).join("\n"));
  }
  const esmOut = uiKitEsm.outputs.find((candidate) => candidate.path.endsWith(".js"));
  const umdOut = uiKitUmd.outputs.find((candidate) => candidate.path.endsWith(".js"));
  if (!esmOut || !umdOut) {
    throw new Error("Bun did not produce moss-ui-kit bundles.");
  }
  const esmDest = path.join(outputDirectory, "moss-ui-kit.esm.js");
  const umdDest = path.join(outputDirectory, "moss-ui-kit.umd.js");
  const cssDest = path.join(outputDirectory, "moss-ui-kit.css");
  await Promise.all([
    copyFile(esmOut.path, esmDest),
    copyFile(umdOut.path, umdDest),
    writeFile(
      cssDest,
      `/* Moss UI Kit Tokens (MIT) */\n${MOSS_UI_KIT_TOKENS_CSS.replaceAll(":host", ":root")}\n`,
      "utf8",
    ),
  ]);
  for (const filePath of [esmDest, umdDest, cssDest]) {
    const bytes = await readFile(filePath);
    const sha = createHash("sha256").update(bytes).digest("hex");
    console.log(`${path.basename(filePath)} ${bytes.byteLength}B sha256=${sha}`);
  }
}

async function main() {
  const uiKitOnly = process.argv.includes("--ui-kit-only");
  if (!uiKitOnly) {
    await Promise.all([
      copyFile(
        path.join(webNodeModules, "d3", "dist", "d3.min.js"),
        path.join(outputDirectory, "d3.min.js"),
      ),
      copyFile(
        path.join(webNodeModules, "d3", "LICENSE"),
        path.join(outputDirectory, "d3.LICENSE.txt"),
      ),
      copyFile(
        path.join(webNodeModules, "chart.js", "dist", "chart.umd.js"),
        path.join(outputDirectory, "chart.umd.js"),
      ),
      copyFile(
        path.join(webNodeModules, "chart.js", "LICENSE.md"),
        path.join(outputDirectory, "chart.LICENSE.txt"),
      ),
      copyFile(
        path.join(webNodeModules, "three", "build", "three.module.js"),
        path.join(outputDirectory, "three.module.js"),
      ),
      copyFile(
        path.join(webNodeModules, "three", "build", "three.core.js"),
        path.join(outputDirectory, "three.core.js"),
      ),
      copyFile(
        path.join(webNodeModules, "three", "LICENSE"),
        path.join(outputDirectory, "three.LICENSE.txt"),
      ),
      ...["inter", "jetbrains-mono"].flatMap((font) => [
        copyFile(
          path.join(
            webNodeModules,
            "@fontsource-variable",
            font,
            "files",
            `${font}-latin-wght-normal.woff2`,
          ),
          path.join(outputDirectory, `${font}-latin.woff2`),
        ),
        copyFile(
          path.join(webNodeModules, "@fontsource-variable", font, "LICENSE"),
          path.join(outputDirectory, `${font}.OFL.txt`),
        ),
      ]),
    ]);
  }

  const scratch = await mkdtemp(path.join(os.tmpdir(), "moss-inline-visualization-libs-"));
  try {
    if (!uiKitOnly) {
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
    }

    await buildMossUiKit(scratch);
  } finally {
    await rm(scratch, { recursive: true, force: true });
  }
}

await main();
