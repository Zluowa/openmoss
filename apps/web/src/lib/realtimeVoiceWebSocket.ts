// FILE: realtimeVoiceWebSocket.ts
// Purpose: Carry domestic Realtime Voice media as bounded 24 kHz PCM16 over a ticketed relay WSS.
// Layer: Web media transport
/* oxlint-disable unicorn/prefer-add-event-listener -- Each owned media handle has one exclusive callback set that dispose clears atomically. */
/* oxlint-disable unicorn/require-post-message-target-origin -- AudioWorklet MessagePort.postMessage has no targetOrigin parameter. */

import type { RealtimeVoiceWebSocketPcm16Transport } from "@synara/contracts";

import {
  requestRealtimeVoiceInputCapture,
  type RealtimeVoiceOutputSignal,
  type RealtimeVoiceWebRtcCallbacks,
  type RealtimeVoiceWebRtcSnapshot,
} from "./realtimeVoiceWebRtc";

const WORKLET_URL = "/realtime-voice-pcm16-worklet.js";
const WORKLET_NAME = "moss-realtime-pcm16-capture";
const EXPECTED_PROTOCOL = "moss-realtime-pcm16-v1";
const EXPECTED_PATH = "/v1/realtime/media";
const TICKET_PATTERN = /^[A-Za-z0-9_-]{43}$/u;
const MAX_SERVER_EVENT_BYTES = 128 * 1_024;
const MAX_AUDIO_DELTA_BASE64_CHARS = 96 * 1_024;
const MAX_QUEUED_CHUNKS = 1_500;
const MAX_QUEUED_INPUT_BYTES = 1_500 * 960;
// The worklet emits 20 ms PCM16 frames (960 bytes at 24 kHz). Until the session starts, keep only the
// newest two seconds of opening speech: GPT-Live rejects input that arrives much faster than real
// time, so a slow connect must not flush a long backlog (the relay trims it too, as a second guard).
const MAX_PRE_ROLL_INPUT_BYTES = 100 * 960;
const MAX_SOCKET_BUFFERED_BYTES = 128 * 1_024;
const FLUSH_RETRY_MS = 12;
const AUDIO_CONTEXT_RESUME_GRACE_MS = 750;

export interface PreparedRealtimeVoiceWebSocketMedia {
  readonly inputDeviceId: string | null;
}

interface RealtimeVoiceWebSocketDependencies {
  readonly createAudioContext?: () => AudioContext;
  readonly createAudioWorkletNode?: (
    context: AudioContext,
    name: string,
    options: AudioWorkletNodeOptions,
  ) => AudioWorkletNode;
  readonly createWebSocket?: (url: string, protocols: string[]) => WebSocket;
  readonly now?: () => number;
  readonly maxQueuedInputBytes?: number;
}

function createMediaError(message: string, cause?: unknown): Error {
  const suffix = cause instanceof DOMException && cause.name ? ` (${cause.name})` : "";
  return new Error(`${message}${suffix}`);
}

function asRecord(value: unknown): Readonly<Record<string, unknown>> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Readonly<Record<string, unknown>>)
    : null;
}

async function resumeAudioContextWithoutBlocking(context: AudioContext): Promise<void> {
  if (context.state !== "suspended") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      resolve();
    };
    const timeout = window.setTimeout(finish, AUDIO_CONTEXT_RESUME_GRACE_MS);
    void context.resume().then(finish, finish);
  });
}

export function validateRealtimeVoiceWebSocketTransport(
  transport: RealtimeVoiceWebSocketPcm16Transport,
  now = Date.now(),
): URL {
  let url: URL;
  try {
    url = new URL(transport.url);
  } catch {
    throw new Error("The Realtime relay returned an invalid media URL.");
  }
  const loopback =
    url.hostname === "127.0.0.1" || url.hostname === "localhost" || url.hostname === "[::1]";
  if (
    (url.protocol !== "wss:" && !(loopback && url.protocol === "ws:")) ||
    url.username ||
    url.password ||
    url.pathname !== EXPECTED_PATH ||
    url.search ||
    url.hash ||
    transport.protocol !== EXPECTED_PROTOCOL ||
    transport.encoding !== "pcm16" ||
    transport.sampleRate !== 24_000 ||
    !TICKET_PATTERN.test(transport.ticket)
  ) {
    throw new Error("The Realtime relay returned an invalid media transport.");
  }
  const expiresAt = Date.parse(transport.expiresAt);
  if (
    !Number.isFinite(expiresAt) ||
    new Date(expiresAt).toISOString() !== transport.expiresAt ||
    expiresAt <= now ||
    expiresAt - now > 60_000
  ) {
    throw new Error("The Realtime relay media ticket expired.");
  }
  return url;
}

export function pcm16BytesToFloat32(bytes: Uint8Array): Float32Array {
  if (bytes.byteLength === 0 || bytes.byteLength % 2 !== 0) {
    throw new Error("Realtime Voice received invalid PCM16 audio.");
  }
  const samples = new Float32Array(bytes.byteLength / 2);
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  for (let index = 0; index < samples.length; index += 1) {
    const sample = view.getInt16(index * 2, true);
    samples[index] = sample < 0 ? sample / 32_768 : sample / 32_767;
  }
  return samples;
}

function arrayBufferToBase64(buffer: ArrayBuffer): string {
  const bytes = new Uint8Array(buffer);
  let binary = "";
  for (let offset = 0; offset < bytes.length; offset += 8_192) {
    binary += String.fromCharCode(...bytes.subarray(offset, offset + 8_192));
  }
  return btoa(binary);
}

function base64ToBytes(value: string): Uint8Array {
  if (
    value.length === 0 ||
    value.length > MAX_AUDIO_DELTA_BASE64_CHARS ||
    value.length % 4 !== 0 ||
    !/^[A-Za-z0-9+/]+={0,2}$/u.test(value)
  ) {
    throw new Error("Realtime Voice received invalid audio data.");
  }
  let binary: string;
  try {
    binary = atob(value);
  } catch {
    throw new Error("Realtime Voice received invalid audio data.");
  }
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

export function decodeRealtimeVoicePcm16Delta(value: string): Float32Array {
  return pcm16BytesToFloat32(base64ToBytes(value));
}

export class RealtimeVoiceWebSocketClient {
  readonly #callbacks: RealtimeVoiceWebRtcCallbacks;
  readonly #dependencies: Required<RealtimeVoiceWebSocketDependencies>;
  #socket: WebSocket | null = null;
  #audioContext: AudioContext | null = null;
  #inputStream: MediaStream | null = null;
  #releaseInput: (() => void) | null = null;
  #inputSource: MediaStreamAudioSourceNode | null = null;
  #workletNode: AudioWorkletNode | null = null;
  #captureDestination: MediaStreamAudioDestinationNode | null = null;
  #outputGain: GainNode | null = null;
  #outputAnalyser: AnalyserNode | null = null;
  #outputAnalysisFrame: number | null = null;
  #lastOutputAnalysisAt = 0;
  #nextPlaybackAt = 0;
  readonly #scheduledOutput = new Set<AudioBufferSourceNode>();
  readonly #queuedInput: ArrayBuffer[] = [];
  #queuedInputBytes = 0;
  #flushTimer: number | null = null;
  #acceptingInput = false;
  #disposed = false;
  #fatalRaised = false;
  #snapshot: RealtimeVoiceWebRtcSnapshot = {
    webRtcConnected: false,
    dataSessionInitialized: false,
    inputMuted: false,
    outputMuted: false,
  };

  constructor(
    callbacks: RealtimeVoiceWebRtcCallbacks,
    dependencies: RealtimeVoiceWebSocketDependencies = {},
  ) {
    this.#callbacks = callbacks;
    this.#dependencies = {
      createAudioContext: dependencies.createAudioContext ?? (() => new AudioContext()),
      createAudioWorkletNode:
        dependencies.createAudioWorkletNode ??
        ((context, name, options) => new AudioWorkletNode(context, name, options)),
      createWebSocket:
        dependencies.createWebSocket ?? ((url, protocols) => new WebSocket(url, protocols)),
      now: dependencies.now ?? Date.now,
      maxQueuedInputBytes: dependencies.maxQueuedInputBytes ?? MAX_QUEUED_INPUT_BYTES,
    };
    try {
      this.#audioContext = this.#dependencies.createAudioContext();
      void resumeAudioContextWithoutBlocking(this.#audioContext);
    } catch {
      // prepare() retries and raises the user-facing error.
    }
  }

  get snapshot(): RealtimeVoiceWebRtcSnapshot {
    return { ...this.#snapshot };
  }

  async prepare(inputDeviceId: string | null): Promise<PreparedRealtimeVoiceWebSocketMedia> {
    if (this.#disposed) throw new Error("Realtime Voice media has been closed.");
    if (this.#inputStream) throw new Error("Realtime Voice media is already prepared.");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw createMediaError("Microphone access is unavailable in this browser.");
    }
    if (typeof AudioWorkletNode === "undefined") {
      throw createMediaError("This browser does not support PCM16 microphone capture.");
    }
    try {
      const context =
        this.#audioContext && this.#audioContext.state !== "closed"
          ? this.#audioContext
          : this.#dependencies.createAudioContext();
      this.#audioContext = context;
      const input = await requestRealtimeVoiceInputCapture(context, inputDeviceId);
      this.#inputStream = input.stream;
      this.#releaseInput = input.release;
      if (input.silent) {
        this.#snapshot = { ...this.#snapshot, inputMuted: true };
        for (const track of input.stream.getAudioTracks()) track.enabled = false;
      }
      await resumeAudioContextWithoutBlocking(context);
      await context.audioWorklet.addModule(WORKLET_URL);
      const inputSource = context.createMediaStreamSource(this.#inputStream);
      const workletNode = this.#dependencies.createAudioWorkletNode(context, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const captureDestination = context.createMediaStreamDestination();
      workletNode.port.onmessage = (event: MessageEvent<unknown>) =>
        this.#handleWorkletMessage(event.data);
      inputSource.connect(workletNode);
      workletNode.connect(captureDestination);
      this.#inputSource = inputSource;
      this.#workletNode = workletNode;
      this.#captureDestination = captureDestination;
      this.#acceptingInput = true;
      if (this.#snapshot.inputMuted) {
        workletNode.port.postMessage({ type: "mute", muted: true });
      }
      return {
        inputDeviceId: input.silent
          ? null
          : (this.#inputStream.getAudioTracks()[0]?.getSettings().deviceId ?? null),
      };
    } catch (cause) {
      await this.dispose();
      if (cause instanceof Error && cause.message.startsWith("Realtime Voice")) throw cause;
      throw createMediaError("Moss could not start the microphone.", cause);
    }
  }

  async connect(transport: RealtimeVoiceWebSocketPcm16Transport): Promise<void> {
    if (!this.#inputStream || !this.#audioContext || this.#disposed || this.#fatalRaised) {
      throw new Error("Realtime Voice media is not prepared.");
    }
    if (this.#socket) throw new Error("Realtime Voice media is already connected.");
    let socket: WebSocket;
    try {
      const url = validateRealtimeVoiceWebSocketTransport(transport, this.#dependencies.now());
      socket = this.#dependencies.createWebSocket(url.href, [
        transport.protocol,
        `moss-ticket.${transport.ticket}`,
      ]);
    } catch (cause) {
      this.#stopInputCapture();
      throw cause;
    }
    this.#acceptingInput = true;
    this.#workletNode?.port.postMessage({ type: "mute", muted: this.#snapshot.inputMuted });
    this.#socket = socket;
    socket.onopen = () => {
      if (this.#disposed || this.#socket !== socket) return;
      if (socket.protocol !== transport.protocol) {
        this.#raiseFatal("Realtime Voice relay selected an invalid media protocol.");
        return;
      }
      this.#snapshot = { ...this.#snapshot, webRtcConnected: true };
      this.#emitSnapshot();
    };
    socket.onmessage = (event) => this.#handleServerEvent(event.data);
    socket.onerror = () => this.#raiseFatal("Realtime Voice media connection failed.");
    socket.onclose = (event) => {
      if (this.#disposed || this.#socket !== socket) return;
      this.#socket = null;
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      this.#stopInputCapture();
      this.#snapshot = {
        ...this.#snapshot,
        webRtcConnected: false,
        dataSessionInitialized: false,
      };
      this.#emitSnapshot();
      if (event.code === 1000) return;
      this.#raiseFatal(
        event.code === 1009
          ? "Realtime Voice media exceeded its safety limit."
          : "Realtime Voice media connection closed unexpectedly.",
      );
    };
  }

  setInputMuted(muted: boolean): void {
    if (this.#disposed || this.#fatalRaised) return;
    this.#snapshot = { ...this.#snapshot, inputMuted: muted };
    for (const track of this.#inputStream?.getAudioTracks() ?? []) track.enabled = !muted;
    this.#workletNode?.port.postMessage({ type: "mute", muted: muted || !this.#acceptingInput });
    if (muted) {
      this.#clearQueuedInput();
      this.#sendEvent({ type: "input_audio_buffer.clear" });
    }
    this.#emitSnapshot();
  }

  setOutputMuted(muted: boolean): void {
    this.#snapshot = { ...this.#snapshot, outputMuted: muted };
    if (this.#outputGain && this.#audioContext) {
      this.#outputGain.gain.setValueAtTime(muted ? 0 : 1, this.#audioContext.currentTime);
    }
    if (muted) this.#callbacks.onOutputSignal?.({ low: 0, mid: 0, high: 0, overall: 0 });
    this.#emitSnapshot();
  }

  async replaceMicrophone(inputDeviceId: string | null): Promise<string | null> {
    const context = this.#audioContext;
    const workletNode = this.#workletNode;
    if (!context || !workletNode || this.#disposed || this.#fatalRaised) {
      throw new Error("Realtime Voice media is not active.");
    }
    const replacement = await requestRealtimeVoiceInputCapture(context, inputDeviceId);
    const nextInputMuted = this.#snapshot.inputMuted || replacement.silent;
    let replacementSource: MediaStreamAudioSourceNode | null = null;
    try {
      replacementSource = context.createMediaStreamSource(replacement.stream);
      replacementSource.connect(workletNode);
      for (const track of replacement.stream.getAudioTracks()) {
        track.enabled = !nextInputMuted;
      }
    } catch (cause) {
      replacement.release();
      replacementSource?.disconnect();
      throw createMediaError("Moss could not switch microphones.", cause);
    }
    const previousSource = this.#inputSource;
    const releasePreviousInput = this.#releaseInput;
    this.#inputSource = replacementSource;
    this.#inputStream = replacement.stream;
    this.#releaseInput = replacement.release;
    previousSource?.disconnect();
    releasePreviousInput?.();
    if (nextInputMuted !== this.#snapshot.inputMuted) {
      this.#snapshot = { ...this.#snapshot, inputMuted: nextInputMuted };
      workletNode.port.postMessage({ type: "mute", muted: nextInputMuted });
      this.#clearQueuedInput();
      this.#sendEvent({ type: "input_audio_buffer.clear" });
      this.#emitSnapshot();
    }
    return replacement.silent
      ? null
      : (replacement.stream.getAudioTracks()[0]?.getSettings().deviceId ?? null);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    this.#stopInputCapture();
    const socket = this.#socket;
    this.#socket = null;
    if (socket) {
      socket.onopen = null;
      socket.onmessage = null;
      socket.onerror = null;
      socket.onclose = null;
      if (socket.readyState === WebSocket.OPEN || socket.readyState === WebSocket.CONNECTING) {
        socket.close(1000, "local session complete");
      }
    }
    this.#interruptOutput();
    if (this.#outputAnalysisFrame !== null) {
      window.cancelAnimationFrame(this.#outputAnalysisFrame);
      this.#outputAnalysisFrame = null;
    }
    this.#inputSource?.disconnect();
    this.#workletNode?.disconnect();
    if (this.#workletNode) this.#workletNode.port.onmessage = null;
    this.#captureDestination?.disconnect();
    this.#outputGain?.disconnect();
    this.#outputAnalyser?.disconnect();
    this.#inputSource = null;
    this.#workletNode = null;
    this.#captureDestination = null;
    this.#outputGain = null;
    this.#outputAnalyser = null;
    this.#releaseInput?.();
    this.#releaseInput = null;
    this.#inputStream = null;
    const context = this.#audioContext;
    this.#audioContext = null;
    await context?.close().catch(() => undefined);
    this.#callbacks.onRemoteStream?.(null);
  }

  #handleWorkletMessage(value: unknown): void {
    const record = asRecord(value);
    if (!record) return;
    if (record.type === "level") {
      const level = record.level;
      if (typeof level === "number" && Number.isFinite(level)) {
        this.#callbacks.onInputLevel?.(Math.max(0, Math.min(1, level)));
      }
      return;
    }
    if (record.type !== "pcm16" || !(record.buffer instanceof ArrayBuffer)) return;
    if (
      record.buffer.byteLength === 0 ||
      record.buffer.byteLength > 4_096 ||
      record.buffer.byteLength % 2 !== 0 ||
      !this.#acceptingInput ||
      this.#fatalRaised ||
      this.#snapshot.inputMuted ||
      this.#disposed
    ) {
      new Uint8Array(record.buffer).fill(0);
      return;
    }
    if (!this.#snapshot.dataSessionInitialized) {
      this.#retainPreRoll(record.buffer);
      return;
    }
    const queuedByteLimit = this.#dependencies.maxQueuedInputBytes;
    if (
      this.#queuedInput.length >= MAX_QUEUED_CHUNKS ||
      this.#queuedInputBytes + record.buffer.byteLength > queuedByteLimit
    ) {
      new Uint8Array(record.buffer).fill(0);
      this.#workletNode?.port.postMessage({ type: "mute", muted: true });
      this.#raiseFatal("Realtime Voice microphone upload could not keep up safely.");
      return;
    }
    this.#queuedInput.push(record.buffer);
    this.#queuedInputBytes += record.buffer.byteLength;
    this.#flushInput();
  }

  /** Keeps the newest opening audio within the pre-roll bound, scrubbing what it drops. */
  #retainPreRoll(buffer: ArrayBuffer): void {
    const limit = Math.min(this.#dependencies.maxQueuedInputBytes, MAX_PRE_ROLL_INPUT_BYTES);
    if (buffer.byteLength > limit) {
      new Uint8Array(buffer).fill(0);
      return;
    }
    while (
      this.#queuedInput.length > 0 &&
      (this.#queuedInput.length >= MAX_QUEUED_CHUNKS ||
        this.#queuedInputBytes + buffer.byteLength > limit)
    ) {
      const dropped = this.#queuedInput.shift()!;
      this.#queuedInputBytes -= dropped.byteLength;
      new Uint8Array(dropped).fill(0);
    }
    this.#queuedInput.push(buffer);
    this.#queuedInputBytes += buffer.byteLength;
  }

  #flushInput(): void {
    if (this.#flushTimer !== null) {
      window.clearTimeout(this.#flushTimer);
      this.#flushTimer = null;
    }
    const socket = this.#socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.#snapshot.dataSessionInitialized ||
      !this.#acceptingInput ||
      this.#fatalRaised ||
      this.#snapshot.inputMuted
    ) {
      return;
    }
    while (this.#queuedInput.length > 0 && socket.bufferedAmount <= MAX_SOCKET_BUFFERED_BYTES) {
      const chunk = this.#queuedInput[0];
      if (!chunk) break;
      const payload = JSON.stringify({
        type: "input_audio_buffer.append",
        audio: arrayBufferToBase64(chunk),
      });
      try {
        socket.send(payload);
      } catch {
        this.#raiseFatal("Realtime Voice microphone upload failed.");
        return;
      }
      this.#queuedInput.shift();
      this.#queuedInputBytes -= chunk.byteLength;
      new Uint8Array(chunk).fill(0);
    }
    if (this.#queuedInput.length > 0) {
      this.#flushTimer = window.setTimeout(() => {
        this.#flushTimer = null;
        this.#flushInput();
      }, FLUSH_RETRY_MS);
    }
  }

  #sendEvent(event: unknown): void {
    const socket = this.#socket;
    if (
      !socket ||
      socket.readyState !== WebSocket.OPEN ||
      !this.#snapshot.dataSessionInitialized ||
      this.#fatalRaised
    ) {
      return;
    }
    socket.send(JSON.stringify(event));
  }

  #handleServerEvent(raw: unknown): void {
    if (this.#disposed || this.#fatalRaised) return;
    if (
      typeof raw !== "string" ||
      new TextEncoder().encode(raw).byteLength > MAX_SERVER_EVENT_BYTES
    ) {
      this.#raiseFatal("Realtime Voice relay returned an invalid media event.");
      return;
    }
    let event: Readonly<Record<string, unknown>> | null = null;
    try {
      event = asRecord(JSON.parse(raw) as unknown);
    } catch {
      // Handled below as an invalid event.
    }
    if (!event || typeof event.type !== "string") {
      this.#raiseFatal("Realtime Voice relay returned an invalid media event.");
      return;
    }
    if (
      (event.type === "session.created" ||
        event.type === "session.updated" ||
        event.type === "session.started") &&
      !this.#snapshot.dataSessionInitialized
    ) {
      this.#snapshot = { ...this.#snapshot, dataSessionInitialized: true };
      this.#emitSnapshot();
      this.#flushInput();
      return;
    }
    if (event.type === "input_audio_buffer.speech_started") {
      this.#interruptOutput();
      return;
    }
    if (event.type === "response.output_audio.delta") {
      if (typeof event.delta !== "string") {
        this.#raiseFatal("Realtime Voice relay returned invalid audio data.");
        return;
      }
      try {
        this.#scheduleOutput(decodeRealtimeVoicePcm16Delta(event.delta));
      } catch (cause) {
        this.#raiseFatal(cause instanceof Error ? cause.message : "Realtime Voice audio failed.");
      }
    }
  }

  #scheduleOutput(samples: Float32Array): void {
    const context = this.#audioContext;
    if (!context || this.#disposed) return;
    void resumeAudioContextWithoutBlocking(context);
    const { gain, analyser } = this.#ensureOutputGraph(context);
    const buffer = context.createBuffer(1, samples.length, 24_000);
    buffer.getChannelData(0).set(samples);
    const source = context.createBufferSource();
    source.buffer = buffer;
    source.connect(gain);
    const startAt = Math.max(context.currentTime + 0.012, this.#nextPlaybackAt);
    this.#nextPlaybackAt = startAt + buffer.duration;
    this.#scheduledOutput.add(source);
    source.onended = () => {
      this.#scheduledOutput.delete(source);
      source.disconnect();
    };
    source.start(startAt);
    if (!this.#outputAnalysisFrame) this.#startOutputAnalysis(context, analyser);
  }

  #ensureOutputGraph(context: AudioContext): { gain: GainNode; analyser: AnalyserNode } {
    if (this.#outputGain && this.#outputAnalyser) {
      return { gain: this.#outputGain, analyser: this.#outputAnalyser };
    }
    const gain = context.createGain();
    gain.gain.value = this.#snapshot.outputMuted ? 0 : 1;
    const analyser = context.createAnalyser();
    analyser.fftSize = 2_048;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.86;
    gain.connect(analyser);
    analyser.connect(context.destination);
    this.#outputGain = gain;
    this.#outputAnalyser = analyser;
    return { gain, analyser };
  }

  #startOutputAnalysis(context: AudioContext, analyser: AnalyserNode): void {
    if (!this.#callbacks.onOutputSignal) return;
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const averageBand = (minimumHz: number, maximumHz: number): number => {
      const first = Math.max(0, Math.floor((minimumHz * analyser.fftSize) / context.sampleRate));
      const last = Math.min(
        frequencies.length - 1,
        Math.ceil((maximumHz * analyser.fftSize) / context.sampleRate),
      );
      let sum = 0;
      let count = 0;
      for (let index = first; index <= last; index += 1) {
        sum += frequencies[index] ?? 0;
        count += 1;
      }
      return count === 0 ? 0 : sum / count / 255;
    };
    const analyze = (now: number) => {
      if (this.#disposed || this.#outputAnalyser !== analyser) return;
      this.#outputAnalysisFrame = window.requestAnimationFrame(analyze);
      if (now - this.#lastOutputAnalysisAt < 1_000 / 30) return;
      this.#lastOutputAnalysisAt = now;
      analyser.getByteFrequencyData(frequencies);
      const low = averageBand(60, 300);
      const mid = averageBand(300, 2_000);
      const high = averageBand(2_000, 8_000);
      const signal: RealtimeVoiceOutputSignal = {
        low,
        mid,
        high,
        overall: Math.min(1, low * 0.42 + mid * 0.42 + high * 0.16),
      };
      this.#callbacks.onOutputSignal?.(signal);
    };
    this.#outputAnalysisFrame = window.requestAnimationFrame(analyze);
  }

  #interruptOutput(): void {
    for (const source of this.#scheduledOutput) {
      source.onended = null;
      try {
        source.stop();
      } catch {
        // The source may already have ended between the snapshot and stop().
      }
      source.disconnect();
    }
    this.#scheduledOutput.clear();
    this.#nextPlaybackAt = this.#audioContext?.currentTime ?? 0;
    this.#callbacks.onOutputSignal?.({ low: 0, mid: 0, high: 0, overall: 0 });
  }

  #emitSnapshot(): void {
    this.#callbacks.onSnapshot({ ...this.#snapshot });
  }

  #clearQueuedInput(): void {
    if (this.#flushTimer !== null) window.clearTimeout(this.#flushTimer);
    this.#flushTimer = null;
    for (const chunk of this.#queuedInput) new Uint8Array(chunk).fill(0);
    this.#queuedInput.length = 0;
    this.#queuedInputBytes = 0;
  }

  #stopInputCapture(): void {
    this.#acceptingInput = false;
    this.#clearQueuedInput();
    this.#workletNode?.port.postMessage({ type: "mute", muted: true });
  }

  #raiseFatal(message: string): void {
    if (this.#disposed || this.#fatalRaised) return;
    this.#fatalRaised = true;
    this.#stopInputCapture();
    this.#callbacks.onFatalError(new Error(message));
  }
}
