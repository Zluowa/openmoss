import type { ServerProviderStatus } from "@synara/contracts";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import {
  ChatComposerSendButton,
  isChatComposerSubmitReady,
  runChatProviderSendPreflight,
} from "./ChatProviderSendControl";
import { localizeProviderSendBlockedReason } from "~/lib/providerUnavailablePresentation";

const DISABLED_MOSS_STATUS: ServerProviderStatus = {
  provider: "codex",
  instanceId: "codex_moss",
  driver: "codex",
  displayName: "Moss",
  status: "warning",
  available: false,
  authStatus: "unknown",
  checkedAt: "2026-08-12T06:00:00.000Z",
  message: "Provider is disabled in Moss settings.",
};

describe("ChatComposerSendButton", () => {
  it.each([
    ["en", "Resume"],
    ["zh-CN", "继续运行"],
  ] as const)(
    "renders the localized Resume control with the shared play action: %s",
    (locale, label) => {
      const markup = renderToStaticMarkup(
        createElement(ChatComposerSendButton, {
          locale,
          provider: "codex",
          status: null,
          admission: { state: "ready", unavailableReason: null },
          visibleSendState: "empty",
          hasSendableContent: false,
          isSendBusy: false,
          isConnecting: false,
          isSendPreflightInFlight: false,
          isProjectPending: false,
          isVoiceTranscribing: false,
          isModelLoading: false,
          isPreparingImages: false,
          isPreparingWorktree: false,
          showResume: true,
        }),
      );

      expect(markup).toContain('type="button"');
      expect(markup).toContain(`aria-label="${label}"`);
      expect(markup).toContain(`title="${label}"`);
      expect(markup).toContain('data-moss-visible-resume-control="true"');
      expect(markup).toContain('data-moss-visible-resume-state="ready"');
      expect(markup).not.toContain("animate-spin");
    },
  );

  it("keeps the Resume label while pending and disables on provider/interactions unavailable", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatComposerSendButton, {
        locale: "en",
        provider: "codex",
        status: DISABLED_MOSS_STATUS,
        admission: { state: "blocked", unavailableReason: "blocked" },
        visibleSendState: "unavailable",
        hasSendableContent: false,
        isSendBusy: false,
        isConnecting: false,
        isSendPreflightInFlight: false,
        isProjectPending: false,
        isVoiceTranscribing: false,
        isModelLoading: false,
        isPreparingImages: false,
        isPreparingWorktree: false,
        showResume: false,
        isResumePending: true,
      }),
    );

    expect(markup).toContain('type="button"');
    expect(markup).toContain('aria-label="Resume"');
    expect(markup).toContain('title="Resume"');
    expect(markup).toContain('data-moss-visible-resume-state="pending"');
    expect(markup).toContain("disabled");
    expect(markup).toContain("animate-spin");
  });

  it.each(["preflight", "blocked"] as const)(
    "keeps Resume fail-closed for a non-ready provider admission: %s",
    (state) => {
      const markup = renderToStaticMarkup(
        createElement(ChatComposerSendButton, {
          locale: "en",
          provider: "codex",
          status: null,
          admission: { state, unavailableReason: null },
          visibleSendState: state,
          hasSendableContent: false,
          isSendBusy: false,
          isConnecting: false,
          isSendPreflightInFlight: false,
          isProjectPending: false,
          isVoiceTranscribing: false,
          isModelLoading: false,
          isPreparingImages: false,
          isPreparingWorktree: false,
          showResume: true,
          onResume: vi.fn(),
        }),
      );

      expect(markup).toContain('data-moss-visible-resume-control="true"');
      expect(markup).toContain("disabled");
    },
  );

  it("keeps a pending Resume mounted but disabled while an interaction owns the composer", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatComposerSendButton, {
        locale: "en",
        provider: "codex",
        status: null,
        admission: { state: "ready", unavailableReason: null },
        visibleSendState: "empty",
        hasSendableContent: false,
        isSendBusy: false,
        isConnecting: false,
        isSendPreflightInFlight: false,
        isProjectPending: false,
        isVoiceTranscribing: false,
        isModelLoading: false,
        isPreparingImages: false,
        isPreparingWorktree: false,
        isResumePending: true,
        isInteractionUnavailable: true,
      }),
    );

    expect(markup).toContain('data-moss-visible-resume-control="true"');
    expect(markup).toContain('data-moss-visible-resume-state="pending"');
    expect(markup).toContain('aria-label="Resume"');
    expect(markup).toContain("disabled");
  });

  it("renders the actual composer submit control as unavailable for a durable provider block", () => {
    const markup = renderToStaticMarkup(
      createElement(ChatComposerSendButton, {
        locale: "zh-CN",
        provider: "codex",
        status: DISABLED_MOSS_STATUS,
        admission: {
          state: "blocked",
          unavailableReason: "Provider is disabled in Moss settings.",
        },
        visibleSendState: "unavailable",
        hasSendableContent: true,
        isSendBusy: false,
        isConnecting: true,
        isSendPreflightInFlight: false,
        isProjectPending: false,
        isVoiceTranscribing: false,
        isModelLoading: false,
        isPreparingImages: false,
        isPreparingWorktree: false,
      }),
    );

    expect(markup).toContain('type="submit"');
    expect(markup).toContain("disabled");
    expect(markup).toContain('aria-label="此服务商已在 Moss 设置中禁用。"');
    expect(markup).toContain('data-moss-visible-send-state="unavailable"');
    expect(markup).toContain('title="此服务商已在 Moss 设置中禁用。"');
    expect(markup).not.toContain("animate-spin");
  });

  it.each([
    {
      name: "authentication",
      status: {
        ...DISABLED_MOSS_STATUS,
        displayName: "Claude Work",
        provider: "claudeAgent" as const,
        instanceId: "claude_work" as const,
        driver: "claudeAgent" as const,
        status: "error" as const,
        authStatus: "unauthenticated" as const,
        message: "Claude Work is not authenticated.",
      },
      provider: "claudeAgent" as const,
      reason: "Claude Work is not authenticated yet.",
      expected: "Claude Work 尚未登录。请打开服务商设置并登录。",
    },
    {
      name: "managed runtime failure",
      status: {
        ...DISABLED_MOSS_STATUS,
        enabled: true,
        status: "error" as const,
        authStatus: "authenticated" as const,
        message: "EPERM: symlink C:\\Users\\person\\.moss\\private",
        unavailableReason: "/Users/person/.moss/private/provider.json",
      },
      provider: "codex" as const,
      reason: "Moss is temporarily unavailable.",
      expected: "Moss 当前不可用。",
    },
  ])("localizes $name in the actual blocked send control", (input) => {
    const markup = renderToStaticMarkup(
      createElement(ChatComposerSendButton, {
        locale: "zh-CN",
        provider: input.provider,
        status: input.status,
        admission: { state: "blocked", unavailableReason: input.reason },
        visibleSendState: "unavailable",
        hasSendableContent: true,
        isSendBusy: false,
        isConnecting: false,
        isSendPreflightInFlight: false,
        isProjectPending: false,
        isVoiceTranscribing: false,
        isModelLoading: false,
        isPreparingImages: false,
        isPreparingWorktree: false,
      }),
    );

    expect(markup).toContain(`aria-label="${input.expected}"`);
    expect(markup).toContain(`title="${input.expected}"`);
    expect(markup).not.toMatch(/EPERM|symlink|C:\\Users|\/Users\/person|provider\.json/iu);
  });

  it.each([
    {
      state: { isConnecting: true },
      en: "Connecting",
      zh: "正在连接",
    },
    {
      state: { isVoiceTranscribing: true },
      en: "Transcribing voice note",
      zh: "正在转写语音消息",
    },
    {
      state: { isModelLoading: true },
      en: "Loading models",
      zh: "正在加载模型",
    },
    {
      state: { isPreparingImages: true },
      en: "Optimizing image",
      zh: "正在优化图片",
    },
    {
      state: { isPreparingWorktree: true },
      en: "Preparing worktree",
      zh: "正在准备工作树",
    },
    {
      state: { isSendBusy: true },
      en: "Sending",
      zh: "正在发送",
    },
    {
      state: {},
      en: "Send message",
      zh: "发送消息",
    },
  ])("localizes the actual send control aria label: $en", ({ state, en, zh }) => {
    const render = (locale: "en" | "zh-CN") =>
      renderToStaticMarkup(
        createElement(ChatComposerSendButton, {
          locale,
          provider: "codex",
          status: null,
          admission: { state: "ready", unavailableReason: null },
          visibleSendState: "ready",
          hasSendableContent: true,
          isSendBusy: false,
          isConnecting: false,
          isSendPreflightInFlight: false,
          isProjectPending: false,
          isVoiceTranscribing: false,
          isModelLoading: false,
          isPreparingImages: false,
          isPreparingWorktree: false,
          ...state,
        }),
      );

    expect(render("en")).toContain(`aria-label="${en}"`);
    expect(render("zh-CN")).toContain(`aria-label="${zh}"`);
  });

  it.each([
    ["en", "Preparing worktree"],
    ["zh-CN", "正在准备工作树"],
  ] as const)(
    "renders preparing-worktree as a disabled spinner with typed %s aria and title",
    (locale, expected) => {
      const markup = renderToStaticMarkup(
        createElement(ChatComposerSendButton, {
          locale,
          provider: "codex",
          status: null,
          admission: { state: "ready", unavailableReason: null },
          visibleSendState: "preparing-worktree",
          hasSendableContent: true,
          isSendBusy: false,
          isConnecting: false,
          isSendPreflightInFlight: false,
          isProjectPending: false,
          isVoiceTranscribing: false,
          isModelLoading: false,
          isPreparingImages: false,
          isPreparingWorktree: true,
        }),
      );

      expect(markup).toContain('disabled=""');
      expect(markup).toContain("animate-spin");
      expect(markup).toContain(`aria-label="${expected}"`);
      expect(markup).toContain(`title="${expected}"`);
      expect(markup).toContain('data-moss-visible-send-state="preparing-worktree"');
    },
  );
});

describe("isChatComposerSubmitReady", () => {
  it("fails closed while a worktree is preparing", () => {
    expect(isChatComposerSubmitReady({ isPreparingWorktree: true })).toBe(false);
  });

  it("admits the existing send pipeline after setup clears", () => {
    expect(isChatComposerSubmitReady({ isPreparingWorktree: false })).toBe(true);
  });
});

describe("ChatView worktree submit admission", () => {
  it("prevents native submits before dedupe and admits before provider/create/turn side effects", () => {
    // The send pipeline lives in useChatTurnSubmission (ChatView mounts it):
    // onSend wraps performComposerSend, and side effects (worktree creation,
    // thread promotion, turn dispatch) run inside executePreparedTurn.
    const source = readFileSync(new URL("./useChatTurnSubmission.ts", import.meta.url), "utf8");
    const performSendStart = source.indexOf("  const performComposerSend = useCallback(");
    const onSendStart = source.indexOf("  const onSend = useCallback(");
    const performSendSource = source.slice(performSendStart, onSendStart);
    const onSendEnd = source.indexOf("\n  return { onSend };", onSendStart);
    const onSendSource = source.slice(onSendStart, onSendEnd);
    const preventDefaultIndex = onSendSource.indexOf("e?.preventDefault();");
    const dedupeGateIndex = onSendSource.indexOf("const gate = composerSendGateRef.current;");
    const performSendCallIndex = onSendSource.indexOf("return performComposerSend(");
    const admissionIndex = performSendSource.indexOf(
      "if (!isChatComposerSubmitReady({ isPreparingWorktree }))",
    );
    const providerPreflightIndex = performSendSource.indexOf("runChatProviderSendPreflight({");
    const mossQuotaAdmissionIndex = performSendSource.indexOf("fetchFreshMossQuotaAdmission({");
    const turnExecutionIndex = performSendSource.indexOf("executePreparedTurn({");

    expect(performSendStart).toBeGreaterThanOrEqual(0);
    expect(onSendStart).toBeGreaterThan(performSendStart);
    expect(onSendEnd).toBeGreaterThan(onSendStart);
    expect(preventDefaultIndex).toBeGreaterThanOrEqual(0);
    expect(dedupeGateIndex).toBeGreaterThan(preventDefaultIndex);
    expect(performSendCallIndex).toBeGreaterThan(dedupeGateIndex);
    expect(admissionIndex).toBeGreaterThanOrEqual(0);
    expect(performSendSource.slice(admissionIndex, providerPreflightIndex)).toContain(
      "return false;",
    );
    expect(mossQuotaAdmissionIndex).toBeGreaterThan(providerPreflightIndex);
    expect(turnExecutionIndex).toBeGreaterThan(mossQuotaAdmissionIndex);
    for (const sideEffectIndex of [
      providerPreflightIndex,
      mossQuotaAdmissionIndex,
      turnExecutionIndex,
    ]) {
      expect(sideEffectIndex).toBeGreaterThan(admissionIndex);
    }
    expect(performSendSource).not.toContain("runAdmittedSend");
  });
});

describe("runChatProviderSendPreflight", () => {
  it("blocks the actual submit path without refresh or dispatch side effects", async () => {
    const refreshStatuses = vi.fn(async () => []);
    const onPreflightStart = vi.fn();
    const onPreflightEnd = vi.fn();
    const onBlocked = vi.fn();
    const dispatchTurn = vi.fn();

    const result = await runChatProviderSendPreflight({
      provider: "codex",
      instanceId: "codex_moss",
      statuses: [DISABLED_MOSS_STATUS],
      refreshStatuses,
      onPreflightStart,
      onPreflightEnd,
      onBlocked,
    });
    if (result.usable) {
      dispatchTurn();
    }

    expect(result).toMatchObject({
      usable: false,
      unavailableReason: "Provider is disabled in Moss settings.",
    });
    expect(onBlocked).toHaveBeenCalledExactlyOnceWith(result);
    expect(refreshStatuses).not.toHaveBeenCalled();
    expect(onPreflightStart).not.toHaveBeenCalled();
    expect(onPreflightEnd).not.toHaveBeenCalled();
    expect(dispatchTurn).not.toHaveBeenCalled();
  });

  it("starts a managed turn on demand without a warming preflight", async () => {
    const refreshStatuses = vi.fn(async () => []);
    const onPreflightStart = vi.fn();
    const onPreflightEnd = vi.fn();
    const onBlocked = vi.fn();
    const managedWarmingStatus: ServerProviderStatus = {
      ...DISABLED_MOSS_STATUS,
      enabled: true,
      status: "warning",
      available: false,
      authStatus: "authenticated",
      message: "Managed runtime is starting in the background.",
    };

    await expect(
      runChatProviderSendPreflight({
        provider: "codex",
        instanceId: "codex_moss",
        statuses: [managedWarmingStatus],
        managedInstanceConfigured: true,
        refreshStatuses,
        onPreflightStart,
        onPreflightEnd,
        onBlocked,
      }),
    ).resolves.toMatchObject({ usable: true, status: managedWarmingStatus });
    expect(refreshStatuses).not.toHaveBeenCalled();
    expect(onPreflightStart).not.toHaveBeenCalled();
    expect(onPreflightEnd).not.toHaveBeenCalled();
    expect(onBlocked).not.toHaveBeenCalled();
  });

  it("ends a transient submit preflight at its deadline with actionable feedback", async () => {
    vi.useFakeTimers();
    try {
      const refreshStatuses = vi.fn(
        () => new Promise<readonly ServerProviderStatus[] | null | undefined>(() => undefined),
      );
      const onPreflightStart = vi.fn();
      const onPreflightEnd = vi.fn();
      const onBlocked = vi.fn();
      const resultPromise = runChatProviderSendPreflight({
        provider: "codex",
        instanceId: "codex",
        statuses: [],
        refreshStatuses,
        refreshTimeoutMs: 25,
        onPreflightStart,
        onPreflightEnd,
        onBlocked,
      });

      await vi.advanceTimersByTimeAsync(25);

      await expect(resultPromise).resolves.toMatchObject({
        usable: false,
        unavailableReason:
          "Provider status check timed out. Choose another available provider or try again.",
      });
      expect(refreshStatuses).toHaveBeenCalledOnce();
      expect(onPreflightStart).toHaveBeenCalledOnce();
      expect(onPreflightEnd).toHaveBeenCalledOnce();
      expect(onBlocked).toHaveBeenCalledExactlyOnceWith(await resultPromise);
    } finally {
      vi.useRealTimers();
    }
  });

  it("redacts managed runtime diagnostics and localizes the ChatView blocked toast", async () => {
    const rawDiagnostic =
      "EPERM: operation not permitted, symlink 'C:\\Users\\person\\.moss\\userdata\\moss-codex-home'";
    const managedError: ServerProviderStatus = {
      ...DISABLED_MOSS_STATUS,
      enabled: true,
      status: "error",
      authStatus: "authenticated",
      message: rawDiagnostic,
      unavailableReason: "/Users/person/.moss/private/provider.json",
    };
    const toastAdd = vi.fn();

    const result = await runChatProviderSendPreflight({
      provider: "codex",
      instanceId: "codex_moss",
      statuses: [managedError],
      refreshStatuses: vi.fn(async () => []),
      onPreflightStart: vi.fn(),
      onPreflightEnd: vi.fn(),
      onBlocked: (blockedAvailability) => {
        toastAdd({
          type: "error",
          title: localizeProviderSendBlockedReason("zh-CN", blockedAvailability),
        });
      },
    });

    expect(result.unavailableReason).toBe("Moss is temporarily unavailable.");
    expect(result.unavailableReason).not.toMatch(
      /EPERM|symlink|C:\\Users|\/Users\/person|provider\.json|moss-codex-home/iu,
    );
    expect(toastAdd).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: "Moss 当前不可用。",
    });
    expect(JSON.stringify(toastAdd.mock.calls)).not.toMatch(
      /EPERM|symlink|C:\\\\Users|\/Users\/person|provider\.json|moss-codex-home/iu,
    );
  });

  it.each([
    {
      name: "unknown non-Moss diagnostics",
      provider: "gemini" as const,
      instanceId: "gemini_work" as const,
      displayName: "Gemini Work",
      message:
        "EACCES /Users/alice/.config/gemini/token.json\n    at load (/Users/alice/provider.js:2:1)",
      unavailableReason: "stderr: GEMINI_API_KEY=secret-macos",
      expected: "Gemini Work 当前不可用。",
    },
    {
      name: "recognized Antigravity line with suffix",
      provider: "antigravity" as const,
      instanceId: "antigravity" as const,
      displayName: "Antigravity",
      message:
        "Provider adapter request failed (antigravity) for models: Plugin install failed.\n    at run (C:\\Users\\person\\agy\\adapter.js:9:2)\nBearer agy-secret-token",
      unavailableReason: "C:\\Users\\person\\.agy\\credentials.json",
      expected: "Antigravity 当前不可用。",
    },
  ])("keeps the actual blocked toast safe for $name", async (fixture) => {
    const unsafeStatus: ServerProviderStatus = {
      provider: fixture.provider,
      instanceId: fixture.instanceId,
      driver: fixture.provider,
      displayName: fixture.displayName,
      status: "error",
      available: false,
      availability: "unavailable",
      authStatus: "authenticated",
      checkedAt: "2026-08-12T06:00:00.000Z",
      message: fixture.message,
      unavailableReason: fixture.unavailableReason,
    };
    const toastAdd = vi.fn();

    const result = await runChatProviderSendPreflight({
      provider: fixture.provider,
      instanceId: fixture.instanceId,
      statuses: [unsafeStatus],
      refreshStatuses: vi.fn(async () => []),
      onPreflightStart: vi.fn(),
      onPreflightEnd: vi.fn(),
      onBlocked: (blockedAvailability) => {
        toastAdd({
          type: "error",
          title: localizeProviderSendBlockedReason("zh-CN", blockedAvailability),
        });
      },
    });

    expect(result.unavailableReason).toBe(`${fixture.displayName} is unavailable right now.`);
    expect(toastAdd).toHaveBeenCalledExactlyOnceWith({
      type: "error",
      title: fixture.expected,
    });
    expect(JSON.stringify(toastAdd.mock.calls)).not.toMatch(
      /EACCES|GEMINI_API_KEY|provider\.js|Plugin install failed|adapter\.js|Bearer|agy-secret-token|credentials\.json|C:\\\\Users|\/Users\/alice/iu,
    );
  });

  it("preserves provider proper names in localized authentication guidance", () => {
    const unauthenticated: ServerProviderStatus = {
      ...DISABLED_MOSS_STATUS,
      provider: "claudeAgent",
      instanceId: "claude_work",
      driver: "claudeAgent",
      displayName: "Claude Work",
      enabled: true,
      status: "error",
      authStatus: "unauthenticated",
      message: "Claude Work is not authenticated.",
    };

    expect(
      localizeProviderSendBlockedReason("zh-CN", {
        provider: "claudeAgent",
        status: unauthenticated,
        unavailableReason: "Claude Work is not authenticated yet.",
      }),
    ).toBe("Claude Work 尚未登录。请打开服务商设置并登录。");
  });
});
