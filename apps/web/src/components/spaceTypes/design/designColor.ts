// FILE: designColor.ts
// Purpose: Text contrast in the 设计 inspector: the colour a text element is drawn in, the colour
//          behind it (the nearest painted ancestor, or the artboard paper), and their WCAG ratio
//          with a plain verdict.
// Layer: 资料空间 设计 (web)
// Why: A colour field should say whether text stays readable. Any CSS colour (oklch, var(), hex)
//      is first painted on a 1×1 canvas, so the ratio comes from the exact pixels shown.

export interface Rgba {
  readonly r: number;
  readonly g: number;
  readonly b: number;
  readonly a: number;
}

let probe: CanvasRenderingContext2D | null = null;

/** Any computed CSS colour as sRGB 0–255 with alpha 0–1, or null when it is not a colour. */
export function parseCssColor(color: string): Rgba | null {
  if (!color || color === "transparent") return { r: 0, g: 0, b: 0, a: 0 };
  probe ??= (() => {
    const canvas = window.document.createElement("canvas");
    canvas.width = 1;
    canvas.height = 1;
    return canvas.getContext("2d", { willReadFrequently: true });
  })();
  if (!probe) return null;
  probe.clearRect(0, 0, 1, 1);
  probe.fillStyle = "rgba(0, 0, 0, 0)";
  probe.fillStyle = color;
  probe.fillRect(0, 0, 1, 1);
  const [r, g, b, a] = probe.getImageData(0, 0, 1, 1).data;
  return { r: r!, g: g!, b: b!, a: (a ?? 0) / 255 };
}

/** `top` drawn over `bottom`. */
function over(top: Rgba, bottom: Rgba): Rgba {
  const a = top.a + bottom.a * (1 - top.a);
  if (a === 0) return { r: 0, g: 0, b: 0, a: 0 };
  const mix = (t: number, b: number) => (t * top.a + b * bottom.a * (1 - top.a)) / a;
  return { r: mix(top.r, bottom.r), g: mix(top.g, bottom.g), b: mix(top.b, bottom.b), a };
}

function luminance(color: Rgba): number {
  const channel = (value: number) => {
    const c = value / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * channel(color.r) + 0.7152 * channel(color.g) + 0.0722 * channel(color.b);
}

export function contrastRatio(foreground: Rgba, background: Rgba): number {
  const ground = background.a < 1 ? over(background, { r: 255, g: 255, b: 255, a: 1 }) : background;
  const ink = foreground.a < 1 ? over(foreground, ground) : foreground;
  const a = luminance(ink);
  const b = luminance(ground);
  return (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
}

/** The colour behind an element: its painted ancestors layered down to the page paper. */
export function backgroundBehind(element: Element): Rgba {
  const view = element.ownerDocument.defaultView;
  const layers: Rgba[] = [];
  let node: Element | null = element;
  while (node && view) {
    const color = parseCssColor(view.getComputedStyle(node).backgroundColor);
    if (color && color.a > 0) {
      layers.push(color);
      if (color.a >= 1) break;
    }
    node = node.parentElement;
  }
  let ground: Rgba = { r: 255, g: 255, b: 255, a: 1 };
  for (const layer of layers.reverse()) ground = over(layer, ground);
  return ground;
}

export interface ContrastReadout {
  readonly ratio: number;
  readonly verdict: "good" | "large-only" | "low";
  readonly label: string;
}

/** The text element's contrast against what is behind it, as the inspector shows it. */
export function textContrast(element: HTMLElement): ContrastReadout | null {
  const view = element.ownerDocument.defaultView;
  if (!view) return null;
  const style = view.getComputedStyle(element);
  const ink = parseCssColor(style.color);
  if (!ink) return null;
  const ratio = contrastRatio(ink, backgroundBehind(element));
  const size = Number.parseFloat(style.fontSize) || 16;
  const bold = Number(style.fontWeight) >= 600;
  const large = size >= 24 || (bold && size >= 18.66);
  const verdict = ratio >= 4.5 ? "good" : ratio >= 3 && large ? "large-only" : "low";
  const shown = Math.floor(ratio * 10) / 10;
  return {
    ratio,
    verdict,
    label:
      verdict === "good"
        ? `对比度 ${shown}，清楚`
        : verdict === "large-only"
          ? `对比度 ${shown}，只适合大字`
          : `对比度 ${shown}，偏低，不易看清`,
  };
}
