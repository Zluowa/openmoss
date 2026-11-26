// FILE: mossbotPinwheel.ts
// Purpose: The Moss mark as pixels: rasterizes its pinwheel at any odd size and any turn, for the kid's head and
//          its small icons.
// Layer: Pure drawing math (no DOM).
// Exports: mossbotPinwheelPixels, PinwheelPixel.

/** A pixel of the pinwheel, as [dx, dy] from its centre pixel and the coral it shows ("C" light, "D" dark). */
export type PinwheelPixel = readonly [dx: number, dy: number, colour: "C" | "D"];

// In the mark's own units (a 95-unit square centred on 0,0, y pointing down) the top-left blade is the right triangle
// (0,0) – (0,-47.5) – (-47.5,-47.5). Its half along the outer edge is the light coral, its half along the centre line
// the dark coral; the other three blades are the same triangle turned clockwise by 90°, 180° and 270°.
//
// Each blade is drawn at 85% about its own centre, so the four blades stay apart at pixel size. Without that gap the
// dark halves join into a cross in the middle and the shape stops reading as the Moss mark.
const SHRINK = 0.85;
const SUPERSAMPLE = 4;
const BLADE_CENTRE_X = -47.5 / 3;
const BLADE_CENTRE_Y = -95 / 3;

function sampleMark(x: number, y: number): "C" | "D" | null {
  let px = x;
  let py = y;
  for (let blade = 0; blade < 4; blade++) {
    const ux = BLADE_CENTRE_X + (px - BLADE_CENTRE_X) / SHRINK;
    const uy = BLADE_CENTRE_Y + (py - BLADE_CENTRE_Y) / SHRINK;
    if (ux <= 0 && uy <= 0 && uy <= ux && ux >= -47.5 && uy >= -47.5) {
      return -ux < uy + 47.5 ? "D" : "C";
    }
    // Turn the point a quarter counter-clockwise to test it against the next blade.
    const turned = py;
    py = -px;
    px = turned;
  }
  return null;
}

const cache = new Map<string, readonly PinwheelPixel[]>();

/**
 * The pinwheel `size` pixels across (odd), turned clockwise by `angle` degrees. A pixel is filled when at least half of
 * it is covered, in the colour covering more of it. The mark repeats every quarter turn, so angles are taken modulo 90
 * and rounded to whole degrees; results are cached.
 */
export function mossbotPinwheelPixels(angle: number, size: number): readonly PinwheelPixel[] {
  const turn = (((Math.round(angle) % 90) + 90) % 90) as number;
  const key = `${size}:${turn}`;
  const cached = cache.get(key);
  if (cached) return cached;
  const radians = (turn * Math.PI) / 180;
  const cos = Math.cos(radians);
  const sin = Math.sin(radians);
  // A little wider than `size`, so a turning blade's tip is not clipped.
  const window = size + 4;
  const half = (window - 1) / 2;
  const unitsPerPixel = 95 / size;
  const pixels: PinwheelPixel[] = [];
  for (let j = 0; j < window; j++) {
    for (let i = 0; i < window; i++) {
      let light = 0;
      let dark = 0;
      for (let a = 0; a < SUPERSAMPLE; a++) {
        for (let b = 0; b < SUPERSAMPLE; b++) {
          const x = (i - half - 0.5 + (a + 0.5) / SUPERSAMPLE) * unitsPerPixel;
          const y = (j - half - 0.5 + (b + 0.5) / SUPERSAMPLE) * unitsPerPixel;
          // Undo the turn to find which part of the still mark this point shows.
          const colour = sampleMark(x * cos + y * sin, -x * sin + y * cos);
          if (colour === "C") light++;
          else if (colour === "D") dark++;
        }
      }
      if ((light + dark) * 2 >= SUPERSAMPLE * SUPERSAMPLE) {
        pixels.push([i - half, j - half, dark >= light ? "D" : "C"]);
      }
    }
  }
  cache.set(key, pixels);
  return pixels;
}
