import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readdirSync, rmSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const WEB_DIR = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const OUTPUT_DIR = resolve(WEB_DIR, ".playwright/electron-e2e");
const OUTPUT_PATH = resolve(OUTPUT_DIR, "visibleBrowserMain.cjs");
const ANNOTATION_PRELOAD_OUTPUT_PATH = resolve(OUTPUT_DIR, "browserAnnotationGuestPreload.cjs");
const MCP_APP_MAIN_OUTPUT_PATH = resolve(OUTPUT_DIR, "mcpAppSandboxMain.cjs");
const MCP_APP_TRUSTED_PRELOAD_OUTPUT_PATH = resolve(OUTPUT_DIR, "mcpAppSandboxTrustedPreload.cjs");
const MCP_APP_GUEST_PRELOAD_OUTPUT_PATH = resolve(OUTPUT_DIR, "mcpAppSandboxGuestPreload.cjs");
const MCP_APP_RENDERER_OUTPUT_PATH = resolve(OUTPUT_DIR, "mcpAppSandboxRenderer.js");
const MCP_APP_GUEST_OUTPUT_PATH = resolve(OUTPUT_DIR, "mcpAppSandboxGuest.iife.js");
const PRODUCTION_CSS_OUTPUT_DIR = resolve(OUTPUT_DIR, "production-css");

function buildProductionCss(): string {
  const cssEntry = resolve(WEB_DIR, "src/index.css");
  const buildScript = [
    'import { build } from "vite";',
    'import tailwindcss from "@tailwindcss/vite";',
    `await build({configFile:false,root:${JSON.stringify(WEB_DIR)},plugins:[tailwindcss()],build:{outDir:${JSON.stringify(PRODUCTION_CSS_OUTPUT_DIR)},emptyOutDir:true,rollupOptions:{input:${JSON.stringify(cssEntry)}}}});`,
  ].join("\n");
  execFileSync("bun", ["-e", buildScript], { cwd: WEB_DIR, stdio: "inherit" });
  const assetsDir = resolve(PRODUCTION_CSS_OUTPUT_DIR, "assets");
  const cssFiles = existsSync(assetsDir)
    ? readdirSync(assetsDir)
        .filter((entry) => /^index-[^/]+\.css$/u.test(entry))
        .map((entry) => resolve(assetsDir, entry))
    : [];
  if (cssFiles.length !== 1) {
    throw new Error(
      "The MCP App Electron fixture did not produce exactly one production CSS asset.",
    );
  }
  return cssFiles[0]!;
}

export default function globalSetup(): () => void {
  mkdirSync(OUTPUT_DIR, { recursive: true });
  const productionCssPath = buildProductionCss();
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/visibleBrowserMain.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${OUTPUT_PATH}`,
      "--external=electron",
      "--external=betterwright",
      `--banner=module.paths.unshift(${JSON.stringify(resolve(WEB_DIR, "../desktop/node_modules"))});`,
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "../desktop/src/browserAnnotations/guestPreload.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${ANNOTATION_PRELOAD_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/mcpAppSandboxMain.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${MCP_APP_MAIN_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "../desktop/src/preload.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${MCP_APP_TRUSTED_PRELOAD_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "../desktop/src/mcpAppSandbox/guestPreload.ts",
      "--target=node",
      "--format=cjs",
      `--outfile=${MCP_APP_GUEST_PRELOAD_OUTPUT_PATH}`,
      "--external=electron",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/mcpAppSandboxRenderer.ts",
      "--target=browser",
      "--format=iife",
      `--outdir=${OUTPUT_DIR}`,
      "--define",
      'import.meta.env={"VITE_WS_URL":"","DEV":false,"APP_VERSION":"0.7.6"}',
      "--define",
      'import.meta.url="http://127.0.0.1/mcpAppSandboxRenderer.js"',
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  execFileSync(
    "bun",
    [
      "build",
      "e2e/fixtures/mcpAppSandboxGuest.ts",
      "--target=browser",
      "--format=iife",
      `--outfile=${MCP_APP_GUEST_OUTPUT_PATH}`,
      "--define",
      "require=undefined",
    ],
    { cwd: WEB_DIR, stdio: "inherit" },
  );
  process.env.MOSS_E2E_ELECTRON_MAIN = OUTPUT_PATH;
  process.env.MOSS_E2E_BROWSER_ANNOTATION_PRELOAD = ANNOTATION_PRELOAD_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_MAIN = MCP_APP_MAIN_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_TRUSTED_PRELOAD = MCP_APP_TRUSTED_PRELOAD_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_GUEST_PRELOAD = MCP_APP_GUEST_PRELOAD_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_RENDERER = MCP_APP_RENDERER_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_GUEST = MCP_APP_GUEST_OUTPUT_PATH;
  process.env.MOSS_E2E_MCP_APP_CSS = productionCssPath;
  return () => rmSync(OUTPUT_DIR, { recursive: true, force: true });
}
