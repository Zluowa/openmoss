// FILE: ComputerHistoryUnavailableLines.browser.tsx
// Purpose: What a person reads on 设置 → 电脑历史 where Computer History cannot run (Linux, WALK-12
//          N12-3 / #914): Chinese only, and the card's explaining line is not repeated.
// Layer: Browser UI test

import "../../index.css";

import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

const harness = vi.hoisted(() => ({
  api: {
    shell: { openExternal: vi.fn() },
    computerHistory: {
      getState: vi.fn(),
      getSettings: vi.fn(),
      listApplications: vi.fn(async () => []),
      listHistory: vi.fn(async () => ({ entries: [] })),
      listHistorySuggestions: vi.fn(async () => []),
      listHistorySummaryIntervals: vi.fn(async () => []),
    },
  },
}));

vi.mock("~/nativeApi", () => ({
  ensureNativeApi: () => harness.api,
  readNativeApi: () => harness.api,
}));
vi.mock("~/hooks/useHandleNewChat", () => ({
  useHandleNewChat: () => ({ handleNewChat: vi.fn() }),
}));
vi.mock("~/composerDraftStore", () => ({
  useComposerDraftStore: { getState: () => ({ setPrompt: vi.fn(), setMentions: vi.fn() }) },
}));

import { MossLocaleScope } from "~/localization";
import { ComputerHistorySettingsPanel } from "./ComputerHistorySettingsPanel";

describe("设置 → 电脑历史 where it cannot run", () => {
  it("reads in Chinese, with the server's English message never shown", async () => {
    harness.api.computerHistory.getSettings.mockResolvedValue({
      consentAt: null,
      observation: {
        defaultApplicationBehavior: "allow",
        defaultURLBehavior: "allow",
        allowlist: [],
        blocklist: [],
        urlAllowlist: [],
        urlBlocklist: [],
      },
    });
    harness.api.computerHistory.getState.mockResolvedValue({
      supported: false,
      enabled: false,
      recorderState: "stopped",
      activationState: "idle",
      inputMonitoringPermission: "unknown",
      accessibilityPermission: "unknown",
      screenRecordingPermission: "unknown",
      privateBrowsingExcluded: true,
      browserCapabilities: [],
      captureCapability: {
        mode: "window_metadata_only",
        interactionEvents: false,
        activitySummaries: false,
        detail: "Window metadata only.",
      },
      settings: {
        consentAt: null,
        observation: {
          defaultApplicationBehavior: "allow",
          defaultURLBehavior: "allow",
          allowlist: [],
          blocklist: [],
          urlAllowlist: [],
          urlBlocklist: [],
        },
      },
      health: {
        droppedEvents: 0,
        queueDepth: 0,
        storageBytes: 0,
        lastError: null,
        corruptionDetected: false,
        keychainState: "unknown",
      },
      message: "Computer History requires a supported Windows or macOS desktop helper.",
    });
    await render(
      <MossLocaleScope locale="zh-CN">
        <ComputerHistorySettingsPanel />
      </MossLocaleScope>,
    );
    await vi.waitFor(() =>
      expect(document.querySelector('[data-testid="computer-history-off-state"]')).not.toBeNull(),
    );
    const lines = document.body.innerText
      .split("\n")
      .map((line) => line.trim())
      .filter(Boolean);
    expect(lines).toEqual([
      "电脑历史需要 Windows 或 macOS 桌面助手。",
      "让 Moss 了解你的工作",
      "开启",
      "开启后，Moss 会保存你允许的应用和网站活动文本摘要，其中可能包含通信内容。不会包含屏幕截图、音频或无痕浏览，且你可以随时暂停、清除历史并管理记录范围。此功能会增加 token 使用量。",
    ]);
  });
});
