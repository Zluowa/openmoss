// FILE: betaFeatures.ts
// Purpose: The web app's read of the shared Beta-only feature list.
// Layer: Route/UI support
// Exports: isBetaFeatureOn, visibleProviderDescriptors, VISIBLE_PROVIDER_DESCRIPTORS

import {
  desktopFlavorFromProtocol,
  INLINE_VISUALS_BETA_FEATURE,
  INBOX_BETA_FEATURE,
  isBetaFeatureEnabled,
  MCP_CONNECTORS_BETA_FEATURE,
  PULL_REQUEST_AUTO_FIX_BETA_FEATURE,
} from "@moss/shared/betaFeatures";
import { PROVIDER_DESCRIPTORS } from "@moss/shared/providerMetadata";

// The desktop serves the app from its own scheme, so the protocol names the
// host flavor (branding.ts uses the same signal for display names). A dev
// build serves `moss:` too, so import.meta.env.DEV disambiguates it. SSR and
// tests have no window and resolve to "unknown", which keeps Beta-only
// features on — the server gate is the authoritative one.
const DESKTOP_FLAVOR = desktopFlavorFromProtocol(
  typeof window === "undefined" ? undefined : window.location?.protocol,
  import.meta.env.DEV,
);

export const isBetaFeatureOn = (feature: string): boolean =>
  isBetaFeatureEnabled(feature, DESKTOP_FLAVOR);

// Hubs (the "groups" Beta feature) were removed from the web app on 2026-11-10 in every
// flavor; the server's hub runtime stays because Mossbot runs on it.

/**
 * Inline visuals are available in Stable and Beta. HTML keeps the same
 * sandbox and desktop-only execution boundary; component specs also work on the web.
 */
export const INLINE_VISUALS_ON = isBetaFeatureOn(INLINE_VISUALS_BETA_FEATURE);

/**
 * Inbox is available in Stable and Beta. Tasks within it retain their separate gate.
 */
export const INBOX_ON = isBetaFeatureOn(INBOX_BETA_FEATURE);

/**
 * Auto-fix CI is available in Stable and Beta; watching a PR remains opt-in.
 */
export const PULL_REQUEST_AUTO_FIX_ON = isBetaFeatureOn(PULL_REQUEST_AUTO_FIX_BETA_FEATURE);

/**
 * Connectors are available in Stable and Beta, including Settings and `@`
 * mentions for provider sessions that support them.
 */
export const MCP_CONNECTORS_ON = isBetaFeatureOn(MCP_CONNECTORS_BETA_FEATURE);

/**
 * Provider descriptors with Beta-only providers removed on Stable. A
 * provider's feature key is its ProviderKind, so an unlisted kind is always
 * visible. Selectable lists (pickers, settings, onboarding) consume this;
 * display-only rendering of existing threads keeps PROVIDER_DESCRIPTORS.
 */
export function visibleProviderDescriptors(
  isOn: (feature: string) => boolean = isBetaFeatureOn,
): (typeof PROVIDER_DESCRIPTORS)[number][] {
  return PROVIDER_DESCRIPTORS.filter((d) => isOn(d.kind));
}

export const VISIBLE_PROVIDER_DESCRIPTORS = visibleProviderDescriptors();
