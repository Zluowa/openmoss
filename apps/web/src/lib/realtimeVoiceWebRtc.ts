// FILE: realtimeVoiceWebRtc.ts
// Purpose: Own the browser media and WebRTC half of a Realtime Voice session.
// Layer: Web media transport

const WORKLET_URL = "/realtime-voice-mic-worklet.js";
const WORKLET_NAME = "moss-realtime-mic-buffer";
const ICE_GATHER_TIMEOUT_MS = 2_500;
const AUDIO_CONTEXT_RESUME_GRACE_MS = 750;
const TRANSIENT_DISCONNECT_GRACE_MS = 2_000;
const MAX_DATA_EVENT_BYTES = 128 * 1_024;

export interface RealtimeVoiceWebRtcSnapshot {
  readonly webRtcConnected: boolean;
  readonly dataSessionInitialized: boolean;
  readonly inputMuted: boolean;
  readonly outputMuted: boolean;
}

export interface RealtimeVoiceOutputSignal {
  readonly low: number;
  readonly mid: number;
  readonly high: number;
  readonly overall: number;
}

export interface RealtimeVoiceWebRtcCallbacks {
  readonly onSnapshot: (snapshot: RealtimeVoiceWebRtcSnapshot) => void;
  readonly onInputLevel?: (level: number) => void;
  readonly onOutputSignal?: (signal: RealtimeVoiceOutputSignal) => void;
  readonly onRemoteStream?: (stream: MediaStream | null) => void;
  readonly onFatalError: (error: Error) => void;
}

interface PreparedMedia {
  readonly offerSdp: string;
  readonly inputDeviceId: string | null;
}

export interface RealtimeVoiceInputCapture {
  readonly stream: MediaStream;
  readonly silent: boolean;
  readonly release: () => void;
}

function createMediaError(message: string, cause?: unknown): Error {
  const suffix = cause instanceof DOMException && cause.name ? ` (${cause.name})` : "";
  return new Error(`${message}${suffix}`);
}

function microphoneConstraints(inputDeviceId: string | null): MediaStreamConstraints {
  return {
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true,
      ...(inputDeviceId ? { deviceId: { exact: inputDeviceId } } : {}),
    },
  };
}

function mediaDeviceWasNotFound(cause: unknown): cause is DOMException {
  return cause instanceof DOMException && cause.name === "NotFoundError";
}

function releaseMediaStream(stream: MediaStream): void {
  for (const track of stream.getTracks()) track.stop();
}

function createRealtimeVoiceMicrophoneCapture(stream: MediaStream): RealtimeVoiceInputCapture {
  let released = false;
  return {
    stream,
    silent: false,
    release: () => {
      if (released) return;
      released = true;
      releaseMediaStream(stream);
    },
  };
}

function createRealtimeVoiceSilentCapture(context: AudioContext): RealtimeVoiceInputCapture {
  const destination = context.createMediaStreamDestination();
  const source = context.createConstantSource();
  source.offset.value = 0;
  source.connect(destination);
  source.start();
  const stream = destination.stream;
  if (stream.getAudioTracks().length === 0) {
    source.stop();
    source.disconnect();
    destination.disconnect();
    throw createMediaError("The browser did not create a silent voice input.");
  }
  let released = false;
  return {
    stream,
    silent: true,
    release: () => {
      if (released) return;
      released = true;
      try {
        source.stop();
      } catch {
        // A racing AudioContext close may already have stopped the source.
      }
      source.disconnect();
      destination.disconnect();
      releaseMediaStream(stream);
    },
  };
}

async function browserHasNoAudioInputDevices(): Promise<boolean> {
  const enumerateDevices = navigator.mediaDevices.enumerateDevices;
  if (typeof enumerateDevices !== "function") return false;
  try {
    const devices = await enumerateDevices.call(navigator.mediaDevices);
    return devices.every((device) => device.kind !== "audioinput");
  } catch {
    // An unreadable device list is not proof that the machine has no input.
    return false;
  }
}

export async function requestRealtimeVoiceInputCapture(
  context: AudioContext,
  inputDeviceId: string | null,
): Promise<RealtimeVoiceInputCapture> {
  let failure: unknown;
  try {
    const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(inputDeviceId));
    return createRealtimeVoiceMicrophoneCapture(stream);
  } catch (cause) {
    failure = cause;
  }

  if (
    inputDeviceId &&
    failure instanceof DOMException &&
    (failure.name === "NotFoundError" || failure.name === "OverconstrainedError")
  ) {
    try {
      const stream = await navigator.mediaDevices.getUserMedia(microphoneConstraints(null));
      return createRealtimeVoiceMicrophoneCapture(stream);
    } catch (cause) {
      failure = cause;
    }
  }

  // A synthetic input is allowed only for confirmed hardware absence. In
  // particular, NotAllowedError and unreadable device inventories remain fatal.
  if (mediaDeviceWasNotFound(failure) && (await browserHasNoAudioInputDevices())) {
    return createRealtimeVoiceSilentCapture(context);
  }
  throw failure;
}

export function isRealtimeVoiceSessionInitializationEvent(value: unknown): boolean {
  if (!value || typeof value !== "object" || Array.isArray(value)) return false;
  const type = (value as { type?: unknown }).type;
  return type === "session.created" || type === "session.updated" || type === "session.started";
}

async function waitForIceGathering(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    let settled = false;
    const finish = () => {
      if (settled) return;
      settled = true;
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onStateChange);
      resolve();
    };
    const onStateChange = () => {
      if (peer.iceGatheringState === "complete") finish();
    };
    const timeout = window.setTimeout(finish, ICE_GATHER_TIMEOUT_MS);
    peer.addEventListener("icegatheringstatechange", onStateChange);
  });
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

export class RealtimeVoiceWebRtcClient {
  readonly #callbacks: RealtimeVoiceWebRtcCallbacks;
  #peer: RTCPeerConnection | null = null;
  #dataChannel: RTCDataChannel | null = null;
  #audioContext: AudioContext | null = null;
  #sourceNode: MediaStreamAudioSourceNode | null = null;
  #workletNode: AudioWorkletNode | null = null;
  #destinationNode: MediaStreamAudioDestinationNode | null = null;
  #inputStream: MediaStream | null = null;
  #releaseInput: (() => void) | null = null;
  #outputStream: MediaStream | null = null;
  #outputSourceNode: MediaStreamAudioSourceNode | null = null;
  #outputAnalyser: AnalyserNode | null = null;
  #outputAnalysisFrame: number | null = null;
  #lastOutputAnalysisAt = 0;
  #audioElement: HTMLAudioElement | null = null;
  #disconnectTimer: number | null = null;
  #disposed = false;
  #fatalRaised = false;
  #snapshot: RealtimeVoiceWebRtcSnapshot = {
    webRtcConnected: false,
    dataSessionInitialized: false,
    inputMuted: false,
    outputMuted: false,
  };

  constructor(callbacks: RealtimeVoiceWebRtcCallbacks) {
    this.#callbacks = callbacks;
    // Construct while the launch click/key gesture is still on the stack. The
    // ownership RPC runs before microphone preparation and can otherwise spend
    // Chromium's transient activation before an AudioContext exists.
    try {
      this.#audioContext = new AudioContext();
      void resumeAudioContextWithoutBlocking(this.#audioContext);
    } catch {
      // prepare() retries and reports the user-facing media error.
    }
  }

  get snapshot(): RealtimeVoiceWebRtcSnapshot {
    return { ...this.#snapshot };
  }

  async prepare(inputDeviceId: string | null): Promise<PreparedMedia> {
    if (this.#disposed) throw new Error("Realtime Voice media has been closed.");
    if (this.#peer) throw new Error("Realtime Voice media is already prepared.");
    if (!navigator.mediaDevices?.getUserMedia) {
      throw createMediaError("Microphone access is unavailable in this browser.");
    }
    if (typeof AudioWorkletNode === "undefined") {
      throw createMediaError("This browser does not support buffered microphone audio.");
    }

    try {
      const audioContext =
        this.#audioContext && this.#audioContext.state !== "closed"
          ? this.#audioContext
          : new AudioContext();
      this.#audioContext = audioContext;
      const input = await requestRealtimeVoiceInputCapture(audioContext, inputDeviceId);
      this.#inputStream = input.stream;
      this.#releaseInput = input.release;
      if (input.silent) {
        this.#snapshot = { ...this.#snapshot, inputMuted: true };
        for (const track of input.stream.getAudioTracks()) track.enabled = false;
      }
      // Chromium can leave resume() pending indefinitely without a trusted user
      // gesture. Loading and wiring the worklet is still safe while suspended;
      // the launch gesture or the first remote track can resume playback later.
      await resumeAudioContextWithoutBlocking(audioContext);
      await audioContext.audioWorklet.addModule(WORKLET_URL);

      const sourceNode = audioContext.createMediaStreamSource(this.#inputStream);
      const workletNode = new AudioWorkletNode(audioContext, WORKLET_NAME, {
        numberOfInputs: 1,
        numberOfOutputs: 1,
        outputChannelCount: [1],
      });
      const destinationNode = audioContext.createMediaStreamDestination();
      workletNode.port.onmessage = (event: MessageEvent<unknown>) => {
        const payload = event.data;
        if (!payload || typeof payload !== "object" || Array.isArray(payload)) return;
        const level = (payload as { level?: unknown }).level;
        if (typeof level === "number" && Number.isFinite(level)) {
          this.#callbacks.onInputLevel?.(Math.max(0, Math.min(1, level)));
        }
      };
      sourceNode.connect(workletNode);
      workletNode.connect(destinationNode);
      if (this.#snapshot.inputMuted) {
        for (const track of destinationNode.stream.getAudioTracks()) track.enabled = false;
        workletNode.port.postMessage({ type: "mute", muted: true });
      }
      this.#sourceNode = sourceNode;
      this.#workletNode = workletNode;
      this.#destinationNode = destinationNode;

      const peer = new RTCPeerConnection();
      this.#peer = peer;
      for (const track of destinationNode.stream.getAudioTracks()) {
        peer.addTrack(track, destinationNode.stream);
      }
      peer.ontrack = (event) => this.#handleRemoteTrack(event);
      peer.onconnectionstatechange = () => this.#handleConnectionState();

      const dataChannel = peer.createDataChannel("oai-events", { ordered: true });
      this.#dataChannel = dataChannel;
      dataChannel.onmessage = (event) => this.#handleDataEvent(event.data);
      dataChannel.onerror = () => this.#raiseFatal("Realtime Voice data channel failed.");
      dataChannel.onclose = () => {
        if (!this.#disposed && this.#snapshot.webRtcConnected) {
          this.#raiseFatal("Realtime Voice data channel closed unexpectedly.");
        }
      };

      const offer = await peer.createOffer();
      if (!offer.sdp) throw createMediaError("The browser did not create a voice offer.");
      await peer.setLocalDescription(offer);
      await waitForIceGathering(peer);
      const offerSdp = peer.localDescription?.sdp;
      if (!offerSdp) throw createMediaError("The browser did not finish the voice offer.");
      return {
        offerSdp,
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

  async applyAnswer(sdp: string): Promise<void> {
    const peer = this.#peer;
    if (!peer || this.#disposed) throw new Error("Realtime Voice media is not prepared.");
    if (!sdp.trim()) throw new Error("The Realtime relay returned an empty answer.");
    await peer.setRemoteDescription({ type: "answer", sdp });
  }

  setInputMuted(muted: boolean): void {
    this.#snapshot = { ...this.#snapshot, inputMuted: muted };
    for (const track of this.#inputStream?.getAudioTracks() ?? []) track.enabled = !muted;
    for (const track of this.#destinationNode?.stream.getAudioTracks() ?? []) {
      track.enabled = !muted;
    }
    this.#workletNode?.port.postMessage({ type: "mute", muted });
    this.#emitSnapshot();
  }

  setOutputMuted(muted: boolean): void {
    this.#snapshot = { ...this.#snapshot, outputMuted: muted };
    if (this.#audioElement) this.#audioElement.muted = muted;
    this.#emitSnapshot();
  }

  async replaceMicrophone(inputDeviceId: string | null): Promise<string | null> {
    const audioContext = this.#audioContext;
    const workletNode = this.#workletNode;
    if (!audioContext || !workletNode || this.#disposed) {
      throw new Error("Realtime Voice media is not active.");
    }

    const replacement = await requestRealtimeVoiceInputCapture(audioContext, inputDeviceId);
    const nextInputMuted = this.#snapshot.inputMuted || replacement.silent;
    let replacementSource: MediaStreamAudioSourceNode | null = null;
    try {
      replacementSource = audioContext.createMediaStreamSource(replacement.stream);
      replacementSource.connect(workletNode);
      for (const track of replacement.stream.getAudioTracks()) {
        track.enabled = !nextInputMuted;
      }
    } catch (cause) {
      replacement.release();
      replacementSource?.disconnect();
      throw createMediaError("Moss could not switch microphones.", cause);
    }

    const previousSource = this.#sourceNode;
    const releasePreviousInput = this.#releaseInput;
    this.#sourceNode = replacementSource;
    this.#inputStream = replacement.stream;
    this.#releaseInput = replacement.release;
    previousSource?.disconnect();
    releasePreviousInput?.();
    if (nextInputMuted !== this.#snapshot.inputMuted) {
      this.#snapshot = { ...this.#snapshot, inputMuted: nextInputMuted };
      for (const track of this.#destinationNode?.stream.getAudioTracks() ?? []) {
        track.enabled = !nextInputMuted;
      }
      workletNode.port.postMessage({ type: "mute", muted: nextInputMuted });
      this.#emitSnapshot();
    }
    return replacement.silent
      ? null
      : (replacement.stream.getAudioTracks()[0]?.getSettings().deviceId ?? null);
  }

  async dispose(): Promise<void> {
    if (this.#disposed) return;
    this.#disposed = true;
    if (this.#disconnectTimer !== null) window.clearTimeout(this.#disconnectTimer);
    this.#disconnectTimer = null;
    this.#dataChannel?.close();
    this.#dataChannel = null;
    if (this.#peer) {
      this.#peer.ontrack = null;
      this.#peer.onconnectionstatechange = null;
      this.#peer.close();
    }
    this.#peer = null;
    this.#sourceNode?.disconnect();
    this.#workletNode?.disconnect();
    this.#sourceNode = null;
    if (this.#workletNode) this.#workletNode.port.onmessage = null;
    this.#workletNode = null;
    this.#destinationNode?.disconnect();
    this.#destinationNode = null;
    this.#outputSourceNode?.disconnect();
    this.#outputSourceNode = null;
    this.#outputAnalyser?.disconnect();
    this.#outputAnalyser = null;
    if (this.#outputAnalysisFrame !== null) {
      window.cancelAnimationFrame(this.#outputAnalysisFrame);
      this.#outputAnalysisFrame = null;
    }
    this.#releaseInput?.();
    this.#releaseInput = null;
    this.#outputStream?.getTracks().forEach((track) => track.stop());
    this.#inputStream = null;
    this.#outputStream = null;
    if (this.#audioElement) {
      this.#audioElement.pause();
      this.#audioElement.srcObject = null;
      this.#audioElement.remove();
    }
    this.#audioElement = null;
    const audioContext = this.#audioContext;
    this.#audioContext = null;
    await audioContext?.close().catch(() => undefined);
    this.#callbacks.onRemoteStream?.(null);
  }

  #handleRemoteTrack(event: RTCTrackEvent): void {
    if (this.#disposed) return;
    const stream = event.streams[0] ?? new MediaStream([event.track]);
    this.#outputStream = stream;
    let audioElement = this.#audioElement;
    if (!audioElement) {
      audioElement = document.createElement("audio");
      audioElement.autoplay = true;
      audioElement.setAttribute("playsinline", "true");
      audioElement.hidden = true;
      document.body.append(audioElement);
      this.#audioElement = audioElement;
    }
    audioElement.muted = this.#snapshot.outputMuted;
    audioElement.srcObject = stream;
    if (this.#audioContext) void resumeAudioContextWithoutBlocking(this.#audioContext);
    void audioElement.play().catch(() => undefined);
    this.#startOutputAnalysis(stream);
    this.#callbacks.onRemoteStream?.(stream);
  }

  #startOutputAnalysis(stream: MediaStream): void {
    const audioContext = this.#audioContext;
    if (!audioContext || !this.#callbacks.onOutputSignal) return;
    this.#outputSourceNode?.disconnect();
    this.#outputAnalyser?.disconnect();
    if (this.#outputAnalysisFrame !== null) window.cancelAnimationFrame(this.#outputAnalysisFrame);

    const source = audioContext.createMediaStreamSource(stream);
    const analyser = audioContext.createAnalyser();
    analyser.fftSize = 2_048;
    analyser.minDecibels = -100;
    analyser.maxDecibels = -10;
    analyser.smoothingTimeConstant = 0.86;
    source.connect(analyser);
    this.#outputSourceNode = source;
    this.#outputAnalyser = analyser;
    const frequencies = new Uint8Array(analyser.frequencyBinCount);
    const sampleRate = audioContext.sampleRate;

    const averageBand = (minimumHz: number, maximumHz: number): number => {
      const first = Math.max(0, Math.floor((minimumHz * analyser.fftSize) / sampleRate));
      const last = Math.min(
        frequencies.length - 1,
        Math.ceil((maximumHz * analyser.fftSize) / sampleRate),
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
      if (now - this.#lastOutputAnalysisAt < 1000 / 30) return;
      this.#lastOutputAnalysisAt = now;
      analyser.getByteFrequencyData(frequencies);
      const low = averageBand(60, 300);
      const mid = averageBand(300, 2_000);
      const high = averageBand(2_000, 8_000);
      const overall = Math.min(1, low * 0.42 + mid * 0.42 + high * 0.16);
      this.#callbacks.onOutputSignal?.({ low, mid, high, overall });
    };
    this.#outputAnalysisFrame = window.requestAnimationFrame(analyze);
  }

  #handleConnectionState(): void {
    const state = this.#peer?.connectionState;
    if (!state || this.#disposed) return;
    if (state === "connected") {
      if (this.#disconnectTimer !== null) window.clearTimeout(this.#disconnectTimer);
      this.#disconnectTimer = null;
      if (!this.#snapshot.webRtcConnected) {
        this.#snapshot = { ...this.#snapshot, webRtcConnected: true };
        this.#workletNode?.port.postMessage({ type: "release" });
        this.#emitSnapshot();
      }
      return;
    }
    if (state === "failed" || state === "closed") {
      this.#raiseFatal(`Realtime Voice connection ${state}.`);
      return;
    }
    if (state === "disconnected" && this.#disconnectTimer === null) {
      this.#disconnectTimer = window.setTimeout(() => {
        this.#disconnectTimer = null;
        if (this.#peer?.connectionState === "disconnected") {
          this.#raiseFatal("Realtime Voice connection was lost.");
        }
      }, TRANSIENT_DISCONNECT_GRACE_MS);
    }
  }

  #handleDataEvent(raw: unknown): void {
    if (
      typeof raw !== "string" ||
      new TextEncoder().encode(raw).byteLength > MAX_DATA_EVENT_BYTES
    ) {
      return;
    }
    try {
      const event = JSON.parse(raw) as unknown;
      if (
        isRealtimeVoiceSessionInitializationEvent(event) &&
        !this.#snapshot.dataSessionInitialized
      ) {
        this.#snapshot = { ...this.#snapshot, dataSessionInitialized: true };
        this.#emitSnapshot();
      }
    } catch {
      // The authoritative control channel validates provider events server-side.
    }
  }

  #emitSnapshot(): void {
    this.#callbacks.onSnapshot({ ...this.#snapshot });
  }

  #raiseFatal(message: string): void {
    if (this.#disposed || this.#fatalRaised) return;
    this.#fatalRaised = true;
    this.#callbacks.onFatalError(new Error(message));
  }
}
