// FILE: subagentMarkColors.ts
// Purpose: Colours of the subagent marks (the leaf pinwheel): eight hues taken from Moss's own
//          tones, each as a light face and a deeper fold, tuned per theme.
// Layer: Theme constants (colours are defined here; SubagentMark reads them by position).
// Exports: SUBAGENT_MARK_TONES, SubagentMarkTone

export interface SubagentMarkTone {
  readonly name: string;
  readonly light: { readonly face: string; readonly fold: string };
  readonly dark: { readonly face: string; readonly fold: string };
}

/**
 * Hand-out order: consecutive agents land at least 126° of hue apart and stay apart under
 * deuteranopia and protanopia (OKLab distance at least 0.064 after simulation). Within each run of
 * eight, any three in a row also fall in three different deuteranopia groups (ochre/clay/moss,
 * plum/lake/slate, jade/berry). Outlines always differ, so colour is never the only difference.
 * Every fold is at least 3.6:1 against the light surfaces and every face at least 9.3:1 in dark.
 */
export const SUBAGENT_MARK_TONES: readonly SubagentMarkTone[] = [
  {
    name: "ochre",
    light: { face: "#dba751", fold: "#a87502" },
    dark: { face: "#e1b05e", fold: "#bb8311" },
  },
  {
    name: "plum",
    light: { face: "#d09fed", fold: "#9d63be" },
    dark: { face: "#d7a8f4", fold: "#ac74cc" },
  },
  {
    name: "jade",
    light: { face: "#5bcea7", fold: "#049772" },
    dark: { face: "#6ad6b0", fold: "#15a780" },
  },
  {
    name: "clay",
    light: { face: "#f79a7d", fold: "#c75c3a" },
    dark: { face: "#fea387", fold: "#d66d4c" },
  },
  {
    name: "lake",
    light: { face: "#3ecae2", fold: "#0590a4" },
    dark: { face: "#52d1e9", fold: "#01a1b7" },
  },
  {
    name: "berry",
    light: { face: "#f694ad", fold: "#c45576" },
    dark: { face: "#fc9eb5", fold: "#d36785" },
  },
  {
    name: "moss",
    light: { face: "#94c16f", fold: "#5e9128" },
    dark: { face: "#9dc97a", fold: "#6ea03e" },
  },
  {
    name: "slate",
    light: { face: "#88b8fe", fold: "#457fd5" },
    dark: { face: "#96c0fd", fold: "#568fe3" },
  },
];
