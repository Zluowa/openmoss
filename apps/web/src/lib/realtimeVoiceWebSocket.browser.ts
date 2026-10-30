import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { RealtimeVoiceWebSocketClient } from "./realtimeVoiceWebSocket";

class FakeMediaWebSocket {
  readonly url: string;
  readonly protocols: string[];
  readonly protocol: string;
  readonly sent: string[] = [];
  bufferedAmount = 0;
  readyState: number = WebSocket.CONNECTING;
  onopen: ((event: Event) => void) | null = null;
  onmessage: ((event: MessageEvent) => void) | null = null;
  onerror: ((event: Event) => void) | null = null;
  onclose: ((event: CloseEvent) => void) | null = null;
  closedWith: { code: number; reason: string } | null = null;

  constructor(url: string, protocols: string[]) {
    this.url = url;
    this.protocols = protocols;
    this.protocol = protocols[0] ?? "";
  }

  open(): void {
    this.readyState = WebSocket.OPEN;
    this.onopen?.(new Event("open"));
  }

  receive(value: unknown): void {
    this.onmessage?.(new MessageEvent("message", { data: JSON.stringify(value) }));
  }

  send(value: string): void {
    this.sent.push(value);
  }

  close(code = 1000, reason = ""): void {
    this.closedWith = { code, reason };
    this.readyState = WebSocket.CLOSED;
    this.onclose?.(new CloseEvent("close", { code, reason, wasClean: code === 1000 }));
  }
}

class FakePcm16WorkletNode {
  readonly commands: unknown[] = [];
  readonly port: {
    onmessage: ((event: MessageEvent<unknown>) => void) | null;
    postMessage: (value: unknown) => void;
  };
  readonly connect = vi.fn();
  readonly disconnect = vi.fn();

  constructor() {
    this.port = {
      onmessage: null,
      postMessage: (value) => this.commands.push(value),
    };
  }

  emitPcm16(buffer: ArrayBuffer): void {
    this.port.onmessage?.(new MessageEvent("message", { data: { type: "pcm16", buffer } }));
  }
}

function pcm16Chunk(marker: number, byteLength = 960): ArrayBuffer {
  const bytes = new Uint8Array(byteLength);
  bytes.fill(marker);
  return bytes.buffer;
}

const PCM16_BYTES_PER_20_MS = 960;
const MAX_PRE_ROLL_CHUNKS = 2 * 50;

function appendMarkers(socket: FakeMediaWebSocket): number[] {
  return socket.sent.flatMap((payload) => {
    const event = JSON.parse(payload) as { type?: unknown; audio?: unknown };
    if (event.type !== "input_audio_buffer.append" || typeof event.audio !== "string") return [];
    return [atob(event.audio).charCodeAt(0)];
  });
}

async function createControlledClient(maxQueuedInputBytes = 1_500 * 960) {
  const track = {
    enabled: true,
    getSettings: () => ({ deviceId: "controlled-microphone" }),
    stop: vi.fn(),
  };
  const stream = {
    getAudioTracks: () => [track],
    getTracks: () => [track],
  } as unknown as MediaStream;
  const getUserMedia = vi.spyOn(navigator.mediaDevices, "getUserMedia").mockResolvedValue(stream);
  const inputSource = { connect: vi.fn(), disconnect: vi.fn() };
  const captureDestination = { disconnect: vi.fn() };
  const context = {
    state: "running",
    currentTime: 0,
    audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
    createMediaStreamSource: vi.fn(() => inputSource),
    createMediaStreamDestination: vi.fn(() => captureDestination),
    close: vi.fn().mockResolvedValue(undefined),
  } as unknown as AudioContext;
  const worklet = new FakePcm16WorkletNode();
  const sockets: FakeMediaWebSocket[] = [];
  const fatal = vi.fn();
  const client = new RealtimeVoiceWebSocketClient(
    { onSnapshot: () => undefined, onFatalError: fatal },
    {
      createAudioContext: () => context,
      createAudioWorkletNode: () => worklet as unknown as AudioWorkletNode,
      createWebSocket: (url, protocols) => {
        const socket = new FakeMediaWebSocket(url, protocols);
        sockets.push(socket);
        return socket as unknown as WebSocket;
      },
      maxQueuedInputBytes,
    },
  );
  await client.prepare(null);
  return {
    client,
    fatal,
    getUserMedia,
    sockets,
    track,
    worklet,
  };
}

function liveTransport() {
  return {
    type: "websocket-pcm16" as const,
    url: "wss://voice-cn.moss.example/v1/realtime/media",
    protocol: "moss-realtime-pcm16-v1" as const,
    ticket: "a".repeat(43),
    expiresAt: new Date(Date.now() + 30_000).toISOString(),
    encoding: "pcm16" as const,
    sampleRate: 24_000 as const,
  };
}

describe("RealtimeVoiceWebSocketClient", () => {
  it("opens muted with zero PCM input when Chromium reports no audio input devices", async () => {
    const silentTrack = {
      enabled: true,
      getSettings: () => ({}),
      stop: vi.fn(),
    };
    const silentStream = {
      getAudioTracks: () => [silentTrack],
      getTracks: () => [silentTrack],
    } as unknown as MediaStream;
    const replacementTrack = {
      enabled: true,
      getSettings: () => ({ deviceId: "attached-microphone" }),
      stop: vi.fn(),
    };
    const replacementStream = {
      getAudioTracks: () => [replacementTrack],
      getTracks: () => [replacementTrack],
    } as unknown as MediaStream;
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValueOnce(new DOMException("No microphone is installed", "NotFoundError"))
      .mockResolvedValueOnce(replacementStream);
    const enumerateDevices = vi
      .spyOn(navigator.mediaDevices, "enumerateDevices")
      .mockResolvedValue([{ kind: "audiooutput" } as MediaDeviceInfo]);
    const silentDestination = { stream: silentStream, disconnect: vi.fn() };
    const captureDestination = { disconnect: vi.fn() };
    const silentSource = {
      offset: { value: 1 },
      connect: vi.fn(),
      disconnect: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
    };
    const initialInputSource = { connect: vi.fn(), disconnect: vi.fn() };
    const replacementInputSource = { connect: vi.fn(), disconnect: vi.fn() };
    const createMediaStreamSource = vi
      .fn()
      .mockReturnValueOnce(initialInputSource)
      .mockReturnValueOnce(replacementInputSource);
    const createMediaStreamDestination = vi
      .fn()
      .mockReturnValueOnce(silentDestination)
      .mockReturnValueOnce(captureDestination);
    const context = {
      state: "running",
      currentTime: 0,
      audioWorklet: { addModule: vi.fn().mockResolvedValue(undefined) },
      createConstantSource: vi.fn(() => silentSource),
      createMediaStreamSource,
      createMediaStreamDestination,
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;
    const worklet = new FakePcm16WorkletNode();
    const sockets: FakeMediaWebSocket[] = [];
    const snapshots: Array<{ inputMuted: boolean }> = [];
    const fatal = vi.fn();
    const client = new RealtimeVoiceWebSocketClient(
      {
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onFatalError: fatal,
      },
      {
        createAudioContext: () => context,
        createAudioWorkletNode: () => worklet as unknown as AudioWorkletNode,
        createWebSocket: (url, protocols) => {
          const socket = new FakeMediaWebSocket(url, protocols);
          sockets.push(socket);
          return socket as unknown as WebSocket;
        },
      },
    );

    try {
      await expect(client.prepare(null)).resolves.toEqual({ inputDeviceId: null });
      expect(client.snapshot.inputMuted).toBe(true);
      expect(silentSource.offset.value).toBe(0);
      expect(silentSource.start).toHaveBeenCalledOnce();
      expect(silentTrack.enabled).toBe(false);
      expect(worklet.commands).toContainEqual({ type: "mute", muted: true });
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(enumerateDevices).toHaveBeenCalledOnce();

      await client.connect(liveTransport());
      const socket = sockets[0];
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      socket.receive({ type: "session.updated" });
      expect(client.snapshot).toMatchObject({
        webRtcConnected: true,
        dataSessionInitialized: true,
        inputMuted: true,
      });
      expect(socket.sent).toHaveLength(0);

      await expect(client.replaceMicrophone("attached-microphone")).resolves.toBe(
        "attached-microphone",
      );
      expect(silentTrack.stop).toHaveBeenCalledOnce();
      expect(silentSource.stop).toHaveBeenCalledOnce();
      expect(silentSource.disconnect).toHaveBeenCalledOnce();
      expect(silentDestination.disconnect).toHaveBeenCalledOnce();
      expect(replacementTrack.enabled).toBe(false);
      client.setInputMuted(false);
      expect(replacementTrack.enabled).toBe(true);
      expect(client.snapshot.inputMuted).toBe(false);
      expect(snapshots).toContainEqual(expect.objectContaining({ inputMuted: false }));
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      getUserMedia.mockRestore();
      enumerateDevices.mockRestore();
    }
    expect(replacementTrack.stop).toHaveBeenCalledOnce();
  });

  it("does not bypass denied microphone permission with a silent PCM input", async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    const enumerateDevices = vi
      .spyOn(navigator.mediaDevices, "enumerateDevices")
      .mockResolvedValue([]);
    const context = {
      state: "running",
      close: vi.fn().mockResolvedValue(undefined),
    } as unknown as AudioContext;
    const client = new RealtimeVoiceWebSocketClient(
      { onSnapshot: () => undefined, onFatalError: () => undefined },
      { createAudioContext: () => context },
    );
    try {
      await expect(client.prepare(null)).rejects.toThrow("NotAllowedError");
      expect(client.snapshot.inputMuted).toBe(false);
      expect(enumerateDevices).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      getUserMedia.mockRestore();
      enumerateDevices.mockRestore();
    }
  });

  it("retains the opening PCM16 chunks and flushes them in order after session initialization", async () => {
    const controlled = await createControlledClient();
    try {
      controlled.worklet.emitPcm16(pcm16Chunk(0x11));
      const lateChunk = pcm16Chunk(0x22);
      controlled.worklet.emitPcm16(lateChunk);
      await controlled.client.connect(liveTransport());
      const socket = controlled.sockets[0];
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      expect(socket.sent).toHaveLength(0);

      socket.receive({ type: "session.updated" });
      expect(appendMarkers(socket)).toEqual([0x11, 0x22]);
      expect([...new Uint8Array(lateChunk)].every((byte) => byte === 0)).toBe(true);
      controlled.worklet.emitPcm16(pcm16Chunk(0x33));
      expect(appendMarkers(socket)).toEqual([0x11, 0x22, 0x33]);
      expect(controlled.fatal).not.toHaveBeenCalled();
    } finally {
      await controlled.client.dispose();
      controlled.getUserMedia.mockRestore();
    }
  });

  it("keeps the newest pre-roll within the byte limit and scrubs what it drops", async () => {
    const controlled = await createControlledClient(1_920);
    const first = pcm16Chunk(0x11);
    const second = pcm16Chunk(0x22);
    const newest = pcm16Chunk(0x33);
    try {
      controlled.worklet.emitPcm16(first);
      controlled.worklet.emitPcm16(second);
      controlled.worklet.emitPcm16(newest);
      expect(controlled.fatal).not.toHaveBeenCalled();
      expect([...new Uint8Array(first)].every((byte) => byte === 0)).toBe(true);

      await controlled.client.connect(liveTransport());
      const socket = controlled.sockets[0];
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      socket.receive({ type: "session.updated" });
      expect(appendMarkers(socket)).toEqual([0x22, 0x33]);
      expect(controlled.fatal).not.toHaveBeenCalled();
    } finally {
      await controlled.client.dispose();
      controlled.getUserMedia.mockRestore();
    }
  });

  it("retains exactly two seconds of pre-roll, then flushes it in order and scrubs it", async () => {
    const controlled = await createControlledClient();
    const retained = Array.from({ length: MAX_PRE_ROLL_CHUNKS }, (_, index) =>
      pcm16Chunk(index, PCM16_BYTES_PER_20_MS),
    );
    try {
      for (const chunk of retained) controlled.worklet.emitPcm16(chunk);
      expect(controlled.fatal).not.toHaveBeenCalled();

      await controlled.client.connect(liveTransport());
      const socket = controlled.sockets[0];
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      expect(socket.sent).toHaveLength(0);

      socket.receive({ type: "session.updated" });
      expect(appendMarkers(socket)).toEqual(
        Array.from({ length: MAX_PRE_ROLL_CHUNKS }, (_, index) => index % 256),
      );
      expect(retained.every((chunk) => new Uint8Array(chunk).every((byte) => byte === 0))).toBe(
        true,
      );
      expect(controlled.fatal).not.toHaveBeenCalled();
    } finally {
      await controlled.client.dispose();
      controlled.getUserMedia.mockRestore();
    }
  });

  it("drops the oldest frame one frame beyond two seconds instead of failing a slow connect", async () => {
    const controlled = await createControlledClient();
    const retained = Array.from({ length: MAX_PRE_ROLL_CHUNKS }, (_, index) =>
      pcm16Chunk(index, PCM16_BYTES_PER_20_MS),
    );
    const newest = pcm16Chunk(0xff, PCM16_BYTES_PER_20_MS);
    try {
      for (const chunk of retained) controlled.worklet.emitPcm16(chunk);
      controlled.worklet.emitPcm16(newest);
      expect(controlled.fatal).not.toHaveBeenCalled();
      expect(new Uint8Array(retained[0]!).every((byte) => byte === 0)).toBe(true);

      await controlled.client.connect(liveTransport());
      const socket = controlled.sockets[0];
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      socket.receive({ type: "session.updated" });
      expect(appendMarkers(socket)).toEqual([
        ...Array.from({ length: MAX_PRE_ROLL_CHUNKS - 1 }, (_, index) => (index + 1) % 256),
        0xff,
      ]);
      expect(controlled.fatal).not.toHaveBeenCalled();
    } finally {
      await controlled.client.dispose();
      controlled.getUserMedia.mockRestore();
    }
  });

  it("drops and scrubs pre-roll on a clean stop before allowing a fresh connection", async () => {
    const controlled = await createControlledClient();
    const stoppedChunk = pcm16Chunk(0x11);
    try {
      controlled.worklet.emitPcm16(stoppedChunk);
      await controlled.client.connect(liveTransport());
      const firstSocket = controlled.sockets[0];
      if (!firstSocket) throw new Error("Media socket was not created");
      firstSocket.open();
      firstSocket.close(1000, "session complete");
      expect([...new Uint8Array(stoppedChunk)].every((byte) => byte === 0)).toBe(true);

      const staleChunk = pcm16Chunk(0x22);
      controlled.worklet.emitPcm16(staleChunk);
      expect([...new Uint8Array(staleChunk)].every((byte) => byte === 0)).toBe(true);
      await controlled.client.connect(liveTransport());
      const secondSocket = controlled.sockets[1];
      if (!secondSocket) throw new Error("Replacement media socket was not created");
      secondSocket.open();
      controlled.worklet.emitPcm16(pcm16Chunk(0x33));
      secondSocket.receive({ type: "session.updated" });
      expect(appendMarkers(secondSocket)).toEqual([0x33]);
      expect(controlled.fatal).not.toHaveBeenCalled();
    } finally {
      await controlled.client.dispose();
      controlled.getUserMedia.mockRestore();
    }
  });

  it("scrubs pre-roll and detaches capture on dispose", async () => {
    const controlled = await createControlledClient();
    const pending = pcm16Chunk(0x44);
    controlled.worklet.emitPcm16(pending);
    await controlled.client.dispose();
    controlled.getUserMedia.mockRestore();

    expect([...new Uint8Array(pending)].every((byte) => byte === 0)).toBe(true);
    expect(controlled.worklet.port.onmessage).toBeNull();
    expect(controlled.track.stop).toHaveBeenCalledOnce();
    expect(controlled.worklet.commands).toContainEqual({ type: "mute", muted: true });
  });

  it("sends PCM16 only after a ticketed WSS session is initialized and releases everything", async () => {
    const sourceContext = new AudioContext();
    const sourceDestination = sourceContext.createMediaStreamDestination();
    const oscillator = sourceContext.createOscillator();
    oscillator.frequency.value = 220;
    oscillator.connect(sourceDestination);
    oscillator.start();
    const sourceTrack = sourceDestination.stream.getAudioTracks()[0];
    if (!sourceTrack) throw new Error("Synthetic source did not create an audio track");
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(sourceDestination.stream);
    const snapshots: Array<{ webRtcConnected: boolean; dataSessionInitialized: boolean }> = [];
    const outputSignals: Array<{ low: number; mid: number; high: number; overall: number }> = [];
    const fatal = vi.fn();
    const launch = document.createElement("button");
    launch.textContent = "Start PCM voice";
    document.body.append(launch);
    const launched: {
      client: RealtimeVoiceWebSocketClient | null;
      preparation: ReturnType<RealtimeVoiceWebSocketClient["prepare"]> | null;
      socket: FakeMediaWebSocket | null;
    } = { client: null, preparation: null, socket: null };
    let replacementContext: AudioContext | null = null;
    let replacementOscillator: OscillatorNode | null = null;
    launch.addEventListener("click", () => {
      void sourceContext.resume();
      launched.client = new RealtimeVoiceWebSocketClient(
        {
          onSnapshot: (snapshot) => snapshots.push(snapshot),
          onOutputSignal: (signal) => outputSignals.push(signal),
          onFatalError: fatal,
        },
        {
          createWebSocket: (url, protocols) => {
            launched.socket = new FakeMediaWebSocket(url, protocols);
            return launched.socket as unknown as WebSocket;
          },
          maxQueuedInputBytes: 19_200,
        },
      );
      launched.preparation = launched.client.prepare(null);
    });
    await userEvent.click(launch);
    const client = launched.client;
    const preparation = launched.preparation;
    if (!client || !preparation) throw new Error("Synthetic launch gesture did not run");

    try {
      await preparation;
      await client.connect(liveTransport());
      const socket = launched.socket;
      if (!socket) throw new Error("Media socket was not created");
      expect(socket.url).toBe("wss://voice-cn.moss.example/v1/realtime/media");
      expect(socket.protocols).toEqual(["moss-realtime-pcm16-v1", `moss-ticket.${"a".repeat(43)}`]);
      expect(socket.url).not.toContain("ticket");
      socket.open();
      expect(client.snapshot).toMatchObject({
        webRtcConnected: true,
        dataSessionInitialized: false,
      });
      await new Promise((resolve) => window.setTimeout(resolve, 120));
      expect(socket.sent).toHaveLength(0);

      socket.receive({ type: "session.updated", session: { id: "redacted" } });
      await vi.waitFor(
        () => {
          expect(client.snapshot.dataSessionInitialized).toBe(true);
          expect(
            socket.sent.some((payload) => JSON.parse(payload).type === "input_audio_buffer.append"),
          ).toBe(true);
        },
        { timeout: 3_000 },
      );
      const append = socket.sent
        .map((payload) => JSON.parse(payload))
        .find((event) => event.type === "input_audio_buffer.append");
      expect(append.audio).toMatch(/^[A-Za-z0-9+/]+=*$/u);
      expect(append.audio.length).toBeLessThan(8_192);
      expect(snapshots).toContainEqual(
        expect.objectContaining({ webRtcConnected: true, dataSessionInitialized: true }),
      );

      client.setInputMuted(true);
      expect(sourceTrack.enabled).toBe(false);
      expect(socket.sent.map((payload) => JSON.parse(payload))).toContainEqual({
        type: "input_audio_buffer.clear",
      });
      client.setInputMuted(false);
      expect(sourceTrack.enabled).toBe(true);

      replacementContext = new AudioContext();
      const replacementDestination = replacementContext.createMediaStreamDestination();
      replacementOscillator = replacementContext.createOscillator();
      replacementOscillator.connect(replacementDestination);
      replacementOscillator.start();
      await replacementContext.resume();
      const replacementTrack = replacementDestination.stream.getAudioTracks()[0];
      if (!replacementTrack) throw new Error("Replacement source did not create an audio track");
      getUserMedia.mockResolvedValueOnce(replacementDestination.stream);
      expect(await client.replaceMicrophone("replacement-device")).toBe(
        replacementTrack.getSettings().deviceId ?? null,
      );
      expect(sourceTrack.readyState).toBe("ended");
      expect(replacementTrack.readyState).toBe("live");

      const pcm = new Int16Array(480);
      pcm.fill(12_000);
      const bytes = new Uint8Array(pcm.buffer);
      let binary = "";
      for (const byte of bytes) binary += String.fromCharCode(byte);
      socket.receive({ type: "response.output_audio.delta", delta: btoa(binary) });
      socket.receive({ type: "input_audio_buffer.speech_started", audio_start_ms: 0 });
      expect(outputSignals.at(-1)).toEqual({ low: 0, mid: 0, high: 0, overall: 0 });

      expect(fatal).not.toHaveBeenCalled();
      socket.bufferedAmount = 256 * 1_024;
      await vi.waitFor(() =>
        expect(fatal).toHaveBeenCalledWith(
          expect.objectContaining({ message: expect.stringContaining("could not keep up") }),
        ),
      );
    } finally {
      await client.dispose();
      oscillator.stop();
      replacementOscillator?.stop();
      await sourceContext.close();
      await replacementContext?.close();
      getUserMedia.mockRestore();
      launch.remove();
    }
    expect(sourceTrack.readyState).toBe("ended");
    expect(launched.socket?.closedWith).toEqual({ code: 1000, reason: "local session complete" });
  });

  it("fails closed when the relay does not select the exact application subprotocol", async () => {
    const sourceContext = new AudioContext();
    const source = sourceContext.createMediaStreamDestination();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(source.stream);
    const fatal = vi.fn();
    const socketHolder: { current: FakeMediaWebSocket | null } = { current: null };
    const client = new RealtimeVoiceWebSocketClient(
      { onSnapshot: () => undefined, onFatalError: fatal },
      {
        createWebSocket: (url, protocols) => {
          socketHolder.current = new FakeMediaWebSocket(url, protocols);
          Object.defineProperty(socketHolder.current, "protocol", { value: "" });
          return socketHolder.current as unknown as WebSocket;
        },
      },
    );
    try {
      await client.prepare(null);
      await client.connect(liveTransport());
      const socket = socketHolder.current;
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      expect(fatal).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("invalid media protocol") }),
      );
    } finally {
      await client.dispose();
      await sourceContext.close();
      getUserMedia.mockRestore();
    }
  });

  it("rejects an odd-length PCM16 output delta before playback", async () => {
    const sourceContext = new AudioContext();
    const source = sourceContext.createMediaStreamDestination();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(source.stream);
    const fatal = vi.fn();
    const socketHolder: { current: FakeMediaWebSocket | null } = { current: null };
    const client = new RealtimeVoiceWebSocketClient(
      { onSnapshot: () => undefined, onFatalError: fatal },
      {
        createWebSocket: (url, protocols) => {
          socketHolder.current = new FakeMediaWebSocket(url, protocols);
          return socketHolder.current as unknown as WebSocket;
        },
      },
    );
    try {
      await client.prepare(null);
      await client.connect(liveTransport());
      const socket = socketHolder.current;
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      socket.receive({ type: "session.updated" });
      socket.receive({ type: "response.output_audio.delta", delta: "AQ==" });
      expect(fatal).toHaveBeenCalledWith(
        expect.objectContaining({ message: expect.stringContaining("invalid PCM16") }),
      );
    } finally {
      await client.dispose();
      await sourceContext.close();
      getUserMedia.mockRestore();
    }
  });

  it("lets the authenticated control channel own a clean server close", async () => {
    const sourceContext = new AudioContext();
    const source = sourceContext.createMediaStreamDestination();
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(source.stream);
    const fatal = vi.fn();
    const snapshots: Array<{ webRtcConnected: boolean; dataSessionInitialized: boolean }> = [];
    const socketHolder: { current: FakeMediaWebSocket | null } = { current: null };
    const client = new RealtimeVoiceWebSocketClient(
      { onSnapshot: (snapshot) => snapshots.push(snapshot), onFatalError: fatal },
      {
        createWebSocket: (url, protocols) => {
          socketHolder.current = new FakeMediaWebSocket(url, protocols);
          return socketHolder.current as unknown as WebSocket;
        },
      },
    );
    try {
      await client.prepare(null);
      await client.connect(liveTransport());
      const socket = socketHolder.current;
      if (!socket) throw new Error("Media socket was not created");
      socket.open();
      socket.receive({ type: "session.updated" });
      socket.close(1000, "session complete");
      expect(fatal).not.toHaveBeenCalled();
      expect(client.snapshot).toMatchObject({
        webRtcConnected: false,
        dataSessionInitialized: false,
      });
      expect(snapshots.at(-1)).toMatchObject({
        webRtcConnected: false,
        dataSessionInitialized: false,
      });
    } finally {
      await client.dispose();
      await sourceContext.close();
      getUserMedia.mockRestore();
    }
  });
});
