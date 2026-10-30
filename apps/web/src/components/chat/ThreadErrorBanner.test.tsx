// FILE: ThreadErrorBanner.test.tsx
// Purpose: Verifies Moss runtime localization and provider-quarantine recovery.
// Layer: Web chat component tests

import { formatProviderDeliveryBlockDetail } from "@synara/shared/providerDeliveryBlock";
import type { ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup, renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";

import { MossLocaleScope } from "~/localization";
import { ThreadErrorBanner } from "./ThreadErrorBanner";

function renderZh(node: ReactNode): string {
  return renderMarkup(<MossLocaleScope locale="zh-CN">{node}</MossLocaleScope>);
}

const blockedError = formatProviderDeliveryBlockDetail(
  "External provider command claim expired without a durable acceptance result; execution was not replayed.",
);

describe("ThreadErrorBanner", () => {
  it("localizes a known provider runtime error for the default Chinese locale", () => {
    const markup = renderZh(<ThreadErrorBanner error="Provider task background failed" />);

    expect(markup).toContain("将服务商任务转入后台失败");
    expect(markup).not.toContain("Provider task background failed");
  });

  it("offers Retry, in plain Chinese, when the provider never started", () => {
    const markup = renderZh(
      <ThreadErrorBanner
        error="Provider adapter process error (codex) for thread thread-1: Timed out waiting for thread/start."
        onRetry={() => undefined}
        onDismiss={() => undefined}
      />,
    );

    expect(markup).toContain("服务商启动超时，对话没能开始。");
    expect(markup).toContain("重试");
    expect(markup).toContain("复制错误信息");
    expect(markup).toContain("关闭错误提示");
    expect(markup).not.toContain("Timed out waiting");
    expect(markup).not.toContain("Copy error");
  });

  it("does not offer Retry for a failure the provider already received", () => {
    const markup = renderZh(
      <ThreadErrorBanner error="Provider task background failed" onRetry={() => undefined} />,
    );

    expect(markup).not.toContain("重试");
  });

  it("replaces an unknown provider diagnostic with safe localized copy", () => {
    const diagnostic = "Provider task background failed: /tmp/original-provider.log:42";
    const markup = renderZh(<ThreadErrorBanner error={diagnostic} />);

    expect(markup).toContain("服务商暂时无法完成此请求，请稍后重试。");
    expect(markup).not.toContain(diagnostic);
    expect(markup).not.toContain("/tmp/original-provider.log");
  });

  it("shows the Grok 401 first paragraph from the Task interrupted prefixed card string", () => {
    const prefix = "The task was interrupted by a provider error. Work remains incomplete. ";
    const grok401 = [
      "Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat/completions Invalid or expired credentials (token rejected: the supplied XAI_API_KEY was not accepted by the upstream proxy for this session).",
      "",
      "Available models: grok-4, grok-4.6, grok-3, grok-3-mini, grok-2, grok-2-vision, grok-2-mini, grok-code-fast-1.",
      "Authentication is temporarily unavailable for this request. There is no need to run /login;",
      "the cached session is still present but the supplied API key was rejected by the proxy.",
      "Retry after rotating the key. Diagnostic dump: request-id=req_grok_401_banner_fixture",
      'payload: {"models":["grok-4","grok-4.6","grok-3","grok-3-mini","grok-2","grok-2-vision","grok-code-fast-1"]}',
      "See also https://cli-chat-proxy.grok.com/docs/auth for the full authentication guide and account recovery steps.",
    ].join("\n");
    const cardError = `${prefix}${grok401}`;
    expect(cardError.length).toBeGreaterThanOrEqual(651);

    const markup = renderZh(<ThreadErrorBanner title="Task interrupted" error={cardError} />);

    expect(markup).toContain("Unauthorized (401) Invalid or expired credentials");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
    expect(markup).not.toContain("The task was interrupted");
    expect(markup).not.toContain("cli-chat-proxy.grok.com");
  });

  it("shows a managed gateway rate limit in Chinese without raw transport details", () => {
    const raw =
      "The Moss model gateway is rate limiting requests right now. Try again in a moment.";
    const markup = renderZh(<ThreadErrorBanner error={raw} />);

    expect(markup).toContain("Moss 当前请求较多，请稍后再试。");
    expect(markup).not.toContain("rate limiting requests");
    expect(markup).not.toContain("request id");
  });

  it("sanitizes a persisted raw Codex 429 from an older build", () => {
    const raw =
      "exceeded retry limit, last status: 429 Too Many Requests, request id: private-request-id";
    const markup = renderZh(<ThreadErrorBanner error={raw} />);

    expect(markup).toContain("Moss 当前请求较多，请稍后再试。");
    expect(markup).not.toContain("Too Many Requests");
    expect(markup).not.toContain("private-request-id");
  });

  it("offers the unblock action for a provider-delivery quarantine", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={blockedError} onDismiss={() => {}} onUnblock={() => {}} />,
    );

    expect(markup).toContain("Unblock thread");
    expect(markup).toContain("Dismiss error");
    expect(markup).not.toContain("durable acceptance result");
  });

  it("disables the action while unblocking", () => {
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={blockedError} onUnblock={() => {}} unblocking />,
    );

    expect(markup).toContain("Unblocking");
    expect(markup).toContain("disabled");
  });

  it("hides the action for unrelated thread errors", () => {
    const actionable = "The provider rejected the prompt.";
    const markup = renderToStaticMarkup(
      <ThreadErrorBanner error={actionable} onDismiss={() => {}} onUnblock={() => {}} />,
    );

    expect(markup).toContain(actionable);
    expect(markup).not.toContain("Unblock thread");
  });

  it("renders nothing without an error", () => {
    expect(renderToStaticMarkup(<ThreadErrorBanner error={null} onUnblock={() => {}} />)).toBe("");
  });
});
