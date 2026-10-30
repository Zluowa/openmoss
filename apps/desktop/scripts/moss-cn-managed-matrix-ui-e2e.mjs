#!/usr/bin/env node
/**
 * CN Moss-account UI matrix: every managed agent × every CN catalog model.
 * UI flow follows moss-phone-chat-e2e.mjs; model/agent picking uses
 * moss-ui-e2e.helpers.mjs Moss-specific adapters.
 *
 * Parallel: multiple workers may attach to loopback CDP concurrently (one
 * connectOverCDP per worker). Shard with MOSS_CN_MATRIX_SHARD_INDEX/COUNT and
 * point each worker at its own Moss CDP port when running cases in parallel.
 */
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  closeOpenMenus,
  connectToExistingAppPage,
  readVisibleComposerState,
  selectComposerAccountSource,
  selectComposerModel,
  shardCases,
  submitAcceptanceChat,
} from "./moss-ui-e2e.helpers.mjs";

delete process.env.NODE_DEBUG;
delete process.env.DEBUG;
delete process.env.PWDEBUG;

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const MATRIX_PATH = process.env.MOSS_CN_MATRIX_FILE ?? "/tmp/moss-cn-matrix.json";
const WORKER_TAG = process.env.MOSS_CN_MATRIX_WORKER_TAG?.trim() || "0";
const REPORT_PATH =
  process.env.MOSS_CN_MATRIX_REPORT ??
  `/tmp/moss-cn-matrix-report${WORKER_TAG === "0" ? "" : `-${WORKER_TAG}`}.json`;
const CDP_URL = process.env.MOSS_PHONE_E2E_CDP_URL ?? "http://127.0.0.1:9230";
const APP_URL = process.env.MOSS_PHONE_E2E_APP_URL ?? "moss://app/index.html";
const REPLY_TIMEOUT_MS = Number(process.env.MOSS_CN_MATRIX_REPLY_TIMEOUT_MS ?? "180000");
const CASE_FILTER = process.env.MOSS_CN_MATRIX_FILTER?.trim() ?? "";
const SHARD_INDEX = Number(process.env.MOSS_CN_MATRIX_SHARD_INDEX ?? "0");
const SHARD_COUNT = Number(process.env.MOSS_CN_MATRIX_SHARD_COUNT ?? "1");

const UI = {
  newChat: /(?:打开新建全局对话主页|Open the new chat landing screen)/u,
  appSnapHeading: /^(?:AppSnap is ready!|应用截图（AppSnap）已就绪！)$/u,
  appSnapDismiss: /^(?:Not now|暂不设置)$/u,
  providerFailure:
    /(?:服务商暂时无法完成此请求|Provider (?:temporarily )?unavailable|Provider runtime error|failed to complete the turn|API Error|upstream)/iu,
};

const AGENT_MENU_PATTERNS = {
  Codex: /^Codex$/u,
  Claude: /^Claude/u,
  OpenCode: /^OpenCode/u,
  Pi: /^Pi(?:\s|$)/u,
  Grok: /^Grok(?:\s|$)/u,
  Hermes: /^Hermes(?:\s|$)/u,
};

function log(event, detail = {}) {
  process.stderr.write(
    `${JSON.stringify({ ts: new Date().toISOString(), event, worker: WORKER_TAG, ...detail })}\n`,
  );
}

function loadMatrix() {
  const raw = JSON.parse(readFileSync(MATRIX_PATH, "utf8"));
  let cases = raw.cases ?? [];
  if (CASE_FILTER) {
    const re = new RegExp(CASE_FILTER, "u");
    cases = cases.filter((entry) => re.test(`${entry.id}/${entry.modelId}`));
  }
  if (SHARD_COUNT > 1) {
    cases = shardCases(cases, { shardIndex: SHARD_INDEX, shardCount: SHARD_COUNT });
  }
  return cases;
}

async function dismissAppSnapWelcomeIfPresent(page) {
  if (process.platform !== "darwin") return;
  const dialog = page.getByRole("dialog").filter({
    has: page.getByRole("heading", { name: UI.appSnapHeading }),
  });
  const dismiss = dialog.getByRole("button", { name: UI.appSnapDismiss });
  if (
    await dismiss
      .waitFor({ state: "visible", timeout: 5_000 })
      .then(() => true)
      .catch(() => false)
  ) {
    await dismiss.click();
    await dialog.waitFor({ state: "detached" });
  }
}

async function readThreadSnapshot(page) {
  return page.evaluate(() => ({
    hash: window.location.hash,
    assistantCount: document.querySelectorAll('[data-message-role="assistant"]').length,
  }));
}

async function openNewChat(page, { force = false } = {}) {
  await closeOpenMenus(page);
  const snapshot = await readThreadSnapshot(page);
  if (!force && snapshot.assistantCount === 0) {
    await page.locator('[data-testid="composer-editor"]').last().waitFor({
      state: "visible",
      timeout: 60_000,
    });
    return;
  }
  const newChatButton = page.getByRole("button", { name: UI.newChat });
  if ((await newChatButton.count()) === 0) throw new Error("new chat control unavailable");
  await newChatButton.first().click({ force: true });
  // New-chat navigation may intentionally retain the landing hash while
  // replacing the draft in-place. Wait briefly for that state update, then
  // use the composer itself as the readiness signal instead of requiring a
  // URL change that never occurs on restored empty drafts.
  await page
    .waitForFunction(
      (prior) => {
        const next = {
          hash: window.location.hash,
          assistantCount: document.querySelectorAll('[data-message-role="assistant"]').length,
        };
        return (
          (next.hash.length > 2 && next.hash !== prior.hash) ||
          next.assistantCount < prior.assistantCount
        );
      },
      snapshot,
      { timeout: 2_000 },
    )
    .catch(() => undefined);
  await page.locator('[data-testid="composer-editor"]').last().waitFor({
    state: "visible",
    timeout: 60_000,
  });
}

async function selectAgentAndMoss(page, agentMenuLabel, targetInstanceId) {
  const current = await readVisibleComposerState(page);
  if (current?.instanceId === targetInstanceId) return;

  const agentPattern = AGENT_MENU_PATTERNS[agentMenuLabel];
  if (!agentPattern) throw new Error(`unknown agent menu label: ${agentMenuLabel}`);

  const picker = page.getByTestId("composer-agent-picker");
  await picker.click();
  await page
    .locator('[role="menu"]')
    .last()
    .waitFor({ state: "visible", timeout: 10_000 })
    .catch(() => undefined);
  let agentItem = page.getByRole("menuitemradio", { name: agentPattern }).first();
  await agentItem.waitFor({ state: "visible", timeout: 15_000 }).catch(() => undefined);
  if ((await agentItem.count()) === 0) {
    // Agent entries may land one render behind the source picker after a
    // previous model change. Re-open once, then fall back to an exact DOM
    // click so the test observes the same menu the user sees.
    await closeOpenMenus(page);
    await picker.click({ force: true });
    await page.waitForTimeout(500);
    agentItem = page.getByRole("menuitemradio", { name: agentPattern }).first();
  }
  if (await agentItem.count()) {
    await agentItem.click({ force: true });
  } else {
    const clicked = await page.evaluate((label) => {
      for (const element of document.querySelectorAll('[role="menuitemradio"]')) {
        if (element.textContent?.trim() !== label) continue;
        if (element instanceof HTMLElement) {
          element.click();
          return true;
        }
      }
      return false;
    }, agentMenuLabel);
    if (!clicked) {
      const available = await page
        .locator('[role="menuitemradio"]')
        .allTextContents()
        .catch(() => []);
      throw new Error(
        `agent unavailable in picker: ${agentMenuLabel}; available: ${available.join(", ")}`,
      );
    }
  }
  await page.waitForTimeout(400);

  let afterAgent = await readVisibleComposerState(page);
  if (afterAgent?.instanceId === targetInstanceId) return;

  await selectComposerAccountSource(page, {
    provider: afterAgent?.provider,
    instanceId: targetInstanceId,
    sourceName: "Moss",
  });
  afterAgent = await readVisibleComposerState(page);
  if (afterAgent?.instanceId !== targetInstanceId) {
    throw new Error(
      `expected instance ${targetInstanceId}, got ${afterAgent?.instanceId ?? "none"} (provider=${afterAgent?.provider ?? "none"})`,
    );
  }
}

async function waitForAgentCatalog(page) {
  const picker = page.getByTestId("composer-agent-picker");
  await picker.click({ force: true });
  const menu = page.locator('[role="menu"]').last();
  await menu.waitFor({ state: "visible", timeout: 15_000 });
  await page
    .getByRole("menuitemradio", { name: /^Claude$/u })
    .waitFor({ state: "visible", timeout: 45_000 })
    .catch(() => undefined);
  await closeOpenMenus(page);
}

async function waitForComposer(page, instanceId, modelId) {
  const composer = page
    .locator(
      `form[data-moss-visible-composer-shell="true"][data-moss-visible-provider-instance="${instanceId}"][data-moss-visible-model="${modelId}"]`,
    )
    .last();
  await composer.waitFor({ state: "visible", timeout: 60_000 });
  return composer;
}

async function waitForReplyOrProviderFailure(page, marker, baselineAssistantTexts) {
  await page
    .waitForFunction(
      ({ expectedMarker, failurePatternSource, baselineTexts }) => {
        const failurePattern = new RegExp(failurePatternSource, "iu");
        const scrollContainer = document.querySelector('[data-chat-scroll-container="true"]');
        if (scrollContainer instanceof HTMLElement) {
          scrollContainer.scrollTop = scrollContainer.scrollHeight;
          scrollContainer.dispatchEvent(new Event("scroll"));
        }
        const allAssistants = [...document.querySelectorAll('[data-message-role="assistant"]')];
        const assistants = allAssistants.filter(
          (message, index) =>
            (message.textContent?.trim() ?? "") !== (baselineTexts[index] ?? "") ||
            index >= baselineTexts.length,
        );
        const lastText = assistants.at(-1)?.textContent?.trim() ?? "";
        if (failurePattern.test(lastText)) return "provider_failure";
        const markerOk = assistants.some((message) =>
          (message.textContent?.trim() ?? "").includes(expectedMarker),
        );
        // Old, virtualized composers can retain a stop control in the DOM after
        // a thread has completed. Only the currently visible composer belongs
        // to this case; a stale hidden control must not turn a completed marker
        // into a 120s timeout.
        const activeComposer = [
          ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
        ].find((element) => element.getClientRects().length > 0);
        const activeStopControl = activeComposer?.querySelector(
          '[data-moss-visible-stop-control="true"]',
        );
        const stillRunning =
          activeStopControl instanceof HTMLElement && activeStopControl.getClientRects().length > 0;
        if (markerOk && !stillRunning) return "ok";
        return null;
      },
      {
        expectedMarker: marker,
        failurePatternSource: UI.providerFailure.source,
        baselineTexts: baselineAssistantTexts,
      },
      { timeout: REPLY_TIMEOUT_MS, polling: "raf" },
    )
    .then(async (handle) => {
      let result;
      try {
        result = await handle.jsonValue();
      } finally {
        await handle.dispose().catch(() => undefined);
      }
      if (result === "provider_failure") {
        const tail = await page.evaluate(() => {
          const last = [...document.querySelectorAll('[data-message-role="assistant"]')].at(-1);
          return last?.textContent?.trim().slice(0, 120) ?? "";
        });
        throw new Error(`provider failure: ${tail}`);
      }
    });
}

function markerFor(caseEntry) {
  const digest = createHash("sha256")
    .update(`${caseEntry.id}:${caseEntry.modelId}`)
    .digest("hex")
    .slice(0, 8);
  return `MOSS_MATRIX_OK_${digest}`;
}

async function stopFailedCase(page) {
  if (page.isClosed()) return;
  const composer = page.locator('form[data-moss-visible-composer-shell="true"]:visible').last();
  const state = await composer.evaluate(
    (element) => ({
      threadId: element.getAttribute("data-moss-visible-thread-id"),
      status: element.getAttribute("data-moss-visible-session-status"),
      activeTurnId: element.getAttribute("data-moss-visible-active-turn-id"),
    }),
    undefined,
    { timeout: 5_000 },
  );
  // These are ThreadSession.status values: orchestration idle/stopped map to
  // closed, ready/interrupted map to ready, and starting maps to connecting.
  const idleStatuses = ["not-started", "ready", "closed", "error", "disconnected"];
  if (!state.threadId || state.status === null || state.activeTurnId === null) {
    throw new Error("Cannot verify the failed case's session state.");
  }
  if (idleStatuses.includes(state.status) && state.activeTurnId === "") return;
  const stop = composer.locator('[data-moss-visible-stop-control="true"]:visible').last();
  if (!(await stop.isVisible())) {
    throw new Error(
      `Session is still active without a visible stop control: ${state.status}, turn ${state.activeTurnId}.`,
    );
  }
  await stop.click({ timeout: 5_000 });
  const settled = await page.waitForFunction(
    ({ threadId, idleStatuses }) => {
      const current = [
        ...document.querySelectorAll('form[data-moss-visible-composer-shell="true"]'),
      ]
        .filter((element) => element.getClientRects().length > 0)
        .at(-1);
      return (
        current?.getAttribute("data-moss-visible-thread-id") === threadId &&
        current.getAttribute("data-moss-visible-active-turn-id") === "" &&
        idleStatuses.includes(current.getAttribute("data-moss-visible-session-status"))
      );
    },
    { threadId: state.threadId, idleStatuses },
    { timeout: 10_000, polling: 100 },
  );
  await settled.dispose().catch(() => undefined);
}

async function runCase(page, caseEntry) {
  const marker = markerFor(caseEntry);
  const label = `${caseEntry.id}/${caseEntry.modelId}`;
  log("case_start", { label, displayName: caseEntry.displayName });
  // Every matrix case gets a fresh draft. Provider/model menus are scoped to
  // the active thread; reusing an empty draft can leave a closed submenu
  // overlay behind and make the next model selection target stale DOM.
  await openNewChat(page, { force: true });
  await dismissAppSnapWelcomeIfPresent(page);
  try {
    await selectAgentAndMoss(page, caseEntry.agentMenuLabel, caseEntry.instanceId);
  } catch (cause) {
    if (!(cause instanceof Error) || !cause.message.startsWith("expected instance ")) throw cause;
    // Provider selection is thread-scoped. If a restored empty draft retained
    // the prior driver, commit the source choice on a fresh thread and retry.
    await openNewChat(page, { force: true });
    await selectAgentAndMoss(page, caseEntry.agentMenuLabel, caseEntry.instanceId);
  }
  try {
    await selectComposerModel(page, {
      displayName: caseEntry.displayName,
      provider: caseEntry.provider,
      modelId: caseEntry.modelId,
    });
  } catch (cause) {
    // A delayed picker render can strand the first submenu focus. Reopen a
    // clean draft once and repeat the exact user flow before recording failure.
    await openNewChat(page, { force: true });
    await selectAgentAndMoss(page, caseEntry.agentMenuLabel, caseEntry.instanceId);
    await selectComposerModel(page, {
      displayName: caseEntry.displayName,
      provider: caseEntry.provider,
      modelId: caseEntry.modelId,
    });
  }
  const composer = await waitForComposer(page, caseEntry.instanceId, caseEntry.modelId);
  const baselineAssistantTexts = await page
    .locator('[data-message-role="assistant"]')
    .allTextContents();
  const started = Date.now();
  await submitAcceptanceChat(page, marker, { composer });
  await waitForReplyOrProviderFailure(page, marker, baselineAssistantTexts);
  const elapsedMs = Date.now() - started;
  const threadUrl = page.url();
  const reloadStarted = Date.now();
  await page.reload();
  await waitForReplyOrProviderFailure(page, marker, []);
  const reloadElapsedMs = Date.now() - reloadStarted;
  log("case_pass", { label, elapsedMs, reloadElapsedMs, marker, threadUrl });
  return { ok: true, label, elapsedMs, reloadElapsedMs, marker, threadUrl };
}

async function main() {
  const cases = loadMatrix();
  if (cases.length === 0) throw new Error("matrix empty");
  log("matrix_loaded", {
    count: cases.length,
    filter: CASE_FILTER || null,
    shardIndex: SHARD_COUNT > 1 ? SHARD_INDEX : null,
    shardCount: SHARD_COUNT > 1 ? SHARD_COUNT : null,
    cdpUrl: CDP_URL,
    reportPath: REPORT_PATH,
  });

  const { browser, page } = await connectToExistingAppPage({
    cdpUrl: CDP_URL,
    appUrl: APP_URL,
    timeoutMs: 60_000,
  });
  let mainFailed = false;
  try {
    await dismissAppSnapWelcomeIfPresent(page);
    await waitForAgentCatalog(page);

    const results = [];
    const writeReport = (finished = false) => {
      const summary = {
        ok: results.length === cases.length && results.every((entry) => entry.ok),
        total: cases.length,
        passed: results.filter((entry) => entry.ok).length,
        failed: results.filter((entry) => !entry.ok).length,
        worker: WORKER_TAG,
        shardIndex: SHARD_COUNT > 1 ? SHARD_INDEX : undefined,
        shardCount: SHARD_COUNT > 1 ? SHARD_COUNT : undefined,
        cdpUrl: CDP_URL,
        results,
        ...(finished
          ? { finishedAt: new Date().toISOString() }
          : { inProgressAt: new Date().toISOString() }),
      };
      mkdirSync(dirname(REPORT_PATH), { recursive: true });
      writeFileSync(REPORT_PATH, `${JSON.stringify(summary, null, 2)}\n`, "utf8");
      return summary;
    };

    for (const caseEntry of cases) {
      const label = `${caseEntry.id}/${caseEntry.modelId}`;
      try {
        results.push(await runCase(page, caseEntry));
      } catch (cause) {
        const message = cause instanceof Error ? cause.message : String(cause);
        log("case_fail", { label, message });
        const failure = { ok: false, label, message };
        results.push(failure);
        try {
          await stopFailedCase(page);
        } catch (cleanupCause) {
          failure.cleanupMessage =
            cleanupCause instanceof Error ? cleanupCause.message : String(cleanupCause);
          log("case_stop_failed", { label, message: failure.cleanupMessage });
          try {
            writeReport(true);
          } catch (reportCause) {
            log("case_report_failed", {
              label,
              message: reportCause instanceof Error ? reportCause.message : String(reportCause),
            });
          }
          // Keep the original case failure and do not open another case while
          // this session may still be executing tools in the background.
          throw cause;
        }
        if (!page.isClosed()) await closeOpenMenus(page).catch(() => undefined);
      }
      writeReport(false);
    }

    const summary = writeReport(true);
    console.log(JSON.stringify(summary));
    if (!summary.ok) process.exitCode = 1;
  } catch (cause) {
    mainFailed = true;
    throw cause;
  } finally {
    try {
      await browser.close();
    } catch (cause) {
      if (!mainFailed) throw cause;
      log("cdp_disconnect_failed", {
        message: cause instanceof Error ? cause.message : String(cause),
      });
    }
  }
}

main().catch((cause) => {
  log("fatal", { message: cause instanceof Error ? cause.message : String(cause) });
  process.exit(1);
});
