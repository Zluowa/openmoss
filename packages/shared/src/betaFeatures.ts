// FILE: betaFeatures.ts
// Purpose: The single list of features that ship in Beta but not in Stable.
// Layer: Shared contracts (consumed by desktop main, server, and web UI)

import {
  MOSS_BETA_BUNDLE_ID,
  MOSS_CANARY_BUNDLE_ID,
  MOSS_CUA_BUNDLE_ID,
  MOSS_DEVELOPMENT_BUNDLE_ID,
  MOSS_PRODUCTION_BUNDLE_ID,
  type MossDesktopFlavor,
} from "./desktopIdentity";

/**
 * Features that ship only in non-Stable builds. Keep a feature out of Stable
 * by adding its key here; promote it by deleting the entry. A provider's key
 * is its ProviderKind. "groups" is Groups (below).
 */
export type BetaOnlyFeature = string;

/** Groups: the coordinator, its threads, the Group panel and the Library. */
export const GROUPS_BETA_FEATURE = "groups";

/**
 * Inline visuals (Stable and Beta): the `moss_show_visual` agent tool,
 * component-spec and sandboxed HTML transcript rows, and the document read.
 */
export const INLINE_VISUALS_BETA_FEATURE = "inline-visuals";

/** Inbox (Stable and Beta): the Inbox page and its `stats.getRecap` RPC. */
export const INBOX_BETA_FEATURE = "inbox";

/**
 * Audio trail (Stable and Beta): the chat message trail moves with the Mac's
 * audio output and/or the microphone, read by the AppSnap helper's `--audio-level` mode.
 */
export const AUDIO_TRAIL_BETA_FEATURE = "audio-trail";

/** Auto-fix CI (Stable and Beta): the PR menu checkbox, RPCs, and check watcher. */
export const PULL_REQUEST_AUTO_FIX_BETA_FEATURE = "pull-request-auto-fix";

/**
 * Connectors (Stable and Beta): remote MCP servers the user signs in to from
 * Settings, proxied to supported provider sessions through the agent gateway.
 */
export const MCP_CONNECTORS_BETA_FEATURE = "mcp-connectors";

export const BETA_ONLY_FEATURES: readonly BetaOnlyFeature[] = [GROUPS_BETA_FEATURE];

/**
 * Whether a Beta-only feature is on for this host. Only the Stable
 * (production) desktop build turns them off: Beta, Cua, Canary, development
 * and non-desktop hosts (flavor "unknown") keep them.
 */
export function isBetaFeatureEnabled(
  feature: BetaOnlyFeature,
  flavor: MossDesktopFlavor | "unknown",
): boolean {
  return !BETA_ONLY_FEATURES.includes(feature) || flavor !== "production";
}

/** Maps a desktop bundle id to its flavor; blank or unrecognized -> "unknown". */
export function desktopFlavorFromBundleId(
  bundleId: string | undefined,
): MossDesktopFlavor | "unknown" {
  switch (bundleId?.trim()) {
    case MOSS_PRODUCTION_BUNDLE_ID:
      return "production";
    case MOSS_DEVELOPMENT_BUNDLE_ID:
      return "development";
    case MOSS_CANARY_BUNDLE_ID:
      return "canary";
    case MOSS_CUA_BUNDLE_ID:
      return "cua";
    case MOSS_BETA_BUNDLE_ID:
      return "beta";
    default:
      return "unknown";
  }
}

/**
 * Maps the web app's own URL scheme to the hosting desktop's flavor. A Stable
 * build serves `moss:` pages; a development build serves the same scheme, so
 * the caller passes whether this is a dev build. Anything else (http, missing
 * window) is "unknown".
 */
export function desktopFlavorFromProtocol(
  protocol: string | undefined,
  isDevBuild: boolean,
): MossDesktopFlavor | "unknown" {
  switch (protocol) {
    case "moss-beta:":
      return "beta";
    case "moss-canary:":
      return "canary";
    case "moss-cua:":
      return "cua";
    case "moss:":
      return isDevBuild ? "development" : "production";
    default:
      return "unknown";
  }
}
