// FILE: providerRuntimeMessages.test.ts
// Purpose: Prove provider runtime localization is exact and preserves dynamic identifiers.
// Layer: Web unit tests

import { describe, expect, it } from "vitest";

import {
  localizeProviderRuntimeMessage,
  normalizeProviderRuntimeMessage,
  PERSONAL_CODEX_USAGE_LIMIT_MESSAGE,
  ZH_CN_TURN_FAILURE_MESSAGES,
} from "./providerRuntimeMessages";

describe("localizeProviderRuntimeMessage", () => {
  it("says in Chinese when a session came back without its history", () => {
    expect(
      localizeProviderRuntimeMessage(
        "The session restarted without its previous history.",
        "zh-CN",
      ),
    ).toBe("会话已重新启动，之前的对话记录没有带上。");
    expect(
      localizeProviderRuntimeMessage(
        "Summary: 2 messages omitted; 1 message shortened. The session was restarted, so your message included a summary.",
        "zh-CN",
      ),
    ).toBe(
      "摘要：省略了 2 条消息；缩短了 1 条消息。会话已重新启动，你的消息附上了之前对话的摘要。",
    );
    expect(
      localizeProviderRuntimeMessage("The session restarted without its previous history.", "en"),
    ).toBe("The session restarted without its previous history.");
  });

  it("normalizes a personal Codex usage verdict without retaining its URL or reset timestamp", () => {
    const raw =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 28th, 2026 11:43 PM.";

    expect(normalizeProviderRuntimeMessage(raw)).toBe(PERSONAL_CODEX_USAGE_LIMIT_MESSAGE);
    expect(localizeProviderRuntimeMessage(raw, "en")).toBe(PERSONAL_CODEX_USAGE_LIMIT_MESSAGE);
    expect(localizeProviderRuntimeMessage(raw, "zh-CN")).toBe(
      "个人 Codex 使用额度已达上限。请在 ChatGPT Codex 用量页购买额度、等待重置，或切换服务商。",
    );
    expect(localizeProviderRuntimeMessage(raw, "zh-CN")).not.toMatch(
      /(?:chatgpt\.com|Aug 28th|11:43 PM)/iu,
    );
  });

  it.each([
    ["Compacting context", "正在压缩上下文"],
    ["Context compacted", "上下文已压缩"],
    ["Context automatically compacting", "正在自动压缩上下文"],
    ["Context automatically compacted", "上下文已自动压缩"],
    ["Optimizing the conversation", "正在优化对话"],
    ["Optimized the conversation", "已优化对话"],
    ["Manual context compaction failed", "手动压缩上下文失败"],
    ["Automatic context compaction failed", "自动压缩上下文失败"],
    ["Provider task stop failed", "停止服务商任务失败"],
    ["Provider task background failed", "将服务商任务转入后台失败"],
    ["No active provider session is bound to this thread.", "此线程未绑定活动的服务商会话。"],
    [
      "No active provider session with workspace cwd is bound to this thread.",
      "此线程未绑定含工作区目录的活动服务商会话。",
    ],
    [
      "The Moss model gateway is rate limiting requests right now. Try again in a moment.",
      "Moss 当前请求较多，请稍后再试。",
    ],
    [
      "Moss model service is temporarily unavailable. Try again shortly.",
      "Moss 模型服务暂时不可用，请稍后再试。",
    ],
    [
      "The provider could not complete this request. Try again shortly.",
      "服务商暂时无法完成此请求，请稍后重试。",
    ],
    ["(empty response)", "没有返回内容"],
    ["The model finished without returning visible text.", "模型已结束，但没有返回可见内容。"],
    [
      "The current Moss account does not have model access. Sign in again; if this continues, contact support.",
      "当前 Moss 账号没有模型使用权限。请重新登录；若仍然出现，请联系支持。",
    ],
    [
      "Moss account quota is exhausted for this period. Top up your plan or wait for the quota to reset.",
      "本周期的 Moss 使用额度已用完，请升级套餐或等待额度重置。",
    ],
  ] as const)("localizes the exact stable provider template %s", (input, expected) => {
    expect(localizeProviderRuntimeMessage(input, "zh-CN")).toBe(expected);
  });

  it.each([
    [
      "The Moss model gateway is rate limiting requests right now. Try again in about 2m.",
      "Moss 当前请求较多，请约 2m 后重试。",
    ],
    [
      "Moss account quota is exhausted for this period. Top up your plan, or try again in about 6d 22h.",
      "本周期的 Moss 使用额度已用完，请升级套餐，或约 6d 22h 后重试。",
    ],
  ] as const)("localizes a managed gateway retry hint: %s", (input, expected) => {
    expect(localizeProviderRuntimeMessage(input, "zh-CN")).toBe(expected);
  });

  it("localizes a persisted raw Codex 429 without exposing its request identifier", () => {
    const raw =
      "exceeded retry limit, last status: 429 Too Many Requests, request id: private-request-id";
    const localized = localizeProviderRuntimeMessage(raw, "zh-CN");

    expect(localized).toBe("Moss 当前请求较多，请稍后再试。");
    expect(localized).not.toContain("private-request-id");
    expect(localizeProviderRuntimeMessage(raw, "en")).toBe(raw);
  });

  it.each([
    [
      (value: string) => `Subagent '${value}' already finished; the message was not delivered.`,
      (value: string) => `子代理 '${value}' 已结束；消息未发送。`,
    ],
    [
      (value: string) => `Failed to stop subagent task '${value}'.`,
      (value: string) => `停止子代理任务 '${value}' 失败。`,
    ],
    [
      (value: string) =>
        `Cannot stop provider task '${value}' because the provider runtime is not active.`,
      (value: string) => `无法停止服务商任务 '${value}'，因为服务商运行时未处于活动状态。`,
    ],
    [
      (value: string) => `Provider '${value}' does not support stopping a provider task.`,
      (value: string) => `服务商 '${value}' 不支持停止服务商任务。`,
    ],
    [
      (value: string) =>
        `Cannot background provider task '${value}' because the provider runtime is not active.`,
      (value: string) => `无法将服务商任务 '${value}' 转入后台，因为服务商运行时未处于活动状态。`,
    ],
    [
      (value: string) => `Provider '${value}' does not support backgrounding a provider task.`,
      (value: string) => `服务商 '${value}' 不支持将服务商任务转入后台。`,
    ],
    [
      (value: string) =>
        `Cannot message subagent '${value}' because the provider runtime is not active.`,
      (value: string) => `无法向子代理 '${value}' 发送消息，因为服务商运行时未处于活动状态。`,
    ],
    [
      (value: string) => `Provider '${value}' does not support messaging a running subagent.`,
      (value: string) => `服务商 '${value}' 不支持向运行中的子代理发送消息。`,
    ],
  ] as const)(
    "localizes a stable dynamic template without changing its value",
    (input, expected) => {
      const dynamicValue = "agent-原始/42:run-7";
      const localized = localizeProviderRuntimeMessage(input(dynamicValue), "zh-CN");

      expect(localized).toBe(expected(dynamicValue));
      expect(localized).toContain(dynamicValue);
    },
  );

  it("tells a Chinese user what to do when ZCode's CLI is missing", () => {
    expect(
      localizeProviderRuntimeMessage(
        "The ZCode CLI could not be started. Install the ZCode desktop app (it bundles the CLI) or set ZCODE_BIN to the zcode CLI path, then retry.",
        "zh-CN",
      ),
    ).toBe(
      "无法启动 ZCode CLI。请安装 ZCode 桌面应用（已内置该 CLI），或把 ZCODE_BIN 设为 zcode CLI 的路径，然后重试。",
    );
  });

  it("tells a Chinese user what to do when Kimi Code has no Git Bash", () => {
    expect(
      localizeProviderRuntimeMessage(
        "Kimi Code needs Git Bash on Windows, and Moss could not find it. Install Git for Windows, or set KIMI_SHELL_PATH to a bash.exe, then retry.",
        "zh-CN",
      ),
    ).toBe(
      "在 Windows 上，Kimi Code 需要 Git Bash，但 Moss 没有找到。请安装 Git for Windows，或把 KIMI_SHELL_PATH 设为 bash.exe 的路径，然后重试。",
    );
  });

  it("translates the rows shown while a provider retries", () => {
    expect(
      localizeProviderRuntimeMessage("Request retry 3/10 in 3s (connection error).", "zh-CN"),
    ).toBe("连接中断，3 秒后重试（第 3/10 次）。");
    expect(localizeProviderRuntimeMessage("Request retry 2/10 in 2s (HTTP 529).", "zh-CN")).toBe(
      "请求失败（HTTP 529），2 秒后重试（第 2/10 次）。",
    );
    expect(
      localizeProviderRuntimeMessage(
        "Pi retrying after provider error (attempt 1/3, retrying in 2.0s): ECONNRESET: The socket connection was closed unexpectedly.",
        "zh-CN",
      ),
    ).toBe("服务商出错，2.0 秒后重试（第 1/3 次）。");
    expect(
      localizeProviderRuntimeMessage(
        "Codex stopped responding (no activity for 900s); the turn was aborted.",
        "zh-CN",
      ),
    ).toBe("Codex 已停止响应（900 秒没有活动），本次对话已中止。");
    expect(localizeProviderRuntimeMessage("OpenCode retrying", "zh-CN")).toBe("OpenCode 正在重试");
    expect(
      localizeProviderRuntimeMessage("Request retry 3/10 in 3s (connection error).", "en"),
    ).toBe("Request retry 3/10 in 3s (connection error).");
  });

  it("returns English and unknown diagnostics byte-for-byte", () => {
    const known = "Provider task stop failed";
    expect(localizeProviderRuntimeMessage(known, "en")).toBe(known);

    const unknown =
      "Provider task stop failed: Error at /Users/moss/Original Project/provider.ts:42\r\n\u0000";
    expect(localizeProviderRuntimeMessage(unknown, "zh-CN")).toBe(unknown);

    const nearMiss = "Subagent 'agent-42' already finished; raw provider detail follows.";
    expect(localizeProviderRuntimeMessage(nearMiss, "zh-CN")).toBe(nearMiss);
  });

  it("explains a Codex config speed tier the model does not offer", () => {
    const raw =
      "Configured service tier `ultrafast` is not advertised as supported for model `gpt-6-astra` and will be omitted from requests.";

    expect(localizeProviderRuntimeMessage(raw, "en")).toBe(
      'gpt-6-astra doesn\'t offer the "ultrafast" speed set in your Codex config, so it runs at standard speed.',
    );
    expect(localizeProviderRuntimeMessage(raw, "zh-CN")).toBe(
      "gpt-6-astra 不支持 Codex 配置里的“ultrafast”速度，本次按标准速度运行。",
    );
    const nearMiss = `${raw} Extra detail.`;
    expect(localizeProviderRuntimeMessage(nearMiss, "zh-CN")).toBe(nearMiss);
    // The row heading above that notice.
    expect(localizeProviderRuntimeMessage("Runtime warning", "zh-CN")).toBe("运行提示");
  });

  it("localizes the anchored task summary while preserving every dynamic label", () => {
    const labels = "编译 /Users/moss/原始.ts, provider:vendor-量子";
    const summary = `2 tasks: ${labels}`;

    expect(localizeProviderRuntimeMessage(summary, "zh-CN")).toBe(`2 个任务：${labels}`);
    expect(localizeProviderRuntimeMessage(summary, "en")).toBe(summary);
  });

  it.each([
    "2 task: alpha",
    "2 tasks:",
    "tasks: alpha",
    "2 tasks: alpha\nprovider detail",
    "prefix 2 tasks: alpha",
  ])("does not rewrite a near-miss task summary: %s", (message) => {
    expect(localizeProviderRuntimeMessage(message, "zh-CN")).toBe(message);
  });
});

describe("why a turn ended, in Chinese", () => {
  it("names the model service, never Claude, and reads old recorded wordings the same way", () => {
    const pairs: ReadonlyArray<readonly [string, string, string]> = [
      [
        "The model service rate limit was reached. Wait briefly, then retry.",
        "Claude rate limit reached. Wait briefly, then retry.",
        "模型服务已达到速率限制，请稍等后重试。",
      ],
      [
        "The model service rejected the request as invalid.",
        "Claude rejected the request as invalid.",
        "模型服务认为这次请求无效，已拒绝。",
      ],
      [
        "The selected model is unavailable for this account.",
        "The selected Claude model is unavailable for this account.",
        "当前账号不能使用所选模型。",
      ],
      [
        "The model reached the maximum output length before completing the turn.",
        "Claude reached the maximum output length before completing the turn.",
        "模型在完成这一轮之前达到了输出长度上限。",
      ],
      [
        "The model service failed to complete the turn.",
        "Claude failed to complete the turn.",
        "模型服务没能完成这一轮。",
      ],
      [
        "The model service could not load its cloud credentials. Check or refresh them, then retry.",
        "Claude could not load its cloud credentials. Check or refresh them, then retry.",
        "模型服务没能加载云端凭据，请检查或刷新后重试。",
      ],
      ["The turn was interrupted.", "Claude runtime interrupted.", "这一轮已中断。"],
      ["The turn failed.", "Claude turn failed.", "这一轮没有完成。"],
      [
        "The agent stopped and will resume on your next message.",
        "Claude runtime stopped and will resume on your next message.",
        "智能体已停止，你发送下一条消息时会继续。",
      ],
    ];
    for (const [current, recorded, zh] of pairs) {
      expect(localizeProviderRuntimeMessage(current, "zh-CN")).toBe(zh);
      expect(localizeProviderRuntimeMessage(recorded, "zh-CN")).toBe(zh);
      expect(localizeProviderRuntimeMessage(current, "en")).toBe(current);
    }
    for (const zh of Object.values(ZH_CN_TURN_FAILURE_MESSAGES)) {
      expect(zh).not.toMatch(/claude/iu);
    }
  });
});
