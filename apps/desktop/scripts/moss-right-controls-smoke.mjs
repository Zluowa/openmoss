import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, relative, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const MAIN_JS = join(DESKTOP_ROOT, "dist-electron", "main.js");
const PRELOAD_JS = join(DESKTOP_ROOT, "dist-electron", "preload.js");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "server", "dist", "index.mjs");
const WEB_INDEX = join(WEB_ROOT, "dist", "index.html");
const THREAD_ID = "thread-moss-served-smoke";
const DESKTOP_ROUTE = `moss://app/index.html#/${THREAD_ID}?mossShell=1`;
const DEFAULT_TIMEOUT_MS = 120_000;
const EXPECTED_HEADER_CONTROL_SIZE = 28;
const EXPECTED_DRAWER_HEIGHT = 280;
const EXPECTED_RESIZED_DRAWER_HEIGHT = 220;
const EXPECTED_SUMMARY_PANEL_WIDTH = 300;
const TERMINAL_STATE_STORAGE_KEY = "moss:terminal-state:v1";
const TERMINAL_DRAWER_HEIGHT_STORAGE_KEY = "app-shell:bottom-panel-height";
const EXPECTED_SUMMARY_DOCUMENT_PROMPT =
  "使用 [@Documents](plugin://documents@openai-primary-runtime) 创建一个新文档。先问我它应该是什么主题。";
// Keep the Moss-only control-plane rail below its 980px breakpoint while still
// remaining above the right dock's 960px full-width eligibility threshold.
const OVERLAY_VIEWPORT = Object.freeze({ width: 976, height: 800 });
const INLINE_VIEWPORT = Object.freeze({ width: 1920, height: 1000 });

const SELECTORS = Object.freeze({
  fixedControls: '[data-testid="chat-header-app-shell-controls"]',
  bottom: '[data-testid="chat-header-bottom-panel-toggle"]',
  summary: '[data-testid="chat-header-thread-summary-toggle"]',
  right: '[data-testid="chat-header-right-dock-toggle"]',
  summaryPanel: '[data-testid="thread-summary-panel"]',
  dockPanel: '[data-testid="right-dock-panel"]',
  drawer: ".thread-terminal-drawer",
  drawerClose: '.thread-terminal-drawer button[aria-label="关闭底部面板"]',
  drawerResize: '.thread-terminal-drawer > div[class*="cursor-row-resize"]',
  composer: "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
  editor: '[data-testid="composer-editor"]',
  send: '[data-moss-visible-send-control="true"]',
  userRows: '[data-message-role="user"]',
  outputTrigger: '[data-testid="thread-summary-panel"] button[aria-label="创建文件或网站"]',
  widthToggle: '[data-testid="right-dock-width-toggle"]',
  mainHeader: '[data-testid="chat-surface-main-header"]',
  layoutShell: '[data-testid="thread-layout-shell"]',
  mainRow: '[data-testid="thread-main-row"]',
  bottomHost: '[data-testid="thread-bottom-panel-host"]',
});

const FIXED_CONTROL_TEST_IDS = Object.freeze([
  "chat-header-bottom-panel-toggle",
  "chat-header-thread-summary-toggle",
  "chat-header-right-dock-toggle",
]);

const DRAWER_FORBIDDEN_ACTION_LABELS = Object.freeze([
  "Move to its own terminal tab",
  "Split right",
  "Split down",
  "Expand terminal into workspace",
  "Collapse terminal into chat drawer",
  "Open side panel",
  "Collapse side panel",
]);

function artifactDate(createdAt) {
  return createdAt.slice(0, 10);
}

function parseArgs(argv) {
  const now = new Date().toISOString();
  const options = {
    createdAt: now,
    evidenceDir: undefined,
    reportPath: undefined,
    timeoutMs: DEFAULT_TIMEOUT_MS,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    const next = argv[index + 1];
    if (arg === "--created-at" && next) {
      options.createdAt = next;
      index += 1;
      continue;
    }
    if (arg === "--evidence-dir" && next) {
      options.evidenceDir = next;
      index += 1;
      continue;
    }
    if (arg === "--report" && next) {
      options.reportPath = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
    throw new Error(`Unknown right-controls smoke option: ${arg}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
  }
  const date = artifactDate(options.createdAt);
  options.evidenceDir ??= `.moss/ledger/evidence/moss-right-controls-smoke-${date}`;
  options.reportPath ??= `.moss/ledger/evidence/moss-right-controls-smoke-${date}.json`;
  return options;
}

function repoPath(path) {
  return resolve(REPO_ROOT, path);
}

function displayPath(path) {
  const absolute = repoPath(path);
  const local = relative(REPO_ROOT, absolute);
  return local.startsWith("..") ? path : local;
}

function assertBuiltFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}. Run bun run build:desktop first.`);
  }
}

function reportProgress(label) {
  process.stderr.write(`[moss-right-controls] ${label}\n`);
}

function requireFromPackage(packageJsonPath) {
  return createRequire(resolve(REPO_ROOT, packageJsonPath));
}

function resolvePlaywrightModuleUrl() {
  const requireFromWeb = requireFromPackage("apps/web/package.json");
  return pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
}

function resolveElectronPath() {
  return requireFromPackage("apps/desktop/package.json")("electron");
}

function dumpProductShellInitScript(createdAt, runtimeDir) {
  const outputPath = join(runtimeDir, "moss-right-controls-init.js");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/moss-promoted-shell-served-smoke.ts",
      "--created-at",
      createdAt,
      "--dump-init-script",
      outputPath,
    ],
    { cwd: REPO_ROOT, encoding: "utf8" },
  );
  if (result.status !== 0) {
    throw new Error(
      ["Unable to build the product-shell fixture init script.", result.stdout, result.stderr]
        .filter(Boolean)
        .join("\n"),
    );
  }
  return readFileSync(outputPath, "utf8");
}

function rightControlsStorageInitScript() {
  return `
(() => {
  try {
    if (window.location.protocol !== "moss:") return;
    const marker = "moss:right-controls-smoke:seeded";
    if (window.sessionStorage.getItem(marker) === "1") return;
    window.localStorage.setItem(
      "moss:right-dock-state:v1",
      JSON.stringify({
        state: {
          dockStateByThreadId: {
            "${THREAD_ID}": { open: false, panes: [], activePaneId: null }
          }
        },
        version: 0
      })
    );
    window.localStorage.setItem(
      "moss:terminal-state:v1",
      JSON.stringify({ state: { terminalStateByThreadId: {} }, version: 1 })
    );
    window.sessionStorage.setItem(marker, "1");
  } catch (error) {
    console.warn("[moss-right-controls-smoke] fixture storage seed failed", error);
  }
})();`;
}

function rectToJson(rect) {
  if (!rect) return null;
  return {
    x: Math.round(rect.x * 100) / 100,
    y: Math.round(rect.y * 100) / 100,
    width: Math.round(rect.width * 100) / 100,
    height: Math.round(rect.height * 100) / 100,
  };
}

function intersectsViewport(rect, viewport) {
  return Boolean(
    rect &&
    rect.width > 0 &&
    rect.height > 0 &&
    rect.x < viewport.width &&
    rect.y < viewport.height &&
    rect.x + rect.width > 0 &&
    rect.y + rect.height > 0,
  );
}

async function viewportLocator(page, selector) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Playwright viewport is unavailable.");
  const candidates = page.locator(selector);
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    const exposed = await candidate.evaluate(
      (element) => !element.closest('[inert], [aria-hidden="true"]'),
    );
    if (exposed && intersectsViewport(await candidate.boundingBox(), viewport)) return candidate;
  }
  throw new Error(`No on-screen element matched ${selector}`);
}

async function selectorEvidence(page, selector) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Playwright viewport is unavailable.");
  const candidates = page.locator(selector);
  const entries = [];
  for (let index = 0; index < (await candidates.count()); index += 1) {
    const candidate = candidates.nth(index);
    const rect = await candidate.boundingBox();
    const exposed = await candidate.evaluate(
      (element) => !element.closest('[inert], [aria-hidden="true"]'),
    );
    entries.push({
      ariaLabel: await candidate.getAttribute("aria-label"),
      ariaPressed: await candidate.getAttribute("aria-pressed"),
      title: await candidate.getAttribute("title"),
      testId: await candidate.getAttribute("data-testid"),
      className: await candidate.getAttribute("class"),
      dataState: await candidate.getAttribute("data-state"),
      exposed,
      inViewport: exposed && intersectsViewport(rect, viewport),
      rect: rectToJson(rect),
    });
  }
  const onScreen = entries.filter((entry) => entry.inViewport);
  return {
    count: entries.length,
    onScreenCount: onScreen.length,
    entries,
    onScreen,
  };
}

function check(id, pass, expected, actual) {
  return { id, pass: Boolean(pass), expected, actual };
}

function sizeMatches(entry, expected) {
  return Boolean(
    entry?.rect &&
    Math.abs(entry.rect.width - expected) <= 1 &&
    Math.abs(entry.rect.height - expected) <= 1,
  );
}

async function dockGeometry(page) {
  const panel = page.locator(SELECTORS.dockPanel);
  if ((await panel.count()) === 0) return null;
  return panel.first().evaluate((element) => {
    const panelRect = element.getBoundingClientRect();
    const provider = element.closest("[data-testid='right-dock-provider']");
    const shell = provider?.parentElement ?? null;
    const shellRect = shell?.getBoundingClientRect() ?? null;
    const root = element.closest("[data-slot='sidebar']");
    const gap = root?.querySelector("[data-slot='sidebar-gap']") ?? null;
    const panelStyle = getComputedStyle(element);
    const gapStyle = gap ? getComputedStyle(gap) : null;
    return {
      state: root?.getAttribute("data-state") ?? null,
      panelRect: {
        x: panelRect.x,
        y: panelRect.y,
        width: panelRect.width,
        height: panelRect.height,
      },
      shellRect: shellRect
        ? {
            x: shellRect.x,
            y: shellRect.y,
            width: shellRect.width,
            height: shellRect.height,
          }
        : null,
      panelTransitionDuration: panelStyle.transitionDuration,
      panelTransitionTimingFunction: panelStyle.transitionTimingFunction,
      gapTransitionDuration: gapStyle?.transitionDuration ?? null,
      gapTransitionTimingFunction: gapStyle?.transitionTimingFunction ?? null,
      motionDurationMs: element.getAttribute("data-motion-duration-ms"),
      motionBounce: element.getAttribute("data-motion-bounce"),
      panelClassName: element.getAttribute("class"),
      gapClassName: gap?.getAttribute("class") ?? null,
    };
  });
}

async function drawerGeometry(page) {
  const drawer = page.locator(SELECTORS.drawer);
  if ((await drawer.count()) === 0) return null;
  return drawer.last().evaluate((element) => {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return {
      x: rect.x,
      y: rect.y,
      width: rect.width,
      height: rect.height,
      transitionDuration: style.transitionDuration,
      motionDurationMs: element.getAttribute("data-transition-duration-ms"),
      motionBounce: element.getAttribute("data-transition-bounce"),
    };
  });
}

async function settleFrame(page) {
  await page.evaluate(
    () =>
      new Promise((resolveFrame) => {
        window.requestAnimationFrame(() => window.requestAnimationFrame(resolveFrame));
      }),
  );
}

async function waitForDockGeometryStable(page, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let previous = null;
  let stableSamples = 0;

  while (Date.now() < deadline) {
    const current = await dockGeometry(page);
    const rect = current?.panelRect ?? null;
    if (
      rect &&
      previous &&
      Math.abs(rect.x - previous.x) <= 0.25 &&
      Math.abs(rect.width - previous.width) <= 0.25
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return;
    } else {
      stableSamples = 0;
    }
    previous = rect;
    await page.waitForTimeout(50);
  }

  throw new Error(`Right dock geometry did not settle within ${timeoutMs}ms.`);
}

async function waitForDockState(page, state) {
  await page.waitForFunction(
    ({ selector, expectedState }) => {
      const panel = document.querySelector(selector);
      return panel?.closest("[data-slot='sidebar']")?.getAttribute("data-state") === expectedState;
    },
    { selector: SELECTORS.dockPanel, expectedState: state },
  );
  await waitForDockGeometryStable(page);
}

async function waitForDrawer(page, open, expectedHeight = EXPECTED_DRAWER_HEIGHT) {
  if (open) {
    await page.locator(SELECTORS.drawer).last().waitFor({ state: "visible" });
    try {
      await page.waitForFunction(
        ({ selector, expectedHeight }) => {
          const drawers = [...document.querySelectorAll(selector)];
          const drawer = drawers.at(-1);
          if (!(drawer instanceof HTMLElement)) return false;
          const rect = drawer.getBoundingClientRect();
          return (
            Math.abs(rect.height - expectedHeight) <= 1 &&
            Number.parseFloat(window.getComputedStyle(drawer).opacity) >= 0.99
          );
        },
        { selector: SELECTORS.drawer, expectedHeight },
      );
    } catch (error) {
      const evidence = await page.evaluate((selector) => {
        const drawer = [...document.querySelectorAll(selector)].at(-1);
        if (!(drawer instanceof HTMLElement)) return { drawer: null };
        const rect = drawer.getBoundingClientRect();
        const style = window.getComputedStyle(drawer);
        return {
          drawer: {
            height: rect.height,
            opacity: style.opacity,
            transform: style.transform,
          },
          activeTag: document.activeElement?.tagName ?? null,
        };
      }, SELECTORS.drawer);
      throw new Error(
        `Terminal drawer did not settle at ${expectedHeight}px: ${JSON.stringify(evidence)}`,
        { cause: error },
      );
    }
  } else {
    await page.locator(SELECTORS.drawer).last().waitFor({ state: "detached" });
  }
  await settleFrame(page);
}

async function waitForSummaryLabel(page, expectedLabel) {
  await page.waitForFunction(
    ({ selector, label }) => document.querySelector(selector)?.getAttribute("aria-label") === label,
    { selector: SELECTORS.summary, label: expectedLabel },
  );
  await settleFrame(page);
}

async function waitForSummaryPanel(page, presentation, visible) {
  await page.waitForFunction(
    ({ selector, expectedPresentation, expectedVisible }) => {
      const panels = [...document.querySelectorAll(selector)];
      const visiblePanels = panels.filter((panel) => {
        const rect = panel.getBoundingClientRect();
        const hiddenByAncestor = panel.closest('[aria-hidden="true"]');
        return (
          !hiddenByAncestor &&
          rect.width > 0 &&
          rect.height > 0 &&
          rect.left < window.innerWidth &&
          rect.top < window.innerHeight &&
          rect.right > 0 &&
          rect.bottom > 0
        );
      });
      if (!expectedVisible) return visiblePanels.length === 0;
      return visiblePanels.some((panel) =>
        expectedPresentation === "overlay"
          ? Boolean(panel.closest('[data-slot="popover-popup"]'))
          : !panel.closest('[data-slot="popover-popup"]'),
      );
    },
    {
      selector: SELECTORS.summaryPanel,
      expectedPresentation: presentation,
      expectedVisible: visible,
    },
  );
  if (visible) {
    await waitForSummaryGeometryStable(page, presentation);
  }
  await settleFrame(page);
}

async function waitForSummaryGeometryStable(page, presentation, timeoutMs = 2_000) {
  const deadline = Date.now() + timeoutMs;
  let previousWidth = null;
  let stableSamples = 0;

  while (Date.now() < deadline) {
    const sample = await page.evaluate(
      ({ selector, expectedPresentation }) => {
        const panels = [...document.querySelectorAll(selector)];
        const panel = panels.find((candidate) => {
          const rect = candidate.getBoundingClientRect();
          const hiddenByAncestor = candidate.closest('[aria-hidden="true"]');
          const isOverlay = Boolean(candidate.closest('[data-slot="popover-popup"]'));
          return (
            !hiddenByAncestor &&
            (expectedPresentation === "overlay" ? isOverlay : !isOverlay) &&
            rect.width > 0 &&
            rect.height > 0 &&
            rect.left < window.innerWidth &&
            rect.top < window.innerHeight &&
            rect.right > 0 &&
            rect.bottom > 0
          );
        });
        return panel?.getBoundingClientRect().width ?? null;
      },
      { selector: SELECTORS.summaryPanel, expectedPresentation: presentation },
    );

    if (
      sample !== null &&
      Math.abs(sample - EXPECTED_SUMMARY_PANEL_WIDTH) <= 0.25 &&
      previousWidth !== null &&
      Math.abs(sample - previousWidth) <= 0.1
    ) {
      stableSamples += 1;
      if (stableSamples >= 2) return;
    } else {
      stableSamples = 0;
    }
    previousWidth = sample;
    await page.waitForTimeout(50);
  }

  throw new Error(`Summary panel geometry did not settle within ${timeoutMs}ms.`);
}

async function fixedControlsEvidence(page) {
  const containerEvidence = await selectorEvidence(page, SELECTORS.fixedControls);
  const container = await viewportLocator(page, SELECTORS.fixedControls);
  const buttons = container.locator("button[data-testid]");
  const entries = [];
  for (let index = 0; index < (await buttons.count()); index += 1) {
    const button = buttons.nth(index);
    entries.push({
      testId: await button.getAttribute("data-testid"),
      ariaLabel: await button.getAttribute("aria-label"),
      ariaPressed: await button.getAttribute("aria-pressed"),
      title: await button.getAttribute("title"),
      rect: rectToJson(await button.boundingBox()),
    });
  }
  return { container: containerEvidence, entries };
}

async function summaryPanelEvidence(page) {
  const viewport = page.viewportSize();
  if (!viewport) throw new Error("Playwright viewport is unavailable.");
  const panels = page.locator(SELECTORS.summaryPanel);
  const entries = [];
  for (let index = 0; index < (await panels.count()); index += 1) {
    const panel = panels.nth(index);
    const rect = await panel.boundingBox();
    const metadata = await panel.evaluate((element) => ({
      hiddenByAncestor: Boolean(element.closest('[aria-hidden="true"]')),
      presentation: element.closest('[data-slot="popover-popup"]') ? "overlay" : "inline",
    }));
    entries.push({
      ...metadata,
      inViewport: !metadata.hiddenByAncestor && intersectsViewport(rect, viewport),
      rect: rectToJson(rect),
    });
  }
  return {
    count: entries.length,
    onScreen: entries.filter((entry) => entry.inViewport),
    onScreenCount: entries.filter((entry) => entry.inViewport).length,
  };
}

async function drawerChromeEvidence(page) {
  const drawers = page.locator(SELECTORS.drawer);
  if ((await drawers.count()) === 0) return null;
  return drawers.last().evaluate((drawer, forbiddenLabels) => {
    const plusButton = drawer.querySelector('button[data-testid="bottom-panel-launcher-trigger"]');
    let header = plusButton?.parentElement ?? null;
    while (header && !header.classList.contains("min-h-9")) header = header.parentElement;
    const headerButtons = header ? [...header.querySelectorAll("button")] : [];
    const entry = (button) => ({
      ariaLabel: button.getAttribute("aria-label"),
      ariaPressed: button.getAttribute("aria-pressed"),
      title: button.getAttribute("title"),
      text: button.textContent?.trim() ?? "",
    });
    const buttonEntries = headerButtons.map(entry);
    const tabEntries = buttonEntries.filter(
      (button) => button.ariaLabel !== "Add action" && button.ariaLabel !== "关闭底部面板",
    );
    const forbidden = forbiddenLabels.filter(
      (label) => drawer.querySelectorAll(`button[aria-label="${label}"]`).length > 0,
    );
    return {
      headerFound: Boolean(header),
      buttons: buttonEntries,
      tabs: tabEntries,
      runtimeErrorCount: drawer.querySelectorAll('[data-testid="terminal-runtime-error"]').length,
      plusCount: drawer.querySelectorAll(
        'button[data-testid="bottom-panel-launcher-trigger"][aria-label="Add action"]',
      ).length,
      closeCount: drawer.querySelectorAll('button[aria-label="关闭底部面板"]').length,
      forbidden,
    };
  }, DRAWER_FORBIDDEN_ACTION_LABELS);
}

async function fixedControlContractEvidence(page, input) {
  const fixedControls = await fixedControlsEvidence(page);
  const controls = {
    bottom: await selectorEvidence(page, SELECTORS.bottom),
    summary: await selectorEvidence(page, SELECTORS.summary),
    right: await selectorEvidence(page, SELECTORS.right),
  };
  const checks = [];
  const onScreen = (name) => controls[name].onScreen[0] ?? null;
  const fixedIds = fixedControls.entries.map((entry) => entry.testId);
  const fixedRects = fixedControls.entries.map((entry) => entry.rect).filter(Boolean);
  const fixedXs = fixedRects.map((rect) => rect.x);
  const fixedYs = fixedRects.map((rect) => rect.y);
  const summaryLabel = input.summaryPresentation === "inline" ? "切换置顶摘要" : "切换摘要";

  checks.push(
    check(
      `${input.id}:fixed-controls-container-count`,
      fixedControls.container.onScreenCount === 1,
      1,
      fixedControls.container.onScreenCount,
    ),
  );
  checks.push(
    check(
      `${input.id}:fixed-controls-only`,
      JSON.stringify(fixedIds) === JSON.stringify(FIXED_CONTROL_TEST_IDS),
      FIXED_CONTROL_TEST_IDS,
      fixedIds,
    ),
  );
  checks.push(
    check(
      `${input.id}:fixed-controls-order`,
      fixedXs.length === 3 && fixedXs[0] < fixedXs[1] && fixedXs[1] < fixedXs[2],
      "bottom < summary < right",
      fixedXs,
    ),
  );
  checks.push(
    check(
      `${input.id}:fixed-controls-size`,
      fixedControls.entries.length === 3 &&
        fixedControls.entries.every((entry) => sizeMatches(entry, EXPECTED_HEADER_CONTROL_SIZE)),
      "three 28x28 controls",
      fixedControls.entries.map((entry) => entry.rect),
    ),
  );
  checks.push(
    check(
      `${input.id}:fixed-controls-baseline`,
      fixedYs.length === 3 && Math.max(...fixedYs) - Math.min(...fixedYs) <= 1,
      "<=1px",
      fixedYs,
    ),
  );
  checks.push(
    check(
      `${input.id}:bottom-chinese-label`,
      onScreen("bottom")?.ariaLabel === "切换底部面板显示",
      "切换底部面板显示",
      onScreen("bottom")?.ariaLabel ?? null,
    ),
  );
  checks.push(
    check(
      `${input.id}:bottom-chinese-title`,
      onScreen("bottom")?.title === "切换底部面板显示",
      "切换底部面板显示",
      onScreen("bottom")?.title ?? null,
    ),
  );
  checks.push(
    check(
      `${input.id}:summary-chinese-label`,
      onScreen("summary")?.ariaLabel === summaryLabel,
      summaryLabel,
      onScreen("summary")?.ariaLabel ?? null,
    ),
  );
  checks.push(
    check(
      `${input.id}:summary-chinese-title`,
      onScreen("summary")?.title === summaryLabel,
      summaryLabel,
      onScreen("summary")?.title ?? null,
    ),
  );
  checks.push(
    check(
      `${input.id}:right-chinese-label`,
      onScreen("right")?.ariaLabel === "显示/隐藏侧边栏",
      "显示/隐藏侧边栏",
      onScreen("right")?.ariaLabel ?? null,
    ),
  );
  checks.push(
    check(
      `${input.id}:right-chinese-title`,
      onScreen("right")?.title === "显示/隐藏侧边栏",
      "显示/隐藏侧边栏",
      onScreen("right")?.title ?? null,
    ),
  );

  return { fixedControls, controls, checks };
}

async function collectState(page, input) {
  const fixedControlContract = await fixedControlContractEvidence(page, input);
  const { fixedControls, controls } = fixedControlContract;
  const summaryPanel = await summaryPanelEvidence(page);
  const dock = await dockGeometry(page);
  const drawer = await drawerGeometry(page);
  const drawerChrome = await drawerChromeEvidence(page);
  const checks = [...fixedControlContract.checks];
  const onScreen = (name) => controls[name].onScreen[0] ?? null;

  if (input.id === "closed-overlay") {
    checks.push(
      check(
        `${input.id}:summary-hidden`,
        summaryPanel.onScreenCount === 0,
        0,
        summaryPanel.onScreenCount,
      ),
    );
    checks.push(
      check(
        `${input.id}:bottom-closed`,
        onScreen("bottom")?.ariaPressed === "false",
        false,
        onScreen("bottom")?.ariaPressed ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:right-closed`,
        onScreen("right")?.ariaPressed === "false",
        false,
        onScreen("right")?.ariaPressed ?? null,
      ),
    );
  }
  if (input.id === "summary-overlay-open") {
    const visibleSummary = summaryPanel.onScreen[0] ?? null;
    checks.push(
      check(
        `${input.id}:summary-overlay-visible`,
        summaryPanel.onScreenCount === 1 && visibleSummary?.presentation === "overlay",
        "one overlay",
        summaryPanel.onScreen,
      ),
    );
    checks.push(
      check(
        `${input.id}:summary-panel-width`,
        Math.abs((visibleSummary?.rect?.width ?? 0) - EXPECTED_SUMMARY_PANEL_WIDTH) <= 1,
        EXPECTED_SUMMARY_PANEL_WIDTH,
        visibleSummary?.rect?.width ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:summary-pressed`,
        onScreen("summary")?.ariaPressed === "true",
        true,
        onScreen("summary")?.ariaPressed ?? null,
      ),
    );
  }
  if (input.id === "bottom-drawer") {
    const drawerButtons = drawerChrome?.buttons ?? [];
    checks.push(
      check(
        `${input.id}:bottom-pressed`,
        onScreen("bottom")?.ariaPressed === "true",
        true,
        onScreen("bottom")?.ariaPressed ?? null,
      ),
    );
    checks.push(check(`${input.id}:drawer-visible`, Boolean(drawer), true, Boolean(drawer)));
    checks.push(
      check(
        `${input.id}:drawer-height`,
        Boolean(drawer) && Math.abs(drawer.height - EXPECTED_DRAWER_HEIGHT) <= 1,
        EXPECTED_DRAWER_HEIGHT,
        drawer?.height ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-single-tab`,
        drawerChrome?.tabs.length === 1 &&
          drawerChrome.tabs[0]?.ariaPressed === "true" &&
          Boolean(drawerChrome.tabs[0]?.title),
        "one active titled tab",
        drawerChrome?.tabs ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-single-plus`,
        drawerChrome?.plusCount === 1,
        1,
        drawerChrome?.plusCount ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-single-close`,
        drawerChrome?.closeCount === 1,
        1,
        drawerChrome?.closeCount ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-only-tab-plus-close`,
        drawerChrome?.headerFound === true && drawerButtons.length === 3,
        "tab + plus + close",
        drawerButtons,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-no-workspace-actions`,
        drawerChrome?.forbidden.length === 0,
        [],
        drawerChrome?.forbidden ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-no-runtime-error`,
        drawerChrome?.runtimeErrorCount === 0,
        0,
        drawerChrome?.runtimeErrorCount ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:drawer-motion-contract`,
        drawer?.motionDurationMs === "500" &&
          drawer.motionBounce === "0.1" &&
          drawer.transitionDuration.split(",").some((value) => value.trim() === "0.5s"),
        "500ms spring with 0.1 bounce",
        drawer ?? null,
      ),
    );
  }
  if (input.id === "right-regular") {
    const duplicateCount = await page
      .locator(
        `${SELECTORS.dockPanel} ${SELECTORS.bottom}, ${SELECTORS.dockPanel} ${SELECTORS.summary}, ${SELECTORS.dockPanel} ${SELECTORS.right}`,
      )
      .count();
    checks.push(
      check(
        `${input.id}:right-pressed`,
        onScreen("right")?.ariaPressed === "true",
        true,
        onScreen("right")?.ariaPressed ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:right-dock-visible`,
        dock?.state === "expanded",
        "expanded",
        dock?.state ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:right-dock-no-fixed-control-duplicates`,
        duplicateCount === 0,
        0,
        duplicateCount,
      ),
    );
    checks.push(
      check(
        `${input.id}:right-dock-motion-contract`,
        dock?.motionDurationMs === "500" &&
          dock.motionBounce === "0.1" &&
          dock.panelTransitionDuration.split(",").some((value) => value.trim() === "0.5s") &&
          dock.gapTransitionDuration?.split(",").some((value) => value.trim() === "0.5s"),
        "500ms spring with 0.1 bounce on panel and gap",
        dock ?? null,
      ),
    );
  }
  if (input.id === "summary-inline-pinned") {
    const visibleSummary = summaryPanel.onScreen[0] ?? null;
    checks.push(
      check(
        `${input.id}:summary-inline-visible`,
        summaryPanel.onScreenCount === 1 && visibleSummary?.presentation === "inline",
        "one inline panel",
        summaryPanel.onScreen,
      ),
    );
    checks.push(
      check(
        `${input.id}:summary-panel-width`,
        Math.abs((visibleSummary?.rect?.width ?? 0) - EXPECTED_SUMMARY_PANEL_WIDTH) <= 1,
        EXPECTED_SUMMARY_PANEL_WIDTH,
        visibleSummary?.rect?.width ?? null,
      ),
    );
    checks.push(
      check(
        `${input.id}:summary-pressed`,
        onScreen("summary")?.ariaPressed === "true",
        true,
        onScreen("summary")?.ariaPressed ?? null,
      ),
    );
  }
  checks.push(...(input.extraChecks ?? []));
  const screenshotPath = join(input.evidenceDir, `${input.index}-${input.id}.png`);
  const absoluteScreenshotPath = repoPath(screenshotPath);
  mkdirSync(dirname(absoluteScreenshotPath), { recursive: true });
  await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
  return {
    id: input.id,
    status: checks.every((item) => item.pass) ? "pass" : "fail",
    screenshotPath: displayPath(screenshotPath),
    fixedControls,
    controls,
    summaryPanel,
    dock,
    drawer,
    drawerChrome,
    checks,
  };
}

async function clickControl(page, selector) {
  const control = await viewportLocator(page, selector);
  await control.click();
}

async function collectSpecialState(page, input) {
  const fixedControlContract = input.summaryPresentation
    ? await fixedControlContractEvidence(page, input)
    : null;
  const checks = [...(fixedControlContract?.checks ?? []), ...input.checks];
  const screenshotPath = join(input.evidenceDir, `${input.index}-${input.id}.png`);
  const absoluteScreenshotPath = repoPath(screenshotPath);
  mkdirSync(dirname(absoluteScreenshotPath), { recursive: true });
  await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
  return {
    id: input.id,
    status: checks.every((item) => item.pass) ? "pass" : "fail",
    screenshotPath: displayPath(screenshotPath),
    ...(fixedControlContract
      ? {
          fixedControls: fixedControlContract.fixedControls,
          controls: fixedControlContract.controls,
        }
      : {}),
    ...(input.evidence ?? {}),
    checks,
  };
}

async function composerEvidence(page) {
  return page.evaluate(
    ({ editorSelector, sendSelector, userRowsSelector }) => {
      const editor = document.querySelector(editorSelector);
      const selection = window.getSelection();
      const focused =
        editor instanceof HTMLElement &&
        (document.activeElement === editor || editor.contains(document.activeElement));
      let caretAtEnd = false;
      if (
        editor instanceof HTMLElement &&
        selection &&
        selection.rangeCount > 0 &&
        selection.isCollapsed &&
        editor.contains(selection.focusNode)
      ) {
        const tail = document.createRange();
        tail.selectNodeContents(editor);
        tail.setStart(selection.focusNode, selection.focusOffset);
        caretAtEnd = tail.toString().length === 0;
      }
      const send = document.querySelector(sendSelector);
      return {
        textContent: editor?.textContent ?? "",
        innerText: editor instanceof HTMLElement ? editor.innerText : "",
        focused,
        caretAtEnd,
        userRowCount: document.querySelectorAll(userRowsSelector).length,
        href: window.location.href,
        sendAriaLabel: send?.getAttribute("aria-label") ?? null,
        sendDisabled: send instanceof HTMLButtonElement ? send.disabled : null,
      };
    },
    {
      editorSelector: SELECTORS.editor,
      sendSelector: SELECTORS.send,
      userRowsSelector: SELECTORS.userRows,
    },
  );
}

async function clearComposer(page) {
  const editor = page.locator(SELECTORS.editor);
  await editor.click();
  await page.keyboard.press("Meta+A");
  await page.keyboard.press("Backspace");
  await page.waitForFunction(
    (selector) => (document.querySelector(selector)?.textContent ?? "").length === 0,
    SELECTORS.editor,
  );
}

async function pressMacShortcut(page, key, { alt = false, shift = false } = {}) {
  await page.keyboard.down("Meta");
  if (alt) {
    await page.keyboard.down("Alt");
  }
  if (shift) {
    await page.keyboard.down("Shift");
  }
  await page.keyboard.press(key);
  if (shift) {
    await page.keyboard.up("Shift");
  }
  if (alt) {
    await page.keyboard.up("Alt");
  }
  await page.keyboard.up("Meta");
}

async function terminalStateSnapshot(page) {
  return page.evaluate(
    ({ storageKey, threadId }) => {
      const raw = window.localStorage.getItem(storageKey);
      let parsed = null;
      try {
        parsed = raw ? JSON.parse(raw) : null;
      } catch {
        parsed = null;
      }
      const persistedState = parsed?.state?.terminalStateByThreadId?.[threadId] ?? null;
      // The product store deliberately prunes a thread entry when it returns to the
      // exact default state. Read the effective selector state here so a closed
      // default terminal is not misreported as unknown/null by the acceptance gate.
      const state = persistedState ?? {
        terminalOpen: false,
        presentationMode: "drawer",
        terminalHeight: 280,
        terminalIds: ["default"],
        activeTerminalId: "default",
        terminalGroups: [
          {
            id: "group-default",
            activeTerminalId: "default",
            layout: {
              type: "terminal",
              paneId: "pane-default",
              terminalIds: ["default"],
              activeTerminalId: "default",
            },
          },
        ],
      };
      return {
        raw,
        persisted: persistedState !== null,
        terminalOpen: state.terminalOpen,
        presentationMode: state.presentationMode,
        terminalHeight: state.terminalHeight,
        terminalIds: state.terminalIds,
        activeTerminalId: state.activeTerminalId,
        terminalGroups: state.terminalGroups,
      };
    },
    { storageKey: TERMINAL_STATE_STORAGE_KEY, threadId: THREAD_ID },
  );
}

async function drawerHeightStorageEvidence(page) {
  return page.evaluate((storageKey) => {
    const raw = window.localStorage.getItem(storageKey);
    let value = null;
    try {
      value = raw === null ? null : JSON.parse(raw);
    } catch {
      value = null;
    }
    return { raw, value };
  }, TERMINAL_DRAWER_HEIGHT_STORAGE_KEY);
}

async function dragDrawerToHeight(page, targetHeight) {
  const drawer = await drawerGeometry(page);
  if (!drawer) throw new Error("Cannot resize a missing terminal drawer.");
  const handle = page.locator(SELECTORS.drawerResize).last();
  const handleRect = await handle.boundingBox();
  if (!handleRect) throw new Error("Terminal drawer resize handle has no geometry.");
  const deltaY = drawer.height - targetHeight;
  const startX = handleRect.x + handleRect.width / 2;
  const startY = handleRect.y + handleRect.height / 2;
  await page.mouse.move(startX, startY);
  await page.mouse.down();
  await page.mouse.move(startX, startY + deltaY, { steps: 8 });
  await page.mouse.up();
  await settleFrame(page);
}

async function rightFullWidthEvidence(page) {
  const panel = page.locator(SELECTORS.dockPanel).first();
  return panel.evaluate(
    (element, selectors) => {
      const panelRect = element.getBoundingClientRect();
      const provider = element.closest("[data-testid='right-dock-provider']");
      const shell = provider?.parentElement ?? null;
      const shellRect = shell?.getBoundingClientRect() ?? null;
      const sidebar = element.closest("[data-slot='sidebar']");
      const panelStyle = window.getComputedStyle(element);
      const toRect = (rect) =>
        rect
          ? {
              x: Math.round(rect.x * 100) / 100,
              y: Math.round(rect.y * 100) / 100,
              width: Math.round(rect.width * 100) / 100,
              height: Math.round(rect.height * 100) / 100,
            }
          : null;
      const mainHeader = document.querySelector(selectors.mainHeader);
      const mainHeaderRect = mainHeader?.getBoundingClientRect() ?? null;
      const mainHeaderStyle = mainHeader ? window.getComputedStyle(mainHeader) : null;
      const controls = sidebar
        ? [
            ...sidebar.querySelectorAll(
              `${selectors.bottom}, ${selectors.summary}, ${selectors.right}`,
            ),
          ]
            .map((control) => {
              const rect = control.getBoundingClientRect();
              return {
                testId: control.getAttribute("data-testid"),
                ariaLabel: control.getAttribute("aria-label"),
                ariaPressed: control.getAttribute("aria-pressed"),
                width: rect.width,
                height: rect.height,
                visible: rect.width > 0 && rect.height > 0,
              };
            })
            .filter((entry) => entry.visible)
        : [];
      return {
        panelRect: toRect(panelRect),
        shellRect: toRect(shellRect),
        borderLeftWidth: panelStyle.borderLeftWidth,
        borderLeftStyle: panelStyle.borderLeftStyle,
        resizerCount: sidebar?.querySelectorAll("[data-slot='sidebar-rail']").length ?? null,
        mainHeader: {
          exists: Boolean(mainHeader),
          ariaHidden: mainHeader?.getAttribute("aria-hidden") ?? null,
          inert: mainHeader instanceof HTMLElement ? mainHeader.inert : null,
          hidden: mainHeader instanceof HTMLElement ? mainHeader.hidden : null,
          display: mainHeaderStyle?.display ?? null,
          inViewport: Boolean(
            mainHeaderRect &&
            mainHeaderRect.width > 0 &&
            mainHeaderRect.height > 0 &&
            mainHeaderStyle?.visibility !== "hidden" &&
            mainHeaderStyle?.display !== "none",
          ),
        },
        controls,
      };
    },
    {
      bottom: SELECTORS.bottom,
      summary: SELECTORS.summary,
      right: SELECTORS.right,
      mainHeader: SELECTORS.mainHeader,
    },
  );
}

async function bottomShellGeometry(page) {
  return page.evaluate((selectors) => {
    const toRect = (element) => {
      if (!(element instanceof Element)) return null;
      const rect = element.getBoundingClientRect();
      return {
        x: Math.round(rect.x * 100) / 100,
        y: Math.round(rect.y * 100) / 100,
        top: Math.round(rect.top * 100) / 100,
        right: Math.round(rect.right * 100) / 100,
        bottom: Math.round(rect.bottom * 100) / 100,
        left: Math.round(rect.left * 100) / 100,
        width: Math.round(rect.width * 100) / 100,
        height: Math.round(rect.height * 100) / 100,
      };
    };
    const shell = document.querySelector(selectors.layoutShell);
    const row = document.querySelector(selectors.mainRow);
    const host = document.querySelector(selectors.bottomHost);
    const drawer = [...document.querySelectorAll(selectors.drawer)].at(-1) ?? null;
    const dock = document.querySelector(selectors.dockPanel);
    const drawerStyle = drawer ? window.getComputedStyle(drawer) : null;
    const dockContainer = dock?.closest("[data-slot='sidebar-container']") ?? null;
    const dockContainerStyle = dockContainer ? window.getComputedStyle(dockContainer) : null;
    return {
      shell: toRect(shell),
      row: toRect(row),
      host: toRect(host),
      drawer: toRect(drawer),
      dock: toRect(dock),
      drawerPosition: drawerStyle?.position ?? null,
      dockContainerPosition: dockContainerStyle?.position ?? null,
    };
  }, SELECTORS);
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

async function runSmoke(options) {
  const runtimeDir = mkdtempSync(join(tmpdir(), "moss-right-controls-smoke-"));
  const mossHome = join(runtimeDir, "moss-home");
  const electronUserDataDir = join(runtimeDir, "electron-user-data");
  mkdirSync(mossHome, { recursive: true });
  mkdirSync(electronUserDataDir, { recursive: true });
  const baseInit = dumpProductShellInitScript(options.createdAt, runtimeDir);
  const importedPlaywright = await import(resolvePlaywrightModuleUrl());
  const electron = importedPlaywright._electron ?? importedPlaywright.default?._electron;
  if (!electron) throw new Error("Playwright Electron launcher is unavailable.");
  const electronEnv = { ...process.env };
  delete electronEnv.VITE_DEV_SERVER_URL;
  reportProgress("launching isolated Electron");
  const electronApp = await electron.launch({
    executablePath: resolveElectronPath(),
    args: [`--user-data-dir=${electronUserDataDir}`, MAIN_JS],
    cwd: DESKTOP_ROOT,
    env: {
      ...electronEnv,
      MOSS_HOME: mossHome,
      DPCODE_HOME: mossHome,
      T3CODE_HOME: mossHome,
      T3CODE_DISABLE_AUTO_UPDATE: "1",
      // main.ts intentionally derives userData from the platform app-data root.
      // Point every supported platform root at this run's temp directory so the
      // smoke neither reads nor mutates the developer's real Moss profile.
      HOME: runtimeDir,
      XDG_CONFIG_HOME: join(runtimeDir, "xdg-config"),
      APPDATA: join(runtimeDir, "appdata"),
      LOCALAPPDATA: join(runtimeDir, "local-appdata"),
    },
    timeout: options.timeoutMs,
  });
  reportProgress("isolated Electron connected");

  try {
    await electronApp.firstWindow({ timeout: options.timeoutMs });
    const page = await waitForMainWindow(electronApp, options.timeoutMs);
    reportProgress("first window ready");
    await page.setViewportSize(OVERLAY_VIEWPORT);
    const initScript = `${baseInit}\n${rightControlsStorageInitScript()}`;
    await page.addInitScript({ content: initScript });
    await page.evaluate(initScript);
    await page.goto(DESKTOP_ROUTE, {
      waitUntil: "domcontentloaded",
      timeout: options.timeoutMs,
    });
    reportProgress("fixture route loaded");
    await page.locator(SELECTORS.composer).waitFor({ state: "visible", timeout: 30_000 });
    reportProgress("composer visible");
    await waitForDockState(page, "collapsed");
    reportProgress("right dock collapsed");
    await waitForSummaryLabel(page, "切换摘要");
    reportProgress("overlay summary control ready");
    await waitForSummaryPanel(page, "overlay", false);
    reportProgress("initial state ready");

    const states = [];
    states.push(
      await collectState(page, {
        id: "closed-overlay",
        index: "00",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
      }),
    );

    await clickControl(page, SELECTORS.summary);
    await waitForSummaryPanel(page, "overlay", true);
    states.push(
      await collectState(page, {
        id: "summary-overlay-open",
        index: "01",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
      }),
    );

    const composerBeforeCreate = await composerEvidence(page);
    await (await viewportLocator(page, SELECTORS.outputTrigger)).click();
    await page.getByRole("menuitem", { name: "创建文档", exact: true }).click();
    await page.waitForFunction(
      ({ selector, expected }) => document.querySelector(selector)?.textContent === expected,
      {
        selector: SELECTORS.editor,
        expected: EXPECTED_SUMMARY_DOCUMENT_PROMPT,
      },
    );
    await settleFrame(page);
    const composerAfterCreate = await composerEvidence(page);
    states.push(
      await collectSpecialState(page, {
        id: "summary-create-document-draft",
        index: "02",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
        evidence: {
          composerBeforeCreate,
          composerAfterCreate,
        },
        checks: [
          check(
            "summary-create-document-draft:summary-document-prompt-exact",
            composerAfterCreate.textContent === EXPECTED_SUMMARY_DOCUMENT_PROMPT,
            EXPECTED_SUMMARY_DOCUMENT_PROMPT,
            composerAfterCreate.textContent,
          ),
          check(
            "summary-create-document-draft:summary-document-editor-focused",
            composerAfterCreate.focused,
            true,
            composerAfterCreate.focused,
          ),
          check(
            "summary-create-document-draft:summary-document-caret-at-end",
            composerAfterCreate.caretAtEnd,
            true,
            composerAfterCreate.caretAtEnd,
          ),
          check(
            "summary-create-document-draft:summary-document-not-submitted",
            composerAfterCreate.userRowCount === composerBeforeCreate.userRowCount &&
              composerAfterCreate.href === composerBeforeCreate.href,
            {
              userRowCount: composerBeforeCreate.userRowCount,
              href: composerBeforeCreate.href,
            },
            {
              userRowCount: composerAfterCreate.userRowCount,
              href: composerAfterCreate.href,
            },
          ),
        ],
      }),
    );
    await clearComposer(page);
    const summaryControlAfterCreate = await viewportLocator(page, SELECTORS.summary);
    if ((await summaryControlAfterCreate.getAttribute("aria-pressed")) === "true") {
      await summaryControlAfterCreate.click();
    }
    await waitForSummaryPanel(page, "overlay", false);

    await clickControl(page, SELECTORS.bottom);
    await waitForDrawer(page, true);
    const terminalBeforeClose = await terminalStateSnapshot(page);
    await page.locator(SELECTORS.drawerClose).last().click();
    await waitForDrawer(page, false);
    const terminalAfterClose = await terminalStateSnapshot(page);
    await page.evaluate(() => {
      window.__mossRightControlsShortcutProbe = [];
      window.addEventListener(
        "keydown",
        (event) => {
          window.__mossRightControlsShortcutProbe.push({
            key: event.key,
            code: event.code,
            metaKey: event.metaKey,
            ctrlKey: event.ctrlKey,
            altKey: event.altKey,
            shiftKey: event.shiftKey,
            defaultPrevented: event.defaultPrevented,
          });
        },
        { capture: true },
      );
    });
    await pressMacShortcut(page, "j");
    await page.waitForTimeout(250);
    const shortcutProbe = await page.evaluate(
      (drawerSelector) => ({
        events: window.__mossRightControlsShortcutProbe ?? [],
        platform: window.navigator.platform,
        activeTag: document.activeElement?.tagName ?? null,
        activeTestId: document.activeElement?.getAttribute("data-testid") ?? null,
        drawerCount: document.querySelectorAll(drawerSelector).length,
      }),
      SELECTORS.drawer,
    );
    reportProgress(`first Cmd+J probe ${JSON.stringify(shortcutProbe)}`);
    await waitForDrawer(page, true);
    const terminalAfterReopen = await terminalStateSnapshot(page);
    const terminalIdsPreserved =
      JSON.stringify(terminalAfterClose.terminalIds) ===
        JSON.stringify(terminalBeforeClose.terminalIds) &&
      JSON.stringify(terminalAfterReopen.terminalIds) ===
        JSON.stringify(terminalBeforeClose.terminalIds);
    const terminalGroupsPreserved =
      JSON.stringify(terminalAfterClose.terminalGroups) ===
        JSON.stringify(terminalBeforeClose.terminalGroups) &&
      JSON.stringify(terminalAfterReopen.terminalGroups) ===
        JSON.stringify(terminalBeforeClose.terminalGroups);
    states.push(
      await collectSpecialState(page, {
        id: "bottom-x-preserves-tab",
        index: "03",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
        evidence: {
          terminalBeforeClose,
          terminalAfterClose,
          terminalAfterReopen,
        },
        checks: [
          check(
            "bottom-x-preserves-tab:bottom-x-closes-drawer",
            terminalAfterClose.terminalOpen === false,
            false,
            terminalAfterClose.terminalOpen,
          ),
          check(
            "bottom-x-preserves-tab:bottom-x-preserves-terminal-ids",
            terminalIdsPreserved,
            terminalBeforeClose.terminalIds,
            {
              afterClose: terminalAfterClose.terminalIds,
              afterReopen: terminalAfterReopen.terminalIds,
            },
          ),
          check(
            "bottom-x-preserves-tab:bottom-x-preserves-active-terminal",
            terminalAfterClose.activeTerminalId === terminalBeforeClose.activeTerminalId &&
              terminalAfterReopen.activeTerminalId === terminalBeforeClose.activeTerminalId,
            terminalBeforeClose.activeTerminalId,
            {
              afterClose: terminalAfterClose.activeTerminalId,
              afterReopen: terminalAfterReopen.activeTerminalId,
            },
          ),
          check(
            "bottom-x-preserves-tab:bottom-x-preserves-terminal-groups",
            terminalGroupsPreserved,
            terminalBeforeClose.terminalGroups,
            {
              afterClose: terminalAfterClose.terminalGroups,
              afterReopen: terminalAfterReopen.terminalGroups,
            },
          ),
          check(
            "bottom-x-preserves-tab:bottom-x-reopens-same-tab",
            terminalAfterReopen.terminalOpen === true &&
              terminalAfterReopen.activeTerminalId === terminalBeforeClose.activeTerminalId,
            {
              terminalOpen: true,
              activeTerminalId: terminalBeforeClose.activeTerminalId,
            },
            {
              terminalOpen: terminalAfterReopen.terminalOpen,
              activeTerminalId: terminalAfterReopen.activeTerminalId,
            },
          ),
        ],
      }),
    );

    const bottomShortcutOpened = terminalAfterReopen.terminalOpen === true;
    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, false);
    const bottomShortcutClosed = (await terminalStateSnapshot(page)).terminalOpen === false;
    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, true);
    const bottomShortcutReopened = (await terminalStateSnapshot(page)).terminalOpen === true;
    states.push(
      await collectState(page, {
        id: "bottom-drawer",
        index: "04",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
        extraChecks: [
          check(
            "bottom-drawer:bottom-shortcut-opens",
            bottomShortcutOpened,
            true,
            bottomShortcutOpened,
          ),
          check(
            "bottom-drawer:bottom-shortcut-closes",
            bottomShortcutClosed,
            true,
            bottomShortcutClosed,
          ),
          check(
            "bottom-drawer:bottom-shortcut-reopens",
            bottomShortcutReopened,
            true,
            bottomShortcutReopened,
          ),
        ],
      }),
    );

    await dragDrawerToHeight(page, EXPECTED_RESIZED_DRAWER_HEIGHT);
    await waitForDrawer(page, true, EXPECTED_RESIZED_DRAWER_HEIGHT);
    const resizedStorage = await drawerHeightStorageEvidence(page);
    const resizedTerminal = await terminalStateSnapshot(page);
    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, false);
    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, true, EXPECTED_RESIZED_DRAWER_HEIGHT);
    const reopenedPersistedHeight = (await drawerGeometry(page))?.height ?? null;
    await dragDrawerToHeight(page, 140);
    await waitForDrawer(page, false);
    const underMinStorage = await drawerHeightStorageEvidence(page);
    const underMinTerminal = await terminalStateSnapshot(page);
    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, true, EXPECTED_RESIZED_DRAWER_HEIGHT);
    const underMinReopenedHeight = (await drawerGeometry(page))?.height ?? null;
    states.push(
      await collectSpecialState(page, {
        id: "bottom-height-behavior",
        index: "05",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
        evidence: {
          resizedStorage,
          resizedTerminal,
          reopenedPersistedHeight,
          underMinStorage,
          underMinTerminal,
          underMinReopenedHeight,
        },
        checks: [
          check(
            "bottom-height-behavior:bottom-resize-height",
            resizedTerminal.terminalHeight === EXPECTED_RESIZED_DRAWER_HEIGHT,
            EXPECTED_RESIZED_DRAWER_HEIGHT,
            resizedTerminal.terminalHeight,
          ),
          check(
            "bottom-height-behavior:bottom-resize-storage",
            resizedStorage.raw === JSON.stringify(EXPECTED_RESIZED_DRAWER_HEIGHT),
            JSON.stringify(EXPECTED_RESIZED_DRAWER_HEIGHT),
            resizedStorage.raw,
          ),
          check(
            "bottom-height-behavior:bottom-resize-thread-state",
            resizedTerminal.terminalHeight === EXPECTED_RESIZED_DRAWER_HEIGHT,
            EXPECTED_RESIZED_DRAWER_HEIGHT,
            resizedTerminal.terminalHeight,
          ),
          check(
            "bottom-height-behavior:bottom-resize-reopens-persisted",
            Math.abs((reopenedPersistedHeight ?? 0) - EXPECTED_RESIZED_DRAWER_HEIGHT) <= 1,
            EXPECTED_RESIZED_DRAWER_HEIGHT,
            reopenedPersistedHeight,
          ),
          check(
            "bottom-height-behavior:bottom-under-min-closes",
            underMinTerminal.terminalOpen === false,
            false,
            underMinTerminal.terminalOpen,
          ),
          check(
            "bottom-height-behavior:bottom-under-min-keeps-storage",
            underMinStorage.raw === JSON.stringify(EXPECTED_RESIZED_DRAWER_HEIGHT),
            JSON.stringify(EXPECTED_RESIZED_DRAWER_HEIGHT),
            underMinStorage.raw,
          ),
          check(
            "bottom-height-behavior:bottom-under-min-reopens-persisted",
            Math.abs((underMinReopenedHeight ?? 0) - EXPECTED_RESIZED_DRAWER_HEIGHT) <= 1,
            EXPECTED_RESIZED_DRAWER_HEIGHT,
            underMinReopenedHeight,
          ),
        ],
      }),
    );

    await page.keyboard.press("Meta+J");
    await waitForDrawer(page, false);
    await page.keyboard.press("Meta+Alt+B");
    await waitForDockState(page, "expanded");
    const rightShortcutOpened = (await viewportLocator(page, SELECTORS.right)).getAttribute(
      "aria-pressed",
    );
    await page.keyboard.press("Meta+Alt+B");
    await waitForDockState(page, "collapsed");
    const rightShortcutClosed = (await viewportLocator(page, SELECTORS.right)).getAttribute(
      "aria-pressed",
    );
    await page.keyboard.press("Meta+Alt+B");
    await waitForDockState(page, "expanded");
    const rightShortcutReopened = (await viewportLocator(page, SELECTORS.right)).getAttribute(
      "aria-pressed",
    );
    states.push(
      await collectState(page, {
        id: "right-regular",
        index: "06",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "overlay",
        extraChecks: [
          check(
            "right-regular:right-shortcut-opens",
            (await rightShortcutOpened) === "true",
            true,
            await rightShortcutOpened,
          ),
          check(
            "right-regular:right-shortcut-closes",
            (await rightShortcutClosed) === "false",
            false,
            await rightShortcutClosed,
          ),
          check(
            "right-regular:right-shortcut-reopens",
            (await rightShortcutReopened) === "true",
            true,
            await rightShortcutReopened,
          ),
        ],
      }),
    );

    await page.locator(SELECTORS.widthToggle).click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute("aria-pressed") === "true",
      SELECTORS.widthToggle,
    );
    await waitForDockGeometryStable(page);
    const fullWidthBeforeActions = await rightFullWidthEvidence(page);
    await clickControl(page, SELECTORS.bottom);
    await waitForDrawer(page, true, EXPECTED_RESIZED_DRAWER_HEIGHT);
    const fullWidthBottomWorked = true;
    const fullWidthBottomGeometry = await bottomShellGeometry(page);
    await clickControl(page, SELECTORS.bottom);
    await waitForDrawer(page, false);
    await clickControl(page, SELECTORS.right);
    await waitForDockState(page, "collapsed");
    const fullWidthCollapseWorked = true;
    await page.keyboard.press("Meta+Alt+B");
    await waitForDockState(page, "expanded");
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute("aria-pressed") === "true",
      SELECTORS.widthToggle,
    );
    await waitForDockGeometryStable(page);
    const fullWidthAfterReopen = await rightFullWidthEvidence(page);
    const fillsShell = (evidence) =>
      Boolean(
        evidence.panelRect &&
        evidence.shellRect &&
        Math.abs(evidence.panelRect.x - evidence.shellRect.x) <= 1 &&
        Math.abs(evidence.panelRect.width - evidence.shellRect.width) <= 1,
      );
    const replacementControlIds = fullWidthAfterReopen.controls.map((entry) => entry.testId);
    states.push(
      await collectSpecialState(page, {
        id: "right-full-width",
        index: "07",
        evidenceDir: options.evidenceDir,
        evidence: {
          fullWidthBeforeActions,
          fullWidthAfterReopen,
          fullWidthBottomGeometry,
        },
        checks: [
          check(
            "right-full-width:right-full-width-fills-shell",
            fillsShell(fullWidthBeforeActions) && fillsShell(fullWidthAfterReopen),
            "panel exactly fills shell before and after reopen",
            { fullWidthBeforeActions, fullWidthAfterReopen },
          ),
          check(
            "right-full-width:right-full-width-no-divider",
            fullWidthAfterReopen.borderLeftWidth === "0px" ||
              fullWidthAfterReopen.borderLeftStyle === "none",
            "no left divider",
            {
              borderLeftWidth: fullWidthAfterReopen.borderLeftWidth,
              borderLeftStyle: fullWidthAfterReopen.borderLeftStyle,
            },
          ),
          check(
            "right-full-width:right-full-width-no-resizer",
            fullWidthAfterReopen.resizerCount === 0,
            0,
            fullWidthAfterReopen.resizerCount,
          ),
          check(
            "right-full-width:right-full-width-main-header-hidden",
            !fullWidthAfterReopen.mainHeader.exists ||
              fullWidthAfterReopen.mainHeader.ariaHidden === "true" ||
              fullWidthAfterReopen.mainHeader.inert === true ||
              fullWidthAfterReopen.mainHeader.hidden === true ||
              fullWidthAfterReopen.mainHeader.display === "none" ||
              fullWidthAfterReopen.mainHeader.inViewport === false,
            "main chat header hidden and inaccessible",
            fullWidthAfterReopen.mainHeader,
          ),
          check(
            "right-full-width:right-full-width-replacement-controls-only",
            JSON.stringify(replacementControlIds) ===
              JSON.stringify([
                "chat-header-bottom-panel-toggle",
                "chat-header-right-dock-toggle",
              ]) &&
              fullWidthAfterReopen.controls.every(
                (entry) =>
                  Math.abs(entry.width - EXPECTED_HEADER_CONTROL_SIZE) <= 1 &&
                  Math.abs(entry.height - EXPECTED_HEADER_CONTROL_SIZE) <= 1,
              ),
            ["chat-header-bottom-panel-toggle", "chat-header-right-dock-toggle"],
            fullWidthAfterReopen.controls,
          ),
          check(
            "right-full-width:right-full-width-bottom-control-works",
            fullWidthBottomWorked,
            true,
            fullWidthBottomWorked,
          ),
          check(
            "right-full-width:right-full-width-bottom-panel-normal-flow",
            Boolean(
              fullWidthBottomGeometry.shell &&
              fullWidthBottomGeometry.host &&
              fullWidthBottomGeometry.drawer &&
              fullWidthBottomGeometry.drawerPosition !== "fixed" &&
              Math.abs(
                fullWidthBottomGeometry.drawer.width - fullWidthBottomGeometry.shell.width,
              ) <= 1 &&
              Math.abs(fullWidthBottomGeometry.drawer.left - fullWidthBottomGeometry.shell.left) <=
                1 &&
              Math.abs(
                fullWidthBottomGeometry.host.height - fullWidthBottomGeometry.drawer.height,
              ) <= 1 &&
              Math.abs(
                fullWidthBottomGeometry.host.bottom - fullWidthBottomGeometry.shell.bottom,
              ) <= 1,
            ),
            "normal-flow drawer and host span the shell bottom",
            fullWidthBottomGeometry,
          ),
          check(
            "right-full-width:right-full-width-bottom-panel-compresses-shell-row",
            Boolean(
              fullWidthBottomGeometry.shell &&
              fullWidthBottomGeometry.row &&
              fullWidthBottomGeometry.host &&
              fullWidthBottomGeometry.dock &&
              fullWidthBottomGeometry.dockContainerPosition === "absolute" &&
              Math.abs(
                fullWidthBottomGeometry.row.height +
                  fullWidthBottomGeometry.host.height -
                  fullWidthBottomGeometry.shell.height,
              ) <= 1 &&
              Math.abs(fullWidthBottomGeometry.row.bottom - fullWidthBottomGeometry.host.top) <=
                1 &&
              Math.abs(fullWidthBottomGeometry.dock.top - fullWidthBottomGeometry.row.top) <= 1 &&
              Math.abs(fullWidthBottomGeometry.dock.bottom - fullWidthBottomGeometry.row.bottom) <=
                1,
            ),
            "main row and right dock end at the bottom-panel host",
            fullWidthBottomGeometry,
          ),
          check(
            "right-full-width:right-full-width-collapse-control-works",
            fullWidthCollapseWorked,
            true,
            fullWidthCollapseWorked,
          ),
          check(
            "right-full-width:right-full-width-restores-after-reopen",
            fillsShell(fullWidthAfterReopen),
            true,
            fillsShell(fullWidthAfterReopen),
          ),
        ],
      }),
    );

    await page.locator(SELECTORS.widthToggle).click();
    await page.waitForFunction(
      (selector) => document.querySelector(selector)?.getAttribute("aria-pressed") === "false",
      SELECTORS.widthToggle,
    );
    await waitForDockGeometryStable(page);
    await page.keyboard.press("Meta+Alt+B");
    await waitForDockState(page, "collapsed");
    await page.setViewportSize(INLINE_VIEWPORT);
    await waitForSummaryLabel(page, "切换置顶摘要");
    await waitForSummaryPanel(page, "inline", true);
    states.push(
      await collectState(page, {
        id: "summary-inline-pinned",
        index: "08",
        evidenceDir: options.evidenceDir,
        summaryPresentation: "inline",
      }),
    );

    const runtime = await page.evaluate(() => ({
      href: window.location.href,
      runtimeDataset: document.documentElement.dataset.runtime ?? null,
      hasDesktopBridge: Boolean(window.desktopBridge),
      hasNativeApi: Boolean(window.nativeApi),
    }));
    const allChecks = states.flatMap((state) => state.checks);
    return {
      version: 1,
      createdAt: options.createdAt,
      status: allChecks.every((item) => item.pass) ? "pass" : "fail",
      route: DESKTOP_ROUTE,
      runtime,
      selectors: SELECTORS,
      expected: {
        fixedControlOrder: FIXED_CONTROL_TEST_IDS,
        headerControlSize: EXPECTED_HEADER_CONTROL_SIZE,
        fixedControlLabels: {
          bottom: "切换底部面板显示",
          summaryOverlay: "切换摘要",
          summaryInline: "切换置顶摘要",
          right: "显示/隐藏侧边栏",
        },
        summaryPanelWidth: EXPECTED_SUMMARY_PANEL_WIDTH,
        summaryPresentations: ["overlay", "inline"],
        terminalDrawerHeight: EXPECTED_DRAWER_HEIGHT,
        terminalDrawerChrome: "one tab + one plus + one close; no workspace-only actions",
        regularRightDockFixedControlDuplicates: 0,
      },
      states,
      failedChecks: allChecks.filter((item) => !item.pass),
      runtimeDir,
    };
  } finally {
    await closeElectronApp(electronApp);
  }
}

async function main(argv) {
  const options = parseArgs(argv);
  assertBuiltFile(MAIN_JS, "desktop main bundle");
  assertBuiltFile(PRELOAD_JS, "desktop preload bundle");
  assertBuiltFile(SERVER_ENTRY, "server backend bundle");
  assertBuiltFile(WEB_INDEX, "web bundle");
  let report;
  try {
    report = await runSmoke(options);
  } catch (error) {
    report = {
      version: 1,
      createdAt: options.createdAt,
      status: "fail",
      route: DESKTOP_ROUTE,
      runtime: null,
      selectors: SELECTORS,
      states: [],
      failedChecks: [],
      error: error instanceof Error ? (error.stack ?? error.message) : String(error),
    };
  }
  const absoluteReportPath = repoPath(options.reportPath);
  mkdirSync(dirname(absoluteReportPath), { recursive: true });
  writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
  process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  return report.status === "pass" ? 0 : 1;
}

main(process.argv.slice(2)).then(
  (exitCode) => {
    process.exitCode = exitCode;
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  },
);
