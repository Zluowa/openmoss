import type { RealtimeVoiceActivity, RealtimeVoicePhase } from "@synara/contracts";

export type RealtimeVoiceOrbCorePhase = "active" | "inactive" | "starting" | "stopping";
export type RealtimeVoiceOrbActivity = RealtimeVoiceActivity | "idle";

export interface RealtimeVoiceOrbStateWeights {
  readonly listen: number;
  readonly speak: number;
  readonly think: number;
}

export const REALTIME_VOICE_ORB_VERTEX_SHADER_SOURCE = `
attribute vec2 a_position;
varying vec2 v_uv;

void main() {
  v_uv = (a_position + 1.0) * 0.5;
  gl_Position = vec4(a_position, 0.0, 1.0);
}
`;

// Clean-room shader derived from observable geometry, color, motion, and audio
// response parameters in the installed Codex build. Names intentionally describe
// the visual operation rather than preserving bundled implementation identifiers.
export const REALTIME_VOICE_ORB_FRAGMENT_SHADER_SOURCE = `
precision highp float;

varying vec2 v_uv;

uniform vec2 u_resolution;
uniform float u_time;
uniform float u_micLevel;
uniform float u_outputLevel;
uniform float u_stateListen;
uniform float u_stateThink;
uniform float u_stateSpeak;
uniform vec4 u_audio;
uniform vec4 u_cumulativeAudio;

#define PI 3.141592653589793
#define FRACTAL_OCTAVES 5

float random2d(vec2 coordinate) {
  return fract(sin(dot(coordinate, vec2(12.9898, 4.1414))) * 43758.5453);
}

float valueNoise2d(vec2 point) {
  vec2 cell = floor(point);
  vec2 blend = fract(point);
  blend = blend * blend * (3.0 - 2.0 * blend);

  float value = mix(
    mix(random2d(cell), random2d(cell + vec2(1.0, 0.0)), blend.x),
    mix(random2d(cell + vec2(0.0, 1.0)), random2d(cell + vec2(1.0, 1.0)), blend.x),
    blend.y
  );
  return value * value;
}

float fractalBrownianMotion(vec2 point) {
  float value = 0.0;
  float amplitude = 0.5;
  vec2 shift = vec2(100.0);
  mat2 rotation = mat2(cos(0.5), sin(0.5), -sin(0.5), cos(0.5));
  for (int octave = 0; octave < FRACTAL_OCTAVES; octave++) {
    value += amplitude * valueNoise2d(point);
    point = rotation * point * 2.0 + shift;
    amplitude *= 0.5;
  }
  return value;
}

vec3 linearBurn(vec3 base, vec3 blend, float opacity) {
  vec3 burned = max(base + blend - vec3(1.0), vec3(0.0));
  return mix(base, burned, opacity);
}

vec4 permute289(vec4 value) {
  return mod((value * 34.0 + 1.0) * value, 289.0);
}

vec4 inverseSqrtApproximation(vec4 value) {
  return 1.79284291400159 - 0.85373472095314 * value;
}

vec3 quinticFade(vec3 value) {
  return value * value * value * (value * (value * 6.0 - 15.0) + 10.0);
}

float classicNoise3d(vec3 point) {
  vec3 lowerCell = floor(point);
  vec3 upperCell = lowerCell + vec3(1.0);
  lowerCell = mod(lowerCell, 289.0);
  upperCell = mod(upperCell, 289.0);
  vec3 lowerOffset = fract(point);
  vec3 upperOffset = lowerOffset - vec3(1.0);
  vec4 x = vec4(lowerCell.x, upperCell.x, lowerCell.x, upperCell.x);
  vec4 y = vec4(lowerCell.yy, upperCell.yy);
  vec4 lowerZ = vec4(lowerCell.z);
  vec4 upperZ = vec4(upperCell.z);
  vec4 xy = permute289(permute289(x) + y);
  vec4 lowerGradientIndex = permute289(xy + lowerZ);
  vec4 upperGradientIndex = permute289(xy + upperZ);

  vec4 lowerGradientX = lowerGradientIndex / 7.0;
  vec4 lowerGradientY = fract(floor(lowerGradientX) / 7.0) - 0.5;
  lowerGradientX = fract(lowerGradientX);
  vec4 lowerGradientZ = vec4(0.5) - abs(lowerGradientX) - abs(lowerGradientY);
  vec4 lowerCorrection = step(lowerGradientZ, vec4(0.0));
  lowerGradientX -= lowerCorrection * (step(vec4(0.0), lowerGradientX) - 0.5);
  lowerGradientY -= lowerCorrection * (step(vec4(0.0), lowerGradientY) - 0.5);

  vec4 upperGradientX = upperGradientIndex / 7.0;
  vec4 upperGradientY = fract(floor(upperGradientX) / 7.0) - 0.5;
  upperGradientX = fract(upperGradientX);
  vec4 upperGradientZ = vec4(0.5) - abs(upperGradientX) - abs(upperGradientY);
  vec4 upperCorrection = step(upperGradientZ, vec4(0.0));
  upperGradientX -= upperCorrection * (step(vec4(0.0), upperGradientX) - 0.5);
  upperGradientY -= upperCorrection * (step(vec4(0.0), upperGradientY) - 0.5);

  vec3 gradient000 = vec3(lowerGradientX.x, lowerGradientY.x, lowerGradientZ.x);
  vec3 gradient100 = vec3(lowerGradientX.y, lowerGradientY.y, lowerGradientZ.y);
  vec3 gradient010 = vec3(lowerGradientX.z, lowerGradientY.z, lowerGradientZ.z);
  vec3 gradient110 = vec3(lowerGradientX.w, lowerGradientY.w, lowerGradientZ.w);
  vec3 gradient001 = vec3(upperGradientX.x, upperGradientY.x, upperGradientZ.x);
  vec3 gradient101 = vec3(upperGradientX.y, upperGradientY.y, upperGradientZ.y);
  vec3 gradient011 = vec3(upperGradientX.z, upperGradientY.z, upperGradientZ.z);
  vec3 gradient111 = vec3(upperGradientX.w, upperGradientY.w, upperGradientZ.w);

  vec4 lowerNorm = inverseSqrtApproximation(vec4(
    dot(gradient000, gradient000),
    dot(gradient010, gradient010),
    dot(gradient100, gradient100),
    dot(gradient110, gradient110)
  ));
  gradient000 *= lowerNorm.x;
  gradient010 *= lowerNorm.y;
  gradient100 *= lowerNorm.z;
  gradient110 *= lowerNorm.w;
  vec4 upperNorm = inverseSqrtApproximation(vec4(
    dot(gradient001, gradient001),
    dot(gradient011, gradient011),
    dot(gradient101, gradient101),
    dot(gradient111, gradient111)
  ));
  gradient001 *= upperNorm.x;
  gradient011 *= upperNorm.y;
  gradient101 *= upperNorm.z;
  gradient111 *= upperNorm.w;

  float contribution000 = dot(gradient000, lowerOffset);
  float contribution100 = dot(gradient100, vec3(upperOffset.x, lowerOffset.yz));
  float contribution010 = dot(gradient010, vec3(lowerOffset.x, upperOffset.y, lowerOffset.z));
  float contribution110 = dot(gradient110, vec3(upperOffset.xy, lowerOffset.z));
  float contribution001 = dot(gradient001, vec3(lowerOffset.xy, upperOffset.z));
  float contribution101 = dot(gradient101, vec3(upperOffset.x, lowerOffset.y, upperOffset.z));
  float contribution011 = dot(gradient011, vec3(lowerOffset.x, upperOffset.yz));
  float contribution111 = dot(gradient111, upperOffset);

  vec3 interpolation = quinticFade(lowerOffset);
  vec4 zBlend = mix(
    vec4(contribution000, contribution100, contribution010, contribution110),
    vec4(contribution001, contribution101, contribution011, contribution111),
    interpolation.z
  );
  vec2 yzBlend = mix(zBlend.xy, zBlend.zw, interpolation.y);
  return 2.2 * mix(yzBlend.x, yzBlend.y, interpolation.x);
}

void main() {
  vec2 centered = v_uv - 0.5;
  centered.x *= u_resolution.x / u_resolution.y;

  float sound = max(max(u_audio.x, u_audio.y), max(u_audio.z, u_audio.w));
  float stateAmount = max(u_stateListen, max(u_stateThink, u_stateSpeak));
  float thinking = u_stateThink;
  float audioEnergy = smoothstep(0.08, 0.72, max(sound, u_micLevel));
  float outputEnergy = smoothstep(0.04, 0.46, u_outputLevel);
  float breath = sin(u_time * PI * 0.34) * 0.5 + 0.5;
  float entry = smoothstep(0.0, 0.9, stateAmount);
  float maxDrawableRadius = min(0.36, min(0.5, 0.5 * u_resolution.x / u_resolution.y) - 0.16);
  float baseRadius = mix(maxDrawableRadius * 0.88, maxDrawableRadius * 0.94, thinking);
  float radius = baseRadius * mix(0.82, 1.0, entry);
  radius += outputEnergy * maxDrawableRadius * 0.12;
  radius +=
    (1.0 - thinking) *
    (1.0 - outputEnergy) *
    breath *
    maxDrawableRadius *
    0.01;
  radius = min(maxDrawableRadius, radius);

  vec2 drift = vec2(
    sin(u_time * 0.43) * 0.0028,
    sin(u_time * 0.36 + 1.7) * 0.0035
  );
  vec2 lifted = centered - drift;
  float distanceToEdge = length(lifted) - radius;
  float edgeWidth = max(1.25 / min(u_resolution.x, u_resolution.y), 0.0014);
  if (distanceToEdge > edgeWidth) {
    discard;
  }
  float edgeAlpha = 1.0 - smoothstep(-edgeWidth, edgeWidth, distanceToEdge);

  vec2 watercolorUv = lifted / (2.0 * radius) + 0.5;
  float soundScale = 1.0 + audioEnergy * 0.22;
  float watercolorTime = u_time * 0.34;
  float broadNoiseX = classicNoise3d(vec3(
    watercolorUv + vec2(0.0, 74.8572),
    (watercolorTime + u_cumulativeAudio.x * 0.05 * soundScale) * 0.3
  ));
  float broadNoiseY = classicNoise3d(vec3(
    watercolorUv + vec2(203.91282, 10.0),
    (watercolorTime + u_cumulativeAudio.z * 0.05 * soundScale) * 0.3
  ));
  watercolorUv += vec2(broadNoiseX * 2.0, broadNoiseY) * 0.19;

  float voiceWarpX = classicNoise3d(vec3(
    watercolorUv * 3.1 + vec2(0.0, 17.3),
    u_cumulativeAudio.x * 0.085 + u_cumulativeAudio.z * 0.035
  ));
  float voiceWarpY = classicNoise3d(vec3(
    watercolorUv * 3.4 + vec2(31.7, 0.0),
    u_cumulativeAudio.y * 0.075 + u_cumulativeAudio.w * 0.045
  ));
  watercolorUv += vec2(voiceWarpX, voiceWarpY) * audioEnergy * 0.04;
  watercolorUv.y +=
    sin(watercolorUv.x * 5.4 + u_cumulativeAudio.w * 0.19) *
    audioEnergy *
    0.016;

  float fineWatercolorNoise =
    classicNoise3d(vec3(watercolorUv * 18.0 + vec2(344.91282, 0.0), watercolorTime * 0.3)) +
    classicNoise3d(vec3(watercolorUv * 39.6 + vec2(723.937, 0.0), watercolorTime * 0.4)) * 0.5;
  watercolorUv += fineWatercolorNoise * 0.006;

  float paperNoiseA = valueNoise2d(
    watercolorUv * 22.0 + vec2(watercolorTime * 0.08, u_cumulativeAudio.x * 0.025)
  );
  float paperNoiseB = valueNoise2d(
    vec2(1.0 - watercolorUv.x, watercolorUv.y) * 41.0 +
    vec2(u_cumulativeAudio.z * 0.018, -watercolorTime * 0.11)
  );
  float paperDisplacement = mix(
    paperNoiseA,
    paperNoiseB,
    sin(watercolorTime + u_cumulativeAudio.w * 0.12) * 0.5 + 0.5
  ) - 0.5;
  watercolorUv += paperDisplacement * (0.012 + audioEnergy * 0.004);

  watercolorUv.y = 1.0 - watercolorUv.y;
  vec2 rotatedUv = watercolorUv - 0.5;
  float gradientAngle = -0.16;
  watercolorUv = mat2(
    cos(gradientAngle), -sin(gradientAngle),
    sin(gradientAngle), cos(gradientAngle)
  ) * rotatedUv + 0.5;
  watercolorUv.y -= 0.03;

  vec2 flowUv = watercolorUv * 1.25;
  vec2 firstFlow = vec2(
    fractalBrownianMotion(
      flowUv * 0.5 + 0.075 * (watercolorTime + u_cumulativeAudio.w * 0.175 * soundScale)
    ),
    fractalBrownianMotion(
      flowUv * 0.5 + 0.075 * (watercolorTime + u_cumulativeAudio.x * 0.136 * soundScale)
    )
  );
  vec2 secondFlow = vec2(
    fractalBrownianMotion(
      flowUv + firstFlow + vec2(0.3, 9.2) +
      0.15 * (watercolorTime + u_cumulativeAudio.y * 0.234 * soundScale)
    ),
    fractalBrownianMotion(
      flowUv + firstFlow + vec2(8.3, 0.8) +
      0.126 * (watercolorTime + u_cumulativeAudio.z * 0.165 * soundScale)
    )
  );
  float flow = fractalBrownianMotion(flowUv + secondFlow - firstFlow);
  float fullFlow = pow(((flow + 0.6 * flow * flow + 0.7 * flow) + 0.5) * 0.5, 0.55);

  vec3 baseColor = mix(vec3(0.94, 0.965, 1.0), vec3(1.0, 0.99, 0.96), u_micLevel);
  vec3 lowColor = vec3(0.36, 0.34, 0.96);
  vec3 midColor = mix(vec3(0.57, 0.64, 1.0), vec3(0.96, 0.92, 1.0), u_micLevel);
  vec3 highColor = vec3(1.0, 0.99, 0.97);

  vec3 audioOffsets = vec3(
    u_cumulativeAudio.x * 0.15 * soundScale,
    -u_cumulativeAudio.y * 0.5 * soundScale,
    u_cumulativeAudio.z * 1.5 * soundScale
  );

  vec2 lowUv = watercolorUv + vec2((fullFlow - 0.5) * 1.2, 0.025);
  float lowNoise = valueNoise2d(
    lowUv * 2.0 + vec2(sin(audioOffsets.x * 0.25), watercolorTime * 0.5 + audioOffsets.x)
  ) * 2.0;
  float lowBlend = smoothstep(
    lowNoise - 1.8,
    lowNoise + 1.8,
    ((lowUv.y - 0.5) * (5.0 - u_audio.x * 0.05 * soundScale)) + 0.5
  );

  vec2 midUv = watercolorUv + vec2((fullFlow - 0.5) * 0.85, 0.025);
  float midNoise = valueNoise2d(
    midUv * 4.0 +
    vec2(sin(audioOffsets.y * 0.15) * 2.4 + 293.0, watercolorTime + audioOffsets.y * 0.5)
  ) * 2.0;
  float midBlend = smoothstep(
    midNoise - ((0.9 + u_audio.y * 0.4) * 1.5),
    midNoise + ((0.9 + u_audio.y * 0.8) * 1.5),
    ((midUv.y - 0.6) * (5.0 - u_audio.y * 0.75)) + 0.5
  );

  vec2 highUv = watercolorUv + vec2((fullFlow - 0.5) * 1.1);
  float highNoise = valueNoise2d(
    highUv * 6.0 +
    vec2(sin(audioOffsets.z * 0.1) * 2.4 + 153.0, watercolorTime * 1.2 + audioOffsets.z * 0.8)
  ) * 2.0;
  float highBlend = smoothstep(
    highNoise - 1.05,
    highNoise + 1.05,
    ((highUv.y - 0.9) * 6.0) + 0.5
  );

  lowBlend = pow(lowBlend, 0.8);
  midBlend = pow(midBlend, 0.9);
  vec3 color = linearBurn(baseColor, lowColor, 1.0 - lowBlend);
  color = linearBurn(color, mix(baseColor, midColor, 1.0 - midBlend), lowBlend);
  color = mix(color, mix(baseColor, highColor, 1.0 - highBlend), lowBlend * midBlend);

  float fineColorNoise = fractalBrownianMotion(
    watercolorUv * 12.0 +
    vec2(watercolorTime * 0.13, -watercolorTime * 0.09) +
    secondFlow * 0.4
  );
  color = mix(
    color,
    highColor,
    smoothstep(0.58, 0.9, fineColorNoise) * (0.035 + audioEnergy * 0.025)
  );
  color = mix(
    color,
    lowColor,
    (1.0 - smoothstep(0.12, 0.42, fineColorNoise)) * 0.018
  );

  float alpha = edgeAlpha * smoothstep(0.0, 0.18, stateAmount + 0.3);
  gl_FragColor = vec4(color, alpha);
}
`;

function clamp01(value: number): number {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(1, value));
}

export function realtimeVoiceOrbCorePhase(phase: RealtimeVoicePhase): RealtimeVoiceOrbCorePhase {
  switch (phase) {
    case "reserving":
    case "presenting":
    case "starting":
      return "starting";
    case "active":
      return "active";
    case "stopping":
      return "stopping";
    case "failed":
    case "inactive":
      return "inactive";
  }
}

export function realtimeVoiceOrbActivity(
  activity: RealtimeVoiceActivity | null,
): RealtimeVoiceOrbActivity {
  return activity ?? "idle";
}

export function realtimeVoiceOrbStateTargets(
  phase: RealtimeVoicePhase,
  activity: RealtimeVoiceActivity | null,
): RealtimeVoiceOrbStateWeights {
  switch (realtimeVoiceOrbCorePhase(phase)) {
    case "inactive":
      return { listen: 0, speak: 0, think: 0 };
    case "starting":
      return { listen: 0, speak: 0, think: 1 };
    case "stopping":
      return { listen: 0.35, speak: 0, think: 0 };
    case "active":
      break;
  }

  switch (realtimeVoiceOrbActivity(activity)) {
    case "idle":
    case "listening":
      return { listen: 1, speak: 0, think: 0 };
    case "thinking":
      return { listen: 0.65, speak: 0, think: 1 };
    case "speaking":
      return { listen: 0.2, speak: 1, think: 0 };
  }
}

export function realtimeVoiceOrbSmoothingFactor(
  deltaSeconds: number,
  timeConstant: number,
): number {
  if (!Number.isFinite(deltaSeconds) || deltaSeconds <= 0) return 0;
  if (!Number.isFinite(timeConstant) || timeConstant <= 0) return 1;
  return 1 - Math.exp(-deltaSeconds / timeConstant);
}

export function advanceRealtimeVoiceOrbState(
  current: RealtimeVoiceOrbStateWeights,
  phase: RealtimeVoicePhase,
  activity: RealtimeVoiceActivity | null,
  deltaSeconds: number,
  deterministicPreview: boolean,
): RealtimeVoiceOrbStateWeights {
  const target = realtimeVoiceOrbStateTargets(phase, activity);
  const smoothing = deterministicPreview ? 1 : realtimeVoiceOrbSmoothingFactor(deltaSeconds, 0.28);
  return {
    listen: current.listen + (target.listen - current.listen) * smoothing,
    speak: current.speak + (target.speak - current.speak) * smoothing,
    think: Math.max(
      current.think + (target.think - current.think) * smoothing,
      realtimeVoiceOrbCorePhase(phase) === "starting" ? 0.6 : 0,
    ),
  };
}

export function realtimeVoiceOrbSmoothstep(edge0: number, edge1: number, value: number): number {
  const progress = clamp01((value - edge0) / (edge1 - edge0));
  return progress * progress * (3 - 2 * progress);
}

export function syntheticRealtimeVoiceOrbAudio(
  activity: RealtimeVoiceActivity | null,
  previewAudioLevel: number,
  live: boolean,
  timeSeconds: number,
): Float32Array {
  const resolvedActivity = realtimeVoiceOrbActivity(activity);
  const level = Math.max(
    live && resolvedActivity === "speaking" ? 0.42 : 0,
    clamp01(previewAudioLevel),
  );
  const slowPulse = realtimeVoiceOrbSmoothstep(
    0.08,
    0.72,
    Math.sin(timeSeconds * 0.78) * 0.5 + 0.5,
  );
  const voicePulse =
    0.58 + Math.sin(timeSeconds * 3.1 + 0.6) * 0.17 + Math.sin(timeSeconds * 4.2 + 2.1) * 0.12;
  const speaking =
    resolvedActivity === "speaking" ? level * (0.08 + slowPulse * Math.max(0.24, voicePulse)) : 0;
  const thinking =
    resolvedActivity === "thinking"
      ? level * (0.1 + (Math.sin(timeSeconds * 1.4) * 0.5 + 0.5) * 0.06)
      : 0;
  const listening = resolvedActivity === "listening" ? level * 0.08 : 0;
  const overall = clamp01(Math.max(speaking, thinking, listening));
  return new Float32Array([
    overall * (0.82 + Math.sin(timeSeconds * 1.1) * 0.14),
    overall * (0.76 + Math.sin(timeSeconds * 1.5 + 1.2) * 0.16),
    overall * (0.68 + Math.sin(timeSeconds * 1.9 + 2.1) * 0.18),
    overall,
  ]);
}
