import type { ServerProviderStatus } from "@synara/contracts";
import { createElement, type ReactNode } from "react";
import { renderToStaticMarkup as renderMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { MossLocaleScope, translateMoss } from "~/localization";

function renderToStaticMarkup(node: ReactNode): string {
  return renderMarkup(createElement(MossLocaleScope, { locale: "zh-CN", children: node }));
}
import { ProviderHealthBanner, runProviderHealthRecoveryAction } from "./ProviderHealthBanner";

function status(overrides: Partial<ServerProviderStatus> = {}): ServerProviderStatus {
  return {
    provider: "codex",
    instanceId: "codex_moss",
    driver: "codex",
    displayName: "Moss",
    status: "error",
    available: false,
    authStatus: "authenticated",
    checkedAt: "2026-07-13T09:00:00.000Z",
    message:
      "Provider adapter process error (codex): EPERM: operation not permitted, symlink 'C:\\Users\\person\\.moss\\userdata\\moss-codex-home\\archived_sessions'",
    ...overrides,
  };
}

function textContent(markup: string): string {
  return markup
    .replace(/<[^>]+>/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
}

describe("ProviderHealthBanner", () => {
  it("replaces managed Moss internals with short recovery guidance", () => {
    const text = textContent(
      renderToStaticMarkup(createElement(ProviderHealthBanner, { status: status() })),
    );

    expect(text).toContain("Moss 暂时不可用");
    expect(text).toContain("重启 Moss");
    expect(text).not.toMatch(/EPERM|symlink|C:\\Users|moss-codex-home/iu);
  });

  it("keeps a durable managed-provider disablement precise instead of calling it preparation", () => {
    const text = textContent(
      renderToStaticMarkup(
        createElement(ProviderHealthBanner, {
          status: status({
            status: "warning",
            available: false,
            message: "Provider is disabled in Moss settings.",
          }),
        }),
      ),
    );

    expect(text).toContain("此服务商已在 Moss 设置中禁用");
    expect(text).not.toContain("Moss 正在准备");
    expect(text).not.toContain("请稍等片刻后再试");
  });

  it("does not expose stale managed-provider diagnostics when settings say it is disabled", () => {
    const text = textContent(
      renderToStaticMarkup(
        createElement(ProviderHealthBanner, {
          status: status({
            enabled: false,
            unavailableReason: "EPERM while reading /Users/person/.moss/private/provider.json",
            message: "Provider is disabled in Moss settings.",
          }),
        }),
      ),
    );

    expect(text).toContain("此服务商已在 Moss 设置中禁用");
    expect(text).not.toMatch(/EPERM|symlink|C:\\Users|moss-codex-home/iu);
  });

  it("keeps a visible recovery action on durable blocks instead of offering dismiss-only UI", () => {
    const onManageProviders = vi.fn();
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          status: "warning",
          available: false,
          message: "Provider is disabled in Moss settings.",
        }),
        onManageProviders,
        onDismiss: vi.fn(),
      }),
    );
    const text = textContent(markup);

    expect(text).toContain("管理服务商");
    expect(markup).not.toContain("关闭服务商状态提示");
  });

  it("routes the durable recovery action to provider settings", () => {
    const onManageProviders = vi.fn();

    runProviderHealthRecoveryAction(onManageProviders);

    expect(onManageProviders).toHaveBeenCalledOnce();
  });

  it("keeps managed-provider authentication failures distinct from preparation", () => {
    const text = textContent(
      renderToStaticMarkup(
        createElement(ProviderHealthBanner, {
          status: status({
            status: "warning",
            available: false,
            authStatus: "unauthenticated",
            message: "Codex is not authenticated.",
          }),
        }),
      ),
    );

    expect(text).toContain("Moss 尚未登录。请打开服务商设置并登录。");
    expect(text).not.toContain("codex login");
    expect(text).not.toContain("Moss 正在准备");
  });

  it("does not expose managed background startup as a chat-level warning", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          enabled: true,
          status: "warning",
          available: false,
          authStatus: "authenticated",
          checkedAt: new Date().toISOString(),
          message: "Managed runtime is starting in the background.",
        }),
      }),
    );

    expect(markup).toBe("");
  });

  it("does not hide an expired managed startup snapshot without server configuration proof", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          enabled: true,
          status: "warning",
          available: false,
          authStatus: "authenticated",
          checkedAt: "2020-01-01T00:00:00.000Z",
          message: "Managed runtime was starting in the background.",
        }),
      }),
    );

    expect(textContent(markup)).toContain("Moss 暂时不可用");
    expect(textContent(markup)).not.toContain("Moss 正在准备");
  });

  it("hides an expired managed startup snapshot when current server settings prove the instance", () => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          enabled: true,
          status: "warning",
          available: false,
          authStatus: "authenticated",
          checkedAt: "2020-01-01T00:00:00.000Z",
          message: "Managed runtime was starting in the background.",
        }),
        managedInstanceConfigured: true,
      }),
    );

    expect(markup).toBe("");
  });

  it.each([
    ["codex_byok", "codex"],
    ["gemini_work", "gemini"],
  ] as const)(
    "does not hide a user-managed %s warning merely because it is named Moss",
    (instanceId, provider) => {
      const markup = renderToStaticMarkup(
        createElement(ProviderHealthBanner, {
          status: status({
            provider,
            instanceId,
            driver: provider,
            displayName: "Moss",
            enabled: true,
            status: "warning",
            available: false,
            authStatus: "authenticated",
            message: "Local provider status is unresolved.",
          }),
        }),
      );

      expect(textContent(markup)).toContain("Moss 服务商当前部分可用。");
      expect(textContent(markup)).not.toContain("Moss 正在准备");
    },
  );

  it.each([
    {
      provider: "claudeAgent" as const,
      instanceId: "claude_work" as const,
      displayName: "Claude Work",
      message: "Run claude login; stderr points to /Users/person/.claude/auth.json",
    },
    {
      provider: "gemini" as const,
      instanceId: "gemini_work" as const,
      displayName: "Gemini Work",
      message: "Run gemini login; token path /Users/person/.config/gemini/token.json",
    },
    {
      provider: "antigravity" as const,
      instanceId: "antigravity" as const,
      displayName: "Antigravity",
      message: "agy login failed; Bearer agy-secret from C:\\Users\\person\\.agy\\auth.json",
    },
  ])("uses provider-agnostic authentication recovery for $displayName", (fixture) => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          provider: fixture.provider,
          instanceId: fixture.instanceId,
          driver: fixture.provider,
          displayName: fixture.displayName,
          status: "error",
          available: false,
          authStatus: "unauthenticated",
          message: fixture.message,
        }),
      }),
    );
    const safeMessage = `${fixture.displayName} 尚未登录。请打开服务商设置并登录。`;

    expect(textContent(markup)).toContain(safeMessage);
    expect(markup).toContain(`title="${safeMessage}"`);
    expect(markup).not.toContain(fixture.message);
    expect(markup).not.toMatch(
      /codex login|claude login|gemini login|agy login|Bearer|agy-secret|C:\\Users|\/Users\/person|stderr|auth\.json|token\.json/iu,
    );
  });

  it.each([
    {
      name: "Windows path and token",
      provider: "codex" as const,
      instanceId: "codex" as const,
      displayName: "Codex Work",
      message:
        "spawn C:\\Users\\person\\AppData\\Local\\codex.exe EPERM\nstderr: Authorization: Bearer sk-secret-windows",
      unavailableReason: "Read C:\\Users\\person\\.codex\\auth.json for token sk-secret-windows",
    },
    {
      name: "macOS path, token, and stack",
      provider: "gemini" as const,
      instanceId: "gemini_work" as const,
      displayName: "Gemini Work",
      message:
        "EACCES: open '/Users/alice/.config/gemini/token.json'\n    at loadToken (/Users/alice/app/provider.js:42:7)",
      unavailableReason: "CLI stderr contained GEMINI_API_KEY=secret-macos",
    },
  ])("redacts non-Moss $name diagnostics from body and title", (fixture) => {
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          provider: fixture.provider,
          instanceId: fixture.instanceId,
          driver: fixture.provider,
          displayName: fixture.displayName,
          message: fixture.message,
          unavailableReason: fixture.unavailableReason,
        }),
      }),
    );
    const safeMessage = `${fixture.displayName} 服务商当前不可用。`;

    expect(textContent(markup)).toContain(safeMessage);
    expect(markup).toContain(`title="${safeMessage}"`);
    expect(markup).not.toContain(fixture.message);
    expect(markup).not.toContain(fixture.unavailableReason);
    expect(markup).not.toMatch(
      /EPERM|EACCES|Bearer|sk-secret|GEMINI_API_KEY|C:\\Users|\/Users\/alice|stderr|provider\.js|auth\.json|token\.json/iu,
    );
  });

  it("does not retain a recognized Antigravity first line or its raw diagnostic suffix", () => {
    const message =
      "Provider adapter request failed (antigravity) for models: Plugin install failed.\n    at run (C:\\Users\\person\\agy\\adapter.js:9:2)\nAuthorization: Bearer agy-secret-token";
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          provider: "antigravity",
          instanceId: "antigravity",
          driver: "antigravity",
          displayName: "Antigravity",
          message,
          unavailableReason: "CLI stderr: /Users/person/.config/agy/credentials.json",
        }),
      }),
    );

    expect(textContent(markup)).toContain("Antigravity 服务商当前不可用。");
    expect(markup).not.toContain(message);
    expect(markup).not.toMatch(
      /Provider adapter request failed|Plugin install failed|adapter\.js|Bearer|agy-secret-token|credentials\.json|C:\\Users|\/Users\/person/iu,
    );
  });

  it("uses safe typed copy for a transient non-Moss check instead of runtime details", () => {
    const message =
      "Antigravity helper timed out after 5000ms: stderr at /Users/person/.config/agy/token.json";
    const markup = renderToStaticMarkup(
      createElement(ProviderHealthBanner, {
        status: status({
          provider: "antigravity",
          instanceId: "antigravity",
          driver: "antigravity",
          displayName: "Antigravity",
          status: "warning",
          available: false,
          authStatus: "unknown",
          message,
          unavailableReason: undefined,
        }),
      }),
    );

    expect(textContent(markup)).toContain("Antigravity 服务商当前部分可用。");
    expect(markup).not.toContain(message);
    expect(markup).not.toMatch(/helper timed out|stderr|\/Users\/person|token\.json/iu);
  });

  it("provides concise Chinese Moss copy", () => {
    expect(translateMoss("zh-CN", "provider.health.moss.errorTitle")).toBe("Moss 暂时不可用");
    expect(translateMoss("zh-CN", "provider.health.moss.errorDescription")).toBe(
      "请稍后重试；如果仍无法使用，请重启 Moss。",
    );
  });
});
