// FILE: ComputerHistoryUnavailableLines.browser.tsx
// Purpose: What a person reads on 设置 → 电脑历史 before turning it on: Chinese only, and one
//          explaining paragraph under the card, on Linux (WALK-12 N12-3 / #914) and on Windows
//          (WALK-13 #953: the Windows paragraph above the card repeated the one under it).
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

const SETTINGS = {
  consentAt: null,
  observation: {
    defaultApplicationBehavior: "allow",
    defaultURLBehavior: "allow",
    allowlist: [],
    blocklist: [],
    urlAllowlist: [],
    urlBlocklist: [],
  },
};

function offState(options: {
  supported: boolean;
  captureCapability: {
    mode: string;
    interactionEvents: boolean;
    activitySummaries: boolean;
    detail: string;
  };
  message?: string;
}) {
  return {
    supported: options.supported,
    enabled: false,
    recorderState: "stopped",
    activationState: "idle",
    inputMonitoringPermission: "unknown",
    accessibilityPermission: "unknown",
    screenRecordingPermission: "unknown",
    privateBrowsingExcluded: true,
    browserCapabilities: [],
    captureCapability: options.captureCapability,
    settings: SETTINGS,
    health: {
      droppedEvents: 0,
      queueDepth: 0,
      storageBytes: 0,
      lastError: null,
      corruptionDetected: false,
      keychainState: "unknown",
    },
    ...(options.message ? { message: options.message } : {}),
  };
}

/** The panel's visible lines, top to bottom, as a person reads them. */
async function renderOffLines(state: ReturnType<typeof offState>): Promise<string[]> {
  harness.api.computerHistory.getSettings.mockResolvedValue(SETTINGS);
  harness.api.computerHistory.getState.mockResolvedValue(state);
  await render(
    <MossLocaleScope locale="zh-CN">
      <ComputerHistorySettingsPanel />
    </MossLocaleScope>,
  );
  await vi.waitFor(() =>
    expect(document.querySelector('[data-testid="computer-history-off-state"]')).not.toBeNull(),
  );
  return document.body.innerText
    .split("\n")
    .map((line) => line.trim())
    .filter(Boolean);
}

describe("设置 → 电脑历史 where it cannot run", () => {
  it("reads in Chinese, with the server's English message never shown", async () => {
    const lines = await renderOffLines(
      offState({
        supported: false,
        captureCapability: {
          mode: "window_metadata_only",
          interactionEvents: false,
          activitySummaries: false,
          detail: "Window metadata only.",
        },
        message: "Computer History requires a supported Windows or macOS desktop helper.",
      }),
    );
    expect(lines).toEqual([
      "电脑历史需要 Windows 或 macOS 桌面助手。",
      "让 Moss 了解你的工作",
      "开启",
      "开启后，Moss 会保存你允许的应用和网站活动文本摘要，其中可能包含通信内容。不会包含屏幕截图、音频或无痕浏览，且你可以随时暂停、清除历史并管理记录范围。此功能会增加 token 使用量。",
    ]);
  });
});

describe("#953 (WALK-13): 设置 → 电脑历史 on Windows, before it is turned on", () => {
  it("with Windows OCR: one paragraph under the card says what is read and saved, where, and what it costs", async () => {
    // The server's own capability detail for a Windows PC with Windows OCR installed.
    const lines = await renderOffLines(
      offState({
        supported: true,
        captureCapability: {
          mode: "interaction_activity",
          interactionEvents: false,
          activitySummaries: true,
          detail:
            "Windows samples the front window in memory, reads it with Windows OCR and keeps only an abstract activity summary on this computer. Screenshots, OCR text, window titles, browser activity, password fields and meetings are never stored.",
        },
      }),
    );
    expect(lines).toEqual([
      "让 Moss 了解你的工作",
      "开启",
      "开启后，Windows 会在本机用系统自带的文字识别读取最前面的窗口，只保留一句活动摘要，例如“写代码”。截图、屏幕文字、窗口标题、浏览器、密码输入框、会议画面和音频都不会保存。历史加密保存在这台电脑上，可随时暂停或清除。此功能会增加 token 使用量。",
    ]);
  });

  it("without Windows OCR: one paragraph under the card, ending the same way", async () => {
    const lines = await renderOffLines(
      offState({
        supported: true,
        captureCapability: {
          mode: "window_metadata_only",
          interactionEvents: false,
          activitySummaries: false,
          detail:
            "Windows records application names only because Windows OCR is not installed. Window titles, browser activity, URLs, screenshots, audio and input events are excluded.",
        },
      }),
    );
    expect(lines).toEqual([
      "让 Moss 了解你的工作",
      "开启",
      "这台电脑没有安装 Windows 文字识别，开启后只记录正在使用的应用名称，不记录浏览器活动、窗口标题、截图或音频。历史加密保存在这台电脑上，可随时暂停或清除。此功能会增加 token 使用量。",
    ]);
  });
});
