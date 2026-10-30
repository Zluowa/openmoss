import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  acceptancePrompt,
  appPageMatches,
  buildAppHashRoute,
  chatSubmissionWasObserved,
  createAcceptanceMarker,
  parseMossKeyE2EOptions,
  removedMossKeyStateIsClean,
} from "./moss-key-chat-e2e.helpers.mjs";

const fixtureKey = "fixture-not-a-real-key-value";

describe("Moss Key real-chat E2E contract", () => {
  it("requires the Moss Key through the environment and never a CLI option", () => {
    expect(() => parseMossKeyE2EOptions([], {})).toThrow(/MOSS_KEY_E2E_KEY is required/);
    expect(() =>
      parseMossKeyE2EOptions(["--key", fixtureKey], {
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/unknown option/);
    expect(() => parseMossKeyE2EOptions([], { MOSS_KEY_E2E_KEY: `${fixtureKey}\nleak` })).toThrow(
      /MOSS_KEY_E2E_KEY is invalid/,
    );
  });

  it("defaults to packaged Moss on a loopback CDP endpoint and cleanup enabled", () => {
    expect(parseMossKeyE2EOptions([], { MOSS_KEY_E2E_KEY: fixtureKey })).toEqual({
      help: false,
      appUrl: "moss://app/index.html",
      cdpUrl: "http://127.0.0.1:9230",
      expectSavedKey: false,
      expectRemovedKey: false,
      keepKey: false,
      keepKeyOnSuccess: false,
      key: fixtureKey,
      timeoutMs: 180_000,
    });
  });

  it("verifies a saved Key without receiving the credential again", () => {
    const savedKeyOptions = parseMossKeyE2EOptions(["--expect-saved-key"], {});
    expect(savedKeyOptions).toEqual({
      help: false,
      appUrl: "moss://app/index.html",
      cdpUrl: "http://127.0.0.1:9230",
      expectSavedKey: true,
      expectRemovedKey: false,
      keepKey: false,
      keepKeyOnSuccess: false,
      timeoutMs: 180_000,
    });
    expect(savedKeyOptions).not.toHaveProperty("key");
    expect(() =>
      parseMossKeyE2EOptions(["--expect-saved-key"], {
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/must be absent/);
    expect(() => parseMossKeyE2EOptions(["--expect-saved-key", "--keep-key"], {})).toThrow(
      /reject Key retention flags/,
    );
    expect(() =>
      parseMossKeyE2EOptions(["--expect-saved-key", "--keep-key-on-success"], {}),
    ).toThrow(/reject Key retention flags/);
    expect(
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_EXPECT_SAVED_KEY: "true",
      }).expectSavedKey,
    ).toBe(true);
  });

  it("verifies a removed Key without receiving or mutating the credential", () => {
    const removedKeyOptions = parseMossKeyE2EOptions(["--expect-removed-key"], {});
    expect(removedKeyOptions).toEqual({
      help: false,
      appUrl: "moss://app/index.html",
      cdpUrl: "http://127.0.0.1:9230",
      expectSavedKey: false,
      expectRemovedKey: true,
      keepKey: false,
      keepKeyOnSuccess: false,
      timeoutMs: 180_000,
    });
    expect(removedKeyOptions).not.toHaveProperty("key");
    expect(() =>
      parseMossKeyE2EOptions(["--expect-removed-key"], {
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/must be absent/);
    expect(() =>
      parseMossKeyE2EOptions(["--expect-removed-key"], {
        MOSS_KEY_E2E_KEY: "",
      }),
    ).toThrow(/must be absent/);
    expect(() =>
      parseMossKeyE2EOptions(["--expect-saved-key", "--expect-removed-key"], {}),
    ).toThrow(/mutually exclusive/);
    expect(() => parseMossKeyE2EOptions(["--expect-removed-key", "--keep-key"], {})).toThrow(
      /reject Key retention flags/,
    );
    expect(() =>
      parseMossKeyE2EOptions(["--expect-removed-key", "--keep-key-on-success"], {}),
    ).toThrow(/reject Key retention flags/);
    expect(() =>
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_EXPECT_REMOVED_KEY: "true",
        MOSS_KEY_E2E_KEEP_KEY: "true",
      }),
    ).toThrow(/reject Key retention flags/);
    expect(
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_EXPECT_REMOVED_KEY: "true",
      }).expectRemovedKey,
    ).toBe(true);
  });

  it("accepts only an explicitly unconfigured and unselected removed-Key state", () => {
    expect(removedMossKeyStateIsClean({ configured: false, selected: false })).toBe(true);
    expect(removedMossKeyStateIsClean({ configured: true, selected: false })).toBe(false);
    expect(removedMossKeyStateIsClean({ configured: false, selected: true })).toBe(false);
    expect(removedMossKeyStateIsClean({})).toBe(false);
    expect(removedMossKeyStateIsClean(null)).toBe(false);
  });

  it("can retain a provisioned Key only after a successful first run", () => {
    const options = parseMossKeyE2EOptions(["--keep-key-on-success"], {
      MOSS_KEY_E2E_KEY: fixtureKey,
    });
    expect(options.keepKey).toBe(false);
    expect(options.keepKeyOnSuccess).toBe(true);
  });

  it("accepts a local dev app override but rejects remote CDP and plain HTTP app targets", () => {
    const options = parseMossKeyE2EOptions([], {
      MOSS_KEY_E2E_APP_URL: "http://localhost:5733/#/login",
      MOSS_KEY_E2E_CDP_URL: "http://[::1]:9333",
      MOSS_KEY_E2E_KEY: fixtureKey,
    });
    expect(options.appUrl).toBe("http://localhost:5733/");
    expect(options.cdpUrl).toBe("http://[::1]:9333");
    expect(() =>
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_CDP_URL: "https://example.test:9230",
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/loopback-only/);
    expect(() =>
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_APP_URL: "http://example.test",
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/loopback-only/);
    expect(() =>
      parseMossKeyE2EOptions([], {
        MOSS_KEY_E2E_APP_URL: "https://example.test",
        MOSS_KEY_E2E_KEY: fixtureKey,
      }),
    ).toThrow(/loopback-only/);
  });

  it("builds and matches packaged hash routes without putting the Key in a URL", () => {
    const route = buildAppHashRoute("moss://app/index.html#/", "/login/api-key");
    expect(route).toBe("moss://app/index.html#/login/api-key");
    expect(appPageMatches(route, "moss://app/index.html")).toBe(true);
    expect(appPageMatches("http://localhost:5733/#/", "moss://app/index.html")).toBe(false);
    expect(route).not.toContain(fixtureKey);
  });

  it("uses a unique marker in an exact-reply acceptance prompt", () => {
    const first = createAcceptanceMarker();
    const second = createAcceptanceMarker();
    expect(first).toMatch(/^MOSS_KEY_CHAT_OK_[a-f0-9]{16}$/);
    expect(first).not.toBe(second);
    expect(acceptancePrompt(first)).toBe(
      `Reply with exactly ${first} and nothing else. Do not use tools.`,
    );
  });

  it("requires an observable user-facing transition before accepting chat submission", () => {
    const unchanged = {
      editorPresent: true,
      editorMatchesPrompt: true,
      markerVisible: false,
      sendState: "ready",
      transcriptMounted: false,
      turnRunning: false,
    };
    expect(chatSubmissionWasObserved(unchanged)).toBe(false);
    expect(chatSubmissionWasObserved({ ...unchanged, transcriptMounted: true })).toBe(false);
    expect(chatSubmissionWasObserved({ ...unchanged, sendState: "connecting" })).toBe(false);
    expect(chatSubmissionWasObserved({ ...unchanged, editorMatchesPrompt: false })).toBe(true);
    expect(chatSubmissionWasObserved({ ...unchanged, markerVisible: true })).toBe(true);
    expect(chatSubmissionWasObserved({ ...unchanged, sendState: "sending" })).toBe(true);
    expect(chatSubmissionWasObserved({ ...unchanged, turnRunning: true })).toBe(true);
  });

  it("never logs the credential or caught error bodies", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("--key");
    expect(source).not.toContain("options.key}");
    expect(source).not.toContain("String(error)");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("textContent:");
    expect(source).toContain("delete process.env.DEBUG");
    expect(source).toContain("delete process.env.PWDEBUG");
    expect(source).toContain("delete process.env.NODE_DEBUG");
    const runStart = source.indexOf("async function run()");
    const parseOptions = source.indexOf("parseMossKeyE2EOptions", runStart);
    const clearInheritedKey = source.indexOf("delete process.env.MOSS_KEY_E2E_KEY", parseOptions);
    const firstRunStep = source.indexOf("await runStep", clearInheritedKey);
    expect(runStart).toBeGreaterThan(-1);
    expect(parseOptions).toBeGreaterThan(runStart);
    expect(clearInheritedKey).toBeGreaterThan(parseOptions);
    expect(firstRunStep).toBeGreaterThan(clearInheritedKey);
    expect(source).toMatch(/keyInput\.fill\(options\.key,/);
    expect(source).toContain("options.expectSavedKey");
    expect(source).toContain("options.expectRemovedKey");
    expect(source).toContain("name: UI_COPY.continueToMoss");
    expect(source).toContain(': "saved_key_missing"');
    expect(source).toContain('safeFailureOutcome = "saved_key_not_selected"');
    expect(source).toContain('safeFailureOutcome = "cleanup_failed"');
    expect(source).toContain("getMossEnterpriseKeyState");
    expect(source).toContain("Current packaged builds use the WebSocket-native API");
    expect(source).toContain('data-moss-visible-provider-instance="codex_moss"');
    expect(source).toContain("#moss-enterprise-api-key");
    expect(source).toContain("optionsForCleanup.keepKeyOnSuccess && code === 0");
    expect(source).toContain("MOSS_KEY_E2E_DIAGNOSTIC_PATH");
    expect(source).toContain("schemaVersion: 3");
    expect(source).toContain("readSafeChatFailureDetails");
    expect(source).toContain("activeServerThreadInstanceIsManaged");
    expect(source).not.toContain("alertText,");
    expect(source).not.toContain("unavailableReason:");
    expect(source).toContain("alertSurfaces");
    expect(source).toContain("alertSources");
    expect(source).toContain("alertClassifications");
    expect(source).toContain('return "provider-status-loading"');
    expect(source).toContain('return "thread-create"');
    expect(source).not.toContain("alert.textContent,");
    expect(source).toContain("mossVisibleSendPhase");
    expect(source).toContain("mossVisibleProviderInstance");
    expect(source).toContain('printStatus("DIAG", `${activeStep}:${safeFailureOutcome}`)');
    expect(source).toMatch(/printStatus\("FAIL", activeStep\)/);
  });

  it("proves removal after restart without chatting or invoking cleanup removal", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    const removedBranch = source.indexOf("if (options.expectRemovedKey &&");
    const emptyInputCheck = source.indexOf('keyInput.inputValue()) !== ""', removedBranch);
    const removedState = source.indexOf('runStep("verify-removed-key-state"', emptyInputCheck);
    const earlyReturn = source.indexOf("return;", removedState);
    const commonChatGate = source.indexOf('runStep("open-key-chat"', earlyReturn);

    expect(removedBranch).toBeGreaterThan(-1);
    expect(emptyInputCheck).toBeGreaterThan(removedBranch);
    expect(removedState).toBeGreaterThan(emptyInputCheck);
    expect(source.slice(removedState, earlyReturn)).toContain("removedMossKeyStateIsClean(state)");
    expect(earlyReturn).toBeGreaterThan(removedState);
    expect(commonChatGate).toBeGreaterThan(earlyReturn);
    expect(source).toMatch(
      /optionsForCleanup\.expectRemovedKey \|\| retainKey[\s\S]{0,120}\? true/,
    );
  });

  it("classifies key verification failures using only fixed safe outcomes", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    expect(source).toContain("无法连接 Moss，");
    expect(source).toContain('return "state_unavailable"');
    expect(source).toContain('return stillPending ? "state_pending" : "form_unavailable"');
    expect(source).toContain('return "key_rejected"');
    expect(source).toContain('return "quota_exhausted"');
    expect(source).toContain('return "gateway_unavailable"');
    expect(source).toContain('"save_failed"');
    expect(source).toContain('"selection_failed" : "save_failed"');
    expect(source).toContain('return "ui_error"');
    expect(source).toContain('safeFailureOutcome = "verification_timeout"');
    expect(source).toContain('safeFailureOutcome = "form_unavailable"');
    expect(source).toContain('safeFailureOutcome = "chat_unavailable"');
    expect(source).toContain('{ polling: "raf", timeout: 30_000 }');
    expect(source).toContain("timeout: KEY_FORM_ACTION_TIMEOUT_MS");
    expect(source).toContain('printStatus("RUN", "recover-key-form-submit")');
    expect(source).toContain('printStatus("PASS", "recover-key-form-submit")');
    expect(source).toContain('await page.keyboard.press("Enter")');
    expect(source).not.toContain('.getByRole("button", { name: "Continue", exact: true })');
    expect(source).not.toContain("alertText,");
    expect(source).not.toMatch(/printStatus\([^)]*alertText/);
  });

  it("proves restored-Key use without filling the credential and fails closed on cleanup", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    const restoredBranch = source.indexOf("if (options.expectSavedKey)");
    const savedAvailability = source.indexOf("waitForSavedKeyAvailability(page)", restoredBranch);
    const emptyInputCheck = source.indexOf('keyInput.inputValue()) !== ""', savedAvailability);
    const restoredState = source.indexOf('runStep("verify-restored-key-state"', emptyInputCheck);
    const continueWithSavedKey = source.indexOf("name: UI_COPY.continueToMoss", restoredState);
    const commonChatGate = source.indexOf('runStep("open-key-chat"', continueWithSavedKey);
    const requiredRemoval = source.indexOf("optionsForCleanup.expectSavedKey && !keyRemoved");

    expect(restoredBranch).toBeGreaterThan(-1);
    expect(savedAvailability).toBeGreaterThan(restoredBranch);
    expect(emptyInputCheck).toBeGreaterThan(savedAvailability);
    expect(restoredState).toBeGreaterThan(emptyInputCheck);
    expect(continueWithSavedKey).toBeGreaterThan(restoredState);
    expect(commonChatGate).toBeGreaterThan(continueWithSavedKey);
    expect(requiredRemoval).toBeGreaterThan(-1);
    expect(source).not.toMatch(/expectSavedKey[\s\S]{0,500}keyInput\.fill/);
  });

  it("types the first chat through user keyboard events", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("editor.fill(prompt)");
    expect(source).not.toContain("editor.pressSequentially(prompt)");
    expect(source).toContain("page.waitForTimeout(500)");
    expect(source).toContain('page.keyboard.type(" ")');
    expect(source).toContain('page.keyboard.press("Backspace")');
    expect(source).toContain("page.keyboard.type(prompt, { delay: 10 })");
    expect(source).toContain('page.keyboard.press("Enter")');
    expect(source).toContain('printStatus("RUN", "recover-first-submit")');
    expect(source).toContain("if (!primarySubmissionObserved)");
    expect(source).toContain("if (!recoverySubmissionObserved)");
    expect(source).toContain('safeFailureOutcome = "submission_timeout"');
  });

  it("dismisses the one-time macOS AppSnap welcome before asserting Key login", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    const dismissal = source.indexOf("await dismissAppSnapWelcomeIfPresent(page)");
    const loginHeading = source.indexOf('page.getByRole("heading", { name: UI_COPY.keyHeading })');

    expect(source).toContain('process.platform !== "darwin"');
    expect(source).toContain("name: UI_COPY.appSnapHeading");
    expect(source).toContain("name: UI_COPY.appSnapDismiss");
    expect(source).toContain('printStatus("PASS", "dismiss-appsnap-welcome")');
    expect(dismissal).toBeGreaterThan(-1);
    expect(dismissal).toBeLessThan(loginHeading);
  });

  it("drives the enterprise key page without weakening the key gate", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");

    expect(source).toContain("AppSnap is ready!|应用截图（AppSnap）已就绪！");
    expect(source).toContain("使用企业 API Key 登录");
    expect(source).toContain("全部模型 · 国内网络直连");
    expect(source).toContain("^进入 Moss$");
    expect(source).toContain("^移除 Key$");
    expect(source).toContain("无效或已被吊销");
    expect(source).toContain("无法连接 Moss 模型服务");
  });

  it("waits for user and assistant markers through the virtualized transcript", () => {
    const source = readFileSync(new URL("./moss-key-chat-e2e.mjs", import.meta.url), "utf8");
    expect(source).toContain('data-chat-scroll-container="true"');
    expect(source).toContain('runStep("render-user-message"');
    expect(source).not.toContain("rows.length > expectedCount");
    expect(source).toContain('role: "assistant"');
    expect(source).toContain("requireIdle: true");
  });
});
