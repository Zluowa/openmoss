// FILE: brandColors.ts
// Purpose: Brand hex color constants for third-party plugin/connector icons. Kept under src/theme/
//          alongside mossBrandColors.ts so brand pigments live in the designated palette layer.
// Layer: Web theme palette
// Exports: OUTLOOK_BRAND_COLORS, BRAND_COLORS

export const OUTLOOK_BRAND_COLORS = {
  dark: "#0364B8",
  mid: "#0078D4",
  light: "#28A8EA",
  flap: "#50D9FF",
  badge: "#0078D4",
  glyph: "#FFFFFF",
} as const;

export const BRAND_COLORS = {
  outlook: "#0078D4",
  googleDocs: "#4285F4",
  googleSheets: "#0F9D58",
  googleSlides: "#F4B400",
  discord: "#5865F2",
  zoom: "#0B5CFF",
  dropbox: "#0061FF",
  airtable: "#18BFFF",
  hubspot: "#FF7A59",
  jira: "#0052CC",
  trello: "#0052CC",
  asana: "#F06A6A",
} as const;
