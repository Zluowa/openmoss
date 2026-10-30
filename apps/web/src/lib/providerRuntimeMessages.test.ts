// FILE: providerRuntimeMessages.test.ts
// Purpose: Prove provider runtime localization is exact and preserves dynamic identifiers.
// Layer: Web unit tests

import { describe, expect, it } from "vitest";

import {
  localizeProviderRuntimeMessage,
  normalizeProviderRuntimeMessage,
  PERSONAL_CODEX_USAGE_LIMIT_MESSAGE,
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
