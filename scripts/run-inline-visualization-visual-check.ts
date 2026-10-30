// FILE: run-inline-visualization-visual-check.ts
// Purpose: Exercise inline visualizations end-to-end in an isolated Moss home and save review evidence.
// Layer: Developer-only browser verification

import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, mkdir, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { chromium, type BrowserContext, type Locator, type Page } from "playwright";

const repoRoot = path.resolve(import.meta.dir, "..");
const outputArgument = "--output-dir";
const T3_VISUAL_REPLY_CSP = "sandbox allow-scripts allow-forms allow-popups";
const WORKED_THREAD_ID = "inline-visualization-worked-fixture";
const WORKED_ATTACHMENT_ID = "inline-visualization-worked-00000000-0000-4000-8000-000000000001";

type CheckResult = {
  readonly passed: boolean;
  readonly outputDir: string;
  readonly isolatedHome: string;
  readonly blockedRequests: readonly string[];
  readonly frameCsp: string | null;
  readonly assertions: Record<string, boolean>;
  readonly screenshots: readonly string[];
  error?: string;
};

function outputDirFromArgs() {
  const index = process.argv.indexOf(outputArgument);
  const value = index === -1 ? undefined : process.argv[index + 1];
  if (!value || value.startsWith("-")) {
    throw new Error(
      `Usage: bun scripts/run-inline-visualization-visual-check.ts ${outputArgument} <directory>`,
    );
  }
  return path.resolve(value);
}

async function availablePort() {
  const probe = Bun.serve({
    port: 0,
    fetch() {
      return new Response("port probe");
    },
  });
  const port = probe.port;
  await probe.stop(true);
  return port;
}

type StartedProcess = {
  readonly process: Bun.Subprocess;
  readonly log: Promise<void>;
};

function startProcess(input: {
  readonly command: readonly string[];
  readonly environment: NodeJS.ProcessEnv;
  readonly logPath: string;
  readonly cwd?: string;
}): StartedProcess {
  const process = Bun.spawn([...input.command], {
    cwd: input.cwd ?? repoRoot,
    env: input.environment,
    stdout: "pipe",
    stderr: "pipe",
  });
  const log = Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
  ]).then(async ([stdout, stderr]) => {
    await Bun.write(input.logPath, `${stdout}${stderr}`);
  });
  return { process, log };
}

async function stopProcess(started: StartedProcess | undefined) {
  if (!started || started.process.exitCode !== null) return;
  started.process.kill("SIGTERM");
  await Promise.race([
    started.process.exited,
    new Promise((resolve) => setTimeout(resolve, 5_000)),
  ]);
  if (started.process.exitCode === null) {
    started.process.kill("SIGKILL");
    await started.process.exited;
  }
  await started.log;
}

async function waitForHealthyServer(origin: string, process: Bun.Subprocess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Verification server exited with code ${String(process.exitCode)}.`);
    }
    try {
      const response = await fetch(`${origin}/health`);
      if (response.ok) return;
    } catch {
      // The server is still booting its local database.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the verification server health endpoint.");
}

async function waitForWebApp(origin: string, process: Bun.Subprocess) {
  const deadline = Date.now() + 30_000;
  while (Date.now() < deadline) {
    if (process.exitCode !== null) {
      throw new Error(`Verification web server exited with code ${String(process.exitCode)}.`);
    }
    try {
      const response = await fetch(origin);
      if (response.ok) return;
    } catch {
      // Vite is still compiling its dependency graph.
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
  throw new Error("Timed out waiting for the verification web app.");
}

function browserExecutable() {
  const configured = process.env.PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH;
  if (configured && existsSync(configured)) return configured;
  if (existsSync("/usr/bin/google-chrome")) return "/usr/bin/google-chrome";
  throw new Error(
    "Chromium was not found. Set PLAYWRIGHT_CHROMIUM_EXECUTABLE_PATH to the installed browser binary.",
  );
}

async function dismissImportProjectsDialog(page: Page) {
  const notNow = page.getByText("暂不设置", { exact: true });
  try {
    await notNow.waitFor({ state: "visible", timeout: 3_000 });
    await notNow.click();
  } catch {
    // Newer fixture state can omit this unrelated first-run dialog.
  }
}

async function acknowledgeStartupAnnouncements(context: BrowserContext, installationKey: string) {
  await context.addInitScript(
    ({ featureTourKey, importAnnouncementKey, value }) => {
      // These markers are exactly what the app writes after a person has
      // dismissed its unrelated first-run announcements. They keep the
      // isolated visual fixture focused on the transcript surface under test.
      localStorage.setItem(featureTourKey, value);
      localStorage.setItem(importAnnouncementKey, value);
    },
    {
      featureTourKey: "moss:feature-tour:since-0.9.2:v1",
      importAnnouncementKey: "moss:project-import-announcement:v1",
      value: JSON.stringify([installationKey]),
    },
  );
}

async function hideUnrelatedScreenshotChrome(page: Page) {
  // The fixture asserts the real transcript before this runs. These are only
  // non-transcript overlays (composer, menus, and toasts) that can overlap a
  // cropped element screenshot while the virtualized list scrolls.
  await page.addStyleTag({
    content: `
      [data-chat-composer-slot],
      [data-chat-composer-form],
      [data-slot="toast-viewport"],
      [data-slot="toast-viewport-anchored"],
      [data-radix-popper-content-wrapper],
      [data-floating-ui-portal],
      [data-slot="tooltip-popup"],
      [data-slot="tooltip-positioner"],
      /* Provider inventory is intentionally unavailable in the isolated
         fixture. It is unrelated to the transcript evidence. */
      [data-slot="alert"],
      [role="menu"],
      [role="listbox"] {
        visibility: hidden !important;
      }
      [data-chat-scroll-container] {
        animation: none !important;
        mask-image: none !important;
        -webkit-mask-image: none !important;
      }
    `,
  });
  await page.keyboard.press("Escape");
}

async function setThemeMode(page: Page, mode: "light" | "dark") {
  // parseStoredThemeState intentionally accepts these compact persisted forms.
  // A reload gives the app and every mounted iframe the same normal startup
  // route a reader uses, including the HTML-render postMessage theme update.
  await page.evaluate((nextMode) => localStorage.setItem("moss:theme", nextMode), mode);
  await page.reload({ waitUntil: "domcontentloaded" });
  await dismissImportProjectsDialog(page);
}

async function assertNoVisibleTooltip(page: Page) {
  const visible = await page.locator('[data-slot="tooltip-popup"]').evaluateAll((popups) =>
    popups
      .filter((popup) => {
        const style = getComputedStyle(popup);
        return style.display !== "none" && style.visibility !== "hidden" && style.opacity !== "0";
      })
      .map((popup) => popup.textContent ?? ""),
  );
  assert.equal(visible.length, 0);
}

async function revealOpenInPanelButton(page: Page, card: Locator) {
  await card.scrollIntoViewIfNeeded();
  const box = await card.boundingBox();
  assert(box && box.width > 0 && box.height > 0);
  // Hover the outer one-pixel frame rather than its iframe child. Pointer
  // events inside an iframe do not satisfy the outer React/Tailwind group
  // hover in Chromium, while its own border exposes the control without
  // aiming at it (and thus without opening a tooltip).
  await page.mouse.move(box.x + box.width / 2, box.y + 0.5);
  await page.waitForTimeout(250);
  const openInPanel = card.getByRole("button", { name: "Open in panel" });
  await openInPanel.waitFor({ state: "visible" });
  const controlOpacity = await openInPanel.evaluate(
    (button) => getComputedStyle(button.parentElement ?? button).opacity,
  );
  assert(Number(controlOpacity) >= 0.99, `Open in panel opacity was ${controlOpacity}.`);
  await assertNoVisibleTooltip(page);
}

async function selectFixtureThread(
  page: Page,
  webOrigin: string,
  threadId = "inline-visualization-fixture",
) {
  // This is the real client route Moss uses after sidebar selection. Navigating
  // to it avoids a first-run prompt racing the click target while preserving
  // the actual WebSocket snapshot and transcript components. The fixture is
  // seeded with this stable Moss thread id before the app starts.
  await page.goto(`${webOrigin}/${threadId}`, { waitUntil: "domcontentloaded" });
  await dismissImportProjectsDialog(page);
}

async function runBrowserAssertions(input: {
  readonly webOrigin: string;
  readonly outputDir: string;
  readonly installationKey: string;
  readonly blockedRequests: string[];
}): Promise<Pick<CheckResult, "assertions" | "screenshots" | "frameCsp">> {
  const browser = await chromium.launch({
    executablePath: browserExecutable(),
    headless: true,
    args: ["--disable-gpu", "--disable-dev-shm-usage"],
  });
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext({ viewport: { width: 1440, height: 1200 } });
    await acknowledgeStartupAnnouncements(context, input.installationKey);
    const frameCsp = { value: null as string | null };

    const page = await context.newPage();
    await page.goto(input.webOrigin, { waitUntil: "domcontentloaded" });
    await setThemeMode(page, "light");
    const nativeMessage = page.locator("[data-assistant-message-id='codex-d3']");
    const nativeCard = page.locator("[data-inline-visualization-state='ready']");
    let nativeCardReady = false;
    for (let attempt = 0; attempt < 2; attempt += 1) {
      await selectFixtureThread(page, input.webOrigin);
      try {
        await nativeCard.waitFor({ state: "visible", timeout: 30_000 });
        nativeCardReady = true;
        break;
      } catch (error) {
        if (attempt === 1) throw error;
        // A just-started WebSocket can finish its first snapshot after the
        // sidebar has rendered. Let the real app settle, then reselect the
        // fixture; do not fabricate transcript state in the browser.
        await page.waitForTimeout(1_000);
      }
    }
    assert(nativeCardReady);
    await nativeCard.scrollIntoViewIfNeeded();
    const nativeFrame = nativeCard.locator("iframe[title='D3 fixture']");
    await nativeFrame.waitFor({ state: "visible", timeout: 30_000 });
    const nativeSandbox = await nativeFrame.getAttribute("sandbox");
    assert.equal(nativeSandbox, "allow-scripts allow-forms");
    assert.equal(await nativeCard.getAttribute("data-inline-visualization-mode"), "wide");
    assert(!(await nativeMessage.innerText()).includes("visualize"));

    const d3Frame = page.frameLocator("iframe[title='D3 fixture']");
    await d3Frame.locator("svg rect").first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await d3Frame.locator("svg rect").count(), 5);
    const nativeSource = await nativeFrame.getAttribute("src");
    assert(nativeSource);
    frameCsp.value =
      (await page.request.get(nativeSource)).headers()["content-security-policy"] ?? null;
    assert.equal(frameCsp.value, T3_VISUAL_REPLY_CSP);
    await hideUnrelatedScreenshotChrome(page);

    await revealOpenInPanelButton(page, nativeCard);
    const codexScreenshot = path.join(input.outputDir, "codex-visualize-card.png");
    await nativeCard.screenshot({ path: codexScreenshot });

    const t3Frame = page.locator("iframe[title='T3 html_render fixture']");
    await t3Frame.waitFor({ state: "visible", timeout: 30_000 });
    await t3Frame.scrollIntoViewIfNeeded();
    const htmlRenderCard = page.locator(
      `[data-html-render-id='${"inline-visualization-fixture-00000000-0000-4000-8000-000000000001"}']`,
    );
    await htmlRenderCard.waitFor({ state: "visible", timeout: 30_000 });
    const t3Sandbox = await t3Frame.getAttribute("sandbox");
    assert.equal(t3Sandbox, "allow-scripts allow-forms");
    const t3Source = await t3Frame.getAttribute("src");
    assert(t3Source);
    const htmlRenderCsp = (await page.request.get(t3Source)).headers()["content-security-policy"];
    assert.equal(htmlRenderCsp, T3_VISUAL_REPLY_CSP);
    await revealOpenInPanelButton(page, htmlRenderCard);
    const lightBodyBackground = await page
      .frameLocator("iframe[title='T3 html_render fixture']")
      .locator("body")
      .evaluate((body) => getComputedStyle(body).backgroundColor);
    assert.equal(lightBodyBackground, "rgba(0, 0, 0, 0)");
    const t3Screenshot = path.join(input.outputDir, "inline-card-light.png");
    // Full-viewport captures retain the surrounding chat column, making the
    // theme relationship visible rather than comparing a page crop in a void.
    await page.screenshot({ path: t3Screenshot });

    await setThemeMode(page, "dark");
    await selectFixtureThread(page, input.webOrigin);
    await hideUnrelatedScreenshotChrome(page);
    const darkHtmlRenderCard = page.locator(
      `[data-html-render-id='${"inline-visualization-fixture-00000000-0000-4000-8000-000000000001"}']`,
    );
    await darkHtmlRenderCard.waitFor({ state: "visible", timeout: 30_000 });
    await revealOpenInPanelButton(page, darkHtmlRenderCard);
    const darkScreenshot = path.join(input.outputDir, "inline-card-dark.png");
    await page.screenshot({ path: darkScreenshot });
    assert.notDeepEqual(await readFile(t3Screenshot), await readFile(darkScreenshot));

    await darkHtmlRenderCard.getByRole("button", { name: "Open in panel" }).click();
    const previewHeader = page.locator("[data-html-render-preview-header]");
    await previewHeader.waitFor({ state: "visible", timeout: 10_000 });
    const panelFrame = previewHeader.locator("xpath=..").locator("iframe");
    await panelFrame.waitFor({ state: "visible", timeout: 10_000 });
    assert.equal(await panelFrame.getAttribute("sandbox"), "allow-scripts allow-forms");
    await page.mouse.move(720, 600);
    await page.waitForTimeout(100);
    await assertNoVisibleTooltip(page);
    const panelScreenshot = path.join(input.outputDir, "open-in-panel.png");
    await page.screenshot({ path: panelScreenshot });

    // This unrelated first-run prompt can be scheduled after the thread opens,
    // rather than synchronously with the click above.
    await dismissImportProjectsDialog(page);
    const fallbacks = page.locator("[data-inline-visualization-state='unavailable']");
    await fallbacks.first().waitFor({ state: "visible", timeout: 30_000 });
    assert.equal(await fallbacks.count(), 2);
    const fallbackSources: string[] = [];
    const fallbackScreenshots: string[] = [];
    const fallbackFixtures = [
      {
        messageId: "oversized-codex-marker",
        expectedSource: "oversized-fixture.html",
        screenshot: "inline-viz-oversize-fallback.png",
      },
      {
        messageId: "missing-codex-marker",
        expectedSource: "missing-fixture.html",
        screenshot: "inline-viz-missing-fallback.png",
      },
    ] as const;
    for (const fixture of fallbackFixtures) {
      // Locate by the stable real message id rather than an index in the
      // virtualized list: a recycled DOM row must never swap evidence files.
      const message = page.locator(`[data-assistant-message-id='${fixture.messageId}']`);
      await message.scrollIntoViewIfNeeded();
      const fallback = message.locator("[data-inline-visualization-state='unavailable']");
      await fallback.waitFor({ state: "visible", timeout: 30_000 });
      await fallback.scrollIntoViewIfNeeded();
      const fallbackScreenshot = path.join(input.outputDir, fixture.screenshot);
      const showSource = fallback.locator("button").filter({ hasText: "Show source" });
      await showSource.waitFor({ state: "visible", timeout: 30_000 });
      // The unrelated first-run import prompt may animate in while the
      // transcript virtualizer scrolls. Source disclosure is deterministic
      // and scoped to this real fallback card, so keep the check independent
      // of that prompt, then close it before capturing the evidence.
      await showSource.click({ force: true });
      const source = fallback.locator("pre");
      await source.waitFor({ state: "visible" });
      // DisclosureRegion intentionally uses a 220ms shared expansion motion.
      // Wait for its rendered height so the PNG proves the source view, not
      // merely that the click toggled React state.
      await page.waitForTimeout(250);
      const sourceBox = await source.boundingBox();
      assert(sourceBox && sourceBox.height > 0);
      const sourceText = await source.innerText();
      assert(sourceText.includes(fixture.expectedSource));
      fallbackSources.push(sourceText);
      // Avoid Chromium's transformed-list-item screenshot hang while keeping
      // the real fallback card in context.
      const fallbackBox = await fallback.boundingBox();
      assert(fallbackBox && fallbackBox.width > 0 && fallbackBox.height > 0);
      await page.screenshot({
        path: fallbackScreenshot,
        clip: {
          x: fallbackBox.x,
          y: fallbackBox.y,
          width: fallbackBox.width,
          height: fallbackBox.height,
        },
        timeout: 10_000,
      });
      fallbackScreenshots.push(fallbackScreenshot);
    }
    assert(fallbackSources.some((source) => source.includes("oversized-fixture.html")));
    assert(fallbackSources.some((source) => source.includes("missing-fixture.html")));
    await dismissImportProjectsDialog(page);

    await selectFixtureThread(page, input.webOrigin, WORKED_THREAD_ID);
    await hideUnrelatedScreenshotChrome(page);
    const workedCard = page.locator(`[data-html-render-id='${WORKED_ATTACHMENT_ID}']`);
    await workedCard.waitFor({ state: "visible", timeout: 30_000 });
    await workedCard.scrollIntoViewIfNeeded();
    const workedFor = page.getByRole("button", { name: /Worked for|已工作/u }).first();
    if ((await workedFor.count()) === 0) {
      throw new Error(`Worked-for disclosure missing:\n${await page.locator("body").innerText()}`);
    }
    const workedCardBox = await workedCard.boundingBox();
    assert(workedCardBox);
    const workedForScreenshot = path.join(input.outputDir, "worked-for-collapsed.png");
    // A full viewport avoids clipping the localized `已工作 …` label at the
    // chat-column edge while preserving the page immediately below it.
    await page.screenshot({ path: workedForScreenshot });
    const undoBeforeScreenshot = path.join(input.outputDir, "undo-before.png");
    await page.screenshot({ path: undoBeforeScreenshot });
    await page.waitForTimeout(3_200);
    assert.notEqual(await workedCard.getAttribute("data-html-render-state"), "unavailable");

    // Use the visible control on the user message. ChatView confirms and then
    // dispatches `thread.checkpoint.revert` with scope `thread`; the fixture
    // therefore proves the real end-to-end undo path, not an artificial DB
    // state or a command injected behind the app.
    const workedRequest = page.getByText("Render the worked-for fixture.", { exact: true });
    await workedRequest.hover();
    // The fixture has an older, independently revertible request above this
    // one. The terminal control is therefore attached to the page-publishing
    // request, in either shipped locale.
    const revertButton = page
      .getByRole("button", { name: /Revert to this message|恢复到此消息/u })
      .last();
    await revertButton.waitFor({ state: "visible", timeout: 10_000 });
    await revertButton.click();
    const revertDialog = page.getByRole("alertdialog");
    await revertDialog.waitFor({ state: "visible", timeout: 10_000 });
    // The web fallback localizes its visible copy with the surrounding app;
    // its affirmative action is deliberately the final button in the compact
    // two-button confirmation footer.
    const confirmRevert = revertDialog.locator("button").last();
    await confirmRevert.waitFor({ state: "visible", timeout: 10_000 });
    await confirmRevert.click();
    await revertDialog.waitFor({ state: "hidden", timeout: 10_000 });
    await page
      .getByText("This earlier assistant reply must remain after the real revert.", {
        exact: true,
      })
      .waitFor({
        state: "visible",
        timeout: 30_000,
      });
    const removedWorkedCard = page.locator(`[data-html-render-id='${WORKED_ATTACHMENT_ID}']`);
    await removedWorkedCard.waitFor({ state: "detached", timeout: 30_000 });
    assert.equal(await page.locator("[data-html-render-id]").count(), 0);
    const undoAfterScreenshot = path.join(input.outputDir, "undo-after.png");
    await page.screenshot({ path: undoAfterScreenshot });

    return {
      assertions: {
        codexMarkerReplacedByCard: true,
        sharedT3SandboxRenderer: true,
        remoteResourcesNotBlockedByHarness: true,
        unavailableFallbacksRendered: true,
        oversizeFallbackSourceVisible: true,
        missingFallbackSourceVisible: true,
        sandboxWithoutSameOrigin: true,
        frameCspEqualsT3: true,
        iframeSandboxAttrsEqualT3: true,
        panelIframeSandboxAttrEqualsT3: true,
        openInPanelOpenedDock: true,
        htmlRenderFixtureUsesThemeBootstrap: true,
        htmlRenderBodyBackgroundTransparent: true,
        lightAndDarkEvidenceDiffer: true,
        workedForRowPresent: true,
        noUnavailableNoticeAfterSlowLoadWindow: true,
        realThreadRevertRemovedVisualReply: true,
        earlierMessagesRemainAfterThreadRevert: true,
      },
      screenshots: [
        codexScreenshot,
        t3Screenshot,
        darkScreenshot,
        panelScreenshot,
        workedForScreenshot,
        undoBeforeScreenshot,
        undoAfterScreenshot,
        ...fallbackScreenshots,
      ],
      frameCsp: frameCsp.value,
    };
  } finally {
    await context?.close();
    await browser.close();
  }
}

async function main() {
  const outputDir = outputDirFromArgs();
  await mkdir(outputDir, { recursive: true });
  const homeDir = await mkdtemp(path.join(os.tmpdir(), "moss-inline-visualization-check-"));
  const serverPort = await availablePort();
  const webPort = await availablePort();
  const serverOrigin = `http://127.0.0.1:${String(serverPort)}`;
  const webOrigin = `http://127.0.0.1:${String(webPort)}`;
  const baseEnvironment = { ...process.env };
  delete baseEnvironment.T3CODE_AUTH_TOKEN;
  let server: StartedProcess | undefined;
  let web: StartedProcess | undefined;
  const blockedRequests: string[] = [];
  const result: CheckResult = {
    passed: false,
    outputDir,
    isolatedHome: homeDir,
    blockedRequests,
    frameCsp: null,
    assertions: {},
    screenshots: [],
  };

  try {
    const serverEnvironment = {
      ...baseEnvironment,
      MOSS_HOME: homeDir,
      MOSS_HOST: "127.0.0.1",
      MOSS_PORT: String(serverPort),
      MOSS_NO_BROWSER: "1",
      MOSS_AUTO_BOOTSTRAP_PROJECT_FROM_CWD: "0",
      VITE_DEV_SERVER_URL: webOrigin,
    };
    server = startProcess({
      command: [process.execPath, "scripts/inlineVisualizationVerificationServer.ts"],
      environment: serverEnvironment,
      logPath: path.join(outputDir, "inline-viz-server.log"),
    });
    await waitForHealthyServer(serverOrigin, server.process);
    await stopProcess(server);
    server = undefined;

    const seed = Bun.spawn(
      [process.execPath, "scripts/seed-inline-visualization-fixture.ts", "--home-dir", homeDir],
      { cwd: repoRoot, env: serverEnvironment, stdout: "pipe", stderr: "pipe" },
    );
    const [seedStdout, seedStderr, seedExitCode] = await Promise.all([
      new Response(seed.stdout).text(),
      new Response(seed.stderr).text(),
      seed.exited,
    ]);
    await Bun.write(path.join(outputDir, "inline-viz-seed.log"), `${seedStdout}${seedStderr}`);
    assert.equal(seedExitCode, 0, seedStderr || seedStdout);

    server = startProcess({
      command: [process.execPath, "scripts/inlineVisualizationVerificationServer.ts"],
      environment: serverEnvironment,
      logPath: path.join(outputDir, "inline-viz-server.log"),
    });
    await waitForHealthyServer(serverOrigin, server.process);
    web = startProcess({
      command: [
        process.execPath,
        "node_modules/vite/bin/vite.js",
        "--host",
        "127.0.0.1",
        "--port",
        String(webPort),
      ],
      environment: {
        ...baseEnvironment,
        PORT: String(webPort),
        ELECTRON_RENDERER_PORT: String(webPort),
        VITE_WS_URL: `ws://127.0.0.1:${String(serverPort)}`,
      },
      logPath: path.join(outputDir, "inline-viz-web.log"),
      cwd: path.join(repoRoot, "apps/web"),
    });
    await waitForWebApp(webOrigin, web.process);

    // This scenario intentionally mutates one real thread at its final step.
    // Retrying a partially completed browser pass would open the same now-
    // reverted thread and turn valid undo evidence into a fake empty-state run.
    const browserResult = await runBrowserAssertions({
      webOrigin,
      outputDir,
      installationKey: path.join(homeDir, "worktrees"),
      blockedRequests,
    });
    Object.assign(result, browserResult, { passed: true });
  } catch (error) {
    result.error = error instanceof Error ? (error.stack ?? error.message) : String(error);
  } finally {
    await stopProcess(web);
    await stopProcess(server);
    await Bun.write(
      path.join(outputDir, "inline-viz-result.json"),
      `${JSON.stringify(result, null, 2)}\n`,
    );
    await rm(homeDir, { recursive: true, force: true });
  }

  if (!result.passed) {
    throw new Error(result.error ?? "Inline visualization visual check failed.");
  }
  process.stdout.write(`Inline visualization visual check passed. Evidence: ${outputDir}\n`);
}

void main();
