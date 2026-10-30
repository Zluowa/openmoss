import { readFileSync } from "node:fs";
import { createContext, Script } from "node:vm";

import { describe, expect, it, vi } from "vitest";

interface WorkletPort {
  onmessage: ((event: { data: unknown }) => void) | null;
  postMessage: ReturnType<typeof vi.fn>;
}

interface WorkletProcessorInstance {
  readonly port: WorkletPort;
  readonly maximumFrames: number;
  readonly bufferedFrames: number;
  readonly phase: "buffering" | "replaying" | "live";
  process(inputs: Float32Array[][], outputs: Float32Array[][]): boolean;
}

type WorkletProcessorConstructor = new () => WorkletProcessorInstance;

function loadProcessor(sampleRate: number): WorkletProcessorInstance {
  const source = readFileSync(
    new URL("../../public/realtime-voice-mic-worklet.js", import.meta.url),
    "utf8",
  );
  let registeredProcessor: WorkletProcessorConstructor | null = null;
  class AudioWorkletProcessorStub {
    readonly port: WorkletPort = {
      onmessage: null,
      postMessage: vi.fn(),
    };
  }
  const context = createContext({
    AudioWorkletProcessor: AudioWorkletProcessorStub,
    Float32Array,
    Math,
    currentTime: 0,
    sampleRate,
    registerProcessor: (name: string, processor: WorkletProcessorConstructor) => {
      expect(name).toBe("moss-realtime-mic-buffer");
      registeredProcessor = processor;
    },
  });
  new Script(source, { filename: "realtime-voice-mic-worklet.js" }).runInContext(context);
  if (!registeredProcessor) throw new Error("Realtime Voice worklet did not register a processor");
  const Processor = registeredProcessor as WorkletProcessorConstructor;
  return new Processor();
}

function processBlock(processor: WorkletProcessorInstance, source: Float32Array): Float32Array {
  const destination = new Float32Array(source.length);
  expect(processor.process([[source]], [[destination]])).toBe(true);
  return destination;
}

function sendCommand(processor: WorkletProcessorInstance, data: unknown): void {
  processor.port.onmessage?.({ data });
}

describe("Realtime Voice microphone worklet", () => {
  it("rescans the current 30-second ring at release instead of replaying overwritten speech", () => {
    const sampleRate = 1_000;
    const processor = loadProcessor(sampleRate);
    const openingSignal = new Float32Array(128);
    openingSignal[64] = 0.5;
    expect(processBlock(processor, openingSignal)).toEqual(new Float32Array(128));

    const silence = new Float32Array(128);
    const blocksToOverwriteSignal = Math.ceil((sampleRate * 30) / silence.length) + 1;
    for (let index = 0; index < blocksToOverwriteSignal; index += 1) {
      processBlock(processor, silence);
    }

    sendCommand(processor, { type: "release" });
    const liveSpeech = new Float32Array(128).fill(0.25);
    expect(processBlock(processor, liveSpeech)).toEqual(liveSpeech);
  });

  it("retains exactly 100ms before the first signal and then drains into live input", () => {
    const sampleRate = 1_000;
    const processor = loadProcessor(sampleRate);
    const buffered = new Float32Array(256);
    buffered[180] = 0.5;
    processBlock(processor, buffered);
    sendCommand(processor, { type: "release" });

    const replay = processBlock(processor, new Float32Array(256));
    expect(Array.from(replay.slice(0, 100))).toEqual(Array.from(new Float32Array(100)));
    expect(replay[100]).toBe(0.5);
    expect(replay[255]).toBe(0);

    const nextLiveBlock = new Float32Array(256).fill(0.25);
    expect(processBlock(processor, nextLiveBlock)).toEqual(nextLiveBlock);
  });

  it("keeps Moss mute and reset extensions fail-closed", () => {
    const sampleRate = 1_000;
    const processor = loadProcessor(sampleRate);
    processBlock(processor, new Float32Array(128).fill(0.5));
    sendCommand(processor, { type: "mute", muted: true });
    const silence = new Float32Array(128);
    const blocksBeyondCapacity = Math.ceil((sampleRate * 30) / silence.length) + 1;
    for (let index = 0; index < blocksBeyondCapacity; index += 1) {
      expect(processBlock(processor, silence)).toEqual(silence);
    }
    expect(processor.phase).toBe("buffering");
    expect(processor.bufferedFrames).toBe(processor.maximumFrames);

    sendCommand(processor, { type: "release" });
    expect(processBlock(processor, new Float32Array(128).fill(0.5))).toEqual(new Float32Array(128));
    expect(processor.phase).toBe("live");
    expect(processor.bufferedFrames).toBe(0);

    sendCommand(processor, { type: "mute", muted: false });
    expect(processBlock(processor, new Float32Array(128).fill(0.25))).toEqual(
      new Float32Array(128).fill(0.25),
    );

    sendCommand(processor, { type: "reset" });
    expect(processBlock(processor, new Float32Array(128).fill(0.5))).toEqual(new Float32Array(128));
  });

  it("drops already-buffered speech when microphone mute races the replay gate", () => {
    const processor = loadProcessor(1_000);
    processBlock(processor, new Float32Array(128).fill(0.5));
    sendCommand(processor, { type: "release" });
    expect(processor.phase).toBe("replaying");

    sendCommand(processor, { type: "mute", muted: true });
    expect(processor.bufferedFrames).toBe(0);
    expect(processBlock(processor, new Float32Array(128).fill(0.5))).toEqual(new Float32Array(128));
    expect(processor.phase).toBe("live");
  });
});
