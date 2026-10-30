// FILE: threadErrorPresentation.test.ts
// Purpose: Guards typed thread-error precedence and user-facing recovery surfaces.
// Layer: Web chat presentation tests

import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import { describe, expect, it } from "vitest";

import {
  isQuotaOwnedThreadError,
  resolveQuotaOwnedThreadError,
  resolveThreadErrorPresentation,
} from "./threadErrorPresentation";

describe("resolveThreadErrorPresentation", () => {
  it("localizes the canonical provider fallback for zh-CN", () => {
    expect(
      resolveThreadErrorPresentation(
        "The provider could not complete this request. Try again shortly.",
        "zh-CN",
      ),
    ).toMatchObject({
      title: "服务商暂时无法完成此请求，请稍后重试。",
      copyText: "服务商暂时无法完成此请求，请稍后重试。",
    });
  });

  it.each([
    ["en" as const, "Working directory not found: /tmp/missing-project"],
    ["zh-CN" as const, "工作目录不存在：/tmp/missing-project"],
  ])("reports the missing working directory accurately for %s", (locale, expected) => {
    expect(
      resolveThreadErrorPresentation(
        "Working directory not found: /tmp/missing-project",
        locale,
        "provider-start-failure",
      ),
    ).toMatchObject({
      title: expected,
      copyText: expected,
    });
  });

  it("extracts a missing working directory from the persisted provider failure", () => {
    const persistedFailure = [
      'Error: Provider adapter validation failed (claudeAgent) in startSession: Could not verify Auto mode support for Claude CLI at "claude": Working directory not found: C:\\项目\\Moss\\已移动',
      "    at ProviderCommandReactor",
    ].join("\n");

    expect(
      resolveThreadErrorPresentation(persistedFailure, "zh-CN", "provider-start-failure"),
    ).toMatchObject({
      title: "工作目录不存在：C:\\项目\\Moss\\已移动",
      copyText: "工作目录不存在：C:\\项目\\Moss\\已移动",
    });
  });

  it.each([
    [
      "en" as const,
      "Project working directory no longer exists: /private/tmp/moss-v107-gui-project. Relocate or reconnect the project in Moss.",
      "Working directory not found: /private/tmp/moss-v107-gui-project",
    ],
    [
      "zh-CN" as const,
      "Project working directory no longer exists: /private/tmp/moss-v107-gui-project. Relocate or reconnect the project in Moss.",
      "工作目录不存在：/private/tmp/moss-v107-gui-project",
    ],
    [
      "zh-CN" as const,
      "Project working directory is not a directory: /tmp/moss-file.txt. Relocate or reconnect the project in Moss.",
      "工作目录不存在：/tmp/moss-file.txt",
    ],
  ])("reports a Codex missing working directory accurately for %s", (locale, raw, expected) => {
    expect(resolveThreadErrorPresentation(raw, locale, "provider-start-failure")).toMatchObject({
      title: expected,
      copyText: expected,
    });
  });

  it("extracts a Codex missing working directory from a wrapped runtime error", () => {
    const persistedFailure = [
      "Error: Provider runtime error",
      "Project working directory no longer exists: /private/tmp/moved-project. Relocate or reconnect the project in Moss.",
      "    at CodexAppServerManager.startSession",
    ].join("\n");

    expect(
      resolveThreadErrorPresentation(persistedFailure, "zh-CN", "provider-start-failure"),
    ).toMatchObject({
      title: "工作目录不存在：/private/tmp/moved-project",
      copyText: "工作目录不存在：/private/tmp/moved-project",
    });
  });

  it.each([
    [
      "en" as const,
      "Your personal Codex usage limit has been reached. Open ChatGPT Codex usage to buy credits, wait for the reset, or switch providers.",
    ],
    [
      "zh-CN" as const,
      "个人 Codex 使用额度已达上限。请在 ChatGPT Codex 用量页购买额度、等待重置，或切换服务商。",
    ],
  ])(
    "presents a personal Codex usage limit as an actionable safe state for %s",
    (locale, expected) => {
      const raw =
        "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 28th, 2026 11:43 PM.";

      const presentation = resolveThreadErrorPresentation(raw, locale);

      expect(presentation.title).toBe(expected);
      expect(presentation.copyText).toBe(expected);
      expect(`${presentation.title}\n${presentation.copyText}`).not.toMatch(
        /(?:https?:\/\/|Aug 28th|11:43 PM)/iu,
      );
    },
  );

  it.each([
    "request_quota_exhausted",
    "token_quota_exhausted",
    "service_cost_window_exhausted",
    "The Moss account five-hour usage allowance is exhausted.",
    "The Moss account weekly usage allowance is exhausted.",
  ])("prioritizes %s over a generic 429 presentation", (reason) => {
    const raw = `exceeded retry limit, last status: 429 Too Many Requests {"error":{"code":"${reason}"}}`;

    expect(resolveThreadErrorPresentation(raw, "en")).toMatchObject({
      title:
        "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.",
      copyText:
        "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.",
    });
  });

  it("presents shared package exhaustion without promising a reset or another wallet", () => {
    for (const raw of [
      "service_cost_budget_exhausted",
      "Your Moss package usage allowance is exhausted.",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe("套餐额度已用完。");
      expect(isQuotaOwnedThreadError(raw)).toBe(true);
    }
  });

  it("localizes a period-quota rejection without exposing transport details", () => {
    const presentation = resolveThreadErrorPresentation(
      'HTTP 429 {"error":{"message":"The Moss account quota for this period is exhausted.","code":"request_quota_exhausted"}}',
      "zh-CN",
    );

    expect(presentation.title).toBe("本周期的 Moss 使用额度已用完，请升级套餐或等待额度重置。");
    expect(presentation.copyText).toBe(presentation.title);
  });

  it("preserves a safe server-provided quota reset hint", () => {
    expect(
      resolveThreadErrorPresentation(
        "Moss account quota is exhausted for this period. Top up your plan, or try again in about 6d 22h.",
        "zh-CN",
      ).title,
    ).toBe("本周期的 Moss 使用额度已用完，请升级套餐，或约 6d 22h 后重试。");
  });

  it("keeps a plain 429 as a transient rate-limit presentation", () => {
    expect(
      resolveThreadErrorPresentation(
        "exceeded retry limit, last status: 429 Too Many Requests",
        "en",
      ),
    ).toMatchObject({
      title: "Moss is receiving too many requests right now. Try again shortly.",
    });
  });

  it("tells the user to sign in again when Codex's ChatGPT sign-in has expired", () => {
    for (const raw of [
      "workspace routing discovery unauthorized (401)",
      "The task was interrupted by a provider error. Work remains incomplete. Your access token could not be refreshed. Please log out and sign in again.",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN")).toMatchObject({
        title: "这个账号的登录已失效。请在服务商设置中重新登录，或改用 Moss 服务。",
        recoveryAction: "manage-providers",
      });
    }
    expect(
      resolveThreadErrorPresentation("workspace routing discovery unauthorized (401)", "en").title,
    ).toBe(
      "This account's sign-in has expired. Sign in again in provider settings, or switch to Moss.",
    );
  });

  it("keeps a Grok 401 reason after stripping the upstream URL", () => {
    const presentation = resolveThreadErrorPresentation(
      "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat Invalid or expired credentials",
      "zh-CN",
    );

    expect(presentation.title).toBe("Unauthorized (401) Invalid or expired credentials");
    expect(presentation.copyText).toBe(presentation.title);
    expect(presentation.title).not.toMatch(/https?:\/\//u);
    expect(presentation.title).not.toBe("服务商暂时无法完成此请求，请稍后重试。");
  });

  it("keeps the 401 reason from a wrapped adapter prompt failure", () => {
    const presentation = resolveThreadErrorPresentation(
      "Provider adapter request failed (grok) for session/prompt: Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat Invalid or expired credentials",
      "zh-CN",
    );

    expect(presentation.title).toBe("Unauthorized (401) Invalid or expired credentials");
    expect(presentation.title).not.toMatch(/https?:\/\/|Provider adapter request failed/u);
    expect(presentation.title).not.toBe("服务商暂时无法完成此请求，请稍后重试。");
  });

  it("keeps the first paragraph of a long Grok 401 body after stripping the URL", () => {
    const grok401 = [
      "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat Invalid or expired credentials (token rejected).",
      "",
      "Available models: grok-4, grok-4.6, grok-3, grok-3-mini, grok-2, grok-2-vision, grok-2-mini.",
      "Authentication is temporarily unavailable for this request. There is no need to run /login;",
      "the cached session is still present but the supplied API key was rejected by the proxy.",
      "Retry after rotating the key. Diagnostic dump: request-id=req_grok_401_fixture",
      'payload: {"models":["grok-4","grok-4.6","grok-3","grok-3-mini","grok-2","grok-2-vision"]}',
      "See also https://cli-chat-proxy.grok.com/docs/auth for the full authentication guide.",
    ].join("\n");
    const raw = `Provider adapter request failed (grok) for session/prompt: ${grok401}`;

    expect(raw.length).toBeGreaterThan(240);
    expect(raw.replace(/https?:\/\/[^\s]+/gu, "").length).toBeGreaterThan(240);

    const presentation = resolveThreadErrorPresentation(raw, "zh-CN");

    expect(presentation.title).toMatch(/^Unauthorized \(401\) Invalid or expired credentials/);
    expect(presentation.title.length).toBeLessThanOrEqual(240);
    expect(presentation.title).not.toMatch(/https?:\/\//u);
    expect(presentation.title).not.toContain("Available models");
    expect(presentation.title).not.toContain("run /login");
    expect(presentation.title).not.toBe("服务商暂时无法完成此请求，请稍后重试。");
  });

  it("keeps the 401 reason from the Task interrupted card's prefixed 651-character string", () => {
    const prefix = "The task was interrupted by a provider error. Work remains incomplete. ";
    const grok401 = [
      "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat/completions Invalid or expired credentials (token rejected: the supplied XAI_API_KEY was not accepted by the upstream proxy for this session).",
      "",
      "Available models: grok-4, grok-4.6, grok-3, grok-3-mini, grok-2, grok-2-vision, grok-2-mini, grok-code-fast-1.",
      "Authentication is temporarily unavailable for this request. There is no need to run /login;",
      "the cached session is still present but the supplied API key was rejected by the proxy.",
      "Retry after rotating the key. Diagnostic dump: request-id=req_grok_401_card_fixture",
      'payload: {"models":["grok-4","grok-4.6","grok-3","grok-3-mini","grok-2","grok-2-vision","grok-code-fast-1"]}',
      "See also https://cli-chat-proxy.grok.com/docs/auth for the full authentication guide and account recovery steps.",
    ].join("\n");
    const cardError = `${prefix}${grok401}`;

    expect(cardError.length).toBeGreaterThanOrEqual(651);
    const firstParagraph = `${prefix}${grok401.split(/\n\s*\n/u)[0] ?? ""}`;
    expect(firstParagraph.length).toBeGreaterThan(240);

    const presentation = resolveThreadErrorPresentation(cardError, "zh-CN");

    expect(presentation.title).toMatch(/^Unauthorized \(401\) Invalid or expired credentials/);
    expect(presentation.title.length).toBeLessThanOrEqual(240);
    expect(presentation.title).not.toMatch(/https?:\/\//u);
    expect(presentation.title).not.toContain("The task was interrupted");
    expect(presentation.title).not.toContain("Available models");
    expect(presentation.title).not.toBe("服务商暂时无法完成此请求，请稍后重试。");
  });

  it("keeps a Grok 400 incorrect-key reason without genericizing it", () => {
    const presentation = resolveThreadErrorPresentation(
      "API error (status 400 Bad Request): invalid-argument: Incorrect API key provided",
      "zh-CN",
    );

    expect(presentation.title).toContain("Incorrect API key provided");
    expect(presentation.title).not.toBe("服务商暂时无法完成此请求，请稍后重试。");
  });

  it("still genericizes a diagnostic that keeps a filesystem path after URL stripping", () => {
    expect(
      resolveThreadErrorPresentation("failed at /Users/moss/.grok/auth.json", "en"),
    ).toMatchObject({
      title: "The provider could not complete this request. Try again shortly.",
    });
  });

  it("shows grok login for an unsigned-in start failure", () => {
    expect(
      resolveThreadErrorPresentation(
        "Grok is not authenticated for headless ACP. Run `grok login` (or launch `grok`) and retry. Grok advertised only interactive auth methods: browser_login, grok.com.",
        "zh-CN",
        "provider-start-failure",
      ),
    ).toMatchObject({
      title: "请运行 grok login",
      copyText: "请运行 grok login",
    });
    expect(
      resolveThreadErrorPresentation("Not signed in. Run grok login and retry.", "en"),
    ).toMatchObject({
      title: "Please run grok login",
    });
  });

  it("does not tell other providers to run grok login", () => {
    for (const context of ["thread", "provider-start-failure"] as const) {
      expect(
        resolveThreadErrorPresentation(
          "Claude could not start: Claude CLI is not signed in.",
          "en",
          context,
        ).title,
      ).not.toBe("Please run grok login");
    }
  });

  it("still hides socket error codes after the 401 passthrough", () => {
    for (const raw of [
      "Provider adapter request failed (grok): connect ETIMEDOUT",
      "Provider adapter request failed (grok) for session/prompt: read ECONNRESET",
      "getaddrinfo ENOTFOUND api.x.ai",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(
        "服务商暂时无法完成此请求，请稍后重试。",
      );
    }
  });

  it("names Codex's own thread-start timeout in plain words and allows a retry", () => {
    for (const raw of [
      "Timed out waiting for thread/start.",
      "Provider adapter process error (codex) for thread 9d8b0e49-928c-45e5-b5d4-beac8e5694ab: Timed out waiting for thread/start.",
      "Timed out waiting for thread/resume.",
      // The reactor's own words when its delivery deadline beat a slow start.
      "The provider did not finish starting within 120000ms, so the message was not sent.",
      "Error: Provider adapter process error (codex) for thread 9d8b0e49-928c-45e5-b5d4-beac8e5694ab: Failed to execute Codex CLI version check: Codex CLI version check timed out after 4000ms.",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN")).toMatchObject({
        title:
          "服务商启动超时，对话没能开始。请重试；如果一直这样，可以在服务商设置里检查，或换一个服务商。",
        retryable: true,
      });
    }
    expect(resolveThreadErrorPresentation("Timed out waiting for thread/start.", "en").title).toBe(
      "The provider took too long to start, so the chat didn't begin. Try again; if it keeps happening, check the provider in settings or switch providers.",
    );
    expect(
      resolveThreadErrorPresentation("Unauthorized (401) Invalid credentials", "en").retryable,
    ).toBeUndefined();
  });

  it("marks provider-start timeout recovery as history-only", () => {
    expect(
      resolveThreadErrorPresentation(
        "Provider turn start failed: thread/start timeout after 60000ms.",
        "en",
      ),
    ).toMatchObject({
      surface: "history",
      recoveryAction: "manage-providers",
    });
  });
});

describe("isQuotaOwnedThreadError", () => {
  it.each([
    "request_quota_exhausted",
    "token_quota_exhausted",
    "service_cost_budget_exhausted",
    "service_cost_window_exhausted",
    "gateway rejected request_quota_exhausted for this period",
    "Moss account quota for this period is exhausted",
    "The Moss account five-hour usage allowance is exhausted.",
    "The Moss account weekly usage allowance is exhausted.",
  ])("accepts quota-specific error %s", (error) => {
    expect(isQuotaOwnedThreadError(error)).toBe(true);
  });

  it("keeps an actionable provider-delivery block outside quota ownership", () => {
    expect(
      isQuotaOwnedThreadError(
        formatProviderDeliveryBlockDetail(
          "External provider command claim expired without a durable acceptance result; execution was not replayed.",
        ),
      ),
    ).toBe(false);
  });

  it("does not claim unrelated delivery failures for the quota surface", () => {
    expect(isQuotaOwnedThreadError("Unable to send this message.")).toBe(false);
    expect(isQuotaOwnedThreadError("Provider runtime error")).toBe(false);
    expect(isQuotaOwnedThreadError("Provider turn failed")).toBe(false);
    expect(isQuotaOwnedThreadError("Turn failed")).toBe(false);
  });

  it("suppresses only a quota-owned error while the authoritative surface is visible", () => {
    const deliveryBlock = formatProviderDeliveryBlockDetail(
      "External provider command claim expired without a durable acceptance result; execution was not replayed.",
    );

    expect(resolveQuotaOwnedThreadError("request_quota_exhausted", true)).toBe(
      "request_quota_exhausted",
    );
    expect(resolveQuotaOwnedThreadError(deliveryBlock, true)).toBeNull();
    expect(resolveQuotaOwnedThreadError("Provider runtime error", true)).toBeNull();
    expect(resolveQuotaOwnedThreadError("request_quota_exhausted", false)).toBeNull();
  });
});
