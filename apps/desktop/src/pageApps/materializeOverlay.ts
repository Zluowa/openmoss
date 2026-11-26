// FILE: materializeOverlay.ts
// Purpose: Fullscreen transparent click-through WebGL2 install materialization overlay
//          (`partition: "moss-app-materialize"`), animating sourceRect -> 96px icon -> window
//          with automatic graceful fallback when Reduce Motion or WebGL2 is unavailable.
// Layer: Desktop pageApps

import {
  BrowserWindow,
  nativeTheme,
  screen,
  systemPreferences,
  type BrowserWindow as BrowserWindowType,
} from "electron";

export const PAGE_APP_MATERIALIZE_PARTITION = "moss-app-materialize";

const IDLE_DESTROY_MS = 10 * 60_000;
const WARM_TIMEOUT_MS = 3_000;
const EVENT_TIMEOUT_MS = 12_000;
const EFFECT_HARD_TIMEOUT_MS = 8_000;
const TARGET_STALL_TIMEOUT_MS = 5_000;
const SOURCE_COVERED_HOLD_MS = 50;
const WINDOW_FADE_MS = 380;

export interface MaterializeRect {
  readonly x: number;
  readonly y: number;
  readonly width: number;
  readonly height: number;
}

export interface StartMaterializeOptions {
  readonly targetWindow: BrowserWindowType;
  readonly sourceRect?: MaterializeRect | null;
  readonly hostWindow?: BrowserWindowType | null;
  readonly hiddenTarget?: boolean;
  readonly iconDataUrl?: Promise<string | null> | string | null;
  readonly sourceImageDataUrl?: string | null;
  readonly cornerRadius?: number;
  readonly onRevealTarget?: () => void;
  readonly onSourceCovered?: () => void;
}

export interface MaterializeHandle {
  reveal(): void;
  cancel(reason?: string): void;
  readonly finished: Promise<void>;
  readonly sourceCovered: Promise<boolean>;
}

const OVERLAY_HTML = `<!doctype html>
<html><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'">
<style>html,body{margin:0;width:100%;height:100%;background:transparent;overflow:hidden}
canvas{position:fixed;inset:0;width:100%;height:100%;display:block}</style>
</head><body aria-hidden="true"><canvas id="c"></canvas>
<script type="module">
const TIMELINE = {
  trace1: 520,
  cover: 470,
  fold1: 1050,
  draw0: 60,
  draw1: 730,
  flash: 810,
  handoff: 820,
  focus: 1040,
  rimOut: 1420,
  done: 1900,
};
const EVENTS = ["source-covered", "handoff", "focus", "done"];
const HOLDS = { "source-covered": 500, handoff: 600 };
const NOT_YET = 1e7;
const ICON_PX = 96;
const ICON_RADIUS = 0.225;
const ICON_FADE_MS = 220;
const ATMO_REF = 330;
const ATMO_MAX_SCALE = 1.8;
const REACH = 340;
const RIM_REACH = 120;
const FOLD_TAIL_MS = 400;
const DIM = 0.38;
const DIM_IN_MS = 320;
const DIM_OUT_MS = [TIMELINE.flash + 60, TIMELINE.done - 300];

const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const smoothstep = (a, b, x) => {
  const t = clamp((x - a) / (b - a), 0, 1);
  return t * t * (3 - 2 * t);
};
const f1 = (x) => x.toFixed(1);

const VERTEX_SHADER = \`#version 300 es
void main(){
  vec2 v = vec2(float((gl_VertexID << 1) & 2), float(gl_VertexID & 2));
  gl_Position = vec4(v * 2.0 - 1.0, 0.0, 1.0);
}\`;

const FRAGMENT_SHADER = \`#version 300 es
precision highp float;
uniform float uHeight;
uniform float uDpr;
uniform float uT;
uniform float uBase;
uniform vec4 uSrc, uTgt, uIcon;
uniform vec2 uOrg;
uniform float uSrcRad, uTgtRad;
uniform float uDark;
uniform float uCopy;
uniform float uHasSrc;
uniform float uIconA;
uniform float uDim;
uniform float uScale;
uniform vec2 uSeed;
uniform float uTitleH;
uniform float uLights;
uniform sampler2D uSrcTex, uIconTex;
out vec4 o;

#define PI 3.14159265
const float TRACE1 = \${f1(TIMELINE.trace1)}, FOLD0 = \${f1(TIMELINE.cover)}, FOLD1 = \${f1(TIMELINE.fold1)};
const float DRAW0 = \${f1(TIMELINE.draw0)}, DRAW1 = \${f1(TIMELINE.draw1)}, FLASH = \${f1(TIMELINE.flash)};
const float HANDOFF = \${f1(TIMELINE.handoff)}, RIM_OUT = \${f1(TIMELINE.rimOut)}, DONE = \${f1(TIMELINE.done)};
const float REACH = \${f1(REACH)};
const vec3 CLAY = vec3(0.93, 0.50, 0.34), GOLD = vec3(1.0, 0.84, 0.56), VIO = vec3(0.66, 0.62, 1.0);
const vec3 TITLE_LIGHT = vec3(0.94, 0.933, 0.91), TITLE_DARK = vec3(0.19, 0.19, 0.18);
const vec3 WIN_LIGHT = vec3(0.953), WIN_DARK = vec3(0.125);

float sdRR(vec2 p, vec2 c, vec2 h, float r){ vec2 q = abs(p - c) - h + r; return length(max(q, 0.0)) + min(max(q.x, q.y), 0.0) - r; }
float sdR(vec2 p, vec4 r, float rad){ return sdRR(p, r.xy + r.zw * 0.5, r.zw * 0.5, min(rad, 0.5 * min(r.z, r.w))); }
float seg(float a, float b, float t){ return clamp((t - a) / (b - a), 0.0, 1.0); }
float sq(float x){ return x * x; }
float ease(float t){ t = clamp(t, 0.0, 1.0); return t * t * (3.0 - 2.0 * t); }
float ang(vec2 p, vec4 r){ vec2 q = (p - (r.xy + r.zw * 0.5)) / (r.zw * 0.5); return atan(q.y, q.x); }
float circ(float a, float b){ return abs(fract(a - b + 0.5) - 0.5); }
float hash(vec2 p){ p = fract(p * vec2(123.34, 456.21)); p += dot(p, p + 45.32); return fract(p.x * p.y); }
float vnoise(vec2 p){
  vec2 i = floor(p), f = fract(p); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(hash(i), hash(i + vec2(1.0, 0.0)), f.x), mix(hash(i + vec2(0.0, 1.0)), hash(i + vec2(1.0, 1.0)), f.x), f.y);
}
float fbm(vec2 p){ return 0.55 * vnoise(p) + 0.3 * vnoise(p * 2.03 + 17.1) + 0.15 * vnoise(p * 4.1 + 5.3); }
float rim(float sd){ return exp(-abs(sd) / 1.5) * 0.95 + exp(-abs(sd) / 15.0) * 0.30; }
float perim(vec2 p, vec4 r){
  vec2 h = r.zw * 0.5; vec2 q = p - (r.xy + h);
  float L;
  if (abs(q.y) * h.x >= abs(q.x) * h.y) L = q.y < 0.0 ? q.x + h.x : 2.0 * h.x + 2.0 * h.y + (h.x - q.x);
  else L = q.x > 0.0 ? 2.0 * h.x + (q.y + h.y) : 4.0 * h.x + 2.0 * h.y + (h.y - q.y);
  return L / (4.0 * h.x + 4.0 * h.y);
}
vec4 frameAt(float t, out float rad){
  float k = ease(seg(FOLD0, FOLD1, t));
  rad = mix(uSrcRad, uIcon.z * \${ICON_RADIUS.toFixed(3)}, k);
  return mix(uSrc, uIcon, k);
}
vec4 acc = vec4(0.0);
void shade(float d){ d = clamp(d, 0.0, 1.0); acc = vec4(acc.rgb * (1.0 - d), acc.a * (1.0 - d) + d); }
void paintPre(vec4 c, float k){ k = clamp(k, 0.0, 1.0); acc = acc * (1.0 - c.a * k) + c * k; }
void paint(vec3 c, float a){ a = clamp(a, 0.0, 1.0); acc = vec4(acc.rgb * (1.0 - a) + c * a, acc.a * (1.0 - a) + a); }
void light(vec3 c, float k){
  k = max(k, 0.0);
  float occ = min(k, 1.0) * mix(0.85, 0.3, uDark);
  acc = vec4(acc.rgb * (1.0 - occ) + c * (0.9 * occ + 0.8 * k * uDark), acc.a * (1.0 - occ) + occ);
}
vec4 sourceCopy(vec2 lp){
  vec3 bar = uLights > 1.5 ? mix(WIN_LIGHT, WIN_DARK, uDark) : mix(TITLE_LIGHT, TITLE_DARK, uDark);
  vec4 col = lp.y < uTitleH || uHasSrc < 0.5 ? vec4(bar, 1.0)
    : texture(uSrcTex, vec2(lp.x / uSrc.z, (lp.y - uTitleH) / (uSrc.w - uTitleH)));
  return col;
}
void main(){
  vec2 p = vec2(gl_FragCoord.x, uHeight - gl_FragCoord.y) / uDpr;
  float t = uT, tH = uBase + HANDOFF, tF = uBase + FLASH;
  float fadeIn = smoothstep(0.0, 60.0, t);
  float life = fadeIn * (1.0 - ease(seg(uBase + RIM_OUT - 420.0, uBase + RIM_OUT, t)));
  float k = ease(seg(FOLD0, FOLD1, t));
  float breath = 0.5 + 0.5 * sin(t * 0.0034);
  float flare = exp(-sq((t - tF) / 120.0));
  float iconOut = 1.0 - seg(tH + 40.0, tH + 320.0, t);

  float rad; vec4 R = frameAt(t, rad);
  float sd = sdR(p, R, rad);
  float inside = clamp(0.5 - sd * uDpr, 0.0, 1.0);
  float sdT = sdR(p, uTgt, uTgtRad);
  float insideT = clamp(0.5 - sdT * uDpr, 0.0, 1.0);

  shade(uDim * (1.0 - inside * (1.0 - smoothstep(0.0, 0.3, k))) * (1.0 - insideT * ease(seg(tF - 80.0, tF + 40.0, t))));

  bool atmo = t > tF - 700.0;
  float tr = t - tF, trp = max(tr, 0.0), live = step(0.0, tr);
  float pull = ease(seg(tF - 680.0, tF - 30.0, t)) * (1.0 - seg(tF - 30.0, tF + 70.0, t));
  float dOut = max(sdT, 0.0) / uScale;
  float outside = smoothstep(-1.0, 2.0, sdT);
  if (atmo) shade(0.20 * pull * exp(-dOut / 150.0) * (1.0 - smoothstep(REACH * 0.6, REACH, dOut)) * (1.0 - 0.5 * uDark));

  if (uCopy > 0.5 && t > FOLD0 - 50.0) {
    float ca = 1.0 - smoothstep(0.3, 0.85, k);
    float sh = 1.0 - smoothstep(-18.0, 42.0, sdR(p - vec2(0.0, 12.0), R, rad));
    shade(0.3 * sh * sh * (1.0 - inside) * ca * step(FOLD0 + 0.001, t));
    paintPre(sourceCopy((p - R.xy) / R.zw * uSrc.zw), inside * ca);
  }

  vec2 topC = vec2(R.x + R.z * 0.5, R.y);
  float a0 = ang(mix(uOrg, topC, k), R), a1 = ang(p, R);
  float s = abs(mod(a1 - a0 + PI, 2.0 * PI) - PI) / PI;
  vec3 rc = mix(CLAY, GOLD, 0.5 + 0.5 * sin(s * 5.0 + t * 0.0022));
  rc = mix(rc, VIO, 0.30 * (0.5 + 0.5 * sin(a1 * 2.0 - t * 0.0016)));
  vec3 pane = mix(vec3(1.0, 0.93, 0.85), rc, 0.25);

  float ia = smoothstep(0.5, 1.0, k) * iconOut * fadeIn;
  if (ia > 0.0) {
    light(rc, exp(-max(sd, 0.0) / 24.0) * 0.20 * (0.55 + 0.45 * breath) * ia * (1.0 - inside) * mix(0.5, 1.0, uDark));
    float ish = 1.0 - smoothstep(-6.0, 26.0, sdR(p - vec2(0.0, 6.0), R, rad));
    shade(0.30 * ish * ish * ia * (1.0 - inside));
    paintPre(texture(uIconTex, clamp((p - R.xy) / R.zw, 0.0, 1.0)), inside * ia * uIconA);
    paint(pane, 0.16 * inside * ia * (1.0 - uIconA));
  }

  float edgeIn = exp(min(sdT, 0.0) / (46.0 * uScale));
  float veil = 0.27 * flare * (0.35 + 0.65 * edgeIn) + 0.05 * seg(uBase + DRAW0, uBase + DRAW1, t) * (1.0 - seg(tH, tH + 300.0, t)) * edgeIn;
  paint(pane, veil * insideT * mix(1.0, 0.55, uCopy) * life);

  if (atmo && sdT > -1.0 && dOut < REACH) {
    vec2 nrm = normalize(vec2(sdR(p + vec2(1.0, 0.0), uTgt, uTgtRad) - sdR(p - vec2(1.0, 0.0), uTgt, uTgtRad),
      sdR(p + vec2(0.0, 1.0), uTgt, uTgtRad) - sdR(p - vec2(0.0, 1.0), uTgt, uTgtRad)) + 1e-5);
    vec2 pa = p / uScale + uSeed;
    float end = 1.0 - smoothstep(uBase + DONE - 420.0, uBase + DONE - 20.0, t);
    float rel = 1.0 - exp(-trp / 320.0);
    float haze = fbm(pa * 0.011 - nrm * (t * 0.00045 + rel * 1.2)) * exp(-dOut / 80.0) * outside;
    float b = haze * (0.55 * pull + exp(-sq((tr - 170.0) / 330.0)) * live) * 0.5;
    light(mix(rc, vec3(1.0, 0.92, 0.82), 0.45), b * end * fadeIn);
  }

  float head = ease(seg(0.0, TRACE1, t)) * 1.12 - 0.04;
  float lit = 1.0 - smoothstep(head - 0.03, head + 0.01, s);
  float hg = exp(-sq((s - head) / 0.07)) * (1.0 - seg(TRACE1, TRACE1 + 160.0, t));
  float holdK = seg(FOLD1 - 250.0, FOLD1 + 250.0, t);
  float gather = seg(uBase - 60.0, uBase + 260.0, t);
  float phase = t * 0.00022 + 0.55 * gather * gather;
  float a01 = a1 / (2.0 * PI);
  float hi = exp(-sq(circ(a01, phase) / 0.085)) + exp(-sq(circ(a01, phase + 0.5) / 0.085));
  float level = lit * (0.62 - 0.26 * holdK + 0.10 * breath * holdK) + hg * 1.1 + hi * 0.72 * holdK;
  float a = rim(sd) * level * life * iconOut;

  float sT = perim(p, uTgt);
  float hdT = ease(seg(uBase + DRAW0, uBase + DRAW1, t)) * 1.08 - 0.04;
  float litT = 1.0 - smoothstep(hdT - 0.014, hdT + 0.004, sT);
  float tail = exp(-max(hdT - sT, 0.0) / 0.22);
  float hgT = exp(-sq((sT - hdT) / 0.03)) * seg(uBase + DRAW0, uBase + DRAW0 + 80.0, t) * (1.0 - seg(tH - 110.0, tH - 10.0, t));
  float lvT = litT * (0.34 + 0.5 * tail * (1.0 - seg(tH - 140.0, tH, t)) + 0.22 * seg(tH - 140.0, tH, t)) + hgT * 1.3 + flare * 1.15 * litT;
  a += (rim(sdT) * lvT + exp(-abs(sdT) / 30.0) * 0.34 * flare) * life;

  light(rc, a);
  o = acc;
}\`;

const canvas = document.getElementById("c");
let gl = null;
let uniforms = null;
let blank = null;
let run = null;

function createProgram() {
  const program = gl.createProgram();
  for (const [type, source] of [
    [gl.VERTEX_SHADER, VERTEX_SHADER],
    [gl.FRAGMENT_SHADER, FRAGMENT_SHADER],
  ]) {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, source);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS))
      throw new Error("shader compile failed: " + gl.getShaderInfoLog(shader));
    gl.attachShader(program, shader);
  }
  gl.linkProgram(program);
  if (!gl.getProgramParameter(program, gl.LINK_STATUS))
    throw new Error("link failed: " + gl.getProgramInfoLog(program));
  return program;
}

function createTexture(source) {
  const texture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, texture);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA, gl.RGBA, gl.UNSIGNED_BYTE, source);
  gl.generateMipmap(gl.TEXTURE_2D);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR_MIPMAP_LINEAR);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
  return texture;
}

async function decode(dataUrl) {
  const image = new Image();
  image.src = dataUrl;
  await image.decode();
  return image;
}

const sized = (r) => ({ ...r, w: Math.max(2, r.w), h: Math.max(2, r.h) });

function clearCanvas(alpha) {
  gl.clearColor(0, 0, 0, alpha);
  gl.clear(gl.COLOR_BUFFER_BIT);
}

function draw(r) {
  const { params, src, tgt, base, t } = r;
  const dpr = params.devicePixelRatio || 1;
  const w = Math.round(window.innerWidth * dpr);
  const h = Math.round(window.innerHeight * dpr);
  if (canvas.width !== w) canvas.width = w;
  if (canvas.height !== h) canvas.height = h;
  gl.viewport(0, 0, w, h);

  const iconPx = Math.min(ICON_PX, 0.4 * Math.min(tgt.w, tgt.h));
  const icon = {
    x: tgt.x + tgt.w / 2 - iconPx / 2,
    y: tgt.y + tgt.h / 2 - iconPx / 2,
    w: iconPx,
    h: iconPx,
  };
  const origin = params.traceOrigin ?? { x: src.x + Math.max(src.w - 60, src.w / 2), y: src.y };
  const scale = clamp(Math.sqrt(tgt.w * tgt.h) / ATMO_REF, 1, ATMO_MAX_SCALE);
  const dim = DIM * smoothstep(0, DIM_IN_MS, t) * (1 - smoothstep(base + DIM_OUT_MS[0], base + DIM_OUT_MS[1], t));
  const xywh = (rect) => [rect.x, rect.y, rect.w, rect.h];
  const values = {
    uHeight: [h],
    uDpr: [dpr],
    uT: [t],
    uBase: [base],
    uSrc: xywh(src),
    uTgt: xywh(tgt),
    uIcon: xywh(icon),
    uOrg: [origin.x, origin.y],
    uSrcRad: [params.sourceCornerRadius ?? params.cornerRadius],
    uTgtRad: [params.cornerRadius],
    uDark: [params.colorScheme === "dark" ? 1 : 0],
    uCopy: [params.sourceIsWindow ? 1 : 0],
    uHasSrc: [r.srcTexture ? 1 : 0],
    uIconA: [r.iconTexture ? smoothstep(r.iconAt, r.iconAt + ICON_FADE_MS, r.wall) : 0],
    uDim: [dim],
    uScale: [scale],
    uSeed: [params.seed % 977, (params.seed >>> 10) % 983],
    uTitleH: [params.sourceTitleBar?.height ?? 0],
    uLights: [{ active: 1, windows: 2 }[params.sourceTitleBar?.lights] ?? 0],
  };
  for (const [name, v] of Object.entries(values)) gl[\`uniform\${v.length}f\`](uniforms[name], ...v);
  gl.activeTexture(gl.TEXTURE0);
  gl.bindTexture(gl.TEXTURE_2D, r.srcTexture ?? blank);
  gl.activeTexture(gl.TEXTURE1);
  gl.bindTexture(gl.TEXTURE_2D, r.iconTexture ?? blank);
  clearCanvas(dim);
  const known = base !== NOT_YET;
  const boxes = [icon];
  if (known) boxes.push(tgt);
  if (t < TIMELINE.fold1 + FOLD_TAIL_MS) boxes.push(src);
  const reach = known ? REACH * scale : RIM_REACH;
  const x0 = Math.min(...boxes.map((b) => b.x)) - reach;
  const y0 = Math.min(...boxes.map((b) => b.y)) - reach;
  const x1 = Math.max(...boxes.map((b) => b.x + b.w)) + reach;
  const y1 = Math.max(...boxes.map((b) => b.y + b.h)) + reach;
  const left = clamp(Math.floor(x0 * dpr), 0, w);
  const right = clamp(Math.ceil(x1 * dpr), 0, w);
  const bottom = clamp(Math.floor(h - y1 * dpr), 0, h);
  const top = clamp(Math.ceil(h - y0 * dpr), 0, h);
  gl.enable(gl.SCISSOR_TEST);
  gl.scissor(left, bottom, right - left, top - bottom);
  gl.drawArrays(gl.TRIANGLES, 0, 3);
  gl.disable(gl.SCISSOR_TEST);
}

let queue = [];
let waiter = null;
function send(event) {
  if (waiter) {
    waiter(event);
    waiter = null;
  } else {
    queue.push(event);
  }
}

function stop() {
  if (!run) return;
  if (run.srcTexture) gl.deleteTexture(run.srcTexture);
  if (run.iconTexture) gl.deleteTexture(run.iconTexture);
  run = null;
  clearCanvas(0);
}

function play(mine) {
  let frames = 0;
  let sent = 0;
  let hold = null;
  let last = null;
  const tick = (wall) => {
    if (run !== mine) return;
    try {
      if (gl.isContextLost()) throw new Error("the WebGL context is lost");
      if (last !== null) {
        frames += 1;
        mine.wall += wall - last;
        if (!hold) mine.t += wall - last;
      }
      last = wall;
      if (hold && (mine.acks.has(hold.name) || wall - hold.since > HOLDS[hold.name])) hold = null;
      const name = EVENTS[sent];
      const at = name === "source-covered" ? TIMELINE.cover : mine.base + TIMELINE[name];
      if (name in HOLDS) mine.t = Math.min(mine.t, at);
      draw(mine);
      if (mine.t >= at && (name !== "source-covered" || frames >= 2)) {
        sent += 1;
        if (name === "done") {
          send({ name });
          stop();
          return;
        }
        send({ name });
        if (name in HOLDS) hold = { name, since: wall };
      }
    } catch {
      send({ name: "error" });
      stop();
      return;
    }
    requestAnimationFrame(tick);
  };
  requestAnimationFrame(tick);
}

window.mz = {
  warm() {
    gl = canvas.getContext("webgl2", {
      alpha: true,
      premultipliedAlpha: true,
      antialias: false,
      depth: false,
      stencil: false,
      powerPreference: "default",
    });
    if (!gl) return { webgl2: false };
    const program = createProgram();
    gl.useProgram(program);
    uniforms = {};
    const count = gl.getProgramParameter(program, gl.ACTIVE_UNIFORMS);
    for (let i = 0; i < count; i += 1) {
      const { name } = gl.getActiveUniform(program, i);
      uniforms[name] = gl.getUniformLocation(program, name);
    }
    gl.uniform1i(uniforms.uSrcTex, 0);
    gl.uniform1i(uniforms.uIconTex, 1);
    gl.pixelStorei(gl.UNPACK_PREMULTIPLY_ALPHA_WEBGL, true);
    gl.pixelStorei(gl.UNPACK_COLORSPACE_CONVERSION_WEBGL, gl.NONE);
    blank = createTexture(new ImageData(1, 1));
    const rect = { x: 10, y: 10, w: 60, h: 60 };
    for (const t of [40, 700, TIMELINE.fold1 + TIMELINE.flash]) {
      draw({ params: { cornerRadius: 10, devicePixelRatio: 1, seed: 1 }, src: rect, tgt: rect, base: TIMELINE.fold1, t });
    }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
    clearCanvas(0);
    return { webgl2: true };
  },
  async start({ sourceImage, ...params }) {
    if (!gl || gl.isContextLost()) throw new Error("the WebGL context is lost");
    const image = sourceImage ? await decode(sourceImage) : null;
    mz.clear();
    run = {
      params,
      src: sized(params.sourceRect),
      tgt: sized(params.expectedTargetRect),
      base: NOT_YET,
      t: 0,
      wall: 0,
      acks: new Set(),
      srcTexture: image && createTexture(image),
      iconTexture: null,
      iconAt: 0,
    };
    play(run);
  },
  next() {
    if (queue.length > 0) return Promise.resolve(queue.shift());
    return new Promise((resolve) => { waiter = resolve; });
  },
  ackSource() { run?.acks.add("source-covered"); },
  ackHandoff() { run?.acks.add("handoff"); },
  setTarget({ rect }) {
    if (!run || run.base !== NOT_YET) return;
    run.tgt = sized(rect);
    run.base = Math.max(run.t, TIMELINE.fold1);
  },
  async setIcon(dataUrl) {
    const mine = run;
    if (!dataUrl) return;
    const image = await decode(dataUrl);
    if (!mine || run !== mine) return;
    mine.iconTexture = createTexture(image);
    mine.iconAt = mine.wall;
  },
  clear() {
    stop();
    queue = [];
    waiter?.({ name: "reset" });
    waiter = null;
  },
};
</script></body></html>`;

let overlayPromise: Promise<{ win: BrowserWindowType; webgl2: boolean } | null> | null = null;
let overlayWin: BrowserWindowType | null = null;
let idleTimer: ReturnType<typeof setTimeout> | null = null;
let activeController: MaterializeController | null = null;

function prefersReducedMotion(): boolean {
  if (process.env.MOSS_APPS_DISABLE_MATERIALIZE === "1") return true;
  try {
    const sp = systemPreferences as unknown as {
      getAnimationSettings?: () => { shouldRenderRichAnimation?: boolean };
    };
    const settings = sp?.getAnimationSettings?.();
    if (settings && settings.shouldRenderRichAnimation === false) {
      return true;
    }
  } catch {
    // Ignore on platforms without animation settings.
  }
  return false;
}

function scheduleIdleDestroy(): void {
  if (idleTimer) clearTimeout(idleTimer);
  idleTimer = setTimeout(() => {
    if (!activeController) {
      disposeMaterializeOverlay();
    }
  }, IDLE_DESTROY_MS);
  idleTimer.unref?.();
}

export function disposeMaterializeOverlay(): void {
  if (idleTimer) {
    clearTimeout(idleTimer);
    idleTimer = null;
  }
  const win = overlayWin;
  overlayWin = null;
  overlayPromise = null;
  if (win && !win.isDestroyed()) {
    try {
      win.destroy();
    } catch {
      // Ignore cleanup errors.
    }
  }
}

function runJsWithTimeout<T>(
  win: BrowserWindowType,
  script: string,
  timeoutMs = WARM_TIMEOUT_MS,
): Promise<T> {
  if (win.isDestroyed()) return Promise.reject(new Error("overlay destroyed"));
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      reject(new Error("overlay call timed out"));
    }, timeoutMs);
    win.webContents
      .executeJavaScript(script)
      .then((value) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(value as T);
      })
      .catch((err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      });
  });
}

async function createAndWarmOverlay(): Promise<{ win: BrowserWindowType; webgl2: boolean } | null> {
  if (typeof BrowserWindow !== "function") return null;
  try {
    const win = new BrowserWindow({
      show: false,
      title: "",
      transparent: true,
      frame: false,
      roundedCorners: false,
      hasShadow: false,
      focusable: false,
      skipTaskbar: true,
      movable: false,
      resizable: false,
      minimizable: false,
      maximizable: false,
      fullscreenable: false,
      enableLargerThanScreen: true,
      backgroundColor: "#00000000",
      webPreferences: {
        sandbox: true,
        contextIsolation: true,
        nodeIntegration: false,
        devTools: false,
        spellcheck: false,
        backgroundThrottling: false,
        partition: PAGE_APP_MATERIALIZE_PARTITION,
      },
    });
    overlayWin = win;
    win.setAlwaysOnTop(true, "screen-saver");
    win.setIgnoreMouseEvents(true);
    win.webContents.setWindowOpenHandler(() => ({ action: "deny" }));
    win.webContents.on("will-navigate", (event) => event.preventDefault());
    win.webContents.on("render-process-gone", () => {
      activeController?.revealNow("render-process-gone");
      disposeMaterializeOverlay();
    });
    win.on("closed", () => {
      if (overlayWin === win) {
        overlayWin = null;
        overlayPromise = null;
      }
      activeController?.revealNow("overlay-closed");
    });

    const dataUrl = `data:text/html;base64,${Buffer.from(OVERLAY_HTML, "utf8").toString("base64")}`;
    await Promise.race([
      win.loadURL(dataUrl),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error("overlay load timed out")), WARM_TIMEOUT_MS),
      ),
    ]);
    const warmResult = await runJsWithTimeout<{ webgl2?: boolean }>(
      win,
      "window.mz && window.mz.warm()",
      WARM_TIMEOUT_MS,
    );
    return { win, webgl2: Boolean(warmResult?.webgl2) };
  } catch {
    disposeMaterializeOverlay();
    return null;
  }
}

export function warmMaterializeOverlay(): void {
  if (activeController || prefersReducedMotion()) return;
  overlayPromise ??= createAndWarmOverlay();
  scheduleIdleDestroy();
}

function fadeWindowOpacity(
  win: BrowserWindowType,
  durationMs: number,
  isCancelled: () => boolean,
): void {
  const startedAt = Date.now();
  const step = () => {
    if (win.isDestroyed() || isCancelled()) return;
    const progress = Math.min(1, (Date.now() - startedAt) / durationMs);
    try {
      win.setOpacity(progress);
    } catch {
      return;
    }
    if (progress < 1) {
      setTimeout(step, 16);
    }
  };
  step();
}

function createDeferred<T>(): {
  readonly promise: Promise<T>;
  readonly resolve: (value: T | PromiseLike<T>) => void;
  readonly reject: (reason?: unknown) => void;
} {
  let resolve!: (value: T | PromiseLike<T>) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

function setActiveController(controller: MaterializeController | null): void {
  activeController = controller;
}

class MaterializeController {
  private readonly opts: StartMaterializeOptions;
  private ended = false;
  private effectActive = false;
  private started = false;
  private wantTarget = false;
  private covered = false;
  private layered = false;
  private targetSent = false;
  private overlay: BrowserWindowType | null = null;
  private readonly timers = new Set<ReturnType<typeof setTimeout>>();
  readonly finishedDeferred = createDeferred<void>();
  readonly sourceCoveredDeferred = createDeferred<boolean>();

  constructor(opts: StartMaterializeOptions) {
    this.opts = opts;
  }

  private after(ms: number, fn: () => void): void {
    const timer = setTimeout(() => {
      this.timers.delete(timer);
      fn();
    }, ms);
    this.timers.add(timer);
  }

  private onWindowClosed = () => {
    this.revealNow("target-closed");
  };

  begin(): void {
    this.after(EVENT_TIMEOUT_MS, () => this.revealNow("deadline"));
    const target = this.opts.targetWindow;
    if (target.isDestroyed()) {
      this.revealNow("target-destroyed");
      return;
    }
    target.once("closed", this.onWindowClosed);

    const skipReason = this.getPlainSkipReason();
    if (skipReason) {
      this.sourceCoveredDeferred.resolve(false);
      return;
    }

    this.effectActive = true;
    setActiveController(this);
    if (!this.opts.hiddenTarget) {
      this.setTargetOpacity(1);
    }
    this.after(EFFECT_HARD_TIMEOUT_MS, () => this.reveal());
    void this.play().catch(() => this.revealNow("play-failed"));
  }

  private getPlainSkipReason(): string | null {
    if (activeController) return "already-running";
    if (prefersReducedMotion()) return "reduced-motion";
    const target = this.opts.targetWindow;
    if (target.isFullScreen() || target.isMinimized()) return "fullscreen-or-minimized";
    const host = this.opts.hostWindow;
    if (host && !host.isDestroyed() && host.isFullScreen()) return "host-fullscreen";
    if (!this.opts.hiddenTarget && !target.isVisible()) return "not-visible";
    return null;
  }

  private setTargetOpacity(opacity: number): void {
    this.layered = true;
    try {
      if (!this.opts.targetWindow.isDestroyed()) {
        this.opts.targetWindow.setOpacity(opacity);
      }
    } catch {
      // Ignore platforms without opacity support.
    }
  }

  private async play(): Promise<void> {
    overlayPromise ??= createAndWarmOverlay();
    const warmed = await overlayPromise.catch(() => null);
    if (this.ended) return;
    if (idleTimer) {
      clearTimeout(idleTimer);
      idleTimer = null;
    }
    if (!warmed || warmed.win.isDestroyed() || !warmed.webgl2) {
      this.goPlain();
      return;
    }

    const target = this.opts.targetWindow;
    if (target.isDestroyed()) {
      this.revealNow("target-closed");
      return;
    }

    const targetBounds = target.getBounds();
    const display = screen.getDisplayMatching(targetBounds);
    const workArea = display.workArea;
    const overlayBounds = {
      x: workArea.x,
      y: workArea.y,
      width: workArea.width,
      height:
        workArea.height -
        (workArea.width === targetBounds.width && workArea.height === targetBounds.height ? 1 : 0),
    };
    const srcBounds = this.opts.sourceRect ?? targetBounds;

    this.overlay = warmed.win;
    warmed.win.setBounds(overlayBounds);
    warmed.win.setIgnoreMouseEvents(true);
    await runJsWithTimeout(warmed.win, "window.mz.clear()");
    if (this.ended) return;

    warmed.win.showInactive();

    const toLocal = (r: MaterializeRect) => ({
      x: r.x - overlayBounds.x,
      y: r.y - overlayBounds.y,
      w: r.width,
      h: r.height,
    });

    const startParams = {
      sourceRect: toLocal(srcBounds),
      expectedTargetRect: toLocal(targetBounds),
      sourceImage: this.opts.sourceImageDataUrl ?? undefined,
      sourceIsWindow: !this.opts.sourceRect && Boolean(this.opts.sourceImageDataUrl),
      cornerRadius: this.opts.cornerRadius ?? 8,
      sourceCornerRadius: this.opts.sourceRect ? 0 : undefined,
      devicePixelRatio: display.scaleFactor || 1,
      colorScheme: nativeTheme.shouldUseDarkColors ? "dark" : "light",
      seed: Math.floor(Math.random() * 2 ** 31),
    };

    await runJsWithTimeout(warmed.win, `window.mz.start(${JSON.stringify(startParams)})`);
    if (this.ended) {
      void runJsWithTimeout(warmed.win, "window.mz.clear()").catch(() => undefined);
      return;
    }

    this.started = true;
    void this.sendIcon(warmed.win);
    this.sendTargetIfWanted();
    void this.pump(warmed.win);
  }

  private async sendIcon(win: BrowserWindowType): Promise<void> {
    const icon = await Promise.resolve(this.opts.iconDataUrl).catch(() => null);
    if (!icon || this.ended || win.isDestroyed()) return;
    void runJsWithTimeout(win, `window.mz.setIcon(${JSON.stringify(icon)})`).catch(() => undefined);
  }

  private async pump(win: BrowserWindowType): Promise<void> {
    while (!this.ended && !win.isDestroyed()) {
      let evt: { name?: string } | null = null;
      try {
        evt = await runJsWithTimeout<{ name?: string }>(win, "window.mz.next()", EVENT_TIMEOUT_MS);
      } catch {
        this.revealNow("overlay-timeout");
        return;
      }
      if (this.ended) return;
      this.handleEvent(win, evt?.name ?? "unknown");
    }
  }

  private handleEvent(win: BrowserWindowType, name: string): void {
    const target = this.opts.targetWindow;
    switch (name) {
      case "source-covered":
        this.after(SOURCE_COVERED_HOLD_MS, () => {
          this.covered = true;
          if (!this.opts.hiddenTarget && !target.isDestroyed()) {
            this.setTargetOpacity(0);
          }
          this.sourceCoveredDeferred.resolve(true);
          this.opts.onSourceCovered?.();
          void runJsWithTimeout(win, "window.mz.ackSource()").catch(() => undefined);
        });
        return;
      case "handoff":
        if (target.isDestroyed()) {
          this.revealNow("target-closed");
          return;
        }
        fadeWindowOpacity(target, WINDOW_FADE_MS, () => this.ended);
        void runJsWithTimeout(win, "window.mz.ackHandoff()").catch(() => undefined);
        return;
      case "focus":
        if (!target.isDestroyed() && BrowserWindow.getFocusedWindow() !== null) {
          target.focus();
        }
        return;
      case "done":
        this.revealNow();
        return;
      default:
        this.revealNow(name);
    }
  }

  private goPlain(): void {
    this.effectActive = false;
    if (activeController === this) {
      activeController = null;
      scheduleIdleDestroy();
    }
    if (!this.opts.hiddenTarget && !this.opts.targetWindow.isDestroyed()) {
      this.setTargetOpacity(1);
    }
    this.sourceCoveredDeferred.resolve(false);
    if (this.wantTarget) {
      this.revealNow();
    }
  }

  reveal(): void {
    if (this.ended) return;
    this.wantTarget = true;
    if (!this.effectActive) {
      const target = this.opts.targetWindow;
      if (this.opts.hiddenTarget && !target.isDestroyed() && !target.isVisible()) {
        this.opts.onRevealTarget?.();
        target.showInactive();
        if (!target.isDestroyed() && BrowserWindow.getFocusedWindow?.() !== null) {
          target.focus();
        }
      }
      this.revealNow();
      return;
    }
    this.sendTargetIfWanted();
  }

  private sendTargetIfWanted(): void {
    if (!this.started || !this.wantTarget || this.targetSent || this.ended) return;
    const target = this.opts.targetWindow;
    const overlay = this.overlay;
    if (target.isDestroyed() || !overlay || overlay.isDestroyed()) {
      this.revealNow("closed");
      return;
    }
    this.targetSent = true;
    if (this.opts.hiddenTarget && !target.isVisible()) {
      this.setTargetOpacity(0);
      this.opts.onRevealTarget?.();
      target.showInactive();
    }
    const tb = target.getBounds();
    const ob = overlay.getBounds();
    const rect = { x: tb.x - ob.x, y: tb.y - ob.y, w: tb.width, h: tb.height };
    void runJsWithTimeout(overlay, `window.mz.setTarget(${JSON.stringify({ rect })})`).catch(
      () => undefined,
    );
    this.after(TARGET_STALL_TIMEOUT_MS, () => this.revealNow("target-stall"));
  }

  revealNow(earlyReason?: string): void {
    if (this.ended) return;
    this.ended = true;
    for (const timer of this.timers) clearTimeout(timer);
    this.timers.clear();

    const target = this.opts.targetWindow;
    if (!target.isDestroyed()) {
      target.removeListener("closed", this.onWindowClosed);
      if (this.layered) {
        try {
          target.setOpacity(1);
        } catch {
          // Ignore.
        }
      }
      if (!target.isVisible() && (!this.opts.hiddenTarget || this.wantTarget || this.covered)) {
        this.opts.onRevealTarget?.();
        target.showInactive();
        if (BrowserWindow.getFocusedWindow?.() !== null) {
          target.focus();
        }
      }
    }

    if (this.overlay && !this.overlay.isDestroyed()) {
      if (earlyReason && this.overlay === overlayWin) {
        disposeMaterializeOverlay();
      } else {
        try {
          this.overlay.hide();
        } catch {
          // Ignore.
        }
        void runJsWithTimeout(this.overlay, "window.mz.clear()").catch(() => undefined);
      }
    }

    if (activeController === this) {
      activeController = null;
      scheduleIdleDestroy();
    }
    this.sourceCoveredDeferred.resolve(false);
    this.finishedDeferred.resolve();
  }
}

/**
 * Starts the WebGL2 install materialization effect if supported, or returns a handle that
 * degrades cleanly to plain reveal on headless/Reduce-Motion/no-WebGL2 environments.
 */
export function startInstallMaterializeEffect(options: StartMaterializeOptions): MaterializeHandle {
  const controller = new MaterializeController(options);
  controller.begin();
  return {
    reveal: () => controller.reveal(),
    cancel: (reason?: string) => controller.revealNow(reason ?? "cancelled"),
    finished: controller.finishedDeferred.promise,
    sourceCovered: controller.sourceCoveredDeferred.promise,
  };
}
