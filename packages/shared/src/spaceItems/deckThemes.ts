// FILE: deckThemes.ts
// Purpose: Moss's built-in deck themes (colors, fonts, text styles) and the lookup agents and
//          the theme picker use.
// Layer: Shared model

import { DEFAULT_DECK_THEME, defaultTextStyles, type DeckTheme } from "./slidesDeck";

const theme = (
  id: string,
  name: string,
  colors: DeckTheme["colors"],
  fonts: DeckTheme["fonts"] = { heading: "Noto Sans SC", body: "Noto Sans SC" },
): { id: string; theme: DeckTheme } => ({
  id,
  theme: { name, colors, fonts, textStyles: defaultTextStyles(colors.text, colors.muted) },
});

/** id → theme. Ids are stable (agents pass them); names are what people see. */
export const DECK_THEMES: readonly { id: string; theme: DeckTheme }[] = [
  { id: "paper", theme: DEFAULT_DECK_THEME },
  theme("ink", "夜墨", {
    background: "#1E2220",
    surface: "#2A2F2C",
    text: "#F3F1EC",
    muted: "#B9B5AC",
    accent: "#E07A52",
    accent2: "#7FB8A4",
    border: "#3A403C",
  }),
  theme("celadon", "青瓷", {
    background: "#F1F5F2",
    surface: "#FFFFFF",
    text: "#1D2B26",
    muted: "#5B6B65",
    accent: "#3E7C6B",
    accent2: "#C9A45C",
    border: "#D3DED8",
  }),
  theme("sea", "海盐", {
    background: "#F5F7FA",
    surface: "#FFFFFF",
    text: "#18202E",
    muted: "#5C6677",
    accent: "#2F5FD0",
    accent2: "#18A08A",
    border: "#D8DEE8",
  }),
  theme(
    "sand",
    "暖砂",
    {
      background: "#F4EEE4",
      surface: "#FBF8F2",
      text: "#2B241D",
      muted: "#75695B",
      accent: "#B4583A",
      accent2: "#56704A",
      border: "#E2D7C6",
    },
    { heading: "Noto Serif SC", body: "Noto Sans SC" },
  ),
  theme("graphite", "石墨", {
    background: "#FFFFFF",
    surface: "#F4F4F3",
    text: "#111111",
    muted: "#666662",
    accent: "#111111",
    accent2: "#8A8A85",
    border: "#E2E2DF",
  }),
];

export const findDeckTheme = (id: string): DeckTheme | null =>
  DECK_THEMES.find((entry) => entry.id === id || entry.theme.name === id)?.theme ?? null;
