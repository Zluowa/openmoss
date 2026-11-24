// FILE: markdownAlerts.ts
// Purpose: GitHub-style alerts in a reply (`> [!NOTE]` …): which glyph and which colour each
//          kind wears, decided once for the desktop (ChatMarkdown) and the phone (Markdown).
//          Their titles are ALERT_WORDS in mossWords.ts.
// Layer: Shared pure data (no imports), so the phone app can import it through Metro.
// Exports: MARKDOWN_ALERTS, MARKDOWN_ALERT_KINDS, MERGED_TONE, MarkdownAlertKind,
//          MarkdownAlertTone

export const MARKDOWN_ALERT_KINDS = ["note", "tip", "important", "warning", "caution"] as const;
export type MarkdownAlertKind = (typeof MARKDOWN_ALERT_KINDS)[number];

/** The colour roles an alert takes; each side maps a role to its own theme's colour. */
export type MarkdownAlertTone = "info" | "success" | "merged" | "warning" | "critical";

export const MARKDOWN_ALERTS: Readonly<
  Record<MarkdownAlertKind, { readonly glyph: string; readonly tone: MarkdownAlertTone }>
> = {
  // Glyphs are Central icon names (apps/web/public/central-icons-reversed).
  note: { glyph: "circle-info", tone: "info" },
  tip: { glyph: "light-bulb", tone: "success" },
  important: { glyph: "circle-info", tone: "merged" },
  warning: { glyph: "exclamation-triangle", tone: "warning" },
  caution: { glyph: "exclamation-circle-bold", tone: "critical" },
};

/**
 * The "merged" role has no colour in the phone's palette; it is the desktop's
 * `--status-merged`: Tailwind indigo-500 (oklch 58.5% 0.233 277.117) in light, and that
 * mixed 72% with white in dark (apps/web index.css).
 */
export const MERGED_TONE = { light: "#615fff", dark: "#8d8cff" } as const;
