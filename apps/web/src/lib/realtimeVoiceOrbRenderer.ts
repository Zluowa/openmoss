import type { RealtimeVoiceActivity, RealtimeVoicePhase } from "@synara/contracts";
import {
  REALTIME_VOICE_ORB_FRAGMENT_SHADER_SOURCE,
  REALTIME_VOICE_ORB_VERTEX_SHADER_SOURCE,
  advanceRealtimeVoiceOrbState,
  realtimeVoiceOrbCorePhase,
  realtimeVoiceOrbSmoothingFactor,
  realtimeVoiceOrbStateTargets,
  syntheticRealtimeVoiceOrbAudio,
} from "@synara/shared/realtimeVoiceOrbShader";

import type { RealtimeVoiceOutputSignal } from "./realtimeVoiceWebRtc";

export {
  advanceRealtimeVoiceOrbState,
  realtimeVoiceOrbActivity,
  realtimeVoiceOrbCorePhase,
  realtimeVoiceOrbSmoothstep,
  realtimeVoiceOrbSmoothingFactor,
  realtimeVoiceOrbStateTargets,
  syntheticRealtimeVoiceOrbAudio,
} from "@synara/shared/realtimeVoiceOrbShader";
export type {
  RealtimeVoiceOrbActivity,
  RealtimeVoiceOrbCorePhase,
  RealtimeVoiceOrbStateWeights,
} from "@synara/shared/realtimeVoiceOrbShader";

export const REALTIME_VOICE_ORB_DPR_CAP = 1.5;

export const REALTIME_VOICE_ORB_WEBGL_CONTEXT_ATTRIBUTES = Object.freeze({
  alpha: true,
  antialias: false,
  depth: false,
  premultipliedAlpha: false,
}) satisfies WebGLContextAttributes;

export interface RealtimeVoiceOrbInputs {
  readonly phase: RealtimeVoicePhase;
  readonly activity: RealtimeVoiceActivity | null;
  readonly previewAudioLevel: number;
  readonly previewTimeMs?: number;
  readonly readPublishedAudioLevels?: () => RealtimeVoiceOutputSignal;
}

export interface RealtimeVoiceOrbAnimationRuntime {
  readonly nowMs: () => number;
  readonly devicePixelRatio: () => number;
  readonly requestAnimationFrame: (callback: FrameRequestCallback) => number;
  readonly cancelAnimationFrame: (handle: number) => void;
}

const FULLSCREEN_TRIANGLE_VERTICES = new Float32Array([-1, -1, 1, -1, -1, 1, -1, 1, 1, -1, 1, 1]);

interface RealtimeVoiceOrbUniforms {
  readonly audio: WebGLUniformLocation;
  readonly cumulativeAudio: WebGLUniformLocation;
  readonly micLevel: WebGLUniformLocation;
  readonly outputLevel: WebGLUniformLocation;
  readonly resolution: WebGLUniformLocation;
  readonly stateListen: WebGLUniformLocation;
  readonly stateSpeak: WebGLUniformLocation;
  readonly stateThink: WebGLUniformLocation;
  readonly time: WebGLUniformLocation;
}

interface MutableRealtimeVoiceOrbStateWeights {
  listen: number;
  speak: number;
  think: number;
}

function browserAnimationRuntime(): RealtimeVoiceOrbAnimationRuntime {
  return {
    nowMs: () => performance.now(),
    devicePixelRatio: () => window.devicePixelRatio || 1,
    requestAnimationFrame: (callback) => window.requestAnimationFrame(callback),
    cancelAnimationFrame: (handle) => window.cancelAnimationFrame(handle),
  };
}

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function realtimeVoiceOrbBackingStoreSize(
  cssWidth: number,
  cssHeight: number,
  devicePixelRatio: number,
): { readonly width: number; readonly height: number; readonly pixelRatio: number } {
  const pixelRatio = Math.min(
    Number.isFinite(devicePixelRatio) && devicePixelRatio > 0 ? devicePixelRatio : 1,
    REALTIME_VOICE_ORB_DPR_CAP,
  );
  return {
    width: Math.max(1, Math.round(Math.max(0, cssWidth) * pixelRatio)),
    height: Math.max(1, Math.round(Math.max(0, cssHeight) * pixelRatio)),
    pixelRatio,
  };
}

function compileShader(
  gl: WebGLRenderingContext,
  shaderType: number,
  source: string,
): WebGLShader | null {
  const shader = gl.createShader(shaderType);
  if (!shader) return null;
  gl.shaderSource(shader, source);
  gl.compileShader(shader);
  if (gl.getShaderParameter(shader, gl.COMPILE_STATUS)) return shader;
  gl.deleteShader(shader);
  return null;
}

function requiredUniform(
  gl: WebGLRenderingContext,
  program: WebGLProgram,
  name: string,
): WebGLUniformLocation | null {
  return gl.getUniformLocation(program, name);
}

export class RealtimeVoiceOrbRenderer {
  readonly #canvas: HTMLCanvasElement;
  readonly #runtime: RealtimeVoiceOrbAnimationRuntime;
  #animationFrameId: number | null = null;
  #audioData = new Float32Array(4);
  #cumulativeAudioData = new Float32Array(4);
  #fallbackContext: CanvasRenderingContext2D | null = null;
  #gl: WebGLRenderingContext | null = null;
  #hasInputs = false;
  #inputs: RealtimeVoiceOrbInputs = {
    phase: "inactive",
    activity: null,
    previewAudioLevel: 0,
  };
  #lastFrameTimeSeconds = 0;
  #micLevel = 0;
  #outputLevel = 0;
  #program: WebGLProgram | null = null;
  #vertexBuffer: WebGLBuffer | null = null;
  #vertexShader: WebGLShader | null = null;
  #fragmentShader: WebGLShader | null = null;
  #state: MutableRealtimeVoiceOrbStateWeights = { listen: 0, speak: 0, think: 0 };
  #uniforms: RealtimeVoiceOrbUniforms | null = null;

  constructor(
    canvas: HTMLCanvasElement,
    runtime: RealtimeVoiceOrbAnimationRuntime = browserAnimationRuntime(),
  ) {
    this.#canvas = canvas;
    this.#runtime = runtime;
    const gl = canvas.getContext(
      "webgl",
      REALTIME_VOICE_ORB_WEBGL_CONTEXT_ATTRIBUTES,
    ) as WebGLRenderingContext | null;
    if (!gl) {
      this.#fallbackContext = canvas.getContext("2d");
      return;
    }
    this.#gl = gl;
    if (!this.#createProgram(gl)) {
      this.#releaseWebGlResources();
      this.#gl = null;
      this.#fallbackContext = canvas.getContext("2d");
    }
  }

  setInputs(inputs: RealtimeVoiceOrbInputs): void {
    this.#inputs = inputs;
    if (!this.#hasInputs) {
      this.#state = { ...realtimeVoiceOrbStateTargets(inputs.phase, inputs.activity) };
      this.#hasInputs = true;
    }

    if (
      inputs.previewTimeMs !== undefined ||
      realtimeVoiceOrbCorePhase(inputs.phase) === "inactive"
    ) {
      this.#cancelAnimationFrame();
      this.#render((inputs.previewTimeMs ?? this.#runtime.nowMs()) / 1_000);
      return;
    }
    if (this.#animationFrameId === null) {
      this.#lastFrameTimeSeconds = this.#runtime.nowMs() / 1_000;
      this.#animationFrameId = this.#runtime.requestAnimationFrame(this.#renderFrame);
    }
  }

  dispose(): void {
    this.#cancelAnimationFrame();
    this.#releaseWebGlResources();
    this.#gl = null;
    this.#fallbackContext = null;
  }

  #renderFrame = (timeMs: number): void => {
    this.#animationFrameId = null;
    this.#render(timeMs / 1_000);
    if (this.#inputs.previewTimeMs === undefined) {
      this.#animationFrameId = this.#runtime.requestAnimationFrame(this.#renderFrame);
    }
  };

  #cancelAnimationFrame(): void {
    if (this.#animationFrameId === null) return;
    this.#runtime.cancelAnimationFrame(this.#animationFrameId);
    this.#animationFrameId = null;
  }

  #createProgram(gl: WebGLRenderingContext): boolean {
    const program = gl.createProgram();
    const vertexShader = compileShader(
      gl,
      gl.VERTEX_SHADER,
      REALTIME_VOICE_ORB_VERTEX_SHADER_SOURCE,
    );
    const fragmentShader = compileShader(
      gl,
      gl.FRAGMENT_SHADER,
      REALTIME_VOICE_ORB_FRAGMENT_SHADER_SOURCE,
    );
    if (!program || !vertexShader || !fragmentShader) {
      if (program) gl.deleteProgram(program);
      if (vertexShader) gl.deleteShader(vertexShader);
      if (fragmentShader) gl.deleteShader(fragmentShader);
      return false;
    }

    gl.attachShader(program, vertexShader);
    gl.attachShader(program, fragmentShader);
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) {
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return false;
    }

    const positionAttribute = gl.getAttribLocation(program, "a_position");
    const vertexBuffer = gl.createBuffer();
    const uniformLocations = {
      audio: requiredUniform(gl, program, "u_audio"),
      cumulativeAudio: requiredUniform(gl, program, "u_cumulativeAudio"),
      micLevel: requiredUniform(gl, program, "u_micLevel"),
      outputLevel: requiredUniform(gl, program, "u_outputLevel"),
      resolution: requiredUniform(gl, program, "u_resolution"),
      stateListen: requiredUniform(gl, program, "u_stateListen"),
      stateSpeak: requiredUniform(gl, program, "u_stateSpeak"),
      stateThink: requiredUniform(gl, program, "u_stateThink"),
      time: requiredUniform(gl, program, "u_time"),
    };
    if (
      positionAttribute < 0 ||
      !vertexBuffer ||
      Object.values(uniformLocations).some((location) => location === null)
    ) {
      if (vertexBuffer) gl.deleteBuffer(vertexBuffer);
      gl.deleteProgram(program);
      gl.deleteShader(vertexShader);
      gl.deleteShader(fragmentShader);
      return false;
    }

    gl.bindBuffer(gl.ARRAY_BUFFER, vertexBuffer);
    gl.bufferData(gl.ARRAY_BUFFER, FULLSCREEN_TRIANGLE_VERTICES, gl.STATIC_DRAW);
    gl.useProgram(program);
    gl.enableVertexAttribArray(positionAttribute);
    gl.vertexAttribPointer(positionAttribute, 2, gl.FLOAT, false, 0, 0);
    gl.enable(gl.BLEND);
    gl.blendFunc(gl.SRC_ALPHA, gl.ONE_MINUS_SRC_ALPHA);

    this.#program = program;
    this.#vertexBuffer = vertexBuffer;
    this.#vertexShader = vertexShader;
    this.#fragmentShader = fragmentShader;
    this.#uniforms = uniformLocations as RealtimeVoiceOrbUniforms;
    return true;
  }

  #releaseWebGlResources(): void {
    const gl = this.#gl;
    if (!gl) return;
    if (this.#vertexBuffer) gl.deleteBuffer(this.#vertexBuffer);
    if (this.#program) gl.deleteProgram(this.#program);
    if (this.#vertexShader) gl.deleteShader(this.#vertexShader);
    if (this.#fragmentShader) gl.deleteShader(this.#fragmentShader);
    this.#vertexBuffer = null;
    this.#program = null;
    this.#vertexShader = null;
    this.#fragmentShader = null;
    this.#uniforms = null;
  }

  #render(timeSeconds: number): void {
    const deltaSeconds =
      this.#lastFrameTimeSeconds === 0 || this.#inputs.previewTimeMs !== undefined
        ? 0.016
        : Math.max(0, Math.min(0.05, timeSeconds - this.#lastFrameTimeSeconds));
    this.#lastFrameTimeSeconds = timeSeconds;
    this.#updateState(deltaSeconds);
    this.#updateAudio(deltaSeconds, timeSeconds);
    this.#resizeCanvas();

    const gl = this.#gl;
    const program = this.#program;
    const uniforms = this.#uniforms;
    if (!gl || !program || !uniforms) {
      this.#renderCanvasFallback(timeSeconds);
      return;
    }

    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.viewport(0, 0, this.#canvas.width, this.#canvas.height);
    gl.useProgram(program);
    gl.uniform1f(uniforms.time, timeSeconds);
    gl.uniform1f(uniforms.micLevel, this.#micLevel);
    gl.uniform1f(uniforms.outputLevel, this.#outputLevel);
    gl.uniform1f(uniforms.stateListen, this.#state.listen);
    gl.uniform1f(uniforms.stateThink, this.#state.think);
    gl.uniform1f(uniforms.stateSpeak, this.#state.speak);
    gl.uniform2f(uniforms.resolution, this.#canvas.width, this.#canvas.height);
    gl.uniform4fv(uniforms.audio, this.#audioData);
    gl.uniform4fv(uniforms.cumulativeAudio, this.#cumulativeAudioData);
    gl.drawArrays(gl.TRIANGLES, 0, 6);
  }

  #resizeCanvas(): void {
    const size = realtimeVoiceOrbBackingStoreSize(
      this.#canvas.clientWidth,
      this.#canvas.clientHeight,
      this.#runtime.devicePixelRatio(),
    );
    if (this.#canvas.width !== size.width) this.#canvas.width = size.width;
    if (this.#canvas.height !== size.height) this.#canvas.height = size.height;
  }

  #updateState(deltaSeconds: number): void {
    this.#state = {
      ...advanceRealtimeVoiceOrbState(
        this.#state,
        this.#inputs.phase,
        this.#inputs.activity,
        deltaSeconds,
        this.#inputs.previewTimeMs !== undefined,
      ),
    };
  }

  #readPublishedAudioLevels(): RealtimeVoiceOutputSignal | null {
    if (realtimeVoiceOrbCorePhase(this.#inputs.phase) === "inactive") return null;
    const readPublishedAudioLevels = this.#inputs.readPublishedAudioLevels;
    if (!readPublishedAudioLevels) return null;
    try {
      const signal = readPublishedAudioLevels();
      return {
        low: clamp01(signal.low),
        mid: clamp01(signal.mid),
        high: clamp01(signal.high),
        overall: clamp01(signal.overall),
      };
    } catch {
      return null;
    }
  }

  #updateAudio(deltaSeconds: number, timeSeconds: number): void {
    const published = this.#readPublishedAudioLevels();
    if (published) {
      const levels = [published.low, published.mid, published.high, published.overall] as const;
      const frameScale = deltaSeconds * 60;
      const longSmoothing = realtimeVoiceOrbSmoothingFactor(deltaSeconds, 2);
      for (let index = 0; index < this.#audioData.length; index += 1) {
        const level = levels[index] ?? 0;
        const target = level * frameScale;
        const current = this.#audioData[index] ?? 0;
        const cumulative = this.#cumulativeAudioData[index] ?? 0;
        this.#audioData[index] = current + (target - current) * longSmoothing;
        this.#cumulativeAudioData[index] = cumulative + level * frameScale * 40 * longSmoothing;
      }
      const maximumLevel = Math.max(...levels);
      const micSmoothing = realtimeVoiceOrbSmoothingFactor(
        deltaSeconds,
        maximumLevel > this.#micLevel ? 0.12 : 0.32,
      );
      this.#micLevel += (maximumLevel - this.#micLevel) * micSmoothing;
      const outputSmoothing = realtimeVoiceOrbSmoothingFactor(
        deltaSeconds,
        published.overall > this.#outputLevel ? 0.09 : 0.3,
      );
      this.#outputLevel += (published.overall - this.#outputLevel) * outputSmoothing;
      return;
    }

    const synthetic = syntheticRealtimeVoiceOrbAudio(
      this.#inputs.activity,
      this.#inputs.previewAudioLevel,
      this.#inputs.previewTimeMs === undefined,
      timeSeconds,
    );
    if (this.#inputs.previewTimeMs !== undefined) {
      for (let index = 0; index < this.#audioData.length; index += 1) {
        const level = synthetic[index] ?? 0;
        this.#audioData[index] = level;
        this.#cumulativeAudioData[index] = level * timeSeconds * 2.5;
      }
      this.#micLevel = synthetic[3] ?? 0;
      this.#outputLevel = synthetic[3] ?? 0;
      return;
    }

    for (let index = 0; index < this.#audioData.length; index += 1) {
      const target = synthetic[index] ?? 0;
      const smoothing = realtimeVoiceOrbSmoothingFactor(
        deltaSeconds,
        target > this.#audioData[index]! ? 0.24 : 0.72,
      );
      const current = this.#audioData[index] ?? 0;
      const cumulative = this.#cumulativeAudioData[index] ?? 0;
      const next = current + (target - current) * smoothing;
      this.#audioData[index] = next;
      this.#cumulativeAudioData[index] =
        cumulative + next * deltaSeconds * (this.#inputs.activity === "speaking" ? 7 : 3.5);
    }
    const overall = synthetic[3] ?? 0;
    const micSmoothing = realtimeVoiceOrbSmoothingFactor(
      deltaSeconds,
      overall > this.#micLevel ? 0.26 : 0.8,
    );
    this.#micLevel += (overall - this.#micLevel) * micSmoothing;
    const outputTarget = this.#inputs.previewAudioLevel > 0 ? overall : 0;
    const outputSmoothing = realtimeVoiceOrbSmoothingFactor(
      deltaSeconds,
      outputTarget > this.#outputLevel ? 0.09 : 0.3,
    );
    this.#outputLevel += (outputTarget - this.#outputLevel) * outputSmoothing;
  }

  #renderCanvasFallback(timeSeconds: number): void {
    const context = this.#fallbackContext;
    if (!context) return;
    const baseRadius = Math.min(this.#canvas.width, this.#canvas.height) * 0.29;
    const centerX = this.#canvas.width / 2;
    const centerY = this.#canvas.height / 2 + Math.sin(timeSeconds * 0.36) * 1.5;
    context.clearRect(0, 0, this.#canvas.width, this.#canvas.height);
    const gradient = context.createLinearGradient(
      centerX - baseRadius * 0.7,
      centerY - baseRadius,
      centerX + baseRadius * 0.55,
      centerY + baseRadius,
    );
    gradient.addColorStop(0, "rgba(1, 129, 254, 1)");
    gradient.addColorStop(0.46, "rgba(164, 239, 255, 0.98)");
    gradient.addColorStop(1, "rgba(255, 253, 239, 0.98)");
    context.fillStyle = gradient;
    context.beginPath();
    context.arc(centerX, centerY, baseRadius * (1 + this.#outputLevel * 0.12), 0, Math.PI * 2);
    context.fill();
  }
}
