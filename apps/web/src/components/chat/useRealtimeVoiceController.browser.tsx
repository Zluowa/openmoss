// @vitest-environment browser

import {
  ThreadId,
  WsRpcError,
  type RealtimeVoiceEvent,
  type RealtimeVoiceState,
} from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  getState: vi.fn(),
  listVoices: vi.fn(),
  onEvent: vi.fn(),
  unsubscribe: vi.fn(),
  claim: vi.fn(),
  start: vi.fn(),
  stop: vi.fn(),
  releaseClaim: vi.fn(),
  reportClientState: vi.fn(),
  resolveScreenContext: vi.fn(),
  appendText: vi.fn(),
  playCue: vi.fn(),
  setInputMuted: vi.fn(),
  setOutputMuted: vi.fn(),
  webrtcPrepare: vi.fn(),
  webrtcDispose: vi.fn(),
  websocketPrepare: vi.fn(),
  eventListener: null as ((event: RealtimeVoiceEvent) => void) | null,
}));

vi.mock("../../lib/realtimeVoiceWebRtc", () => ({
  RealtimeVoiceWebRtcClient: class FakeRealtimeVoiceWebRtcClient {
    snapshot = {
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: false,
      outputMuted: false,
    };

    async prepare() {
      harness.webrtcPrepare();
      return { offerSdp: "moss-browser-offer", inputDeviceId: null };
    }

    async applyAnswer() {}

    setInputMuted(inputMuted: boolean) {
      this.snapshot = { ...this.snapshot, inputMuted };
      harness.setInputMuted(inputMuted);
    }

    setOutputMuted(outputMuted: boolean) {
      this.snapshot = { ...this.snapshot, outputMuted };
      harness.setOutputMuted(outputMuted);
    }

    async replaceMicrophone() {
      return null;
    }

    async dispose() {
      harness.webrtcDispose();
    }
  },
}));

vi.mock("../../lib/realtimeVoiceWebSocket", () => ({
  RealtimeVoiceWebSocketClient: class FakeRealtimeVoiceWebSocketClient {
    snapshot = {
      webRtcConnected: false,
      dataSessionInitialized: false,
      inputMuted: false,
      outputMuted: false,
    };

    async prepare() {
      harness.websocketPrepare();
      return { inputDeviceId: null };
    }

    async connect() {}

    setInputMuted(inputMuted: boolean) {
      this.snapshot = { ...this.snapshot, inputMuted };
      harness.setInputMuted(inputMuted);
    }

    setOutputMuted(outputMuted: boolean) {
      this.snapshot = { ...this.snapshot, outputMuted };
      harness.setOutputMuted(outputMuted);
    }

    async replaceMicrophone() {
      return null;
    }

    async dispose() {}
  },
}));

vi.mock("~/nativeApi", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/nativeApi")>();
  return {
    ...actual,
    readNativeApi: () => ({
      realtimeVoice: {
        getState: harness.getState,
        listVoices: harness.listVoices,
        onEvent: harness.onEvent,
        claim: harness.claim,
        start: harness.start,
        stop: harness.stop,
        releaseClaim: harness.releaseClaim,
        reportClientState: harness.reportClientState,
        resolveScreenContext: harness.resolveScreenContext,
        appendText: harness.appendText,
      },
    }),
  };
});

vi.mock("../../lib/realtimeVoiceCue", () => ({
  playRealtimeVoiceCue: harness.playCue,
}));

import { useRealtimeVoiceRuntimeController } from "./useRealtimeVoiceController";
import { MossLocalizationProvider as MossZhProvider } from "~/localization";

vi.mock("~/appSettings", async (importOriginal) => {
  const actual = await importOriginal<typeof import("~/appSettings")>();
  return {
    ...actual,
    useAppSettings: () => ({
      settings: {
        codexAccounts: [],
        codexHomePath: "",
        localeOverride: "zh-CN",
        selectedCodexAccountId: "default",
      },
    }),
  };
});

// zh-CN 表面：裸挂载默认 localization context 按浏览器语言解析为 en，统一以 zh Provider 包裹。
function renderZh(ui: Parameters<typeof render>[0]) {
  return render(<MossZhProvider>{ui}</MossZhProvider>);
}
import { translateMoss } from "../../localization";

const THREAD_A = ThreadId.makeUnsafe("voice-owner-thread-a");
const THREAD_B = ThreadId.makeUnsafe("ordinary-thread-b");
const SESSION_A = "voice-owner-session-a";
const SESSION_B = "voice-owner-session-b";

const INACTIVE_STATE: RealtimeVoiceState = {
  phase: "inactive",
  sessionId: null,
  threadId: null,
  ownerClaimId: null,
  source: null,
  voice: null,
  requestedModel: null,
  actualModel: null,
  activity: null,
  barrier: {
    requestAccepted: false,
    backendStarted: false,
    webRtcConnected: false,
    dataSessionInitialized: false,
  },
  inputMuted: false,
  outputMuted: false,
  error: null,
};

const ACTIVE_STATE: RealtimeVoiceState = {
  phase: "active",
  sessionId: SESSION_A,
  threadId: THREAD_A,
  ownerClaimId: "voice-owner-claim-a",
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

const ACTIVE_STATE_B: RealtimeVoiceState = {
  ...ACTIVE_STATE,
  sessionId: SESSION_B,
  ownerClaimId: "voice-owner-claim-b",
};

function RuntimeSwitchHarness({ disabled = false }: { readonly disabled?: boolean }) {
  const [threadId, setThreadId] = useState(THREAD_A);
  const [startAccepted, setStartAccepted] = useState<string>("unrequested");
  const voice = useRealtimeVoiceRuntimeController({
    threadId,
    disabled,
    source: "composer-existing",
    ownsDesktopSurface: true,
    focusThread: setThreadId,
  });

  return (
    <div>
      <button
        type="button"
        onClick={() =>
          void voice.start().then((accepted) => setStartAccepted(accepted ? "true" : "false"))
        }
      >
        Start owner call
      </button>
      <button type="button" onClick={() => setThreadId(THREAD_B)}>
        Open another task
      </button>
      <button type="button" onClick={voice.openOwningThread}>
        Return to voice owner
      </button>
      <button type="button" onClick={voice.toggleInputMuted}>
        Toggle microphone
      </button>
      <button type="button" onClick={voice.toggleOutputMuted}>
        Toggle speaker
      </button>
      <output data-testid="visible-thread">{String(threadId)}</output>
      <output data-testid="voice-owner-thread">{String(voice.state.threadId ?? "none")}</output>
      <output data-testid="voice-session">{String(voice.state.sessionId ?? "none")}</output>
      <output data-testid="voice-phase">{voice.state.phase}</output>
      <output data-testid="voice-transcript">{voice.transcript}</output>
      <output data-testid="voice-quota">{voice.quota?.creditBalance ?? "none"}</output>
      <output data-testid="voice-error">{voice.error ?? "none"}</output>
      <output data-testid="voice-launch-failed">{String(voice.launchFailed)}</output>
      <output data-testid="voice-launch-overlay-visible">
        {String(voice.isLaunchOverlayVisible)}
      </output>
      <output data-testid="voice-main-presentation-visible">
        {String(voice.isMainThreadPresentationVisible)}
      </output>
      <output data-testid="voice-start-accepted">{startAccepted}</output>
    </div>
  );
}

beforeEach(() => {
  harness.getState.mockReset().mockResolvedValue(INACTIVE_STATE);
  harness.listVoices.mockReset().mockResolvedValue({
    defaultVoice: "maple",
    preferredTransport: "webrtc",
    voices: [],
  });
  harness.unsubscribe.mockReset();
  harness.claim.mockReset().mockResolvedValue({
    ownerClaimId: "voice-owner-claim-a",
    preferredTransport: "webrtc",
  });
  harness.start.mockReset().mockResolvedValue({
    sessionId: SESSION_A,
    transport: { type: "webrtc", sdp: "moss-browser-answer" },
  });
  harness.stop.mockReset().mockResolvedValue({ accepted: true });
  harness.releaseClaim.mockReset().mockResolvedValue({ accepted: true });
  harness.reportClientState.mockReset().mockResolvedValue(ACTIVE_STATE);
  harness.resolveScreenContext.mockReset().mockResolvedValue({ accepted: true });
  harness.appendText.mockReset().mockResolvedValue({ accepted: true });
  harness.playCue.mockReset();
  harness.setInputMuted.mockReset();
  harness.setOutputMuted.mockReset();
  harness.webrtcPrepare.mockReset();
  harness.webrtcDispose.mockReset();
  harness.websocketPrepare.mockReset();
  harness.eventListener = null;
  harness.onEvent
    .mockReset()
    .mockImplementation((listener: (event: RealtimeVoiceEvent) => void) => {
      harness.eventListener = listener;
      return harness.unsubscribe;
    });
  window.localStorage.removeItem("moss.realtimeVoice.screenContext.v1");
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("useRealtimeVoiceRuntimeController owner event routing", () => {
  it("ignores usage and quota warnings from a foreign voice session", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());
    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
    });

    const quota = {
      periodEnd: null,
      planLimitNanoUsd: null,
      planUsedNanoUsd: 0,
      planReservedNanoUsd: 0,
      creditBalance: 7,
      estimatedMinutesRemaining: null,
    } as const;
    harness.eventListener?.({
      type: "usage",
      sessionId: SESSION_B,
      threadId: THREAD_B,
      createdAt: "2026-08-22T11:11:24.790Z",
      responseId: "foreign-response",
      usage: {
        inputTextTokens: 0,
        inputCachedTextTokens: 0,
        inputAudioTokens: 0,
        inputCachedAudioTokens: 0,
        inputImageTokens: 0,
        inputCachedImageTokens: 0,
        outputTextTokens: 0,
        outputAudioTokens: 0,
        costNanoUsd: 0,
      },
      quota,
    });
    harness.eventListener?.({
      type: "quota-warning",
      sessionId: SESSION_B,
      threadId: THREAD_B,
      createdAt: "2026-08-22T11:11:24.790Z",
      quota,
      willStopAfterCurrentResponse: false,
    });
    expect(screen.getByTestId("voice-quota").element().textContent).toBe("none");

    harness.eventListener?.({
      type: "usage",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-08-22T11:11:24.790Z",
      responseId: "owned-response",
      usage: {
        inputTextTokens: 0,
        inputCachedTextTokens: 0,
        inputAudioTokens: 0,
        inputCachedAudioTokens: 0,
        inputImageTokens: 0,
        inputCachedImageTokens: 0,
        outputTextTokens: 0,
        outputAudioTokens: 0,
        costNanoUsd: 0,
      },
      quota,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-quota").element().textContent).toBe("7");
    });
  });

  it("plays build-6119 cues only for microphone mute state changes", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
    });
    harness.playCue.mockClear();

    const microphoneButton = screen
      .getByRole("button", {
        name: "Toggle microphone",
      })
      .element() as HTMLButtonElement;
    microphoneButton.click();
    microphoneButton.click();
    (screen.getByRole("button", { name: "Toggle speaker" }).element() as HTMLButtonElement).click();

    expect(harness.setInputMuted.mock.calls).toEqual([[true], [false]]);
    expect(harness.setOutputMuted.mock.calls).toEqual([[true]]);
    expect(harness.playCue.mock.calls).toEqual([["mute"], ["unmute"]]);
  });

  it("reports a guarded start as rejected without beginning a launch", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness disabled />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-start-accepted").element().textContent).toBe("false");
    });
    expect(screen.getByTestId("voice-phase").element().textContent).toBe("inactive");
    expect(harness.claim).not.toHaveBeenCalled();
    expect(harness.start).not.toHaveBeenCalled();
  });

  it("presents a typed zero-credit start rejection as quota exhaustion", async () => {
    harness.start.mockRejectedValueOnce(
      new WsRpcError({
        message: "This Moss account does not have enough credits to start Realtime Voice.",
        code: "VOICE_CREDITS_EXHAUSTED",
        retryable: false,
      }),
    );
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.quotaExhausted"),
      );
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
    });
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.releaseClaim).toHaveBeenCalledWith({
      ownerClaimId: "voice-owner-claim-a",
    });
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("presents provider rate limiting as retryable service pressure instead of zero quota", async () => {
    harness.start.mockRejectedValueOnce(
      new WsRpcError({
        message: "Realtime Voice is receiving too many requests. Wait a moment and try again.",
        code: "VOICE_RATE_LIMITED",
        retryable: true,
      }),
    );
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();

    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        "语音服务请求过多，请稍后重试。",
      );
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
    });
    expect(harness.start).toHaveBeenCalledOnce();
    expect(harness.releaseClaim).toHaveBeenCalledWith({
      ownerClaimId: "voice-owner-claim-a",
    });
    expect(harness.stop).not.toHaveBeenCalled();
  });

  it("keeps the authoritative entitlement error when the failed state follows it", async () => {
    harness.start.mockRejectedValueOnce(
      new WsRpcError({
        message: "Realtime Voice is not included for this Moss account.",
        code: "VOICE_ENTITLEMENT_REQUIRED",
        retryable: false,
      }),
    );
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.entitlementRequired"),
      );
    });

    harness.eventListener?.({
      type: "error",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-08-22T11:11:24.790Z",
      code: "VOICE_ENTITLEMENT_REQUIRED",
      message: "Realtime Voice is not included for this Moss account.",
      recoverable: false,
    });
    harness.eventListener?.({
      type: "state",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-08-22T11:11:24.790Z",
      state: {
        ...INACTIVE_STATE,
        phase: "failed",
        sessionId: SESSION_A,
        threadId: THREAD_A,
        source: "composer-existing",
        error: "private failed-state detail",
      },
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.entitlementRequired"),
      );
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
    });
  });

  it("clears a superseded local launch failure when the same thread becomes active", async () => {
    harness.webrtcPrepare.mockImplementationOnce(() => {
      throw new DOMException("Requested device not found", "NotFoundError");
    });
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("failed");
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe("true");
    });

    harness.eventListener?.({
      type: "state",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.000Z",
      state: ACTIVE_STATE,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-error").element().textContent).toBe("none");
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("false");
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe(
        "false",
      );
    });

    harness.eventListener?.({
      type: "closed",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.100Z",
      reason: "user",
    });
    harness.eventListener?.({
      type: "state",
      sessionId: null,
      threadId: null,
      createdAt: "2026-07-30T12:00:00.200Z",
      state: INACTIVE_STATE,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("inactive");
      expect(screen.getByTestId("voice-error").element().textContent).toBe("none");
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("false");
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe(
        "false",
      );
    });
  });

  it("keeps the provider failure surface after active, error, closed(error), and inactive events", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-error").element().textContent).toBe("none");
    });

    harness.eventListener?.({
      type: "error",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.000Z",
      code: "provider_session_error",
      message:
        "relay disconnected wss://private-relay.invalid/session/private-session Bearer TOKEN_SENTINEL /Users/private-user",
      recoverable: false,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable"),
      );
      expect(document.body.textContent).not.toMatch(
        /TOKEN_SENTINEL|private-relay|private-session|private-user/u,
      );
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe("true");
    });

    harness.eventListener?.({
      type: "closed",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.100Z",
      reason: "error",
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("failed");
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable"),
      );
      expect(screen.getByTestId("voice-launch-failed").element().textContent).toBe("true");
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe("true");
      expect(screen.getByTestId("voice-main-presentation-visible").element().textContent).toBe(
        "true",
      );
    });

    harness.eventListener?.({
      type: "state",
      sessionId: null,
      threadId: null,
      createdAt: "2026-07-30T12:00:00.200Z",
      state: INACTIVE_STATE,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("failed");
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable"),
      );
      expect(screen.getByTestId("voice-launch-overlay-visible").element().textContent).toBe("true");
      expect(screen.getByTestId("voice-main-presentation-visible").element().textContent).toBe(
        "true",
      );
    });
  });

  it("keeps A transcript, screen tools, and failure state while B is visible, then returns to A", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-owner-thread").element().textContent).toBe(THREAD_A);
    });
    expect(harness.webrtcPrepare).toHaveBeenCalledOnce();
    expect(harness.webrtcPrepare.mock.invocationCallOrder[0]).toBeLessThan(
      harness.claim.mock.invocationCallOrder[0] ?? Number.POSITIVE_INFINITY,
    );

    (
      screen.getByRole("button", { name: "Open another task" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("visible-thread").element().textContent).toBe(THREAD_B);
    });

    harness.eventListener?.({
      type: "transcript",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.000Z",
      itemId: "assistant-owner-item",
      role: "assistant",
      delta: "Owner A reply continues while B is visible.",
      done: true,
    });
    harness.eventListener?.({
      type: "tool-request",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:00.100Z",
      callId: "owner-screen-context-call",
      name: "capture_screen_context",
      arguments: {},
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-transcript").element().textContent).toContain(
        "Owner A reply continues while B is visible.",
      );
      expect(harness.resolveScreenContext).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_A,
          callId: "owner-screen-context-call",
          accepted: false,
          reason: "screen_context_disabled",
        }),
      );
    });

    (
      screen.getByRole("button", { name: "Return to voice owner" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("visible-thread").element().textContent).toBe(THREAD_A);
      expect(screen.getByTestId("voice-owner-thread").element().textContent).toBe(THREAD_A);
      expect(screen.getByTestId("voice-transcript").element().textContent).toContain(
        "Owner A reply continues while B is visible.",
      );
    });

    (
      screen.getByRole("button", { name: "Open another task" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("visible-thread").element().textContent).toBe(THREAD_B);
    });
    harness.eventListener?.({
      type: "state",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:01.000Z",
      state: {
        ...ACTIVE_STATE,
        phase: "failed",
        error:
          "Owner A relay failed with TOKEN_SENTINEL at /Users/private-user/voice.ts:7 private-session",
      },
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable"),
      );
      expect(document.body.textContent).not.toMatch(/TOKEN_SENTINEL|private-user|private-session/u);
    });

    (
      screen.getByRole("button", { name: "Return to voice owner" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("visible-thread").element().textContent).toBe(THREAD_A);
      expect(screen.getByTestId("voice-error").element().textContent).toBe(
        translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable"),
      );
    });
  });

  it("ignores stale terminal events from a previous session on the same thread", async () => {
    const screen = await renderZh(<RuntimeSwitchHarness />);
    await vi.waitFor(() => expect(harness.eventListener).not.toBeNull());

    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-session").element().textContent).toBe(SESSION_A);
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
    });

    harness.eventListener?.({
      type: "closed",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:02.000Z",
      reason: "user",
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("inactive");
      expect(harness.webrtcDispose).toHaveBeenCalledTimes(1);
    });

    harness.claim.mockResolvedValue({
      ownerClaimId: "voice-owner-claim-b",
      preferredTransport: "webrtc",
    });
    harness.start.mockResolvedValue({
      sessionId: SESSION_B,
      transport: { type: "webrtc", sdp: "moss-browser-answer-b" },
    });
    harness.reportClientState.mockResolvedValue(ACTIVE_STATE_B);
    (
      screen.getByRole("button", { name: "Start owner call" }).element() as HTMLButtonElement
    ).click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-session").element().textContent).toBe(SESSION_B);
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-error").element().textContent).toBe("none");
    });

    harness.eventListener?.({
      type: "error",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:02.100Z",
      code: "stale_provider_error",
      message: "A stale session must not close the replacement call.",
      recoverable: false,
    });
    harness.eventListener?.({
      type: "state",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:02.200Z",
      state: INACTIVE_STATE,
    });
    harness.eventListener?.({
      type: "closed",
      sessionId: SESSION_A,
      threadId: THREAD_A,
      createdAt: "2026-07-30T12:00:02.300Z",
      reason: "error",
    });

    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-session").element().textContent).toBe(SESSION_B);
      expect(screen.getByTestId("voice-phase").element().textContent).toBe("active");
      expect(screen.getByTestId("voice-error").element().textContent).toBe("none");
      expect(harness.webrtcDispose).toHaveBeenCalledTimes(1);
    });
  });
});
