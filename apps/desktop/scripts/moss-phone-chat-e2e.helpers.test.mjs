import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

import {
  acceptancePrompt,
  aliyunPercentEncode,
  appPageMatches,
  buildAliyunQuerySendDetailsUrl,
  buildAppHashRoute,
  chatSubmissionWasObserved,
  createAcceptanceMarker,
  createProfileMarker,
  createRestartReceipt,
  extractFreshSmsCode,
  normalizeMainlandPhone,
  parseMossPhoneE2EOptions,
  restartReceiptMatches,
  shanghaiDateStrings,
} from "./moss-phone-chat-e2e.helpers.mjs";

const fixtureCredentials = {
  MOSS_PHONE_E2E_PHONE: "13800138000",
  ALIYUN_SMS_AUDIT_ACCESS_KEY_ID: "fixture-audit-access-key-id",
  ALIYUN_SMS_AUDIT_ACCESS_KEY_SECRET: "fixture-audit-access-key-secret",
  ALIYUN_SMS_TEMPLATE_CODE_LOGIN: "SMS_123456789",
  MOSS_PHONE_E2E_RESTART_RECEIPT_PATH: "/tmp/moss-phone-e2e-restart-receipt.json",
};

describe("Moss phone-account real-chat E2E helpers", () => {
  it("accepts only a mainland phone and keeps credentials out of CLI options", () => {
    expect(normalizeMainlandPhone("+86 138 0013 8000")).toBe("13800138000");
    expect(() => normalizeMainlandPhone("123")).toThrow(/invalid/);
    expect(() => parseMossPhoneE2EOptions(["--phone", "13800138000"], fixtureCredentials)).toThrow(
      /unknown option/,
    );
    expect(parseMossPhoneE2EOptions([], fixtureCredentials)).toMatchObject({
      phone: "13800138000",
      expectSavedSession: false,
      logoutOnSuccess: false,
    });
  });

  it("requires a credential-free second run and permits cleanup only after restart", () => {
    const receiptOnly = {
      MOSS_PHONE_E2E_RESTART_RECEIPT_PATH: "/tmp/moss-phone-e2e-restart-receipt.json",
    };
    expect(parseMossPhoneE2EOptions(["--expect-saved-session"], receiptOnly)).toMatchObject({
      armRestartReceipt: false,
      expectSavedSession: true,
      logoutOnSuccess: false,
    });
    expect(() => parseMossPhoneE2EOptions(["--expect-saved-session"], fixtureCredentials)).toThrow(
      /must not receive login credentials/,
    );
    expect(() =>
      parseMossPhoneE2EOptions(["--expect-saved-session"], {
        ...receiptOnly,
        ALIYUN_ACCESS_KEY_ID: "inherited-generic-access-key-id",
      }),
    ).toThrow(/must not receive login credentials/);
    expect(() => parseMossPhoneE2EOptions(["--logout-on-success"], fixtureCredentials)).toThrow(
      /retained for restart/,
    );
    expect(
      parseMossPhoneE2EOptions(["--expect-saved-session", "--logout-on-success"], receiptOnly),
    ).toMatchObject({
      expectSavedSession: true,
      logoutOnSuccess: true,
    });
    expect(parseMossPhoneE2EOptions(["--arm-restart-receipt"], receiptOnly)).toMatchObject({
      armRestartReceipt: true,
      expectSavedSession: false,
    });
    expect(() =>
      parseMossPhoneE2EOptions(["--arm-restart-receipt", "--expect-saved-session"], receiptOnly),
    ).toThrow(/mutually exclusive/);
  });

  it("builds only loopback CDP and stable packaged routes", () => {
    const route = buildAppHashRoute("moss://app/index.html#/", "/login");
    expect(route).toBe("moss://app/index.html#/login");
    expect(appPageMatches(route, "moss://app/index.html")).toBe(true);
    expect(() =>
      parseMossPhoneE2EOptions([], {
        ...fixtureCredentials,
        MOSS_PHONE_E2E_CDP_URL: "https://example.test:9230",
      }),
    ).toThrow(/loopback-only/);
    expect(() =>
      parseMossPhoneE2EOptions([], {
        ...fixtureCredentials,
        MOSS_PHONE_E2E_APP_URL: "https://example.test/app",
      }),
    ).toThrow(/loopback-only/);
  });

  it("uses a distinct account marker and exact-reply prompt", () => {
    const marker = createAcceptanceMarker();
    expect(marker).toMatch(/^MOSS_ACCOUNT_CHAT_OK_[a-f0-9]{16}$/u);
    expect(acceptancePrompt(marker)).toBe(
      `Reply with exactly ${marker} and nothing else. Do not use tools.`,
    );
  });

  it("encodes and signs an Aliyun RPC query without leaking secrets into path data", () => {
    expect(aliyunPercentEncode("!*'() ~")).toBe("%21%2A%27%28%29%20~");
    const url = new URL(
      buildAliyunQuerySendDetailsUrl({
        accessKeyId: "fixture-id",
        accessKeySecret: "fixture-secret",
        date: "20260717",
        nonce: "fixture-nonce",
        phone: "13800138000",
        region: "cn-hangzhou",
        timestamp: "2026-07-16T20:00:00Z",
      }),
    );
    expect(url.protocol).toBe("https:");
    expect(url.hostname).toBe("dysmsapi.aliyuncs.com");
    expect(url.searchParams.get("Action")).toBe("QuerySendDetails");
    expect(url.searchParams.get("Signature")).toBeTruthy();
    expect(url.toString()).not.toContain("fixture-secret");
  });

  it("extracts only a fresh six-digit code from the selected login template", () => {
    const notBeforeMs = Date.parse("2026-07-17T04:00:00.900+08:00");
    const payload = {
      SmsSendDetailDTOs: {
        SmsSendDetailDTO: [
          {
            Content: "旧验证码 111111",
            SendDate: "2026-07-17 03:59:57",
            TemplateCode: "LOGIN",
          },
          {
            Content: "您的验证码是 222222，请勿泄露。",
            SendDate: "2026-07-17 04:00:02",
            TemplateCode: "OTHER",
          },
          {
            Content: '{"code":"333333"}',
            SendDate: "2026-07-17 04:00:03",
            TemplateCode: "LOGIN",
          },
          {
            Content: '{"code":"444444"}',
            SendDate: "2026-07-17 04:00:04",
          },
        ],
      },
    };
    expect(extractFreshSmsCode(payload, { notBeforeMs, templateCode: "LOGIN" })).toBe("333333");
    expect(extractFreshSmsCode(payload, { notBeforeMs })).toBeNull();
  });

  it("requires an exact login template and dedicated read-only audit credentials", () => {
    const { ALIYUN_SMS_TEMPLATE_CODE_LOGIN: _template, ...missingTemplate } = fixtureCredentials;
    expect(() => parseMossPhoneE2EOptions([], missingTemplate)).toThrow(
      /ALIYUN_SMS_TEMPLATE_CODE_LOGIN is required/,
    );
    expect(() =>
      parseMossPhoneE2EOptions([], {
        MOSS_PHONE_E2E_PHONE: fixtureCredentials.MOSS_PHONE_E2E_PHONE,
        ALIYUN_ACCESS_KEY_ID: "fixture-production-key-id",
        ALIYUN_ACCESS_KEY_SECRET: "fixture-production-key-secret",
        ALIYUN_SMS_TEMPLATE_CODE_LOGIN: "SMS_123456789",
        MOSS_PHONE_E2E_RESTART_RECEIPT_PATH: fixtureCredentials.MOSS_PHONE_E2E_RESTART_RECEIPT_PATH,
      }),
    ).toThrow(/ALIYUN_SMS_AUDIT_ACCESS_KEY_ID is required/);
  });

  it("queries today and yesterday in Shanghai time", () => {
    expect(shanghaiDateStrings(new Date("2026-07-16T16:30:00Z"))).toEqual(["20260717", "20260716"]);
  });

  it("requires a visible transition before accepting chat submission", () => {
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
    expect(chatSubmissionWasObserved({ ...unchanged, sendState: "sending" })).toBe(true);
  });

  it("binds restart proof to the same browser-storage profile and a different Electron PID", () => {
    const profileMarker = createProfileMarker();
    const receipt = createRestartReceipt({ browserPid: 100, profileMarker });
    expect(receipt).toMatchObject({
      schemaVersion: 1,
      electronBrowserPid: 100,
    });
    expect(receipt.profileFingerprint).toMatch(/^[a-f0-9]{64}$/u);
    expect(restartReceiptMatches(receipt, { browserPid: 101, profileMarker })).toBe(true);
    expect(restartReceiptMatches(receipt, { browserPid: 100, profileMarker })).toBe(false);
    expect(
      restartReceiptMatches(receipt, {
        browserPid: 101,
        profileMarker: createProfileMarker(),
      }),
    ).toBe(false);
  });

  it("keeps credentials, OTP bodies, and caught errors out of output surfaces", () => {
    const source = readFileSync(new URL("./moss-phone-chat-e2e.mjs", import.meta.url), "utf8");
    expect(source).not.toContain("--phone");
    expect(source).not.toContain("String(error)");
    expect(source).not.toContain("error.message");
    expect(source).not.toContain("Content:");
    expect(source).not.toMatch(/printStatus\([^)]*(?:phone|code|payload|url)/iu);
    expect(source).toContain("delete process.env.DEBUG");
    expect(source).toContain("delete process.env.PWDEBUG");
    expect(source).toContain("delete process.env.NODE_DEBUG");

    const runStart = source.indexOf("async function run()");
    const parseOptions = source.indexOf("parseMossPhoneE2EOptions", runStart);
    const clearPhone = source.indexOf("delete process.env[name]", parseOptions);
    const firstRunStep = source.indexOf("await runStep", clearPhone);
    expect(runStart).toBeGreaterThan(-1);
    expect(parseOptions).toBeGreaterThan(runStart);
    expect(clearPhone).toBeGreaterThan(parseOptions);
    expect(firstRunStep).toBeGreaterThan(clearPhone);

    expect(source).toContain('data-moss-visible-provider-instance="codex_moss"');
    expect(source).toContain('data-moss-visible-provider-instance="codex_byok"');
    expect(source).toContain('data-moss-visible-model="gpt-5.6-terra"');
    expect(source).toContain('safeFailureOutcome = "moss_selection_failed"');
    expect(source).toContain("QuerySendDetails");
    expect(source).toContain("options.expectSavedSession");
    expect(source).toContain("options.armRestartReceipt");
    expect(source).toContain("verifyRestartBoundary");
    expect(source).toContain("armRestartBoundary");
    expect(source).toContain('document.querySelector("#moss-phone-account-heading")');
    expect(source).toContain('document.querySelector("#moss-phone-number")');
    expect(source).toContain('document.querySelector("#moss-account-heading")');
    expect(source).toContain("MOSS_PHONE_E2E_DIAGNOSTIC_PATH");
    expect(source).toContain('printStatus("DIAG", `${activeStep}:${safeFailureOutcome}`)');
    expect(source).toMatch(/printStatus\("FAIL", activeStep\)/);
  });
});
