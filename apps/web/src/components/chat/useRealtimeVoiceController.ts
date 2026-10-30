// FILE: useRealtimeVoiceController.ts
// Purpose: Coordinate the regional renderer media transport with the server-owned Realtime Voice state.
// Layer: Chat composer controller

import {
  type DesktopRealtimeVoiceOverlayCommand,
  type DesktopRealtimeVoiceOverlayHandoff,
  type DesktopRealtimeVoiceOverlayPublication,
  type DesktopRealtimeVoiceOverlaySnapshot,
  type RealtimeVoiceDescriptor,
  type RealtimeVoiceEvent,
  type RealtimeVoiceId,
  type RealtimeVoiceLaunchSource,
  type RealtimeVoiceQuotaSnapshot,
  type RealtimeVoiceState,
  type RealtimeVoiceStopReason,
  type RealtimeVoiceTransportPreference,
  type ThreadId,
} from "@synara/contracts";
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";

import { useTranslation } from "../../localization";
import {
  RealtimeVoiceWebRtcClient,
  type RealtimeVoiceWebRtcCallbacks,
  type RealtimeVoiceOutputSignal,
  type RealtimeVoiceWebRtcSnapshot,
} from "../../lib/realtimeVoiceWebRtc";
import { RealtimeVoiceWebSocketClient } from "../../lib/realtimeVoiceWebSocket";
import { readNativeApi } from "../../nativeApi";
import { playRealtimeVoiceCue } from "../../lib/realtimeVoiceCue";
import {
  DEFAULT_REALTIME_VOICE,
  keyboardEventMatchesRealtimeVoiceShortcut,
  readRealtimeVoiceInputDevicePreference,
  readPersistedRealtimeVoicePreference,
  readRealtimeVoicePreference,
  readRealtimeVoiceScreenContextPreference,
  readRealtimeVoiceShortcutPreference,
  writeRealtimeVoiceInputDevicePreference,
  writeRealtimeVoicePreference,
} from "../../lib/realtimeVoicePreferences";
import { encodeRealtimeVoiceScreenContext } from "../../lib/realtimeVoiceScreenContext";
import { toastManager } from "../ui/toast";
import type {
  RealtimeVoiceDetachMotion,
  RealtimeVoiceHandoffMotion,
  RealtimeVoicePresentationSurface,
} from "./RealtimeVoiceHandoffTarget";
import {
  presentRealtimeVoiceError,
  type RealtimeVoiceTranslate,
} from "./realtimeVoiceErrorPresentation";

export {
  classifyRealtimeVoicePresentationError,
  presentRealtimeVoiceError,
} from "./realtimeVoiceErrorPresentation";

const ZERO_SIGNAL: RealtimeVoiceOutputSignal = { low: 0, mid: 0, high: 0, overall: 0 };
const REALTIME_VOICE_REMOTE_STOP_TIMEOUT_MS = 1_500;
type RealtimeVoiceMediaClient = RealtimeVoiceWebRtcClient | RealtimeVoiceWebSocketClient;
let realtimeVoiceOverlayPublisher: symbol | null = null;
let realtimeVoiceMediaOwnerPublisher: symbol | null = null;

export const MOSS_REALTIME_VOICE_QUOTA_WARNING =
  "You’re approaching your Moss usage limit, so this voice chat may end soon";

export function selectRealtimeVoiceTransportCandidate<TWebRtc, TWebSocket>(
  preferredTransport: RealtimeVoiceTransportPreference,
  candidates: {
    readonly webrtc: TWebRtc;
    readonly websocketPcm16: TWebSocket;
  },
): {
  readonly selected: TWebRtc | TWebSocket;
  readonly standby: TWebRtc | TWebSocket;
} {
  return preferredTransport === "websocket-pcm16"
    ? { selected: candidates.websocketPcm16, standby: candidates.webrtc }
    : { selected: candidates.webrtc, standby: candidates.websocketPcm16 };
}

export function isRealtimeVoiceClientStateResponseCurrent(input: {
  readonly reportGeneration: number;
  readonly currentGeneration: number;
  readonly reportSequence: number;
  readonly latestReportSequence: number;
  readonly sessionId: string;
  readonly ownedSessionId: string | null;
  readonly reportedSnapshot: RealtimeVoiceWebRtcSnapshot;
  readonly latestSnapshot: RealtimeVoiceWebRtcSnapshot;
}): boolean {
  const reported = input.reportedSnapshot;
  const latest = input.latestSnapshot;
  return (
    input.reportGeneration === input.currentGeneration &&
    input.reportSequence === input.latestReportSequence &&
    input.sessionId === input.ownedSessionId &&
    reported.webRtcConnected === latest.webRtcConnected &&
    reported.dataSessionInitialized === latest.dataSessionInitialized &&
    reported.inputMuted === latest.inputMuted &&
    reported.outputMuted === latest.outputMuted
  );
}

export function realtimeVoiceEventTargetsOwnedCall(input: {
  readonly eventSessionId: string | null;
  readonly eventThreadId: ThreadId | null;
  readonly ownedSessionId: string | null;
  readonly ownerThreadId: ThreadId | null;
  readonly currentThreadId: ThreadId;
}): boolean {
  if (input.ownedSessionId !== null) {
    return (
      input.eventSessionId === input.ownedSessionId &&
      (input.ownerThreadId === null || input.eventThreadId === input.ownerThreadId)
    );
  }
  return input.eventThreadId === (input.ownerThreadId ?? input.currentThreadId);
}

export function shouldApplyRealtimeVoiceInputPreference(input: {
  readonly phase: RealtimeVoiceState["phase"];
  readonly mediaOwnerActive: boolean;
  readonly selectedDeviceId: string | null;
  readonly preferredDeviceId: string | null;
}): boolean {
  return (
    input.phase === "active" &&
    input.mediaOwnerActive &&
    input.selectedDeviceId !== input.preferredDeviceId
  );
}

export function projectRealtimeVoiceQuotaWarning(input: {
  readonly threadId: ThreadId | null;
  readonly sessionId: string | null;
  readonly ownedSessionId: string | null;
  readonly willStopAfterCurrentResponse: boolean;
  readonly announcedKeys: ReadonlySet<string>;
}): {
  readonly key: string;
  readonly threadId: ThreadId;
  readonly text: string;
  readonly description: string | undefined;
} | null {
  if (
    input.threadId === null ||
    input.sessionId === null ||
    input.sessionId !== input.ownedSessionId
  ) {
    return null;
  }
  const key = `${input.threadId}:${input.sessionId}`;
  if (input.announcedKeys.has(key)) return null;
  return {
    key,
    threadId: input.threadId,
    text: MOSS_REALTIME_VOICE_QUOTA_WARNING,
    description: input.willStopAfterCurrentResponse
      ? "Moss will finish the current response before ending this voice chat."
      : undefined,
  };
}

export async function deliverRealtimeVoiceQuotaWarning(input: {
  readonly announcement: NonNullable<ReturnType<typeof projectRealtimeVoiceQuotaWarning>>;
  readonly sessionId: string;
  readonly showToast: (
    announcement: NonNullable<ReturnType<typeof projectRealtimeVoiceQuotaWarning>>,
  ) => void;
  readonly appendSpeech: (sessionId: string, text: string) => Promise<unknown>;
}): Promise<void> {
  try {
    input.showToast(input.announcement);
  } catch {
    // A toast provider failure must not suppress the in-call warning.
  }
  await input.appendSpeech(input.sessionId, input.announcement.text).catch(() => undefined);
}

export async function stopRealtimeVoiceRemoteBeforeDisposal(input: {
  readonly quiesceMedia?: () => void;
  readonly stopRemote: () => Promise<unknown>;
  readonly disposeMedia: () => Promise<void>;
  readonly timeoutMs?: number;
}): Promise<void> {
  let timeout: ReturnType<typeof setTimeout> | null = null;
  try {
    try {
      input.quiesceMedia?.();
    } catch {
      // Remote stop and final disposal remain authoritative if muting fails.
    }
    await Promise.race([
      input.stopRemote(),
      new Promise<void>((resolve) => {
        timeout = setTimeout(resolve, input.timeoutMs ?? REALTIME_VOICE_REMOTE_STOP_TIMEOUT_MS);
      }),
    ]).catch(() => undefined);
  } finally {
    if (timeout) clearTimeout(timeout);
    await input.disposeMedia();
  }
}

export interface RealtimeVoiceLaunchHandoffState {
  readonly pending: boolean;
  readonly handoffComplete: boolean;
}

export interface RealtimeVoicePendingRemoteError {
  readonly message: string;
  readonly code?: string | null;
  readonly sessionId: string | null;
  readonly threadId: ThreadId | null;
  readonly recoverable: boolean;
}

const IDLE_REALTIME_VOICE_LAUNCH_STATE: RealtimeVoiceLaunchHandoffState = {
  pending: false,
  handoffComplete: false,
};

const CONNECTING_REALTIME_VOICE_LAUNCH_STATE: RealtimeVoiceLaunchHandoffState = {
  pending: true,
  handoffComplete: false,
};

function inactiveState(): RealtimeVoiceState {
  return {
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
}

function presentRealtimeVoiceState(
  state: RealtimeVoiceState,
  translate?: RealtimeVoiceTranslate,
  code?: string | null,
): RealtimeVoiceState {
  if (!state.error) return state;
  return {
    ...state,
    error: presentRealtimeVoiceError(
      { cause: state.error, ...(code !== undefined ? { code } : {}) },
      translate,
    ),
  };
}

export function realtimeVoicePresentationSurfaceForLaunch(
  source: RealtimeVoiceLaunchSource,
  globalOverlayAvailable: boolean,
): RealtimeVoicePresentationSurface {
  return source === "global-hotkey" && globalOverlayAvailable ? "global-overlay" : "main-thread";
}

export function projectRealtimeVoiceOverlaySnapshot(input: {
  readonly state: RealtimeVoiceState;
  readonly error: string | null;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly audioSignal?: RealtimeVoiceOutputSignal | null;
  readonly translate?: RealtimeVoiceTranslate;
}): DesktopRealtimeVoiceOverlaySnapshot | null {
  if (input.presentationSurface !== "global-overlay" || input.state.phase === "inactive") {
    return null;
  }
  const rawError = input.error ?? input.state.error;
  const snapshot: DesktopRealtimeVoiceOverlaySnapshot = {
    phase: input.state.phase,
    activity: input.state.activity,
    inputMuted: input.state.inputMuted,
    outputMuted: input.state.outputMuted,
    error:
      rawError === null ? null : presentRealtimeVoiceError({ cause: rawError }, input.translate),
  };
  return input.audioSignal === undefined
    ? snapshot
    : { ...snapshot, audioSignal: input.audioSignal };
}

export function createRealtimeVoiceOverlayPublication(input: {
  readonly state: RealtimeVoiceState;
  readonly error: string | null;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly mediaOwnerActive: boolean;
  readonly handoff: RealtimeVoiceHandoffMotion | null;
  readonly audioSignal?: RealtimeVoiceOutputSignal | null;
  readonly translate?: RealtimeVoiceTranslate;
}): DesktopRealtimeVoiceOverlayPublication {
  return {
    snapshot: projectRealtimeVoiceOverlaySnapshot(input),
    mediaOwnerActive: input.mediaOwnerActive,
    handoff:
      input.presentationSurface === "global-overlay" && input.handoff?.from === "main-thread"
        ? input.handoff
        : null,
  };
}

export function dispatchRealtimeVoiceOverlayCommand(
  command: DesktopRealtimeVoiceOverlayCommand,
  handlers: {
    readonly toggle: () => void;
    readonly stop: () => void;
    readonly toggleInputMute: () => void;
    readonly toggleOutputMute: () => void;
    readonly focus: () => void;
    readonly handoff: () => void;
  },
): void {
  switch (command) {
    case "toggle":
      handlers.toggle();
      return;
    case "stop":
      handlers.stop();
      return;
    case "toggle-input-mute":
      handlers.toggleInputMute();
      return;
    case "toggle-output-mute":
      handlers.toggleOutputMute();
      return;
    case "focus":
      handlers.focus();
      return;
    case "handoff":
      handlers.handoff();
      return;
  }
}

export function reduceRealtimeVoiceLaunchStateForEvent(
  current: RealtimeVoiceLaunchHandoffState,
  event: RealtimeVoiceEvent,
): RealtimeVoiceLaunchHandoffState {
  return event.type === "closed" || (event.type === "state" && event.state.phase === "inactive")
    ? IDLE_REALTIME_VOICE_LAUNCH_STATE
    : current;
}

export function projectRealtimeVoiceLaunchUi(input: {
  readonly launch: RealtimeVoiceLaunchHandoffState;
  readonly state: RealtimeVoiceState;
  readonly threadId: ThreadId;
  readonly error: string | null;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly launchSource?: RealtimeVoiceLaunchSource | null;
}): {
  readonly connected: boolean;
  readonly failed: boolean;
  readonly overlayVisible: boolean;
} {
  const isCurrentThread = input.state.threadId === input.threadId;
  const belongsToCurrentThread = input.state.threadId === null || isCurrentThread;
  const failed =
    (isCurrentThread && input.state.phase === "failed") ||
    (belongsToCurrentThread &&
      input.error !== null &&
      (input.launch.pending || input.state.phase === "inactive"));
  const launchSource = input.state.source ?? input.launchSource ?? null;
  return {
    connected: input.launch.pending && isCurrentThread && input.state.phase === "active",
    failed,
    overlayVisible:
      input.presentationSurface === "main-thread" &&
      belongsToCurrentThread &&
      (failed ||
        (launchSource !== "composer-existing" &&
          input.launch.pending &&
          !input.launch.handoffComplete)),
  };
}

export function shouldPromoteRealtimeVoiceToGlobalOverlay(input: {
  readonly state: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly globalOverlayAvailable: boolean;
  readonly mediaOwnerActive: boolean;
}): boolean {
  return (
    input.mediaOwnerActive &&
    input.globalOverlayAvailable &&
    input.presentationSurface === "main-thread" &&
    input.state.phase === "active" &&
    input.state.threadId !== null &&
    input.state.threadId !== input.currentThreadId
  );
}

export function shouldReturnRealtimeVoiceToMainThread(input: {
  readonly state: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly mediaOwnerActive: boolean;
  readonly presentationHandoff: RealtimeVoiceHandoffMotion | null;
}): boolean {
  return (
    input.mediaOwnerActive &&
    input.presentationSurface === "global-overlay" &&
    input.presentationHandoff === null &&
    input.state.phase === "active" &&
    input.state.threadId !== null &&
    input.state.threadId === input.currentThreadId
  );
}

export function shouldRenderRealtimeVoiceMainThreadPresentation(input: {
  readonly state: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly error: string | null;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly presentationOwner: boolean;
}): boolean {
  if (!input.presentationOwner || input.presentationSurface !== "main-thread") return false;
  return (
    (input.state.threadId === input.currentThreadId && input.state.phase !== "inactive") ||
    (input.state.phase === "inactive" && input.error !== null)
  );
}

export function realtimeVoiceToggleAction(input: {
  readonly state: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly presentationOwner: boolean;
}): "start" | "stop" | null {
  if (input.state.phase !== "inactive" && input.presentationOwner) {
    return "stop";
  }
  if (input.state.phase === "inactive" || input.state.phase === "failed") return "start";
  return null;
}

export function createRealtimeVoiceFatalFailure(input: {
  readonly state: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly sessionId: string | null;
  readonly message: string;
}): {
  readonly state: RealtimeVoiceState;
  readonly pendingError: RealtimeVoicePendingRemoteError;
} {
  const threadId = input.state.threadId ?? input.currentThreadId;
  return {
    state: {
      ...input.state,
      phase: "failed",
      threadId,
      activity: null,
      error: input.message,
    },
    pendingError: {
      message: input.message,
      sessionId: input.sessionId,
      threadId,
      recoverable: false,
    },
  };
}

export function resolveRealtimeVoiceRemoteTermination(input: {
  readonly previousState: RealtimeVoiceState;
  readonly inactiveState: RealtimeVoiceState;
  readonly currentThreadId: ThreadId;
  readonly pendingError: RealtimeVoicePendingRemoteError | null;
  readonly closedReason: RealtimeVoiceStopReason | null;
}): {
  readonly state: RealtimeVoiceState;
  readonly error: string | null;
  readonly failed: boolean;
} {
  const reasonIsFailure =
    input.closedReason === "error" ||
    input.closedReason === "server-closed" ||
    input.closedReason === "startup-failed";
  // A terminal close is commonly followed by the relay's authoritative
  // inactive snapshot. Once the close has resolved to failed, keep that
  // presentation sticky until Retry or Dismiss explicitly replaces it.
  const previousFailureIsTerminal = input.previousState.phase === "failed";
  const terminalPendingError =
    input.pendingError !== null &&
    (!input.pendingError.recoverable || reasonIsFailure || previousFailureIsTerminal)
      ? input.pendingError
      : null;
  const error =
    terminalPendingError?.message ??
    input.inactiveState.error ??
    (reasonIsFailure || previousFailureIsTerminal ? input.previousState.error : null);
  if (
    !terminalPendingError &&
    !input.inactiveState.error &&
    !reasonIsFailure &&
    !previousFailureIsTerminal
  ) {
    return { state: input.inactiveState, error: null, failed: false };
  }
  const previous = input.previousState;
  return {
    state: {
      ...previous,
      phase: "failed",
      sessionId: null,
      threadId: input.pendingError?.threadId ?? previous.threadId ?? input.currentThreadId,
      ownerClaimId: null,
      activity: null,
      error,
    },
    error,
    failed: true,
  };
}

async function listAudioInputs(): Promise<readonly MediaDeviceInfo[]> {
  if (!navigator.mediaDevices?.enumerateDevices) return [];
  const devices = await navigator.mediaDevices.enumerateDevices();
  return devices.filter((device) => device.kind === "audioinput");
}

async function resolveScreenContextTool(
  event: Extract<RealtimeVoiceEvent, { type: "tool-request" }>,
): Promise<void> {
  const sessionId = event.sessionId;
  if (!sessionId || event.name !== "capture_screen_context") return;
  const api = readNativeApi();
  if (!api) return;
  const reject = async (reason: string) => {
    await api.realtimeVoice.resolveScreenContext({
      sessionId,
      callId: event.callId,
      accepted: false,
      reason,
      capturedAt: null,
      sourceAppName: null,
      sourceBundleIdentifier: null,
      sourceWindowTitle: null,
      imageDataUrl: null,
    });
  };
  if (!readRealtimeVoiceScreenContextPreference()) {
    await reject("screen_context_disabled");
    return;
  }
  const captureScreenContext = window.desktopBridge?.realtimeVoice?.captureScreenContext;
  if (!captureScreenContext) {
    await reject("screen_context_unavailable");
    return;
  }
  try {
    const encoded = await encodeRealtimeVoiceScreenContext(await captureScreenContext());
    await api.realtimeVoice.resolveScreenContext({
      sessionId,
      callId: event.callId,
      accepted: true,
      reason: null,
      ...encoded,
    });
  } catch {
    await reject("screen_context_capture_failed").catch(() => undefined);
  }
}

export interface UseRealtimeVoiceControllerOptions {
  readonly threadId: ThreadId;
  readonly disabled: boolean;
  readonly source: RealtimeVoiceLaunchSource;
  readonly prepareThread?: () => Promise<void>;
  readonly focusThread?: (threadId: ThreadId) => void | Promise<void>;
  readonly ownsDesktopSurface?: boolean;
}

export interface UseRealtimeVoiceControllerResult {
  readonly state: RealtimeVoiceState;
  readonly voices: readonly RealtimeVoiceDescriptor[];
  readonly selectedVoice: RealtimeVoiceId;
  readonly inputDevices: readonly MediaDeviceInfo[];
  readonly selectedInputDeviceId: string | null;
  readonly transcript: string;
  readonly quota: RealtimeVoiceQuotaSnapshot | null;
  readonly error: string | null;
  readonly isCurrentThread: boolean;
  readonly isVisible: boolean;
  readonly isMainThreadPresentationVisible: boolean;
  readonly isLaunchOverlayVisible: boolean;
  readonly isLaunchConnected: boolean;
  readonly launchFailed: boolean;
  readonly launchHandoffComplete: boolean;
  readonly presentationSurface: RealtimeVoicePresentationSurface;
  readonly presentationHandoff: RealtimeVoiceHandoffMotion | null;
  readonly canDetachToGlobalOverlay: boolean;
  readonly canStart: boolean;
  readonly readOutputSignal: () => RealtimeVoiceOutputSignal;
  /** Returns false only when the request was rejected before a launch attempt began. */
  readonly start: (source?: RealtimeVoiceLaunchSource) => Promise<boolean>;
  readonly stop: () => Promise<void>;
  readonly retry: () => Promise<void>;
  readonly dismissFailure: () => void;
  readonly completeLaunchHandoff: () => void;
  readonly detachToGlobalOverlay: (motion: RealtimeVoiceDetachMotion) => void;
  readonly openOwningThread: () => void;
  readonly setSelectedVoice: (voice: RealtimeVoiceId) => void;
  readonly setInputDevice: (deviceId: string | null) => Promise<void>;
  readonly toggleInputMuted: () => void;
  readonly toggleOutputMuted: () => void;
  readonly appendText: (text: string) => Promise<boolean>;
}

export function useRealtimeVoiceRuntimeController(
  options: UseRealtimeVoiceControllerOptions,
): UseRealtimeVoiceControllerResult {
  const { t } = useTranslation();
  const { disabled, focusThread, prepareThread, source: defaultSource, threadId } = options;
  const ownsDesktopSurface = options.ownsDesktopSurface ?? true;
  const [state, setState] = useState<RealtimeVoiceState>(inactiveState);
  const [voices, setVoices] = useState<readonly RealtimeVoiceDescriptor[]>([]);
  const [selectedVoice, setSelectedVoiceState] = useState<RealtimeVoiceId>(() =>
    typeof window === "undefined" ? DEFAULT_REALTIME_VOICE : readRealtimeVoicePreference(),
  );
  const [inputDevices, setInputDevices] = useState<readonly MediaDeviceInfo[]>([]);
  const [selectedInputDeviceId, setSelectedInputDeviceId] = useState<string | null>(() =>
    typeof window === "undefined" ? null : readRealtimeVoiceInputDevicePreference(),
  );
  const [transcript, setTranscript] = useState("");
  const [quota, setQuota] = useState<RealtimeVoiceQuotaSnapshot | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [launch, setLaunch] = useState<RealtimeVoiceLaunchHandoffState>(
    IDLE_REALTIME_VOICE_LAUNCH_STATE,
  );
  const launchPending = launch.pending;
  const launchHandoffComplete = launch.handoffComplete;
  const [presentationSurface, setPresentationSurface] =
    useState<RealtimeVoicePresentationSurface>("main-thread");
  const [presentationHandoff, setPresentationHandoff] = useState<RealtimeVoiceHandoffMotion | null>(
    null,
  );
  const [mediaOwnerActive, setMediaOwnerActiveState] = useState(false);
  const [presentationOwner, setPresentationOwnerState] = useState(false);
  const transcriptItemsRef = useRef(
    new Map<string, { readonly role: "user" | "assistant"; readonly text: string }>(),
  );
  const threadIdRef = useRef(threadId);
  const focusThreadRef = useRef(focusThread);
  const selectedVoiceRef = useRef(selectedVoice);
  const backendDefaultVoiceRef = useRef<RealtimeVoiceId>(DEFAULT_REALTIME_VOICE);
  const preferredTransportRef = useRef<RealtimeVoiceTransportPreference>("webrtc");
  const selectedInputDeviceIdRef = useRef(selectedInputDeviceId);
  const stateRef = useRef(state);
  const mediaRef = useRef<RealtimeVoiceMediaClient | null>(null);
  const pendingMediaCandidatesRef = useRef(new Set<RealtimeVoiceMediaClient>());
  const ownedClaimRef = useRef<string | null>(null);
  const ownedSessionRef = useRef<string | null>(null);
  const generationRef = useRef(0);
  const mountedRef = useRef(true);
  const stoppingRef = useRef(false);
  const mediaSnapshotRef = useRef<RealtimeVoiceWebRtcSnapshot>({
    webRtcConnected: false,
    dataSessionInitialized: false,
    inputMuted: false,
    outputMuted: false,
  });
  const outputSignalRef = useRef<RealtimeVoiceOutputSignal>(ZERO_SIGNAL);
  const mediaDisposalRef = useRef<Promise<void> | null>(null);
  const stopRef = useRef<() => Promise<void>>(async () => undefined);
  const mediaFatalRef = useRef<(error: unknown) => void>(() => undefined);
  const connectedCueArmedRef = useRef(false);
  const lastOutputMutedRef = useRef(false);
  const lastSourceRef = useRef<RealtimeVoiceLaunchSource>(defaultSource);
  const presentationSurfaceRef = useRef<RealtimeVoicePresentationSurface>("main-thread");
  const handoffSequenceRef = useRef(0);
  const controllerInstanceRef = useRef(Symbol("realtime-voice-controller"));
  const pendingRemoteErrorRef = useRef<RealtimeVoicePendingRemoteError | null>(null);
  const mediaOwnerActiveRef = useRef(false);
  const presentationOwnerRef = useRef(false);
  const publishedMediaOwnershipRef = useRef(false);
  const clientStateReportSequenceRef = useRef(0);
  const quotaWarningAnnouncementKeysRef = useRef(new Set<string>());
  const translateRef = useRef<RealtimeVoiceTranslate>(t);
  const pendingThreadFocusRef = useRef<{
    readonly threadId: ThreadId;
    readonly animateHandoff: boolean;
    readonly handoff: DesktopRealtimeVoiceOverlayHandoff | null;
  } | null>(null);

  useLayoutEffect(() => {
    threadIdRef.current = threadId;
    focusThreadRef.current = focusThread;
    selectedVoiceRef.current = selectedVoice;
    selectedInputDeviceIdRef.current = selectedInputDeviceId;
    stateRef.current = state;
    presentationSurfaceRef.current = presentationSurface;
    translateRef.current = t;
  }, [focusThread, presentationSurface, selectedInputDeviceId, selectedVoice, state, t, threadId]);

  const refreshInputDevices = useCallback(() => {
    void listAudioInputs()
      .then((devices) => {
        if (mountedRef.current) setInputDevices(devices);
      })
      .catch(() => {
        if (mountedRef.current) setInputDevices([]);
      });
  }, []);

  const setMediaOwnerActive = useCallback((active: boolean) => {
    mediaOwnerActiveRef.current = active;
    if (mountedRef.current) setMediaOwnerActiveState(active);
  }, []);

  const setPresentationOwner = useCallback((active: boolean) => {
    presentationOwnerRef.current = active;
    if (mountedRef.current) setPresentationOwnerState(active);
  }, []);

  const disposeLocalMedia = useCallback(async () => {
    const media = mediaRef.current;
    const pendingCandidates = [...pendingMediaCandidatesRef.current];
    pendingMediaCandidatesRef.current.clear();
    if (!media && pendingCandidates.length === 0 && mediaDisposalRef.current) {
      await mediaDisposalRef.current;
      return;
    }
    mediaRef.current = null;
    mediaSnapshotRef.current = {
      webRtcConnected: false,
      dataSessionInitialized: false,
      inputMuted: false,
      outputMuted: false,
    };
    outputSignalRef.current = ZERO_SIGNAL;
    const disposal = Promise.resolve().then(async () => {
      const clients = new Set(pendingCandidates);
      if (media) clients.add(media);
      await Promise.allSettled([...clients].map((client) => client.dispose()));
    });
    mediaDisposalRef.current = disposal;
    try {
      await disposal;
    } finally {
      if (mediaDisposalRef.current === disposal) mediaDisposalRef.current = null;
    }
  }, []);

  const reportClientState = useCallback((snapshot: RealtimeVoiceWebRtcSnapshot) => {
    mediaSnapshotRef.current = snapshot;
    lastOutputMutedRef.current = snapshot.outputMuted;
    const sessionId = ownedSessionRef.current;
    const api = readNativeApi();
    if (!sessionId || !api) return;
    const reportGeneration = generationRef.current;
    const reportSequence = clientStateReportSequenceRef.current + 1;
    clientStateReportSequenceRef.current = reportSequence;
    const responseIsCurrent = () =>
      isRealtimeVoiceClientStateResponseCurrent({
        reportGeneration,
        currentGeneration: generationRef.current,
        reportSequence,
        latestReportSequence: clientStateReportSequenceRef.current,
        sessionId,
        ownedSessionId: ownedSessionRef.current,
        reportedSnapshot: snapshot,
        latestSnapshot: mediaSnapshotRef.current,
      });
    void api.realtimeVoice
      .reportClientState({ sessionId, ...snapshot })
      .then((nextState) => {
        if (!mountedRef.current || !responseIsCurrent()) return;
        stateRef.current = nextState;
        setState(nextState);
      })
      .catch(() => {
        if (responseIsCurrent()) {
          mediaFatalRef.current(new Error("Realtime Voice transport was interrupted."));
        }
      });
  }, []);

  const publishOverlayAudioSignal = useCallback((signal: RealtimeVoiceOutputSignal) => {
    outputSignalRef.current = signal;
    if (
      !presentationOwnerRef.current ||
      !mediaOwnerActiveRef.current ||
      presentationSurfaceRef.current !== "global-overlay"
    ) {
      return;
    }
    const overlay = window.desktopBridge?.realtimeVoice?.overlay;
    const currentState = stateRef.current;
    if (!overlay || currentState.phase === "inactive") return;
    void overlay
      .publish(
        createRealtimeVoiceOverlayPublication({
          state: currentState,
          error: currentState.error,
          presentationSurface: "global-overlay",
          mediaOwnerActive: true,
          handoff: null,
          audioSignal: signal,
          translate: translateRef.current,
        }),
      )
      .catch(() => undefined);
  }, []);

  const stop = useCallback(async () => {
    if (stoppingRef.current) return;
    stoppingRef.current = true;
    const previousState = stateRef.current;
    const pendingError = pendingRemoteErrorRef.current;
    const terminalError = pendingError !== null && !pendingError.recoverable ? pendingError : null;
    generationRef.current += 1;
    // Keep a fatal marker until the relay's terminal event consumes it. This
    // prevents a racing inactive event from briefly erasing the retry surface.
    pendingRemoteErrorRef.current = terminalError;
    if (mountedRef.current) {
      setLaunch(IDLE_REALTIME_VOICE_LAUNCH_STATE);
    }
    const api = readNativeApi();
    const sessionId = ownedSessionRef.current;
    const claimId = ownedClaimRef.current;
    ownedSessionRef.current = null;
    ownedClaimRef.current = null;
    if (mountedRef.current && stateRef.current.phase !== "inactive") {
      const stoppingState = { ...stateRef.current, phase: "stopping" as const };
      stateRef.current = stoppingState;
      setState(stoppingState);
    }
    await stopRealtimeVoiceRemoteBeforeDisposal({
      quiesceMedia: () => mediaRef.current?.setInputMuted(true),
      stopRemote: async () => {
        if (api && sessionId) {
          await api.realtimeVoice.stop({
            sessionId,
            reason: terminalError ? "error" : "user",
          });
        } else if (api && claimId) {
          await api.realtimeVoice.releaseClaim({ ownerClaimId: claimId });
        }
      },
      disposeMedia: disposeLocalMedia,
    }).catch(() => undefined);
    if (mountedRef.current) {
      const latest = presentRealtimeVoiceState(
        api ? await api.realtimeVoice.getState().catch(() => inactiveState()) : inactiveState(),
        translateRef.current,
        terminalError?.code,
      );
      const resolution = terminalError
        ? resolveRealtimeVoiceRemoteTermination({
            previousState,
            inactiveState: latest.phase === "inactive" ? latest : inactiveState(),
            currentThreadId: threadIdRef.current,
            pendingError: terminalError,
            closedReason: "error",
          })
        : { state: latest, error: null, failed: false };
      stateRef.current = resolution.state;
      setState(resolution.state);
      setError(resolution.error);
    }
    setMediaOwnerActive(false);
    if (!terminalError) setPresentationOwner(false);
    stoppingRef.current = false;
  }, [disposeLocalMedia, setMediaOwnerActive, setPresentationOwner]);

  useLayoutEffect(() => {
    stopRef.current = stop;
  }, [stop]);

  const handleMediaFatal = useCallback((fatalError: unknown) => {
    const message = presentRealtimeVoiceError({ cause: fatalError }, translateRef.current);
    const failure = createRealtimeVoiceFatalFailure({
      state: stateRef.current,
      currentThreadId: threadIdRef.current,
      sessionId: ownedSessionRef.current,
      message,
    });
    pendingRemoteErrorRef.current = failure.pendingError;
    stateRef.current = failure.state;
    if (mountedRef.current) {
      setState(failure.state);
      setError(message);
    }
    void stopRef.current();
  }, []);

  useLayoutEffect(() => {
    mediaFatalRef.current = handleMediaFatal;
  }, [handleMediaFatal]);

  const start = useCallback(
    async (sourceOverride?: RealtimeVoiceLaunchSource) => {
      if (
        disabled ||
        stoppingRef.current ||
        mediaRef.current ||
        pendingMediaCandidatesRef.current.size > 0
      ) {
        return false;
      }
      const source = sourceOverride ?? defaultSource;
      lastSourceRef.current = source;
      const nextPresentationSurface = realtimeVoicePresentationSurfaceForLaunch(
        source,
        window.desktopBridge?.realtimeVoice?.overlay !== undefined,
      );
      if (nextPresentationSurface === "global-overlay") {
        realtimeVoiceOverlayPublisher = controllerInstanceRef.current;
      }
      presentationSurfaceRef.current = nextPresentationSurface;
      setPresentationSurface(nextPresentationSurface);
      setPresentationOwner(true);
      setPresentationHandoff(null);
      setLaunch(CONNECTING_REALTIME_VOICE_LAUNCH_STATE);
      setError(null);
      pendingRemoteErrorRef.current = null;
      setTranscript("");
      transcriptItemsRef.current.clear();
      setQuota(null);
      quotaWarningAnnouncementKeysRef.current.clear();
      const api = readNativeApi();
      if (!api) {
        const message = presentRealtimeVoiceError(
          { cause: null, code: "VOICE_SERVER_NOT_CONNECTED" },
          translateRef.current,
        );
        const failedState: RealtimeVoiceState = {
          ...stateRef.current,
          phase: "failed",
          threadId,
          source,
          voice: selectedVoice,
          error: message,
        };
        stateRef.current = failedState;
        setState(failedState);
        setError(message);
        return true;
      }
      const generation = generationRef.current + 1;
      generationRef.current = generation;

      let claimId: string | null = null;
      let sessionId: string | null = null;
      let preferredTransport: RealtimeVoiceTransportPreference = preferredTransportRef.current;
      let media: RealtimeVoiceMediaClient | null = null;
      const mediaCallbacks: RealtimeVoiceWebRtcCallbacks = {
        onSnapshot: reportClientState,
        onOutputSignal: publishOverlayAudioSignal,
        onFatalError: (fatalError) => {
          if (generationRef.current !== generation) return;
          handleMediaFatal(fatalError);
        },
      };
      // Construct both candidates while the click/key activation is still on
      // the stack. Each constructor prewarms its AudioContext. Resolve and
      // prepare the regional media transport before taking the short-lived
      // presentation claim so a slow/no-device microphone probe cannot expire
      // an otherwise valid launch reservation.
      const candidates = {
        webrtc: new RealtimeVoiceWebRtcClient(mediaCallbacks),
        websocketPcm16: new RealtimeVoiceWebSocketClient(mediaCallbacks),
      } as const;
      pendingMediaCandidatesRef.current.add(candidates.webrtc);
      pendingMediaCandidatesRef.current.add(candidates.websocketPcm16);
      setMediaOwnerActive(true);

      const isStale = () => !mountedRef.current || generationRef.current !== generation;
      try {
        await prepareThread?.();
        if (isStale()) throw new Error("Realtime Voice start was cancelled.");
        const catalog = await api.realtimeVoice.listVoices();
        preferredTransport = catalog.preferredTransport;
        preferredTransportRef.current = preferredTransport;
        const selection = selectRealtimeVoiceTransportCandidate(preferredTransport, candidates);
        media = selection.selected;
        mediaRef.current = media;
        pendingMediaCandidatesRef.current.delete(selection.selected);
        pendingMediaCandidatesRef.current.delete(selection.standby);
        await selection.standby.dispose().catch(() => undefined);

        const prepared = await media.prepare(selectedInputDeviceId);
        if (prepared.inputDeviceId) {
          selectedInputDeviceIdRef.current = prepared.inputDeviceId;
          setSelectedInputDeviceId(prepared.inputDeviceId);
          writeRealtimeVoiceInputDevicePreference(prepared.inputDeviceId);
        }
        refreshInputDevices();
        if (isStale()) throw new Error("Realtime Voice start was cancelled.");

        const claim = await api.realtimeVoice.claim({
          threadId,
          source,
        });
        claimId = claim.ownerClaimId;
        ownedClaimRef.current = claimId;
        if (isStale()) throw new Error("Realtime Voice start was cancelled.");
        if (claim.preferredTransport !== preferredTransport) {
          throw new Error("The Realtime Voice regional media route changed during launch.");
        }

        const started = await api.realtimeVoice.start({
          ownerClaimId: claim.ownerClaimId,
          threadId,
          source,
          // `null` delegates to the backend-owned product default. Only an
          // explicit per-device choice overrides it.
          voice: readPersistedRealtimeVoicePreference(),
          transport:
            preferredTransport === "websocket-pcm16"
              ? { type: "websocket-pcm16" }
              : {
                  type: "webrtc",
                  sdp: (prepared as Awaited<ReturnType<RealtimeVoiceWebRtcClient["prepare"]>>)
                    .offerSdp,
                },
          outputModality: "audio",
        });
        sessionId = started.sessionId;
        ownedSessionRef.current = sessionId;
        if (isStale()) throw new Error("Realtime Voice start was cancelled.");
        if (preferredTransport === "websocket-pcm16") {
          if (
            !(media instanceof RealtimeVoiceWebSocketClient) ||
            started.transport.type !== "websocket-pcm16"
          ) {
            throw new Error("The Realtime relay returned the wrong regional media transport.");
          }
          await media.connect(started.transport);
        } else {
          if (
            !(media instanceof RealtimeVoiceWebRtcClient) ||
            started.transport.type !== "webrtc"
          ) {
            throw new Error("The Realtime relay returned the wrong regional media transport.");
          }
          await media.applyAnswer(started.transport.sdp);
        }
        reportClientState(media.snapshot);
      } catch (cause) {
        const message = presentRealtimeVoiceError({ cause }, translateRef.current);
        if (mountedRef.current && generationRef.current === generation) {
          pendingRemoteErrorRef.current = {
            message,
            sessionId,
            threadId,
            recoverable: true,
          };
          setError(message);
          const failedState: RealtimeVoiceState = {
            ...stateRef.current,
            phase: "failed",
            threadId,
            sessionId,
            ownerClaimId: claimId,
            voice: selectedVoice,
            error: message,
          };
          stateRef.current = failedState;
          setState(failedState);
        }
        ownedSessionRef.current = null;
        ownedClaimRef.current = null;
        await stopRealtimeVoiceRemoteBeforeDisposal({
          quiesceMedia: () => media?.setInputMuted(true),
          stopRemote: async () => {
            if (sessionId) {
              await api.realtimeVoice.stop({ sessionId, reason: "startup-failed" });
            } else if (claimId) {
              await api.realtimeVoice.releaseClaim({ ownerClaimId: claimId });
            }
          },
          disposeMedia: disposeLocalMedia,
        }).catch(() => undefined);
        if (generationRef.current === generation) setMediaOwnerActive(false);
      }
      return true;
    },
    [
      defaultSource,
      disabled,
      disposeLocalMedia,
      handleMediaFatal,
      prepareThread,
      publishOverlayAudioSignal,
      refreshInputDevices,
      reportClientState,
      setMediaOwnerActive,
      setPresentationOwner,
      selectedInputDeviceId,
      selectedVoice,
      threadId,
    ],
  );

  const retry = useCallback(async () => {
    await stop();
    if (mountedRef.current) await start(lastSourceRef.current);
  }, [start, stop]);

  const dismissFailure = useCallback(() => {
    setError(null);
    pendingRemoteErrorRef.current = null;
    setLaunch(IDLE_REALTIME_VOICE_LAUNCH_STATE);
    const next = inactiveState();
    stateRef.current = next;
    setState(next);
    setPresentationOwner(false);
  }, [setPresentationOwner]);

  const completeLaunchHandoff = useCallback(() => {
    if (!mountedRef.current || stateRef.current.phase !== "active") return;
    setLaunch((current) => (current.pending ? { ...current, handoffComplete: true } : current));
  }, []);

  const presentInMainThread = useCallback(
    (
      animateHandoff: boolean,
      incomingHandoff: DesktopRealtimeVoiceOverlayHandoff | null = null,
    ) => {
      const from = presentationSurfaceRef.current;
      if (from === "main-thread") return;
      presentationSurfaceRef.current = "main-thread";
      setPresentationSurface("main-thread");
      if (!animateHandoff) {
        setPresentationHandoff(null);
        return;
      }
      handoffSequenceRef.current += 1;
      setPresentationHandoff({
        sequence: handoffSequenceRef.current,
        from: incomingHandoff?.from ?? from,
        origin: incomingHandoff?.origin ?? null,
        velocity: incomingHandoff?.velocity ?? null,
      });
    },
    [],
  );

  const presentOwningThread = useCallback(
    (
      animateHandoff: boolean,
      incomingHandoff: DesktopRealtimeVoiceOverlayHandoff | null = null,
    ) => {
      const ownerThreadId = stateRef.current.threadId;
      if (ownerThreadId !== null && ownerThreadId !== threadIdRef.current) {
        const focusOwner = focusThreadRef.current;
        if (!focusOwner) return;
        pendingThreadFocusRef.current = {
          threadId: ownerThreadId,
          animateHandoff,
          handoff: incomingHandoff,
        };
        void Promise.resolve(focusOwner(ownerThreadId)).catch(() => {
          if (pendingThreadFocusRef.current?.threadId === ownerThreadId) {
            pendingThreadFocusRef.current = null;
          }
        });
        return;
      }
      presentInMainThread(animateHandoff, incomingHandoff);
    },
    [presentInMainThread],
  );

  useLayoutEffect(() => {
    const pending = pendingThreadFocusRef.current;
    if (!pending || pending.threadId !== threadId) return;
    pendingThreadFocusRef.current = null;
    presentInMainThread(pending.animateHandoff, pending.handoff);
  }, [presentInMainThread, threadId]);

  useLayoutEffect(() => {
    if (
      !shouldReturnRealtimeVoiceToMainThread({
        state,
        currentThreadId: threadId,
        presentationSurface,
        mediaOwnerActive,
        presentationHandoff,
      })
    ) {
      return;
    }
    presentInMainThread(true);
  }, [
    mediaOwnerActive,
    presentInMainThread,
    presentationSurface,
    presentationHandoff,
    state.phase,
    state.threadId,
    threadId,
  ]);

  const detachToGlobalOverlay = useCallback((motion: RealtimeVoiceDetachMotion) => {
    if (
      !window.desktopBridge?.realtimeVoice?.overlay ||
      stateRef.current.phase !== "active" ||
      presentationSurfaceRef.current !== "main-thread"
    ) {
      return;
    }
    handoffSequenceRef.current += 1;
    const handoff: RealtimeVoiceHandoffMotion = {
      sequence: handoffSequenceRef.current,
      from: "main-thread",
      origin: motion.origin,
      velocity: motion.velocity,
    };
    realtimeVoiceOverlayPublisher = controllerInstanceRef.current;
    presentationSurfaceRef.current = "global-overlay";
    setPresentationHandoff(handoff);
    setPresentationSurface("global-overlay");
  }, []);

  const openOwningThread = useCallback(() => {
    presentOwningThread(true);
  }, [presentOwningThread]);

  const setSelectedVoice = useCallback((voice: RealtimeVoiceId) => {
    if (stateRef.current.phase !== "inactive" && stateRef.current.phase !== "failed") return;
    selectedVoiceRef.current = voice;
    setSelectedVoiceState(voice);
    writeRealtimeVoicePreference(voice);
  }, []);

  const setInputDevice = useCallback(
    async (deviceId: string | null) => {
      const previous = selectedInputDeviceIdRef.current;
      if (previous === deviceId) return;
      selectedInputDeviceIdRef.current = deviceId;
      setSelectedInputDeviceId(deviceId);
      writeRealtimeVoiceInputDevicePreference(deviceId);
      const media = mediaRef.current;
      if (!media) return;
      try {
        const actualDeviceId = await media.replaceMicrophone(deviceId);
        selectedInputDeviceIdRef.current = actualDeviceId;
        setSelectedInputDeviceId(actualDeviceId);
        writeRealtimeVoiceInputDevicePreference(actualDeviceId);
        refreshInputDevices();
      } catch (cause) {
        selectedInputDeviceIdRef.current = previous;
        setSelectedInputDeviceId(previous);
        writeRealtimeVoiceInputDevicePreference(previous);
        setError(presentRealtimeVoiceError({ cause }, translateRef.current));
      }
    },
    [refreshInputDevices],
  );

  const toggleInputMuted = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    const muted = !media.snapshot.inputMuted;
    media.setInputMuted(muted);
    playRealtimeVoiceCue(muted ? "mute" : "unmute");
  }, []);

  const toggleOutputMuted = useCallback(() => {
    const media = mediaRef.current;
    if (!media) return;
    media.setOutputMuted(!media.snapshot.outputMuted);
  }, []);

  const appendText = useCallback(async (text: string): Promise<boolean> => {
    const normalized = text.trim();
    const sessionId = ownedSessionRef.current;
    const api = readNativeApi();
    if (!normalized || !sessionId || !api || stateRef.current.phase !== "active") return false;
    const result = await api.realtimeVoice.appendText({
      sessionId,
      role: "user",
      text: normalized,
    });
    return result.accepted;
  }, []);

  useEffect(() => {
    mountedRef.current = true;
    const api = readNativeApi();
    const onEvent = (event: RealtimeVoiceEvent) => {
      if (!mountedRef.current) return;
      if (event.type === "state") {
        const targetsOwnedCall = realtimeVoiceEventTargetsOwnedCall({
          eventSessionId: event.sessionId,
          eventThreadId: event.threadId,
          ownedSessionId: ownedSessionRef.current,
          ownerThreadId: stateRef.current.threadId,
          currentThreadId: threadIdRef.current,
        });
        if (!targetsOwnedCall) return;
        setLaunch((current) => reduceRealtimeVoiceLaunchStateForEvent(current, event));
        const pendingError = pendingRemoteErrorRef.current;
        const presentedEventState = presentRealtimeVoiceState(
          event.state,
          translateRef.current,
          event.state.phase === "failed" ? pendingError?.code : undefined,
        );
        if (presentedEventState.phase === "inactive") {
          const terminalGeneration = generationRef.current + 1;
          generationRef.current = terminalGeneration;
          const resolution = resolveRealtimeVoiceRemoteTermination({
            previousState: stateRef.current,
            inactiveState: presentedEventState,
            currentThreadId: threadIdRef.current,
            pendingError: pendingRemoteErrorRef.current,
            closedReason: null,
          });
          pendingRemoteErrorRef.current = null;
          stateRef.current = resolution.state;
          setState(resolution.state);
          setError(resolution.error);
          if (!resolution.failed) setPresentationOwner(false);
          ownedSessionRef.current = null;
          ownedClaimRef.current = null;
          void disposeLocalMedia()
            .catch(() => undefined)
            .finally(() => {
              if (generationRef.current === terminalGeneration) setMediaOwnerActive(false);
            });
          return;
        }
        if (
          presentedEventState.phase === "active" &&
          presentedEventState.error === null &&
          pendingError?.recoverable === true &&
          pendingError.sessionId === null &&
          pendingError.threadId === presentedEventState.threadId
        ) {
          // A local pre-session failure (for example, the initial microphone
          // probe) is no longer authoritative once the backend reports a fully
          // active replacement call for the same thread. Do not let its retry
          // surface cover the live call or reappear after a normal close.
          pendingRemoteErrorRef.current = null;
          setError(null);
        }
        stateRef.current = presentedEventState;
        setState(presentedEventState);
        if (presentedEventState.error && targetsOwnedCall) {
          setError(presentedEventState.error);
          if (presentedEventState.phase === "failed") {
            pendingRemoteErrorRef.current = {
              message: presentedEventState.error,
              sessionId: presentedEventState.sessionId,
              threadId: presentedEventState.threadId,
              recoverable: false,
            };
          }
        }
        return;
      }
      if (
        event.type === "transcript" &&
        realtimeVoiceEventTargetsOwnedCall({
          eventSessionId: event.sessionId,
          eventThreadId: event.threadId,
          ownedSessionId: ownedSessionRef.current,
          ownerThreadId: stateRef.current.threadId,
          currentThreadId: threadIdRef.current,
        })
      ) {
        const items = transcriptItemsRef.current;
        const previous = items.get(event.itemId);
        items.set(event.itemId, {
          role: event.role,
          text: (event.done ? event.delta : `${previous?.text ?? ""}${event.delta}`).slice(-2_000),
        });
        while (items.size > 12) {
          const oldest = items.keys().next().value;
          if (typeof oldest !== "string") break;
          items.delete(oldest);
        }
        setTranscript(
          [...items.values()]
            .map((item) => item.text)
            .filter(Boolean)
            .join("\n")
            .slice(-2_000),
        );
        return;
      }
      if (
        event.type === "tool-request" &&
        event.name === "capture_screen_context" &&
        realtimeVoiceEventTargetsOwnedCall({
          eventSessionId: event.sessionId,
          eventThreadId: event.threadId,
          ownedSessionId: ownedSessionRef.current,
          ownerThreadId: stateRef.current.threadId,
          currentThreadId: threadIdRef.current,
        })
      ) {
        void resolveScreenContextTool(event).catch(() => undefined);
        return;
      }
      if (event.type === "usage") {
        if (
          !realtimeVoiceEventTargetsOwnedCall({
            eventSessionId: event.sessionId,
            eventThreadId: event.threadId,
            ownedSessionId: ownedSessionRef.current,
            ownerThreadId: stateRef.current.threadId,
            currentThreadId: threadIdRef.current,
          })
        ) {
          return;
        }
        setQuota(event.quota);
        return;
      }
      if (event.type === "quota-warning") {
        if (
          !realtimeVoiceEventTargetsOwnedCall({
            eventSessionId: event.sessionId,
            eventThreadId: event.threadId,
            ownedSessionId: ownedSessionRef.current,
            ownerThreadId: stateRef.current.threadId,
            currentThreadId: threadIdRef.current,
          })
        ) {
          return;
        }
        setQuota(event.quota);
        const announcement = projectRealtimeVoiceQuotaWarning({
          threadId: event.threadId,
          sessionId: event.sessionId,
          ownedSessionId: ownedSessionRef.current,
          willStopAfterCurrentResponse: event.willStopAfterCurrentResponse,
          announcedKeys: quotaWarningAnnouncementKeysRef.current,
        });
        if (announcement) {
          quotaWarningAnnouncementKeysRef.current.add(announcement.key);
          const api = readNativeApi();
          const sessionId = ownedSessionRef.current;
          if (sessionId !== null && sessionId === event.sessionId) {
            void deliverRealtimeVoiceQuotaWarning({
              announcement,
              sessionId,
              showToast: (warning) => {
                toastManager.add({
                  type: "warning",
                  title: warning.text,
                  ...(warning.description ? { description: warning.description } : {}),
                  data: { threadId: warning.threadId },
                });
              },
              appendSpeech: (ownedSessionId, text) =>
                api
                  ? api.realtimeVoice.appendSpeech({ sessionId: ownedSessionId, text })
                  : Promise.resolve(),
            });
          }
        }
        return;
      }
      if (event.type === "error") {
        const targetsCurrentController = realtimeVoiceEventTargetsOwnedCall({
          eventSessionId: event.sessionId,
          eventThreadId: event.threadId,
          ownedSessionId: ownedSessionRef.current,
          ownerThreadId: stateRef.current.threadId,
          currentThreadId: threadIdRef.current,
        });
        if (targetsCurrentController) {
          const message = presentRealtimeVoiceError(
            { cause: event.message, code: event.code },
            translateRef.current,
          );
          setError(message);
          pendingRemoteErrorRef.current = {
            message,
            code: event.code,
            sessionId: event.sessionId,
            threadId: event.threadId ?? stateRef.current.threadId ?? threadIdRef.current,
            recoverable: event.recoverable,
          };
        }
        return;
      }
      if (event.type === "closed") {
        if (
          !realtimeVoiceEventTargetsOwnedCall({
            eventSessionId: event.sessionId,
            eventThreadId: event.threadId,
            ownedSessionId: ownedSessionRef.current,
            ownerThreadId: stateRef.current.threadId,
            currentThreadId: threadIdRef.current,
          })
        ) {
          return;
        }
        setLaunch((current) => reduceRealtimeVoiceLaunchStateForEvent(current, event));
        const terminalGeneration = generationRef.current + 1;
        generationRef.current = terminalGeneration;
        const resolution = resolveRealtimeVoiceRemoteTermination({
          previousState: stateRef.current,
          inactiveState: inactiveState(),
          currentThreadId: threadIdRef.current,
          pendingError: pendingRemoteErrorRef.current,
          closedReason: event.reason,
        });
        pendingRemoteErrorRef.current = null;
        ownedSessionRef.current = null;
        ownedClaimRef.current = null;
        stateRef.current = resolution.state;
        setState(resolution.state);
        setError(resolution.error);
        if (!resolution.failed) setPresentationOwner(false);
        void disposeLocalMedia()
          .catch(() => undefined)
          .finally(() => {
            if (generationRef.current === terminalGeneration) setMediaOwnerActive(false);
          });
      }
    };
    const unsubscribe = api?.realtimeVoice.onEvent(onEvent);
    void api?.realtimeVoice
      .listVoices()
      .then((result) => {
        if (!mountedRef.current) return;
        setVoices(result.voices);
        backendDefaultVoiceRef.current = result.defaultVoice;
        preferredTransportRef.current = result.preferredTransport;
        const persistedVoice = readPersistedRealtimeVoicePreference();
        const nextVoice =
          persistedVoice && result.voices.some((voice) => voice.id === persistedVoice)
            ? persistedVoice
            : result.voices.some((voice) => voice.id === result.defaultVoice)
              ? result.defaultVoice
              : (result.voices[0]?.id ?? DEFAULT_REALTIME_VOICE);
        selectedVoiceRef.current = nextVoice;
        setSelectedVoiceState(nextVoice);
      })
      .catch(() => undefined);
    void api?.realtimeVoice
      .getState()
      .then((initialState) => {
        if (!mountedRef.current) return;
        const presentedState = presentRealtimeVoiceState(initialState, translateRef.current);
        stateRef.current = presentedState;
        setState(presentedState);
      })
      .catch(() => undefined);
    refreshInputDevices();
    const onDeviceChange = () => {
      void listAudioInputs()
        .then(async (devices) => {
          if (!mountedRef.current) return;
          setInputDevices(devices);
          const selectedId = selectedInputDeviceIdRef.current;
          const media = mediaRef.current;
          if (!selectedId || !media || devices.some((device) => device.deviceId === selectedId)) {
            return;
          }
          const replacementId = await media.replaceMicrophone(null);
          if (!mountedRef.current) return;
          selectedInputDeviceIdRef.current = replacementId;
          setSelectedInputDeviceId(replacementId);
          writeRealtimeVoiceInputDevicePreference(replacementId);
        })
        .catch(() => undefined);
    };
    navigator.mediaDevices?.addEventListener?.("devicechange", onDeviceChange);
    return () => {
      mountedRef.current = false;
      presentationOwnerRef.current = false;
      unsubscribe?.();
      navigator.mediaDevices?.removeEventListener?.("devicechange", onDeviceChange);
      if (
        ownedSessionRef.current ||
        ownedClaimRef.current ||
        mediaRef.current ||
        // oxlint-disable-next-line react-hooks/exhaustive-deps -- teardown must inspect the current transport candidates, not the mount-time set.
        pendingMediaCandidatesRef.current.size > 0
      ) {
        const sessionId = ownedSessionRef.current;
        const claimId = ownedClaimRef.current;
        ownedSessionRef.current = null;
        ownedClaimRef.current = null;
        mediaOwnerActiveRef.current = false;
        generationRef.current += 1;
        void stopRealtimeVoiceRemoteBeforeDisposal({
          quiesceMedia: () => mediaRef.current?.setInputMuted(true),
          stopRemote: async () => {
            if (sessionId) {
              await api?.realtimeVoice.stop({ sessionId, reason: "surface-unmounted" });
            } else if (claimId) {
              await api?.realtimeVoice.releaseClaim({ ownerClaimId: claimId });
            }
          },
          disposeMedia: disposeLocalMedia,
        }).catch(() => undefined);
      }
    };
  }, [disposeLocalMedia, refreshInputDevices, setMediaOwnerActive, setPresentationOwner]);

  useLayoutEffect(() => {
    if (
      !shouldPromoteRealtimeVoiceToGlobalOverlay({
        state,
        currentThreadId: threadId,
        presentationSurface,
        globalOverlayAvailable: window.desktopBridge?.realtimeVoice?.overlay !== undefined,
        mediaOwnerActive,
      })
    ) {
      return;
    }
    realtimeVoiceOverlayPublisher = controllerInstanceRef.current;
    presentationSurfaceRef.current = "global-overlay";
    setPresentationHandoff(null);
    setPresentationSurface("global-overlay");
  }, [mediaOwnerActive, presentationSurface, state, threadId]);

  useEffect(() => {
    const desktopShortcut = window.desktopBridge?.realtimeVoice;
    const ownsActiveGlobalPresentation =
      presentationOwner &&
      presentationSurface === "global-overlay" &&
      (state.phase !== "inactive" || launchPending);
    const shouldHandleDesktopToggle =
      ownsActiveGlobalPresentation ||
      (presentationOwner && state.phase !== "inactive") ||
      (ownsDesktopSurface && state.phase === "inactive");
    const toggleVoice = () => {
      const action = realtimeVoiceToggleAction({
        state: stateRef.current,
        currentThreadId: threadIdRef.current,
        presentationSurface: presentationSurfaceRef.current,
        presentationOwner: presentationOwnerRef.current,
      });
      if (action === "stop") {
        void stop();
      } else if (action === "start") {
        void start("global-hotkey");
      }
    };
    const syncGlobalShortcut = () => {
      if (!shouldHandleDesktopToggle) return;
      void desktopShortcut
        ?.setGlobalShortcut(readRealtimeVoiceShortcutPreference())
        .catch(() => undefined);
    };
    const onPreferencesChanged = () => {
      const persistedVoice = readPersistedRealtimeVoicePreference();
      const nextVoice = persistedVoice ?? backendDefaultVoiceRef.current;
      const nextDevice = readRealtimeVoiceInputDevicePreference();
      if (
        shouldApplyRealtimeVoiceInputPreference({
          phase: stateRef.current.phase,
          mediaOwnerActive: mediaOwnerActiveRef.current,
          selectedDeviceId: selectedInputDeviceIdRef.current,
          preferredDeviceId: nextDevice,
        })
      ) {
        void setInputDevice(nextDevice);
      } else if (
        stateRef.current.phase === "active" &&
        selectedInputDeviceIdRef.current !== nextDevice
      ) {
        selectedInputDeviceIdRef.current = nextDevice;
        setSelectedInputDeviceId(nextDevice);
      }
      if (stateRef.current.phase !== "inactive" && stateRef.current.phase !== "failed") {
        syncGlobalShortcut();
        return;
      }
      selectedVoiceRef.current = nextVoice;
      selectedInputDeviceIdRef.current = nextDevice;
      setSelectedVoiceState(nextVoice);
      setSelectedInputDeviceId(nextDevice);
      syncGlobalShortcut();
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (
        event.repeat ||
        !keyboardEventMatchesRealtimeVoiceShortcut(event, readRealtimeVoiceShortcutPreference())
      ) {
        return;
      }
      event.preventDefault();
      toggleVoice();
    };
    const onOverlayCommand = (
      command: DesktopRealtimeVoiceOverlayCommand,
      handoff: DesktopRealtimeVoiceOverlayHandoff | null,
    ) => {
      dispatchRealtimeVoiceOverlayCommand(command, {
        toggle: toggleVoice,
        stop: () => void stop(),
        toggleInputMute: toggleInputMuted,
        toggleOutputMute: toggleOutputMuted,
        focus: () => presentOwningThread(false),
        handoff: () => presentOwningThread(true, handoff),
      });
    };
    syncGlobalShortcut();
    const unsubscribeDesktopToggle = shouldHandleDesktopToggle
      ? desktopShortcut?.onToggle(toggleVoice)
      : undefined;
    const unsubscribeOverlayCommand = ownsActiveGlobalPresentation
      ? desktopShortcut?.overlay?.onCommand(onOverlayCommand)
      : undefined;
    window.addEventListener("moss:realtime-voice-preferences-changed", onPreferencesChanged);
    if (shouldHandleDesktopToggle && !desktopShortcut) {
      window.addEventListener("keydown", onKeyDown, true);
    }
    return () => {
      unsubscribeDesktopToggle?.();
      unsubscribeOverlayCommand?.();
      window.removeEventListener("moss:realtime-voice-preferences-changed", onPreferencesChanged);
      if (shouldHandleDesktopToggle && !desktopShortcut) {
        window.removeEventListener("keydown", onKeyDown, true);
      }
    };
  }, [
    ownsDesktopSurface,
    launchPending,
    presentationSurface,
    presentOwningThread,
    presentationOwner,
    start,
    state.phase,
    state.threadId,
    setInputDevice,
    stop,
    toggleInputMuted,
    toggleOutputMuted,
  ]);

  useEffect(() => {
    if (
      presentationSurface !== "global-overlay" ||
      !launchPending ||
      launchHandoffComplete ||
      state.phase !== "active"
    ) {
      return;
    }
    const frame = window.requestAnimationFrame(() => {
      if (stateRef.current.phase !== "active") return;
      setLaunch((current) => (current.pending ? { ...current, handoffComplete: true } : current));
    });
    return () => window.cancelAnimationFrame(frame);
  }, [launchHandoffComplete, launchPending, presentationSurface, state.phase]);

  useEffect(() => {
    const overlay = window.desktopBridge?.realtimeVoice?.overlay;
    if (!overlay) return;
    const publication = createRealtimeVoiceOverlayPublication({
      state,
      error,
      presentationSurface,
      mediaOwnerActive,
      handoff: presentationHandoff,
      audioSignal: outputSignalRef.current,
      translate: t,
    });
    const { snapshot } = publication;
    const controllerInstance = controllerInstanceRef.current;
    if (mediaOwnerActive) {
      realtimeVoiceMediaOwnerPublisher = controllerInstance;
      publishedMediaOwnershipRef.current = true;
      if (presentationSurface === "global-overlay") {
        realtimeVoiceOverlayPublisher = controllerInstance;
      } else if (realtimeVoiceOverlayPublisher === controllerInstance) {
        realtimeVoiceOverlayPublisher = null;
      }
      void overlay.publish(publication).catch(() => undefined);
      return;
    }
    if (
      publishedMediaOwnershipRef.current ||
      realtimeVoiceMediaOwnerPublisher === controllerInstance
    ) {
      publishedMediaOwnershipRef.current = false;
      if (realtimeVoiceMediaOwnerPublisher === controllerInstance) {
        realtimeVoiceMediaOwnerPublisher = null;
      }
      if (snapshot === null && realtimeVoiceOverlayPublisher === controllerInstance) {
        realtimeVoiceOverlayPublisher = null;
      }
      void overlay.publish(publication).catch(() => undefined);
      return;
    }
    if (snapshot !== null) {
      realtimeVoiceOverlayPublisher = controllerInstance;
      void overlay.publish(publication).catch(() => undefined);
      return;
    }
    if (presentationSurface === "global-overlay" && launchPending) {
      realtimeVoiceOverlayPublisher = controllerInstance;
      void overlay.publish(publication).catch(() => undefined);
      return;
    }
    if (realtimeVoiceOverlayPublisher === controllerInstance) {
      realtimeVoiceOverlayPublisher = null;
      void overlay.publish(publication).catch(() => undefined);
      return;
    }
    if (
      ownsDesktopSurface &&
      realtimeVoiceOverlayPublisher === null &&
      realtimeVoiceMediaOwnerPublisher === null
    ) {
      void overlay.publish(publication).catch(() => undefined);
    }
  }, [
    error,
    launchPending,
    mediaOwnerActive,
    ownsDesktopSurface,
    presentationHandoff,
    presentationSurface,
    state,
    t,
  ]);

  useEffect(() => {
    const overlay = window.desktopBridge?.realtimeVoice?.overlay;
    return () => {
      const controllerInstance = controllerInstanceRef.current;
      const ownedOverlay = realtimeVoiceOverlayPublisher === controllerInstance;
      const ownedMedia = realtimeVoiceMediaOwnerPublisher === controllerInstance;
      if (!ownedOverlay && !ownedMedia && !publishedMediaOwnershipRef.current) return;
      if (ownedOverlay) realtimeVoiceOverlayPublisher = null;
      if (ownedMedia) realtimeVoiceMediaOwnerPublisher = null;
      publishedMediaOwnershipRef.current = false;
      if (overlay) {
        void overlay
          .publish({ snapshot: null, mediaOwnerActive: false, handoff: null })
          .catch(() => undefined);
      }
    };
  }, []);

  useEffect(() => {
    if (state.phase === "active" && !connectedCueArmedRef.current) {
      connectedCueArmedRef.current = true;
      if (!state.outputMuted) playRealtimeVoiceCue("start");
      return;
    }
    if (state.phase === "inactive" && connectedCueArmedRef.current) {
      connectedCueArmedRef.current = false;
      if (!lastOutputMutedRef.current) playRealtimeVoiceCue("end");
      lastOutputMutedRef.current = false;
    }
  }, [state.outputMuted, state.phase]);

  const isCurrentThread = state.threadId === threadId;
  const isVisible =
    presentationOwner &&
    ((isCurrentThread && state.phase !== "inactive") ||
      (state.phase === "inactive" && error !== null));
  const launchUi = projectRealtimeVoiceLaunchUi({
    launch,
    state,
    threadId,
    error,
    presentationSurface,
    launchSource: defaultSource,
  });
  const isMainThreadPresentationVisible = shouldRenderRealtimeVoiceMainThreadPresentation({
    state,
    currentThreadId: threadId,
    error,
    presentationSurface,
    presentationOwner,
  });
  const canDetachToGlobalOverlay =
    presentationOwner &&
    presentationSurface === "main-thread" &&
    isCurrentThread &&
    state.phase === "active" &&
    window.desktopBridge?.realtimeVoice?.overlay !== undefined;
  const readOutputSignal = useCallback(() => outputSignalRef.current, []);
  return {
    state,
    voices,
    selectedVoice,
    inputDevices,
    selectedInputDeviceId,
    transcript,
    quota,
    error,
    isCurrentThread,
    isVisible,
    isMainThreadPresentationVisible,
    isLaunchOverlayVisible: presentationOwner && launchUi.overlayVisible,
    isLaunchConnected: presentationOwner && launchUi.connected,
    launchFailed: presentationOwner && launchUi.failed,
    launchHandoffComplete,
    presentationSurface,
    presentationHandoff,
    canDetachToGlobalOverlay,
    canStart: !disabled && (state.phase === "inactive" || state.phase === "failed"),
    readOutputSignal,
    start,
    stop,
    retry,
    dismissFailure,
    completeLaunchHandoff,
    detachToGlobalOverlay,
    openOwningThread,
    setSelectedVoice,
    setInputDevice,
    toggleInputMuted,
    toggleOutputMuted,
    appendText,
  };
}
