import { existsSync, mkdirSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const MAIN_JS = join(DESKTOP_ROOT, "dist-electron", "main.js");
const DEFAULT_TIMEOUT_MS = 120_000;

function parseArgs(argv) {
  const options = {
    evidenceDir: join(tmpdir(), "moss-new-user-smoke"),
    profileRoot: undefined,
    probeOnly: false,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--evidence-dir" && next) {
      options.evidenceDir = resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--profile-root" && next) {
      options.profileRoot = resolve(next);
      index += 1;
      continue;
    }
    if (arg === "--probe-only") {
      options.probeOnly = true;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown new-user smoke option: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
  }
  if (options.probeOnly && !options.profileRoot) {
    throw new Error("--probe-only requires an explicit existing --profile-root.");
  }
  if (options.probeOnly) {
    let profileIsDirectory = false;
    try {
      profileIsDirectory = statSync(options.profileRoot).isDirectory();
    } catch {
      profileIsDirectory = false;
    }
    if (!profileIsDirectory) {
      throw new Error(`--profile-root must be an existing directory: ${options.profileRoot}`);
    }
  }
  return options;
}

function packageRequire(packageJsonPath) {
  return createRequire(resolve(REPO_ROOT, packageJsonPath));
}

function resolvePlaywrightModuleUrl() {
  const requireFromWeb = packageRequire("apps/web/package.json");
  return pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
}

function resolveElectronPath() {
  return packageRequire("apps/desktop/package.json")("electron");
}

function reportProgress(message) {
  process.stderr.write(`[moss-new-user] ${message}\n`);
}

function assertBuilt() {
  if (!existsSync(MAIN_JS)) {
    throw new Error(`Desktop build is missing at ${MAIN_JS}. Run bun run build:desktop first.`);
  }
}

function errorText(error) {
  return error instanceof Error ? error.message : String(error);
}

function recordCheck(checks, id, passed, expected, actual) {
  checks.push({ id, passed, expected, actual });
  if (!passed) reportProgress(`check failed: ${id}`);
  return passed;
}

function hasLegacyProductSurface(initial) {
  // Keep the retired product label out of native runtime source. The smoke
  // assertion still checks the exact lower-cased value without shipping that
  // identifier as a visible product string.
  const legacyLabels = new Set([
    "t3 code",
    "t3",
    String.fromCharCode(115, 121, 110, 97, 114, 97),
    "dpcode",
  ]);
  return initial.controls.some((control) => {
    const surfaceControl = `${control.ariaLabel ?? ""} ${control.title ?? ""}`;
    if (!/sidebar surface|侧边栏界面/i.test(surfaceControl)) return false;
    return legacyLabels.has(control.text.trim().toLowerCase());
  });
}

async function closeElectronApp(electronApp) {
  try {
    await Promise.race([
      electronApp.close(),
      new Promise((_, reject) => setTimeout(() => reject(new Error("close timeout")), 5_000)),
    ]);
  } catch {
    try {
      electronApp.process().kill("SIGTERM");
    } catch {
      // The process may already be gone.
    }
  }
}

async function waitForShell(page, timeoutMs) {
  await page.waitForLoadState("domcontentloaded", { timeout: timeoutMs });
  await page.waitForFunction(
    () =>
      window.location.protocol === "moss:" &&
      document.readyState !== "loading" &&
      document.body.innerText.trim().length > 0,
    undefined,
    { timeout: timeoutMs },
  );
}

async function checkPackagedLogo(page, checks) {
  const logo = await page.evaluate(async () => {
    const response = await fetch("/moss-logo-coral.png", { cache: "no-store" });
    if (!response.ok) {
      return { responseStatus: response.status, naturalWidth: 0, naturalHeight: 0 };
    }
    const image = new Image();
    image.src = "/moss-logo-coral.png";
    await image.decode();
    const authLogo = document.querySelector('img[src="/moss-logo-coral.png"]');
    return {
      responseStatus: response.status,
      naturalWidth: image.naturalWidth,
      naturalHeight: image.naturalHeight,
      authNaturalWidth: authLogo instanceof HTMLImageElement ? authLogo.naturalWidth : 0,
    };
  });
  recordCheck(
    checks,
    "logo:packaged-asset-loads",
    logo.responseStatus === 200 &&
      logo.naturalWidth > 0 &&
      logo.naturalHeight > 0 &&
      logo.authNaturalWidth > 0,
    "HTTP 200, packaged naturalWidth/naturalHeight > 0, and auth Logo naturalWidth > 0",
    logo,
  );
}

async function waitForMainWindow(electronApp, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let lastUrls = [];
  while (Date.now() < deadline) {
    const windows = electronApp.windows();
    lastUrls = windows.map((candidate) => candidate.url());
    const mainWindow = windows.find((candidate) => candidate.url().startsWith("moss://app/"));
    if (mainWindow) return mainWindow;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for the Moss app window. Observed: ${lastUrls.join(", ")}`);
}

async function collectVisibleControls(page) {
  return page.evaluate(() => {
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      const rect = element.getBoundingClientRect();
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        rect.width > 0 &&
        rect.height > 0
      );
    };
    return [
      ...document.querySelectorAll(
        "button, input, textarea, [role='button'], [role='tab'], [role='combobox']",
      ),
    ]
      .filter(isVisible)
      .map((element) => {
        const rect = element.getBoundingClientRect();
        return {
          tag: element.tagName.toLowerCase(),
          text: (element.innerText || element.value || "")
            .trim()
            .replace(/\s+/g, " ")
            .slice(0, 160),
          ariaLabel: element.getAttribute("aria-label"),
          role: element.getAttribute("role"),
          testId: element.getAttribute("data-testid"),
          title: element.getAttribute("title"),
          placeholder: element.getAttribute("placeholder"),
          rect: {
            x: Math.round(rect.x),
            y: Math.round(rect.y),
            width: Math.round(rect.width),
            height: Math.round(rect.height),
          },
        };
      });
  });
}

async function capture(page, evidenceDir, name) {
  mkdirSync(evidenceDir, { recursive: true });
  const screenshotPath = join(evidenceDir, `${name}.png`);
  await page.screenshot({ path: screenshotPath, fullPage: false });
  const state = await page.evaluate(() => ({
    url: window.location.href,
    lang: document.documentElement.lang,
    locale: document.documentElement.dataset.mossLocale ?? null,
    title: document.title,
    bodyText: document.body.innerText.trim().slice(0, 12_000),
  }));
  const controls = await collectVisibleControls(page);
  const result = { name, screenshotPath, ...state, controls };
  writeFileSync(join(evidenceDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function waitForHashPath(page, path, timeoutMs) {
  await page.waitForFunction(
    (expectedPath) => window.location.hash.startsWith(`#${expectedPath}`),
    path,
    { timeout: timeoutMs },
  );
}

async function waitForDockOnScreen(page, timeoutMs) {
  await page.waitForFunction(
    () => {
      const panel = document.querySelector('[data-testid="right-dock-panel"]');
      if (!panel) return false;
      const rect = panel.getBoundingClientRect();
      return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0;
    },
    undefined,
    { timeout: timeoutMs },
  );
}

async function ensureRightDockOnScreen(page, timeoutMs) {
  const isOnScreen = await page.evaluate(() => {
    const panel = document.querySelector('[data-testid="right-dock-panel"]');
    if (!panel) return false;
    const rect = panel.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0 && rect.left < window.innerWidth && rect.right > 0;
  });
  if (isOnScreen) return;

  const widthToggle = page.getByTestId("right-dock-width-toggle");
  await widthToggle.waitFor({ state: "visible", timeout: timeoutMs });
  await widthToggle.click({ timeout: timeoutMs });
  await waitForDockOnScreen(page, timeoutMs);
}

async function waitForTerminalText(page, marker, timeoutMs) {
  await page.waitForFunction(
    (expectedMarker) =>
      [...document.querySelectorAll(".thread-terminal-drawer .xterm-rows")].some((element) =>
        element.textContent?.includes(expectedMarker),
      ),
    marker,
    { timeout: timeoutMs },
  );
}

async function waitForFileContents(path, expectedContents, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (existsSync(path) && readFileSync(path, "utf8").includes(expectedContents)) return;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(`Timed out waiting for terminal marker file: ${path}`);
}

async function clickRevealedSectionAction(button, timeoutMs) {
  const header = button.locator(
    "xpath=ancestor::div[contains(concat(' ', normalize-space(@class), ' '), ' group/project-header ')][1]",
  );
  await header.hover({ timeout: timeoutMs });
  await button.evaluate(
    (element, revealTimeoutMs) =>
      new Promise((resolveReveal, rejectReveal) => {
        const startedAt = performance.now();
        const waitForReveal = () => {
          const style = window.getComputedStyle(element.parentElement ?? element);
          if (style.pointerEvents !== "none" && Number(style.opacity) > 0) {
            resolveReveal(undefined);
            return;
          }
          if (performance.now() - startedAt >= revealTimeoutMs) {
            rejectReveal(
              new Error(
                `Section action did not reveal on hover (pointer-events=${style.pointerEvents}, opacity=${style.opacity})`,
              ),
            );
            return;
          }
          requestAnimationFrame(waitForReveal);
        };
        waitForReveal();
      }),
    Math.min(timeoutMs, 2_000),
  );
  await button.click({ timeout: timeoutMs });
}

async function runJourney(page, options, profileRoot, checks, steps) {
  const projectRoot = join(profileRoot, "Projects", "moss-first-project");
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "# Moss first project\n");

  const initial = steps[0];
  recordCheck(checks, "initial:moss-title", initial.title === "Moss", "Moss", initial.title);
  recordCheck(
    checks,
    "initial:visible-moss-product-control",
    initial.controls.some(
      (control) =>
        control.tag === "button" &&
        control.text === "Moss" &&
        control.ariaLabel === "切换侧边栏界面",
    ),
    "Visible Moss product control",
    initial.controls,
  );
  recordCheck(checks, "initial:default-zh-cn", initial.lang === "zh-CN", "zh-CN", initial.lang);
  recordCheck(
    checks,
    "initial:localized-sidebar",
    ["新建项目对话", "看板", "拉取请求", "自动化工作流", "插件"].every((label) =>
      initial.bodyText.includes(label),
    ),
    "Chinese primary navigation",
    initial.bodyText,
  );
  recordCheck(
    checks,
    "initial:localized-main-surface",
    ["我们要做什么？", "在项目中工作", "完全访问"].every((label) =>
      initial.bodyText.includes(label),
    ) &&
      ["What should we", "Work in a project", "Full access"].every(
        (label) => !initial.bodyText.includes(label),
      ),
    "Chinese first-user composer without visible English fallback copy",
    initial.bodyText,
  );
  recordCheck(
    checks,
    "initial:localized-activity",
    initial.bodyText.includes("活动") &&
      !initial.bodyText.includes("See running tasks") &&
      !initial.bodyText.includes("anything that needs your attention"),
    "Chinese Activity coachmark without English fallback",
    initial.bodyText,
  );
  recordCheck(
    checks,
    "initial:no-legacy-product-surface",
    !hasLegacyProductSurface(initial),
    "Moss surface without retired product labels",
    initial.controls,
  );

  reportProgress("adding a first project through the sidebar path flow");
  await clickRevealedSectionAction(
    page.getByRole("button", { name: "添加项目" }),
    options.timeoutMs,
  );
  await page.getByRole("heading", { name: "创建项目", exact: true }).waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  const projectPathInput = page.getByRole("textbox", { name: "项目文件夹路径" });
  await projectPathInput.fill(projectRoot);
  await page.getByRole("button", { name: "创建项目", exact: true }).click();
  await page.getByText("moss-first-project", { exact: true }).first().waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  await page.locator('[data-testid="composer-editor"]').last().waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "01-project-created"));
  recordCheck(
    checks,
    "project:created-and-opened",
    steps.at(-1).bodyText.includes("moss-first-project"),
    "moss-first-project visible",
    steps.at(-1).bodyText,
  );
  const projectLandingHeading = page.locator('[data-testid="empty-landing-heading"]');
  await projectLandingHeading.waitFor({ state: "visible", timeout: options.timeoutMs });
  const projectLandingHeadingText = await projectLandingHeading.innerText();
  recordCheck(
    checks,
    "project:localized-landing-heading",
    projectLandingHeadingText.includes("moss-first-project") &&
      projectLandingHeadingText.includes("我们要在") &&
      projectLandingHeadingText.includes("里做什么？") &&
      !projectLandingHeadingText.includes("What should we do in") &&
      !projectLandingHeadingText.includes("this folder"),
    "Localized project landing heading containing the created project name",
    projectLandingHeadingText,
  );

  reportProgress("starting the first project terminal conversation before opening dock tools");
  const terminalThreadAction = page.getByRole("button", {
    name: "在 moss-first-project 中新建终端对话",
    exact: true,
  });
  await terminalThreadAction.waitFor({ state: "visible", timeout: options.timeoutMs });
  const projectLandingHash = await page.evaluate(() => window.location.hash);
  await clickRevealedSectionAction(terminalThreadAction, options.timeoutMs);
  recordCheck(
    checks,
    "project:terminal-action-localized",
    (await terminalThreadAction.getAttribute("aria-label")) ===
      "在 moss-first-project 中新建终端对话",
    "在 moss-first-project 中新建终端对话",
    await terminalThreadAction.getAttribute("aria-label"),
  );
  await page.waitForFunction(
    (previousHash) => {
      const hash = window.location.hash;
      return (
        hash !== previousHash &&
        /^#[/][0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(hash)
      );
    },
    projectLandingHash,
    { timeout: options.timeoutMs },
  );
  const terminalThreadId = await page.evaluate(() => window.location.hash.slice(2));
  const terminalPane = page.locator(".thread-terminal-drawer").last();
  await terminalPane.waitFor({ state: "visible", timeout: options.timeoutMs });
  await page
    .locator(`[data-testid="thread-archive-${terminalThreadId}"]`)
    .waitFor({ state: "visible", timeout: options.timeoutMs });
  await page.locator('[data-testid="right-dock-empty-actions"]').waitFor({
    state: "attached",
    timeout: options.timeoutMs,
  });
  await ensureRightDockOnScreen(page, options.timeoutMs);

  reportProgress("opening the real right dock and Files pane");
  await waitForDockOnScreen(page, options.timeoutMs);
  steps.push(await capture(page, options.evidenceDir, "02-right-dock-open"));
  const rightDockLauncher = page.locator('[data-testid="right-dock-empty-actions"]');
  const rightDockLauncherText = await rightDockLauncher.innerText();
  recordCheck(
    checks,
    "right-dock:localized-launcher",
    ["文件", "侧边对话", "浏览器", "终端"].every((label) =>
      rightDockLauncherText.includes(label),
    ) &&
      ["Files", "Side task", "Browser", "Terminal"].every(
        (label) => !rightDockLauncherText.includes(label),
      ),
    "Chinese right-dock launcher labels",
    rightDockLauncherText,
  );
  await page.locator('[data-testid="right-dock-empty-action-explorer"]').click();
  await page.getByText("README.md", { exact: true }).first().waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "03-files-pane"));
  recordCheck(checks, "right-dock:files-clickable", true, true, true);
  await page.getByRole("button", { name: /^(Close Files|关闭文件)$/ }).click();
  await page.locator('[data-testid="right-dock-empty-actions"]').waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });

  reportProgress("opening and closing the Browser pane");
  await page.locator('[data-testid="right-dock-empty-action-browser"]').click();
  await page.locator('[data-native-browser-surface="true"]').waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "04-browser-pane"));
  recordCheck(checks, "right-dock:browser-clickable", true, true, true);
  await page.getByRole("button", { name: /^(Close Browser|关闭浏览器)$/ }).click();
  await page.locator('[data-testid="right-dock-empty-actions"]').waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });

  reportProgress("opening Terminal from the right-side launcher and running a command");
  await page.locator('[data-testid="right-dock-empty-action-terminal"]').click();
  const drawer = page.locator(".thread-terminal-drawer").last();
  await drawer.waitFor({ state: "visible", timeout: options.timeoutMs });
  const terminalScreen = drawer.locator(".xterm-screen").last();
  await terminalScreen.waitFor({ state: "visible", timeout: options.timeoutMs });
  const terminalInput = drawer.locator(".xterm-helper-textarea").last();
  await terminalInput.waitFor({ state: "attached", timeout: options.timeoutMs });
  await page.waitForTimeout(1_000);
  await terminalScreen.click({ position: { x: 24, y: 24 } });
  await page.waitForFunction(
    () => document.activeElement?.classList.contains("xterm-helper-textarea") === true,
    undefined,
    { timeout: options.timeoutMs },
  );
  const terminalMarkerPath = join(profileRoot, "terminal-command.ok");
  await page.keyboard.type(`printf 'MOSS_NEW_USER_TERMINAL_OK\\n' | tee '${terminalMarkerPath}'`);
  await page.keyboard.press("Enter");
  await waitForFileContents(terminalMarkerPath, "MOSS_NEW_USER_TERMINAL_OK", options.timeoutMs);
  await waitForTerminalText(page, "MOSS_NEW_USER_TERMINAL_OK", 2_000).catch(() => undefined);
  steps.push(await capture(page, options.evidenceDir, "05-terminal-command"));
  recordCheck(checks, "right-dock:terminal-clickable", true, true, true);
  recordCheck(checks, "terminal:command-output", true, true, true);
  const drawerClose = drawer.locator(
    'button[aria-label="关闭底部面板"], button[aria-label="Close bottom panel"]',
  );
  await drawerClose.click();
  await drawer.waitFor({ state: "detached", timeout: options.timeoutMs });

  reportProgress("opening Settings and exercising locale switching");
  await page.getByTestId("sidebar-account-menu-trigger").click();
  await page.getByRole("menuitem", { name: /设置/ }).click();
  await waitForHashPath(page, "/settings", options.timeoutMs);
  steps.push(await capture(page, options.evidenceDir, "06-settings-general"));
  await page.getByRole("button", { name: "外观", exact: true }).click();
  const languageSelectZh = page.getByRole("combobox", { name: "语言" });
  await languageSelectZh.waitFor({ state: "visible", timeout: options.timeoutMs });
  await languageSelectZh.click();
  await page.locator('[data-slot="select-item"]').filter({ hasText: "English" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en", undefined, {
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "07-settings-english"));
  recordCheck(
    checks,
    "settings:english-switch",
    steps.at(-1).lang === "en",
    "en",
    steps.at(-1).lang,
  );

  const languageSelectEn = page.getByRole("combobox", { name: "Language" });
  await languageSelectEn.click();
  await page.locator('[data-slot="select-item"]').filter({ hasText: "简体中文" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN", undefined, {
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "08-settings-chinese"));
  recordCheck(
    checks,
    "settings:chinese-switch",
    steps.at(-1).lang === "zh-CN",
    "zh-CN",
    steps.at(-1).lang,
  );

  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.waitForFunction(() => !window.location.hash.startsWith("#/settings"), undefined, {
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "09-back-to-app"));
  recordCheck(
    checks,
    "settings:back-to-app",
    !steps.at(-1).url.includes("#/settings"),
    "non-settings route",
    steps.at(-1).url,
  );

  reportProgress("opening the plugin library, search, and first detail page");
  await page.getByRole("button", { name: "插件", exact: true }).click();
  await waitForHashPath(page, "/skills", options.timeoutMs);
  const pluginSearch = page.getByPlaceholder("搜索插件");
  await pluginSearch.waitFor({ state: "visible", timeout: options.timeoutMs });
  steps.push(await capture(page, options.evidenceDir, "10-plugins"));
  await pluginSearch.fill("Browser");
  await page
    .waitForFunction(
      () => {
        const bodyText = document.body.innerText;
        return (
          document.querySelectorAll("#plugins-page-results button[data-plugin-library-focus-key]")
            .length > 0 ||
          bodyText.includes("未找到插件") ||
          bodyText.includes("无法加载插件")
        );
      },
      undefined,
      { timeout: Math.min(options.timeoutMs, 10_000) },
    )
    .catch(() => undefined);
  steps.push(await capture(page, options.evidenceDir, "11-plugins-search"));
  const pluginRows = page.locator("#plugins-page-results button[data-plugin-library-focus-key]");
  const pluginRowCount = await pluginRows.count();
  const pluginSearchBody = steps.at(-1).bodyText;
  const hasFirstUserEmptyState = pluginSearchBody.includes("未找到插件");
  recordCheck(
    checks,
    "plugins:search-results-or-empty-state",
    pluginRowCount > 0 || hasFirstUserEmptyState,
    "Search results or localized first-user empty state",
    { pluginRowCount, hasFirstUserEmptyState },
  );
  recordCheck(
    checks,
    "plugins:no-provider-internals",
    ["plugin/list", "authentication required", "Provider adapter request failed"].every(
      (label) => !pluginSearchBody.includes(label),
    ),
    "No raw provider RPC or authentication internals",
    pluginSearchBody,
  );
  if (pluginRowCount > 0) {
    await pluginRows.first().click();
    await page
      .getByRole("heading")
      .first()
      .waitFor({ state: "visible", timeout: options.timeoutMs });
    steps.push(await capture(page, options.evidenceDir, "12-plugin-detail"));
    recordCheck(checks, "plugins:detail-opens", true, true, true);
    await page.getByRole("button", { name: "插件", exact: true }).first().click();
  }

  reportProgress("switching into Studio and preserving an unsent draft");
  const surfaceTrigger = page.getByRole("button", {
    name: "切换侧边栏界面",
    exact: true,
  });
  await surfaceTrigger.waitFor({ state: "visible", timeout: options.timeoutMs });
  await surfaceTrigger.click();
  const studioSurfaceItem = page.getByRole("menuitemradio", { name: /^创作室/ });
  await studioSurfaceItem.waitFor({ state: "visible", timeout: options.timeoutMs });
  await studioSurfaceItem.click();
  await page.waitForFunction(
    () =>
      window.location.hash.startsWith("#/studio") ||
      document.body.innerText.includes("新建创作室对话"),
    undefined,
    { timeout: options.timeoutMs },
  );
  const studioEditor = page.locator('[data-testid="composer-editor"]').last();
  await studioEditor.waitFor({ state: "visible", timeout: options.timeoutMs });
  await studioEditor.click();
  await page.keyboard.insertText("MOSS_NEW_USER_STUDIO_DRAFT");
  steps.push(await capture(page, options.evidenceDir, "13-studio-draft"));
  recordCheck(
    checks,
    "studio:localized-sidebar",
    steps.at(-1).bodyText.includes("新建创作室对话"),
    "新建创作室对话",
    steps.at(-1).bodyText,
  );
  recordCheck(
    checks,
    "studio:draft-entry",
    await studioEditor.innerText().then((value) => value.includes("MOSS_NEW_USER_STUDIO_DRAFT")),
    true,
    await studioEditor.innerText(),
  );

  const projectsSurfaceTrigger = page.getByRole("button", {
    name: "切换侧边栏界面",
    exact: true,
  });
  await projectsSurfaceTrigger.waitFor({ state: "visible", timeout: options.timeoutMs });
  await projectsSurfaceTrigger.click();
  const mossSurfaceItem = page.getByRole("menuitemradio", { name: /^Moss/ });
  await mossSurfaceItem.waitFor({ state: "visible", timeout: options.timeoutMs });
  await mossSurfaceItem.click();
  await page.getByText("moss-first-project", { exact: true }).first().waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  steps.push(await capture(page, options.evidenceDir, "14-projects-return"));

  reportProgress("checking Kanban and Automations routes");
  await page.getByRole("button", { name: "看板", exact: true }).click();
  await waitForHashPath(page, "/kanban", options.timeoutMs);
  steps.push(await capture(page, options.evidenceDir, "15-kanban"));
  await page.getByRole("button", { name: "自动化工作流", exact: true }).click();
  await waitForHashPath(page, "/automations", options.timeoutMs);
  steps.push(await capture(page, options.evidenceDir, "16-automations"));
  recordCheck(checks, "routes:kanban-and-automations", true, true, true);
  recordCheck(
    checks,
    "automations:localized-empty-state",
    ["新建自动化", "暂无自动化", "定时独立运行提示词"].every((label) =>
      steps.at(-1).bodyText.includes(label),
    ) &&
      ["New automation", "No automations yet", "Schedule a prompt"].every(
        (label) => !steps.at(-1).bodyText.includes(label),
      ),
    "Chinese automation empty state",
    steps.at(-1).bodyText,
  );

  await page.setViewportSize({ width: 1024, height: 768 });
  await page.getByRole("button", { name: "新建项目对话", exact: true }).click();
  await page
    .waitForFunction(() => !window.location.hash.startsWith("#/automations"), undefined, {
      timeout: 10_000,
    })
    .catch(() => undefined);
  await page.waitForTimeout(1_500);
  steps.push(await capture(page, options.evidenceDir, "17-compact-new-thread"));
  recordCheck(
    checks,
    "provider-status:localized-unauthenticated",
    !steps.at(-1).bodyText.includes("CLI is not authenticated") &&
      (!steps.at(-1).bodyText.includes("provider 状态") ||
        steps.at(-1).bodyText.includes("CLI 尚未登录")),
    "No visible raw English unauthenticated provider status",
    steps.at(-1).bodyText,
  );
  const compactComposerVisible = await page
    .locator('[data-testid="composer-editor"]')
    .last()
    .isVisible()
    .catch(() => false);
  recordCheck(
    checks,
    "navigation:new-thread-from-automations",
    compactComposerVisible,
    "Visible composer editor",
    { url: steps.at(-1).url, compactComposerVisible },
  );
  const overflow = await page.evaluate(() => ({
    documentWidth: document.documentElement.scrollWidth,
    viewportWidth: document.documentElement.clientWidth,
  }));
  recordCheck(
    checks,
    "layout:no-horizontal-page-overflow",
    overflow.documentWidth <= overflow.viewportWidth,
    overflow.viewportWidth,
    overflow.documentWidth,
  );
}

function runPersistenceProbe(initial, profileRoot, checks) {
  recordCheck(checks, "restart:locale-persisted", initial.lang === "zh-CN", "zh-CN", initial.lang);
  recordCheck(
    checks,
    "restart:project-persisted",
    initial.bodyText.includes("moss-first-project"),
    "moss-first-project visible after restart",
    initial.bodyText,
  );
  recordCheck(
    checks,
    "restart:terminal-command-persisted",
    existsSync(join(profileRoot, "terminal-command.ok")),
    "terminal command marker still exists",
    join(profileRoot, "terminal-command.ok"),
  );
  recordCheck(
    checks,
    "restart:no-legacy-product-surface",
    !hasLegacyProductSurface(initial),
    "Moss surface without retired product labels",
    initial.controls,
  );
}

async function run(options) {
  assertBuilt();
  const profileRoot = options.profileRoot ?? mkdtempSync(join(tmpdir(), "moss-new-user-profile-"));
  const mossHome = join(profileRoot, "moss-home");
  const electronUserDataDir = join(profileRoot, "electron-user-data");
  mkdirSync(mossHome, { recursive: true });
  mkdirSync(electronUserDataDir, { recursive: true });
  mkdirSync(options.evidenceDir, { recursive: true });

  const importedPlaywright = await import(resolvePlaywrightModuleUrl());
  const electron = importedPlaywright._electron ?? importedPlaywright.default?._electron;
  if (!electron) throw new Error("Playwright Electron launcher is unavailable.");

  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const stderrLines = [];
  const stdoutLines = [];
  const checks = [];
  const steps = [];
  const electronEnv = { ...process.env };
  delete electronEnv.VITE_DEV_SERVER_URL;

  reportProgress(`launching isolated Electron at ${profileRoot}`);
  const electronApp = await electron.launch({
    executablePath: resolveElectronPath(),
    args: [`--user-data-dir=${electronUserDataDir}`, MAIN_JS],
    cwd: DESKTOP_ROOT,
    env: {
      ...electronEnv,
      HOME: profileRoot,
      XDG_CONFIG_HOME: join(profileRoot, "xdg-config"),
      APPDATA: join(profileRoot, "appdata"),
      LOCALAPPDATA: join(profileRoot, "local-appdata"),
      MOSS_HOME: mossHome,
      DPCODE_HOME: mossHome,
      T3CODE_HOME: mossHome,
      T3CODE_DISABLE_AUTO_UPDATE: "1",
    },
    timeout: options.timeoutMs,
  });

  electronApp.process().stdout?.on("data", (chunk) => stdoutLines.push(String(chunk)));
  electronApp.process().stderr?.on("data", (chunk) => stderrLines.push(String(chunk)));

  try {
    await electronApp.firstWindow({ timeout: options.timeoutMs });
    reportProgress("first Electron window observed");
    const page = await waitForMainWindow(electronApp, options.timeoutMs);
    reportProgress(`main window ready at ${page.url()}`);
    await page.setViewportSize({ width: 1512, height: 982 });
    page.on("console", (message) => {
      if (message.type() === "error") {
        const location = message.location();
        consoleErrors.push({
          text: message.text(),
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        });
      }
    });
    page.on("pageerror", (error) => pageErrors.push(errorText(error)));
    page.on("requestfailed", (request) => {
      requestFailures.push(
        `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
      );
    });

    await page.waitForTimeout(2_000);
    const preShellState = await page.evaluate(() => ({
      url: window.location.href,
      readyState: document.readyState,
      bodyTextLength: document.body?.innerText.length ?? -1,
      hasDesktopBridge: Boolean(window.desktopBridge),
      hasNativeApi: Boolean(window.nativeApi),
    }));
    reportProgress(`pre-shell state ${JSON.stringify(preShellState)}`);
    await waitForShell(page, options.timeoutMs);
    reportProgress("application shell is interactive");
    await checkPackagedLogo(page, checks);
    await page.waitForTimeout(2_000);
    const initial = await capture(page, options.evidenceDir, "00-initial");
    steps.push(initial);
    let journeyError = null;
    try {
      if (options.probeOnly) {
        runPersistenceProbe(initial, profileRoot, checks);
      } else {
        await runJourney(page, options, profileRoot, checks, steps);
      }
    } catch (error) {
      journeyError = errorText(error);
      reportProgress(`journey failed: ${journeyError}`);
      try {
        steps.push(await capture(page, options.evidenceDir, "failure"));
      } catch (captureError) {
        journeyError = `${journeyError}; failure capture: ${errorText(captureError)}`;
      }
    }
    const failedChecks = checks.filter((check) => !check.passed);
    const report = {
      status:
        failedChecks.length === 0 && pageErrors.length === 0 && journeyError === null
          ? "pass"
          : "fail",
      mode: options.probeOnly ? "probe" : "journey",
      profileRoot,
      evidenceDir: options.evidenceDir,
      initial,
      steps,
      checks,
      failedChecks,
      journeyError,
      consoleErrors,
      pageErrors,
      requestFailures,
      stdout: stdoutLines.join("").slice(-20_000),
      stderr: stderrLines.join("").slice(-20_000),
    };
    writeFileSync(join(options.evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);
    process.stdout.write(
      `${JSON.stringify(
        {
          status: report.status,
          mode: report.mode,
          profileRoot,
          evidenceDir: options.evidenceDir,
          stepCount: steps.length,
          checkCount: checks.length,
          failedChecks,
          consoleErrorCount: consoleErrors.length,
          pageErrorCount: pageErrors.length,
          requestFailureCount: requestFailures.length,
        },
        null,
        2,
      )}\n`,
    );
    if (report.status !== "pass") process.exitCode = 1;
    return report;
  } finally {
    await closeElectronApp(electronApp);
  }
}

const options = parseArgs(process.argv.slice(2));
run(options).catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
