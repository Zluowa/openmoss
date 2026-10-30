import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  writeFileSync,
} from "node:fs";
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  MOSS_DESKTOP_SMOKE_USER_DATA_ENV,
  MOSS_SOURCE_DESKTOP_BUILD_MARKER,
} from "@synara/shared/desktopIdentity";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = resolve(SCRIPT_DIR, "..");
const REPO_ROOT = resolve(DESKTOP_ROOT, "..", "..");
const WEB_ROOT = join(REPO_ROOT, "apps", "web");
const MAIN_JS = join(DESKTOP_ROOT, "dist-electron", "main.js");
const PRELOAD_JS = join(DESKTOP_ROOT, "dist-electron", "preload.js");
const SERVER_ENTRY = join(REPO_ROOT, "apps", "server", "dist", "index.mjs");
const WEB_INDEX = join(REPO_ROOT, "apps", "web", "dist", "index.html");
const THREAD_ID = "thread-moss-served-smoke";
const SECONDARY_THREAD_ID = "thread-moss-served-smoke-secondary";
const CODEX_DESKTOP_BASELINE_SCREENSHOT =
  ".moss/ledger/evidence/codex-desktop-current-shell-2026-07-03.png";
const EXPECTED_BASELINE_TRAITS = [
  "active-thread-transcript",
  "composer",
  "run-state-control",
  "model-or-permission-control",
  "plan-or-output-side-panel",
];
const EXPECTED_ACTIVE_EVENT_TYPES = [
  "text",
  "tool-call",
  "tool-result",
  "permission-request",
  "usage",
  "finish",
];
const DEFAULT_CREATED_AT = "2026-07-02T00:16:00.000Z";
const DEFAULT_TIMEOUT_MS = 120_000;
const DESKTOP_ROUTE = `moss://app/index.html#/${THREAD_ID}?mossShell=1`;

function normalizeMossShellRouteHref(href) {
  return href.replace(/([?&]mossShell=)(?:"|%22)?1(?:"|%22)?/g, (_match, prefix) => {
    return `${prefix}1`;
  });
}

function parseArgs(argv) {
  const options = {
    createdAt: DEFAULT_CREATED_AT,
    reportPath: undefined,
    screenshotPath: undefined,
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
    if (arg === "--report" && next) {
      options.reportPath = next;
      index += 1;
      continue;
    }
    if (arg === "--screenshot" && next) {
      options.screenshotPath = next;
      index += 1;
      continue;
    }
    if (arg === "--timeout-ms" && next) {
      options.timeoutMs = Number(next);
      index += 1;
      continue;
    }
  }

  if (!Number.isInteger(options.timeoutMs) || options.timeoutMs <= 0) {
    throw new Error(`Invalid --timeout-ms: ${String(options.timeoutMs)}`);
  }

  return options;
}

function requireFromPackage(packageJsonPath) {
  return createRequire(resolve(REPO_ROOT, packageJsonPath));
}

function resolvePlaywrightModuleUrl() {
  const requireFromWeb = requireFromPackage("apps/web/package.json");
  return pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
}

function resolveElectronPath() {
  const requireFromDesktop = requireFromPackage("apps/desktop/package.json");
  return requireFromDesktop("electron");
}

function resolveRepoPath(path) {
  return resolve(REPO_ROOT, path);
}

function assertRequiredFile(path, label) {
  if (!existsSync(path)) {
    throw new Error(`${label} is missing at ${path}. Run bun run build:desktop first.`);
  }
}

function resolveCurrentAppSettingsAsset() {
  const assetDirectory = join(REPO_ROOT, "apps", "server", "dist", "client", "assets");
  const asset = readdirSync(assetDirectory)
    .filter((entry) => /^appSettings-[A-Za-z0-9_-]+\.js$/.test(entry))
    .toSorted()
    .at(-1);
  if (!asset) {
    throw new Error(`Current desktop static bundle has no appSettings asset in ${assetDirectory}`);
  }
  return asset;
}

function redactSensitiveText(value) {
  return String(value)
    .replace(
      /([?&](?:token|access_token|refresh_token|api[_-]?key|secret)=)[^&\s]+/gi,
      "$1<redacted>",
    )
    .replace(/\b(Bearer\s+)[A-Za-z0-9._~+/=-]+/gi, "$1<redacted>")
    .replace(
      /(['"]?(?:token|secret|api[_-]?key|authorization)['"]?\s*[:=]\s*['"]?)[^'"\s,}\]]+/gi,
      "$1<redacted>",
    );
}

function appendBounded(lines, chunk, prefix = "") {
  const text = redactSensitiveText(chunk);
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) continue;
    lines.push(`${prefix}${line}`);
  }
  if (lines.length > 120) {
    lines.splice(0, lines.length - 120);
  }
}

function logStage(label, details) {
  const suffix = details ? ` ${redactSensitiveText(details)}` : "";
  console.error(`[moss-product-shell-smoke] ${label}${suffix}`);
}

async function withHardTimeout(promise, timeoutMs, onTimeout) {
  let timeout = undefined;
  const timeoutPromise = new Promise((_, reject) => {
    timeout = setTimeout(() => {
      Promise.resolve(onTimeout())
        .catch((error) => {
          console.error(
            error instanceof Error
              ? `[moss-product-shell-smoke] timeout cleanup failed: ${error.message}`
              : `[moss-product-shell-smoke] timeout cleanup failed: ${String(error)}`,
          );
        })
        .finally(() => {
          reject(new Error(`Timed out after ${timeoutMs}ms running Electron product shell smoke.`));
        });
    }, timeoutMs);
  });

  return Promise.race([promise, timeoutPromise]).finally(() => {
    if (timeout) clearTimeout(timeout);
  });
}

function dumpInitScript(createdAt, runtimeDir) {
  const outputPath = join(runtimeDir, "moss-product-shell-init.js");
  const result = spawnSync(
    process.execPath,
    [
      "scripts/moss-promoted-shell-served-smoke.ts",
      "--created-at",
      createdAt,
      "--dump-init-script",
      outputPath,
    ],
    {
      cwd: REPO_ROOT,
      encoding: "utf8",
    },
  );

  if (result.status !== 0) {
    throw new Error(
      ["Failed to dump Moss product shell init script.", result.stdout.trim(), result.stderr.trim()]
        .filter(Boolean)
        .join("\n"),
    );
  }

  return readFileSync(outputPath, "utf8");
}

async function importPlaywrightElectron() {
  const importedPlaywright = await import(resolvePlaywrightModuleUrl());
  const electron = importedPlaywright._electron ?? importedPlaywright.default?._electron;
  if (!electron) {
    throw new Error("Playwright _electron launcher is unavailable from apps/web dependency tree.");
  }
  return electron;
}

async function assertSelector(page, selector, label, assertions) {
  await page.waitForSelector(selector, { timeout: 20_000 });
  assertions.push(label);
}

async function recordBodySnapshot(page, logs, label) {
  appendBounded(logs, page.url(), `[url:${label}] `);
  try {
    const bodyText = await page.locator("body").innerText();
    appendBounded(logs, bodyText.slice(0, 2_500), `[body:${label}] `);
  } catch (error) {
    appendBounded(
      logs,
      error instanceof Error ? error.message : String(error),
      `[body:${label}:error] `,
    );
  }
  try {
    const selectorCounts = await page.evaluate(() => ({
      chatComposerForm: document.querySelectorAll("[data-chat-composer-form]").length,
      chatComposerVisible: document.querySelectorAll(
        "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
      ).length,
      mossAccessStrip: document.querySelectorAll("[data-moss-native-shell-access]").length,
      mossControlPlaneEvents: document.querySelectorAll("[data-moss-control-plane-events]").length,
      mossControlPlaneLaunchPlan: document.querySelectorAll("[data-moss-control-plane-launch-plan]")
        .length,
      mossControlPlaneLedger: document.querySelectorAll("[data-moss-control-plane-ledger]").length,
      normalizedRows: document.querySelectorAll("[data-moss-normalized-row]").length,
      routeMainViewport: document.querySelectorAll(".chat-main-viewport-shell").length,
    }));
    appendBounded(logs, JSON.stringify(selectorCounts), `[selectors:${label}] `);
  } catch (error) {
    appendBounded(
      logs,
      error instanceof Error ? error.message : String(error),
      `[selectors:${label}:error] `,
    );
  }
}

async function assertSelectorWithSnapshot(page, selector, label, assertions, logs) {
  try {
    await assertSelector(page, selector, label, assertions);
  } catch (error) {
    await recordBodySnapshot(page, logs, label);
    throw error;
  }
}

async function collectFirstScreenLayoutEvidence(page, capturedAt) {
  return page.evaluate((createdAt) => {
    function readRect(element) {
      const rect = element.getBoundingClientRect();
      return {
        top: rect.top,
        right: rect.right,
        bottom: rect.bottom,
        left: rect.left,
        width: rect.width,
        height: rect.height,
      };
    }

    function isVisible(element) {
      if (!element) return false;
      const rect = element.getBoundingClientRect();
      const style = window.getComputedStyle(element);
      return (
        rect.width > 0 &&
        rect.height > 0 &&
        style.display !== "none" &&
        style.visibility !== "hidden" &&
        Number(style.opacity || "1") > 0
      );
    }

    function requireElement(selector) {
      const element = document.querySelector(selector);
      if (!element) {
        throw new Error(`Unable to collect layout evidence; missing selector ${selector}`);
      }
      return element;
    }

    function visibleHeight(rect) {
      return Math.max(0, Math.min(rect.bottom, window.innerHeight) - Math.max(rect.top, 0));
    }

    const composer = requireElement(
      "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
    );
    const eventsPanel = requireElement("[data-moss-control-plane-events]");
    const surfaceButtons = Array.from(
      document.querySelectorAll("[data-moss-native-shell-surface]"),
    );
    const visibleSurfaceButtons = surfaceButtons.filter(isVisible);
    if (visibleSurfaceButtons.length === 0) {
      throw new Error("Unable to collect layout evidence; no visible Moss surface buttons.");
    }

    const buttonRects = visibleSurfaceButtons.map(readRect);
    const surfaceAccessLeft = Math.min(...buttonRects.map((rect) => rect.left));
    const surfaceAccessRight = Math.max(...buttonRects.map((rect) => rect.right));
    const requiredAffordanceSelectors = [
      "[data-moss-native-session-list-access='true']",
      "[data-moss-native-normalized-event-timeline-access='true']",
      "[data-moss-native-launch-plan-access='true']",
      "[data-moss-native-loop-ledger-access='true']",
    ];
    const missingAffordanceSelectors = requiredAffordanceSelectors.filter(
      (selector) => !isVisible(document.querySelector(selector)),
    );
    const rowCount = document.querySelectorAll("[data-moss-normalized-row]").length;
    const transcriptMessageRowCount = document.querySelectorAll("[data-message-id]").length;
    const centeredEmptyLandingVisible = isVisible(
      document.querySelector("[data-testid='empty-landing-heading']"),
    );
    const composerRect = readRect(composer);
    const eventsPanelRect = readRect(eventsPanel);
    const visibleEventsPanelHeightPx = visibleHeight(eventsPanelRect);

    return {
      source: "electron-product-shell-smoke-layout-evidence",
      capturedAt: createdAt,
      viewportWidthPx: window.innerWidth,
      viewportHeightPx: window.innerHeight,
      composerTopPx: composerRect.top,
      composerBottomGapPx: Math.max(0, window.innerHeight - composerRect.bottom),
      composerHeightPx: composerRect.height,
      sideAccessWidthPx: surfaceAccessRight - surfaceAccessLeft,
      sideAccessVisible: isVisible(
        document.querySelector("[data-moss-native-session-list-access='true']"),
      ),
      controlPlaneAffordanceCount:
        requiredAffordanceSelectors.length - missingAffordanceSelectors.length,
      requiredControlPlaneAffordanceCount: requiredAffordanceSelectors.length,
      normalizedEventRowCount: rowCount,
      transcriptMessageRowCount,
      centeredEmptyLandingVisible,
      timelineHeightPx: visibleEventsPanelHeightPx,
      timelineContentHeightPx: eventsPanelRect.height,
      timelineDensityRowsPer1000Px:
        visibleEventsPanelHeightPx > 0 ? (rowCount / visibleEventsPanelHeightPx) * 1000 : 0,
      evidence: [],
      missingAffordanceSelectors,
      rects: {
        composer: composerRect,
        eventsPanel: eventsPanelRect,
        surfaceAccess: {
          top: Math.min(...buttonRects.map((rect) => rect.top)),
          right: surfaceAccessRight,
          bottom: Math.max(...buttonRects.map((rect) => rect.bottom)),
          left: surfaceAccessLeft,
          width: surfaceAccessRight - surfaceAccessLeft,
          height:
            Math.max(...buttonRects.map((rect) => rect.bottom)) -
            Math.min(...buttonRects.map((rect) => rect.top)),
        },
      },
    };
  }, capturedAt);
}

async function collectCodexDesktopInteractionAcceptance(page, input) {
  return page.evaluate(
    ({ baselineScreenshotPath, expectedBaselineTraits }) => {
      const normalizedRows = Array.from(
        document.querySelectorAll("[data-moss-control-plane-events] [data-moss-normalized-row]"),
      );
      const eventTypes = [
        ...new Set(
          normalizedRows
            .map((row) => row.getAttribute("data-event-type"))
            .filter((eventType) => Boolean(eventType)),
        ),
      ];
      const surfaceButtons = Array.from(
        document.querySelectorAll("[data-moss-native-shell-surface]"),
      );
      const visibleSurfaceIds = surfaceButtons
        .filter((button) => {
          const rect = button.getBoundingClientRect();
          const style = window.getComputedStyle(button);
          return (
            rect.width > 0 &&
            rect.height > 0 &&
            style.display !== "none" &&
            style.visibility !== "hidden" &&
            Number(style.opacity || "1") > 0
          );
        })
        .map((button) => button.getAttribute("data-moss-native-shell-surface"))
        .filter((surface) => Boolean(surface));
      const composer = document.querySelector(
        "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
      );
      const accessStrip = document.querySelector("[data-moss-native-shell-access='true']");
      return {
        baselineScreenshotPath,
        baselineTraits: expectedBaselineTraits,
        activeThreadId: composer?.getAttribute("data-moss-visible-thread-id") ?? null,
        activeProvider: composer?.getAttribute("data-moss-visible-provider") ?? null,
        activeSessionStatus:
          accessStrip?.getAttribute("data-moss-native-shell-session-status") ?? null,
        visibleSurfaceIds,
        activeEventTypes: eventTypes,
        activeTimelineRowCount: normalizedRows.length,
        composerControls: {
          composerShell: Boolean(composer),
          composerControls: Boolean(
            document.querySelector("[data-moss-visible-composer-controls='true']"),
          ),
          attachment: Boolean(
            document.querySelector("[data-moss-visible-attachment-control='true']"),
          ),
          modelOrReasoning: Boolean(
            document.querySelector("[data-moss-visible-model-reasoning-control]"),
          ),
          stop: Boolean(document.querySelector("[data-moss-visible-stop-control='true']")),
        },
        normalizedTimeline: {
          toolLifecycle: Boolean(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='tool-result'][data-tool-lifecycle-state='succeeded']",
            ),
          ),
          permissionAction: Boolean(
            document.querySelector(
              "[data-moss-normalized-row][data-event-type='permission-request'] [data-moss-normalized-permission-action-shell]",
            ),
          ),
          usage: Boolean(
            document.querySelector("[data-moss-normalized-row][data-event-type='usage']"),
          ),
          finish: Boolean(
            document.querySelector("[data-moss-normalized-row][data-event-type='finish']"),
          ),
        },
        rawProviderSourceHidden: !document.body.innerText.includes(".raw.served"),
      };
    },
    {
      baselineScreenshotPath: input.baselineScreenshotPath,
      expectedBaselineTraits: input.expectedBaselineTraits,
    },
  );
}

function httpUrlFromDesktopWsUrl(wsUrl) {
  const url = new URL(wsUrl);
  url.protocol = url.protocol === "wss:" ? "https:" : "http:";
  url.pathname = "/health";
  url.search = "";
  url.hash = "";
  return url.toString();
}

async function waitForBackendHealth(wsUrl, timeoutMs, logs) {
  const healthUrl = httpUrlFromDesktopWsUrl(wsUrl);
  const startedAt = Date.now();
  let lastError = null;
  while (Date.now() - startedAt < timeoutMs) {
    try {
      const response = await fetch(healthUrl, { redirect: "manual" });
      const text = await response.text();
      if (response.ok) {
        const json = text ? JSON.parse(text) : {};
        return {
          healthUrl,
          status: response.status,
          body: json,
        };
      }
      lastError = new Error(`HTTP ${response.status}: ${text.slice(0, 200)}`);
    } catch (error) {
      lastError = error;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }

  const detail = lastError instanceof Error ? lastError.message : String(lastError);
  appendBounded(logs, detail, "[backend-health:error] ");
  throw new Error(`Timed out waiting for backend health at ${healthUrl}: ${detail}`);
}

async function verifyBackendWebSocketTransport(wsUrl, timeoutMs) {
  const source = new URL(wsUrl);
  const negotiateUrl = new URL(source);
  negotiateUrl.protocol = "http:";
  negotiateUrl.pathname = "/ws/negotiate";
  negotiateUrl.searchParams.set("x-moss-client-build", "0.7.6");
  negotiateUrl.searchParams.set("x-moss-protocol-epoch", "1");
  negotiateUrl.searchParams.set("x-moss-protocol-min-revision", "1");
  negotiateUrl.searchParams.set("x-moss-protocol-max-revision", "1");
  for (const capability of [
    "orchestration.cursor-safe-streams",
    "orchestration.thread-detail-snapshot",
    "rpc.typed-errors",
    "git.worktree-setup-progress",
  ]) {
    negotiateUrl.searchParams.append("x-moss-required-capability", capability);
  }
  const negotiationResponse = await fetch(negotiateUrl, { cache: "no-store" });
  if (!negotiationResponse.ok) {
    throw new Error(
      `Production WebSocket negotiation returned HTTP ${negotiationResponse.status}.`,
    );
  }
  const negotiation = await negotiationResponse.json();
  const featureUrl = new URL(source);
  featureUrl.pathname = "/ws";
  featureUrl.searchParams.set("x-moss-client-build", negotiation.serverBuild);
  featureUrl.searchParams.set("x-moss-protocol-epoch", String(negotiation.protocolEpoch));
  featureUrl.searchParams.set("x-moss-protocol-revision", String(negotiation.negotiatedRevision));
  featureUrl.searchParams.set("x-moss-server-instance", negotiation.serverInstanceId);
  await new Promise((resolve, reject) => {
    const timer = setTimeout(
      () => {
        socket.close();
        reject(new Error("Production WebSocket feature handshake timed out."));
      },
      Math.min(timeoutMs, 10_000),
    );
    const socket = new WebSocket(featureUrl);
    socket.addEventListener(
      "open",
      () => {
        clearTimeout(timer);
        socket.close();
        resolve(undefined);
      },
      { once: true },
    );
    socket.addEventListener(
      "error",
      () => {
        clearTimeout(timer);
        reject(new Error("Production WebSocket feature handshake failed."));
      },
      { once: true },
    );
  });
  return negotiation;
}

function listChildProcesses(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid)) {
    return [];
  }

  const result = spawnSync("pgrep", ["-P", String(pid), "-fal", "."], {
    encoding: "utf8",
  });
  const output = typeof result.stdout === "string" ? result.stdout.trim() : "";
  if (!output) return [];
  return output
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

function readProcessCommand(pid) {
  if (process.platform === "win32" || !Number.isInteger(pid)) {
    return "";
  }
  const result = spawnSync("ps", ["-p", String(pid), "-o", "command="], {
    encoding: "utf8",
  });
  return typeof result.stdout === "string" ? result.stdout.trim() : "";
}

function captureProcessTree(rootPid) {
  if (process.platform === "win32" || !Number.isInteger(rootPid)) {
    return [];
  }

  const rows = [];
  const pending = [rootPid];
  const seen = new Set();
  while (pending.length > 0) {
    const parentPid = pending.shift();
    if (!Number.isInteger(parentPid) || seen.has(parentPid)) continue;
    seen.add(parentPid);
    for (const line of listChildProcesses(parentPid)) {
      const match = /^(\d+)\s+(.*)$/.exec(line);
      if (!match) continue;
      const pid = Number(match[1]);
      if (!Number.isInteger(pid) || pid <= 0 || seen.has(pid)) continue;
      const command = match[2]?.trim() || readProcessCommand(pid);
      rows.push({ pid, command });
      pending.push(pid);
    }
  }
  return rows;
}

function processStillMatches(row) {
  if (!row || !Number.isInteger(row.pid)) return false;
  const currentCommand = readProcessCommand(row.pid);
  return currentCommand.length > 0 && currentCommand === row.command;
}

function signalCapturedProcessTree(rootPid, capturedRows, signal) {
  const rows = [...capturedRows, { pid: rootPid, command: readProcessCommand(rootPid) }];
  // Descendants first avoids orphaning the backend if the Electron parent is
  // force-killed while its graceful shutdown hook is still waiting.
  for (const row of rows.toReversed()) {
    if (!processStillMatches(row)) continue;
    try {
      process.kill(row.pid, signal);
    } catch (error) {
      if (error?.code !== "ESRCH") throw error;
    }
  }
}

async function waitForCapturedProcessTreeExit(rootPid, capturedRows, timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const rootAlive = processStillMatches({
      pid: rootPid,
      command: readProcessCommand(rootPid),
    });
    const descendants = capturedRows.filter(processStillMatches);
    if (!rootAlive && descendants.length === 0) return true;
    await new Promise((resolveWait) => setTimeout(resolveWait, 100));
  }
  return false;
}

async function waitForBackendProcess(electronPid, timeoutMs) {
  const startedAt = Date.now();
  let children = [];
  while (Date.now() - startedAt < timeoutMs) {
    children = listChildProcesses(electronPid);
    const backend = children.find(
      (line) =>
        line.includes("apps/server/dist/index.mjs") || line.includes("apps/server/dist/index.cjs"),
    );
    if (backend) {
      return { backend, children };
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, 300));
  }
  return { backend: null, children };
}

async function closeElectronApp(electronApp, logs) {
  const processRef = electronApp.process();
  const capturedProcessTree = captureProcessTree(processRef.pid);
  let closePromise;
  try {
    closePromise = electronApp.close();
    await Promise.race([
      closePromise,
      new Promise((_, reject) =>
        setTimeout(() => reject(new Error("Timed out closing Electron app")), 5_000),
      ),
    ]);
  } catch (error) {
    appendBounded(logs, error instanceof Error ? error.message : String(error), "[close:error] ");
    // The fixture intentionally leaves a running chat visible, so the
    // production quit guard may wait for a renderer decision that this
    // teardown harness cannot provide. Bypass that UI-only handshake before
    // falling back to process-tree signalling; this does not alter product
    // quit behavior and keeps the smoke runner deterministic.
    try {
      await electronApp.evaluate(({ app }) => app.exit(0));
    } catch {
      // The Electron process may already have closed its automation channel.
    }
    try {
      signalCapturedProcessTree(processRef.pid, capturedProcessTree, "SIGTERM");
    } catch {
      // The process may already be gone.
    }
    if (!(await waitForCapturedProcessTreeExit(processRef.pid, capturedProcessTree, 2_000))) {
      try {
        signalCapturedProcessTree(processRef.pid, capturedProcessTree, "SIGKILL");
      } catch {
        // Ignore; process may already be gone.
      }
      if (!(await waitForCapturedProcessTreeExit(processRef.pid, capturedProcessTree, 3_000))) {
        appendBounded(
          logs,
          capturedProcessTree
            .filter(processStillMatches)
            .map((row) => row.pid)
            .join(", "),
          "[close:remaining-pids] ",
        );
      }
    }
  } finally {
    // A timed-out Playwright close continues in the background. Let it settle
    // after the owned process tree has been terminated so it cannot keep the
    // smoke runner alive indefinitely.
    if (closePromise) {
      await Promise.race([
        closePromise.catch(() => undefined),
        new Promise((resolveWait) => setTimeout(resolveWait, 1_000)),
      ]);
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

async function runElectronSmokeCore(input, state) {
  const electronLogs = [];
  const browserLogs = [];
  const assertions = [];
  state.electronLogs = electronLogs;

  logStage("dump-init-script");
  const initScript = dumpInitScript(input.createdAt, input.runtimeDir);
  logStage("import-playwright-electron");
  const electron = await importPlaywrightElectron();
  const electronBinaryPath = resolveElectronPath();
  const electronUserDataDir = join(input.runtimeDir, "electron-user-data");
  const mossHome = join(input.runtimeDir, "moss-home");
  const electronEnv = { ...process.env };
  delete electronEnv.VITE_DEV_SERVER_URL;
  mkdirSync(electronUserDataDir, { recursive: true });
  mkdirSync(mossHome, { recursive: true });

  logStage("launch-electron", MAIN_JS);
  const electronApp = await electron.launch({
    executablePath: electronBinaryPath,
    args: [`--user-data-dir=${electronUserDataDir}`, MAIN_JS],
    cwd: DESKTOP_ROOT,
    env: {
      ...electronEnv,
      ELECTRON_ENABLE_LOGGING: "1",
      // This is a source-build launch, not an installed Moss launch. The
      // marker makes the desktop main bundle reject stale output and enables
      // its dedicated smoke profile override; explicitly setting both profile
      // variables also prevents an inherited installed profile from winning
      // if Electron normalizes or drops the command-line switch.
      MOSS_SOURCE_DESKTOP_BUILD_MARKER,
      MOSS_DESKTOP_FLAVOR: "development",
      [MOSS_DESKTOP_SMOKE_USER_DATA_ENV]: electronUserDataDir,
      MOSS_DESKTOP_USER_DATA_DIR: electronUserDataDir,
      MOSS_HOME: mossHome,
      DPCODE_HOME: mossHome,
      T3CODE_HOME: mossHome,
      T3CODE_DISABLE_AUTO_UPDATE: "1",
      HOME: input.runtimeDir,
      XDG_CONFIG_HOME: join(input.runtimeDir, "xdg-config"),
      APPDATA: join(input.runtimeDir, "appdata"),
      LOCALAPPDATA: join(input.runtimeDir, "local-appdata"),
    },
    timeout: input.timeoutMs,
  });
  state.electronApp = electronApp;

  const electronProcess = electronApp.process();
  electronProcess.stdout?.on("data", (chunk) => appendBounded(electronLogs, chunk, "[electron] "));
  electronProcess.stderr?.on("data", (chunk) =>
    appendBounded(electronLogs, chunk, "[electron:err] "),
  );

  try {
    logStage("first-window");
    await electronApp.firstWindow({ timeout: input.timeoutMs });
    const page = await waitForMainWindow(electronApp, input.timeoutMs);
    const loadedAppSettingsRequests = new Set();
    page.on("request", (request) => {
      const match = /\/(appSettings-[A-Za-z0-9_-]+\.js)(?:[?#]|$)/.exec(request.url());
      if (match?.[1]) loadedAppSettingsRequests.add(match[1]);
    });
    page.on("console", (message) => {
      appendBounded(browserLogs, `[${message.type()}] ${message.text()}`);
    });
    page.on("pageerror", (error) => {
      appendBounded(browserLogs, error.stack ?? error.message, "[pageerror] ");
    });
    // The first window loads the production index before the smoke route is
    // navigated. Capture cached module resources now; after navigation the
    // browser may retain them without emitting a second request.
    for (const asset of await page.evaluate(() =>
      performance
        .getEntriesByType("resource")
        .map((entry) => {
          try {
            return new URL(entry.name).pathname.split("/").at(-1) ?? "";
          } catch {
            return "";
          }
        })
        .filter((asset) => /^appSettings-[A-Za-z0-9_-]+\.js$/.test(asset)),
    )) {
      loadedAppSettingsRequests.add(asset);
    }

    logStage("install-init-script");
    await page.addInitScript({ content: initScript });
    await page.evaluate(initScript);
    logStage("goto", DESKTOP_ROUTE);
    await page.goto(DESKTOP_ROUTE, {
      waitUntil: "domcontentloaded",
      timeout: input.timeoutMs,
    });
    await page.waitForFunction(
      () => document.documentElement.dataset.runtime === "electron",
      undefined,
      { timeout: Math.min(input.timeoutMs, 20_000) },
    );

    logStage("read-runtime-bridge");
    let runtimeEvidence = await page.evaluate(() => {
      const bridge = window.desktopBridge;
      const desktopWsUrl = typeof bridge?.getWsUrl === "function" ? bridge.getWsUrl() : null;
      return {
        hasDesktopBridge: Boolean(bridge),
        hasDesktopBridgeGetWsUrl: typeof bridge?.getWsUrl === "function",
        desktopWsUrl,
        runtimeDataset: document.documentElement.dataset.runtime ?? null,
        userAgent: navigator.userAgent,
        hasNativeApi: Boolean(window.nativeApi),
      };
    });

    if (!runtimeEvidence.hasDesktopBridge || !runtimeEvidence.hasDesktopBridgeGetWsUrl) {
      throw new Error("Electron preload desktopBridge.getWsUrl was not available.");
    }
    assertions.push("Electron preload bridge exposes desktopBridge.getWsUrl");
    if (
      !runtimeEvidence.desktopWsUrl ||
      !runtimeEvidence.desktopWsUrl.startsWith("ws://127.0.0.1:")
    ) {
      throw new Error(
        `Electron preload did not return a loopback desktop WS URL: ${String(runtimeEvidence.desktopWsUrl)}`,
      );
    }
    assertions.push("desktopBridge.getWsUrl returns live loopback backend websocket URL");

    const loadedAppSettingsAssets = [
      ...new Set([
        ...loadedAppSettingsRequests,
        ...(await page.evaluate(() =>
          performance
            .getEntriesByType("resource")
            .map((entry) => {
              try {
                return new URL(entry.name).pathname.split("/").at(-1) ?? "";
              } catch {
                return "";
              }
            })
            .filter((asset) => /^appSettings-[A-Za-z0-9_-]+\.js$/.test(asset)),
        )),
      ]),
    ];
    if (!loadedAppSettingsAssets.includes(input.expectedAppSettingsAsset)) {
      // Route restoration can reuse the initial module graph without exposing
      // a second resource entry. Verify the exact production asset is still
      // available from the static bundle before treating this as a failure.
      const staticAssetAvailable = await page.evaluate(async (asset) => {
        try {
          const response = await fetch(`/assets/${asset}`, { cache: "no-store" });
          return response.ok;
        } catch {
          return false;
        }
      }, input.expectedAppSettingsAsset);
      if (!staticAssetAvailable) {
        throw new Error(
          [
            `Electron loaded appSettings assets ${loadedAppSettingsAssets.join(", ") || "none"}`,
            `expected current ${input.expectedAppSettingsAsset}`,
          ].join("; "),
        );
      }
      assertions.push(
        "current source appSettings asset is available from the production static bundle",
      );
    } else {
      assertions.push("Electron renderer loaded the current source appSettings asset");
    }

    logStage("backend-health", runtimeEvidence.desktopWsUrl);
    const backendHealth = await waitForBackendHealth(
      runtimeEvidence.desktopWsUrl,
      Math.min(input.timeoutMs, 45_000),
      electronLogs,
    );
    assertions.push("real Node backend responds on /health through desktop bridge URL");
    const websocketNegotiation = await verifyBackendWebSocketTransport(
      runtimeEvidence.desktopWsUrl,
      Math.min(input.timeoutMs, 15_000),
    );
    assertions.push("production backend WebSocket negotiation and feature handshake succeed");

    logStage("backend-process", String(electronProcess.pid));
    const processEvidence = await waitForBackendProcess(
      electronProcess.pid,
      Math.min(input.timeoutMs, 20_000),
    );
    if (!processEvidence.backend) {
      throw new Error(
        `Unable to find real Node backend child process under Electron pid ${electronProcess.pid}. Children: ${processEvidence.children.join(" | ")}`,
      );
    }
    assertions.push("Electron process tree contains apps/server/dist backend child process");

    if (runtimeEvidence.runtimeDataset !== "electron") {
      throw new Error(
        `Renderer runtime dataset should be electron, got ${String(runtimeEvidence.runtimeDataset)}`,
      );
    }
    assertions.push("renderer detected Electron runtime from preload bridge");

    try {
      logStage("assert-composer");
      await assertSelector(
        page,
        "form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']",
        "composer shell mounted from Electron product route",
        assertions,
      );
    } catch (error) {
      await recordBodySnapshot(page, browserLogs, "composer-timeout");
      throw error;
    }
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-visible-attachment-control='true']",
      "composer attachment control is visible in the running shell",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-visible-model-reasoning-control]",
      "composer model or reasoning control is visible in the running shell",
      assertions,
      browserLogs,
    );
    logStage("assert-access-strip");
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-native-shell-access='true'][data-moss-native-shell-provider='codex'][data-moss-native-shell-session-status='running']",
      "native Moss shell access strip reflects active codex running session",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-native-shell-access='true'][data-moss-shell-productization-source='route-toggle'][data-moss-shell-productization-mode='explicit-toggle']",
      "native Moss shell is enabled by explicit harness route under Electron",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-visible-stop-control='true']",
      "running-session stop control is visible",
      assertions,
      browserLogs,
    );
    logStage("assert-event-timeline");
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-control-plane-events]",
      "default normalized event surface is visible",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-event-count='8']",
      "normalized event subscription is live with fixture events",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-normalized-row][data-event-type='tool-result'][data-tool-lifecycle-state='succeeded']",
      "tool-call and tool-result lifecycle is normalized",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-normalized-row][data-event-type='usage'][data-usage-model='gpt-5.3-codex']",
      "usage event renders from normalized timeline",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-normalized-row][data-event-type='permission-request'] [data-moss-normalized-permission-action-shell]",
      "permission request action shell is available from normalized event",
      assertions,
      browserLogs,
    );

    const bodyAfterEvents = await page.locator("body").innerText();
    if (bodyAfterEvents.includes("codex.raw.served")) {
      throw new Error("Raw provider event source leaked into visible Electron shell.");
    }
    assertions.push("raw provider event source is not rendered");
    const codexDesktopInteractionAcceptance = await collectCodexDesktopInteractionAcceptance(page, {
      baselineScreenshotPath: CODEX_DESKTOP_BASELINE_SCREENSHOT,
      expectedBaselineTraits: EXPECTED_BASELINE_TRAITS,
    });
    const missingActiveEventTypes = EXPECTED_ACTIVE_EVENT_TYPES.filter(
      (eventType) => !codexDesktopInteractionAcceptance.activeEventTypes.includes(eventType),
    );
    if (missingActiveEventTypes.length > 0) {
      throw new Error(
        `Active normalized timeline is missing event types: ${missingActiveEventTypes.join(", ")}`,
      );
    }
    if (
      !codexDesktopInteractionAcceptance.composerControls.attachment ||
      !codexDesktopInteractionAcceptance.composerControls.modelOrReasoning ||
      !codexDesktopInteractionAcceptance.composerControls.stop ||
      !codexDesktopInteractionAcceptance.normalizedTimeline.toolLifecycle ||
      !codexDesktopInteractionAcceptance.normalizedTimeline.permissionAction ||
      !codexDesktopInteractionAcceptance.normalizedTimeline.usage ||
      !codexDesktopInteractionAcceptance.normalizedTimeline.finish ||
      !codexDesktopInteractionAcceptance.rawProviderSourceHidden
    ) {
      throw new Error(
        "Codex Desktop broader interaction control set is incomplete in the Electron shell.",
      );
    }
    assertions.push("Codex Desktop baseline-backed active shell control set is visible");
    assertions.push("active normalized timeline covers text, tool, permission, usage, and finish");
    const routeBeforeSwitches = normalizeMossShellRouteHref(page.url());
    const visitedSurfaces = ["events"];

    await page
      .locator(
        "[data-event-id='moss-served-smoke-normalized-4'] [data-permission-action-intent='approve']",
      )
      .click();
    await assertSelectorWithSnapshot(
      page,
      "[data-event-id='moss-served-smoke-normalized-4'] [data-moss-normalized-permission-action-shell][data-permission-action-status='accepted'][data-permission-action-enabled='false']",
      "permission request approve action transitions to accepted",
      assertions,
      browserLogs,
    );
    const permissionActionStatus = await page
      .locator(
        "[data-event-id='moss-served-smoke-normalized-4'] [data-moss-normalized-permission-action-shell]",
      )
      .getAttribute("data-permission-action-status");

    logStage("assert-session-list");
    await page.locator("[data-moss-native-session-list-access='true']").click();
    visitedSurfaces.push("sessions");
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='thread-moss-served-smoke'][data-session-status='running']",
      "session list surface shows Electron runtime session",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      `[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='${SECONDARY_THREAD_ID}'][data-provider='Claude'][data-session-status='ready']`,
      "session list surface shows secondary provider session",
      assertions,
      browserLogs,
    );
    await page
      .locator(
        `[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='${SECONDARY_THREAD_ID}']`,
      )
      .click();
    await assertSelectorWithSnapshot(
      page,
      `[data-moss-control-plane-sessions] [data-moss-session-list-row][data-thread-id='${SECONDARY_THREAD_ID}'][data-selected-session='true'][data-active-thread='false']`,
      "secondary provider session can be selected without changing the active thread",
      assertions,
      browserLogs,
    );

    logStage("assert-selected-session-event-timeline");
    await page.locator("[data-moss-native-normalized-event-timeline-access='true']").click();
    visitedSurfaces.push("events");
    await assertSelectorWithSnapshot(
      page,
      `[data-moss-control-plane-events] [data-moss-normalized-session-scope][data-scope-thread-id='${SECONDARY_THREAD_ID}'][data-scope-active-thread='false']`,
      "normalized event surface scopes to selected secondary session",
      assertions,
      browserLogs,
    );
    const selectedSessionSubscription = page.locator(
      `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${SECONDARY_THREAD_ID}']`,
    );
    await assertSelectorWithSnapshot(
      page,
      `[data-moss-normalized-subscription-state][data-subscription-status='live'][data-subscription-scope='selected-session'][data-subscription-thread-id='${SECONDARY_THREAD_ID}'][data-subscription-event-count='1']`,
      "selected secondary session normalized timeline renders without active-thread event bleed",
      assertions,
      browserLogs,
    );
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-control-plane-events] [data-moss-normalized-row][data-event-type='text'][data-text-stream-kind='assistant_text']",
      "selected secondary session normalized row is visible",
      assertions,
      browserLogs,
    );
    const selectedEventSurfaceText = await page
      .locator("[data-moss-control-plane-events]")
      .innerText();
    if (!selectedEventSurfaceText.includes("moss served smoke secondary session text")) {
      throw new Error("Selected secondary session text did not render in the Electron shell.");
    }
    if (
      selectedEventSurfaceText.includes("moss served smoke assistant text") ||
      selectedEventSurfaceText.includes("claude.raw.served") ||
      selectedEventSurfaceText.includes("codex.raw.served")
    ) {
      throw new Error(
        "Selected secondary session timeline leaked active-thread or raw event text.",
      );
    }
    assertions.push(
      "selected secondary session timeline hides active-thread and raw provider text",
    );

    logStage("assert-launch-plan");
    await page.locator("[data-moss-native-launch-plan-access='true']").click();
    visitedSurfaces.push("launch-plan");
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-control-plane-launch-plan]",
      "launch plan inspector surface is visible",
      assertions,
      browserLogs,
    );
    const launchText = await page.locator("[data-moss-control-plane-launch-plan]").innerText();
    if (!launchText.includes("sha256:moss-served-smoke-secondary")) {
      throw new Error("Launch plan inspector did not render the selected secondary plan hash.");
    }
    assertions.push("launch plan inspector renders selected secondary redacted plan hash");

    logStage("assert-loop-ledger");
    await page.locator("[data-moss-native-loop-ledger-access='true']").click();
    visitedSurfaces.push("ledger");
    await assertSelectorWithSnapshot(
      page,
      "[data-moss-control-plane-ledger]",
      "loop ledger dashboard surface is visible",
      assertions,
      browserLogs,
    );
    const ledgerText = await page.locator("[data-moss-control-plane-ledger]").innerText();
    if (!ledgerText.includes("moss-task-0081")) {
      throw new Error("Loop ledger dashboard did not render fixture task context.");
    }
    assertions.push("loop ledger dashboard renders task context");

    logStage("assert-event-surface-after-switch");
    await page.locator("[data-moss-native-normalized-event-timeline-access='true']").click();
    visitedSurfaces.push("events");
    await assertSelectorWithSnapshot(
      page,
      `[data-moss-control-plane-events] [data-moss-normalized-subscription-state][data-subscription-scope='selected-session'][data-subscription-thread-id='${SECONDARY_THREAD_ID}'][data-subscription-event-count='1']`,
      "selected-session event surface remains available after surface switches",
      assertions,
      browserLogs,
    );
    const firstScreenLayoutEvidence = await collectFirstScreenLayoutEvidence(page, input.createdAt);
    assertions.push("first-screen layout geometry evidence recorded");
    const composerThreadIdAfterSwitches = await page
      .locator("form[data-chat-composer-form='true'][data-moss-visible-composer-shell='true']")
      .getAttribute("data-moss-visible-thread-id");
    if (composerThreadIdAfterSwitches !== THREAD_ID) {
      throw new Error("Composer thread changed during Moss surface switching.");
    }
    const routeAfterSwitches = normalizeMossShellRouteHref(page.url());
    if (routeAfterSwitches !== routeBeforeSwitches) {
      throw new Error(
        `Moss surface switching changed the active route: ${routeBeforeSwitches} -> ${routeAfterSwitches}`,
      );
    }
    assertions.push("composer and active route remain stable across Moss surface switches");
    const selectedSessionEventCount = Number(
      (await selectedSessionSubscription.getAttribute("data-subscription-event-count")) ?? "0",
    );
    const interactionContinuity = {
      routeBeforeSwitches,
      routeAfterSwitches,
      composerThreadIdAfterSwitches,
      visitedSurfaces,
      selectedSessionThreadId: SECONDARY_THREAD_ID,
      selectedSessionEventCount,
      permissionActionStatus,
      launchPlanHashVisible: "sha256:moss-served-smoke-secondary",
    };
    codexDesktopInteractionAcceptance.permissionActionStatus = permissionActionStatus;
    codexDesktopInteractionAcceptance.selectedSessionThreadId = SECONDARY_THREAD_ID;
    codexDesktopInteractionAcceptance.selectedSessionEventCount = selectedSessionEventCount;
    codexDesktopInteractionAcceptance.launchPlanHashVisible = "sha256:moss-served-smoke-secondary";
    codexDesktopInteractionAcceptance.routeBeforeSwitches = routeBeforeSwitches;
    codexDesktopInteractionAcceptance.routeAfterSwitches = routeAfterSwitches;
    codexDesktopInteractionAcceptance.composerThreadIdAfterSwitches = composerThreadIdAfterSwitches;
    codexDesktopInteractionAcceptance.visitedSurfaces = visitedSurfaces;
    codexDesktopInteractionAcceptance.fullCodexParityClaim = false;
    assertions.push("Codex Desktop broader interaction path preserves selected-session drilldown");

    runtimeEvidence = await page.evaluate(() => ({
      hasDesktopBridge: Boolean(window.desktopBridge),
      hasNativeApi: Boolean(window.nativeApi),
      runtimeDataset: document.documentElement.dataset.runtime ?? null,
      routeHref: window.location.href,
    }));
    runtimeEvidence.routeHref = normalizeMossShellRouteHref(runtimeEvidence.routeHref);

    if (input.screenshotPath) {
      const absoluteScreenshotPath = resolveRepoPath(input.screenshotPath);
      mkdirSync(dirname(absoluteScreenshotPath), { recursive: true });
      logStage("screenshot", absoluteScreenshotPath);
      await page.screenshot({ path: absoluteScreenshotPath, fullPage: true });
    }

    return {
      assertions,
      interactionContinuity,
      codexDesktopInteractionAcceptance,
      firstScreenLayoutEvidence,
      runtimeEvidence,
      backendHealth,
      websocketNegotiation: {
        protocolEpoch: websocketNegotiation.protocolEpoch,
        negotiatedRevision: websocketNegotiation.negotiatedRevision,
        serverBuild: websocketNegotiation.serverBuild,
        serverInstanceId: websocketNegotiation.serverInstanceId,
      },
      processEvidence: {
        electronPid: electronProcess.pid,
        backend: processEvidence.backend,
        children: processEvidence.children,
      },
      electronBinaryPath,
      electronUserDataDir,
      mossHome,
      electronLogTail: electronLogs,
      browserLogTail: browserLogs,
      staticAssetEvidence: {
        expectedAppSettingsAsset: input.expectedAppSettingsAsset,
        loadedAppSettingsAssets,
      },
    };
  } catch (error) {
    if (browserLogs.length > 0) {
      console.error("[moss-product-shell-smoke] browser log tail:");
      for (const line of browserLogs) {
        console.error(line);
      }
    }
    if (electronLogs.length > 0) {
      console.error("[moss-product-shell-smoke] electron log tail:");
      for (const line of electronLogs) {
        console.error(line);
      }
    }
    throw error;
  } finally {
    await closeElectronApp(electronApp, electronLogs);
    state.electronApp = null;
  }
}

async function runElectronSmoke(input) {
  const state = {
    electronApp: null,
    electronLogs: [],
  };
  return withHardTimeout(runElectronSmokeCore(input, state), input.timeoutMs + 30_000, async () => {
    logStage("hard-timeout-cleanup");
    if (state.electronApp) {
      await closeElectronApp(state.electronApp, state.electronLogs);
      state.electronApp = null;
    }
  });
}

async function main(argv) {
  const options = parseArgs(argv);
  assertRequiredFile(MAIN_JS, "desktop main bundle");
  assertRequiredFile(PRELOAD_JS, "desktop preload bundle");
  assertRequiredFile(SERVER_ENTRY, "server backend bundle");
  assertRequiredFile(WEB_INDEX, "web desktop static bundle");

  const runtimeDir = mkdtempSync(join(tmpdir(), "moss-electron-smoke-"));
  const smoke = await runElectronSmoke({
    createdAt: options.createdAt,
    runtimeDir,
    timeoutMs: options.timeoutMs,
    screenshotPath: options.screenshotPath,
    expectedAppSettingsAsset: resolveCurrentAppSettingsAsset(),
  });

  const report = {
    createdAt: options.createdAt,
    route: DESKTOP_ROUTE,
    desktopRuntime: "electron",
    backendMode: "real-node",
    assertions: smoke.assertions,
    interactionContinuity: smoke.interactionContinuity,
    codexDesktopInteractionAcceptance: smoke.codexDesktopInteractionAcceptance,
    firstScreenLayoutEvidence: {
      ...smoke.firstScreenLayoutEvidence,
      evidence: [
        ...(options.screenshotPath ? [options.screenshotPath] : []),
        ...(options.reportPath ? [options.reportPath] : []),
      ],
    },
    runtimeEvidence: smoke.runtimeEvidence,
    backendHealth: smoke.backendHealth,
    processEvidence: smoke.processEvidence,
    electronBinaryPath: smoke.electronBinaryPath,
    bundles: {
      main: MAIN_JS,
      preload: PRELOAD_JS,
      serverEntry: SERVER_ENTRY,
      webIndex: WEB_INDEX,
    },
    staticAssetEvidence: smoke.staticAssetEvidence,
    runtimeDir,
    runtimeDirRetained: true,
    electronUserDataDir: smoke.electronUserDataDir,
    mossHome: smoke.mossHome,
    ...(options.screenshotPath ? { screenshotPath: options.screenshotPath } : {}),
    electronLogTail: smoke.electronLogTail,
    browserLogTail: smoke.browserLogTail,
  };

  if (options.reportPath) {
    const absoluteReportPath = resolveRepoPath(options.reportPath);
    mkdirSync(dirname(absoluteReportPath), { recursive: true });
    writeFileSync(absoluteReportPath, `${JSON.stringify(report, null, 2)}\n`);
  }

  console.log(JSON.stringify(report, null, 2));
  return 0;
}

main(process.argv.slice(2)).then(
  (status) => {
    process.exitCode = status;
  },
  (error) => {
    console.error(error instanceof Error ? error.stack : String(error));
    process.exitCode = 1;
  },
);
