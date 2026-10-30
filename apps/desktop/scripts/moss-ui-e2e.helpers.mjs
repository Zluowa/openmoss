/**
 * Shared Moss desktop UI E2E helpers.
 * Base interaction patterns follow moss-phone-chat-e2e.mjs; CN matrix adds
 * composer model/agent adapters on top.
 */
import { createRequire } from "node:module";
import { dirname, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

import { appPageMatches } from "./moss-phone-chat-e2e.helpers.mjs";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const WEB_ROOT = resolve(SCRIPT_DIR, "..", "..", "web");

const CHAT_PRIMARY_SUBMIT_WAIT_TIMEOUT_MS = 15_000;
const CHAT_RECOVERY_SUBMIT_WAIT_TIMEOUT_MS = 30_000;

export { appPageMatches };

export function matrixAcceptancePrompt(marker) {
  if (!/^MOSS_MATRIX_OK_[a-f0-9]{8}$/u.test(marker)) {
    throw new Error("invalid matrix marker");
  }
  return `Reply with exactly ${marker} and nothing else. Do not use tools.`;
}

export async function importPlaywrightChromium() {
  const requireFromWeb = createRequire(resolve(WEB_ROOT, "package.json"));
  const moduleUrl = pathToFileURL(requireFromWeb.resolve("playwright", { paths: [WEB_ROOT] })).href;
  const playwright = await import(moduleUrl);
  const chromium = playwright.chromium ?? playwright.default?.chromium;
  if (!chromium) throw new Error("Playwright Chromium unavailable");
  return chromium;
}

/**
 * Attach to an already-running Moss Electron app. Multiple workers may call
 * connectOverCDP against the same loopback port concurrently; each gets its own
 * Playwright session. Call browser.close() when finished to disconnect this CDP
 * session; it leaves the existing Electron app running.
 */
export async function connectToExistingAppPage({ cdpUrl, appUrl, timeoutMs }) {
  const chromium = await importPlaywrightChromium();
  const browser = await chromium.connectOverCDP(cdpUrl, { timeout: timeoutMs });
  try {
    const deadline = Date.now() + timeoutMs;
    let page = null;
    while (Date.now() < deadline) {
      const pages = browser.contexts().flatMap((context) => context.pages());
      page = pages.find((candidate) => appPageMatches(candidate.url(), appUrl)) ?? null;
      if (page) break;
      await new Promise((resolveWait) => setTimeout(resolveWait, 500));
    }
    if (!page) throw new Error("matching Electron page unavailable");
    const isElectron = await page.evaluate(() => /\bElectron\/\d/iu.test(navigator.userAgent));
    if (!isElectron) throw new Error("CDP target is not Electron");
    page.setDefaultTimeout(timeoutMs);
    page.setDefaultNavigationTimeout(timeoutMs);
    return { browser, page };
  } catch (cause) {
    await browser.close().catch(() => undefined);
    throw cause;
  }
}

export function readChatSubmissionSnapshot(page, { marker, prompt }) {
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

function chatSubmissionWasObserved(snapshot) {
  return (
    snapshot.markerVisible === true ||
    snapshot.turnRunning === true ||
    snapshot.editorPresent === false ||
    snapshot.editorMatchesPrompt === false ||
    new Set(["preparing-worktree", "sending"]).has(snapshot.sendState)
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

/**
 * Same submit/recover flow as moss-phone-chat-e2e.mjs: Enter first, then
 * explicit send-button recovery if the timeline did not observe submission.
 */
export async function submitAcceptanceChat(page, marker, { composer } = {}) {
  const prompt = matrixAcceptancePrompt(marker);
  const editor = composer
    ? composer.locator('[data-testid="composer-editor"]').last()
    : page.locator('[data-testid="composer-editor"]').last();
  const sendButton = composer
    ? composer.locator('[data-moss-visible-send-control="true"]').last()
    : page.locator('[data-moss-visible-send-control="true"]').last();

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
  if (!primaryObserved) {
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
  }
}

/** Phone/chat parity: virtualized timeline + assistant message id selector. */
export async function waitForAssistantMarker(page, marker, { requireIdle = true } = {}) {
  await page.waitForFunction(
    ({ expectedMarker, expectedIdle }) => {
      const scrollContainer = document.querySelector('[data-chat-scroll-container="true"]');
      if (scrollContainer instanceof HTMLElement) {
        scrollContainer.scrollTop = scrollContainer.scrollHeight;
        scrollContainer.dispatchEvent(new Event("scroll"));
      }
      const markerVisible = [
        ...document.querySelectorAll('[data-message-role="assistant"] [data-assistant-message-id]'),
        ...document.querySelectorAll('[data-message-role="assistant"]'),
      ].some((message) => (message.textContent?.trim() ?? "").includes(expectedMarker));
      const stillRunning = Boolean(
        document.querySelector('[data-moss-visible-stop-control="true"]'),
      );
      return markerVisible && (!expectedIdle || !stillRunning);
    },
    { expectedMarker: marker, expectedIdle: requireIdle },
    { polling: "raf" },
  );
}

export async function readVisibleComposerState(page) {
  return page.evaluate(() => {
    const composer = [
      ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
    ].find((element) => element.getClientRects().length > 0);
    if (!(composer instanceof HTMLFormElement)) return null;
    return {
      instanceId: composer.getAttribute("data-moss-visible-provider-instance"),
      modelId: composer.getAttribute("data-moss-visible-model"),
      provider: composer.getAttribute("data-moss-visible-provider"),
    };
  });
}

export async function closeOpenMenus(page) {
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(150);
  await page.keyboard.press("Escape").catch(() => undefined);
  await page.waitForTimeout(150);
}

/** Opens the model menu shared by model choices and the account-source panel. */
export async function openComposerModelMenu(page, { provider }) {
  const combinedTrigger = page.locator('[data-moss-visible-model-reasoning-control="combined"]');
  const trigger = (await combinedTrigger.count())
    ? combinedTrigger.last()
    : page.locator('[data-moss-visible-model-reasoning-control="model"]').last();
  await trigger.click();
  await page.waitForTimeout(400);

  if (provider === "codex") {
    const advancedHidden = await page.evaluate(
      () =>
        document
          .querySelector('[data-codex-power-panel="advanced"]')
          ?.getAttribute("aria-hidden") === "true",
    );
    if (advancedHidden) {
      const advanced = page.getByRole("menuitem", { name: /^(?:高级|Advanced)$/u }).first();
      if (!(await advanced.count())) {
        // The compact power menu can render one frame after the trigger while
        // the previous model submenu is being dismissed. Re-open once and
        // use the DOM fallback so a stale overlay cannot strand the picker.
        await closeOpenMenus(page);
        await trigger.click({ force: true });
        await page.waitForTimeout(500);
      }
      const retryAdvanced = page.getByRole("menuitem", { name: /^(?:高级|Advanced)$/u }).first();
      if (await retryAdvanced.count()) {
        await retryAdvanced.click({ force: true });
      } else {
        const clicked = await page.evaluate(() => {
          for (const element of document.querySelectorAll('[role="menuitem"]')) {
            if (!/^(?:高级|Advanced)$/u.test(element.textContent?.trim() ?? "")) continue;
            if (element instanceof HTMLElement) {
              element.click();
              return true;
            }
          }
          return false;
        });
        if (!clicked) throw new Error("advanced model picker menu unavailable");
      }
      await page.waitForTimeout(400);
    }
  }

  const modelSubmenu = page
    .locator('[data-slot="menu-sub-trigger"]')
    .filter({ hasText: /^(?:模型|Model)(?:\s|$)/u })
    .first();
  // All CLIs use the same catalog and selection semantics. Some packaged
  // surfaces render the catalog as a submenu while others keep that same list
  // in the open menu; accept either DOM shape without changing the product
  // contract or splitting models by CLI.
  if ((await modelSubmenu.count()) > 0) {
    await modelSubmenu.focus();
    await page.keyboard.press("ArrowRight");
    await page.waitForTimeout(400);
  }
}

/**
 * Account sources live in the model menu. The Agent picker intentionally
 * contains only executors, so looking there for Moss produces a false failure.
 */
export async function selectComposerAccountSource(page, { provider, instanceId, sourceName }) {
  const current = await readVisibleComposerState(page);
  if (current?.instanceId === instanceId) return;

  await closeOpenMenus(page);
  await openComposerModelMenu(page, { provider });
  const changeSource = page.getByRole("button", { name: /^(?:切换来源|Change source):/u });
  await changeSource.waitFor({ state: "visible", timeout: 15_000 });
  await changeSource.click();
  const sources = page.locator('[data-moss-model-source-panel="sources"]');
  await sources.waitFor({ state: "visible", timeout: 15_000 });
  const source = sources.getByRole("menuitemradio", { name: sourceName, exact: true });
  if ((await source.count()) === 0) {
    const available = await sources
      .locator('[role="menuitemradio"], [role="menuitem"]')
      .allTextContents();
    throw new Error(
      `account source unavailable: ${sourceName}; available: ${available.join(", ")}`,
    );
  }
  if (!(await source.isEnabled())) {
    throw new Error(`account source disabled: ${sourceName}`);
  }
  await source.click();
  await page.waitForFunction(
    (expectedInstanceId) => {
      const composer = [
        ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
      ].find((element) => element.getClientRects().length > 0);
      return composer?.getAttribute("data-moss-visible-provider-instance") === expectedInstanceId;
    },
    instanceId,
    { timeout: 15_000 },
  );
  await closeOpenMenus(page);
}

/** Selects the visible model through the shared model menu. */
export async function selectComposerModel(page, { displayName, provider, modelId }) {
  const current = await readVisibleComposerState(page);
  if (current?.modelId === modelId) return;

  await openComposerModelMenu(page, { provider });
  const escaped = displayName.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&");
  const radio = page.getByRole("menuitemradio", { name: new RegExp(`^${escaped}$`, "u") }).first();
  if ((await radio.count()) > 0) {
    await radio.click({ force: true }).catch(async () => {
      await clickModelRadioViaDom(page, displayName);
    });
  } else {
    const clicked = await clickModelRadioViaDom(page, displayName);
    if (!clicked) {
      const available = await page
        .locator('[role="menuitemradio"]')
        .allTextContents()
        .catch(() => []);
      const labels = available
        .map((label) => label.trim())
        .filter(Boolean)
        .slice(0, 40)
        .join(", ");
      throw new Error(
        `model not listed in picker: ${displayName}${labels ? `; available: ${labels}` : ""}`,
      );
    }
  }

  await page.waitForFunction(
    (expectedModelId) => {
      const composer = [
        ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
      ].find((element) => element.getClientRects().length > 0);
      return composer?.getAttribute("data-moss-visible-model") === expectedModelId;
    },
    modelId,
    { timeout: 15_000 },
  );
  await closeOpenMenus(page);
}

async function clickModelRadioViaDom(page, displayName) {
  return page.evaluate((label) => {
    for (const element of document.querySelectorAll('[role="menuitemradio"]')) {
      if ((element.textContent?.trim() ?? "") !== label) continue;
      if (element instanceof HTMLElement) {
        element.scrollIntoView({ block: "nearest" });
        element.click();
        return true;
      }
    }
    return false;
  }, displayName);
}

export function shardCases(cases, { shardIndex, shardCount }) {
  if (!Number.isInteger(shardCount) || shardCount <= 0) return cases;
  if (!Number.isInteger(shardIndex) || shardIndex < 0 || shardIndex >= shardCount) {
    throw new Error("invalid shard index/count");
  }
  return cases.filter((_, index) => index % shardCount === shardIndex);
}
