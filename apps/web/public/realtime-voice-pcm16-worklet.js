/*
 * Mono PCM16 capture for the domestic Realtime Voice WSS transport.
 * This processor resamples inside the audio render thread and transfers only
 * bounded 20 ms chunks to the renderer; it never owns network credentials.
 */
/* oxlint-disable unicorn/prefer-add-event-listener, unicorn/require-post-message-target-origin -- AudioWorklet MessagePort owns one callback and has no targetOrigin parameter. */
class MossRealtimePcm16CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.targetSampleRate = 24_000;
    this.chunkSamples = 480;
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkIndex = 0;
    this.sourceFramesPerTargetFrame = sampleRate / this.targetSampleRate;
    this.inputFrame = 0;
    this.nextOutputFrame = 0;
    this.previousSample = null;
    this.inputMuted = false;
    this.lastLevelPostAt = 0;
    this.port.onmessage = (event) => {
      const command = event.data;
      if (!command || typeof command !== "object") return;
      if (command.type === "mute") {
        this.inputMuted = command.muted === true;
        if (this.inputMuted) this.resetAudio();
      }
      if (command.type === "reset") this.resetAudio();
    };
  }

  resetAudio() {
    this.chunkIndex = 0;
    this.inputFrame = 0;
    this.nextOutputFrame = 0;
    this.previousSample = null;
  }

  pushPcm16(sample) {
    const normalized = Math.max(-1, Math.min(1, sample));
    this.chunk[this.chunkIndex] =
      normalized < 0 ? Math.round(normalized * 32_768) : Math.round(normalized * 32_767);
    this.chunkIndex += 1;
    if (this.chunkIndex < this.chunkSamples) return;
    const completed = this.chunk;
    this.chunk = new Int16Array(this.chunkSamples);
    this.chunkIndex = 0;
    this.port.postMessage({ type: "pcm16", buffer: completed.buffer }, [completed.buffer]);
  }

  process(inputs, outputs) {
    const source = inputs[0] && inputs[0][0];
    const destination = outputs[0] && outputs[0][0];
    if (destination) destination.fill(0);
    if (!source || this.inputMuted) return true;

    let sumSquares = 0;
    for (let index = 0; index < source.length; index += 1) {
      const sample = source[index] || 0;
      sumSquares += sample * sample;
      if (this.previousSample === null) this.previousSample = sample;
      while (this.nextOutputFrame <= this.inputFrame) {
        const previousFrame = Math.max(0, this.inputFrame - 1);
        const progress = Math.max(0, Math.min(1, this.nextOutputFrame - previousFrame));
        this.pushPcm16(this.previousSample + (sample - this.previousSample) * progress);
        this.nextOutputFrame += this.sourceFramesPerTargetFrame;
      }
      this.previousSample = sample;
      this.inputFrame += 1;
    }

    const now = currentTime * 1_000;
    if (now - this.lastLevelPostAt >= 50) {
      this.lastLevelPostAt = now;
      const level = Math.min(1, Math.sqrt(sumSquares / Math.max(1, source.length)) * 3.2);
      this.port.postMessage({ type: "level", level });
    }
    return true;
  }
}

registerProcessor("moss-realtime-pcm16-capture", MossRealtimePcm16CaptureProcessor);
