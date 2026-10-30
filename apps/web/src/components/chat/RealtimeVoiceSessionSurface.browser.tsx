// Production CSS is required for the immersive surface geometry and accessibility gate.
import "../../index.css";

import { ThreadId, type RealtimeVoiceState } from "@synara/contracts";
import axe from "axe-core";
import { page, userEvent } from "vitest/browser";
import { afterEach, describe, expect, it, vi } from "vitest";
import { render } from "vitest-browser-react";
import { useState } from "react";

import type { RealtimeVoiceHandoffMotion } from "./RealtimeVoiceHandoffTarget";
import { RealtimeVoiceSessionSurface } from "./RealtimeVoiceSessionSurface";

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

const silentOutput = () => ({ low: 0, mid: 0, high: 0, overall: 0 });

function installReducedMotionPreference(): void {
  vi.stubGlobal(
    "matchMedia",
    vi.fn(
      (query: string): MediaQueryList => ({
        matches: query === "(prefers-reduced-motion: reduce)",
        media: query,
        onchange: null,
        addEventListener: vi.fn(),
        removeEventListener: vi.fn(),
        addListener: vi.fn(),
        removeListener: vi.fn(),
        dispatchEvent: vi.fn(() => true),
      }),
    ),
  );
}

function callbacks() {
  return {
    submit: vi.fn(),
    stop: vi.fn(),
    input: vi.fn(),
    output: vi.fn(),
    detach: vi.fn(),
  };
}

function ControlledSurface(props: {
  readonly events: ReturnType<typeof callbacks>;
  readonly state?: RealtimeVoiceState;
  readonly disabled?: boolean;
  readonly handoff?: RealtimeVoiceHandoffMotion | null;
  readonly reduceMotion?: boolean;
  readonly canDetach?: boolean;
  readonly initialText?: string;
}) {
  const [text, setText] = useState(props.initialText ?? "");
  return (
    <main className="h-screen w-screen bg-white" data-testid="host-light-theme">
      <RealtimeVoiceSessionSurface
        state={props.state ?? activeState}
        transcript="Ready when you are"
        quota={quota}
        readOutputSignal={silentOutput}
        text={text}
        onTextChange={setText}
        onSubmit={props.events.submit}
        onStop={props.events.stop}
        onToggleInputMuted={props.events.input}
        onToggleOutputMuted={props.events.output}
        onDetachToGlobalOverlay={props.events.detach}
        {...(props.disabled === undefined ? {} : { disabled: props.disabled })}
        {...(props.handoff === undefined ? {} : { handoff: props.handoff })}
        {...(props.canDetach === undefined ? {} : { canDetachToGlobalOverlay: props.canDetach })}
        {...(props.reduceMotion === undefined ? {} : { reduceMotion: props.reduceMotion })}
        previewTimeMs={4_250}
      />
    </main>
  );
}

afterEach(() => {
  document.documentElement.classList.remove("dark");
  document.body.replaceChildren();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("RealtimeVoiceSessionSurface", () => {
  it("keeps the controlled composer and independent voice controls operational", async () => {
    const events = callbacks();
    const screen = await render(<ControlledSurface events={events} />);

    try {
      const textbox = page.getByRole("textbox", { name: "Message" });
      await expect.element(textbox).toHaveAttribute("placeholder", "Type anything");
      await textbox.fill("first line");
      const textboxElement = document.querySelector<HTMLTextAreaElement>(
        'textarea[placeholder="Type anything"]',
      );
      if (!textboxElement) throw new Error("voice composer textarea missing");
      const imeConfirmation = new KeyboardEvent("keydown", {
        bubbles: true,
        cancelable: true,
        key: "Enter",
      });
      Object.defineProperties(imeConfirmation, {
        keyCode: { value: 229 },
        which: { value: 229 },
      });
      textboxElement.dispatchEvent(imeConfirmation);
      expect(events.submit).not.toHaveBeenCalled();
      await userEvent.keyboard("{Shift>}{Enter}{/Shift}");
      expect(events.submit).not.toHaveBeenCalled();
      await textbox.fill("  coordinate agents  ");
      await userEvent.keyboard("{Enter}");
      expect(events.submit).toHaveBeenCalledOnce();
      expect(events.submit).toHaveBeenCalledWith("  coordinate agents  ");

      await page.getByRole("button", { name: "Mute voice output" }).click();
      await page.getByRole("button", { name: "Mute microphone" }).click();
      await page.getByRole("button", { name: "End voice chat" }).click();
      expect(events.output).toHaveBeenCalledOnce();
      expect(events.input).toHaveBeenCalledOnce();
      expect(events.stop).toHaveBeenCalledOnce();
    } finally {
      await screen.unmount();
    }
  });

  it("inherits the host theme while preserving Codex geometry and passes the focused axe gate", async () => {
    await page.viewport(1_603, 915);
    const events = callbacks();
    const screen = await render(<ControlledSurface events={events} />);

    try {
      const surface = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-session-surface]",
      );
      const column = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-session-column]",
      );
      const composer = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-session-composer]",
      );
      const stage = document.querySelector<HTMLElement>("[data-moss-realtime-voice-stage]");
      const orbCanvas = stage?.querySelector<HTMLCanvasElement>("canvas");
      const orb = orbCanvas?.parentElement;
      const controls = document.querySelector<HTMLElement>(
        "[data-moss-realtime-voice-composer-controls]",
      );
      if (!surface || !column || !composer || !stage || !orb || !controls) {
        throw new Error("immersive Realtime Voice geometry missing");
      }

      expect(surface.dataset.theme).toBe("inherit");
      expect(surface.classList.contains("dark")).toBe(false);
      expect(surface.classList.contains("bg-background")).toBe(true);
      const lightBackground = getComputedStyle(surface).backgroundColor;
      document.documentElement.classList.add("dark");
      await vi.waitFor(() => {
        expect(getComputedStyle(surface).backgroundColor).not.toBe(lightBackground);
      });
      document.documentElement.classList.remove("dark");
      expect(getComputedStyle(column).maxWidth).toBe("900px");
      expect(getComputedStyle(stage).height).toBe("208px");
      expect(getComputedStyle(orb).width).toBe("112px");
      expect(getComputedStyle(orbCanvas).filter).toBe("none");
      expect(getComputedStyle(composer).height).toBe("96px");
      expect(getComputedStyle(composer).borderRadius).toBe("16px");
      expect(getComputedStyle(composer).maxWidth).toBe("900px");
      expect(composer.getBoundingClientRect().width).toBe(900);
      for (const button of controls.querySelectorAll("button")) {
        expect(getComputedStyle(button).width).toBe("28px");
        expect(getComputedStyle(button).height).toBe("28px");
      }
      const endButton = controls.querySelector<HTMLButtonElement>(
        'button[aria-label="End voice chat"]',
      );
      if (!endButton) throw new Error("end voice control missing");
      expect(endButton.className).toContain("bg-[var(--color-text-foreground)]");

      const axeResults = await axe.run(surface, {
        runOnly: { type: "tag", values: ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa"] },
        resultTypes: ["violations"],
      });
      expect(
        axeResults.violations.filter(
          (violation) => violation.impact === "serious" || violation.impact === "critical",
        ),
      ).toEqual([]);

      await page.viewport(320, 640);
      expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(window.innerWidth);
      expect(document.documentElement.scrollHeight).toBeLessThanOrEqual(window.innerHeight);
    } finally {
      await screen.unmount();
    }
  });

  it("disables composer interaction outside the active phase", async () => {
    const events = callbacks();
    const startingState: RealtimeVoiceState = {
      ...activeState,
      phase: "starting",
      activity: null,
      barrier: { ...activeState.barrier, dataSessionInitialized: false },
    };
    const screen = await render(
      <ControlledSurface events={events} state={startingState} initialText="queued text" />,
    );

    try {
      await expect.element(page.getByRole("textbox", { name: "Message" })).toBeDisabled();
      document
        .querySelector<HTMLFormElement>("[data-moss-realtime-voice-session-composer]")
        ?.requestSubmit();
      expect(events.submit).not.toHaveBeenCalled();
      await expect.element(page.getByRole("button", { name: "End voice chat" })).toBeEnabled();
      expect(
        document
          .querySelector("[data-moss-realtime-voice-session-surface]")
          ?.getAttribute("data-interactive"),
      ).toBe("false");
    } finally {
      await screen.unmount();
    }
  });

  it("forwards reduced-motion handoff and keyboard detach behavior to the existing stage", async () => {
    installReducedMotionPreference();
    const events = callbacks();
    const handoff: RealtimeVoiceHandoffMotion = {
      sequence: 7,
      from: "global-overlay",
      origin: null,
      velocity: null,
    };
    const screen = await render(
      <ControlledSurface events={events} handoff={handoff} reduceMotion canDetach />,
    );

    try {
      const target = document.querySelector<HTMLElement>(
        '[data-realtime-voice-handoff-target="main-thread"]',
      );
      const draggableOrb = document.querySelector<HTMLButtonElement>(
        "[data-realtime-voice-draggable-orb]",
      );
      if (!target || !draggableOrb) throw new Error("voice handoff target missing");
      expect(target.getAnimations()).toHaveLength(0);

      draggableOrb.focus();
      await userEvent.keyboard("{Enter}");
      expect(events.detach).toHaveBeenCalledOnce();
      expect(events.detach.mock.calls[0]?.[0]?.velocity).toEqual({ x: 0, y: 0 });
    } finally {
      await screen.unmount();
    }
  });
});
