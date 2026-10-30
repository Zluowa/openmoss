// FILE: RealtimeVoiceControllerProvider.tsx
// Purpose: Keep the single Realtime Voice media owner alive across route and thread changes.
// Layer: Application voice runtime / chat-surface adapter

import type { ThreadId } from "@synara/contracts";
import {
  createContext,
  useCallback,
  useContext,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from "react";

import {
  type UseRealtimeVoiceControllerOptions,
  type UseRealtimeVoiceControllerResult,
  useRealtimeVoiceRuntimeController,
} from "./useRealtimeVoiceController";

const DETACHED_REALTIME_VOICE_THREAD_ID = "__moss_realtime_voice_detached_surface__" as ThreadId;

interface RegisteredRealtimeVoiceSurface {
  readonly id: symbol;
  readonly options: UseRealtimeVoiceControllerOptions;
  readonly sequence: number;
}

interface RealtimeVoiceControllerContextValue {
  readonly activeSurfaceId: symbol | null;
  readonly result: UseRealtimeVoiceControllerResult;
  readonly registerSurface: (id: symbol, options: UseRealtimeVoiceControllerOptions) => void;
  readonly unregisterSurface: (id: symbol) => void;
}

const RealtimeVoiceControllerContext = createContext<RealtimeVoiceControllerContextValue | null>(
  null,
);

function preferredSurface(
  surfaces: Iterable<RegisteredRealtimeVoiceSurface>,
): RegisteredRealtimeVoiceSurface | null {
  const ordered = [...surfaces].toSorted((left, right) => right.sequence - left.sequence);
  return ordered.find((surface) => surface.options.ownsDesktopSurface !== false) ?? null;
}

/**
 * The media transport must outlive ChatView. Codex keeps one call alive while the
 * user opens another task, so route components only register presentation context;
 * they never own the peer connection lifecycle.
 */
export function RealtimeVoiceControllerProvider(props: { readonly children: ReactNode }) {
  const surfacesRef = useRef(new Map<symbol, RegisteredRealtimeVoiceSurface>());
  const sequenceRef = useRef(0);
  const lastSurfaceRef = useRef<UseRealtimeVoiceControllerOptions | null>(null);
  const [activeSurface, setActiveSurface] = useState<RegisteredRealtimeVoiceSurface | null>(null);

  const selectActiveSurface = useCallback(() => {
    const next = preferredSurface(surfacesRef.current.values());
    if (next) lastSurfaceRef.current = next.options;
    setActiveSurface(next);
  }, []);

  const registerSurface = useCallback(
    (id: symbol, options: UseRealtimeVoiceControllerOptions) => {
      sequenceRef.current += 1;
      surfacesRef.current.set(id, {
        id,
        options,
        sequence: sequenceRef.current,
      });
      selectActiveSurface();
    },
    [selectActiveSurface],
  );

  const unregisterSurface = useCallback(
    (id: symbol) => {
      if (!surfacesRef.current.delete(id)) return;
      selectActiveSurface();
    },
    [selectActiveSurface],
  );

  const lastSurface = lastSurfaceRef.current;
  const focusThread = activeSurface?.options.focusThread ?? lastSurface?.focusThread;
  const result = useRealtimeVoiceRuntimeController({
    threadId: activeSurface?.options.threadId ?? DETACHED_REALTIME_VOICE_THREAD_ID,
    disabled: activeSurface?.options.disabled ?? true,
    source: activeSurface?.options.source ?? lastSurface?.source ?? "composer-existing",
    ...(activeSurface?.options.prepareThread
      ? { prepareThread: activeSurface.options.prepareThread }
      : {}),
    ...(focusThread ? { focusThread } : {}),
    ownsDesktopSurface: true,
  });

  const value = useMemo<RealtimeVoiceControllerContextValue>(
    () => ({
      activeSurfaceId: activeSurface?.id ?? null,
      result,
      registerSurface,
      unregisterSurface,
    }),
    [activeSurface?.id, registerSurface, result, unregisterSurface],
  );

  return (
    <RealtimeVoiceControllerContext.Provider value={value}>
      {props.children}
    </RealtimeVoiceControllerContext.Provider>
  );
}

/**
 * Read the process-wide runtime without registering a presentation surface.
 * Shell UI such as the sidebar can observe the owning thread while ChatView
 * remains the only component allowed to register or replace surface context.
 */
export function useRealtimeVoiceGlobalRuntime(): Readonly<
  Pick<UseRealtimeVoiceControllerResult, "state">
> {
  const context = useContext(RealtimeVoiceControllerContext);
  if (!context) {
    throw new Error(
      "useRealtimeVoiceGlobalRuntime must be used inside RealtimeVoiceControllerProvider",
    );
  }
  return useMemo(() => ({ state: context.result.state }), [context.result.state]);
}

/**
 * Bind a ChatView to the process-wide voice controller. Only the focused surface
 * can launch/present the call; non-focused split panes remain ordinary chats.
 */
export function useRealtimeVoiceController(
  options: UseRealtimeVoiceControllerOptions,
): UseRealtimeVoiceControllerResult {
  const context = useContext(RealtimeVoiceControllerContext);
  if (!context) {
    throw new Error(
      "useRealtimeVoiceController must be used inside RealtimeVoiceControllerProvider",
    );
  }
  const surfaceIdRef = useRef(Symbol("realtime-voice-chat-surface"));
  const { registerSurface, unregisterSurface } = context;
  const { disabled, focusThread, ownsDesktopSurface, prepareThread, source, threadId } = options;
  const prepareThreadRef = useRef(prepareThread);
  const focusThreadRef = useRef(focusThread);
  const hasPrepareThread = prepareThread !== undefined;
  const hasFocusThread = focusThread !== undefined;

  useLayoutEffect(() => {
    prepareThreadRef.current = prepareThread;
    focusThreadRef.current = focusThread;
  }, [focusThread, prepareThread]);

  const prepareLatestThread = useCallback(async () => {
    await prepareThreadRef.current?.();
  }, []);
  const focusLatestThread = useCallback((voiceThreadId: ThreadId) => {
    return focusThreadRef.current?.(voiceThreadId);
  }, []);

  useLayoutEffect(() => {
    const surfaceId = surfaceIdRef.current;
    registerSurface(surfaceId, {
      threadId,
      disabled,
      source,
      ...(hasPrepareThread ? { prepareThread: prepareLatestThread } : {}),
      ...(hasFocusThread ? { focusThread: focusLatestThread } : {}),
      ...(ownsDesktopSurface === undefined ? {} : { ownsDesktopSurface }),
    });
    return () => unregisterSurface(surfaceId);
  }, [
    disabled,
    focusLatestThread,
    hasFocusThread,
    hasPrepareThread,
    ownsDesktopSurface,
    prepareLatestThread,
    registerSurface,
    source,
    threadId,
    unregisterSurface,
  ]);

  const ownsActiveSurface = context.activeSurfaceId === surfaceIdRef.current;
  const isCurrentThread = context.result.state.threadId === options.threadId;

  return useMemo(
    () => ({
      ...context.result,
      isCurrentThread,
      isVisible: ownsActiveSurface && context.result.isVisible,
      isMainThreadPresentationVisible:
        ownsActiveSurface && isCurrentThread && context.result.isMainThreadPresentationVisible,
      isLaunchOverlayVisible: ownsActiveSurface && context.result.isLaunchOverlayVisible,
      isLaunchConnected: ownsActiveSurface && context.result.isLaunchConnected,
      launchFailed: ownsActiveSurface && context.result.launchFailed,
      canDetachToGlobalOverlay: ownsActiveSurface && context.result.canDetachToGlobalOverlay,
      canStart: ownsActiveSurface && !options.disabled && context.result.canStart,
    }),
    [context.result, isCurrentThread, options.disabled, ownsActiveSurface],
  );
}
