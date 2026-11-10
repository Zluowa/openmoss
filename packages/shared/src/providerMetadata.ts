// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SupportedProviderKind,
} from "@moss/contracts";
import { MOSS_OFFICIAL_SITE_URL } from "./desktopIdentity";

export interface ProviderDescriptor {
  readonly kind: SupportedProviderKind;
  readonly displayName: string;
  readonly available: boolean;
  readonly setupDocsHref: string;
  /**
   * True when the provider runtime can inject a user message into a live turn
   * without interrupting it (Codex `turn/steer`, Pi `session.steer`, Claude
   * streaming-input prompt queue). Mirrors the adapter's
   * `supportsTurnSteering` capability so the pure decider and the web client
   * can route steers without a runtime round-trip; keep the two in sync.
   */
  readonly supportsNativeTurnSteering: boolean;
  readonly usage: {
    readonly signInCommand: string;
    readonly learnMoreHref: string;
  } | null;
}

type ExhaustiveProviderDescriptors<Descriptors extends readonly ProviderDescriptor[]> =
  Exclude<SupportedProviderKind, Descriptors[number]["kind"]> extends never ? Descriptors : never;

function defineProviderDescriptors<const Descriptors extends readonly ProviderDescriptor[]>(
  descriptors: ExhaustiveProviderDescriptors<Descriptors>,
): Descriptors {
  return descriptors;
}

export const PROVIDER_DESCRIPTORS = defineProviderDescriptors([
  {
    kind: "codex",
    displayName: PROVIDER_DISPLAY_NAMES.codex,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "codex login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "claude",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "cursor",
    displayName: PROVIDER_DISPLAY_NAMES.cursor,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "cursor-agent login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "gemini",
    displayName: PROVIDER_DISPLAY_NAMES.gemini,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "gemini",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "antigravity",
    displayName: PROVIDER_DISPLAY_NAMES.antigravity,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "agy",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "grok",
    displayName: PROVIDER_DISPLAY_NAMES.grok,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "grok login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "opencode auth login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "pi",
    displayName: PROVIDER_DISPLAY_NAMES.pi,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "pi",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "hermes",
    displayName: PROVIDER_DISPLAY_NAMES.hermes,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "hermes setup",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "devin",
    displayName: PROVIDER_DISPLAY_NAMES.devin,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "devin auth login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "omp",
    displayName: PROVIDER_DISPLAY_NAMES.omp,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: null,
  },
  {
    kind: "kimi",
    displayName: PROVIDER_DISPLAY_NAMES.kimi,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "kimi login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "minimax",
    displayName: PROVIDER_DISPLAY_NAMES.minimax,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "mcode login",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
  {
    kind: "zcode",
    displayName: PROVIDER_DISPLAY_NAMES.zcode,
    available: true,
    setupDocsHref: MOSS_OFFICIAL_SITE_URL,
    supportsNativeTurnSteering: false,
    usage: {
      // The ZCode desktop app login is the primary path; the bridge's setup
      // command only stores a GLM Coding Plan API key.
      signInCommand: "zcode-acp setup --provider bigmodel",
      learnMoreHref: MOSS_OFFICIAL_SITE_URL,
    },
  },
] as const satisfies readonly ProviderDescriptor[]);

export const PROVIDER_DESCRIPTOR_BY_KIND = Object.fromEntries(
  PROVIDER_DESCRIPTORS.map((descriptor) => [descriptor.kind, descriptor]),
) as Partial<Record<ProviderKind, (typeof PROVIDER_DESCRIPTORS)[number]>>;

// Accepts plain strings so projection-sourced provider names can be checked
// without casts; unknown providers are simply not steerable.
export const providerSupportsNativeTurnSteering = (kind: string): boolean =>
  PROVIDER_DESCRIPTORS.some(
    (descriptor) => descriptor.kind === kind && descriptor.supportsNativeTurnSteering,
  );
