// FILE: pageChromeStyles.ts
// Purpose: The pill geometry of the page top bar, shared by every slot so the bar reads as one
//          set of capsules.
// Layer: Space page chrome (owned by space-ui)
// Geometry (measured from the reference page header, compact density, mapped onto Moss tokens):
//   - bar: 46px tall, 16px side padding, 12px between the left and right clusters, no rule
//     under it: the pills float over the page;
//   - a standalone pill (title, share): 32px tall, fully round, 12px side padding, footnote
//     size (12px on a 20px line), raised on the card surface by a soft shadow alone (a hairline
//     only in dark, where a shadow does not read);
//   - a capsule (a group of buttons): the same 32px surface with 2px padding and 2px between
//     buttons; the buttons inside are 28px, flat until hovered;
//   - an icon-only button is square (28px), its 16px glyph centred.

/** The left / right clusters of the bar. */
export const PAGE_CHROME_BAR_CLASS_NAME =
  "flex h-11.5 shrink-0 items-center justify-between gap-3 px-4 select-none";

/** The raised surface every pill and capsule sits on. */
export const PAGE_CHROME_SURFACE_CLASS_NAME =
  "bg-card shadow-sm dark:ring-1 dark:ring-[color-mix(in_srgb,var(--foreground)_10%,transparent)]";

/** A group of buttons in one pill. Hides itself when its slot renders nothing. */
export const PAGE_CHROME_CAPSULE_CLASS_NAME = `inline-flex h-8 shrink-0 items-center gap-0.5 rounded-full p-0.5 empty:hidden ${PAGE_CHROME_SURFACE_CLASS_NAME}`;

/** A button inside a capsule: flat, 28px, round. */
export const PAGE_CHROME_CAPSULE_BUTTON_CLASS_NAME =
  "inline-flex h-7 shrink-0 items-center gap-1.5 rounded-full px-2.5 text-ui-sm leading-5 text-muted-foreground outline-none transition-colors hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 aria-pressed:bg-accent aria-pressed:text-foreground data-[popup-open]:bg-accent";

/** Square variant of the capsule button, for icon-only actions. */
export const PAGE_CHROME_ICON_BUTTON_CLASS_NAME = "w-7 justify-center px-0";

/** A pill that stands on its own (the title, 分享): 32px, its own raised surface. */
export const PAGE_CHROME_PILL_CLASS_NAME = `inline-flex h-8 shrink-0 items-center gap-1.5 rounded-full px-3 text-ui-sm leading-5 text-foreground outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring disabled:pointer-events-none disabled:opacity-50 data-[popup-open]:bg-accent ${PAGE_CHROME_SURFACE_CLASS_NAME}`;
