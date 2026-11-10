// FILE: AppSnapIllustration.tsx
// Purpose: Moss's own picture for Settings › AppSnap: an app window caught in a capture
//          frame, with the two keys that take the snap. Drawn in theme colors so it reads
//          in light and dark; no photos or third-party artwork.
// Layer: Settings UI illustration
// Exports: AppSnapIllustration

import { cn, getNavigatorPlatform, isMacPlatform } from "~/lib/utils";

export function AppSnapIllustration({ className }: { readonly className?: string }) {
  const keyLabel = isMacPlatform(getNavigatorPlatform()) ? "⌥" : "Alt";
  return (
    <figure
      aria-hidden
      data-testid="appsnap-illustration"
      className={cn(
        "overflow-hidden rounded-xl border border-[color:var(--color-border)] bg-[color-mix(in_srgb,var(--color-text-foreground)_3.5%,transparent)]",
        className,
      )}
    >
      <svg viewBox="0 0 320 300" className="block h-auto w-full" role="presentation">
        {/* The app being snapped. */}
        <g transform="translate(44 34)">
          <rect
            width="232"
            height="150"
            rx="10"
            fill="var(--color-background)"
            stroke="var(--color-border)"
          />
          <rect width="232" height="22" rx="10" fill="var(--color-background-control)" />
          <rect y="12" width="232" height="10" fill="var(--color-background-control)" />
          <circle cx="14" cy="11" r="3" fill="var(--color-border)" />
          <circle cx="24" cy="11" r="3" fill="var(--color-border)" />
          <circle cx="34" cy="11" r="3" fill="var(--color-border)" />
          <rect
            x="12"
            y="34"
            width="52"
            height="104"
            rx="6"
            fill="var(--color-background-control)"
          />
          <rect x="76" y="36" width="120" height="8" rx="4" fill="currentColor" opacity="0.22" />
          <rect x="76" y="54" width="140" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="66" width="128" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="78" width="136" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="96" width="92" height="34" rx="6" fill="currentColor" opacity="0.08" />
        </g>
        {/* The capture frame: corner brackets just outside the window. */}
        <g
          fill="none"
          stroke="#f26b4f"
          strokeWidth="3"
          strokeLinecap="round"
          transform="translate(34 24)"
        >
          <path d="M0 22V8a8 8 0 0 1 8-8h14" />
          <path d="M230 0h14a8 8 0 0 1 8 8v14" />
          <path d="M252 148v14a8 8 0 0 1-8 8h-14" />
          <path d="M22 170H8a8 8 0 0 1-8-8v-14" />
        </g>
        {/* The two keys pressed together. */}
        <g transform="translate(86 222)" fontFamily="inherit" fontSize="15" fontWeight="500">
          <rect
            width="58"
            height="44"
            rx="9"
            fill="var(--color-background)"
            stroke="var(--color-border)"
          />
          <rect y="38" width="58" height="6" rx="3" fill="currentColor" opacity="0.08" />
          <text x="29" y="26" textAnchor="middle" fill="currentColor">
            {keyLabel}
          </text>
          <text x="74" y="27" textAnchor="middle" fill="currentColor" opacity="0.5">
            +
          </text>
          <g transform="translate(90 0)">
            <rect
              width="58"
              height="44"
              rx="9"
              fill="var(--color-background)"
              stroke="var(--color-border)"
            />
            <rect y="38" width="58" height="6" rx="3" fill="currentColor" opacity="0.08" />
            <text x="29" y="26" textAnchor="middle" fill="currentColor">
              {keyLabel}
            </text>
          </g>
        </g>
      </svg>
    </figure>
  );
}
