// Origin: Ported from apps/server/src/htmlRender/HtmlRender.test.ts in T3 Code
//   (https://github.com/pingdotgg/t3code, MIT) at ba0ea3d152150f399827d36a5b4b86c5bbda2d7f.
//   The headless-browser cases are covered by the local preview-browser contract.
import { fileURLToPath } from "node:url";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import { ThreadId } from "@synara/contracts";
import { Effect, FileSystem, Layer, Path } from "effect";

import { resolveAttachmentRelativePath } from "../attachmentPaths.ts";
import { parseThreadSegmentFromAttachmentId } from "../attachmentStore.ts";
import { ServerConfig } from "../config.ts";
import {
  HtmlRender,
  HtmlRenderImagesNotFoundError,
  HtmlRenderImageTooLargeError,
  HtmlRenderLive,
  HtmlRenderViewportHeightError,
  chromeForTestingHeadlessShellUrl,
  dedicatedHeadlessShellExecutable,
  HTML_PREVIEW_BROWSER_INSTALL_PROGRESS_MESSAGE,
  installDedicatedHeadlessShell,
  makeSharedPreviewBrowserInstaller,
  playwrightHeadlessShellManifestEntry,
  resolveBundledPlaywrightPaths,
} from "./HtmlRender.ts";

const layerTest = HtmlRenderLive.pipe(
  Layer.provideMerge(ServerConfig.layerTest(process.cwd(), { prefix: "moss-html-render-" })),
  Layer.provideMerge(NodeServices.layer),
);

const PNG_BYTES = new Uint8Array([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
const base64 = (data: Uint8Array | string) => Buffer.from(data).toString("base64");

// A committed image outside any temporary workspace, inside this repository's git root.
const REPOSITORY_IMAGE = fileURLToPath(
  new URL("../../../web/public/favicon-16x16.png", import.meta.url),
);

describe("HtmlRender", () => {
  it("resolves the shipped Playwright browser manifest through the runtime", () => {
    const paths = resolveBundledPlaywrightPaths((specifier) => {
      if (specifier === "playwright/package.json") {
        return join("/opt/Moss/resources/server/node_modules/playwright", "package.json");
      }
      throw new Error(`Unexpected Playwright dependency: ${specifier}`);
    });

    expect(paths).toEqual({
      browsersManifestPath: join(
        "/opt/Moss/resources/server/node_modules/playwright-core",
        "browsers.json",
      ),
    });
  });

  it("pins one Chrome Headless Shell archive rather than Playwright's ffmpeg bundle", () => {
    expect(
      playwrightHeadlessShellManifestEntry(
        JSON.stringify({
          browsers: [
            { name: "chromium", revision: "1234", browserVersion: "151.0.0.0" },
            { name: "chromium-headless-shell", revision: "1234", browserVersion: "151.0.0.0" },
            { name: "ffmpeg", revision: "1011" },
          ],
        }),
      ),
    ).toEqual({ revision: "1234", browserVersion: "151.0.0.0" });
    expect(chromeForTestingHeadlessShellUrl("151.0.0.0", "linux", "x64")).toBe(
      "https://storage.googleapis.com/chrome-for-testing-public/151.0.0.0/linux64/chrome-headless-shell-linux64.zip",
    );
    expect(() => chromeForTestingHeadlessShellUrl("151.0.0.0", "linux", "arm64")).toThrow(
      "not available for linux/arm64",
    );
  });

  it("locates only the dedicated Chromium headless shell", () => {
    const browserDirectory = "/moss-data/tools/html-preview-browser";
    const executable = join(
      browserDirectory,
      "chromium_headless_shell-1234",
      "chrome-headless-shell-linux64",
      "chrome-headless-shell",
    );
    expect(
      dedicatedHeadlessShellExecutable(
        browserDirectory,
        () => ["chromium-1234", "chromium_headless_shell-1234", "ffmpeg-1011"],
        (candidate) => candidate === executable,
      ),
    ).toBe(executable);
    expect(
      dedicatedHeadlessShellExecutable(
        browserDirectory,
        () => ["chromium-1234"],
        () => true,
      ),
    ).toBeUndefined();
  });

  it("downloads and extracts only the headless-shell archive through injectable boundaries", async () => {
    const browserDirectory = await mkdtemp(join(tmpdir(), "moss-headless-shell-test-"));
    const downloadedUrls: string[] = [];
    const extracted: Array<{ archivePath: string; targetDirectory: string }> = [];
    try {
      await installDedicatedHeadlessShell({
        browserDirectory,
        revision: "1234",
        browserVersion: "151.0.0.0",
        fetchImpl: Object.assign(
          async (url: string | URL | Request) => {
            downloadedUrls.push(String(url));
            return new Response("headless-shell-archive");
          },
          { preconnect: () => {} },
        ),
        extract: async (input) => {
          extracted.push(input);
          expect(await readFile(input.archivePath, "utf8")).toBe("headless-shell-archive");
        },
      });
      expect(downloadedUrls).toEqual([chromeForTestingHeadlessShellUrl("151.0.0.0")]);
      expect(extracted).toEqual([
        {
          archivePath: join(browserDirectory, "chrome-headless-shell.zip"),
          targetDirectory: join(browserDirectory, "chromium_headless_shell-1234"),
        },
      ]);
      expect(existsSync(join(browserDirectory, "chrome-headless-shell.zip"))).toBe(false);
    } finally {
      await rm(browserDirectory, { recursive: true, force: true });
    }
  });

  it("shares a bounded headless-browser install between concurrent previews", async () => {
    let installs = 0;
    let releaseInstall: (() => void) | undefined;
    const installer = makeSharedPreviewBrowserInstaller({
      install: () =>
        new Promise<void>((resolve) => {
          installs += 1;
          releaseInstall = resolve;
        }),
      timeoutMs: 1_000,
    });

    const first = installer.waitForInstall();
    const second = installer.waitForInstall();
    expect(installs).toBe(1);
    releaseInstall?.();
    await expect(Promise.all([first, second])).resolves.toEqual([undefined, undefined]);
  });

  it("reports bounded install progress while keeping the shared download alive", async () => {
    let releaseInstall: (() => void) | undefined;
    const installer = makeSharedPreviewBrowserInstaller({
      install: () =>
        new Promise<void>((resolve) => {
          releaseInstall = resolve;
        }),
      timeoutMs: 5,
    });

    await expect(installer.waitForInstall()).rejects.toThrow(
      HTML_PREVIEW_BROWSER_INSTALL_PROGRESS_MESSAGE,
    );
    releaseInstall?.();
    await expect(installer.waitForInstall()).resolves.toBeUndefined();
  });

  it.effect("inlines local images by absolute path and leaves URLs and relative paths alone", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "moss-html-images-" });
      const png = path.join(directory, "shot.png");
      const svg = path.join(directory, "logo.svg");
      yield* fileSystem.writeFile(png, PNG_BYTES);
      yield* fileSystem.writeFileString(svg, "<svg/>");
      const kept = [
        "https://example.com/a.png",
        "//cdn.example.com/b.png",
        "./c.png",
        "data:image/png;base64,AAAA",
      ];

      const prepared = yield* htmlRender.prepare(
        [
          "<!doctype html><html><head><title>Shots</title></head><body>",
          `<img src="${png}"><div style="background:url(${svg})"></div>`,
          `<script>const shots = ['${png}', \`${svg}\`];</script>`,
          ...kept.map((src) => `<img src="${src}">`),
          "</body></html>",
        ].join(""),
        directory,
      );

      const pngUri = `data:image/png;base64,${base64(PNG_BYTES)}`;
      const svgUri = `data:image/svg+xml;base64,${base64("<svg/>")}`;
      expect(prepared).toContain(`<img src="${pngUri}">`);
      expect(prepared).toContain(`url(${svgUri})`);
      expect(prepared).toContain(`['${pngUri}', \`${svgUri}\`]`);
      expect(prepared).not.toContain(directory);
      for (const src of kept) expect(prepared).toContain(`<img src="${src}">`);
      // The theme bootstrap opens the head, ahead of the page's own markup.
      expect(prepared.indexOf("<head>")).toBeLessThan(prepared.indexOf('<style id="moss-theme">'));
      expect(prepared.indexOf('<style id="moss-theme">')).toBeLessThan(prepared.indexOf("<title>"));
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("rejects viewport height units, which make the fitted frame grow without end", () =>
    Effect.gen(function* () {
      const htmlRender = yield* HtmlRender;
      for (const page of [
        "<style>main{min-height:100vh}</style>",
        "<style media=screen>main{height: calc(100dvh - 2rem)}",
        "<div style='top:.5svh'></div>",
        "<div style=height:100vh></div>",
      ]) {
        const error = yield* htmlRender.prepare(page, null).pipe(Effect.flip);
        expect(error).toBeInstanceOf(HtmlRenderViewportHeightError);
        const previewError = yield* htmlRender.preview({ html: page }).pipe(Effect.flip);
        expect(previewError).toBeInstanceOf(HtmlRenderViewportHeightError);
      }
      yield* htmlRender.prepare(
        '<style>main{width:100vw;height:320px}</style><img src="data:image/png;base64,AB1vh+2vh/3vhC">',
        null,
      );
      yield* htmlRender.prepare(
        "<p>Avoid 100vh here.</p><!-- <div style=\"height:100vh\"></div> --><script>const unit = '100vh';</script>",
        null,
      );
      yield* htmlRender.prepare(`<style>${"1".repeat(200_000)}vx</style>`, null);
    }).pipe(Effect.provide(layerTest)),
  );

  it.effect("inlines an SVG behind processing instructions and a doctype subset", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "moss-html-images-" });
      const svg = path.join(directory, "styled.svg");
      const source = [
        '<?xml version="1.0"?>',
        '<?xml-stylesheet href="theme.css"?>',
        '<!DOCTYPE svg [ <!ENTITY fill "red"> ]>',
        '<svg xmlns="http://www.w3.org/2000/svg" width="32" height="32"/>',
      ].join("\n");
      yield* fileSystem.writeFileString(svg, source);

      const prepared = yield* htmlRender.prepare(`<img src="${svg}">`, directory);

      expect(prepared).toContain(`data:image/svg+xml;base64,${base64(source)}`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("lists every local image it cannot read", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "moss-html-images-" });
      const folder = path.join(directory, "folder.png");
      yield* fileSystem.makeDirectory(folder);
      const missing = path.join(directory, "missing.jpg");
      // Named like an image, but a symlink or renamed file must not carry other data.
      const secret = path.join(directory, "secret.png");
      yield* fileSystem.writeFileString(secret, "API_KEY=abc123");
      const report = path.join(directory, "report.svg");
      yield* fileSystem.writeFileString(report, "<!doctype html><body><svg></svg>API_KEY=abc123");
      // An <svg> inside a quoted entity, and a prolog shaped to stall a backtracking matcher.
      const config = path.join(directory, "config.svg");
      yield* fileSystem.writeFileString(
        config,
        '<!DOCTYPE config [<!ENTITY a "a"><!ENTITY b "]><svg/>">]><config>API_KEY=abc123</config>',
      );
      const stalling = path.join(directory, "stalling.svg");
      yield* fileSystem.writeFileString(stalling, `${"<?p?>".repeat(40)}<config><svg/></config>`);
      const unclosed = path.join(directory, "unclosed.svg");
      yield* fileSystem.writeFileString(unclosed, '<!DOCTYPE svg [<!ENTITY a "x><svg/>');
      // Roots named SVG or svgé are other elements.
      const upper = path.join(directory, "upper.svg");
      yield* fileSystem.writeFileString(upper, "<SVG/>API_KEY=abc123");
      const longer = path.join(directory, "longer.svg");
      yield* fileSystem.writeFileString(longer, "<svg\u00e9/>API_KEY=abc123");

      const error = yield* htmlRender
        .prepare(
          `<img src="${missing}"><img src='${folder}'><img src="C:\\nope\\shot.webp"><img src="${secret}"><img src="${report}"><img src="${config}"><img src="${stalling}"><img src="${unclosed}"><img src="${upper}"><img src="${longer}">`,
          directory,
        )
        .pipe(Effect.flip);

      expect(error).toBeInstanceOf(HtmlRenderImagesNotFoundError);
      expect(error._tag === "HtmlRenderImagesNotFoundError" && error.paths).toEqual([
        missing,
        folder,
        "C:\\nope\\shot.webp",
        secret,
        report,
        config,
        stalling,
        unclosed,
        upper,
        longer,
      ]);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("inlines an absolute local image outside the thread workspace", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const page = `<img src="${REPOSITORY_IMAGE}">`;
      const repositoryBytes = yield* fileSystem.readFile(REPOSITORY_IMAGE);
      const prepared = yield* htmlRender.prepare(page, path.dirname(REPOSITORY_IMAGE));
      expect(prepared).toContain(`data:image/png;base64,${base64(repositoryBytes)}`);
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("refuses an image over the per-image limit before reading it", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const htmlRender = yield* HtmlRender;
      const directory = yield* fileSystem.makeTempDirectoryScoped({ prefix: "moss-html-images-" });
      const huge = path.join(directory, "huge.png");
      yield* fileSystem.writeFile(huge, new Uint8Array(10 * 1024 * 1024 + 1));

      const error = yield* htmlRender.prepare(`<img src="${huge}">`, directory).pipe(Effect.flip);

      expect(error).toBeInstanceOf(HtmlRenderImageTooLargeError);
      expect(error.message).toContain("at most 10.0 MiB");
    }).pipe(Effect.scoped, Effect.provide(layerTest)),
  );

  it.effect("publishes the prepared page as an html thread attachment", () =>
    Effect.gen(function* () {
      const fileSystem = yield* FileSystem.FileSystem;
      const config = yield* ServerConfig;
      const htmlRender = yield* HtmlRender;

      const reference = yield* htmlRender.publish({
        threadId: ThreadId.makeUnsafe("thread-html-render"),
        cwd: null,
        html: "<p>Quarterly revenue</p>",
        title: "  Revenue  ",
        height: 9_000,
      });

      // This isolated service fixture has no dedicated preview browser, so
      // measurement remains opportunistic and publishing still succeeds.
      expect(reference).toEqual({
        attachmentId: expect.any(String),
        title: "Revenue",
        height: 2_000,
      });
      expect(parseThreadSegmentFromAttachmentId(reference.attachmentId)).toBe("thread-html-render");
      const stored = resolveAttachmentRelativePath({
        attachmentsDir: config.attachmentsDir,
        relativePath: `${reference.attachmentId}.html`,
      });
      const html = yield* fileSystem.readFileString(stored ?? "");
      expect(html).toContain('<style id="moss-theme">');
      expect(html).toContain("<p>Quarterly revenue</p>");
    }).pipe(Effect.provide(layerTest)),
  );
});
