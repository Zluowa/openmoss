// @vitest-environment browser

import { ThreadId, type RealtimeVoiceEvent, type RealtimeVoiceState } from "@synara/contracts";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

const harness = vi.hoisted(() => ({
  getState: vi.fn(),
  listVoices: vi.fn(),
  onEvent: vi.fn(),
  unsubscribe: vi.fn(),
  stop: vi.fn(),
  eventListener: null as ((event: RealtimeVoiceEvent) => void) | null,
}));

vi.mock("~/nativeApi", async (importOriginal) => ({
  ...(await importOriginal<typeof import("~/nativeApi")>()),
  readNativeApi: () => ({
    realtimeVoice: {
      getState: harness.getState,
      listVoices: harness.listVoices,
      onEvent: harness.onEvent,
      stop: harness.stop,
    },
  }),
}));

import {
  RealtimeVoiceControllerProvider,
  useRealtimeVoiceController,
  useRealtimeVoiceGlobalRuntime,
} from "./RealtimeVoiceControllerProvider";

const THREAD_A = ThreadId.makeUnsafe("voice-owner-thread-a");
const THREAD_B = ThreadId.makeUnsafe("ordinary-thread-b");
const INACTIVE_STATE = {
  phase: "inactive" as const,
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
  ...INACTIVE_STATE,
  phase: "active",
  sessionId: "voice-session-active",
  threadId: THREAD_A,
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
};

function VoiceSurface(props: { readonly threadId: ThreadId }) {
  const voice = useRealtimeVoiceController({
    threadId: props.threadId,
    disabled: false,
    source: "composer-existing",
    ownsDesktopSurface: true,
  });
  return (
    <output data-testid="voice-surface-thread">{String(voice.state.threadId ?? "none")}</output>
  );
}

function RouteSwitchHarness() {
  const [threadId, setThreadId] = useState(THREAD_A);
  return (
    <RealtimeVoiceControllerProvider>
      <button type="button" onClick={() => setThreadId(THREAD_B)}>
        Open another task
      </button>
      <VoiceSurface key={threadId} threadId={threadId} />
    </RealtimeVoiceControllerProvider>
  );
}

function GlobalRuntimeProbe() {
  const { state } = useRealtimeVoiceGlobalRuntime();
  return <output data-testid="global-runtime-phase">{state.phase}</output>;
}

function RootFallbackSwitchHarness() {
  const [fallback, setFallback] = useState(false);
  return (
    <RealtimeVoiceControllerProvider>
      <button type="button" onClick={() => setFallback((current) => !current)}>
        {fallback ? "Show happy route" : "Show root fallback"}
      </button>
      <GlobalRuntimeProbe />
      {fallback ? <p>Connecting to Moss server...</p> : <VoiceSurface threadId={THREAD_A} />}
    </RealtimeVoiceControllerProvider>
  );
}

function UnstableCallbackSurface() {
  const [renderCount, setRenderCount] = useState(0);
  const voice = useRealtimeVoiceController({
    threadId: THREAD_A,
    disabled: false,
    source: "composer-existing",
    ownsDesktopSurface: true,
    prepareThread: async () => undefined,
    focusThread: () => undefined,
  });
  return (
    <>
      <button type="button" onClick={() => setRenderCount((current) => current + 1)}>
        Rerender voice surface
      </button>
      <output data-testid="unstable-callback-render-count">{renderCount}</output>
      <output data-testid="unstable-callback-phase">{voice.state.phase}</output>
    </>
  );
}

function UnstableCallbackHarness() {
  return (
    <RealtimeVoiceControllerProvider>
      <UnstableCallbackSurface />
    </RealtimeVoiceControllerProvider>
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
  harness.stop.mockReset().mockResolvedValue({ accepted: true });
  harness.eventListener = null;
  harness.onEvent
    .mockReset()
    .mockImplementation((listener: (event: RealtimeVoiceEvent) => void) => {
      harness.eventListener = listener;
      return harness.unsubscribe;
    });
});

afterEach(() => {
  document.body.replaceChildren();
  vi.restoreAllMocks();
});

describe("RealtimeVoiceControllerProvider", () => {
  it("does not re-register recursively when presentation callbacks change identity", async () => {
    const consoleError = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const screen = await render(<UnstableCallbackHarness />);
    await vi.waitFor(() => expect(harness.onEvent).toHaveBeenCalledTimes(1));

    const rerenderButton = screen
      .getByRole("button", { name: "Rerender voice surface" })
      .element() as HTMLButtonElement;
    rerenderButton.click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("unstable-callback-render-count").element().textContent).toBe("1");
    });

    expect(screen.getByTestId("unstable-callback-phase").element().textContent).toBe("inactive");
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    expect(
      consoleError.mock.calls.some(([message]) =>
        String(message).includes("Maximum update depth exceeded"),
      ),
    ).toBe(false);

    await screen.unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps the process-wide controller subscribed while the visible thread route remounts", async () => {
    const screen = await render(<RouteSwitchHarness />);
    await vi.waitFor(() => expect(harness.onEvent).toHaveBeenCalledTimes(1));

    const switchButton = screen
      .getByRole("button", { name: "Open another task" })
      .element() as HTMLButtonElement;
    switchButton.click();
    await vi.waitFor(() => {
      expect(screen.getByTestId("voice-surface-thread").element()).toBeTruthy();
    });

    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribe).not.toHaveBeenCalled();

    await screen.unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });

  it("keeps an active global runtime alive while the root switches to a fallback branch", async () => {
    const screen = await render(<RootFallbackSwitchHarness />);
    await vi.waitFor(() => expect(harness.onEvent).toHaveBeenCalledTimes(1));

    harness.eventListener?.({
      type: "state",
      sessionId: ACTIVE_STATE.sessionId,
      threadId: THREAD_A,
      createdAt: "2026-07-30T00:00:00.000Z",
      state: ACTIVE_STATE,
    });
    await vi.waitFor(() => {
      expect(screen.getByTestId("global-runtime-phase").element().textContent).toBe("active");
    });

    const fallbackButton = screen
      .getByRole("button", { name: "Show root fallback" })
      .element() as HTMLButtonElement;
    fallbackButton.click();
    await vi.waitFor(() => expect(screen.getByText("Connecting to Moss server...")).toBeTruthy());

    expect(screen.getByTestId("global-runtime-phase").element().textContent).toBe("active");
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();

    const happyRouteButton = screen
      .getByRole("button", { name: "Show happy route" })
      .element() as HTMLButtonElement;
    happyRouteButton.click();
    await vi.waitFor(() => expect(screen.getByTestId("voice-surface-thread")).toBeTruthy());

    expect(screen.getByTestId("global-runtime-phase").element().textContent).toBe("active");
    expect(harness.onEvent).toHaveBeenCalledTimes(1);
    expect(harness.unsubscribe).not.toHaveBeenCalled();
    expect(harness.stop).not.toHaveBeenCalled();

    await screen.unmount();
    expect(harness.unsubscribe).toHaveBeenCalledTimes(1);
  });
});
