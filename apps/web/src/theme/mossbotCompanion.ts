// FILE: mossbotCompanion.ts
// Purpose: Colours of the Mossbot companion (body tones, eyes, the Moss pinwheel it turns into).
// Layer: Theme constants (colours are defined here; the companion engine and avatar read them by name).
// Exports: MOSSBOT_COMPANION_TONES, MOSSBOT_COMPANION_EYE, MOSSBOT_COMPANION_CORAL, MOSSBOT_COMPANION_CORAL_DEEP,
//          MossbotCompanionTone.

/** Body colours: moss green first, then the other earth tones an assistant can wear. White eyes read on all. */
export const MOSSBOT_COMPANION_TONES = {
  moss: { body: "#5a873b" },
  jade: { body: "#3e856a" },
  olive: { body: "#7a8536" },
  ochre: { body: "#b2833a" },
  stone: { body: "#857f77" },
  slate: { body: "#577689" },
  // Earth versions of the remaining assistant colours (cyan, violet, rose, orange).
  lake: { body: "#3f8584" },
  plum: { body: "#7b6a8d" },
  clay: { body: "#a8665c" },
  rust: { body: "#b0683a" },
} as const;

export type MossbotCompanionTone = keyof typeof MOSSBOT_COMPANION_TONES;

/** Eyes: warm paper white, readable on every tone in light and dark mode. */
export const MOSSBOT_COMPANION_EYE = "#fbfaf6";

/** The Moss mark's two corals; only the pinwheel uses them. */
export const MOSSBOT_COMPANION_CORAL = "#ff5e4b";
export const MOSSBOT_COMPANION_CORAL_DEEP = "#d63d2b";
