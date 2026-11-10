// FILE: RealtimeVoiceEmptyState.browser.tsx
// Purpose: The voice-mode conversation is never blank: status, live transcript, first-open hint
//          and an end control, in Chinese, for the empty and the active states.
// Layer: Chat surface browser tests

// Production CSS keeps the compact geometry and colours real for the screenshots.
import "../../index.css";

import { ThreadId, type RealtimeVoiceState } from "@moss/contracts";
import { page } from "vitest/browser";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";

import { MossLocaleScope } from "../../localization";
import {
  REALTIME_VOICE_HINT_STORAGE_KEY,
  RealtimeVoiceEmptyState,
} from "./RealtimeVoiceEmptyState";
import { RealtimeVoiceStage } from "./RealtimeVoiceStage";

const listening: RealtimeVoiceState = {
  phase: "active",
  sessionId: "voice-session",
  threadId: ThreadId.makeUnsafe("voice-thread"),
  ownerClaimId: "voice-owner",
  source: "composer-existing",
  voice: "maple",
  requestedModel: "gpt-realtime-2.1",
  actualModel: "gpt-realtime-2.1",
  activity: "listening",
  barrier: {
    requestAccepted: true,
    backendStarted: true,
    webRtcConnected: true,
    dataSessionInitialized: true,
  },
  inputMuted: false,
  outputMuted: false,
  error: null,
};

const silentSignal = () => ({ low: 0, mid: 0, high: 0, overall: 0 });

/** The empty voice thread as ChatView lays it out: transcript pane above, stage above composer. */
function VoiceThread(props: {
  readonly state: RealtimeVoiceState;
  readonly transcript: string;
  readonly hasMessages?: boolean;
  readonly onStop: () => void;
}) {
  return (
    <MossLocaleScope locale="zh-CN">
      <main
        className="fixed inset-0 flex flex-col bg-[var(--color-background-primary)] px-5 pb-4"
        data-testid="voice-thread"
      >
        <div className="flex flex-1 items-center justify-center">
          {props.hasMessages ? (
            <p className="text-ui-lg">已有消息</p>
          ) : (
            <RealtimeVoiceEmptyState state={props.state} transcript={props.transcript} />
          )}
        </div>
        <div className="mx-auto w-full" style={{ maxWidth: 900 }}>
          <RealtimeVoiceStage
            state={props.state}
            transcript={props.transcript}
            quota={null}
            readOutputSignal={silentSignal}
            previewTimeMs={4_250}
            onStop={props.onStop}
            showCaption={props.hasMessages ?? false}
          />
          <div className="h-24 rounded-[14px] border border-border bg-[var(--color-background-surface)]" />
        </div>
      </main>
    </MossLocaleScope>
  );
}

async function screenshot(name: string): Promise<void> {
  // Copied to C:\DevTemp\moss-owner-feedback-20261108\fix\voice for the PR.
  await page.screenshot({ path: `../../../../../.tmp/realtime-voice/${name}.png` });
}

beforeEach(async () => {
  localStorage.removeItem(REALTIME_VOICE_HINT_STORAGE_KEY);
  await page.viewport(1_280, 800);
});

afterEach(() => {
  localStorage.removeItem(REALTIME_VOICE_HINT_STORAGE_KEY);
});

describe("RealtimeVoiceEmptyState", () => {
  it("empty state: shows the status, a prompt, the first-open hint and an end control", async () => {
    const onStop = vi.fn();
    const screen = await render(<VoiceThread state={listening} transcript="" onStop={onStop} />);
    try {
      const empty = document.querySelector<HTMLElement>("[data-moss-realtime-voice-empty-state]");
      expect(empty).toBeTruthy();
      expect(empty?.textContent).toContain("语音对话");
      expect(empty?.textContent).toContain("正在聆听");
      expect(empty?.textContent).toContain("说点什么吧，Moss 在听。");
      await expect.element(page.getByRole("region", { name: "语音对话怎么用" })).toBeVisible();
      expect(empty?.textContent).toContain("直接说话，停顿后 Moss 就会回答。");

      const statusRow = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-status-row]",
      );
      expect(statusRow?.textContent).toContain("正在聆听");
      expect(statusRow?.dataset.tone).toBe("listening");
      // Compact scale: a 24px status row and a 24px (sm) ghost button.
      expect(getComputedStyle(statusRow!).height).toBe("24px");
      const stage = document.querySelector<HTMLElement>("[data-moss-realtime-voice-stage]");
      expect(getComputedStyle(stage!).height).toBe("208px");
      // No English and no provider wording anywhere in the voice view.
      const visibleText = document.querySelector("[data-testid='voice-thread']")?.textContent ?? "";
      expect(visibleText).not.toMatch(/Listening|Speaking|Thinking|Provider adapter/u);
      await screenshot("moss-voice-empty-1280x800");

      await page.getByRole("button", { name: "结束语音" }).click();
      expect(onStop).toHaveBeenCalledOnce();

      await page.getByRole("button", { name: "知道了" }).click();
      expect(document.querySelector("[data-moss-realtime-voice-hint]")).toBeNull();
      expect(localStorage.getItem(REALTIME_VOICE_HINT_STORAGE_KEY)).toBe("1");
    } finally {
      await screen.unmount();
    }
  });

  it("shows the hint only on the first voice chat", async () => {
    const first = await render(<VoiceThread state={listening} transcript="" onStop={vi.fn()} />);
    expect(document.querySelector("[data-moss-realtime-voice-hint]")).toBeTruthy();
    await first.unmount();
    // Ending the first chat counts as having seen it.
    expect(localStorage.getItem(REALTIME_VOICE_HINT_STORAGE_KEY)).toBe("1");

    const second = await render(<VoiceThread state={listening} transcript="" onStop={vi.fn()} />);
    try {
      expect(document.querySelector("[data-moss-realtime-voice-hint]")).toBeNull();
      expect(
        document.querySelector("[data-moss-realtime-voice-empty-state]")?.textContent,
      ).toContain("说点什么吧，Moss 在听。");
    } finally {
      await second.unmount();
    }
  });

  it("active state: the live transcript appears progressively and the status follows Moss", async () => {
    localStorage.setItem(REALTIME_VOICE_HINT_STORAGE_KEY, "1");
    const onStop = vi.fn();
    const screen = await render(
      <VoiceThread state={listening} transcript="你好" onStop={onStop} />,
    );
    try {
      const transcript = () =>
        document.querySelector<HTMLElement>("[data-moss-realtime-voice-live-transcript]")
          ?.textContent ?? "";
      expect(transcript()).toContain("你好");

      await screen.rerender(
        <VoiceThread state={listening} transcript="你好，帮我生成一张图片" onStop={onStop} />,
      );
      expect(transcript()).toContain("你好，帮我生成一张图片");

      await screen.rerender(
        <VoiceThread
          state={{ ...listening, activity: "thinking" }}
          transcript="你好，帮我生成一张图片"
          onStop={onStop}
        />,
      );
      expect(document.querySelector("[data-moss-realtime-voice-empty-status]")?.textContent).toBe(
        "正在思考",
      );

      await screen.rerender(
        <VoiceThread
          state={{ ...listening, activity: "speaking" }}
          transcript={"你好，帮我生成一张图片\n好的，我来画一张"}
          onStop={onStop}
        />,
      );
      expect(document.querySelector("[data-moss-realtime-voice-empty-status]")?.textContent).toBe(
        "正在说话",
      );
      expect(transcript()).toContain("好的，我来画一张");
      expect(
        document.querySelector<HTMLElement>("[data-moss-realtime-voice-status-row]")?.dataset.tone,
      ).toBe("speaking");
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("正在说话. 好的，我来画一张");
      await screenshot("moss-voice-active-1280x800");
    } finally {
      await screen.unmount();
    }
  });

  it("active thread with messages: the newest transcript line is a caption above the orb", async () => {
    localStorage.setItem(REALTIME_VOICE_HINT_STORAGE_KEY, "1");
    const screen = await render(
      <VoiceThread
        state={{ ...listening, inputMuted: true }}
        transcript={"第一句\n再帮我改一下标题"}
        hasMessages
        onStop={vi.fn()}
      />,
    );
    try {
      expect(document.querySelector("[data-moss-realtime-voice-caption]")?.textContent).toBe(
        "再帮我改一下标题",
      );
      expect(
        document.querySelector("[data-moss-realtime-voice-status-row]")?.textContent,
      ).toContain("麦克风已静音");
      await screenshot("moss-voice-caption-1280x800");
    } finally {
      await screen.unmount();
    }
  });
});
