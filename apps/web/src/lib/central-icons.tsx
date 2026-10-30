// FILE: central-icons.tsx
// Purpose: Resolve and render Central icon SVGs shipped as static web assets.
// Layer: web UI utility
// Exports: CentralIcon, getCentralIconUrl, createCentralIconElement, createCentralIconComponent
// Depends on: Vite public asset serving and app className merging utilities.

import { forwardRef, type CSSProperties, type HTMLAttributes, type ReactElement } from "react";
import { cn } from "./utils";

// Central icons ship in two visual sets served as static assets: the default
// "reversed" outline set and a solid "fill" set. The variant only selects the
// source folder — rendering (CSS mask + bg-current) is identical for both, so a
// fill asset paints as a solid glyph and an outline asset as a stroked one.
// "moss" holds the few glyphs Central lacks, drawn to the same spec (24px grid,
// 1.5px round-capped stroke) so they are indistinguishable from the set.
const CENTRAL_ICON_BASE_PATHS = {
  reversed: "/central-icons-reversed",
  fill: "/central-icons-fill",
  moss: "/moss-icons",
} as const;
export type CentralIconVariant = keyof typeof CENTRAL_ICON_BASE_PATHS;
const DEFAULT_CENTRAL_ICON_VARIANT: CentralIconVariant = "reversed";
const SVG_SUFFIX = ".svg";
const CENTRAL_ICON_NAME_PATTERN = /^[a-z0-9][a-z0-9-]*$/;

export type CentralIconProps = Omit<HTMLAttributes<HTMLSpanElement>, "children"> & {
  name: string;
  label?: string | undefined;
  variant?: CentralIconVariant | undefined;
};

// Builds a public asset URL from the icon basename without allowing path traversal.
export function getCentralIconUrl(
  name: string,
  variant: CentralIconVariant = DEFAULT_CENTRAL_ICON_VARIANT,
): string | null {
  // Defensive: a non-string name (stale HMR module state, or a dynamic call site handing
  // through bad data) must degrade to "no icon" with a loud diagnostic instead of taking
  // down the whole tree with `name.endsWith is not a function`.
  if (typeof name !== "string") {
    console.error("[central-icons] non-string icon name:", name, new Error("caller").stack);
    return null;
  }
  const normalizedName = name.endsWith(SVG_SUFFIX) ? name.slice(0, -SVG_SUFFIX.length) : name;

  if (!CENTRAL_ICON_NAME_PATTERN.test(normalizedName)) {
    return null;
  }

  return `${CENTRAL_ICON_BASE_PATHS[variant]}/${encodeURIComponent(normalizedName)}${SVG_SUFFIX}`;
}

// Shared base classes so the React component and the imperative DOM helper stay
// pixel-identical (single uniform fill tinted to the current text color).
const CENTRAL_ICON_BASE_CLASS = "inline-block size-4 shrink-0 bg-current";
// A container rule that styles its icon names both the glyph span and `<svg>` (brand marks):
// `[&_svg,&_[data-slot=central-icon]]:…` for descendants and
// `[&>svg,&>[data-slot=central-icon]]:…` for direct children. Spell the selector out in source,
// never build it at runtime: Tailwind only generates classes it finds in source, and
// tailwind-merge only lets a call site's override replace a primitive's rule when both spell
// the selector the same way. Two kinds of svg rule stay svg-only on purpose: the
// `svg:not([class*='size-'])` size fallbacks, which a glyph never matches because it always
// carries a size class (`size-4` unless the caller sets one), and the `opacity-80` dimming,
// because icons take the text colour (docs/design/visual-system.md).
export const CENTRAL_ICON_SLOT = "central-icon";

// CSS-mask shorthand value that paints the icon as a solid `bg-current` fill.
function centralIconMaskValue(iconUrl: string): string {
  return `url("${iconUrl}") center / contain no-repeat`;
}

export const CentralIcon = forwardRef<HTMLSpanElement, CentralIconProps>(function CentralIcon(
  { name, label, variant, className, style, role: roleProp, ...props },
  ref,
) {
  const iconUrl = getCentralIconUrl(name, variant);

  if (!iconUrl) {
    return null;
  }

  const maskValue = centralIconMaskValue(iconUrl);
  const maskStyle = {
    WebkitMask: maskValue,
    mask: maskValue,
    ...style,
  } satisfies CSSProperties;

  return (
    <span
      {...props}
      ref={ref}
      // A caller's role wins (a spinner is a live `status`); a labelled glyph is otherwise an image.
      role={roleProp ?? (label ? "img" : undefined)}
      aria-label={label}
      aria-hidden={label ? undefined : true}
      data-slot={CENTRAL_ICON_SLOT}
      className={cn(CENTRAL_ICON_BASE_CLASS, className)}
      style={maskStyle}
    />
  );
});

// Adapts a Central icon name to the `ComponentType<{ className?: string }>` shape
// expected by icon-prop APIs (SidebarIconButton, menu action descriptors, …) so
// Central glyphs can drop in wherever a react-icons/lucide component was used.
export function createCentralIconComponent(
  name: string,
  variant?: CentralIconVariant,
): (props: { className?: string }) => ReactElement {
  function CentralIconGlyph({ className }: { className?: string }) {
    return <CentralIcon name={name} variant={variant} className={className} />;
  }
  CentralIconGlyph.displayName = `CentralIconGlyph(${name})`;
  return CentralIconGlyph;
}

// Imperative twin of `CentralIcon` for non-React surfaces such as the Lexical
// composer chips that build their DOM by hand. Returns null when the name is
// invalid so callers can fall back to a static glyph.
export function createCentralIconElement(
  name: string,
  className?: string,
  variant?: CentralIconVariant,
): HTMLSpanElement | null {
  const iconUrl = getCentralIconUrl(name, variant);
  if (!iconUrl) {
    return null;
  }

  const span = document.createElement("span");
  span.setAttribute("aria-hidden", "true");
  span.dataset.slot = CENTRAL_ICON_SLOT;
  span.className = cn(CENTRAL_ICON_BASE_CLASS, className);
  const maskValue = centralIconMaskValue(iconUrl);
  span.style.setProperty("-webkit-mask", maskValue);
  span.style.setProperty("mask", maskValue);
  return span;
}
