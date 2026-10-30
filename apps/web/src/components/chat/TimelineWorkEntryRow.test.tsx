// FILE: TimelineWorkEntryRow.test.tsx
// Purpose: Guards historical transcript work rows against raw provider-error disclosure.
// Layer: Web chat presentation tests

import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TimelineWorkEntryRow } from "./TimelineWorkEntryRow";

const localeState = vi.hoisted(() => ({ locale: "zh-CN" as "en" | "zh-CN" }));

vi.mock("~/localization", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/localization")>();
  return {
    ...actual,
    useTranslation: () => ({
      locale: localeState.locale,
      t: (key: Parameters<typeof actual.translateMoss>[1]) =>
        actual.translateMoss(localeState.locale, key),
      format: (
        key: Parameters<typeof actual.formatMossTranslation>[1],
        values: Record<string, string | number>,
      ) => actual.formatMossTranslation(localeState.locale, key, values),
    }),
  };
});

const rawProviderStartTimeout =
  "Provider turn start failed: thread/start timeout after 55000ms. " +
  "threadId=11111111-1111-4111-8111-111111111111 " +
  "sessionId=runtime-session-123 " +
  "token=secret-token " +
  "Bearer sk-live-secret " +
  "/Users/person/private/provider.ts:42:7 " +
  "C:\\Users\\person\\AppData\\Local\\Temp\\provider.ts:44:9\n" +
  "    at start (/Users/person/private/provider.ts:42:7)";

function renderFailedProviderStart(detail: string): string {
  return renderToStaticMarkup(
    <TimelineWorkEntryRow
      workEntry={{
        id: "provider-turn-start-failed",
        createdAt: "2026-08-12T12:00:00.000Z",
        label: "Provider turn start failed",
        detail,
        tone: "error",
        activityKind: "provider.turn.start.failed",
      }}
      chatMetaFontSizePx={12}
      textFontSizePx={13}
      density="compact"
      onImageExpand={() => {}}
      markdownCwd={undefined}
      timestampFormat="24-hour"
    />,
  );
}

describe("TimelineWorkEntryRow historical provider errors", () => {
  it("keeps the tool label beside its connector icon", () => {
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "connector-tool",
          createdAt: "2026-10-24T06:00:00.000Z",
          label: "Get connector profile",
          toolName: "mcp__example_connector__get_profile",
          mcpServer: "example_connector",
          tone: "tool",
          activityKind: "tool.completed",
          toolStatus: "completed",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );
    expect(markup).toContain("data-work-entry-icon");
    expect(markup).toContain("data-work-entry-display-text");
    expect(markup).toContain("Get connector profile");
  });

  it("keeps a persisted personal Codex quota failure actionable after reload", () => {
    const raw =
      "You've hit your usage limit. Visit https://chatgpt.com/codex/settings/usage to purchase more credits or try again at Aug 28th, 2026 11:43 PM.";
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "runtime-error",
          createdAt: "2026-08-22T21:32:17.000Z",
          label: "Provider runtime error",
          detail: raw,
          tone: "error",
          activityKind: "runtime.error",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain(
      "个人 Codex 使用额度已达上限。请在 ChatGPT Codex 用量页购买额度、等待重置，或切换服务商。",
    );
    expect(markup).not.toContain("Provider runtime error");
    expect(markup).not.toMatch(/(?:chatgpt\.com|Aug 28th|11:43 PM)/iu);
  });

  it("replaces a persisted provider-start diagnostic across visible, title, and AX surfaces", () => {
    const markup = renderFailedProviderStart(rawProviderStartTimeout);

    expect(markup).toContain(
      "服务商启动超时，对话没能开始。请重试；如果一直这样，可以在服务商设置里检查，或换一个服务商。",
    );
    expect(markup).not.toMatch(
      /(?:\/Users\/|C:\\Users|threadId|sessionId|token=|Bearer|sk-live-secret|provider\.ts|runtime-session-123)/iu,
    );
  });

  it("keeps a Grok 401 reason on the runtime error row after stripping the URL", () => {
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "runtime-error",
          createdAt: "2026-08-22T21:32:17.000Z",
          label: "Provider runtime error",
          detail:
            "Provider adapter request failed (grok) for session/prompt: Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat Invalid or expired credentials",
          tone: "error",
          activityKind: "runtime.error",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("Unauthorized (401) Invalid or expired credentials");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
    expect(markup).not.toContain("cli-chat-proxy.grok.com");
  });

  it("keeps the first paragraph of a long Grok 401 on the runtime error row", () => {
    const detail = [
      "Provider adapter request failed (grok) for session/prompt: Unauthorized (401) from https://cli-chat-proxy.grok.com/v1/chat Invalid or expired credentials (token rejected).",
      "",
      "Available models: grok-4, grok-4.6, grok-3, grok-3-mini, grok-2, grok-2-vision.",
      "Authentication is temporarily unavailable. There is no need to run /login.",
    ].join("\n");
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "runtime-error-long-401",
          createdAt: "2026-08-22T21:32:17.000Z",
          label: "Provider runtime error",
          detail,
          tone: "error",
          activityKind: "runtime.error",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("Unauthorized (401) Invalid or expired credentials");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
    expect(markup).not.toContain("Available models");
  });

  it("shows grok login on an unsigned-in start failure row", () => {
    const markup = renderFailedProviderStart(
      "Grok is not authenticated for headless ACP. Run `grok login` (or launch `grok`) and retry. Grok advertised only interactive auth methods: browser_login, grok.com.",
    );

    expect(markup).toContain("请运行 grok login");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
    expect(markup).not.toContain("not authenticated for headless ACP");
  });

  it("uses generic safe copy for an unknown provider-start failure", () => {
    const rawUnknownFailure = "Unexpected adapter handoff refusal for account private-account";
    const markup = renderFailedProviderStart(rawUnknownFailure);

    expect(markup).toContain("服务商暂时无法完成此请求，请稍后重试。");
    expect(markup).not.toContain(rawUnknownFailure);
    expect(markup).not.toMatch(/adapter handoff|private-account/iu);
  });

  it("shows the missing Codex working directory instead of the generic provider fallback", () => {
    const markup = renderFailedProviderStart(
      "Project working directory no longer exists: /private/tmp/moved-project. Relocate or reconnect the project in Moss.",
    );

    expect(markup).toContain("工作目录不存在：/private/tmp/moved-project");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
    expect(markup).not.toContain("Provider turn start failed");
  });

  it("maps a Codex runtime error row to the missing working directory", () => {
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "runtime-error",
          createdAt: "2026-08-22T21:32:17.000Z",
          label: "Provider runtime error",
          detail:
            "Project working directory no longer exists: /private/tmp/moved-project. Relocate or reconnect the project in Moss.",
          tone: "error",
          activityKind: "runtime.error",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("工作目录不存在：/private/tmp/moved-project");
    expect(markup).not.toContain("Provider runtime error");
    expect(markup).not.toContain("服务商暂时无法完成此请求");
  });
});

describe("TimelineWorkEntryRow quota activity", () => {
  it("ignores the persisted English summary and uses localized Moss copy", () => {
    const markup = renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={{
          id: "quota-exhausted",
          createdAt: "2026-08-12T12:00:00.000Z",
          label: "Quota exhausted",
          detail: "Quota exhausted",
          tone: "error",
          activityKind: "account.quota-exhausted",
        }}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );

    expect(markup).toContain("本周期用量已用完");
    expect(markup).not.toContain("Quota exhausted");
  });
});

describe("TimelineWorkEntryRow Grok visual and tool-search labels", () => {
  const renderWorkEntry = (
    locale: "en" | "zh-CN",
    workEntry: Parameters<typeof TimelineWorkEntryRow>[0]["workEntry"],
  ) => {
    localeState.locale = locale;
    return renderToStaticMarkup(
      <TimelineWorkEntryRow
        workEntry={workEntry}
        chatMetaFontSizePx={12}
        textFontSizePx={13}
        density="compact"
        onImageExpand={() => {}}
        markdownCwd={undefined}
        timestampFormat="24-hour"
      />,
    );
  };

  it.each([
    ["en", "Search tools: moss html_render"],
    ["zh-CN", "搜索工具：moss html_render"],
  ] as const)("keeps Grok's query intact in %s", (locale, expectedLabel) => {
    const markup = renderWorkEntry(locale, {
      id: `search-tools-${locale}`,
      createdAt: "2026-10-09T04:55:15.687Z",
      label: 'Search tools: "moss html_render"',
      toolTitle: "Search tools:",
      preview: "moss html_render",
      tone: "tool",
      activityKind: "tool.completed",
    });

    expect(markup).toContain(expectedLabel);
    expect(markup).not.toContain("Moss Html Render");
  });

  it("uses a preview document title and hides a missing one instead of a payload filename", () => {
    const titledMarkup = renderWorkEntry("zh-CN", {
      id: "html-preview-titled",
      createdAt: "2026-10-09T05:10:16.622Z",
      label: "moss__html_preview — source file: /tmp/preview-dark.json",
      toolName: "moss__html_preview",
      toolTitle: "Previewed an HTML page",
      preview: "2026 经营看板",
      tone: "tool",
      activityKind: "tool.completed",
    });
    const untitledMarkup = renderWorkEntry("zh-CN", {
      id: "html-preview-untitled",
      createdAt: "2026-10-09T05:10:16.626Z",
      label: "moss__html_preview — source file: /tmp/preview-empty.json",
      toolName: "moss__html_preview",
      toolTitle: "Previewed an HTML page",
      detail: "moss__html_preview — source file: /tmp/preview-empty.json",
      tone: "tool",
      activityKind: "tool.completed",
    });

    expect(titledMarkup).toContain("已预览 HTML 页面 2026 经营看板");
    expect(titledMarkup).not.toContain("preview-dark.json");
    expect(untitledMarkup).toContain("已预览 HTML 页面");
    expect(untitledMarkup).not.toMatch(/(?:preview-empty\.json|moss__html_preview)/u);
  });
});
