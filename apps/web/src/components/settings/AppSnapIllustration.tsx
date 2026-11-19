// FILE: AppSnapIllustration.tsx
// Purpose: Moss's own picture for Settings › AppSnap: an app window caught in a capture
//          frame, with the active shortcut keys that take the snap. Drawn in theme tokens so it
//          reads cleanly in light and dark; no hardcoded colors, photos, or third-party artwork.
// Layer: Settings UI illustration
// Exports: AppSnapIllustration

import type { DesktopAppSnapPlatform, DesktopAppSnapShortcut } from "@moss/contracts";
import {
  appSnapShortcutKeyLabel,
  appSnapShortcutModifiers,
  defaultAppSnapShortcut,
  normalizeAppSnapShortcutForPlatform,
} from "@moss/shared/appSnapShortcut";

import { cn, getNavigatorPlatform, isMacPlatform, isWindowsPlatform } from "~/lib/utils";

const COMPACT_MAC_MODIFIERS = {
  command: "⌘",
  control: "⌃",
  option: "⌥",
  shift: "⇧",
} as const;

const COMPACT_WIN_MODIFIERS = {
  command: "Win",
  control: "Ctrl",
  option: "Alt",
  shift: "Shift",
} as const;

function resolveIllustrationPlatform(platform?: DesktopAppSnapPlatform): DesktopAppSnapPlatform {
  if (platform) return platform;
  const nav = getNavigatorPlatform();
  if (isWindowsPlatform(nav)) return "windows";
  if (isMacPlatform(nav)) return "macos";
  return "other";
}

function illustrationKeycaps(
  shortcut: DesktopAppSnapShortcut,
  platform: DesktopAppSnapPlatform,
): readonly string[] {
  const normalized = normalizeAppSnapShortcutForPlatform(shortcut, platform);
  const nonMac = platform === "windows" || platform === "linux";
  if (normalized.kind === "both-option-keys") {
    return nonMac ? ["Alt", "Alt"] : ["⌥", "⌥"];
  }
  const modifierMap = nonMac ? COMPACT_WIN_MODIFIERS : COMPACT_MAC_MODIFIERS;
  return [
    ...appSnapShortcutModifiers(normalized, platform).map((modifier) => modifierMap[modifier]),
    appSnapShortcutKeyLabel(normalized.key, platform),
  ];
}

export function AppSnapIllustration({
  className,
  shortcut,
  platform: platformProp,
}: {
  readonly className?: string;
  readonly shortcut?: DesktopAppSnapShortcut;
  readonly platform?: DesktopAppSnapPlatform;
}) {
  const platform = resolveIllustrationPlatform(platformProp);
  const isWindows = platform === "windows";
  const keycaps = illustrationKeycaps(shortcut ?? defaultAppSnapShortcut(platform), platform);
  const keyWidths = keycaps.map((label) => Math.max(46, Math.min(72, label.length * 10 + 26)));
  const plusGap = 24;
  const totalWidth =
    keyWidths.reduce((sum, width) => sum + width, 0) + Math.max(0, keycaps.length - 1) * plusGap;
  const startX = (320 - totalWidth) / 2;

  let cursorX = startX;
  const placedKeys = keycaps.map((label, index) => {
    const width = keyWidths[index] ?? 52;
    const x = cursorX;
    cursorX += width + plusGap;
    return {
      label,
      width,
      x,
      plusX: x + width + plusGap / 2,
      isLast: index === keycaps.length - 1,
    };
  });

  return (
    <figure
      aria-hidden
      data-testid="appsnap-illustration"
      className={cn(
        "flex h-full items-center justify-center overflow-hidden rounded-card border border-[color:var(--color-border)] bg-[color-mix(in_srgb,var(--color-text-foreground)_3.5%,transparent)] p-3",
        className,
      )}
    >
      <svg viewBox="0 0 320 272" className="block h-auto w-full max-w-[300px]" role="presentation">
        {/* The app being snapped. */}
        <g transform="translate(44 22)">
          <rect
            width="232"
            height="146"
            rx="10"
            fill="var(--color-background, var(--background))"
            stroke="var(--color-border, var(--border))"
          />
          <rect
            width="232"
            height="22"
            rx="10"
            fill="var(--color-background-control, var(--secondary))"
          />
          <rect
            y="12"
            width="232"
            height="10"
            fill="var(--color-background-control, var(--secondary))"
          />
          {isWindows ? (
            <g fill="currentColor" opacity="0.42">
              <rect x="190" y="10.5" width="7" height="1.5" rx="0.75" />
              <rect
                x="203"
                y="8"
                width="6"
                height="6"
                rx="1"
                fill="none"
                stroke="currentColor"
                strokeWidth="1.3"
              />
              <path
                d="M215 8.5L220 13.5M220 8.5L215 13.5"
                stroke="currentColor"
                strokeWidth="1.3"
                strokeLinecap="round"
              />
            </g>
          ) : (
            <>
              <circle cx="14" cy="11" r="3" fill="var(--color-border, var(--border))" />
              <circle cx="24" cy="11" r="3" fill="var(--color-border, var(--border))" />
              <circle cx="34" cy="11" r="3" fill="var(--color-border, var(--border))" />
            </>
          )}
          <rect
            x="12"
            y="34"
            width="52"
            height="100"
            rx="6"
            fill="var(--color-background-control, var(--secondary))"
          />
          <rect x="76" y="36" width="120" height="8" rx="4" fill="currentColor" opacity="0.22" />
          <rect x="76" y="54" width="140" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="66" width="128" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="78" width="136" height="6" rx="3" fill="currentColor" opacity="0.12" />
          <rect x="76" y="96" width="92" height="32" rx="6" fill="currentColor" opacity="0.08" />
        </g>
        {/* The capture frame: corner brackets just outside the window in Moss's accent tone. */}
        <g
          fill="none"
          stroke="var(--color-text-accent, var(--primary))"
          strokeWidth="2.75"
          strokeLinecap="round"
          transform="translate(34 12)"
        >
          <path d="M0 22V8a8 8 0 0 1 8-8h14" />
          <path d="M230 0h14a8 8 0 0 1 8 8v14" />
          <path d="M252 144v14a8 8 0 0 1-8 8h-14" />
          <path d="M22 166H8a8 8 0 0 1-8-8v-14" />
        </g>
        {/* The active shortcut keys pressed together. */}
        <g transform="translate(0 202)" fontFamily="inherit" fontSize="13.5" fontWeight="500">
          {placedKeys.map(({ label, width, x, plusX, isLast }) => (
            <g key={`${label}-${x}`}>
              <g transform={`translate(${x} 0)`}>
                <rect
                  width={width}
                  height="40"
                  rx="8"
                  fill="var(--color-background, var(--background))"
                  stroke="var(--color-border, var(--border))"
                />
                <rect y="34" width={width} height="6" rx="3" fill="currentColor" opacity="0.08" />
                <text x={width / 2} y="24" textAnchor="middle" fill="currentColor">
                  {label}
                </text>
              </g>
              {!isLast ? (
                <text x={plusX} y="24" textAnchor="middle" fill="currentColor" opacity="0.5">
                  +
                </text>
              ) : null}
            </g>
          ))}
        </g>
      </svg>
    </figure>
  );
}
