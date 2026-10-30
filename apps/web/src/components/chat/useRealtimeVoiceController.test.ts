import {
  ThreadId,
  WsRpcError,
  type RealtimeVoiceEvent,
  type RealtimeVoiceState,
} from "@synara/contracts";
import { describe, expect, it, vi } from "vitest";

import {
  MOSS_REALTIME_VOICE_QUOTA_WARNING,
  classifyRealtimeVoicePresentationError,
  createRealtimeVoiceFatalFailure,
  createRealtimeVoiceOverlayPublication,
  deliverRealtimeVoiceQuotaWarning,
  dispatchRealtimeVoiceOverlayCommand,
  isRealtimeVoiceClientStateResponseCurrent,
  realtimeVoiceEventTargetsOwnedCall,
  projectRealtimeVoiceOverlaySnapshot,
  projectRealtimeVoiceLaunchUi,
  projectRealtimeVoiceQuotaWarning,
  presentRealtimeVoiceError,
  realtimeVoiceToggleAction,
  reduceRealtimeVoiceLaunchStateForEvent,
  realtimeVoicePresentationSurfaceForLaunch,
  resolveRealtimeVoiceRemoteTermination,
  selectRealtimeVoiceTransportCandidate,
  shouldApplyRealtimeVoiceInputPreference,
  shouldPromoteRealtimeVoiceToGlobalOverlay,
  shouldRenderRealtimeVoiceMainThreadPresentation,
  shouldReturnRealtimeVoiceToMainThread,
  stopRealtimeVoiceRemoteBeforeDisposal,
} from "./useRealtimeVoiceController";
import { translateMoss } from "../../localization";

const THREAD_ID = ThreadId.makeUnsafe("private-thread");
const OTHER_THREAD_ID = ThreadId.makeUnsafe("other-private-thread");

const activeState: RealtimeVoiceState = {
  phase: "active",
  sessionId: "private-session",
  threadId: THREAD_ID,
  ownerClaimId: "private-owner",
  source: "global-hotkey",
  voice: "maple",
  requestedModel: "requested-model",
  actualModel: "actual-model",
  activity: "speaking",
  barrier: {
    requestAccepted: true,
    backendStarted: true,
    webRtcConnected: true,
    dataSessionInitialized: true,
  },
  inputMuted: true,
  outputMuted: false,
  error: null,
};

const startingState: RealtimeVoiceState = {
  ...activeState,
  phase: "starting",
  activity: null,
};

const startingLaunch = { pending: true, handoffComplete: false } as const;
const idleLaunch = { pending: false, handoffComplete: false } as const;

const inactiveState = {
  ...activeState,
  phase: "inactive",
  sessionId: null,
  threadId: null,
  ownerClaimId: null,
  source: null,
  voice: null,
  requestedModel: null,
  actualModel: null,
  activity: null,
  error: null,
} satisfies RealtimeVoiceState;

describe("Realtime Voice presentation projection", () => {
  it("keeps provider rate limiting distinct from exhausted account quota", () => {
    const input = {
      cause: new Error(
        "Realtime Voice is receiving too many requests. Wait a moment and try again.",
      ),
      code: "VOICE_RATE_LIMITED",
    };

    expect(classifyRealtimeVoicePresentationError(input)).toBe("service-rate-limited");
    expect(presentRealtimeVoiceError(input, (key) => translateMoss("en", key))).toBe(
      "Voice is receiving too many requests. Wait a moment and try again.",
    );
    expect(presentRealtimeVoiceError(input, (key) => translateMoss("zh-CN", key))).toBe(
      "语音服务请求过多，请稍后重试。",
    );
  });

  it.each([
    {
      name: "microphone permission",
      error: new DOMException("Permission denied for /dev/private-mic", "NotAllowedError"),
      code: null,
      category: "microphone-permission",
      key: "realtimeVoice.error.microphonePermission",
    },
    {
      name: "upstream service availability",
      error: new Error("provider service detail should stay private"),
      code: "VOICE_UPSTREAM_UNAVAILABLE",
      category: "service-unavailable",
      key: "realtimeVoice.error.serviceUnavailable",
    },
    {
      name: "Moss service credits",
      error: new Error("provider billing detail should stay private"),
      code: "VOICE_SERVICE_CREDITS_EXHAUSTED",
      category: "service-credits-exhausted",
      key: "realtimeVoice.error.serviceCreditsExhausted",
    },
    {
      name: "network and relay availability",
      error: new Error(
        "relay disconnected at wss://private-relay.invalid/session/private-session Bearer TOKEN_SENTINEL",
      ),
      code: null,
      category: "network-unavailable",
      key: "realtimeVoice.error.networkUnavailable",
    },
    {
      name: "missing microphone",
      error: new DOMException("No audio input device is available", "NotFoundError"),
      code: null,
      category: "microphone-unavailable",
      key: "realtimeVoice.error.microphoneUnavailable",
    },
    {
      name: "quota exhaustion",
      error: new Error("provider account detail should stay private"),
      code: "VOICE_QUOTA_EXHAUSTED",
      category: "quota-exhausted",
      key: "realtimeVoice.error.quotaExhausted",
    },
    {
      name: "Moss account authentication",
      error: new Error("account session detail should stay private"),
      code: "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
      category: "account-authentication",
      key: "realtimeVoice.error.loginRequired",
    },
    {
      name: "Moss account recovery",
      error: new Error("account recovery detail should stay private"),
      code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
      category: "account-recovery",
      key: "realtimeVoice.error.accountRecovery",
    },
    {
      name: "Moss entitlement",
      error: new Error("entitlement detail should stay private"),
      code: "VOICE_ENTITLEMENT_REQUIRED",
      category: "account-entitlement",
      key: "realtimeVoice.error.entitlementRequired",
    },
    {
      name: "Moss entitlement failed-state message",
      error: new Error("Realtime Voice is not included for this Moss account."),
      code: null,
      category: "account-entitlement",
      key: "realtimeVoice.error.entitlementRequired",
    },
    {
      name: "existing voice session",
      error: new Error("account session detail should stay private"),
      code: "VOICE_SESSION_CONFLICT",
      category: "session-conflict",
      key: "realtimeVoice.error.sessionConflict",
    },
    {
      name: "unknown failures",
      error: new Error(
        "TOKEN_SENTINEL at /Users/private-user/app.ts:41\n    at privateStack (internal.js:9:1)",
      ),
      code: "PRIVATE_PROVIDER_FAILURE",
      category: "voice-unavailable",
      key: "realtimeVoice.error.unavailable",
    },
  ] as const)("maps $name to a finite, localized, non-sensitive presentation", (fixture) => {
    expect(
      classifyRealtimeVoicePresentationError({ cause: fixture.error, code: fixture.code }),
    ).toBe(fixture.category);

    for (const locale of ["en", "zh-CN"] as const) {
      const message = presentRealtimeVoiceError(
        { cause: fixture.error, code: fixture.code },
        (key) => translateMoss(locale, key),
      );
      expect(message).toBe(translateMoss(locale, fixture.key));
      expect(message).not.toMatch(
        /TOKEN_SENTINEL|private-user|private-relay|private-session|privateStack|\/dev\//u,
      );
    }
  });

  it.each([
    {
      name: "typed transport error",
      error: new WsRpcError({
        message: "Realtime Voice is not included for this Moss account.",
        code: "VOICE_ENTITLEMENT_REQUIRED",
        retryable: false,
      }),
    },
    {
      name: "typed transport error nested as a cause",
      error: new Error("Realtime Voice request failed", {
        cause: new WsRpcError({
          message: "private account detail",
          code: "VOICE_ENTITLEMENT_REQUIRED",
          retryable: false,
        }),
      }),
    },
  ])("reads the authoritative code from a $name", ({ error }) => {
    expect(classifyRealtimeVoicePresentationError({ cause: error })).toBe("account-entitlement");
    expect(presentRealtimeVoiceError({ cause: error }, (key) => translateMoss("zh-CN", key))).toBe(
      translateMoss("zh-CN", "realtimeVoice.error.entitlementRequired"),
    );
  });

  it("sanitizes raw state and renderer errors before publishing the desktop overlay", () => {
    const raw =
      "Bearer TOKEN_SENTINEL wss://private-relay.invalid/session/private-session /Users/private-user";
    const snapshot = projectRealtimeVoiceOverlaySnapshot({
      state: { ...activeState, phase: "failed", error: raw },
      error: raw,
      presentationSurface: "global-overlay",
    });

    expect(snapshot?.error).toBe(translateMoss("en", "realtimeVoice.error.networkUnavailable"));
    expect(JSON.stringify(snapshot)).not.toMatch(
      /TOKEN_SENTINEL|private-relay|private-session|private-user/u,
    );
  });

  it("routes owned-call events by stable session and owner thread while another task is visible", () => {
    expect(
      realtimeVoiceEventTargetsOwnedCall({
        eventSessionId: activeState.sessionId,
        eventThreadId: THREAD_ID,
        ownedSessionId: activeState.sessionId,
        ownerThreadId: THREAD_ID,
        currentThreadId: OTHER_THREAD_ID,
      }),
    ).toBe(true);
    expect(
      realtimeVoiceEventTargetsOwnedCall({
        eventSessionId: "other-session",
        eventThreadId: THREAD_ID,
        ownedSessionId: activeState.sessionId,
        ownerThreadId: THREAD_ID,
        currentThreadId: OTHER_THREAD_ID,
      }),
    ).toBe(false);
    expect(
      realtimeVoiceEventTargetsOwnedCall({
        eventSessionId: activeState.sessionId,
        eventThreadId: OTHER_THREAD_ID,
        ownedSessionId: activeState.sessionId,
        ownerThreadId: THREAD_ID,
        currentThreadId: OTHER_THREAD_ID,
      }),
    ).toBe(false);
  });

  it("asks the relay to stop before closing media and still disposes on rejection or timeout", async () => {
    const ordered: string[] = [];
    await stopRealtimeVoiceRemoteBeforeDisposal({
      quiesceMedia: () => {
        ordered.push("quiesce");
      },
      stopRemote: async () => {
        ordered.push("stop");
      },
      disposeMedia: async () => {
        ordered.push("dispose");
      },
    });
    expect(ordered).toEqual(["quiesce", "stop", "dispose"]);

    const disposeAfterFailure = vi.fn(async () => undefined);
    await stopRealtimeVoiceRemoteBeforeDisposal({
      stopRemote: async () => Promise.reject(new Error("relay unavailable")),
      disposeMedia: disposeAfterFailure,
    });
    expect(disposeAfterFailure).toHaveBeenCalledOnce();

    vi.useFakeTimers();
    try {
      const disposeAfterTimeout = vi.fn(async () => undefined);
      const stopping = stopRealtimeVoiceRemoteBeforeDisposal({
        stopRemote: () => new Promise(() => undefined),
        disposeMedia: disposeAfterTimeout,
        timeoutMs: 25,
      });
      await vi.advanceTimersByTimeAsync(25);
      await stopping;
      expect(disposeAfterTimeout).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("uses the global overlay only for a desktop global-hotkey launch", () => {
    expect(realtimeVoicePresentationSurfaceForLaunch("global-hotkey", true)).toBe("global-overlay");
    expect(realtimeVoicePresentationSurfaceForLaunch("global-hotkey", false)).toBe("main-thread");
    expect(realtimeVoicePresentationSurfaceForLaunch("composer-existing", true)).toBe(
      "main-thread",
    );
  });

  it("publishes only the sanitized global-overlay fields", () => {
    const snapshot = projectRealtimeVoiceOverlaySnapshot({
      state: activeState,
      error: translateMoss("en", "realtimeVoice.error.unavailable"),
      presentationSurface: "global-overlay",
    });

    expect(snapshot).toEqual({
      phase: "active",
      activity: "speaking",
      inputMuted: true,
      outputMuted: false,
      error: translateMoss("en", "realtimeVoice.error.unavailable"),
    });
    expect(Object.keys(snapshot ?? {}).toSorted()).toEqual([
      "activity",
      "error",
      "inputMuted",
      "outputMuted",
      "phase",
    ]);
  });

  it("publishes only bounded display-energy bands when the owner supplies orb audio", () => {
    const audioSignal = { low: 0.1, mid: 0.2, high: 0.3, overall: 0.4 } as const;
    expect(
      projectRealtimeVoiceOverlaySnapshot({
        state: activeState,
        error: null,
        presentationSurface: "global-overlay",
        audioSignal,
      }),
    ).toEqual({
      phase: "active",
      activity: "speaking",
      inputMuted: true,
      outputMuted: false,
      error: null,
      audioSignal,
    });
  });

  it("withdraws the overlay for main-thread and inactive presentations", () => {
    expect(
      projectRealtimeVoiceOverlaySnapshot({
        state: activeState,
        error: null,
        presentationSurface: "main-thread",
      }),
    ).toBeNull();
    expect(
      projectRealtimeVoiceOverlaySnapshot({
        state: { ...activeState, phase: "inactive" },
        error: null,
        presentationSurface: "global-overlay",
      }),
    ).toBeNull();
  });

  it("publishes media ownership independently from overlay visibility and carries only detach handoffs", () => {
    const handoff = {
      sequence: 7,
      from: "main-thread",
      origin: { centerX: 640, centerY: 420, width: 112, height: 112 },
      velocity: { x: 840, y: -120 },
    } as const;

    expect(
      createRealtimeVoiceOverlayPublication({
        state: activeState,
        error: null,
        presentationSurface: "main-thread",
        mediaOwnerActive: true,
        handoff,
      }),
    ).toEqual({ snapshot: null, mediaOwnerActive: true, handoff: null });

    expect(
      createRealtimeVoiceOverlayPublication({
        state: activeState,
        error: null,
        presentationSurface: "global-overlay",
        mediaOwnerActive: true,
        handoff,
      }),
    ).toEqual({
      snapshot: {
        phase: "active",
        activity: "speaking",
        inputMuted: true,
        outputMuted: false,
        error: null,
      },
      mediaOwnerActive: true,
      handoff,
    });

    expect(
      createRealtimeVoiceOverlayPublication({
        state: { ...activeState, phase: "failed", error: "Relay unavailable" },
        error: "Relay unavailable",
        presentationSurface: "global-overlay",
        mediaOwnerActive: false,
        handoff: null,
      }),
    ).toMatchObject({
      snapshot: {
        phase: "failed",
        error: translateMoss("en", "realtimeVoice.error.networkUnavailable"),
      },
      mediaOwnerActive: false,
      handoff: null,
    });
  });

  it("maps every desktop overlay command to exactly one renderer action", () => {
    const handlers = {
      toggle: vi.fn(),
      stop: vi.fn(),
      toggleInputMute: vi.fn(),
      toggleOutputMute: vi.fn(),
      focus: vi.fn(),
      handoff: vi.fn(),
    };

    dispatchRealtimeVoiceOverlayCommand("toggle", handlers);
    dispatchRealtimeVoiceOverlayCommand("stop", handlers);
    dispatchRealtimeVoiceOverlayCommand("toggle-input-mute", handlers);
    dispatchRealtimeVoiceOverlayCommand("toggle-output-mute", handlers);
    dispatchRealtimeVoiceOverlayCommand("focus", handlers);
    dispatchRealtimeVoiceOverlayCommand("handoff", handlers);

    for (const handler of Object.values(handlers)) expect(handler).toHaveBeenCalledOnce();
  });

  it("does not retain the starting overlay after a remote inactive state", () => {
    const inactiveState = {
      ...startingState,
      phase: "inactive",
      sessionId: null,
      ownerClaimId: null,
      activity: null,
    } satisfies RealtimeVoiceState;
    const event = {
      type: "state",
      sessionId: null,
      threadId: activeState.threadId,
      createdAt: "2026-07-27T06:00:00.000Z",
      state: inactiveState,
    } satisfies RealtimeVoiceEvent;

    expect(
      projectRealtimeVoiceLaunchUi({
        launch: startingLaunch,
        state: startingState,
        threadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(true);
    const launch = reduceRealtimeVoiceLaunchStateForEvent(startingLaunch, event);
    expect(launch).toEqual({ pending: false, handoffComplete: false });
    expect(
      projectRealtimeVoiceLaunchUi({
        launch,
        state: event.state,
        threadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(false);
    expect(
      projectRealtimeVoiceOverlaySnapshot({
        state: event.state,
        error: null,
        presentationSurface: "global-overlay",
      }),
    ).toBeNull();
  });

  it("keeps an existing-thread launch inline while new and failed launches use the surface", () => {
    const existingThreadState = {
      ...startingState,
      source: "composer-existing",
    } satisfies RealtimeVoiceState;
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: startingLaunch,
        state: existingThreadState,
        threadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(false);
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: startingLaunch,
        state: { ...existingThreadState, source: "composer-new" },
        threadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(true);
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: startingLaunch,
        state: { ...existingThreadState, phase: "failed", error: "Relay unavailable" },
        threadId: THREAD_ID,
        error: "Relay unavailable",
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(true);
  });

  it("does not retain the starting overlay after a remote closed event", () => {
    const event = {
      type: "closed",
      sessionId: activeState.sessionId,
      threadId: activeState.threadId,
      createdAt: "2026-07-27T06:00:00.000Z",
      reason: "server-closed",
    } satisfies RealtimeVoiceEvent;
    const launch = reduceRealtimeVoiceLaunchStateForEvent(startingLaunch, event);

    expect(launch).toEqual({ pending: false, handoffComplete: false });
    expect(
      projectRealtimeVoiceLaunchUi({
        launch,
        state: startingState,
        threadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
      }).overlayVisible,
    ).toBe(false);
  });

  it("keeps an inactive renderer error on the recoverable retry and back surface", () => {
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: idleLaunch,
        state: inactiveState,
        threadId: THREAD_ID,
        error: "The microphone transport was interrupted.",
        presentationSurface: "main-thread",
      }),
    ).toEqual({ connected: false, failed: true, overlayVisible: true });
  });

  it("turns a local media fatal into a terminal failed state before cleanup", () => {
    const failure = createRealtimeVoiceFatalFailure({
      state: activeState,
      currentThreadId: THREAD_ID,
      sessionId: activeState.sessionId,
      message: "The microphone transport was interrupted.",
    });

    expect(failure).toMatchObject({
      state: {
        phase: "failed",
        threadId: THREAD_ID,
        sessionId: activeState.sessionId,
        activity: null,
        error: "The microphone transport was interrupted.",
      },
      pendingError: {
        message: "The microphone transport was interrupted.",
        sessionId: activeState.sessionId,
        threadId: THREAD_ID,
        recoverable: false,
      },
    });

    expect(
      resolveRealtimeVoiceRemoteTermination({
        previousState: failure.state,
        inactiveState,
        currentThreadId: THREAD_ID,
        pendingError: failure.pendingError,
        closedReason: "error",
      }),
    ).toMatchObject({
      failed: true,
      error: "The microphone transport was interrupted.",
      state: { phase: "failed", threadId: THREAD_ID },
    });
  });

  it("promotes only the active media owner when its task is no longer focused", () => {
    expect(
      shouldPromoteRealtimeVoiceToGlobalOverlay({
        state: activeState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "main-thread",
        globalOverlayAvailable: true,
        mediaOwnerActive: true,
      }),
    ).toBe(true);
    expect(
      shouldPromoteRealtimeVoiceToGlobalOverlay({
        state: activeState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "main-thread",
        globalOverlayAvailable: true,
        mediaOwnerActive: false,
      }),
    ).toBe(false);
    expect(
      shouldPromoteRealtimeVoiceToGlobalOverlay({
        state: activeState,
        currentThreadId: THREAD_ID,
        presentationSurface: "main-thread",
        globalOverlayAvailable: true,
        mediaOwnerActive: true,
      }),
    ).toBe(false);
  });

  it("returns the same active media owner to the main thread when its task is reopened", () => {
    expect(
      shouldReturnRealtimeVoiceToMainThread({
        state: activeState,
        currentThreadId: THREAD_ID,
        presentationSurface: "global-overlay",
        mediaOwnerActive: true,
        presentationHandoff: null,
      }),
    ).toBe(true);
    expect(
      shouldReturnRealtimeVoiceToMainThread({
        state: activeState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "global-overlay",
        mediaOwnerActive: true,
        presentationHandoff: null,
      }),
    ).toBe(false);
    expect(
      shouldReturnRealtimeVoiceToMainThread({
        state: activeState,
        currentThreadId: THREAD_ID,
        presentationSurface: "global-overlay",
        mediaOwnerActive: true,
        presentationHandoff: {
          sequence: 1,
          from: "main-thread",
          origin: null,
          velocity: null,
        },
      }),
    ).toBe(false);
  });

  it("keeps the global toggle bound to the detached media owner after a task switch", () => {
    expect(
      realtimeVoiceToggleAction({
        state: activeState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "global-overlay",
        presentationOwner: true,
      }),
    ).toBe("stop");
    expect(
      realtimeVoiceToggleAction({
        state: activeState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "global-overlay",
        presentationOwner: false,
      }),
    ).toBeNull();
    expect(
      realtimeVoiceToggleAction({
        state: { ...activeState, phase: "failed" },
        currentThreadId: THREAD_ID,
        presentationSurface: "global-overlay",
        presentationOwner: true,
      }),
    ).toBe("stop");
    expect(
      realtimeVoiceToggleAction({
        state: inactiveState,
        currentThreadId: OTHER_THREAD_ID,
        presentationSurface: "main-thread",
        presentationOwner: false,
      }),
    ).toBe("start");
  });

  it("lets the claim select websocket media without a transport-change retry", () => {
    const candidates = { webrtc: { id: "rtc" }, websocketPcm16: { id: "wss" } } as const;

    expect(selectRealtimeVoiceTransportCandidate("websocket-pcm16", candidates)).toEqual({
      selected: candidates.websocketPcm16,
      standby: candidates.webrtc,
    });
    expect(selectRealtimeVoiceTransportCandidate("webrtc", candidates)).toEqual({
      selected: candidates.webrtc,
      standby: candidates.websocketPcm16,
    });
  });

  it("rejects stale client-state responses from an older report or generation", () => {
    const latestSnapshot = {
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: true,
      outputMuted: false,
    } as const;
    const base = {
      reportGeneration: 8,
      currentGeneration: 8,
      reportSequence: 12,
      latestReportSequence: 12,
      sessionId: "private-session",
      ownedSessionId: "private-session",
      reportedSnapshot: latestSnapshot,
      latestSnapshot,
    } as const;

    expect(isRealtimeVoiceClientStateResponseCurrent(base)).toBe(true);
    expect(
      isRealtimeVoiceClientStateResponseCurrent({
        ...base,
        reportSequence: 11,
      }),
    ).toBe(false);
    expect(
      isRealtimeVoiceClientStateResponseCurrent({
        ...base,
        currentGeneration: 9,
      }),
    ).toBe(false);
    expect(
      isRealtimeVoiceClientStateResponseCurrent({
        ...base,
        latestSnapshot: { ...latestSnapshot, inputMuted: false },
      }),
    ).toBe(false);
  });

  it("applies a Settings microphone change only to the active media owner", () => {
    expect(
      shouldApplyRealtimeVoiceInputPreference({
        phase: "active",
        mediaOwnerActive: true,
        selectedDeviceId: "old-mic",
        preferredDeviceId: "new-mic",
      }),
    ).toBe(true);
    expect(
      shouldApplyRealtimeVoiceInputPreference({
        phase: "active",
        mediaOwnerActive: false,
        selectedDeviceId: "old-mic",
        preferredDeviceId: "new-mic",
      }),
    ).toBe(false);
    expect(
      shouldApplyRealtimeVoiceInputPreference({
        phase: "active",
        mediaOwnerActive: true,
        selectedDeviceId: "new-mic",
        preferredDeviceId: "new-mic",
      }),
    ).toBe(false);
  });

  it("does not render or bind active controls from a same-task non-owner pane", () => {
    expect(
      shouldRenderRealtimeVoiceMainThreadPresentation({
        state: activeState,
        currentThreadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
        presentationOwner: false,
      }),
    ).toBe(false);
    expect(
      shouldRenderRealtimeVoiceMainThreadPresentation({
        state: activeState,
        currentThreadId: THREAD_ID,
        error: null,
        presentationSurface: "main-thread",
        presentationOwner: true,
      }),
    ).toBe(true);
    expect(
      realtimeVoiceToggleAction({
        state: activeState,
        currentThreadId: THREAD_ID,
        presentationSurface: "main-thread",
        presentationOwner: false,
      }),
    ).toBeNull();
  });

  it("announces the Moss quota warning once for the owned session and retains stop urgency", () => {
    const announcedKeys = new Set<string>();
    const announcement = projectRealtimeVoiceQuotaWarning({
      threadId: THREAD_ID,
      sessionId: "private-session",
      ownedSessionId: "private-session",
      willStopAfterCurrentResponse: true,
      announcedKeys,
    });

    expect(announcement).toEqual({
      key: `${THREAD_ID}:private-session`,
      threadId: THREAD_ID,
      text: MOSS_REALTIME_VOICE_QUOTA_WARNING,
      description: "Moss will finish the current response before ending this voice chat.",
    });
    expect(MOSS_REALTIME_VOICE_QUOTA_WARNING).toBe(
      "You’re approaching your Moss usage limit, so this voice chat may end soon",
    );
    if (announcement) announcedKeys.add(announcement.key);
    expect(
      projectRealtimeVoiceQuotaWarning({
        threadId: THREAD_ID,
        sessionId: "private-session",
        ownedSessionId: "private-session",
        willStopAfterCurrentResponse: false,
        announcedKeys,
      }),
    ).toBeNull();
    expect(
      projectRealtimeVoiceQuotaWarning({
        threadId: THREAD_ID,
        sessionId: "other-session",
        ownedSessionId: "private-session",
        willStopAfterCurrentResponse: false,
        announcedKeys: new Set(),
      }),
    ).toBeNull();
  });

  it("shows the quota toast and safely queues its emergency speech", async () => {
    const announcement = {
      key: `${THREAD_ID}:private-session`,
      threadId: THREAD_ID,
      text: MOSS_REALTIME_VOICE_QUOTA_WARNING,
      description: undefined,
    } as const;
    const showToast = vi.fn();
    const appendSpeech = vi.fn(async () => Promise.reject(new Error("relay unavailable")));

    await expect(
      deliverRealtimeVoiceQuotaWarning({
        announcement,
        sessionId: "private-session",
        showToast,
        appendSpeech,
      }),
    ).resolves.toBeUndefined();
    expect(showToast).toHaveBeenCalledOnce();
    expect(showToast).toHaveBeenCalledWith(announcement);
    expect(appendSpeech).toHaveBeenCalledWith("private-session", MOSS_REALTIME_VOICE_QUOTA_WARNING);
  });

  it("preserves a provider error as a failed presentation after the relay closes", () => {
    const resolution = resolveRealtimeVoiceRemoteTermination({
      previousState: startingState,
      inactiveState,
      currentThreadId: THREAD_ID,
      pendingError: {
        message: "The realtime provider disconnected.",
        sessionId: activeState.sessionId,
        threadId: THREAD_ID,
        recoverable: false,
      },
      closedReason: "server-closed",
    });

    expect(resolution).toMatchObject({
      error: "The realtime provider disconnected.",
      failed: true,
      state: {
        phase: "failed",
        sessionId: null,
        threadId: THREAD_ID,
        ownerClaimId: null,
        activity: null,
        error: "The realtime provider disconnected.",
      },
    });
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: idleLaunch,
        state: resolution.state,
        threadId: THREAD_ID,
        error: resolution.error,
        presentationSurface: "main-thread",
      }),
    ).toEqual({ connected: false, failed: true, overlayVisible: true });
    expect(
      projectRealtimeVoiceOverlaySnapshot({
        state: resolution.state,
        error: resolution.error,
        presentationSurface: "global-overlay",
      }),
    ).toMatchObject({
      phase: "failed",
      error: translateMoss("en", "realtimeVoice.error.networkUnavailable"),
    });
  });

  it("keeps the terminal error surface through error, closed(error), then inactive", () => {
    const pendingError = {
      message: "The realtime provider disconnected.",
      sessionId: activeState.sessionId,
      threadId: THREAD_ID,
      recoverable: false,
    } as const;
    const afterClosed = resolveRealtimeVoiceRemoteTermination({
      previousState: activeState,
      inactiveState,
      currentThreadId: THREAD_ID,
      pendingError,
      closedReason: "error",
    });
    expect(afterClosed).toMatchObject({
      failed: true,
      error: pendingError.message,
      state: { phase: "failed", threadId: THREAD_ID, error: pendingError.message },
    });

    // The closed handler has consumed the pending marker by the time the
    // authoritative inactive state arrives.
    const afterInactive = resolveRealtimeVoiceRemoteTermination({
      previousState: afterClosed.state,
      inactiveState,
      currentThreadId: THREAD_ID,
      pendingError: null,
      closedReason: null,
    });

    expect(afterInactive).toEqual(afterClosed);
    expect(
      projectRealtimeVoiceLaunchUi({
        launch: idleLaunch,
        state: afterInactive.state,
        threadId: THREAD_ID,
        error: afterInactive.error,
        presentationSurface: "main-thread",
      }),
    ).toEqual({ connected: false, failed: true, overlayVisible: true });
    expect(
      shouldRenderRealtimeVoiceMainThreadPresentation({
        state: afterInactive.state,
        currentThreadId: THREAD_ID,
        error: afterInactive.error,
        presentationSurface: "main-thread",
        presentationOwner: true,
      }),
    ).toBe(true);
  });

  it("preserves the last recoverable provider error when an abnormal close follows", () => {
    const resolution = resolveRealtimeVoiceRemoteTermination({
      previousState: { ...activeState, error: null },
      inactiveState,
      currentThreadId: THREAD_ID,
      pendingError: {
        message: "The relay is reconnecting.",
        sessionId: activeState.sessionId,
        threadId: THREAD_ID,
        recoverable: true,
      },
      closedReason: "server-closed",
    });

    expect(resolution).toMatchObject({
      failed: true,
      error: "The relay is reconnecting.",
      state: { phase: "failed", error: "The relay is reconnecting." },
    });
  });

  it("keeps a recoverable local startup failure visible while its claim resets", () => {
    const resolution = resolveRealtimeVoiceRemoteTermination({
      previousState: {
        ...startingState,
        phase: "failed",
        error: "Moss could not start the microphone. (NotFoundError)",
      },
      inactiveState,
      currentThreadId: THREAD_ID,
      pendingError: {
        message: "Moss could not start the microphone. (NotFoundError)",
        sessionId: null,
        threadId: THREAD_ID,
        recoverable: true,
      },
      closedReason: null,
    });

    expect(resolution).toMatchObject({
      failed: true,
      error: "Moss could not start the microphone. (NotFoundError)",
      state: {
        phase: "failed",
        threadId: THREAD_ID,
        error: "Moss could not start the microphone. (NotFoundError)",
      },
    });
  });

  it.each(["user", "inactivity"] as const)(
    "clears a recoverable provider warning for a normal %s close",
    (closedReason) => {
      expect(
        resolveRealtimeVoiceRemoteTermination({
          previousState: { ...activeState, error: null },
          inactiveState,
          currentThreadId: THREAD_ID,
          pendingError: {
            message: "The relay is reconnecting.",
            sessionId: activeState.sessionId,
            threadId: THREAD_ID,
            recoverable: true,
          },
          closedReason,
        }),
      ).toEqual({ state: inactiveState, error: null, failed: false });
    },
  );
});
