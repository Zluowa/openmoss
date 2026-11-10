import { createHash } from "node:crypto";
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { playwright } from "@vitest/browser-playwright";
import { defineConfig, mergeConfig } from "vitest/config";

import viteConfig, { reactCompilerPlugin } from "./vite.config";
import { withoutVitePlugin } from "./vitePluginConfig";
import { preparePageAppLibraries } from "../server/src/pages/apps/localLibraries";

const srcPath = fileURLToPath(new URL("./src", import.meta.url));
const repoRoot = fileURLToPath(new URL("../..", import.meta.url));
const chromiumExecutablePath = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH?.trim();
const browserCacheDir = process.env.MOSS_BROWSER_VITE_CACHE_DIR?.trim();
const accessibilityOutput = process.env.MOSS_PLUGIN_A11Y_OUTPUT?.trim() ?? "";
const accessibilityWriteEnabled = accessibilityOutput.length > 0;
const appThumbnailProbes = new WeakMap<
  object,
  {
    readonly requests: { resourceType: string; local: boolean; appFrame: boolean }[];
    readonly stop: () => Promise<void>;
  }
>();

function accessibilityOutputPath(): { absolutePath: string; repoRelativePath: string } {
  if (!accessibilityOutput || isAbsolute(accessibilityOutput)) {
    throw new Error("MOSS_PLUGIN_A11Y_OUTPUT must be a repository-relative evidence path.");
  }
  const evidenceRoot = resolve(repoRoot, ".moss/plugin-page-parity/evidence");
  const absolutePath = resolve(repoRoot, accessibilityOutput);
  if (absolutePath !== evidenceRoot && !absolutePath.startsWith(`${evidenceRoot}${sep}`)) {
    throw new Error("MOSS_PLUGIN_A11Y_OUTPUT must stay under Gate 5's evidence directory.");
  }
  if (!absolutePath.endsWith(".json")) {
    throw new Error("MOSS_PLUGIN_A11Y_OUTPUT must name a JSON report.");
  }
  return {
    absolutePath,
    repoRelativePath: relative(repoRoot, absolutePath).split(sep).join("/"),
  };
}

export const browserViteConfig = {
  ...viteConfig,
  plugins: withoutVitePlugin(viteConfig.plugins ?? [], reactCompilerPlugin),
};

export default mergeConfig(
  browserViteConfig,
  defineConfig({
    ...(browserCacheDir ? { cacheDir: browserCacheDir } : {}),
    server: { watch: { ignored: ["**/.vitest-attachments/**", "**/__screenshots__/**"] } },
    // Prebundle direct hook dependencies so restored caches cannot reload tests mid-run.
    optimizeDeps: { include: ["react-dom/client", "zustand/vanilla", "zustand/vanilla/shallow"] },
    define: {
      MOSS_PLUGIN_A11Y_WRITE_ENABLED: JSON.stringify(accessibilityWriteEnabled),
      MOSS_PLUGIN_A11Y_PROGRAM: JSON.stringify(
        process.env.MOSS_PLUGIN_A11Y_PROGRAM ?? "moss-plugin-page-codex-perfect-parity",
      ),
      MOSS_PLUGIN_A11Y_COMMIT: JSON.stringify(process.env.MOSS_PLUGIN_A11Y_COMMIT ?? ""),
      MOSS_PLUGIN_A11Y_ARTIFACT_SHA256: JSON.stringify(
        process.env.MOSS_PLUGIN_A11Y_ARTIFACT_SHA256 ?? "",
      ),
      MOSS_PLUGIN_A11Y_CAPTURE_SHA256: JSON.stringify(
        process.env.MOSS_PLUGIN_A11Y_CAPTURE_SHA256 ?? "",
      ),
      MOSS_PLUGIN_A11Y_CREATED_AT: JSON.stringify(process.env.MOSS_PLUGIN_A11Y_CREATED_AT ?? ""),
    },
    resolve: {
      alias: {
        "~": srcPath,
      },
    },
    test: {
      setupFiles: ["src/test/browserLocaleSetup.ts", "src/test/browserSettingsDialogReset.ts"],
      include: [
        "src/components/**/*.browser.tsx",
        "src/hooks/**/*.browser.ts",
        "src/hooks/**/*.browser.tsx",
        "src/lib/**/*.browser.ts",
        "src/lib/**/*.browser.tsx",
        "src/whatsNew/**/*.browser.tsx",
      ],
      // Browser component tests share page-level mock infrastructure; run files serially
      // so one spec cannot steal another spec's WebSocket/native-API events.
      fileParallelism: false,
      maxWorkers: 1,
      browser: {
        enabled: true,
        provider: playwright({
          contextOptions: { locale: "en-US" },
          launchOptions: chromiumExecutablePath
            ? { executablePath: chromiumExecutablePath }
            : undefined,
        }),
        instances: [{ browser: "chromium" }],
        headless: true,
        commands: {
          async beginAppThumbnailRequestProbe(
            context,
            appTitle = "Coral tracker",
            readonlyHost = false,
          ) {
            await appThumbnailProbes.get(context.page)?.stop();
            const requests: { resourceType: string; local: boolean; appFrame: boolean }[] = [];
            const intercept = async (route: import("playwright").Route) => {
              const request = route.request();
              const requestUrl = new URL(request.url());
              const local = ["localhost", "127.0.0.1", "[::1]"].includes(requestUrl.hostname);
              // Vitest can also use blob frames; identify the actual app fixture.
              const frameElement = await request
                .frame()
                .frameElement()
                .catch(() => null);
              const appFrame = (await frameElement?.getAttribute("title")) === appTitle;
              await frameElement?.dispose();
              if (
                readonlyHost &&
                appFrame &&
                local &&
                request.resourceType() === "document" &&
                requestUrl.pathname === "/space-app-preview.html"
              ) {
                await route.continue();
                return;
              }
              if (appFrame || !local) {
                requests.push({ resourceType: request.resourceType(), local, appFrame });
                await route.abort();
              } else await route.continue();
            };
            await context.page.route("**/*", intercept);
            appThumbnailProbes.set(context.page, {
              requests,
              stop: () => context.page.unroute("**/*", intercept),
            });
          },
          async endAppThumbnailRequestProbe(context) {
            const probe = appThumbnailProbes.get(context.page);
            if (!probe) return [];
            await probe.stop();
            appThumbnailProbes.delete(context.page);
            return probe.requests;
          },
          async writeAppThumbnailEvidence(context, thumbnail: string) {
            if (
              thumbnail.length > 200_023 ||
              !/^data:image\/jpeg;base64,[A-Za-z0-9+/]+={0,2}$/u.test(thumbnail)
            )
              throw new Error("Invalid thumbnail evidence");
            const target = resolve(
              repoRoot,
              "apps/web/node_modules/.cache/page-app-thumbnail-rendered.jpg",
            );
            mkdirSync(dirname(target), { recursive: true });
            writeFileSync(target, Buffer.from(thumbnail.slice(23), "base64"));
            for (const frame of context.page.frames()) {
              const element = await frame.frameElement().catch(() => null);
              const matches = (await element?.getAttribute("title")) === "Coral tracker";
              await element?.dispose();
              if (!matches) continue;
              const metrics = await frame.evaluate(() => ({
                viewport: [innerWidth, innerHeight],
                body: [
                  document.body.clientWidth,
                  document.body.clientHeight,
                  document.body.scrollHeight,
                ],
                background: getComputedStyle(document.body).backgroundColor,
                text: document.body.innerText.slice(0, 80),
              }));
              await frame.locator("body").screenshot({
                path: resolve(
                  repoRoot,
                  "apps/web/node_modules/.cache/page-app-thumbnail-source.png",
                ),
              });
              return metrics;
            }
            throw new Error("App fixture is not mounted");
          },
          async prepareAppLibraryFixture(_context, html: string) {
            if (html.length > 2_000_000) throw new Error("App fixture is too large");
            return preparePageAppLibraries(html, undefined, async (name) => ({
              contents: readFileSync(
                resolve(repoRoot, "apps/web/public/inline-visualization-libs", name),
              ),
              contentType: "text/javascript",
            }));
          },
          async writeReadonlyAppItemEvidence(context) {
            const frame = await context.frame();
            const target = frame.locator("[data-app-item]");
            const bounds = await target.boundingBox();
            if (!bounds || bounds.width < 790 || bounds.height < 400)
              throw new Error(`Readonly preview fixture is clipped: ${JSON.stringify(bounds)}`);
            const output = resolve(
              repoRoot,
              "apps/web/node_modules/.cache/readonly-app-item-owner.png",
            );
            mkdirSync(dirname(output), { recursive: true });
            await target.screenshot({ path: output });
            return { width: bounds.width, height: bounds.height };
          },
          async beginPointerPickup(context, sourceSelector: string, activationOffsetPx = 10) {
            const frame = await context.frame();
            const sourceBox = await frame.locator(sourceSelector).boundingBox();
            if (!sourceBox) {
              throw new Error("Pointer pickup source must be visible.");
            }
            const source = {
              x: sourceBox.x + sourceBox.width / 2,
              y: sourceBox.y + sourceBox.height / 2,
            };
            await context.page.mouse.move(source.x, source.y);
            await context.page.mouse.down();
            await context.page.mouse.move(source.x + activationOffsetPx, source.y, { steps: 2 });
            return { source, activationOffsetPx };
          },
          async releasePointer(context) {
            await context.page.mouse.up();
          },
          async pressKeyboardKey(context, key: string) {
            await context.page.keyboard.press(key);
          },
          async emulateReducedMotion(context, reducedMotion: "reduce" | "no-preference") {
            await context.page.emulateMedia({ reducedMotion });
          },
          async dragPointerSequence(
            context,
            sourceSelector: string,
            targetSelector: string,
            steps = 12,
          ) {
            const frame = await context.frame();
            const sourceBox = await frame.locator(sourceSelector).boundingBox();
            const targetBox = await frame.locator(targetSelector).boundingBox();
            if (!sourceBox || !targetBox) {
              throw new Error("Pointer drag source and target must both be visible.");
            }
            const source = {
              x: sourceBox.x + sourceBox.width / 2,
              y: sourceBox.y + sourceBox.height / 2,
            };
            const target = {
              x: targetBox.x + targetBox.width / 2,
              y: targetBox.y + targetBox.height / 2,
            };
            await context.page.mouse.move(source.x, source.y);
            await context.page.mouse.down();
            await context.page.mouse.move(target.x, target.y, { steps });
            await context.page.mouse.up();
            return { source, target, steps };
          },
          async dragPointerToViewportEdgeAndHold(
            context,
            sourceSelector: string,
            scrollContainerSelector: string,
            holdMs = 700,
          ) {
            const frame = await context.frame();
            const sourceBox = await frame.locator(sourceSelector).boundingBox();
            const scrollContainerBox = await frame.locator(scrollContainerSelector).boundingBox();
            if (!sourceBox || !scrollContainerBox) {
              throw new Error("Pointer pickup source and scroll container must be visible.");
            }
            const source = {
              x: sourceBox.x + sourceBox.width / 2,
              y: sourceBox.y + sourceBox.height / 2,
            };
            const edge = {
              // Keep the pointer over the exact scroll viewport. The vertical
              // edge is what drives auto-scroll; moving below it lands in the
              // sidebar footer and cannot drive this ancestor.
              x: scrollContainerBox.x + scrollContainerBox.width / 2,
              y: scrollContainerBox.y + scrollContainerBox.height - 2,
            };
            await context.page.mouse.move(source.x, source.y);
            await context.page.mouse.down();
            await context.page.mouse.move(edge.x, edge.y, { steps: 8 });
            await new Promise((resolve) => setTimeout(resolve, holdMs));
            return { source, edge, holdMs };
          },
          async moveHeldPointerTo(context, targetSelector: string) {
            const frame = await context.frame();
            const targetBox = await frame.locator(targetSelector).boundingBox();
            if (!targetBox) {
              throw new Error("Held pointer target must be visible.");
            }
            const target = {
              x: targetBox.x + targetBox.width / 2,
              y: targetBox.y + targetBox.height / 2,
            };
            await context.page.mouse.move(target.x, target.y, { steps: 8 });
            return { target };
          },
          writeMossPluginAccessibilityEvidence(_context, json: string) {
            if (!accessibilityWriteEnabled) {
              throw new Error("Gate 5 evidence writing is disabled for this browser run.");
            }
            if (typeof json !== "string" || json.length === 0 || json.length > 5_000_000) {
              throw new Error("Gate 5 evidence must be a non-empty JSON string under 5 MB.");
            }
            JSON.parse(json);
            const { absolutePath, repoRelativePath } = accessibilityOutputPath();
            mkdirSync(dirname(absolutePath), { recursive: true });
            const temporaryPath = `${absolutePath}.tmp-${process.pid}`;
            writeFileSync(temporaryPath, json, { encoding: "utf8", mode: 0o600 });
            renameSync(temporaryPath, absolutePath);
            return {
              path: repoRelativePath,
              sha256: createHash("sha256").update(json).digest("hex"),
            };
          },
        },
        api: {
          // Vitest's default 63315 falls inside common Windows/Hyper-V
          // excluded-port ranges. Keep the local browser harness on IPv4 and
          // allow CI or developers to override the fallback port.
          host: process.env.VITEST_BROWSER_API_HOST ?? "127.0.0.1",
          port: Number(process.env.VITEST_BROWSER_API_PORT ?? 51_100),
        },
      },
      // The full desktop route graph can take more than 30 seconds to compile
      // on a cold Windows cache before an individual browser test can proceed.
      testTimeout: 90_000,
      hookTimeout: 90_000,
    },
  }),
);
