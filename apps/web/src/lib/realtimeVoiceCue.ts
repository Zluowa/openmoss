// Moss-owned synthesized cues; no bundled or copied audio assets.

type RealtimeVoiceCueKind = "start" | "end" | "mute" | "unmute";

type CueVoice = {
  readonly type: OscillatorType;
  readonly fromHz: number;
  readonly toHz: number;
  readonly glideSeconds: number;
  readonly onsetSeconds: number;
  readonly attackSeconds: number;
  readonly gain: number;
};

type CueProfile = {
  readonly durationSeconds: number;
  readonly envelope: ReadonlyArray<
    readonly [offsetSeconds: number, gain: number, curve: "set" | "linear" | "exponential"]
  >;
  readonly voices: ReadonlyArray<CueVoice>;
};

type ActiveCue = {
  readonly context: AudioContext;
  cleanup(): void;
};

const SILENCE_GAIN = 0.000001;
const SCHEDULE_LEAD_SECONDS = 0.008;
const CLEANUP_GRACE_SECONDS = 0.25;

// These profiles are an original synthesis based only on perceptual measurements:
// a quick tonal bloom followed by a soft, roughly 1.5 second bell-like tail.
const CUE_PROFILES: Readonly<Record<RealtimeVoiceCueKind, CueProfile>> = {
  start: {
    durationSeconds: 1.5,
    envelope: [
      [0, SILENCE_GAIN, "set"],
      [0.008, SILENCE_GAIN, "linear"],
      [0.055, 0.21, "linear"],
      [0.17, 0.29, "linear"],
      [1.5, SILENCE_GAIN, "exponential"],
    ],
    voices: [
      {
        type: "sine",
        fromHz: 225,
        toHz: 280,
        glideSeconds: 0.13,
        onsetSeconds: 0,
        attackSeconds: 0.018,
        gain: 0.54,
      },
      {
        type: "sine",
        fromHz: 276,
        toHz: 330,
        glideSeconds: 0.19,
        onsetSeconds: 0.055,
        attackSeconds: 0.07,
        gain: 0.63,
      },
      {
        type: "sine",
        fromHz: 500,
        toHz: 554,
        glideSeconds: 0.2,
        onsetSeconds: 0.12,
        attackSeconds: 0.045,
        gain: 0.3,
      },
    ],
  },
  end: {
    durationSeconds: 1.58,
    envelope: [
      [0, SILENCE_GAIN, "set"],
      [0.03, SILENCE_GAIN, "linear"],
      [0.075, 0.12, "linear"],
      [0.13, 0.3, "linear"],
      [1.58, 0.000008, "exponential"],
    ],
    voices: [
      {
        type: "sine",
        fromHz: 330,
        toHz: 222,
        glideSeconds: 0.14,
        onsetSeconds: 0.015,
        attackSeconds: 0.075,
        gain: 0.72,
      },
      {
        type: "sine",
        fromHz: 640,
        toHz: 444,
        glideSeconds: 0.17,
        onsetSeconds: 0.065,
        attackSeconds: 0.055,
        gain: 0.38,
      },
      {
        type: "sine",
        fromHz: 350,
        toHz: 330,
        glideSeconds: 0.16,
        onsetSeconds: 0,
        attackSeconds: 0.035,
        gain: 0.2,
      },
    ],
  },
  // Build 6119 added separate microphone-state cues. The observed assets are
  // 1.2587-second containers whose audible content is a very quiet, short pulse:
  // mute begins near 47 ms and unmute near 172 ms. These are Moss-owned
  // synthesis profiles based on those timing/spectral measurements, not copied
  // audio assets.
  mute: {
    durationSeconds: 1.258667,
    envelope: [
      [0, SILENCE_GAIN, "set"],
      [0.046, SILENCE_GAIN, "linear"],
      [0.051, 0.052, "linear"],
      [0.061, SILENCE_GAIN, "exponential"],
      [1.258667, SILENCE_GAIN, "set"],
    ],
    voices: [
      {
        type: "triangle",
        fromHz: 410,
        toHz: 265,
        glideSeconds: 0.018,
        onsetSeconds: 0.044,
        attackSeconds: 0.005,
        gain: 0.82,
      },
      {
        type: "sine",
        fromHz: 1_020,
        toHz: 620,
        glideSeconds: 0.016,
        onsetSeconds: 0.046,
        attackSeconds: 0.004,
        gain: 0.36,
      },
    ],
  },
  unmute: {
    durationSeconds: 1.258667,
    envelope: [
      [0, SILENCE_GAIN, "set"],
      [0.171, SILENCE_GAIN, "linear"],
      [0.18, 0.043, "linear"],
      [0.196, SILENCE_GAIN, "exponential"],
      [1.258667, SILENCE_GAIN, "set"],
    ],
    voices: [
      {
        type: "triangle",
        fromHz: 270,
        toHz: 430,
        glideSeconds: 0.025,
        onsetSeconds: 0.168,
        attackSeconds: 0.009,
        gain: 0.78,
      },
      {
        type: "sine",
        fromHz: 640,
        toHz: 1_080,
        glideSeconds: 0.024,
        onsetSeconds: 0.171,
        attackSeconds: 0.008,
        gain: 0.32,
      },
    ],
  },
};

// Each cue owns its AudioContext. Keeping all live cues allows overlapping
// lifecycle transitions without cutting off an earlier cue or leaking a context.
const activeCues = new Set<ActiveCue>();

function safelyCloseContext(context: AudioContext): void {
  if (context.state === "closed") return;
  try {
    void context.close().catch(() => undefined);
  } catch {
    // Audio shutdown is best-effort and must never affect voice state changes.
  }
}

function scheduleEnvelope(
  parameter: AudioParam,
  at: number,
  envelope: CueProfile["envelope"],
): void {
  for (const [offsetSeconds, gain, curve] of envelope) {
    const time = at + offsetSeconds;
    if (curve === "set") {
      parameter.setValueAtTime(gain, time);
    } else if (curve === "linear") {
      parameter.linearRampToValueAtTime(gain, time);
    } else {
      parameter.exponentialRampToValueAtTime(gain, time);
    }
  }
}

export function playRealtimeVoiceCue(kind: RealtimeVoiceCueKind): void {
  const AudioContextConstructor = globalThis.AudioContext;
  if (typeof AudioContextConstructor !== "function") return;

  let context: AudioContext;
  try {
    context = new AudioContextConstructor();
  } catch {
    return;
  }

  const profile = CUE_PROFILES[kind];
  const sources: OscillatorNode[] = [];
  const nodes: AudioNode[] = [];
  let remainingSources = 0;
  let cleaned = false;
  let watchdog: ReturnType<typeof globalThis.setTimeout> | null = null;

  const onSourceEnded = () => {
    remainingSources = Math.max(0, remainingSources - 1);
    if (remainingSources === 0) cleanup();
  };
  const onSourceError = () => cleanup();
  const onContextStateChange = () => {
    if (context.state === "closed") cleanup();
  };

  const cue: ActiveCue = { context, cleanup };
  activeCues.add(cue);

  function cleanup(): void {
    if (cleaned) return;
    cleaned = true;
    activeCues.delete(cue);

    if (watchdog !== null) {
      globalThis.clearTimeout(watchdog);
      watchdog = null;
    }

    context.removeEventListener("statechange", onContextStateChange);
    for (const source of sources) {
      source.removeEventListener("ended", onSourceEnded);
      source.removeEventListener("error", onSourceError);
      if (remainingSources > 0 && context.state !== "closed") {
        try {
          source.stop();
        } catch {
          // A source that already ended cannot be stopped again.
        }
      }
    }
    for (const node of nodes) {
      try {
        node.disconnect();
      } catch {
        // A partially constructed graph may already be disconnected.
      }
    }
    safelyCloseContext(context);
  }

  try {
    const at = context.currentTime + SCHEDULE_LEAD_SECONDS;
    const masterGain = context.createGain();
    nodes.push(masterGain);
    scheduleEnvelope(masterGain.gain, at, profile.envelope);
    masterGain.connect(context.destination);

    for (const voice of profile.voices) {
      const oscillator = context.createOscillator();
      const voiceGain = context.createGain();
      sources.push(oscillator);
      nodes.push(oscillator, voiceGain);
      remainingSources += 1;

      oscillator.type = voice.type;
      oscillator.frequency.setValueAtTime(voice.fromHz, at);
      oscillator.frequency.exponentialRampToValueAtTime(voice.toHz, at + voice.glideSeconds);

      voiceGain.gain.setValueAtTime(SILENCE_GAIN, at);
      voiceGain.gain.setValueAtTime(SILENCE_GAIN, at + voice.onsetSeconds);
      voiceGain.gain.linearRampToValueAtTime(
        voice.gain,
        at + voice.onsetSeconds + voice.attackSeconds,
      );

      oscillator.connect(voiceGain);
      voiceGain.connect(masterGain);
      oscillator.addEventListener("ended", onSourceEnded, { once: true });
      oscillator.addEventListener("error", onSourceError, { once: true });
      oscillator.start(at);
      oscillator.stop(at + profile.durationSeconds);
    }

    context.addEventListener("statechange", onContextStateChange);
    watchdog = globalThis.setTimeout(
      cleanup,
      (SCHEDULE_LEAD_SECONDS + profile.durationSeconds + CLEANUP_GRACE_SECONDS) * 1_000,
    );

    if (context.state === "closed") {
      cleanup();
      return;
    }
    if (context.state === "suspended") {
      try {
        void context.resume().catch(cleanup);
      } catch {
        cleanup();
      }
    }
  } catch {
    cleanup();
  }
}
