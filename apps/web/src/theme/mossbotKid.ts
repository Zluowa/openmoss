// FILE: mossbotKid.ts
// Purpose: Colours of the pinwheel kid (风车娃), the pixel body a Mossbot can wear: its tones, ink eyes, the
//          Moss pinwheel on its head, and the props its scenes use.
// Layer: Theme constants (colours are defined here; the kid sprite reads them by palette key).
// Exports: MOSSBOT_KID_TONES, MOSSBOT_KID_INK, MOSSBOT_KID_PROP_COLOURS, MossbotKidTone.
import {
  MOSSBOT_COMPANION_CORAL,
  MOSSBOT_COMPANION_CORAL_DEEP,
  MOSSBOT_COMPANION_TONES,
} from "./mossbotCompanion";

/**
 * Body tones. Coral is the kid's own colour, taken from the Moss mark; the others are the companion's earth tones,
 * each with a shade 22% darker for the body's lower and right edges. Ink eyes keep at least 3.7:1 on every tone.
 */
export const MOSSBOT_KID_TONES = {
  coral: { body: MOSSBOT_COMPANION_CORAL, shade: MOSSBOT_COMPANION_CORAL_DEEP },
  moss: { body: MOSSBOT_COMPANION_TONES.moss.body, shade: "#46692e" },
  jade: { body: MOSSBOT_COMPANION_TONES.jade.body, shade: "#306853" },
  olive: { body: MOSSBOT_COMPANION_TONES.olive.body, shade: "#5f682a" },
  ochre: { body: MOSSBOT_COMPANION_TONES.ochre.body, shade: "#8b662d" },
  stone: { body: MOSSBOT_COMPANION_TONES.stone.body, shade: "#68635d" },
  slate: { body: MOSSBOT_COMPANION_TONES.slate.body, shade: "#445c6b" },
  lake: { body: MOSSBOT_COMPANION_TONES.lake.body, shade: "#316867" },
  plum: { body: MOSSBOT_COMPANION_TONES.plum.body, shade: "#60536e" },
  clay: { body: MOSSBOT_COMPANION_TONES.clay.body, shade: "#835048" },
  rust: { body: MOSSBOT_COMPANION_TONES.rust.body, shade: "#89512d" },
} as const;

export type MossbotKidTone = keyof typeof MOSSBOT_KID_TONES;

/** Eyes and the pinwheel's hub: the Moss ink. */
export const MOSSBOT_KID_INK = "#141413";

/**
 * Colours for props and for body details that keep their own colour in every tone: the robot's visor, the chick's
 * shell, the penguin's belly, beak and feet.
 */
export const MOSSBOT_KID_PROP_COLOURS = {
  W: "#ffffff",
  P: "#f1eee6",
  G: "#bdbcb6",
  S: "#8b8a84",
  N: "#4d4c48",
  Y: "#f5b44a",
  B: "#3987e5",
  E: "#2fb36a",
  R: "#7a4a2e",
} as const;
