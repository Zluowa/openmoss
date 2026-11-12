// FILE: mossLogoPath.ts
// Purpose: The Moss mark as a vector, for pages that do not serve `public/moss-logo-coral.png`
//          (the guest share page is built without `public/`).
//
// Construction: an origami pinwheel. Each blade is a right isosceles triangle C·M·K (legs 38,
// C = (−3, −6), M = (−3, −44), K = (−41, −44)), turned 0°, 90°, 180° and 270° about the centre,
// which stays open. Its outer corner K is folded onto C along the crease MF (F is the midpoint of
// CK), so the folded layer C·M·F shows the paper's back. Every paper edge is offset outward by
// 3.5 with round corners; the crease stays a sharp straight line.

import { MOSS_BRAND_CORAL, MOSS_BRAND_CORAL_FOLD } from "~/theme/mossBrandColors";

export const MOSS_LOGO_VIEW_BOX = "-47.5 -47.5 95 95";
/** Paper front, the Moss coral. */
export const MOSS_LOGO_COLOR = MOSS_BRAND_CORAL;
/** Paper back, shown by the folded corners. */
export const MOSS_LOGO_FOLD_COLOR = MOSS_BRAND_CORAL_FOLD;

/** The four blades: the whole silhouette of the mark. */
export const MOSS_LOGO_PATH =
  "M-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -44A3.5 3.5 0 0 0 -3 -47.5L-41 -47.5A3.5 3.5 0 0 0 -43.47 -41.53ZM3.53 -5.47A3.5 3.5 0 0 0 6 0.5L44 0.5A3.5 3.5 0 0 0 47.5 -3L47.5 -41A3.5 3.5 0 0 0 41.53 -43.47ZM5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 44A3.5 3.5 0 0 0 3 47.5L41 47.5A3.5 3.5 0 0 0 43.47 41.53ZM-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-44 -0.5A3.5 3.5 0 0 0 -47.5 3L-47.5 41A3.5 3.5 0 0 0 -41.53 43.47Z";

/**
 * The four folded corners, one per blade in turning order, drawn over the blades in
 * {@link MOSS_LOGO_FOLD_COLOR}. Separate so the mark can light them one by one.
 */
export const MOSS_LOGO_FOLD_PATHS = [
  "M-24.47 -22.53L-5.47 -3.53A3.5 3.5 0 0 0 0.5 -6L0.5 -44A3.5 3.5 0 0 0 -0.53 -46.47Z",
  "M22.53 -24.47L3.53 -5.47A3.5 3.5 0 0 0 6 0.5L44 0.5A3.5 3.5 0 0 0 46.47 -0.53Z",
  "M24.47 22.53L5.47 3.53A3.5 3.5 0 0 0 -0.5 6L-0.5 44A3.5 3.5 0 0 0 0.53 46.47Z",
  "M-22.53 24.47L-3.53 5.47A3.5 3.5 0 0 0 -6 -0.5L-44 -0.5A3.5 3.5 0 0 0 -46.47 0.53Z",
] as const;
