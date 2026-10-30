#!/usr/bin/env node

import { randomUUID } from "node:crypto";
import { createRequire } from "node:module";
import { readFile, unlink, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  acceptancePrompt,
  appPageMatches,
  buildAliyunQuerySendDetailsUrl,
  buildAppHashRoute,
  chatSubmissionWasObserved,
  createAcceptanceMarker,
  createProfileMarker,
  createRestartReceipt,
  extractFreshSmsCode,
  parseMossPhoneE2EOptions,
  restartReceiptMatches,
  shanghaiDateStrings,
} from "./moss-phone-chat-e2e.helpers.mjs";

delete process.env.NODE_DEBUG;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, "..", "..", "..");
const WEB_ROOT = resolve(REPO_ROOT, "apps", "web");

const APP_SNAP_WAIT_TIMEOUT_MS = 5_000;
const CHAT_PRIMARY_SUBMIT_WAIT_TIMEOUT_MS = 15_000;
const CHAT_RECOVERY_SUBMIT_WAIT_TIMEOUT_MS = 30_000;
const SMS_POLL_INTERVAL_MS = 2_000;
const RESTART_PROFILE_STORAGE_KEY = "moss-phone-e2e-profile-proof-v1";

const SAFE_OUTCOMES = new Set([
  "account_not_authenticated",
  "app_unavailable",
  "chat_unavailable",
  "logout_failed",
  "moss_selection_failed",
  "otp_rejected",
  "phone_form_unavailable",
  "reply_timeout",
  "restart_proof_cleanup_failed",
  "restart_proof_failed",
  "sms_lookup_failed",
  "sms_send_failed",
  "submission_timeout",
  "unexpected_failure",
]);

const UI_COPY = {
  accountLabel: /^Moss 账号$/u,
  appSnapDismiss: /^(?:Not now|暂不设置)$/u,
  appSnapHeading: /^(?:AppSnap is ready!|应用截图（AppSnap）已就绪！)$/u,
  logout: /^退出登录$/u,
  phoneHeading: /^登录 Moss$/u,
  phoneVerified: /手机号已验证/u,
};

let activeStep = "configuration";
let safeFailureOutcome = "unexpected_failure";
let connectedPage = null;
let exiting = false;

function printStatus(kind, step) {
  process.stderr.write(`[moss-phone-e2e] ${kind} ${step}\n`);
}

async function writeSafeFailureDiagnostic() {
  const diagnosticPath = process.env.MOSS_PHONE_E2E_DIAGNOSTIC_PATH?.trim();
  if (!diagnosticPath) return;
  const outcome = SAFE_OUTCOMES.has(safeFailureOutcome) ? safeFailureOutcome : "unexpected_failure";
  try {
    await writeFile(
      diagnosticPath,
      `${JSON.stringify(
        {
          schemaVersion: 1,
          step: activeStep,
          outcome,
          platform: process.platform,
        },
        null,
        2,
      )}\n`,
      { encoding: "utf8", mode: 0o600 },
    );
  } catch {
    // Diagnostics are best-effort and never include browser, provider, or SMS bodies.
  }
}

function printHelp() {
  process.stdout.write(`Moss phone-account real-chat E2E\n\n`);
  process.stdout.write(
    `Connects to an already-running installed Electron app over loopback CDP.\n`,
  );
  process.stdout.write(`Fresh login requires these environment variables and never CLI values:\n`);
  process.stdout.write(`  MOSS_PHONE_E2E_PHONE\n`);
  process.stdout.write(`  ALIYUN_SMS_AUDIT_ACCESS_KEY_ID\n`);
  process.stdout.write(`  ALIYUN_SMS_AUDIT_ACCESS_KEY_SECRET\n`);
  process.stdout.write(`  ALIYUN_SMS_TEMPLATE_CODE_LOGIN\n`);
  process.stdout.write(
    `  Use a dedicated read-only QuerySendDetails audit identity, never the SMS relay sender.\n\n`,
  );
  process.stdout.write(`Every run also requires:\n`);
  process.stdout.write(`  MOSS_PHONE_E2E_RESTART_RECEIPT_PATH (absolute path)\n\n`);
  process.stdout.write(`Options (equivalent environment variable):\n`);
  process.stdout.write(`  --cdp-url URL             MOSS_PHONE_E2E_CDP_URL\n`);
  process.stdout.write(`  --app-url URL             MOSS_PHONE_E2E_APP_URL\n`);
  process.stdout.write(`  --timeout-ms NUMBER       MOSS_PHONE_E2E_TIMEOUT_MS\n`);
  process.stdout.write(`  --sms-timeout-ms NUMBER   MOSS_PHONE_E2E_SMS_TIMEOUT_MS\n`);
  process.stdout.write(`  --expect-saved-session    MOSS_PHONE_E2E_EXPECT_SAVED_SESSION=1\n`);
  process.stdout.write(`  --arm-restart-receipt     MOSS_PHONE_E2E_ARM_RESTART_RECEIPT=1\n`);
  process.stdout.write(`  --logout-on-success       MOSS_PHONE_E2E_LOGOUT_ON_SUCCESS=1\n`);
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
  const isElectron = await page.evaluate(() => /\bElectron\/\d/iu.test(navigator.userAgent));
  if (!isElectron) throw new Error("CDP target is not Electron");
  page.setDefaultTimeout(options.timeoutMs);
  page.setDefaultNavigationTimeout(options.timeoutMs);
  return { browser, page };
}

async function readElectronBrowserPid(browser) {
  const session = await browser.newBrowserCDPSession();
  try {
    const result = await session.send("SystemInfo.getProcessInfo");
    const browserProcess = result.processInfo?.find((entry) => entry.type === "browser");
    if (!Number.isSafeInteger(browserProcess?.id) || browserProcess.id <= 0) {
      throw new Error("Electron browser process unavailable");
    }
    return browserProcess.id;
  } finally {
    await session.detach().catch(() => undefined);
  }
}

async function armRestartBoundary(page, browser, options) {
  const profileMarker = createProfileMarker();
  await page.evaluate(({ key, value }) => window.localStorage.setItem(key, value), {
    key: RESTART_PROFILE_STORAGE_KEY,
    value: profileMarker,
  });
  try {
    const browserPid = await readElectronBrowserPid(browser);
    const receipt = createRestartReceipt({ browserPid, profileMarker });
    await writeFile(options.restartReceiptPath, `${JSON.stringify(receipt)}\n`, {
      encoding: "utf8",
      flag: "wx",
      mode: 0o600,
    });
  } catch (error) {
    await page
      .evaluate((key) => window.localStorage.removeItem(key), RESTART_PROFILE_STORAGE_KEY)
      .catch(() => undefined);
    throw error;
  }
}

async function verifyRestartBoundary(page, browser, options) {
  const rawReceipt = await readFile(options.restartReceiptPath, "utf8");
  if (rawReceipt.length > 4_096) throw new Error("restart receipt is invalid");
  const receipt = JSON.parse(rawReceipt);
  const profileMarker = await page.evaluate(
    (key) => window.localStorage.getItem(key),
    RESTART_PROFILE_STORAGE_KEY,
  );
  const browserPid = await readElectronBrowserPid(browser);
  if (!restartReceiptMatches(receipt, { browserPid, profileMarker })) {
    throw new Error("restart boundary was not proven");
  }
}

async function consumeRestartBoundary(page, options) {
  await page.evaluate((key) => window.localStorage.removeItem(key), RESTART_PROFILE_STORAGE_KEY);
  await unlink(options.restartReceiptPath);
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
  const dismiss = dialog.getByRole("button", { name: UI_COPY.appSnapDismiss });
  const appeared = await dismiss
    .waitFor({ state: "visible", timeout: APP_SNAP_WAIT_TIMEOUT_MS })
    .then(() => true)
    .catch(() => false);
  if (!appeared) return;
  await dismiss.click();
  await dialog.waitFor({ state: "detached" });
  printStatus("PASS", "dismiss-appsnap-welcome");
}

async function queryAliyunSendDetails(options, date) {
  const url = buildAliyunQuerySendDetailsUrl({
    accessKeyId: options.aliyunAccessKeyId,
    accessKeySecret: options.aliyunAccessKeySecret,
    date,
    nonce: randomUUID(),
    phone: options.phone,
    region: options.aliyunRegion,
    timestamp: new Date().toISOString().replace(/\.\d{3}Z$/u, "Z"),
  });
  const response = await fetch(url, {
    headers: { accept: "application/json" },
    redirect: "error",
    signal: AbortSignal.timeout(10_000),
  });
  if (!response.ok) return null;
  const payload = await response.json();
  if (!payload || typeof payload !== "object" || payload.Code !== "OK") return null;
  return payload;
}

async function waitForFreshSmsCode(options, notBeforeMs) {
  const deadline = Date.now() + options.smsTimeoutMs;
  while (Date.now() < deadline) {
    for (const date of [...new Set(shanghaiDateStrings())]) {
      const payload = await queryAliyunSendDetails(options, date).catch(() => null);
      const code = extractFreshSmsCode(payload, {
        notBeforeMs,
        templateCode: options.aliyunTemplateCode,
      });
      if (code) return code;
    }
    await new Promise((resolveWait) => setTimeout(resolveWait, SMS_POLL_INTERVAL_MS));
  }
  return null;
}

async function verifyVisibleAccountSession(page, options) {
  await gotoRoute(page, options, "/account");
  await page.getByText(UI_COPY.accountLabel, { exact: true }).waitFor({
    state: "visible",
  });
  await page.getByText(UI_COPY.phoneVerified).waitFor({ state: "visible" });
}

async function waitForMossComposer(page) {
  const composer = page
    .locator(
      'form[data-moss-visible-composer-shell="true"][data-moss-visible-provider="codex"][data-moss-visible-provider-instance="codex_moss"][data-moss-visible-model="gpt-5.6-terra"]',
    )
    .last();
  await composer.waitFor({ state: "visible" });
  const conflictingComposer = page
    .locator(
      'form[data-moss-visible-composer-shell="true"][data-moss-visible-provider-instance="codex_byok"]',
    )
    .last();
  if (await conflictingComposer.isVisible().catch(() => false)) {
    throw new Error("BYOK composer visible during Moss account acceptance");
  }
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
      const markerVisible = [...document.querySelectorAll(selector)].some((message) => {
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
      const editor = [...document.querySelectorAll('[data-testid="composer-editor"]')].at(-1);
      const sendControl = [
        ...document.querySelectorAll('[data-moss-visible-send-control="true"]'),
      ].at(-1);
      return {
        editorPresent: editor instanceof HTMLElement,
        editorMatchesPrompt:
          editor instanceof HTMLElement
            ? (editor.textContent?.trim() ?? "") === expectedPrompt
            : false,
        markerVisible: [...document.querySelectorAll('[data-message-role="user"]')].some(
          (message) => (message.textContent?.trim() ?? "").includes(expectedMarker),
        ),
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

async function submitRealChat(page, marker) {
  const prompt = acceptancePrompt(marker);
  const editor = page.locator('[data-testid="composer-editor"]').last();
  await editor.click();
  await page.waitForTimeout(500);
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await editor.focus();
  await page.keyboard.press("End");
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
  await page.keyboard.press("Enter");

  const primaryObserved = await waitForObservedChatSubmission(page, {
    marker,
    prompt,
    timeoutMs: CHAT_PRIMARY_SUBMIT_WAIT_TIMEOUT_MS,
  });
  if (primaryObserved) return;

  printStatus("RUN", "recover-first-submit");
  await editor.focus();
  await page.keyboard.press(process.platform === "darwin" ? "Meta+A" : "Control+A");
  await page.keyboard.press("Backspace");
  await page.keyboard.type(prompt, { delay: 10 });
  await page.waitForFunction((expectedPrompt) => {
    const activeEditor = [...document.querySelectorAll('[data-testid="composer-editor"]')].at(-1);
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
  const recoveryObserved = await waitForObservedChatSubmission(page, {
    marker,
    prompt,
    timeoutMs: CHAT_RECOVERY_SUBMIT_WAIT_TIMEOUT_MS,
  });
  if (!recoveryObserved) throw new Error("chat submission produced no visible transition");
  printStatus("PASS", "recover-first-submit");
}

async function logoutPhoneSession(page, options) {
  await verifyVisibleAccountSession(page, options);
  const logout = page.getByRole("button", { name: UI_COPY.logout });
  await logout.waitFor({ state: "visible" });
  await logout.click();
  await page.waitForFunction(() => {
    const isVisible = (element) =>
      element instanceof HTMLElement && element.getClientRects().length > 0;
    const phoneAccount = document.querySelector("#moss-phone-account-heading");
    const phoneLogin = document.querySelector("#moss-phone-number");
    const cloudAccount = document.querySelector("#moss-account-heading");
    return !isVisible(phoneAccount) && (isVisible(phoneLogin) || isVisible(cloudAccount));
  });
}

async function exitAfterCleanup(code) {
  if (exiting) return;
  exiting = true;
  // Do not close the user-owned Electron process or print Playwright errors.
  connectedPage = null;
  process.exit(code);
}

for (const signal of ["SIGINT", "SIGTERM"]) {
  process.once(signal, () => {
    printStatus("FAIL", "interrupted");
    void exitAfterCleanup(signal === "SIGINT" ? 130 : 143);
  });
}

async function run() {
  const options = parseMossPhoneE2EOptions(process.argv.slice(2), process.env);
  if (options.help) {
    printHelp();
    return;
  }
  for (const name of [
    "MOSS_PHONE_E2E_PHONE",
    "ALIYUN_SMS_AUDIT_ACCESS_KEY_ID",
    "ALIYUN_SMS_AUDIT_ACCESS_KEY_SECRET",
    "ALIYUN_ACCESS_KEY_ID",
    "ALIYUN_ACCESS_KEY_SECRET",
  ]) {
    delete process.env[name];
  }

  const { browser, page } = await runStep("connect-installed-electron", () =>
    connectToExistingPage(options),
  );
  connectedPage = page;

  if (options.expectSavedSession) {
    await runStep("verify-restart-boundary", async () => {
      try {
        await verifyRestartBoundary(page, browser, options);
      } catch {
        safeFailureOutcome = "restart_proof_failed";
        throw new Error("saved session restart boundary unavailable");
      }
    });
  }

  if (options.expectSavedSession || options.armRestartReceipt) {
    await runStep("restore-phone-account-session", async () => {
      await verifyVisibleAccountSession(page, options);
    });
  } else {
    await runStep("open-phone-login", async () => {
      await gotoRoute(page, options, "/login");
      await dismissAppSnapWelcomeIfPresent(page);
      await page.getByRole("heading", { name: UI_COPY.phoneHeading }).waitFor({
        state: "visible",
      });
      await page.locator("#moss-phone-number").waitFor({ state: "visible" });
    });

    let smsRequestedAt = 0;
    await runStep("send-phone-otp", async () => {
      const phone = page.locator("#moss-phone-number");
      await phone.fill(options.phone);
      smsRequestedAt = Date.now();
      await phone.focus();
      await page.keyboard.press("Enter");
      await page.locator("#moss-phone-code").waitFor({ state: "visible" });
    });

    const code = await runStep("retrieve-phone-otp", async () => {
      const value = await waitForFreshSmsCode(options, smsRequestedAt);
      if (!value) {
        safeFailureOutcome = "sms_lookup_failed";
        throw new Error("fresh OTP unavailable");
      }
      return value;
    });

    await runStep("verify-phone-otp", async () => {
      const input = page.locator("#moss-phone-code");
      await input.fill(code);
      await input.focus();
      await page.keyboard.press("Enter");
      try {
        await page
          .locator(
            'form[data-moss-visible-composer-shell="true"][data-moss-visible-provider-instance="codex_moss"][data-moss-visible-model="gpt-5.6-terra"]',
          )
          .last()
          .waitFor({ state: "visible" });
      } catch {
        safeFailureOutcome = "otp_rejected";
        throw new Error("phone login did not reach Moss chat");
      }
    });

    await runStep("verify-phone-account-session", async () => {
      try {
        await verifyVisibleAccountSession(page, options);
      } catch {
        safeFailureOutcome = "account_not_authenticated";
        throw new Error("phone account session unavailable");
      }
    });
  }

  await runStep("open-moss-account-chat", async () => {
    await gotoRoute(page, options, "/");
    try {
      await waitForMossComposer(page);
    } catch {
      safeFailureOutcome = "moss_selection_failed";
      throw new Error("codex_moss composer unavailable");
    }
  });

  const marker = createAcceptanceMarker();
  await runStep("submit-real-chat", async () => {
    try {
      await submitRealChat(page, marker);
    } catch {
      safeFailureOutcome = "submission_timeout";
      throw new Error("Moss account chat submission failed");
    }
  });
  await runStep("render-user-message", () =>
    waitForVirtualizedTimelineMarker(page, { marker, role: "user" }),
  );
  await runStep("receive-real-reply", async () => {
    try {
      await waitForVirtualizedTimelineMarker(page, {
        marker,
        role: "assistant",
        requireIdle: true,
      });
    } catch {
      safeFailureOutcome = "reply_timeout";
      throw new Error("exact Moss account reply unavailable");
    }
  });

  if (options.logoutOnSuccess) {
    await runStep("logout-phone-account", async () => {
      try {
        await logoutPhoneSession(page, options);
      } catch {
        safeFailureOutcome = "logout_failed";
        throw new Error("phone session cleanup failed");
      }
    });
  }

  if (options.expectSavedSession) {
    await runStep("consume-restart-boundary", async () => {
      try {
        await consumeRestartBoundary(page, options);
      } catch {
        safeFailureOutcome = "restart_proof_cleanup_failed";
        throw new Error("restart proof cleanup failed");
      }
    });
  } else {
    await runStep("arm-restart-boundary", async () => {
      try {
        await armRestartBoundary(page, browser, options);
      } catch {
        safeFailureOutcome = "restart_proof_failed";
        throw new Error("restart proof could not be armed");
      }
    });
  }

  printStatus("PASS", "complete");
}

run()
  .then(() => exitAfterCleanup(0))
  .catch(async () => {
    await writeSafeFailureDiagnostic();
    printStatus("DIAG", `${activeStep}:${safeFailureOutcome}`);
    printStatus("FAIL", activeStep);
    await exitAfterCleanup(1);
  });
