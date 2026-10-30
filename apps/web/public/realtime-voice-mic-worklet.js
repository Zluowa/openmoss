/*
 * Buffered microphone processor for Realtime Voice startup.
 * Network and application state remain on the main thread; this processor only
 * retains mono PCM until the peer connection is ready.
 */
class MossRealtimeMicBufferProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.phase = "buffering";
    this.inputMuted = false;
    this.signalThreshold = 0.003;
    this.maximumFrames = sampleRate * 30;
    this.preRollFrames = sampleRate * 0.1;
    this.buffer = new Float32Array(this.maximumFrames);
    this.readIndex = 0;
    this.bufferedFrames = 0;
    this.lastLevelPostAt = 0;

    this.port.onmessage = (event) => {
      const command = event.data;
      if (!command || typeof command !== "object") return;
      if (command.type === "release") {
        this.release();
        return;
      }
      if (command.type === "mute") {
        this.inputMuted = command.muted === true;
        if (this.inputMuted) this.clearBuffer();
        return;
      }
      if (command.type === "reset") {
        this.phase = "buffering";
        this.clearBuffer();
      }
    };
  }

  clearBuffer() {
    this.readIndex = 0;
    this.bufferedFrames = 0;
  }

  release() {
    if (this.phase !== "buffering") return;
    const signalOffset = this.findFirstSignalOffset();
    if (signalOffset === null) {
      this.clearBuffer();
      this.phase = "live";
      return;
    }
    const leadingFramesToDrop = Math.max(0, signalOffset - this.preRollFrames);
    this.readIndex = (this.readIndex + leadingFramesToDrop) % this.maximumFrames;
    this.bufferedFrames -= leadingFramesToDrop;
    this.phase = "replaying";
  }

  append(source) {
    if (!source) return;
    for (const sample of source) {
      if (this.bufferedFrames === this.maximumFrames) {
        this.readIndex = (this.readIndex + 1) % this.maximumFrames;
        this.bufferedFrames -= 1;
      }
      const writeIndex = (this.readIndex + this.bufferedFrames) % this.maximumFrames;
      this.buffer[writeIndex] = sample;
      this.bufferedFrames += 1;
    }
  }

  copyInput(source, destination, startIndex = 0) {
    if (!source) return;
    for (let index = startIndex; index < destination.length && index < source.length; index += 1) {
      destination[index] = source[index] ?? 0;
    }
  }

  findFirstSignalOffset() {
    for (let offset = 0; offset < this.bufferedFrames; offset += 1) {
      const index = (this.readIndex + offset) % this.maximumFrames;
      if (Math.abs(this.buffer[index] ?? 0) >= this.signalThreshold) return offset;
    }
    return null;
  }

  hasSignal(source) {
    if (!source) return false;
    return source.some((sample) => Math.abs(sample) >= this.signalThreshold);
  }

  shift() {
    if (this.bufferedFrames === 0) return 0;
    const sample = this.buffer[this.readIndex] ?? 0;
    this.readIndex = (this.readIndex + 1) % this.maximumFrames;
    this.bufferedFrames -= 1;
    return sample;
  }

  process(inputs, outputs) {
    const input = inputs[0];
    const output = outputs[0];
    const source = input && input[0];
    const destination = output && output[0];
    if (!destination) return true;

    destination.fill(0);
    const audibleSource = this.inputMuted ? null : source;
    const bufferingSource = this.inputMuted ? destination : source;
    let sumSquares = 0;
    if (audibleSource) {
      for (const sample of audibleSource) sumSquares += sample * sample;
    }

    if (this.phase === "buffering") {
      this.append(bufferingSource);
    } else if (this.phase === "live") {
      this.copyInput(audibleSource, destination);
    } else {
      if (this.hasSignal(audibleSource)) this.append(audibleSource);
      for (let index = 0; index < destination.length; index += 1) {
        if (this.bufferedFrames === 0) {
          this.phase = "live";
          this.copyInput(audibleSource, destination, index);
          break;
        }
        destination[index] = this.shift();
      }
      if (this.bufferedFrames === 0) this.phase = "live";
    }

    const level = Math.min(1, Math.sqrt(sumSquares / Math.max(1, destination.length)) * 3.2);
    const now = currentTime * 1000;
    if (now - this.lastLevelPostAt >= 50) {
      this.lastLevelPostAt = now;
      this.port.postMessage({ type: "level", level });
    }
    return true;
  }
}

registerProcessor("moss-realtime-mic-buffer", MossRealtimeMicBufferProcessor);
