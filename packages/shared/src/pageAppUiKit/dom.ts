// FILE: dom.ts
// Purpose: SSR-safe Shadow DOM and SVG helpers for Moss UI Kit components.
// Layer: Shared Page App UI Kit

import { MOSS_UI_KIT_BASE_SHADOW_CSS } from "./tokens";

export const BaseHtmlElement: typeof HTMLElement =
  typeof HTMLElement === "function" ? HTMLElement : (class {} as typeof HTMLElement);

const SVG_NS = "http://www.w3.org/2000/svg";

export function createMossMarkSvg(size = 14): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 16 16");
  svg.setAttribute("fill", "none");
  svg.setAttribute("aria-hidden", "true");
  const path = document.createElementNS(SVG_NS, "path");
  path.setAttribute(
    "d",
    "M8 1.5c1.1 0 2 .9 2 2v2.4l1.7-1.7a2 2 0 1 1 2.8 2.8L12.8 8.7H15a2 2 0 1 1 0 4h-2.4l1.7 1.7a2 2 0 1 1-2.8 2.8L9.8 15.5c-.6.3-1.2.5-1.8.5s-1.2-.2-1.8-.5l-1.7 1.7a2 2 0 1 1-2.8-2.8L3.4 12.7H1a2 2 0 1 1 0-4h2.2L1.5 7a2 2 0 1 1 2.8-2.8L6 5.9V3.5c0-1.1.9-2 2-2Z",
  );
  path.setAttribute("fill", "var(--moss-coral)");
  svg.appendChild(path);
  return svg;
}

export function createMicSvg(size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const rect = document.createElementNS(SVG_NS, "rect");
  rect.setAttribute("x", "9");
  rect.setAttribute("y", "2");
  rect.setAttribute("width", "6");
  rect.setAttribute("height", "12");
  rect.setAttribute("rx", "3");

  const arc = document.createElementNS(SVG_NS, "path");
  arc.setAttribute("d", "M5 10v2a7 7 0 0 0 14 0v-2");

  const stem = document.createElementNS(SVG_NS, "path");
  stem.setAttribute("d", "M12 19v3");

  svg.appendChild(rect);
  svg.appendChild(arc);
  svg.appendChild(stem);
  return svg;
}

export function createSpeakerSvg(size = 15): SVGSVGElement {
  const svg = document.createElementNS(SVG_NS, "svg");
  svg.setAttribute("width", String(size));
  svg.setAttribute("height", String(size));
  svg.setAttribute("viewBox", "0 0 24 24");
  svg.setAttribute("fill", "none");
  svg.setAttribute("stroke", "currentColor");
  svg.setAttribute("stroke-width", "1.9");
  svg.setAttribute("stroke-linecap", "round");
  svg.setAttribute("stroke-linejoin", "round");
  svg.setAttribute("aria-hidden", "true");

  const cone = document.createElementNS(SVG_NS, "polygon");
  cone.setAttribute("points", "11 5 6 9 2 9 2 15 6 15 11 19 11 5");
  const wave1 = document.createElementNS(SVG_NS, "path");
  wave1.setAttribute("d", "M15.54 8.46a5 5 0 0 1 0 7.07");
  const wave2 = document.createElementNS(SVG_NS, "path");
  wave2.setAttribute("d", "M19.07 4.93a10 10 0 0 1 0 14.14");

  svg.appendChild(cone);
  svg.appendChild(wave1);
  svg.appendChild(wave2);
  return svg;
}

export function createRealtimeVoiceBarsIcon(busy = false): HTMLSpanElement {
  const wrap = document.createElement("span");
  wrap.setAttribute("aria-hidden", "true");
  wrap.setAttribute("data-moss-realtime-voice-bars-icon", "true");
  wrap.style.display = "inline-flex";
  wrap.style.width = "16px";
  wrap.style.height = "16px";
  wrap.style.alignItems = "center";
  wrap.style.justifyContent = "center";
  wrap.style.gap = "1.2px";
  if (busy) {
    wrap.style.opacity = "0.75";
  }
  for (const h of [4.15, 12.17, 6.83, 9.5, 4.15]) {
    const bar = document.createElement("span");
    bar.style.display = "block";
    bar.style.width = "1.5px";
    bar.style.height = `${h}px`;
    bar.style.borderRadius = "999px";
    bar.style.backgroundColor = "currentColor";
    wrap.appendChild(bar);
  }
  return wrap;
}

export function createShadowHost(el: HTMLElement, extraCss: string): ShadowRoot {
  const shadow = el.shadowRoot ?? el.attachShadow({ mode: "open" });
  shadow.textContent = "";
  const style = document.createElement("style");
  style.textContent = `${MOSS_UI_KIT_BASE_SHADOW_CSS}\n${extraCss}`;
  shadow.appendChild(style);
  return shadow;
}
