// FILE: mossLogoPath.ts
// Purpose: The Moss mark as a vector, for pages that do not serve `public/moss-logo-coral.png`
//          (the guest share page is built without `public/`).
//
// Construction: an origami pinwheel. Each blade is a right isosceles triangle C·M·K (legs 38,
// C = (−3, −6), M = (−3, −44), K = (−41, −44)), turned 0°, 90°, 180° and 270° about the centre,
// which stays open. Its outer corner K is folded onto C along the crease MF (F is the midpoint of
// CK), so the folded layer C·M·F shows the paper's back. Every paper edge is offset outward by
// 3.5; the corner at the hub keeps a 3.5 round, so the centre stays open, and the two outer
// corners (the tips, M and K) are rounded to 6. The crease stays a sharp straight line.

import { MOSS_BRAND_CORAL, MOSS_BRAND_CORAL_FOLD } from "~/theme/mossBrandColors";

export const MOSS_LOGO_VIEW_BOX = "-47.5 -47.5 95 95";
/** Paper front, the Moss coral. */
export const MOSS_LOGO_COLOR = MOSS_BRAND_CORAL;
/** Paper back, shown by the folded corners. */
export const MOSS_LOGO_FOLD_COLOR = MOSS_BRAND_CORAL_FOLD;

/** The four blades: the whole silhouette of the mark. */
export const MOSS_LOGO_PATH =
  "M-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -41.5A6 6 0 0 0 -5.5 -47.5L-34.96 -47.5A6 6 0 0 0 -39.21 -37.26ZM3.53 -5.47A3.5 3.5 0 0 0 6 0.5L41.5 0.5A6 6 0 0 0 47.5 -5.5L47.5 -34.96A6 6 0 0 0 37.26 -39.21ZM5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 41.5A6 6 0 0 0 5.5 47.5L34.96 47.5A6 6 0 0 0 39.21 37.26ZM-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-41.5 -0.5A6 6 0 0 0 -47.5 5.5L-47.5 34.96A6 6 0 0 0 -37.26 39.21Z";

/**
 * The four folded corners, one per blade in turning order, drawn over the blades in
 * {@link MOSS_LOGO_FOLD_COLOR}. Separate so the mark can light them one by one.
 */
export const MOSS_LOGO_FOLD_PATHS = [
  "M-24.47 -22.53L-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -41.5A6 6 0 0 0 -1.26 -45.74Z",
  "M22.53 -24.47L3.53 -5.47A3.5 3.5 0 0 0 6 0.5L41.5 0.5A6 6 0 0 0 45.74 -1.26Z",
  "M24.47 22.53L5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 41.5A6 6 0 0 0 1.26 45.74Z",
  "M-22.53 24.47L-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-41.5 -0.5A6 6 0 0 0 -45.74 1.26Z",
] as const;
