// FILE: markdownRendering.ts
// Purpose: How a reply's math and Mermaid blocks are recognised and coloured, decided once for
//          the desktop (ChatMarkdown, MermaidDiagram) and the phone (markdownParser, Markdown,
//          MermaidBlock).
// Layer: Shared pure data (no imports), so the phone app can import it through Metro.
// Exports: MARKDOWN_MATH, MERMAID_FENCE_LANGUAGE, PELE_COLOR_ROLES, PeleColorRole

/**
 * Math delimiters: `$x$` in a line and `$$` blocks. `singleDollarText` is remark-math's
 * `singleDollarTextMath`: one `$` opens inline math, as `$$` does.
 */
export const MARKDOWN_MATH = { inline: "$", display: "$$", singleDollarText: true } as const;

/** The fence language that makes a code block a diagram. */
export const MERMAID_FENCE_LANGUAGE = "mermaid";

/** The colour roles pele's palette variables take; each side maps a role to its own theme. */
export type PeleColorRole =
  | "background"
  | "foreground"
  | "muted"
  | "surface"
  | "surfaceAlt"
  | "border"
  | "accent"
  | "critical";

/** pele's palette variables (the diagram renderer both sides use) and the role of each. */
export const PELE_COLOR_ROLES: Readonly<Record<string, PeleColorRole>> = {
  "--pele-bg": "background",
  "--pele-fg": "foreground",
  "--pele-muted": "muted",
  "--pele-line": "muted",
  "--pele-surface": "surface",
  "--pele-surface-alt": "surfaceAlt",
  "--pele-border": "border",
  "--pele-accent": "accent",
  "--pele-critical": "critical",
};
