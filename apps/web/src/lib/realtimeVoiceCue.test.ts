import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { playRealtimeVoiceCue } from "./realtimeVoiceCue";

type Listener = (event: Event) => void;

class MockAudioParam {
  readonly setValueAtTime = vi.fn();
  readonly linearRampToValueAtTime = vi.fn();
  readonly exponentialRampToValueAtTime = vi.fn();
}

class MockAudioNode {
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();
}

class MockGainNode extends MockAudioNode {
  readonly gain = new MockAudioParam();
}

class MockOscillatorNode extends MockAudioNode {
  readonly frequency = new MockAudioParam();
  readonly start = vi.fn();
  readonly stop = vi.fn();
  type: OscillatorType = "sine";

  readonly addEventListener = vi.fn((type: string, listener: Listener) => {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  });
  readonly removeEventListener = vi.fn((type: string, listener: Listener) => {
    this.listeners.get(type)?.delete(listener);
  });

  private readonly listeners = new Map<string, Set<Listener>>();

  emit(type: "ended" | "error"): void {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ type } as Event);
    }
  }
}

class MockAudioContext {
  static initialState: AudioContextState = "running";
  static rejectResume = false;
  static throwOnOscillatorCall: number | null = null;
  static readonly instances: MockAudioContext[] = [];

  readonly currentTime = 2.5;
  readonly destination = new MockAudioNode();
  readonly oscillators: MockOscillatorNode[] = [];
  readonly gains: MockGainNode[] = [];
  state = MockAudioContext.initialState;

  readonly createGain = vi.fn(() => {
    const gain = new MockGainNode();
    this.gains.push(gain);
    return gain;
  });
  readonly createOscillator = vi.fn(() => {
    if (this.oscillators.length === MockAudioContext.throwOnOscillatorCall) {
      throw new Error("oscillator unavailable");
    }
    const oscillator = new MockOscillatorNode();
    this.oscillators.push(oscillator);
    return oscillator;
  });
  readonly resume = vi.fn(() =>
    MockAudioContext.rejectResume
      ? Promise.reject(new Error("autoplay blocked"))
      : Promise.resolve(),
  );
  readonly close = vi.fn(() => {
    this.state = "closed";
    return Promise.resolve();
  });
  readonly addEventListener = vi.fn((type: string, listener: Listener) => {
    const listeners = this.listeners.get(type) ?? new Set<Listener>();
    listeners.add(listener);
    this.listeners.set(type, listeners);
  });
  readonly removeEventListener = vi.fn((type: string, listener: Listener) => {
    this.listeners.get(type)?.delete(listener);
  });

  private readonly listeners = new Map<string, Set<Listener>>();

  constructor() {
    MockAudioContext.instances.push(this);
  }

  static reset(): void {
    MockAudioContext.initialState = "running";
    MockAudioContext.rejectResume = false;
    MockAudioContext.throwOnOscillatorCall = null;
    MockAudioContext.instances.length = 0;
  }
}

function getContext(index = 0): MockAudioContext {
  const context = MockAudioContext.instances[index];
  if (!context) throw new Error(`Missing mock AudioContext at index ${index}`);
  return context;
}

function getOscillator(context: MockAudioContext, index: number): MockOscillatorNode {
  const oscillator = context.oscillators[index];
  if (!oscillator) throw new Error(`Missing mock oscillator at index ${index}`);
  return oscillator;
}

function getGain(context: MockAudioContext, index: number): MockGainNode {
  const gain = context.gains[index];
  if (!gain) throw new Error(`Missing mock gain at index ${index}`);
  return gain;
}

function ThrowingAudioContext(): never {
  throw new Error("audio device unavailable");
}

describe("playRealtimeVoiceCue", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    MockAudioContext.reset();
    vi.stubGlobal("AudioContext", MockAudioContext);
  });

  afterEach(async () => {
    await vi.runOnlyPendingTimersAsync();
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it("schedules the rising start bloom and its measured-length tail", () => {
    playRealtimeVoiceCue("start");

    const context = getContext();
    expect(context.oscillators).toHaveLength(3);
    expect(context.gains).toHaveLength(4);

    const lowVoice = getOscillator(context, 0);
    const middleVoice = getOscillator(context, 1);
    const highVoice = getOscillator(context, 2);
    expect(lowVoice.frequency.setValueAtTime).toHaveBeenCalledWith(225, 2.508);
    expect(lowVoice.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(280, 2.638);
    expect(middleVoice.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(330, 2.698);
    expect(highVoice.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(554, 2.708);
    expect(lowVoice.stop).toHaveBeenCalledWith(4.008);

    const masterEnvelope = getGain(context, 0).gain;
    expect(masterEnvelope.linearRampToValueAtTime).toHaveBeenCalledWith(0.29, 2.678);
    expect(masterEnvelope.exponentialRampToValueAtTime).toHaveBeenCalledWith(0.000001, 4.008);
  });

  it("schedules a descending end bloom before the long tail", () => {
    playRealtimeVoiceCue("end");

    const context = getContext();
    const lowVoice = getOscillator(context, 0);
    const octaveVoice = getOscillator(context, 1);
    expect(lowVoice.frequency.setValueAtTime).toHaveBeenCalledWith(330, 2.508);
    expect(lowVoice.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(222, 2.648);
    expect(octaveVoice.frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(444, 2.678);
    expect(lowVoice.stop).toHaveBeenCalledWith(4.088);
    expect(getGain(context, 0).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.3, 2.638);
  });

  it("schedules the build-6119 microphone mute pulse at the observed offset", () => {
    playRealtimeVoiceCue("mute");

    const context = getContext();
    expect(context.oscillators).toHaveLength(2);
    expect(getOscillator(context, 0).type).toBe("triangle");
    expect(getOscillator(context, 0).frequency.setValueAtTime).toHaveBeenCalledWith(410, 2.508);
    expect(getOscillator(context, 0).frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      265,
      2.526,
    );
    expect(getGain(context, 0).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.052, 2.559);
    expect(getOscillator(context, 0).stop).toHaveBeenCalledWith(3.766667);
  });

  it("schedules the build-6119 microphone unmute pulse at the observed offset", () => {
    playRealtimeVoiceCue("unmute");

    const context = getContext();
    expect(context.oscillators).toHaveLength(2);
    expect(getOscillator(context, 0).type).toBe("triangle");
    expect(getOscillator(context, 0).frequency.exponentialRampToValueAtTime).toHaveBeenCalledWith(
      430,
      2.533,
    );
    expect(getGain(context, 0).gain.linearRampToValueAtTime).toHaveBeenCalledWith(0.043, 2.688);
    expect(getOscillator(context, 0).stop).toHaveBeenCalledWith(3.766667);
  });

  it("keeps overlapping cues independent and cleans each on ended or error", () => {
    playRealtimeVoiceCue("start");
    playRealtimeVoiceCue("end");

    const startContext = getContext(0);
    const endContext = getContext(1);
    for (const oscillator of startContext.oscillators) oscillator.emit("ended");

    expect(startContext.close).toHaveBeenCalledOnce();
    expect(endContext.close).not.toHaveBeenCalled();
    expect(startContext.gains.every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);

    getOscillator(endContext, 0).emit("error");

    expect(endContext.close).toHaveBeenCalledOnce();
    expect(
      endContext.oscillators.every((oscillator) => oscillator.disconnect.mock.calls.length === 1),
    ).toBe(true);
  });

  it("closes and disconnects the graph when autoplay resume fails", async () => {
    MockAudioContext.initialState = "suspended";
    MockAudioContext.rejectResume = true;

    playRealtimeVoiceCue("start");
    await Promise.resolve();

    const context = getContext();
    expect(context.resume).toHaveBeenCalledOnce();
    expect(context.close).toHaveBeenCalledOnce();
    expect(context.gains.every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);
    expect(
      context.oscillators.every((oscillator) => oscillator.disconnect.mock.calls.length === 1),
    ).toBe(true);
  });

  it("cleans a partially constructed graph after a scheduling error", () => {
    MockAudioContext.throwOnOscillatorCall = 1;

    expect(() => playRealtimeVoiceCue("start")).not.toThrow();

    const context = getContext();
    expect(context.close).toHaveBeenCalledOnce();
    expect(getOscillator(context, 0).disconnect).toHaveBeenCalledOnce();
    expect(context.gains.every((gain) => gain.disconnect.mock.calls.length === 1)).toBe(true);
  });

  it("uses a watchdog when a browser omits source completion events", () => {
    playRealtimeVoiceCue("start");
    const context = getContext();

    vi.advanceTimersByTime(1_700);
    expect(context.close).not.toHaveBeenCalled();
    vi.advanceTimersByTime(100);

    expect(context.close).toHaveBeenCalledOnce();
  });

  it("is a silent no-op when Web Audio is unavailable or construction fails", () => {
    vi.stubGlobal("AudioContext", undefined);
    expect(() => playRealtimeVoiceCue("start")).not.toThrow();

    vi.stubGlobal("AudioContext", ThrowingAudioContext);
    expect(() => playRealtimeVoiceCue("end")).not.toThrow();
  });
});
