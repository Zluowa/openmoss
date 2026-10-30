// Production CSS is required for the composer/orb visual gate.
import "../../index.css";

import { DEFAULT_SERVER_SETTINGS_VIEW, ThreadId, type RealtimeVoiceState } from "@synara/contracts";
import { QueryClient, QueryClientProvider } from "@tanstack/react-query";
import axe from "axe-core";
import { commands, page } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { StrictMode, useState } from "react";

import { RealtimeVoiceComposerControls } from "./RealtimeVoiceComposerControls";
import { MossLocalizationProvider, translateMoss } from "../../localization";
import { serverQueryKeys } from "../../lib/serverReactQuery";
import { APP_SETTINGS_STORAGE_KEY } from "../../uiLocale";
import {
  RealtimeVoiceHandoffTarget,
  type RealtimeVoiceHandoffMotion,
} from "./RealtimeVoiceHandoffTarget";
import { RealtimeVoiceLaunchOverlay } from "./RealtimeVoiceLaunchOverlay";
import { RealtimeVoiceStage } from "./RealtimeVoiceStage";
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

const activeState: RealtimeVoiceState = {
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

const quota = {
  periodEnd: null,
  planLimitNanoUsd: 1_000_000_000,
  planUsedNanoUsd: 100_000_000,
  planReservedNanoUsd: 50_000_000,
  creditBalance: 12,
  estimatedMinutesRemaining: 8,
} as const;

const motionCommands = commands as unknown as {
  emulateReducedMotion: (reducedMotion: "reduce" | "no-preference") => Promise<void>;
};

function activeSurface(overrides: Partial<RealtimeVoiceState> = {}) {
  const callbacks = {
    stop: vi.fn(),
    input: vi.fn(),
    output: vi.fn(),
  };
  const state = { ...activeState, ...overrides };
  const screen = renderZh(
    <main
      className="fixed inset-0 flex items-end justify-center bg-[var(--color-background-primary)] px-3 pb-4 sm:px-5"
      data-testid="voice-fixture"
    >
      <div className="w-full" style={{ maxWidth: 900 }}>
        <RealtimeVoiceStage
          state={state}
          transcript="Ready when you are"
          quota={quota}
          readOutputSignal={() => ({ low: 0, mid: 0, high: 0, overall: 0 })}
          previewTimeMs={4_250}
        />
        <div className="flex min-h-24 items-end gap-3 rounded-[20px] border border-border bg-[var(--color-background-surface)] p-2">
          <label className="min-w-0 flex-1">
            <span className="sr-only">Message</span>
            <textarea
              className="min-h-16 w-full resize-none bg-transparent p-2 text-sm outline-none"
              placeholder="Type anything"
            />
          </label>
          <RealtimeVoiceComposerControls
            state={state}
            onStop={callbacks.stop}
            onToggleInputMuted={callbacks.input}
            onToggleOutputMuted={callbacks.output}
          />
        </div>
      </div>
    </main>,
  );
  return { screen, callbacks };
}

function draggableSurface(reduceMotion?: boolean) {
  const detach = vi.fn();
  const screen = renderZh(
    <RealtimeVoiceStage
      state={activeState}
      transcript=""
      quota={quota}
      readOutputSignal={() => ({ low: 0, mid: 0, high: 0, overall: 0 })}
      canDetachToGlobalOverlay
      onDetachToGlobalOverlay={detach}
      {...(reduceMotion === undefined ? {} : { reduceMotion })}
    />,
  );
  return { screen, detach };
}

function draggableOrb(): HTMLButtonElement {
  const orb = document.querySelector<HTMLButtonElement>("[data-realtime-voice-draggable-orb]");
  if (!orb) throw new Error("draggable voice orb missing");
  let capturedPointer: number | null = null;
  Object.defineProperties(orb, {
    setPointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        capturedPointer = pointerId;
      },
    },
    hasPointerCapture: {
      configurable: true,
      value: (pointerId: number) => capturedPointer === pointerId,
    },
    releasePointerCapture: {
      configurable: true,
      value: (pointerId: number) => {
        if (capturedPointer === pointerId) capturedPointer = null;
      },
    },
  });
  return orb;
}

function dispatchOrbPointer(
  orb: HTMLButtonElement,
  type: "pointerdown" | "pointermove" | "pointerup",
  position: { readonly x: number; readonly y: number },
  pointerType: "mouse" | "touch" = "mouse",
  timeMs?: number,
) {
  const event = new PointerEvent(type, {
    bubbles: true,
    cancelable: true,
    pointerId: 41,
    pointerType,
    button: 0,
    buttons: type === "pointerup" ? 0 : 1,
    screenX: position.x,
    screenY: position.y,
  });
  if (timeMs !== undefined) {
    Object.defineProperty(event, "timeStamp", { configurable: true, value: timeMs });
  }
  orb.dispatchEvent(event);
}

describe("RealtimeVoiceStage", () => {
  it("uses the inline 50px connection pulse before handing off to the active orb", async () => {
    const completed = vi.fn();

    function ConnectingStage() {
      const [state, setState] = useState<RealtimeVoiceState>({
        ...activeState,
        phase: "starting",
        activity: null,
      });
      return (
        <>
          <button type="button" onClick={() => setState(activeState)}>
            Activate voice
          </button>
          <RealtimeVoiceStage
            state={state}
            transcript=""
            quota={quota}
            readOutputSignal={() => ({ low: 0, mid: 0, high: 0, overall: 0 })}
            onConnectionHandoffComplete={completed}
          />
        </>
      );
    }

    const mounted = await renderZh(<ConnectingStage />);
    try {
      const pulse = document.querySelector<HTMLElement>(
        '[data-moss-realtime-voice-connecting-pulse="true"]',
      );
      if (!pulse) throw new Error("inline connecting pulse missing");
      expect(getComputedStyle(pulse).width).toBe("50px");
      expect(document.querySelector("canvas")).toBeNull();

      await page.getByRole("button", { name: "Activate voice" }).click();
      await vi.waitFor(() => expect(document.querySelector("canvas")).toBeTruthy());
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
    } finally {
      await mounted.unmount();
    }
  });

  it("keeps typing available and the three right-edge session controls independent", async () => {
    const mounted = activeSurface();
    try {
      await expect
        .element(page.getByRole("status"))
        .toHaveTextContent("Listening. Ready when you are");
      await expect.element(page.getByRole("textbox", { name: "Message" })).toBeEnabled();
      await page.getByRole("button", { name: "Mute voice output" }).click();
      await page.getByRole("button", { name: "Mute microphone" }).click();
      await page.getByRole("button", { name: "End voice chat" }).click();
      expect(mounted.callbacks.output).toHaveBeenCalledOnce();
      expect(mounted.callbacks.input).toHaveBeenCalledOnce();
      expect(mounted.callbacks.stop).toHaveBeenCalledOnce();
    } finally {
      await (await mounted.screen).unmount();
    }
  });

  it("renders the full-surface recoverable failure actions", async () => {
    const retry = vi.fn();
    const back = vi.fn();
    const screen = renderZh(
      <RealtimeVoiceLaunchOverlay
        visible
        failed
        connected={false}
        handoffComplete={false}
        error="relay wss://private-relay.invalid/session/private-session Bearer TOKEN_SENTINEL /Users/private-user"
        onHandoffComplete={vi.fn()}
        onRetry={retry}
        onBack={back}
      />,
    );
    try {
      await expect
        .element(page.getByText(translateMoss("zh-CN", "realtimeVoice.launch.failedTitle")))
        .toBeInTheDocument();
      await expect
        .element(page.getByText(translateMoss("zh-CN", "realtimeVoice.error.networkUnavailable")))
        .toBeInTheDocument();
      expect(document.body.textContent).not.toMatch(
        /TOKEN_SENTINEL|private-relay|private-session|private-user/u,
      );
      await page
        .getByRole("button", { name: translateMoss("zh-CN", "realtimeVoice.launch.retry") })
        .click();
      await page
        .getByRole("button", { name: translateMoss("zh-CN", "realtimeVoice.launch.back") })
        .click();
      expect(retry).toHaveBeenCalledOnce();
      expect(back).toHaveBeenCalledOnce();
    } finally {
      await (await screen).unmount();
    }
  });

  it("localizes failed dialog copy and accessible names in zh-CN", async () => {
    const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    localStorage.setItem(APP_SETTINGS_STORAGE_KEY, JSON.stringify({ localeOverride: "zh-CN" }));
    queryClient.setQueryData(serverQueryKeys.settings(), DEFAULT_SERVER_SETTINGS_VIEW);
    const screen = renderZh(
      <QueryClientProvider client={queryClient}>
        <MossLocalizationProvider>
          <RealtimeVoiceLaunchOverlay
            visible
            failed
            connected={false}
            handoffComplete={false}
            error="VOICE_QUOTA_EXHAUSTED TOKEN_SENTINEL /Users/private-user"
            onHandoffComplete={vi.fn()}
            onRetry={vi.fn()}
            onBack={vi.fn()}
          />
        </MossLocalizationProvider>
      </QueryClientProvider>,
    );
    try {
      await expect
        .element(
          page.getByRole("dialog", {
            name: translateMoss("zh-CN", "realtimeVoice.launch.failedAria"),
          }),
        )
        .toBeVisible();
      await expect
        .element(page.getByText(translateMoss("zh-CN", "realtimeVoice.error.quotaExhausted")))
        .toBeVisible();
      await expect
        .element(
          page.getByRole("button", {
            name: translateMoss("zh-CN", "realtimeVoice.launch.retry"),
          }),
        )
        .toBeVisible();
      expect(document.body.textContent).not.toMatch(/TOKEN_SENTINEL|private-user/u);
    } finally {
      await (await screen).unmount();
      queryClient.clear();
      localStorage.removeItem(APP_SETTINGS_STORAGE_KEY);
    }
  });

  it("shows only the 112px connecting pulse and keeps launch copy screen-reader-only", async () => {
    const screen = renderZh(
      <RealtimeVoiceLaunchOverlay
        visible
        failed={false}
        connected={false}
        handoffComplete={false}
        error={null}
        onHandoffComplete={vi.fn()}
        onRetry={vi.fn()}
        onBack={vi.fn()}
      />,
    );
    try {
      const status = page.getByRole("status");
      await expect
        .element(status)
        .toHaveTextContent(translateMoss("zh-CN", "realtimeVoice.launch.startingAria"));
      await expect.element(status).toHaveClass("sr-only");
      await expect.element(page.getByRole("button", { name: "Cancel" })).not.toBeInTheDocument();
      const pulse = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-connecting-pulse]",
      );
      const overlay = document.querySelector<HTMLElement>(
        '[data-moss-realtime-voice-launch-overlay="true"]',
      );
      const container = pulse?.parentElement;
      if (!pulse || !container || !overlay) throw new Error("connecting pulse geometry missing");
      expect(overlay.classList.contains("dark")).toBe(false);
      expect(overlay.classList.contains("bg-background")).toBe(true);
      expect(getComputedStyle(container).width).toBe("112px");
      expect(getComputedStyle(container).height).toBe("112px");
      expect(getComputedStyle(pulse).width).toBe("50px");
      expect(getComputedStyle(pulse).height).toBe("50px");
      expect(pulse.classList.contains("bg-foreground")).toBe(true);
    } finally {
      await (await screen).unmount();
    }
  });

  it("completes a connected launch on the next animation frame before fading", async () => {
    await motionCommands.emulateReducedMotion("no-preference");
    const completed = vi.fn();
    function ConnectedLaunch() {
      const [handoffComplete, setHandoffComplete] = useState(false);
      return (
        <RealtimeVoiceLaunchOverlay
          visible={!handoffComplete}
          failed={false}
          connected
          handoffComplete={handoffComplete}
          error={null}
          onHandoffComplete={() => {
            completed();
            setHandoffComplete(true);
          }}
          onRetry={vi.fn()}
          onBack={vi.fn()}
        />
      );
    }

    const screen = renderZh(<ConnectedLaunch />);
    try {
      await vi.waitFor(() => expect(completed).toHaveBeenCalledOnce());
      const overlay = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-launch-overlay]",
      );
      expect(overlay?.dataset.handoffComplete).toBe("true");
      expect(overlay?.dataset.mossRealtimeVoiceLaunchOverlay).toBe("false");
      expect(overlay?.style.transition).toContain("200ms");
    } finally {
      await (await screen).unmount();
    }
  });

  it("runs Web Animations once for a handoff and skips it under reduced motion", async () => {
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 1,
      from: "global-overlay",
      origin: null,
      velocity: null,
    };
    const animated = renderZh(
      <RealtimeVoiceHandoffTarget handoff={motion} reduceMotion={false} surface="main-thread">
        <div>Orb</div>
      </RealtimeVoiceHandoffTarget>,
    );
    try {
      await animated;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("main-thread handoff target missing");
      await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
      expect(target.getAnimations()[0]?.effect?.getTiming().duration).toBe(300);
    } finally {
      await (await animated).unmount();
    }

    const reduced = renderZh(
      <RealtimeVoiceHandoffTarget handoff={motion} reduceMotion surface="main-thread">
        <div>Reduced orb</div>
      </RealtimeVoiceHandoffTarget>,
    );
    try {
      await reduced;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("reduced-motion handoff target missing");
      expect(target.getAnimations()).toHaveLength(0);
    } finally {
      await (await reduced).unmount();
    }
  });

  it("does not infer the native fade from overlay capability alone", async () => {
    const previousDesktopBridge = window.desktopBridge;
    Object.defineProperty(window, "desktopBridge", {
      configurable: true,
      writable: true,
      value: {
        realtimeVoice: {
          overlay: {},
        },
      } as unknown as NonNullable<typeof window.desktopBridge>,
    });
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 2,
      from: "global-overlay",
      origin: {
        centerX: 1_200,
        centerY: 500,
        width: 112,
        height: 112,
      },
      velocity: { x: 1_000, y: -400 },
    };
    const implicit = renderZh(
      <RealtimeVoiceHandoffTarget handoff={motion} reduceMotion={false} surface="main-thread">
        <div>Native overlay orb</div>
      </RealtimeVoiceHandoffTarget>,
    );
    try {
      await implicit;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("native-overlay handoff target missing");
      await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
      expect(target.getAnimations()[0]?.effect?.getTiming().duration).toBe(300);
    } finally {
      await (await implicit).unmount();
      Object.defineProperty(window, "desktopBridge", {
        configurable: true,
        writable: true,
        value: previousDesktopBridge,
      });
    }
  });

  it("uses the 200ms opacity-only return when the caller selects the native transition", async () => {
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 3,
      from: "global-overlay",
      origin: {
        centerX: 1_200,
        centerY: 500,
        width: 112,
        height: 112,
      },
      velocity: { x: 1_000, y: -400 },
    };
    const explicit = renderZh(
      <RealtimeVoiceHandoffTarget
        handoff={motion}
        reduceMotion={false}
        surface="main-thread"
        usesFadeTransition
      >
        <div>Native overlay orb</div>
      </RealtimeVoiceHandoffTarget>,
    );
    try {
      await explicit;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("native-overlay handoff target missing");
      await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
      const animation = target.getAnimations()[0];
      expect(animation?.effect?.getTiming()).toMatchObject({
        duration: 200,
        easing: "cubic-bezier(0.22, 1, 0.36, 1)",
        fill: "backwards",
      });
      expect((animation?.effect as KeyframeEffect | null)?.getKeyframes()).toEqual([
        expect.objectContaining({ opacity: "0" }),
        expect.objectContaining({ opacity: "1" }),
      ]);
    } finally {
      await (await explicit).unmount();
    }
  });

  it("keeps one 200ms handoff animation alive across equivalent rerenders and callback-ref churn", async () => {
    const firstAnchorRef = vi.fn();
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 4,
      from: "global-overlay",
      origin: null,
      velocity: null,
    };
    const mounted = render(
      <RealtimeVoiceHandoffTarget
        handoff={motion}
        presentationAnchorRef={firstAnchorRef}
        reduceMotion={false}
        surface="main-thread"
        usesFadeTransition
      >
        <div>Stable native handoff</div>
      </RealtimeVoiceHandoffTarget>,
    );

    try {
      const screen = await mounted;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("stable handoff target missing");
      await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
      const animation = target.getAnimations()[0];
      if (!animation) throw new Error("stable handoff animation missing");
      animation.currentTime = 40;

      const nextAnchorRef = vi.fn();
      await screen.rerender(
        <RealtimeVoiceHandoffTarget
          handoff={{ ...motion }}
          presentationAnchorRef={nextAnchorRef}
          reduceMotion={false}
          surface="main-thread"
          usesFadeTransition
        >
          <div>Parent rerendered</div>
        </RealtimeVoiceHandoffTarget>,
      );

      expect(firstAnchorRef).toHaveBeenLastCalledWith(null);
      expect(nextAnchorRef).toHaveBeenCalledWith(target);
      expect(target.getAnimations()).toContain(animation);
      expect(animation.playState).not.toBe("idle");
      await animation.finished;
      expect(animation.playState).toBe("finished");
    } finally {
      await (await mounted).unmount();
    }
  });

  it("restarts the 200ms return fade after StrictMode cleanup without replaying it on an equivalent rerender", async () => {
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 5,
      from: "global-overlay",
      origin: null,
      velocity: null,
    };
    const mounted = render(
      <StrictMode>
        <RealtimeVoiceHandoffTarget
          handoff={motion}
          reduceMotion={false}
          surface="main-thread"
          usesFadeTransition
        >
          <div>Strict native handoff</div>
        </RealtimeVoiceHandoffTarget>
      </StrictMode>,
    );

    try {
      const screen = await mounted;
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      if (!target) throw new Error("strict handoff target missing");
      await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
      const animation = target.getAnimations()[0];
      if (!animation) throw new Error("strict handoff animation missing");
      expect(animation.effect?.getTiming().duration).toBe(200);
      animation.currentTime = 40;

      await screen.rerender(
        <StrictMode>
          <RealtimeVoiceHandoffTarget
            handoff={{ ...motion }}
            reduceMotion={false}
            surface="main-thread"
            usesFadeTransition
          >
            <div>Strict parent rerendered</div>
          </RealtimeVoiceHandoffTarget>
        </StrictMode>,
      );

      expect(target.getAnimations()).toEqual([animation]);
      await animation.finished;
      expect(animation.playState).toBe("finished");
    } finally {
      await (await mounted).unmount();
    }
  });

  it("cancels an unfinished handoff animation when its target unmounts", async () => {
    const mounted = render(
      <RealtimeVoiceHandoffTarget
        handoff={{
          sequence: 5,
          from: "global-overlay",
          origin: null,
          velocity: null,
        }}
        reduceMotion={false}
        surface="main-thread"
        usesFadeTransition
      >
        <div>Unmounting native handoff</div>
      </RealtimeVoiceHandoffTarget>,
    );
    const screen = await mounted;
    const target = document.querySelector<HTMLElement>(
      '[data-realtime-voice-handoff-target="main-thread"]',
    );
    if (!target) throw new Error("unmount handoff target missing");
    await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
    const animation = target.getAnimations()[0];
    if (!animation) throw new Error("unmount handoff animation missing");
    animation.currentTime = 40;
    void animation.finished.catch(() => undefined);

    await screen.unmount();

    expect(animation.playState).toBe("idle");
  });

  it("cancels the current sequence when reduced motion becomes active without replaying it", async () => {
    const motion: RealtimeVoiceHandoffMotion = {
      sequence: 6,
      from: "global-overlay",
      origin: null,
      velocity: null,
    };
    const mounted = render(
      <RealtimeVoiceHandoffTarget
        handoff={motion}
        reduceMotion={false}
        surface="main-thread"
        usesFadeTransition
      >
        <div>Reducible native handoff</div>
      </RealtimeVoiceHandoffTarget>,
    );
    const screen = await mounted;
    const target = document.querySelector<HTMLElement>(
      '[data-realtime-voice-handoff-target="main-thread"]',
    );
    if (!target) throw new Error("reduced-motion transition target missing");
    await vi.waitFor(() => expect(target.getAnimations()).toHaveLength(1));
    const animation = target.getAnimations()[0];
    if (!animation) throw new Error("reduced-motion transition animation missing");
    animation.currentTime = 40;
    void animation.finished.catch(() => undefined);

    await screen.rerender(
      <RealtimeVoiceHandoffTarget
        handoff={{ ...motion }}
        reduceMotion
        surface="main-thread"
        usesFadeTransition
      >
        <div>Reduced native handoff</div>
      </RealtimeVoiceHandoffTarget>,
    );
    expect(animation.playState).toBe("idle");
    expect(target.getAnimations()).toHaveLength(0);

    await screen.rerender(
      <RealtimeVoiceHandoffTarget
        handoff={{ ...motion }}
        reduceMotion={false}
        surface="main-thread"
        usesFadeTransition
      >
        <div>Still reduced native handoff</div>
      </RealtimeVoiceHandoffTarget>,
    );
    expect(target.getAnimations()).toHaveLength(0);
    await screen.unmount();
  });

  it("detaches a touch-dragged orb with its screen-space origin and velocity", async () => {
    const mounted = draggableSurface(false);
    try {
      await mounted.screen;
      const orb = draggableOrb();
      dispatchOrbPointer(orb, "pointerdown", { x: 100, y: 140 }, "touch");
      dispatchOrbPointer(orb, "pointermove", { x: 164, y: 128 }, "touch");
      const draggedRect = orb.getBoundingClientRect();
      dispatchOrbPointer(orb, "pointerup", { x: 164, y: 128 }, "touch");

      expect(mounted.detach).toHaveBeenCalledOnce();
      const motion = mounted.detach.mock.calls[0]?.[0];
      expect(motion?.origin.centerX).toBeCloseTo(
        window.screenX + draggedRect.left + draggedRect.width / 2,
        3,
      );
      expect(motion?.origin.centerY).toBeCloseTo(
        window.screenY + draggedRect.top + draggedRect.height / 2,
        3,
      );
      expect(Math.hypot(motion?.velocity?.x ?? 0, motion?.velocity?.y ?? 0)).toBeGreaterThan(0);
      expect(orb.style.transform).toBe("");
    } finally {
      await (await mounted.screen).unmount();
    }
  });

  it("snaps a sub-threshold drag back and removes tilt under reduced motion", async () => {
    const animated = draggableSurface(false);
    try {
      await animated.screen;
      const orb = draggableOrb();
      dispatchOrbPointer(orb, "pointerdown", { x: 100, y: 100 }, "mouse", 100);
      dispatchOrbPointer(orb, "pointermove", { x: 132, y: 100 }, "mouse", 300);
      const content = orb.querySelector<HTMLElement>(
        '[data-realtime-voice-draggable-orb-content="true"]',
      );
      const highlight = orb.querySelector<HTMLElement>(
        '[data-realtime-voice-drag-highlight="true"]',
      );
      if (!content || !highlight) throw new Error("Codex drag response layers missing");
      expect(orb.style.transform).toContain("translate3d(14.72px, 0px, 0px)");
      expect(content.style.transform).toContain("perspective(180px)");
      expect(content.style.transform).toContain("scale(1.00694)");
      expect(Number(highlight.style.opacity)).toBeGreaterThan(0);
      expect(highlight.style.transform).toContain("translate3d(0%");
      dispatchOrbPointer(orb, "pointerup", { x: 132, y: 100 }, "mouse", 500);
      expect(animated.detach).not.toHaveBeenCalled();
      await vi.waitFor(() => expect(orb.getAnimations()).toHaveLength(1));
      expect(orb.getAnimations()[0]?.effect?.getTiming().duration).toBe(280);
    } finally {
      await (await animated.screen).unmount();
    }

    const reduced = draggableSurface(true);
    try {
      await reduced.screen;
      const orb = draggableOrb();
      dispatchOrbPointer(orb, "pointerdown", { x: 100, y: 100 });
      dispatchOrbPointer(orb, "pointermove", { x: 104, y: 100 });
      expect(orb.style.transform).toBe("");
      dispatchOrbPointer(orb, "pointerup", { x: 104, y: 100 });
      expect(reduced.detach).not.toHaveBeenCalled();
      expect(orb.style.transform).toBe("");
      expect(orb.getAnimations()).toHaveLength(0);
    } finally {
      await (await reduced.screen).unmount();
    }
  });

  it("offers a keyboard action for moving the orb to the floating overlay", async () => {
    const mounted = draggableSurface();
    try {
      await mounted.screen;
      const orb = draggableOrb();
      expect(orb.type).toBe("button");
      expect(orb.getAttribute("aria-label")).toBe("Move voice chat to floating overlay");
      orb.dispatchEvent(
        new KeyboardEvent("keydown", {
          bubbles: true,
          cancelable: true,
          key: "Enter",
        }),
      );
      expect(mounted.detach).toHaveBeenCalledOnce();
      expect(mounted.detach.mock.calls[0]?.[0]?.velocity).toEqual({ x: 0, y: 0 });
    } finally {
      await (await mounted.screen).unmount();
    }
  });

  it("matches the active geometry, stays inside compact widths, and has no serious axe findings", async () => {
    await page.viewport(1_603, 915);
    document.documentElement.classList.add("dark");
    const mounted = activeSurface({ activity: "speaking" });
    try {
      await mounted.screen;
      const stage = document.querySelector<HTMLElement>("[data-moss-realtime-voice-stage]");
      const canvas = stage?.querySelector<HTMLCanvasElement>("canvas");
      const orb = canvas?.parentElement;
      const controls = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-composer-controls]",
      );
      if (!stage || !orb || !canvas || !controls) throw new Error("voice geometry missing");
      expect(stage && getComputedStyle(stage).height).toBe("208px");
      expect(orb && getComputedStyle(orb).width).toBe("112px");
      expect(canvas && getComputedStyle(canvas).width).toBe("152px");
      for (const button of controls?.querySelectorAll("button") ?? []) {
        expect(getComputedStyle(button).width).toBe("28px");
        expect(getComputedStyle(button).height).toBe("28px");
      }
      const fixture = document.querySelector<HTMLElement>("[data-testid='voice-fixture']");
      const axeResults = await axe.run(fixture ?? document.body, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        resultTypes: ["violations"],
      });
      expect(
        axeResults.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        ),
      ).toEqual([]);
      const screenshotPath = await page.screenshot({
        path: "../../../../../.tmp/realtime-voice/moss-realtime-voice-active-1603x915.png",
      });
      expect(screenshotPath).toContain("moss-realtime-voice-active-1603x915.png");

      await page.viewport(390, 844);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      document.documentElement.classList.remove("dark");
      await (await mounted.screen).unmount();
    }
  });
});
