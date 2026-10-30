#!/usr/bin/env node

import { createRequire } from "node:module";
import { writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acceptancePrompt,
  appPageMatches,
  buildAppHashRoute,
  chatSubmissionWasObserved,
  createAcceptanceMarker,
  parseMossKeyE2EOptions,
  removedMossKeyStateIsClean,
} from "./moss-key-chat-e2e.helpers.mjs";

delete process.env.NODE_DEBUG;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const WEB_ROOT = resolve(REPO_ROOT, "apps", "web");

let activeStep = "configuration";
let connectedPage = null;
let optionsForCleanup = null;
let exiting = false;
let safeFailureOutcome = "unexpected_failure";
let safeFailureDetails = null;

const SAFE_VERIFICATION_OUTCOMES = new Set([
  "chat_unavailable",
  "cleanup_failed",
  "form_unavailable",
  "gateway_unavailable",
  "key_rejected",
  "model_unavailable",
  "quota_exhausted",
  "removed_key_not_cleared",
  "save_failed",
  "saved_key_missing",
  "saved_key_not_selected",
  "selection_failed",
  "state_pending",
  "state_unavailable",
  "submission_timeout",
  "ui_error",
  "verification_timeout",
]);

const KEY_FORM_WAIT_TIMEOUT_MS = 30_000;
const KEY_FORM_ACTION_TIMEOUT_MS = 10_000;
const KEY_FORM_SUBMIT_ATTEMPTS = 2;
const APP_SNAP_WELCOME_WAIT_TIMEOUT_MS = 5_000;
const CHAT_PRIMARY_SUBMIT_WAIT_TIMEOUT_MS = 15_000;
const CHAT_RECOVERY_SUBMIT_WAIT_TIMEOUT_MS = 30_000;

// The installed app follows the user's locale. Keep user-facing locators
// explicit for every locale shipped by Moss so the native acceptance gate
// exercises the visible UI instead of requiring an English host machine.
const UI_COPY = {
  appSnapHeading: /^(?:AppSnap is ready!|应用截图（AppSnap）已就绪！)$/u,
  appSnapDismiss: /^(?:Not now|暂不设置)$/u,
  keyHeading: /^使用企业 API Key 登录$/u,
  keyDescription: /全部模型 · 国内网络直连/u,
  checkingKey: /^正在检查企业 API Key…$/u,
  continueToMoss: /^进入 Moss$/u,
  removeSavedKey: /^移除 Key$/u,
  savedKeyNotice: /本机已保存 moss_sk_/u,
};

function printStatus(kind, step) {
  process.stderr.write(`[moss-key-e2e] ${kind} ${step}\n`);
}

async function writeSafeFailureDiagnostic() {
  const diagnosticPath = process.env.MOSS_KEY_E2E_DIAGNOSTIC_PATH?.trim();
  if (!diagnosticPath) return;
  const outcome = SAFE_VERIFICATION_OUTCOMES.has(safeFailureOutcome)
    ? safeFailureOutcome
    : "unexpected_failure";
  const diagnostic = {
    schemaVersion: 3,
    step: activeStep,
    outcome,
    platform: process.platform,
    ...(safeFailureDetails ? { details: safeFailureDetails } : {}),
  };
  try {
    await writeFile(diagnosticPath, `${JSON.stringify(diagnostic, null, 2)}\n`, {
      encoding: "utf8",
      mode: 0o600,
    });
  } catch {
    // Diagnostics are best-effort and must never replace the acceptance result.
  }
}

function printHelp() {
  process.stdout.write(`Moss enterprise key real-chat E2E\n\n`);
  process.stdout.write(`Connects to an already-running Electron CDP endpoint.\n`);
  process.stdout.write(`Launch Moss with an isolated profile and CDP bound to loopback.\n\n`);
  process.stdout.write(`Fresh-login environment variable:\n`);
  process.stdout.write(
    `  MOSS_KEY_E2E_KEY         Required unless using a verification-only mode; never a CLI arg\n\n`,
  );
  process.stdout.write(`Options (equivalent environment variable):\n`);
  process.stdout.write(`  --cdp-url URL            MOSS_KEY_E2E_CDP_URL\n`);
  process.stdout.write(`  --app-url URL            MOSS_KEY_E2E_APP_URL\n`);
  process.stdout.write(`  --timeout-ms NUMBER      MOSS_KEY_E2E_TIMEOUT_MS\n`);
  process.stdout.write(`  --expect-saved-key       MOSS_KEY_E2E_EXPECT_SAVED_KEY=1\n`);
  process.stdout.write(`  --expect-removed-key     MOSS_KEY_E2E_EXPECT_REMOVED_KEY=1\n`);
  process.stdout.write(`  --keep-key-on-success    MOSS_KEY_E2E_KEEP_KEY_ON_SUCCESS=1\n`);
  process.stdout.write(`  --keep-key               MOSS_KEY_E2E_KEEP_KEY=1\n\n`);
  process.stdout.write(
    `Verification-only modes reject MOSS_KEY_E2E_KEY and Key retention flags.\n`,
  );
  process.stdout.write(`Removed-Key verification does not chat or mutate Key state.\n`);
  process.stdout.write(
    `Other runs remove the test Key by default after a successful real reply.\n`,
  );
}

async function runStep(name, operation) {
  activeStep = name;
  printStatus("RUN", name);
  const result = await operation();
  printStatus("PASS", name);
  return result;
}

function packageRequire(packageJsonPath) {
  return createRequire(resolve(REPO_ROOT, packageJsonPath));
}

async function importChromium() {
  // Protocol-level Playwright debug logs can include action payloads. Disable
  // opt-in automation debugging before loading Playwright so the password-field
  // value cannot be echoed even when a runner has DEBUG/PWDEBUG set globally.
  delete process.env.DEBUG;
  delete process.env.PWDEBUG;
  const requireFromWeb = packageRequire("apps/web/package.json");
  const moduleUrl = pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
  const playwright = await import(moduleUrl);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error("Playwright Chromium unavailable");
  return chromium;
}

async function connectToExistingPage(options) {
  const chromium = await importChromium();
  const browser = await chromium.connectOverCDP(options.cdpUrl, {
    timeout: options.timeoutMs,
  });
  const pages = browser.contexts().flatMap((context) => context.pages());
  const page = pages.find((candidate) => appPageMatches(candidate.url(), options.appUrl));
  if (!page) throw new Error("matching Electron page unavailable");
  const isElectron = await page.evaluate(() => /\bElectron\/\d/i.test(navigator.userAgent));
  if (!isElectron) throw new Error("CDP target is not Electron");
  page.setDefaultTimeout(options.timeoutMs);
  page.setDefaultNavigationTimeout(options.timeoutMs);
  return page;
}

async function gotoRoute(page, options, route) {
  await page.goto(buildAppHashRoute(options.appUrl, route), {
    waitUntil: "domcontentloaded",
  });
  await page.waitForFunction((path) => window.location.hash.startsWith(`#${path}`), route);
}

async function dismissAppSnapWelcomeIfPresent(page) {
  if (process.platform !== "darwin") return;

  const dialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: UI_COPY.appSnapHeading }),
  });
  const dismissButton = dialog.getByRole("button", { name: UI_COPY.appSnapDismiss });
  const appeared = await dismissButton
    .waitFor({ state: "visible", timeout: APP_SNAP_WELCOME_WAIT_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;

  await dismissButton.click({ timeout: KEY_FORM_ACTION_TIMEOUT_MS });
  await dialog.waitFor({ state: "detached", timeout: KEY_FORM_ACTION_TIMEOUT_MS });
  printStatus("PASS", "dismiss-appsnap-welcome");
}

async function waitForKeyVerificationOutcome(page) {
  const outcomeHandle = await page.waitForFunction(
    () => {
      if (!window.location.hash.startsWith("#/login")) return "success";

      const alertText = [...document.querySelectorAll('[role="alert"]')]
        .map((alert) => alert.textContent?.trim() ?? "")
        .join(" ");
      if (!alertText) return false;
      const savedKeyVisible = [...document.querySelectorAll('[role="status"]')].some((status) =>
        /本机已保存 moss_sk_/u.test(status.textContent ?? ""),
      );
      if (/(?:无效或已被吊销|以 moss_sk_ 开头)/u.test(alertText)) return "key_rejected";
      if (/没有可用的模型额度/u.test(alertText)) return "quota_exhausted";
      if (/无法连接 Moss 模型服务/u.test(alertText)) return "gateway_unavailable";
      if (/无法在本机安全保存/u.test(alertText)) {
        return savedKeyVisible ? "selection_failed" : "save_failed";
      }
      return "ui_error";
    },
    undefined,
    // The server-side gateway probe is bounded to 10 seconds. Three times that
    // budget distinguishes a genuine UI/backend hang from a slow response while
    // keeping the native acceptance job actionable.
    { polling: "raf", timeout: 30_000 },
  );
  return outcomeHandle.jsonValue();
}

async function waitForKeyFormAvailability(page) {
  try {
    const outcomeHandle = await page.waitForFunction(
      () => {
        const input = document.querySelector("#moss-enterprise-api-key");
        if (
          input instanceof HTMLInputElement &&
          !input.disabled &&
          Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length)
        ) {
          return "ready";
        }

        const alertText = [...document.querySelectorAll('[role="alert"]')]
          .map((alert) => alert.textContent?.trim() ?? "")
          .join(" ");
        if (/无法连接 Moss，/u.test(alertText)) {
          return "state_unavailable";
        }
        return false;
      },
      undefined,
      { polling: "raf", timeout: KEY_FORM_WAIT_TIMEOUT_MS },
    );
    return outcomeHandle.jsonValue();
  } catch {
    const stillPending = await page
      .getByRole("status")
      .filter({ hasText: UI_COPY.checkingKey })
      .isVisible()
      .catch(() => false);
    return stillPending ? "state_pending" : "form_unavailable";
  }
}

async function waitForSavedKeyAvailability(page) {
  try {
    const outcomeHandle = await page.waitForFunction(
      () => {
        const savedKeyVisible = [...document.querySelectorAll('[role="status"]')].some((status) =>
          /本机已保存 moss_sk_/u.test(status.textContent ?? ""),
        );
        if (savedKeyVisible) return "ready";

        const alertText = [...document.querySelectorAll('[role="alert"]')]
          .map((alert) => alert.textContent?.trim() ?? "")
          .join(" ");
        if (/无法连接 Moss，/u.test(alertText)) {
          return "state_unavailable";
        }

        const input = document.querySelector("#moss-enterprise-api-key");
        if (
          input instanceof HTMLInputElement &&
          Boolean(input.offsetWidth || input.offsetHeight || input.getClientRects().length)
        ) {
          return "saved_key_missing";
        }
        return false;
      },
      undefined,
      { polling: "raf", timeout: KEY_FORM_WAIT_TIMEOUT_MS },
    );
    return outcomeHandle.jsonValue();
  } catch {
    const stillPending = await page
      .getByRole("status")
      .filter({ hasText: UI_COPY.checkingKey })
      .isVisible()
      .catch(() => false);
    return stillPending ? "state_pending" : "saved_key_missing";
  }
}

async function readSafeMossEnterpriseKeyState(page) {
  return page.evaluate(async (timeoutMs) => {
    const readState = window.nativeApi?.server?.getMossEnterpriseKeyState;
    if (typeof readState === "function") {
      try {
        const state = await Promise.race([
          window.nativeApi.server.getMossEnterpriseKeyState(),
          new Promise((resolve) => setTimeout(() => resolve(null), timeoutMs)),
        ]);
        if (state) {
          // A signed-in key is "configured"; the key owning Moss is "selected".
          return {
            configured: state.authenticated === true,
            selected: state.active === true,
            providerInstanceId: null,
            model: null,
          };
        }
      } catch {
        // Current packaged builds use the WebSocket-native API rather than
        // exposing it on window. Fall through to the same rendered state that
        // a user can observe and act on.
      }
    }

    const visible = (element) =>
      element instanceof HTMLElement &&
      Boolean(element.offsetWidth || element.offsetHeight || element.getClientRects().length);
    const statuses = [...document.querySelectorAll('[role="status"]')];
    const buttons = [...document.querySelectorAll("button")];
    const savedKeyNotice = statuses.some(
      (status) => visible(status) && /本机已保存 moss_sk_/u.test(status.textContent ?? ""),
    );
    const hasVisibleButton = (pattern) =>
      buttons.some((button) => visible(button) && pattern.test(button.textContent?.trim() ?? ""));
    const continueToMoss = hasVisibleButton(/^进入 Moss$/u);
    const continueWithSavedKey = hasVisibleButton(/^使用已保存的 Key$/u);
    const removeSavedKey = hasVisibleButton(/^移除 Key$/u);
    const keyInput = document.querySelector("#moss-enterprise-api-key");
    if (!visible(keyInput) && !savedKeyNotice && !removeSavedKey) return null;

    return {
      configured: savedKeyNotice || removeSavedKey,
      selected: continueToMoss && !continueWithSavedKey,
      providerInstanceId: null,
      model: null,
    };
  }, 10_000);
}

async function waitForChatAvailability(page) {
  return page
    .locator('[data-testid="composer-editor"]')
    .last()
    .waitFor({
      state: "visible",
      timeout: KEY_FORM_WAIT_TIMEOUT_MS,
    })
    .then(() => true)
    .catch(() => false);
}

async function submitKeyForm(page, options) {
  for (let attempt = 1; attempt <= KEY_FORM_SUBMIT_ATTEMPTS; attempt += 1) {
    if (attempt > 1) {
      printStatus("RUN", "recover-key-form-submit");
      await gotoRoute(page, options, "/login/api-key");
    }

    const formAvailability = await waitForKeyFormAvailability(page);
    if (formAvailability !== "ready") continue;

    const keyInput = page.locator("#moss-enterprise-api-key");
    try {
      await keyInput.fill(options.key, { timeout: KEY_FORM_ACTION_TIMEOUT_MS });
      await keyInput.focus({ timeout: KEY_FORM_ACTION_TIMEOUT_MS });
    } catch {
      // A brand-new packaged profile can replace the first mounted form while
      // backend state settles. Re-open the fixed route once, but never retry a
      // request after the Enter event has been dispatched.
      continue;
    }

    // Submit through the focused password field. This is the native user path
    // and avoids retaining a button locator while a cold Windows render
    // replaces the form during its first React Query state transition.
    try {
      await page.keyboard.press("Enter");
    } catch {
      return false;
    }
    if (attempt > 1) printStatus("PASS", "recover-key-form-submit");
    return true;
  }
  return false;
}

async function waitForVirtualizedTimelineMarker(page, { marker, role, requireIdle = false }) {
  await page.waitForFunction(
    ({ expectedMarker, expectedRole, expectedIdle }) => {
      const scrollContainer = document.querySelector('[data-chat-scroll-container="true"]');
      if (scrollContainer instanceof HTMLElement) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }

      const selector =
        expectedRole === "assistant"
          ? '[data-message-role="assistant"] [data-assistant-message-id]'
          : '[data-message-role="user"]';
      const messages = [...document.querySelectorAll(selector)];
      const markerVisible = messages.some((message) => {
        const text = message.textContent?.trim() ?? "";
        return expectedRole === "assistant"
          ? text === expectedMarker
          : text.includes(expectedMarker);
      });
      const stillRunning = Boolean(
        document.querySelector('[data-moss-visible-stop-control="true"]'),
      );
      return markerVisible && (!expectedIdle || !stillRunning);
    },
    {
      expectedMarker: marker,
      expectedRole: role,
      expectedIdle: requireIdle,
    },
    { polling: "raf" },
  );
}

async function readChatSubmissionSnapshot(page, { marker, prompt }) {
  return page.evaluate(
    ({ expectedMarker, expectedPrompt }) => {
      const activeEditor = [...document.querySelectorAll('[data-testid="composer-editor"]')].at(-1);
      const sendControl = [
        ...document.querySelectorAll('[data-moss-visible-send-control="true"]'),
      ].at(-1);
      const markerVisible = [...document.querySelectorAll('[data-message-role="user"]')].some(
        (message) => (message.textContent?.trim() ?? "").includes(expectedMarker),
      );
      return {
        editorPresent: activeEditor instanceof HTMLElement,
        editorMatchesPrompt:
          activeEditor instanceof HTMLElement
            ? (activeEditor.textContent?.trim() ?? "") === expectedPrompt
            : false,
        markerVisible,
        sendState:
          sendControl instanceof HTMLElement
            ? (sendControl.dataset.mossVisibleSendState ?? null)
            : null,
        transcriptMounted: Boolean(document.querySelector('[data-chat-scroll-container="true"]')),
        turnRunning: Boolean(document.querySelector('[data-moss-visible-stop-control="true"]')),
      };
    },
    { expectedMarker: marker, expectedPrompt: prompt },
  );
}

async function waitForObservedChatSubmission(page, { marker, prompt, timeoutMs }) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const snapshot = await readChatSubmissionSnapshot(page, { marker, prompt });
    if (chatSubmissionWasObserved(snapshot)) return true;
    await page.waitForTimeout(100);
  }
  return false;
}

async function readSafeChatFailureDetails(page, { prompt }) {
  return page.evaluate(
    async ({ expectedPrompt }) => {
      const editor = [...document.querySelectorAll('[data-testid="composer-editor"]')].at(-1);
      const composerForm = [
        ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
      ].at(-1);
      const sendControls = [
        ...document.querySelectorAll('[data-moss-visible-send-control="true"]'),
      ];
      const sendControl = sendControls.at(-1);
      const safeValue = (value, allowed) =>
        typeof value === "string" && allowed.includes(value) ? value : null;
      const attributeBoolean = (element, attribute) => {
        const value = element instanceof HTMLElement ? element.getAttribute(attribute) : null;
        return value === "true" ? true : value === "false" ? false : null;
      };
      const alerts = [...document.querySelectorAll('[role="alert"]')];
      const alertSurfaces = [
        ...new Set(
          alerts.map((alert) => (alert.closest('[data-slot="toast-popup"]') ? "toast" : "inline")),
        ),
      ];
      const alertSources = [
        ...new Set(
          alerts.map((alert) => {
            if (alert.closest('[data-slot="toast-popup"]')) return "toast";
            if (alert.querySelector('[aria-label="Dismiss error"]')) return "thread-error";
            if (alert.querySelector('[aria-label="Dismiss rate limit status"]')) {
              return "rate-limit";
            }
            if (alert.querySelector('[data-slot="alert-title"]')) return "provider-health";
            return "inline-other";
          }),
        ),
      ];
      const alertClassifications = [
        ...new Set(
          alerts.map((alert) => {
            const text = alert.textContent ?? "";
            if (/Provider status is still loading/i.test(text)) return "provider-status-loading";
            if (/is not authenticated yet/i.test(text)) return "provider-not-authenticated";
            if (/is unavailable right now/i.test(text)) return "provider-unavailable";
            if (/has limited availability right now/i.test(text)) {
              return "provider-limited-availability";
            }
            if (/thread\.create|Thread '.+' already exists/i.test(text)) {
              return "thread-create";
            }
            if (/project\.create|Project '.+' already exists/i.test(text)) {
              return "project-create";
            }
            if (/thread\.turn\.start/i.test(text)) return "turn-start";
            if (/orchestration|dispatch command/i.test(text)) return "orchestration";
            if (/disconnect|connect|socket|transport/i.test(text)) return "connection";
            return "other";
          }),
        ),
      ];

      const api = window.nativeApi;
      const readWithTimeout = (operation) =>
        Promise.race([
          operation().catch(() => null),
          new Promise((resolve) => setTimeout(() => resolve(null), 5_000)),
        ]);
      const [config, settings, shellSnapshot] = api
        ? await Promise.all([
            readWithTimeout(() => api.server.getConfig()),
            readWithTimeout(() => api.server.getSettings()),
            readWithTimeout(() => api.orchestration.getShellSnapshot()),
          ])
        : [null, null, null];

      const managedStatus = config?.providers?.find((status) => status.instanceId === "codex_moss");
      const activeThreadId =
        composerForm instanceof HTMLElement
          ? (composerForm.dataset.mossVisibleThreadId ?? null)
          : null;
      const serverThread =
        activeThreadId && shellSnapshot
          ? shellSnapshot.threads.find((thread) => String(thread.id) === activeThreadId)
          : null;

      return {
        composer: {
          editorPresent: editor instanceof HTMLElement,
          editorMatchesPrompt:
            editor instanceof HTMLElement
              ? (editor.textContent?.trim() ?? "") === expectedPrompt
              : false,
          sendControlCount: sendControls.length,
          sendControlDisabled:
            sendControl instanceof HTMLButtonElement ? sendControl.disabled : null,
          sendState:
            sendControl instanceof HTMLElement
              ? safeValue(sendControl.dataset.mossVisibleSendState, [
                  "empty",
                  "ready",
                  "connecting",
                  "preparing-worktree",
                  "sending",
                  "transcribing",
                  "loading-models",
                ])
              : null,
          projectReady: attributeBoolean(composerForm, "data-moss-visible-project-ready"),
          provider:
            composerForm instanceof HTMLElement
              ? safeValue(composerForm.dataset.mossVisibleProvider, [
                  "codex",
                  "claudeAgent",
                  "cursor",
                  "gemini",
                  "antigravity",
                  "grok",
                  "opencode",
                  "pi",
                ])
              : null,
          providerInstance:
            composerForm instanceof HTMLElement
              ? safeValue(composerForm.dataset.mossVisibleProviderInstance, [
                  "codex",
                  "codex_moss",
                  "other",
                ])
              : null,
          sessionStatus:
            composerForm instanceof HTMLElement
              ? safeValue(composerForm.dataset.mossVisibleSessionStatus, [
                  "not-started",
                  "starting",
                  "ready",
                  "running",
                  "stopping",
                  "stopped",
                  "error",
                ])
              : null,
          sendPhase:
            composerForm instanceof HTMLElement
              ? safeValue(composerForm.dataset.mossVisibleSendPhase, [
                  "idle",
                  "composer",
                  "automation",
                  "provider-preflight",
                  "browser-context",
                  "first-send-target",
                  "project-create",
                  "prepare-dispatch",
                  "thread-create",
                  "thread-metadata",
                  "persist-settings",
                  "attachments",
                  "turn-start",
                ])
              : null,
          sendOutcome:
            composerForm instanceof HTMLElement
              ? safeValue(composerForm.dataset.mossVisibleSendOutcome, [
                  "idle",
                  "running",
                  "blocked",
                  "failed",
                  "succeeded",
                ])
              : null,
          transcriptMounted: Boolean(document.querySelector('[data-chat-scroll-container="true"]')),
          turnRunning: Boolean(document.querySelector('[data-moss-visible-stop-control="true"]')),
          alertPresent: alerts.length > 0,
          alertSurfaces,
          alertSources,
          alertClassifications,
        },
        selection: {
          settingsRead: settings !== null,
          managedConfigured: Boolean(settings?.providerInstances?.codex_moss),
          selectedCodexAccountIsManaged:
            settings === null ? null : settings.providers?.codex?.selectedAccountId === "moss",
          textGenerationInstanceIsManaged:
            settings === null
              ? null
              : settings.textGenerationModelSelection?.instanceId === "codex_moss",
          shellSnapshotRead: shellSnapshot !== null,
          activeServerThreadFound: serverThread !== null,
          activeServerThreadInstanceIsManaged:
            serverThread === null ? null : serverThread.modelSelection.instanceId === "codex_moss",
        },
        providerStatus: {
          configRead: config !== null,
          managedFound: Boolean(managedStatus),
          status: safeValue(managedStatus?.status, ["ready", "warning", "error"]),
          available: typeof managedStatus?.available === "boolean" ? managedStatus.available : null,
          authStatus: safeValue(managedStatus?.authStatus, [
            "authenticated",
            "unauthenticated",
            "unknown",
          ]),
          enabled: typeof managedStatus?.enabled === "boolean" ? managedStatus.enabled : null,
        },
      };
    },
    { expectedPrompt: prompt },
  );
}

async function removeTestKey(page, options) {
  try {
    await gotoRoute(page, options, "/login/api-key");
    const removeButton = page.getByRole("button", {
      name: UI_COPY.removeSavedKey,
    });
    if (!(await removeButton.isVisible({ timeout: 5_000 }).catch(() => false))) return false;
    await removeButton.click();
    await removeButton.waitFor({
      state: "detached",
      timeout: options.timeoutMs,
    });
    const state = await readSafeMossEnterpriseKeyState(page);
    if (
      !state ||
      state.configured ||
      state.selected ||
      state.providerInstanceId !== null ||
      state.model !== null
    ) {
      return false;
    }
    printStatus("PASS", "remove-test-key");
    return true;
  } catch {
    // Cleanup is best-effort and deliberately does not print browser/server errors:
    // a downstream implementation must never make the credential observable here.
    printStatus("WARN", "remove-test-key");
    return false;
  }
}

async function exitAfterCleanup(code) {
  if (exiting) return;
  exiting = true;
  if (connectedPage && optionsForCleanup) {
    const retainKey =
      optionsForCleanup.keepKey || (optionsForCleanup.keepKeyOnSuccess && code === 0);
    const keyRemoved =
      optionsForCleanup.expectRemovedKey || retainKey
        ? true
        : await removeTestKey(connectedPage, optionsForCleanup);
    if (code === 0 && optionsForCleanup.expectSavedKey && !keyRemoved) {
      activeStep = "remove-test-key";
      safeFailureOutcome = "cleanup_failed";
      await writeSafeFailureDiagnostic();
      printStatus("DIAG", `${activeStep}:${safeFailureOutcome}`);
      printStatus("FAIL", activeStep);
      code = 1;
    }
  }
  // Do not call browser.close(): this runner connected to an installed app it does not own.
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    printStatus("FAIL", "interrupted");
    void exitAfterCleanup(signal === "SIGINT" ? 130 : 143);
  });
}

async function run() {
  let options;
  try {
    options = parseMossKeyE2EOptions(process.argv.slice(2), process.env);
  } finally {
    // Retain the credential only in the parsed options object. The driver does
    // not spawn credential-requiring children, so its inherited environment can
    // be cleared before Playwright or any other runtime dependency is loaded.
    delete process.env.MOSS_KEY_E2E_KEY;
  }
  if (options.help) {
    printHelp();
    return;
  }
  optionsForCleanup = options;

  const page = await runStep("connect-installed-electron", () => connectToExistingPage(options));
  connectedPage = page;

  await runStep(
    options.expectRemovedKey
      ? "open-removed-key-login"
      : options.expectSavedKey
        ? "open-saved-key-login"
        : "open-no-account-key-login",
    async () => {
      await gotoRoute(page, options, "/login/api-key");
      // On a brand-new macOS profile, the one-time AppSnap announcement is a
      // modal dialog. Dismiss its explicit "Not now" path before asserting the
      // login page beneath it, exactly as a user declining setup would do.
      await dismissAppSnapWelcomeIfPresent(page);
      await page.getByRole("heading", { name: UI_COPY.keyHeading }).waitFor({
        state: "visible",
        timeout: KEY_FORM_WAIT_TIMEOUT_MS,
      });
      await page.getByText(UI_COPY.keyDescription).waitFor({
        state: "visible",
        timeout: KEY_FORM_WAIT_TIMEOUT_MS,
      });
      const preexistingKeyNotice = page.getByText(UI_COPY.savedKeyNotice);

      if (options.expectSavedKey) {
        const savedKeyAvailability = await waitForSavedKeyAvailability(page);
        if (savedKeyAvailability !== "ready") {
          safeFailureOutcome = SAFE_VERIFICATION_OUTCOMES.has(savedKeyAvailability)
            ? savedKeyAvailability
            : "saved_key_missing";
          throw new Error("Moss did not restore the saved Key");
        }
        const keyInput = page.locator("#moss-enterprise-api-key");
        if ((await keyInput.inputValue()) !== "") {
          safeFailureOutcome = "ui_error";
          throw new Error("saved-Key verification found unexpected credential input");
        }
      } else {
        const formAvailability = await waitForKeyFormAvailability(page);
        if (formAvailability !== "ready") {
          safeFailureOutcome = SAFE_VERIFICATION_OUTCOMES.has(formAvailability)
            ? formAvailability
            : "form_unavailable";
          throw new Error("Moss Key form did not become available");
        }
        const keyInput = page.locator("#moss-enterprise-api-key");
        if (options.expectRemovedKey && (await keyInput.inputValue()) !== "") {
          safeFailureOutcome = "removed_key_not_cleared";
          throw new Error("removed-Key verification found a populated credential input");
        }
        if (await preexistingKeyNotice.isVisible().catch(() => false)) {
          if (options.expectRemovedKey) safeFailureOutcome = "removed_key_not_cleared";
          throw new Error("isolated profile required");
        }
      }
    },
  );

  if (options.expectRemovedKey) {
    await runStep("verify-removed-key-state", async () => {
      const state = await readSafeMossEnterpriseKeyState(page);
      if (!state) {
        safeFailureOutcome = "state_unavailable";
        throw new Error("removed Moss Key state was unavailable");
      }
      if (!removedMossKeyStateIsClean(state)) {
        safeFailureOutcome = "removed_key_not_cleared";
        throw new Error("removed Moss Key state was still configured or selected");
      }
    });
    printStatus("PASS", "complete");
    return;
  }

  if (options.expectSavedKey) {
    await runStep("verify-restored-key-state", async () => {
      const state = await readSafeMossEnterpriseKeyState(page);
      if (!state) {
        safeFailureOutcome = "state_unavailable";
        throw new Error("saved Moss Key state was unavailable");
      }
      if (!state.configured) {
        safeFailureOutcome = "saved_key_missing";
        throw new Error("saved Moss Key was not configured");
      }
      if (!state.selected) {
        safeFailureOutcome = "saved_key_not_selected";
        throw new Error("saved Moss Key selection was not restored");
      }
      if (state.providerInstanceId !== null || state.model !== null) {
        safeFailureOutcome = "selection_failed";
        throw new Error("saved Moss Key provider selection was invalid");
      }
    });

    await runStep("continue-with-restored-key", async () => {
      const continueButton = page.getByRole("button", {
        name: UI_COPY.continueToMoss,
      });
      try {
        await continueButton.waitFor({
          state: "visible",
          timeout: KEY_FORM_ACTION_TIMEOUT_MS,
        });
        await continueButton.click({ timeout: KEY_FORM_ACTION_TIMEOUT_MS });
      } catch {
        safeFailureOutcome = "selection_failed";
        throw new Error("saved Moss Key could not be selected");
      }

      let outcome;
      try {
        outcome = await waitForKeyVerificationOutcome(page);
      } catch {
        safeFailureOutcome = "verification_timeout";
        throw new Error("saved Moss Key did not produce a visible outcome");
      }
      if (outcome !== "success") {
        safeFailureOutcome = SAFE_VERIFICATION_OUTCOMES.has(outcome) ? outcome : "ui_error";
        throw new Error("saved Moss Key was not accepted");
      }
    });
  } else {
    await runStep("verify-and-use-key", async () => {
      if (!(await submitKeyForm(page, options))) {
        safeFailureOutcome = "form_unavailable";
        throw new Error("Moss Key form could not be submitted");
      }
      let outcome;
      try {
        outcome = await waitForKeyVerificationOutcome(page);
      } catch {
        safeFailureOutcome = "verification_timeout";
        throw new Error("Moss Key verification did not produce a visible outcome");
      }
      if (outcome !== "success") {
        safeFailureOutcome = SAFE_VERIFICATION_OUTCOMES.has(outcome) ? outcome : "ui_error";
        throw new Error("Moss Key verification was not accepted");
      }
    });
  }

  await runStep("open-key-chat", async () => {
    if (!(await waitForChatAvailability(page))) {
      safeFailureOutcome = "chat_unavailable";
      throw new Error("Moss chat did not become available after Key verification");
    }
    // The enterprise key owns the managed Moss surface; its model follows the
    // key's entitlement, so only the instance is pinned here.
    const managedComposer = page
      .locator(
        'form[data-moss-visible-composer-shell="true"][data-moss-visible-provider="codex"][data-moss-visible-provider-instance="codex_moss"]',
      )
      .last();
    if (
      !(await managedComposer.isVisible({ timeout: KEY_FORM_WAIT_TIMEOUT_MS }).catch(() => false))
    ) {
      safeFailureOutcome = "selection_failed";
      throw new Error("enterprise key chat did not select the managed Moss instance");
    }
  });

  const marker = createAcceptanceMarker();
  const prompt = acceptancePrompt(marker);
  await runStep("submit-real-chat", async () => {
    const editor = page.locator('[data-testid="composer-editor"]').last();
    // Drive Lexical through the page keyboard. On a brand-new desktop profile,
    // Playwright's contenteditable `fill()` and locator `pressSequentially()`
    // can update the DOM without updating Lexical's draft state, leaving the
    // visible send button enabled while clicking it is still a no-op.
    await editor.click();
    // The visible editor mounts before its controlled state and provider-driven
    // route effects have necessarily settled on a brand-new profile. A short
    // human-scale focus pause prevents those effects from discarding the first
    // input batch.
    await page.waitForTimeout(500);
    await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
    await page.keyboard.press("Backspace");
    await editor.focus();
    await page.keyboard.press("End");
    // The first input boundary activates Lexical's brand-new profile listener.
    // Remove the warm-up character before entering the acceptance prompt.
    await page.keyboard.type(" ");
    await page.keyboard.press("Backspace");
    await page.waitForTimeout(50);
    await page.keyboard.type(prompt, { delay: 10 });
    const sendButton = page.locator('[data-moss-visible-send-control="true"]').last();
    await sendButton.waitFor({ state: "visible" });
    await page.waitForFunction((selector) => {
      const button = document.querySelector(selector);
      return button instanceof HTMLButtonElement && !button.disabled;
    }, '[data-moss-visible-send-control="true"]');
    // Enter is the composer's first-class Lexical submit path and is the same
    // keystroke a user can press. It reads Lexical's live snapshot before any
    // button-focus transition can race the controlled draft.
    await page.keyboard.press("Enter");

    const primarySubmissionObserved = await waitForObservedChatSubmission(page, {
      marker,
      prompt,
      timeoutMs: CHAT_PRIMARY_SUBMIT_WAIT_TIMEOUT_MS,
    });
    if (!primarySubmissionObserved) {
      printStatus("RUN", "recover-first-submit");
      // A cold packaged profile can still be finishing project/provider setup
      // when the first user keystroke arrives. Re-enter the prompt through real
      // keyboard events, then exercise the visible click path exactly once.
      await editor.focus();
      await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
      await page.keyboard.press("Backspace");
      await page.keyboard.type(prompt, { delay: 10 });
      await page.waitForFunction((expectedPrompt) => {
        const activeEditor = [...document.querySelectorAll('[data-testid="composer-editor"]')].at(
          -1,
        );
        return (activeEditor?.textContent?.trim() ?? "") === expectedPrompt;
      }, prompt);
      await page.waitForFunction((selector) => {
        const button = document.querySelector(selector);
        return (
          button instanceof HTMLButtonElement &&
          !button.disabled &&
          button.dataset.mossVisibleSendState === "ready"
        );
      }, '[data-moss-visible-send-control="true"]');
      await sendButton.click();
      const recoverySubmissionObserved = await waitForObservedChatSubmission(page, {
        marker,
        prompt,
        timeoutMs: CHAT_RECOVERY_SUBMIT_WAIT_TIMEOUT_MS,
      });
      if (!recoverySubmissionObserved) {
        safeFailureOutcome = "submission_timeout";
        safeFailureDetails = await readSafeChatFailureDetails(page, {
          prompt,
        }).catch(() => null);
        throw new Error("Moss chat submission did not produce a visible outcome");
      }
      printStatus("PASS", "recover-first-submit");
    }
  });

  await runStep("render-user-message", () =>
    waitForVirtualizedTimelineMarker(page, { marker, role: "user" }),
  );

  await runStep("receive-real-reply", async () => {
    await waitForVirtualizedTimelineMarker(page, {
      marker,
      role: "assistant",
      requireIdle: true,
    });
  });

  printStatus("PASS", "complete");
}

run()
  .then(async () => {
    await exitAfterCleanup(0);
  })
  .catch(async () => {
    // Never print caught error text: Playwright/server errors are not part of the
    // acceptance contract and could regress into including sensitive form data.
    await writeSafeFailureDiagnostic();
    printStatus("DIAG", `${activeStep}:${safeFailureOutcome}`);
    printStatus("FAIL", activeStep);
    await exitAfterCleanup(1);
  });
