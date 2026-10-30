import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
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
const FIXTURE_PROJECT_NAME = "moss-localization-smoke";

const CREDENTIAL_ENV_KEYS = [
  "ANTHROPIC_API_KEY",
  "AWS_ACCESS_KEY_ID",
  "AWS_PROFILE",
  "AWS_SECRET_ACCESS_KEY",
  "AWS_SESSION_TOKEN",
  "AZURE_OPENAI_API_KEY",
  "GEMINI_API_KEY",
  "GH_ENTERPRISE_TOKEN",
  "GH_HOST",
  "GH_TOKEN",
  "GITHUB_ENTERPRISE_TOKEN",
  "GITHUB_TOKEN",
  "GIT_ASKPASS",
  "GOOGLE_API_KEY",
  "OPENAI_API_KEY",
  "SSH_ASKPASS",
  "SSH_AUTH_SOCK",
];

// These are product names, protocols, model names, file formats, or literal key names that are
// intentionally retained inside Chinese UI. The English detector removes only these exact tokens;
// it does not allow arbitrary Latin sentences containing one of them.
const BASE_ALLOWED_TECHNICAL_TOKENS = [
  "Moss",
  "AppSnap",
  "macOS",
  "iOS",
  "Windows",
  "Linux",
  "Electron",
  "Chromium",
  "GitHub",
  "GitLab",
  "Git",
  "CLI",
  "gh",
  "PR",
  "UI",
  "OS",
  "SSH",
  "GPG",
  "API",
  "URL",
  "URI",
  "HTTP",
  "HTTPS",
  "WebSocket",
  "RPC",
  "IPC",
  "JSON",
  "JSON-RPC",
  "YAML",
  "TOML",
  "SQL",
  "SQLite",
  "CSS",
  "HTML",
  "DOM",
  "JS",
  "JSX",
  "TS",
  "TSX",
  "TypeScript",
  "JavaScript",
  "Node.js",
  "Bun",
  "npm",
  "pnpm",
  "yarn",
  "React",
  "Vite",
  "Vitest",
  "Playwright",
  "Markdown",
  "PDF",
  "PNG",
  "JPEG",
  "SVG",
  "ZIP",
  "DMG",
  "AppImage",
  "MCP",
  "ACP",
  "PTY",
  "TTY",
  "LSP",
  "SDK",
  "OAuth",
  "SSO",
  "SMS",
  "GoTrue",
  "OpenAI",
  "ChatGPT",
  "Codex",
  "Claude",
  "Gemini",
  "Antigravity",
  "Cursor",
  "Grok",
  "Pi",
  "Factory",
  "Droid",
  "Opus",
  "Sonnet",
  "Haiku",
  "GPT",
  "Sol",
  "Qwen",
  "DeepSeek",
  "Kimi",
  "MiniMax",
  "OpenCode",
  "Kilo",
  "Fable",
  "Zed",
  "JetBrains",
  "Finder",
  "Dock",
  "Instruments",
  "Xcode",
  "Homebrew",
  "VS Code",
  "Visual Studio Code",
  "SF Pro",
  "JetBrains Mono",
  "Safari",
  "Chrome",
  "Cookie",
  "ARM",
  "x64",
  "MiB",
  "GiB",
  "KiB",
  "MB",
  "GB",
  "KB",
  "ms",
  "Option",
  "Alt",
  "Cmd",
  "Ctrl",
  "Enter",
  "Esc",
  "Tab",
  "zh-CN",
  "en",
];

function usage() {
  return [
    "Usage:",
    "  node apps/desktop/scripts/moss-localization-smoke.mjs \\",
    "    --evidence-dir /absolute/path/to/evidence [--timeout-ms 120000] [--keep-profile]",
    "",
    "The desktop candidate must already exist. Build it separately with `bun run build:desktop`.",
  ].join("\n");
}

function parseArgs(argv) {
  const options = {
    evidenceDir: undefined,
    keepProfile: false,
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
    if (arg === "--keep-profile") {
      options.keepProfile = true;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      process.stdout.write(`${usage()}\n`);
      process.exit(0);
    }
    throw new Error(`Unknown localization smoke option: ${String(arg)}\n\n${usage()}`);
  }

  if (!options.evidenceDir) {
    throw new Error(`--evidence-dir is required.\n\n${usage()}`);
  }
  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
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
  process.stderr.write(`[moss-localization] ${message}\n`);
}

function errorText(error) {
  return error instanceof Error ? (error.stack ?? error.message) : String(error);
}

function recordCheck(checks, id, passed, expected, actual) {
  checks.push({ id, passed, expected, actual });
  if (!passed) reportProgress(`check failed: ${id}`);
  return passed;
}

function assertBuilt() {
  if (!existsSync(MAIN_JS)) {
    throw new Error(`Desktop build is missing at ${MAIN_JS}. Run bun run build:desktop first.`);
  }
}

function createIsolatedEnvironment(profileRoot) {
  const electronEnv = { ...process.env };
  delete electronEnv.VITE_DEV_SERVER_URL;
  for (const key of CREDENTIAL_ENV_KEYS) delete electronEnv[key];

  const xdgConfigHome = join(profileRoot, "xdg-config");
  const mossHome = join(profileRoot, "moss-home");
  const codexHome = join(profileRoot, "codex-home");
  const claudeConfigDir = join(profileRoot, "claude-config");
  const ghConfigDir = join(profileRoot, "gh-config");
  for (const directory of [xdgConfigHome, mossHome, codexHome, claudeConfigDir, ghConfigDir]) {
    mkdirSync(directory, { recursive: true });
  }

  return {
    ...electronEnv,
    HOME: profileRoot,
    XDG_CONFIG_HOME: xdgConfigHome,
    XDG_CACHE_HOME: join(profileRoot, "xdg-cache"),
    XDG_DATA_HOME: join(profileRoot, "xdg-data"),
    XDG_STATE_HOME: join(profileRoot, "xdg-state"),
    APPDATA: join(profileRoot, "appdata"),
    LOCALAPPDATA: join(profileRoot, "local-appdata"),
    MOSS_HOME: mossHome,
    DPCODE_HOME: mossHome,
    T3CODE_HOME: mossHome,
    CODEX_HOME: codexHome,
    CLAUDE_CONFIG_DIR: claudeConfigDir,
    GH_CONFIG_DIR: ghConfigDir,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
    MOSS_DISABLE_AUTH_PROTOCOL_REGISTRATION: "1",
    T3CODE_DISABLE_AUTO_UPDATE: "1",
    MOSS_DISABLE_AUTO_UPDATE: "1",
  };
}

function createFixtureRepository(profileRoot, isolatedEnv) {
  const projectRoot = join(profileRoot, "Projects", FIXTURE_PROJECT_NAME);
  mkdirSync(projectRoot, { recursive: true });
  writeFileSync(join(projectRoot, "README.md"), "# Moss localization smoke\n");
  execFileSync("git", ["init", "--quiet", "--initial-branch=main", projectRoot], {
    env: isolatedEnv,
    stdio: "pipe",
  });
  execFileSync(
    "git",
    [
      "-C",
      projectRoot,
      "remote",
      "add",
      "origin",
      "https://github.com/example/moss-localization-smoke.git",
    ],
    { env: isolatedEnv, stdio: "pipe" },
  );
  return projectRoot;
}

async function closeElectronApp(electronApp) {
  if (!electronApp) return;
  try {
    await Promise.race([
      electronApp.close(),
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Electron close timeout")), 5_000),
      ),
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

async function waitForHashPath(page, path, timeoutMs) {
  await page.waitForFunction(
    (expectedPath) => window.location.hash.startsWith(`#${expectedPath}`),
    path,
    { timeout: timeoutMs },
  );
}

function readPersistedLocale(localePersistencePath) {
  try {
    return readFileSync(localePersistencePath, "utf8").trim();
  } catch {
    return null;
  }
}

async function waitForPersistedLocale(localePersistencePath, expectedLocale, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let actualLocale = readPersistedLocale(localePersistencePath);
  while (actualLocale !== expectedLocale && Date.now() < deadline) {
    await new Promise((resolveWait) => setTimeout(resolveWait, 50));
    actualLocale = readPersistedLocale(localePersistencePath);
  }
  return actualLocale;
}

async function openAppearanceSettings(page, locale, timeoutMs) {
  if (!windowHashStartsWithSettings(await page.evaluate(() => window.location.hash))) {
    const settingsLabel = locale === "zh-CN" ? "设置" : "Settings";
    const directSettingsButton = page.getByRole("button", {
      name: settingsLabel,
      exact: true,
    });
    if (await directSettingsButton.isVisible().catch(() => false)) {
      await directSettingsButton.click();
    } else {
      await page.getByTestId("sidebar-account-menu-trigger").click();
      await page.getByRole("menuitem", { name: new RegExp(`^${settingsLabel}(?:\\s|$)`) }).click();
    }
    await waitForHashPath(page, "/settings", timeoutMs);
  }
  const appearanceLabel = locale === "zh-CN" ? "外观" : "Appearance";
  await page.getByRole("button", { name: appearanceLabel, exact: true }).click();
}

function windowHashStartsWithSettings(hash) {
  return hash.startsWith("#/settings");
}

async function dismissOptionalStartupOverlays(page) {
  for (const name of ["关闭更新提示", "Dismiss What's new", "暂不设置", "Not now"]) {
    const button = page.getByRole("button", { name, exact: true });
    if (await button.isVisible().catch(() => false)) await button.click();
  }
}

async function collectVisibleControls(page) {
  return page.evaluate(() => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this callback into the renderer.
    const isVisible = (element) => {
      const style = window.getComputedStyle(element);
      return (
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity) !== 0 &&
        element.getClientRects().length > 0
      );
    };
    return [
      ...document.querySelectorAll(
        "button, input, textarea, [role='button'], [role='tab'], [role='combobox']",
      ),
    ]
      .filter(isVisible)
      .map((element) => ({
        tag: element.tagName.toLowerCase(),
        text: (element.innerText || element.value || "").trim().replace(/\s+/g, " ").slice(0, 200),
        ariaLabel: element.getAttribute("aria-label"),
        role: element.getAttribute("role"),
        testId: element.getAttribute("data-testid"),
        title: element.getAttribute("title"),
        placeholder: element.getAttribute("placeholder"),
      }));
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
    bodyText: document.body.innerText.trim().slice(0, 20_000),
  }));
  const controls = await collectVisibleControls(page);
  const result = { name, screenshotPath, ...state, controls };
  writeFileSync(join(evidenceDir, `${name}.json`), `${JSON.stringify(result, null, 2)}\n`);
  return result;
}

async function captureFailure(page, evidenceDir) {
  if (!page) return null;
  try {
    return await capture(page, evidenceDir, "99-failure");
  } catch (error) {
    return { captureError: errorText(error) };
  }
}

async function readApplicationMenu(electronApp) {
  return electronApp.evaluate(({ Menu }) => {
    // oxlint-disable-next-line unicorn/consistent-function-scoping -- Electron serializes this callback into the main process.
    const serialize = (menu) =>
      menu.items.map((item) => ({
        id: item.id || null,
        label: item.label || null,
        role: item.role || null,
        type: item.type,
        enabled: item.enabled,
        visible: item.visible,
        submenu: item.submenu ? serialize(item.submenu) : [],
      }));
    const applicationMenu = Menu.getApplicationMenu();
    return applicationMenu ? serialize(applicationMenu) : [];
  });
}

function flattenMenuLabels(items) {
  return items.flatMap((item) => [item.label, ...flattenMenuLabels(item.submenu)]).filter(Boolean);
}

async function waitForApplicationMenu(electronApp, expectedLabels, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  let menu = [];
  while (Date.now() < deadline) {
    menu = await readApplicationMenu(electronApp);
    const labels = flattenMenuLabels(menu);
    if (expectedLabels.every((label) => labels.includes(label))) return menu;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  throw new Error(
    `Application menu did not contain ${expectedLabels.join(", ")}. Last labels: ${flattenMenuLabels(menu).join(", ")}`,
  );
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
                `Section action did not reveal (pointer-events=${style.pointerEvents}, opacity=${style.opacity})`,
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

async function addFixtureProject(page, projectRoot, timeoutMs) {
  await clickRevealedSectionAction(page.getByRole("button", { name: "添加项目" }), timeoutMs);
  await page.getByRole("button", { name: "输入路径", exact: true }).click();
  const projectPathInput = page.locator('input[placeholder="/path/to/project"]');
  await projectPathInput.fill(projectRoot);
  await projectPathInput.press("Enter");
  await page.getByText(FIXTURE_PROJECT_NAME, { exact: true }).first().waitFor({
    state: "visible",
    timeout: timeoutMs,
  });
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function stripAllowedEnglish(value, extraAllowedTokens = []) {
  let remainder = value.normalize("NFKC");
  const structuralPatterns = [
    /`[^`]+`/g,
    /https?:\/\/[^\s，。；;）)]+/g,
    /(?:~\/|\/(?:Users|home|tmp|private|var|Applications|Volumes)\/)[^\s，。；;）)]+/g,
    /\b[A-Za-z]:\\[^\s，。；;）)]+/g,
    /\b[\w.+-]+@[\w.-]+\.[A-Za-z]{2,}\b/g,
    /\b(?:v)?\d+\.\d+(?:\.\d+)*(?:[-+][A-Za-z0-9.-]+)?\b/g,
    /\b(?:gpt|claude|gemini|grok|codex|o[134])-[A-Za-z0-9._-]+\b/gi,
    /\b[A-Za-z_$][\w$]*(?:\.[A-Za-z_$][\w$]*)+\b/g,
    /\b[A-Za-z0-9._-]+\.(?:json|jsonl|md|toml|yaml|yml|js|mjs|cjs|ts|tsx|jsx|css|html|png|jpe?g|svg|zip|dmg)\b/gi,
    /\b[A-Z][A-Z0-9]+_[A-Z0-9_]+\b/g,
    /--[A-Za-z0-9][A-Za-z0-9-]*/g,
    /\/[A-Za-z][A-Za-z0-9-]*\b/g,
    /\b(?:Cmd|Ctrl|Alt|Option|Shift)(?:\+[A-Za-z0-9[\]]+)+\b/g,
    /#[0-9]+\b/g,
  ];
  for (const pattern of structuralPatterns) remainder = remainder.replace(pattern, " ");

  const tokens = [...BASE_ALLOWED_TECHNICAL_TOKENS, ...extraAllowedTokens].toSorted(
    (left, right) => right.length - left.length,
  );
  for (const token of tokens) {
    const pattern = new RegExp(`(^|[^A-Za-z0-9])(?:${escapeRegExp(token)})(?=$|[^A-Za-z0-9])`, "g");
    remainder = remainder.replace(pattern, "$1 ");
  }
  return remainder.replace(/\s+/g, " ").trim();
}

async function collectVisibleStrings(page, scopeSelector = "body") {
  return page
    .locator(scopeSelector)
    .last()
    .evaluate((scope) => {
      // oxlint-disable-next-line unicorn/consistent-function-scoping -- Playwright serializes this callback into the renderer.
      const isVisible = (element) => {
        const style = window.getComputedStyle(element);
        return (
          style.display !== "none" &&
          style.visibility !== "hidden" &&
          Number(style.opacity) !== 0 &&
          element.getClientRects().length > 0
        );
      };
      const entries = [];
      const walker = document.createTreeWalker(scope, NodeFilter.SHOW_TEXT);
      while (walker.nextNode()) {
        const node = walker.currentNode;
        const parent = node.parentElement;
        const value = node.textContent?.trim().replace(/\s+/g, " ") ?? "";
        if (!parent || !value || !isVisible(parent)) continue;
        if (["SCRIPT", "STYLE", "NOSCRIPT"].includes(parent.tagName)) continue;
        entries.push({ source: "text", value });
      }

      for (const element of [scope, ...scope.querySelectorAll("*")]) {
        if (!isVisible(element)) continue;
        for (const attribute of ["aria-label", "title", "placeholder", "alt"]) {
          const value = element.getAttribute(attribute)?.trim().replace(/\s+/g, " ") ?? "";
          if (value) entries.push({ source: attribute, value });
        }
      }

      const seen = new Set();
      return entries.filter((entry) => {
        const key = `${entry.source}\0${entry.value}`;
        if (seen.has(key)) return false;
        seen.add(key);
        return true;
      });
    });
}

async function findUnexpectedEnglish(page, options = {}) {
  const entries = await collectVisibleStrings(page, options.scopeSelector ?? "body");
  const unexpected = [];
  for (const entry of entries) {
    const remainder = stripAllowedEnglish(entry.value, options.extraAllowedTokens ?? []);
    const words = remainder.match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g) ?? [];
    if (words.length === 0) continue;
    unexpected.push({ ...entry, remainder, words });
  }
  return unexpected;
}

function findUnexpectedEnglishValues(values, extraAllowedTokens = []) {
  return values.flatMap((value) => {
    const remainder = stripAllowedEnglish(value, extraAllowedTokens);
    const words = remainder.match(/\b[A-Za-z][A-Za-z'-]{1,}\b/g) ?? [];
    return words.length > 0 ? [{ value, remainder, words }] : [];
  });
}

async function recordChineseSurfaceAudit(checks, page, id, options = {}) {
  const unexpected = await findUnexpectedEnglish(page, options);
  recordCheck(
    checks,
    `${id}:no-unexpected-english`,
    unexpected.length === 0,
    "No visible English outside the explicit technical/path/dynamic allowlist",
    unexpected,
  );
  return unexpected;
}

function includesAll(haystack, needles) {
  return needles.every((needle) => haystack.includes(needle));
}

function excludesAll(haystack, needles) {
  return needles.every((needle) => !haystack.includes(needle));
}

async function runJourney(
  electronApp,
  page,
  options,
  projectRoot,
  localePersistencePath,
  restartDesktop,
  checks,
  steps,
  menus,
) {
  reportProgress("checking the default Chinese shell and native application menu");
  await dismissOptionalStartupOverlays(page);

  const initial = await capture(page, options.evidenceDir, "00-default-zh-cn");
  steps.push(initial);
  recordCheck(checks, "default:html-lang", initial.lang === "zh-CN", "zh-CN", initial.lang);
  recordCheck(
    checks,
    "default:key-navigation-chinese",
    includesAll(initial.bodyText, [
      "新线程",
      "搜索",
      "看板",
      "自动化",
      "拉取请求",
      "插件",
      "设置",
    ]) &&
      excludesAll(initial.bodyText, [
        "New thread",
        "Kanban",
        "Automations",
        "Pull requests",
        "Plugins",
      ]),
    "Chinese primary navigation without English fallbacks",
    initial.bodyText.slice(0, 4_000),
  );
  await recordChineseSurfaceAudit(checks, page, "default");

  menus.zhInitial = await waitForApplicationMenu(
    electronApp,
    ["文件", "编辑", "视图", "窗口", "帮助", "设置…", "检查更新…", "键盘快捷键"],
    options.timeoutMs,
  );
  const zhMenuLabels = flattenMenuLabels(menus.zhInitial);
  const zhMenuUnexpectedEnglish = findUnexpectedEnglishValues(zhMenuLabels);
  recordCheck(
    checks,
    "menu:default-chinese",
    excludesAll(zhMenuLabels.join("\n"), ["File", "Edit", "View", "Window", "Help", "Settings…"]) &&
      zhMenuUnexpectedEnglish.length === 0,
    "Localized Chinese native menu labels without unexpected English",
    { labels: zhMenuLabels, unexpectedEnglish: zhMenuUnexpectedEnglish },
  );

  reportProgress("adding a synthetic repository through the localized project flow");
  await addFixtureProject(page, projectRoot, options.timeoutMs);
  steps.push(await capture(page, options.evidenceDir, "01-synthetic-project"));

  reportProgress("switching the renderer and native menu to English, then back to Chinese");
  await openAppearanceSettings(page, "zh-CN", options.timeoutMs);
  const settingsZh = await capture(page, options.evidenceDir, "02-settings-zh-cn");
  steps.push(settingsZh);
  recordCheck(
    checks,
    "settings:chinese-navigation",
    includesAll(settingsZh.bodyText, ["返回应用", "通用", "外观", "高级"]),
    "Chinese settings navigation",
    settingsZh.bodyText.slice(0, 4_000),
  );

  const languageSelectZh = page.getByRole("combobox", { name: "语言" });
  await languageSelectZh.click();
  await page.locator('[data-slot="select-item"]').filter({ hasText: "English" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "en", undefined, {
    timeout: options.timeoutMs,
  });
  menus.en = await waitForApplicationMenu(
    electronApp,
    [
      "File",
      "Edit",
      "View",
      "Window",
      "Help",
      "Settings…",
      "Check for Updates…",
      "Keyboard Shortcuts",
    ],
    options.timeoutMs,
  );
  const settingsEn = await capture(page, options.evidenceDir, "03-settings-en");
  steps.push(settingsEn);
  recordCheck(
    checks,
    "settings:english-navigation",
    settingsEn.lang === "en" &&
      includesAll(settingsEn.bodyText, ["Back to app", "General", "Appearance", "Advanced"]) &&
      excludesAll(settingsEn.bodyText, ["返回应用", "通用", "外观", "高级"]),
    "English settings navigation after switching locale",
    settingsEn.bodyText.slice(0, 4_000),
  );
  const enMenuLabels = flattenMenuLabels(menus.en);
  recordCheck(
    checks,
    "menu:english-switch",
    !/[\u3400-\u9fff]/u.test(enMenuLabels.join("\n")),
    "English native menu labels without residual Chinese",
    enMenuLabels,
  );

  const persistedEnglish = await waitForPersistedLocale(
    localePersistencePath,
    "en",
    options.timeoutMs,
  );
  recordCheck(
    checks,
    "persistence:english-file",
    persistedEnglish === "en",
    { path: localePersistencePath, contents: "en" },
    { path: localePersistencePath, contents: persistedEnglish },
  );

  reportProgress("restarting the isolated desktop to verify persisted English");
  ({ electronApp, page } = await restartDesktop());
  await dismissOptionalStartupOverlays(page);
  const restartedEnglish = await capture(page, options.evidenceDir, "04-restart-en");
  steps.push(restartedEnglish);
  menus.enRestarted = await waitForApplicationMenu(
    electronApp,
    ["File", "Edit", "View", "Window", "Help", "Settings…"],
    options.timeoutMs,
  );
  recordCheck(
    checks,
    "persistence:english-restart",
    restartedEnglish.lang === "en" &&
      includesAll(restartedEnglish.bodyText, ["New thread", "Search"]) &&
      !/[\u3400-\u9fff]/u.test(flattenMenuLabels(menus.enRestarted).join("\n")),
    "Renderer and native menu restore English after a real process restart",
    {
      lang: restartedEnglish.lang,
      bodyText: restartedEnglish.bodyText.slice(0, 4_000),
      menuLabels: flattenMenuLabels(menus.enRestarted),
    },
  );

  await openAppearanceSettings(page, "en", options.timeoutMs);

  const languageSelectEn = page.getByRole("combobox", { name: "Language" });
  await languageSelectEn.click();
  await page.locator('[data-slot="select-item"]').filter({ hasText: "简体中文" }).click();
  await page.waitForFunction(() => document.documentElement.lang === "zh-CN", undefined, {
    timeout: options.timeoutMs,
  });
  menus.zhRestored = await waitForApplicationMenu(
    electronApp,
    ["文件", "编辑", "视图", "窗口", "帮助", "设置…", "检查更新…", "键盘快捷键"],
    options.timeoutMs,
  );
  const zhRestoredMenuLabels = flattenMenuLabels(menus.zhRestored);
  const zhRestoredMenuUnexpectedEnglish = findUnexpectedEnglishValues(zhRestoredMenuLabels);
  recordCheck(
    checks,
    "menu:chinese-restored",
    zhRestoredMenuUnexpectedEnglish.length === 0,
    "Chinese native menu restored without unexpected English",
    {
      labels: zhRestoredMenuLabels,
      unexpectedEnglish: zhRestoredMenuUnexpectedEnglish,
    },
  );
  const settingsZhRestored = await capture(page, options.evidenceDir, "05-settings-zh-cn-restored");
  steps.push(settingsZhRestored);
  recordCheck(
    checks,
    "settings:chinese-restored",
    settingsZhRestored.lang === "zh-CN" &&
      includesAll(settingsZhRestored.bodyText, ["返回应用", "通用", "外观", "高级"]) &&
      excludesAll(settingsZhRestored.bodyText, [
        "Back to app",
        "General",
        "Appearance",
        "Advanced",
      ]),
    "Chinese settings navigation restored",
    settingsZhRestored.bodyText.slice(0, 4_000),
  );

  const persistedChinese = await waitForPersistedLocale(
    localePersistencePath,
    "zh-CN",
    options.timeoutMs,
  );
  recordCheck(
    checks,
    "persistence:chinese-file",
    persistedChinese === "zh-CN",
    { path: localePersistencePath, contents: "zh-CN" },
    { path: localePersistencePath, contents: persistedChinese },
  );

  reportProgress("restarting the isolated desktop to verify persisted Simplified Chinese");
  ({ electronApp, page } = await restartDesktop());
  await dismissOptionalStartupOverlays(page);
  const restartedChinese = await capture(page, options.evidenceDir, "06-restart-zh-cn");
  steps.push(restartedChinese);
  menus.zhRestarted = await waitForApplicationMenu(
    electronApp,
    ["文件", "编辑", "视图", "窗口", "帮助", "设置…"],
    options.timeoutMs,
  );
  const restartedChineseMenuLabels = flattenMenuLabels(menus.zhRestarted);
  recordCheck(
    checks,
    "persistence:chinese-restart",
    restartedChinese.lang === "zh-CN" &&
      includesAll(restartedChinese.bodyText, ["新线程", "搜索"]) &&
      findUnexpectedEnglishValues(restartedChineseMenuLabels).length === 0,
    "Renderer and native menu restore Simplified Chinese after a real process restart",
    {
      lang: restartedChinese.lang,
      bodyText: restartedChinese.bodyText.slice(0, 4_000),
      menuLabels: restartedChineseMenuLabels,
    },
  );

  await openAppearanceSettings(page, "zh-CN", options.timeoutMs);

  reportProgress("auditing the AppSnap settings surface");
  await page.getByRole("button", { name: "应用截图", exact: true }).click();
  await page
    .getByText("使用应用截图（AppSnap）向智能体展示其他应用的窗口", { exact: true })
    .waitFor({
      state: "visible",
      timeout: options.timeoutMs,
    });
  const appSnap = await capture(page, options.evidenceDir, "07-appsnap-zh-cn");
  steps.push(appSnap);
  recordCheck(
    checks,
    "appsnap:representative-copy",
    includesAll(appSnap.bodyText, ["应用截图", "截图", "快捷键", "发送位置", "截图提示音"]) &&
      excludesAll(appSnap.bodyText, [
        "Take an AppSnap",
        "Enable AppSnap",
        "Destination",
        "Capture sound",
      ]),
    "Localized AppSnap headings, controls, and helper copy",
    appSnap.bodyText.slice(0, 6_000),
  );
  await recordChineseSurfaceAudit(checks, page, "appsnap");

  reportProgress("opening and auditing the complete release history");
  await page.getByRole("button", { name: "高级", exact: true }).click();
  await page.getByRole("button", { name: "查看发布历史", exact: true }).click();
  const releaseDialog = page
    .locator('[data-slot="dialog-popup"]')
    .filter({ hasText: "发布历史" })
    .last();
  await releaseDialog.getByText("发布历史", { exact: true }).waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  const releaseHistory = await capture(page, options.evidenceDir, "08-release-history-zh-cn");
  steps.push(releaseHistory);
  const releaseText = await releaseDialog.innerText();
  const expandedReleaseFeatureCount = await releaseDialog
    .locator('[data-slot="collapsible-panel"]:visible h3')
    .count();
  recordCheck(
    checks,
    "release-history:representative-copy",
    includesAll(releaseText, [
      "发布历史",
      "所有精选版本，按时间从新到旧排列。",
      "版本",
      "项更新",
    ]) &&
      expandedReleaseFeatureCount > 0 &&
      excludesAll(releaseText, ["Release history", "Every curated release", "Version ", " update"]),
    "Localized release-history chrome and expanded current release",
    { expandedReleaseFeatureCount, text: releaseText.slice(0, 10_000) },
  );
  await recordChineseSurfaceAudit(checks, page, "release-history", {
    scopeSelector: '[data-slot="dialog-popup"]',
  });
  await releaseDialog.getByRole("button", { name: "关闭", exact: true }).last().click();
  await releaseDialog.waitFor({ state: "hidden", timeout: options.timeoutMs });

  reportProgress("opening and auditing the global feedback dialog");
  await page.getByRole("button", { name: "返回应用", exact: true }).click();
  await page.waitForFunction(() => !window.location.hash.startsWith("#/settings"), undefined, {
    timeout: options.timeoutMs,
  });
  await page.getByRole("button", { name: /^搜索(?:\s|$)/ }).click();
  const commandDialog = page.locator('[data-slot="command-dialog-popup"]');
  const commandInput = commandDialog.locator('[data-slot="autocomplete-input"]');
  await commandInput.fill("feedback");
  await commandDialog
    .locator('[data-slot="command-item"]')
    .filter({ hasText: "向 Moss 反馈" })
    .click();
  const feedbackDialog = page
    .locator('[data-slot="dialog-popup"]')
    .filter({ hasText: "分享反馈" })
    .last();
  await feedbackDialog.getByText("分享反馈", { exact: true }).waitFor({
    state: "visible",
    timeout: options.timeoutMs,
  });
  const feedback = await capture(page, options.evidenceDir, "09-feedback-zh-cn");
  steps.push(feedback);
  const feedbackText = await feedbackDialog.innerText();
  const feedbackDetails = await feedbackDialog.locator("textarea").evaluate((textarea) => ({
    ariaLabel: textarea.getAttribute("aria-label"),
    placeholder: textarea.getAttribute("placeholder"),
  }));
  recordCheck(
    checks,
    "feedback:representative-copy",
    includesAll(feedbackText, ["分享反馈", "性能", "提交"]) &&
      feedbackDetails.placeholder === "请说明详情（必填）" &&
      feedbackDetails.ariaLabel === "反馈详情" &&
      excludesAll(feedbackText, ["Share feedback", "Performance", "Share details", "Submit"]),
    "Localized feedback dialog",
    { details: feedbackDetails, text: feedbackText },
  );
  await recordChineseSurfaceAudit(checks, page, "feedback", {
    scopeSelector: '[data-slot="dialog-popup"]',
  });
  await page.keyboard.press("Escape");
  await feedbackDialog.waitFor({ state: "hidden", timeout: options.timeoutMs });

  reportProgress("opening the deterministic GitHub CLI unavailable state");
  await page.getByRole("button", { name: "拉取请求", exact: true }).click();
  await waitForHashPath(page, "/pull-requests", options.timeoutMs);
  await page
    .getByText(/^(需要 GitHub CLI|登录 GitHub CLI|拉取请求不可用)$/)
    .waitFor({ state: "visible", timeout: options.timeoutMs });
  const pullRequests = await capture(
    page,
    options.evidenceDir,
    "10-pull-requests-unavailable-zh-cn",
  );
  steps.push(pullRequests);
  recordCheck(
    checks,
    "pull-requests:unavailable-copy",
    includesAll(pullRequests.bodyText, ["拉取请求"]) &&
      ["需要 GitHub CLI", "登录 GitHub CLI", "拉取请求不可用"].some((text) =>
        pullRequests.bodyText.includes(text),
      ) &&
      excludesAll(pullRequests.bodyText, [
        "GitHub CLI is required",
        "Sign in to GitHub CLI",
        "Pull requests are unavailable",
      ]),
    "Localized GitHub CLI unavailable state",
    pullRequests.bodyText.slice(0, 8_000),
  );
  await recordChineseSurfaceAudit(checks, page, "pull-requests", {
    extraAllowedTokens: [FIXTURE_PROJECT_NAME, "gh auth login", "brew install gh", "main"],
  });

  return { electronApp, page };
}

async function run(options) {
  mkdirSync(options.evidenceDir, { recursive: true });
  const startedAt = new Date();
  const profileRoot = mkdtempSync(join(tmpdir(), "moss-localization-profile-"));
  const electronUserDataDir = join(profileRoot, "electron-user-data");
  const isolatedEnv = createIsolatedEnvironment(profileRoot);
  const localePersistencePath = join(isolatedEnv.MOSS_HOME, "userdata", "desktop-ui-locale");
  mkdirSync(electronUserDataDir, { recursive: true });

  const checks = [];
  const steps = [];
  const menus = {};
  const consoleErrors = [];
  const pageErrors = [];
  const requestFailures = [];
  const stderrLines = [];
  const stdoutLines = [];
  let electronApp = null;
  let page = null;
  let fatalError = null;
  let failureEvidence = null;
  let launchCount = 0;

  try {
    assertBuilt();
    const projectRoot = createFixtureRepository(profileRoot, isolatedEnv);
    const importedPlaywright = await import(resolvePlaywrightModuleUrl());
    // oxlint-disable-next-line no-underscore-dangle -- Playwright exposes Electron through this public launcher name.
    const electron = importedPlaywright._electron ?? importedPlaywright.default?._electron;
    if (!electron) throw new Error("Playwright Electron launcher is unavailable.");

    const launchDesktop = async () => {
      launchCount += 1;
      reportProgress(
        `launching isolated desktop process ${launchCount} with HOME and MOSS_HOME under ${profileRoot}`,
      );
      const launchedApp = await electron.launch({
        executablePath: resolveElectronPath(),
        args: [`--user-data-dir=${electronUserDataDir}`, MAIN_JS],
        cwd: DESKTOP_ROOT,
        env: isolatedEnv,
        timeout: options.timeoutMs,
      });
      launchedApp.process().stdout?.on("data", (chunk) => stdoutLines.push(String(chunk)));
      launchedApp.process().stderr?.on("data", (chunk) => stderrLines.push(String(chunk)));

      await launchedApp.firstWindow({ timeout: options.timeoutMs });
      const launchedPage = await waitForMainWindow(launchedApp, options.timeoutMs);
      await launchedPage.setViewportSize({ width: 1512, height: 982 });
      launchedPage.on("console", (message) => {
        if (message.type() !== "error") return;
        const location = message.location();
        consoleErrors.push({
          text: message.text(),
          url: location.url,
          lineNumber: location.lineNumber,
          columnNumber: location.columnNumber,
        });
      });
      launchedPage.on("pageerror", (error) => pageErrors.push(errorText(error)));
      launchedPage.on("requestfailed", (request) => {
        requestFailures.push(
          `${request.method()} ${request.url()} ${request.failure()?.errorText ?? ""}`,
        );
      });

      await waitForShell(launchedPage, options.timeoutMs);
      await launchedPage.waitForTimeout(1_000);
      electronApp = launchedApp;
      page = launchedPage;
      return { electronApp: launchedApp, page: launchedPage };
    };

    const restartDesktop = async () => {
      await closeElectronApp(electronApp);
      electronApp = null;
      page = null;
      return launchDesktop();
    };

    ({ electronApp, page } = await launchDesktop());
    ({ electronApp, page } = await runJourney(
      electronApp,
      page,
      options,
      projectRoot,
      localePersistencePath,
      restartDesktop,
      checks,
      steps,
      menus,
    ));
  } catch (error) {
    fatalError = errorText(error);
    reportProgress(`fatal failure: ${fatalError}`);
    failureEvidence = await captureFailure(page, options.evidenceDir);
  } finally {
    await closeElectronApp(electronApp);
  }

  const failedChecks = checks.filter((check) => !check.passed);
  const status =
    fatalError === null && failedChecks.length === 0 && pageErrors.length === 0 ? "pass" : "fail";
  const report = {
    status,
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    mainJs: MAIN_JS,
    profileRoot,
    profilePreserved: options.keepProfile,
    isolation: {
      temporaryHome: profileRoot,
      electronChromiumUserDataDir: electronUserDataDir,
      mossHome: isolatedEnv.MOSS_HOME,
      mossCompatibilityHome: isolatedEnv.MOSS_HOME,
      desktopStateDir: join(isolatedEnv.MOSS_HOME, "userdata"),
      desktopUiLocaleFile: localePersistencePath,
      launchCount,
      reusedSameIsolatedProfileAcrossRestarts: launchCount > 1,
      providerAndGitHubCredentialEnvironmentRemoved: [...CREDENTIAL_ENV_KEYS],
      gitGlobalConfig: "/dev/null",
      authProtocolRegistrationDisabled: true,
    },
    evidenceDir: options.evidenceDir,
    checks,
    failedChecks,
    steps,
    menus,
    fatalError,
    failureEvidence,
    consoleErrors,
    pageErrors,
    requestFailures,
    persistedDesktopUiLocale: {
      path: localePersistencePath,
      contents: readPersistedLocale(localePersistencePath),
    },
    stdout: stdoutLines.join("").slice(-20_000),
    stderr: stderrLines.join("").slice(-20_000),
  };
  writeFileSync(join(options.evidenceDir, "report.json"), `${JSON.stringify(report, null, 2)}\n`);

  if (!options.keepProfile) {
    rmSync(profileRoot, { recursive: true, force: true });
  }

  process.stdout.write(
    `${JSON.stringify(
      {
        status,
        evidenceDir: options.evidenceDir,
        profileRoot: options.keepProfile ? profileRoot : "removed",
        stepCount: steps.length,
        checkCount: checks.length,
        failedChecks,
        fatalError,
        pageErrorCount: pageErrors.length,
        consoleErrorCount: consoleErrors.length,
        requestFailureCount: requestFailures.length,
      },
      null,
      2,
    )}\n`,
  );
  if (status !== "pass") process.exitCode = 1;
  return report;
}

const options = parseArgs(process.argv.slice(2));
run(options).catch((error) => {
  process.stderr.write(`${errorText(error)}\n`);
  process.exitCode = 1;
});
