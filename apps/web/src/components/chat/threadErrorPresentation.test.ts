// FILE: threadErrorPresentation.test.ts
// Purpose: Guards typed thread-error precedence and user-facing recovery surfaces.
// Layer: Web chat presentation tests

import { formatProviderDeliveryBlockDetail } from "@moss/shared/providerDeliveryBlock";
import { describe, expect, it } from "vitest";

import { WS_MESSAGE_NOT_SENT_DETAIL } from "../../wsTransportEvents";

import {
  isExplainedProviderFailure,
  isQuotaOwnedThreadError,
  resolveQuotaOwnedThreadError,
  resolveThreadErrorPresentation,
} from "./threadErrorPresentation";

describe("resolveThreadErrorPresentation", () => {
  it.each([
    [WS_MESSAGE_NOT_SENT_DETAIL, "Moss 暂时连不上后端，这条消息没有发出，内容还在输入框里。"],
    [
      "The connection was interrupted before this message was accepted. Please send it again.",
      "消息还没被接收，连接就中断了。请再发一次。",
    ],
  ])("says plainly that a send did not go through: %s", (raw, zhCn) => {
    expect(resolveThreadErrorPresentation(raw, "en").title).toBe(raw);
    expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(zhCn);
  });

  it("offers another model first when the model itself cannot take the request", () => {
    const raw =
      'unexpected status 400 Bad Request: {"error":{"message":"The model cannot represent these tool definitions or tool choices.","type":"invalid_request_error","code":"unsupported_tool_definition"}}';
    expect(resolveThreadErrorPresentation(raw, "zh-CN")).toMatchObject({
      title: "这个模型用不了这次对话需要的某个工具。换一个模型，再点「继续任务」就能接着做。",
      changeModelFirst: true,
    });
    expect(
      resolveThreadErrorPresentation("The model service timed out.", "zh-CN").changeModelFirst,
    ).toBeUndefined();
  });

  it("says plainly when the local Pi account cannot run the thread's model", () => {
    const raw =
      "Error: Provider adapter request failed (pi) for model/set: This Pi account has no sign-in for DeepSeek Flash. Switch to Moss or another model to continue.";
    for (const context of ["thread", "provider-start-failure"] as const) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN", context)).toMatchObject({
        title: "本机的 Pi 还没登录能用「DeepSeek Flash」的账号。换成 Moss 或其他模型就能继续。",
        changeModelFirst: true,
      });
    }
    expect(resolveThreadErrorPresentation(raw, "en").title).toBe(
      "This Pi account has no sign-in for DeepSeek Flash. Switch to Moss or another model to continue.",
    );
    expect(isExplainedProviderFailure(raw)).toBe(true);
  });

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

  it("explains the gateway refusing an identical request, however the CLI words it", () => {
    for (const raw of [
      'Conflict: {"object":"moss.operation_status","operation_id":"a","status":"completed","retry_safe":false}',
      "409 status code (no body)",
      "Provider adapter request failed (hermes) for session/prompt: Hermes model request failed (HTTP 409).",
      "Provider adapter request failed (minimax) for session/prompt: Internal error: MiniMax Code Runtime failed: BYOK provider custom_provider:moss upstream error: 409 status code (no body) (JSON-RPC -32603)",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(
        "刚刚已经发送过完全相同的请求，Moss 不会重复发送，以免重复计费。请改一下消息内容，或等大约 15 分钟后再试。",
      );
      expect(resolveThreadErrorPresentation(raw, "en").title).toContain("identical request");
    }
  });

  it("says an identical request is still running on a gateway that refuses only then", () => {
    for (const raw of [
      'Conflict: {"object":"moss.operation_status","status":"in_progress","retry_safe":true,"error":{"message":"An identical request is still running. Retry when it finishes.","code":"operation_in_progress"}}',
      "409 An identical request is still running. Retry when it finishes.",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(
        "相同的请求还在运行，等它结束后再试。",
      );
      expect(resolveThreadErrorPresentation(raw, "en").title).toBe(
        "An identical request is still running. Retry when it finishes.",
      );
    }
  });

  it("says the connection dropped when a stream stalls and is cut off", () => {
    for (const raw of [
      "stream disconnected before completion: idle timeout waiting for SSE",
      "stream disconnected before completion: Transport error: network error: error decoding response body",
      "Provider adapter request failed (minimax) for session/prompt: Internal error: MiniMax Code Runtime failed: BYOK provider custom_provider:moss upstream error: terminated (JSON-RPC -32603)",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(
        "与模型服务的连接中断了，请重试。",
      );
      expect(resolveThreadErrorPresentation(raw, "en").title).toBe(
        "The connection to the model service dropped. Try again.",
      );
      expect(isExplainedProviderFailure(raw)).toBe(true);
    }
  });

  it("translates Claude's server error on the failure card", () => {
    expect(
      resolveThreadErrorPresentation("Claude returned a server error. Retry in a moment.", "zh-CN")
        .title,
    ).toBe("Claude 返回了服务器错误，请稍后重试。");
  });

  it("shows the gateway's reason in place of each CLI's raw wrapper", () => {
    for (const raw of [
      "unexpected status 502 Bad Gateway: The model service is temporarily unavailable., url: https://moss.example/functions/v1/moss-model-gateway/v1/responses",
      '502: {"message":"The model service is temporarily unavailable.","type":"upstream_error","code":"upstream_unavailable"}',
      "The model service is temporarily unavailable.",
      "Provider adapter request failed (grok) for session/prompt: API error (status 502 Bad Gateway): upstream_error: The model service is temporarily unavailable.",
    ]) {
      expect(resolveThreadErrorPresentation(raw, "zh-CN").title).toBe(
        "模型服务暂时不可用，请稍后重试。",
      );
      expect(resolveThreadErrorPresentation(raw, "en").title).toBe(
        "The model service is temporarily unavailable.",
      );
    }
    expect(
      resolveThreadErrorPresentation(
        "unexpected status 404 Not Found: This model is not available for this Moss sign-in method., url: https://moss.example/v1/responses",
        "zh-CN",
      ).title,
    ).toBe("当前的 Moss 登录方式不能使用这个模型，请换一个模型。");
  });

  it("shows why an agent could not start, without its adapter text or stack", () => {
    const raw =
      "Error: Provider adapter process error (kimi) for thread t-1: Kimi Code session startup failed: Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry. (Internal error Git Bash was not found on this Windows host.)\n    at <anonymous> (C:\\moss\\apps\\server\\AcpAgentAdapter.ts:755:21)";
    expect(resolveThreadErrorPresentation(raw, "zh-CN", "provider-start-failure").title).toBe(
      "在 Windows 上，Kimi Code 需要 Git Bash，但 Moss 没有找到。请安装 Git for Windows，或把 KIMI_SHELL_PATH 设为 bash.exe 的路径，然后重试。",
    );
    expect(resolveThreadErrorPresentation(raw, "en").title).toBe(
      "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.",
    );
  });

  it.each([
    [
      "Moss could not safely apply compatibility for this Hermes version.",
      "Moss 无法安全兼容这个 Hermes 版本。",
    ],
    [
      "This Hermes installation is missing the required compatibility helper.",
      "当前 Hermes 安装缺少所需的兼容组件。",
    ],
    [
      "Hermes compatibility did not load from its isolated Moss home.",
      "Hermes 兼容组件未从 Moss 隔离目录加载。",
    ],
    [
      "Hermes compatibility did not load. Check whether its Moss plugin is disabled.",
      "Hermes 兼容组件未加载，请检查 Moss 插件是否已停用。",
    ],
    [
      "Moss Hermes compatibility is disabled in this isolated home's plugin settings.",
      "Moss Hermes 兼容插件已在此隔离目录的插件设置中停用。",
    ],
    [
      "Managed Hermes plugin configuration could not be read safely.",
      "无法安全读取 Moss 托管的 Hermes 插件配置。",
    ],
    [
      "Moss Hermes compatibility plugin conflicts with an existing plugin.",
      "Moss Hermes 兼容插件与已有插件冲突，原文件已保留。",
    ],
  ])("retains the safe Hermes startup diagnosis %s in English and Chinese", (english, chinese) => {
    const raw = `Error: Provider adapter process error (hermes) for thread private-id: Hermes session startup failed: ${english} (JSON-RPC -32000)\n    at <anonymous> (C:\\private\\server.js:1:2) secret=fake-sensitive-detail`;
    for (const context of ["thread", "provider-start-failure"] as const) {
      expect(resolveThreadErrorPresentation(raw, "en", context)).toMatchObject({
        title: english,
        copyText: english,
      });
      expect(resolveThreadErrorPresentation(raw, "zh-CN", context)).toMatchObject({
        title: chinese,
        copyText: chinese,
      });
    }
  });

  it("says what to do when a Moss Codex chat has no sign-in runtime, in every surface", () => {
    // The strings the owner's failed turn persisted: the session error, the
    // adapter-wrapped turn-start failure with its stack, and a revoked runtime.
    for (const raw of [
      "Reserved Codex account 'moss' requires a server-issued runtime generation.",
      "Error: Provider adapter process error (codex) for thread 481d4fd9-d382-4db0-97a6-3987a7e646b0: Reserved Codex account 'moss' requires a server-issued runtime generation.\n    at catch (file:///C:/moss/apps/server/dist/index.mjs:168353:22)",
      "Codex account runtime generation was revoked; recreate the account runtime before retrying.",
    ]) {
      for (const context of ["thread", "provider-start-failure"] as const) {
        expect(resolveThreadErrorPresentation(raw, "zh-CN", context).title).toBe(
          "Moss 模型服务还没为这个对话准备好。请重新登录 Moss，或换一个服务商后重试。",
        );
        expect(resolveThreadErrorPresentation(raw, "en", context).title).toBe(
          "Moss's models aren't ready for this chat. Sign in to Moss again, or switch to another provider, then retry.",
        );
      }
      expect(isExplainedProviderFailure(raw)).toBe(true);
    }
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

  it("tells the person Codex was slow to read its data folder, and what to do", () => {
    const raw =
      "Error: Provider validation failed in ProviderService.startSession: Provider 'codex' did not finish starting within 100000ms for thread 'a2ad9cbf-2107-47af-a0e2-3b384705ac38'. Codex was still loading its data folder (E:\\Codex\\home) after 99 s.\n    at stack";
    expect(resolveThreadErrorPresentation(raw, "zh-CN")).toMatchObject({
      title:
        "Codex 读取它的数据文件夹（E:\\Codex\\home）太慢，对话没能开始。通常是这个文件夹所在的磁盘正忙或很慢，比如正在大范围搜索文件、杀毒扫描，或者另一个 Codex 应用在大量读写。等磁盘空闲后再试；如果经常这样，可以把 Codex 的数据文件夹放到更快的磁盘上。",
      retryable: true,
      recoveryAction: "manage-providers",
    });
    const opening =
      "Provider 'codex' did not finish starting within 100000ms for thread 't'. Codex was still opening the conversation in its data folder after 61 s.";
    expect(resolveThreadErrorPresentation(opening, "en").title).toBe(
      "Codex took too long to read its data folder, so the chat didn't begin. The disk holding it is usually busy or slow, for example with a large file search, a virus scan, or another Codex app reading and writing a lot. Try again when the disk is quieter; if it keeps happening, move Codex's data folder to a faster disk.",
    );
    // Without the sentence, the plain start timeout stays.
    expect(
      resolveThreadErrorPresentation(
        "Provider 'codex' did not finish starting within 100000ms for thread 't'.",
        "en",
      ).title,
    ).toMatch(/^The provider took too long to start/);
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
