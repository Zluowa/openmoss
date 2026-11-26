// FILE: desktop-bundle-files.ts
// Purpose: Exclude non-runtime files from desktop artifacts without changing the staged install.
// Layer: Release/build helper

const DIAGNOSTIC_FILES = [
  "!node_modules/**/*.{js,mjs,cjs,ts,mts,cts}.map",
  "!node_modules/**/*.{d.mts,d.cts,tsbuildinfo}",
  // These packages execute their compiled JS exports. Keep arbitrary dependency
  // sources: extension loaders and native helpers can legitimately need them.
  // Remove only TypeScript, retaining vendored licenses and other source assets.
  "!node_modules/effect/src/**/*.ts",
  "!node_modules/@effect/{platform-node,platform-node-shared,sql-sqlite-bun}/src/**/*.ts",
  "!node_modules/@anthropic-ai/sdk/src/**/*.ts",
  "!node_modules/**/node_modules/@anthropic-ai/sdk/src/**/*.ts",
  "!node_modules/zod/src/**/*.ts",
  "!node_modules/**/node_modules/zod/src/**/*.ts",
  "!node_modules/{tldts,tldts-core,tldts-experimental,smol-toml,mime,eventsource,eventsource-parser}/src/**/*.ts",
  "!node_modules/tough-cookie/node_modules/tldts/src/**/*.ts",
  "!node_modules/tough-cookie/node_modules/tldts/node_modules/tldts-core/src/**/*.ts",
  "!node_modules/@noble/{hashes,curves,ciphers}/src/**/*.ts",
  "!node_modules/**/node_modules/@noble/hashes/src/**/*.ts",
] as const;

const UNUSED_DEPENDENCY_RUNTIME_FILES = [
  // BetterWright optional/debug payloads unused by Moss:
  // - patchright-core is only loaded for stealthRuntimeFix (unsupported on hostTarget).
  // - playwright-core/lib/vite contains HTML report / trace viewer / recorder web UIs.
  // - @ghostery/* is lazy-imported by betterwright/dist/src/ad-blocker.js only when adBlock: true;
  //   Moss explicitly passes adBlock: false on every BetterWright instance.
  "!node_modules/patchright-core/**",
  "!node_modules/playwright-core/lib/vite/**",
  "!node_modules/**/node_modules/playwright-core/lib/vite/**",
  "!node_modules/@ghostery/**",
  "!node_modules/betterwright/docs/**",
  // Effect bundles full Scalar and Swagger HTML/JS UIs that Moss never serves.
  "!node_modules/effect/dist/unstable/httpapi/internal/httpApiScalar.js",
  "!node_modules/effect/dist/unstable/httpapi/internal/httpApiSwagger.js",
  // Browser-only SDK bundle; Node runtime loads sdk.mjs.
  "!node_modules/@anthropic-ai/claude-agent-sdk/browser-sdk.js",
  // Undici markdown documentation trees.
  "!node_modules/undici/docs/**",
  "!node_modules/**/node_modules/undici/docs/**",
] as const;

// Desktop Electron loads static assets over 127.0.0.1 loopback. Shipping
// precompressed .gz/.br sidecars inside app.asar adds ~15 MB of incompressible
// bytes directly to every installer and copies 1,700+ extra files; CLI and SSH
// runtime packs still read directly from apps/server/dist with sidecars intact,
// and apps/server/src/http.ts serves uncompressed assets when sidecars are absent.
export const DESKTOP_CLIENT_PRECOMPRESSED_SIDECAR_EXCLUSION =
  "!apps/server/dist/client/**/*.{gz,br}";

export function isDesktopClientPrecompressedSidecar(relativeServerDistPath: string): boolean {
  const normalized = relativeServerDistPath.replaceAll("\\", "/");
  return normalized.startsWith("client/") && /\.(?:gz|br)$/u.test(normalized);
}

export function preserveDependencyDiagnostics(env: NodeJS.ProcessEnv): boolean {
  return [env.MOSS_WEB_SOURCEMAP, env.MOSS_SERVER_SOURCEMAP, env.MOSS_DESKTOP_SOURCEMAP].some(
    (value) => ["1", "true", "hidden"].includes(value?.trim().toLowerCase() ?? ""),
  );
}

export function createDesktopBundleFileExclusions(
  platform: "mac" | "linux" | "win",
  options: { readonly diagnostics?: boolean } = {},
): string[] {
  const exclusions: string[] = [
    DESKTOP_CLIENT_PRECOMPRESSED_SIDECAR_EXCLUSION,
    ...UNUSED_DEPENDENCY_RUNTIME_FILES,
  ];
  if (!options.diagnostics) exclusions.push(...DIAGNOSTIC_FILES);

  // node-pty is rebuilt or selected before packaging. Its platform prebuilds are not
  // interchangeable; retain both same-platform architectures for universal Mac.
  if (platform !== "mac") exclusions.push("!node_modules/node-pty/prebuilds/darwin-*/**");
  if (platform !== "win") exclusions.push("!node_modules/node-pty/prebuilds/win32-*/**");
  exclusions.push("!node_modules/node-pty/lib/*.test.js");
  // MSVC leaves incremental-link inputs and build logs next to the rebuilt
  // addon. These are build products, not DLLs, executables, or native addons.
  exclusions.push(
    "!node_modules/node-pty/build/**/*.{iobj,ipdb,tlog,vcxproj,filters,recipe,lastbuildstate,exp,lib}",
  );

  // All icon preferences for the target OS and the shared fallbacks (moss.png, icon.png) remain intact.
  const resources = "!apps/desktop/prod-resources/";
  exclusions.push(`${resources}entitlements.mac*.plist`, `${resources}installer.nsh`);
  if (platform !== "mac") {
    exclusions.push(
      `${resources}app-icon-macos.png`,
      `${resources}dock-icon*.png`,
      `${resources}icon.icns`,
    );
  }
  if (platform !== "linux") {
    exclusions.push(
      `${resources}app-icon-linux.png`,
      `${resources}app-icon-beta-linux.png`,
      `${resources}app-icon-default-linux.png`,
    );
  }
  if (platform !== "win") {
    exclusions.push(
      `${resources}app-icon-windows.ico`,
      `${resources}app-icon-beta-windows.ico`,
      `${resources}app-icon-default-windows.ico`,
      `${resources}icon.ico`,
    );
  }

  return exclusions;
}

export function createDesktopBundleFilePatterns(
  platform: "mac" | "linux" | "win",
  options: { readonly diagnostics?: boolean } = {},
): string[] {
  return ["**/*", ...createDesktopBundleFileExclusions(platform, options)];
}
