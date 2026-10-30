import { userEvent } from "vitest/browser";
import { describe, expect, it, vi } from "vitest";

import { RealtimeVoiceWebRtcClient } from "./realtimeVoiceWebRtc";

async function waitForIce(peer: RTCPeerConnection): Promise<void> {
  if (peer.iceGatheringState === "complete") return;
  await new Promise<void>((resolve) => {
    const finish = () => {
      window.clearTimeout(timeout);
      peer.removeEventListener("icegatheringstatechange", onChange);
      resolve();
    };
    const onChange = () => {
      if (peer.iceGatheringState !== "complete") return;
      finish();
    };
    const timeout = window.setTimeout(finish, 3_000);
    peer.addEventListener("icegatheringstatechange", onChange);
  });
}

function timeDomainEnergy(analyser: AnalyserNode): number {
  const samples = new Float32Array(analyser.fftSize);
  analyser.getFloatTimeDomainData(samples);
  let sum = 0;
  for (const sample of samples) sum += sample * sample;
  return Math.sqrt(sum / samples.length);
}

describe("RealtimeVoiceWebRtcClient", () => {
  it("negotiates a muted silent input when Chromium reports no audio input devices", async () => {
    const replacementContext = new AudioContext();
    const replacementDestination = replacementContext.createMediaStreamDestination();
    const replacementTrack = replacementDestination.stream.getAudioTracks()[0];
    if (!replacementTrack) throw new Error("Replacement source did not create an audio track");
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValueOnce(new DOMException("No microphone is installed", "NotFoundError"))
      .mockResolvedValueOnce(replacementDestination.stream);
    const enumerateDevices = vi
      .spyOn(navigator.mediaDevices, "enumerateDevices")
      .mockResolvedValue([{ kind: "audiooutput" } as MediaDeviceInfo]);
    const snapshots: Array<{ inputMuted: boolean }> = [];
    const fatal = vi.fn();
    const remote = new RTCPeerConnection();
    const remoteChannel: { current: RTCDataChannel | null } = { current: null };
    const remoteTrack: { current: MediaStreamTrack | null } = { current: null };
    remote.ondatachannel = (event) => {
      remoteChannel.current = event.channel;
    };
    remote.ontrack = (event) => {
      remoteTrack.current = event.track;
    };
    const launch = document.createElement("button");
    launch.type = "button";
    launch.textContent = "Start voice without a microphone";
    document.body.append(launch);
    const launched: {
      client: RealtimeVoiceWebRtcClient | null;
      prepared: ReturnType<RealtimeVoiceWebRtcClient["prepare"]> | null;
    } = { client: null, prepared: null };
    launch.addEventListener("click", () => {
      const client = new RealtimeVoiceWebRtcClient({
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onFatalError: fatal,
      });
      launched.client = client;
      launched.prepared = client.prepare(null);
    });
    await userEvent.click(launch);
    const client = launched.client;
    const preparation = launched.prepared;
    if (!client || !preparation) throw new Error("No-microphone launch gesture did not run");

    try {
      const prepared = await preparation;
      expect(prepared.inputDeviceId).toBeNull();
      expect(prepared.offerSdp).toMatch(/\bm=audio\b/u);
      expect(prepared.offerSdp).toMatch(/\bm=application\b/u);
      expect(client.snapshot.inputMuted).toBe(true);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(enumerateDevices).toHaveBeenCalledOnce();

      await remote.setRemoteDescription({ type: "offer", sdp: prepared.offerSdp });
      const answer = await remote.createAnswer();
      await remote.setLocalDescription(answer);
      await waitForIce(remote);
      const answerSdp = remote.localDescription?.sdp;
      if (!answerSdp) throw new Error("Synthetic remote did not create an answer");
      await client.applyAnswer(answerSdp);
      await vi.waitFor(
        () => {
          expect(client.snapshot.webRtcConnected).toBe(true);
          expect(remoteChannel.current?.readyState).toBe("open");
          expect(remoteTrack.current?.kind).toBe("audio");
        },
        { timeout: 5_000, interval: 50 },
      );
      remoteChannel.current?.send(JSON.stringify({ type: "session.created" }));
      await vi.waitFor(() => expect(client.snapshot.dataSessionInitialized).toBe(true));

      expect(await client.replaceMicrophone("attached-microphone")).toBe(
        replacementTrack.getSettings().deviceId ?? null,
      );
      expect(getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          audio: expect.objectContaining({ deviceId: { exact: "attached-microphone" } }),
        }),
      );
      expect(replacementTrack.enabled).toBe(false);
      client.setInputMuted(false);
      expect(replacementTrack.enabled).toBe(true);
      expect(client.snapshot.inputMuted).toBe(false);
      expect(snapshots).toContainEqual(expect.objectContaining({ inputMuted: false }));
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      remote.close();
      await replacementContext.close();
      getUserMedia.mockRestore();
      enumerateDevices.mockRestore();
      launch.remove();
    }
    expect(replacementTrack.readyState).toBe("ended");
  });

  it("does not bypass denied microphone permission with a silent input", async () => {
    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockRejectedValue(new DOMException("Permission denied", "NotAllowedError"));
    const enumerateDevices = vi
      .spyOn(navigator.mediaDevices, "enumerateDevices")
      .mockResolvedValue([]);
    const client = new RealtimeVoiceWebRtcClient({
      onSnapshot: () => undefined,
      onFatalError: () => undefined,
    });
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

  it("negotiates real local peers, waits for a session event, and closes every media resource", async () => {
    const sourceContext = new AudioContext();
    const sourceDestination = sourceContext.createMediaStreamDestination();
    const sourceOscillator = sourceContext.createOscillator();
    sourceOscillator.frequency.value = 220;
    sourceOscillator.connect(sourceDestination);
    sourceOscillator.start();
    let sourceOscillatorStopped = false;
    const sourceTrack = sourceDestination.stream.getAudioTracks()[0];
    if (!sourceTrack) throw new Error("Synthetic source did not create an audio track");

    const getUserMedia = vi
      .spyOn(navigator.mediaDevices, "getUserMedia")
      .mockResolvedValue(sourceDestination.stream);
    const snapshots: Array<{
      webRtcConnected: boolean;
      dataSessionInitialized: boolean;
    }> = [];
    const inputLevels: number[] = [];
    const fatal = vi.fn();
    const remote = new RTCPeerConnection();
    const receivedContext = new AudioContext();
    const receivedGain = receivedContext.createGain();
    receivedGain.gain.value = 0;
    receivedGain.connect(receivedContext.destination);
    let receivedAnalyser: AnalyserNode | null = null;
    const remoteChannel: { current: RTCDataChannel | null } = { current: null };
    remote.ontrack = (event) => {
      const stream = event.streams[0] ?? new MediaStream([event.track]);
      const source = receivedContext.createMediaStreamSource(stream);
      const analyser = receivedContext.createAnalyser();
      analyser.fftSize = 2_048;
      source.connect(analyser);
      analyser.connect(receivedGain);
      receivedAnalyser = analyser;
    };
    remote.ondatachannel = (event) => {
      remoteChannel.current = event.channel;
    };
    const remoteOutputContext = new AudioContext();
    const remoteOutput = remoteOutputContext.createMediaStreamDestination();
    const remoteOscillator = remoteOutputContext.createOscillator();
    remoteOscillator.frequency.value = 330;
    remoteOscillator.connect(remoteOutput);
    remoteOscillator.start();
    const remoteTrack = remoteOutput.stream.getAudioTracks()[0];
    if (!remoteTrack) throw new Error("Synthetic remote did not create an audio track");
    remote.addTrack(remoteTrack, remoteOutput.stream);
    const replacementContext = new AudioContext();
    const replacementDestination = replacementContext.createMediaStreamDestination();
    const replacementTrack = replacementDestination.stream.getAudioTracks()[0];
    if (!replacementTrack) throw new Error("Replacement source did not create an audio track");

    const launch = document.createElement("button");
    launch.type = "button";
    launch.textContent = "Start synthetic voice";
    document.body.append(launch);
    const launched: {
      client: RealtimeVoiceWebRtcClient | null;
      prepared: ReturnType<RealtimeVoiceWebRtcClient["prepare"]> | null;
    } = { client: null, prepared: null };
    launch.addEventListener("click", () => {
      void sourceContext.resume();
      void remoteOutputContext.resume();
      void receivedContext.resume();
      const client = new RealtimeVoiceWebRtcClient({
        onSnapshot: (snapshot) => snapshots.push(snapshot),
        onInputLevel: (level) => inputLevels.push(level),
        onFatalError: fatal,
      });
      launched.client = client;
      launched.prepared = client.prepare(null);
    });
    await userEvent.click(launch);
    const client = launched.client;
    const preparation = launched.prepared;
    if (!client || !preparation) throw new Error("Synthetic launch gesture did not run");

    try {
      const prepared = await preparation;
      expect(prepared.offerSdp.startsWith("v=0")).toBe(true);
      expect(getUserMedia).toHaveBeenCalledOnce();
      expect(sourceContext.state).toBe("running");
      await vi.waitFor(() => expect(Math.max(0, ...inputLevels)).toBeGreaterThan(0.01), {
        timeout: 5_000,
        interval: 50,
      });
      // Nothing after this point is live source audio. Any non-zero inbound
      // energy after negotiation must have crossed the startup worklet buffer.
      sourceOscillator.stop();
      sourceOscillatorStopped = true;
      await remote.setRemoteDescription({ type: "offer", sdp: prepared.offerSdp });
      const answer = await remote.createAnswer();
      await remote.setLocalDescription(answer);
      await waitForIce(remote);
      const answerSdp = remote.localDescription?.sdp;
      if (!answerSdp) throw new Error("Synthetic remote did not create an answer");
      await client.applyAnswer(answerSdp);

      await vi.waitFor(
        () => {
          expect(client.snapshot.webRtcConnected).toBe(true);
          expect(remoteChannel.current?.readyState).toBe("open");
        },
        { timeout: 5_000, interval: 50 },
      );
      await vi.waitFor(
        () => {
          expect(receivedAnalyser).not.toBeNull();
          expect(timeDomainEnergy(receivedAnalyser!)).toBeGreaterThan(0.001);
        },
        { timeout: 5_000, interval: 50 },
      );
      remoteChannel.current?.send(
        JSON.stringify({ type: "session.created", session: { id: "sess_1" } }),
      );
      await vi.waitFor(() => expect(client.snapshot.dataSessionInitialized).toBe(true));
      const remoteAudio = document.querySelector<HTMLAudioElement>("audio[playsinline]");
      expect(remoteAudio).not.toBeNull();
      client.setOutputMuted(true);
      expect(client.snapshot).toMatchObject({ inputMuted: false, outputMuted: true });
      expect(remoteAudio?.muted).toBe(true);
      expect(sourceTrack.enabled).toBe(true);
      client.setInputMuted(true);
      expect(client.snapshot).toMatchObject({ inputMuted: true, outputMuted: true });
      expect(sourceTrack.enabled).toBe(false);
      expect(remoteAudio?.muted).toBe(true);
      client.setInputMuted(false);
      client.setOutputMuted(false);

      getUserMedia.mockResolvedValueOnce(replacementDestination.stream);
      await client.replaceMicrophone("replacement-device");
      expect(sourceTrack.readyState).toBe("ended");
      expect(replacementTrack.readyState).toBe("live");
      expect(getUserMedia).toHaveBeenLastCalledWith(
        expect.objectContaining({
          audio: expect.objectContaining({ deviceId: { exact: "replacement-device" } }),
        }),
      );
      expect(snapshots.some((snapshot) => snapshot.webRtcConnected)).toBe(true);
      expect(fatal).not.toHaveBeenCalled();
    } finally {
      await client.dispose();
      remote.close();
      if (!sourceOscillatorStopped) sourceOscillator.stop();
      remoteOscillator.stop();
      await sourceContext.close();
      await remoteOutputContext.close();
      await receivedContext.close();
      await replacementContext.close();
      getUserMedia.mockRestore();
      launch.remove();
    }
    expect(sourceTrack.readyState).toBe("ended");
  });
});
