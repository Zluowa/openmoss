// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SupportedProviderKind,
} from "@synara/contracts";

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
    setupDocsHref: "/docs/providers/codex",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "codex login",
      learnMoreHref: "https://platform.openai.com/usage",
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    available: true,
    setupDocsHref: "/docs/providers/claude-code",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "claude",
      learnMoreHref: "https://docs.anthropic.com/en/docs/about-claude/models#rate-limits",
    },
  },
  {
    kind: "cursor",
    displayName: PROVIDER_DISPLAY_NAMES.cursor,
    available: true,
    setupDocsHref: "/docs/providers/cursor",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "cursor-agent login",
      learnMoreHref: "https://cursor.com/dashboard",
    },
  },
  {
    kind: "gemini",
    displayName: PROVIDER_DISPLAY_NAMES.gemini,
    available: true,
    setupDocsHref: "/docs/providers/gemini",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "gemini",
      learnMoreHref: "https://ai.google.dev/gemini-api/docs/quota",
    },
  },
  {
    kind: "antigravity",
    displayName: PROVIDER_DISPLAY_NAMES.antigravity,
    available: true,
    setupDocsHref: "/docs/providers/antigravity",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "agy",
      learnMoreHref: "https://antigravity.google",
    },
  },
  {
    kind: "grok",
    displayName: PROVIDER_DISPLAY_NAMES.grok,
    available: true,
    setupDocsHref: "/docs/providers/grok",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "grok login",
      learnMoreHref: "https://console.x.ai",
    },
  },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    available: true,
    setupDocsHref: "/docs/providers/opencode",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "opencode auth login",
      learnMoreHref: "https://opencode.ai",
    },
  },
  {
    kind: "pi",
    displayName: PROVIDER_DISPLAY_NAMES.pi,
    available: true,
    setupDocsHref: "/docs/providers/pi",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "pi",
      learnMoreHref: "https://pi.dev",
    },
  },
  {
    kind: "hermes",
    displayName: PROVIDER_DISPLAY_NAMES.hermes,
    available: true,
    setupDocsHref: "/docs/providers/hermes",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "hermes setup",
      learnMoreHref: "https://hermes-agent.nousresearch.com",
    },
  },
  {
    kind: "devin",
    displayName: PROVIDER_DISPLAY_NAMES.devin,
    available: true,
    setupDocsHref: "/docs/providers/devin",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "devin auth login",
      learnMoreHref: "https://app.devin.ai/usage",
    },
  },
  {
    kind: "omp",
    displayName: PROVIDER_DISPLAY_NAMES.omp,
    available: true,
    setupDocsHref: "https://trymoss.com/docs/providers/omp",
    supportsNativeTurnSteering: false,
    usage: null,
  },
  {
    kind: "kimi",
    displayName: PROVIDER_DISPLAY_NAMES.kimi,
    available: true,
    setupDocsHref: "/docs/providers/kimi",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "kimi login",
      learnMoreHref: "https://www.kimi.com/code",
    },
  },
  {
    kind: "minimax",
    displayName: PROVIDER_DISPLAY_NAMES.minimax,
    available: true,
    setupDocsHref: "/docs/providers/minimax",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "mcode login",
      learnMoreHref: "https://platform.minimax.io/docs/coding-plan",
    },
  },
  {
    kind: "zcode",
    displayName: PROVIDER_DISPLAY_NAMES.zcode,
    available: true,
    setupDocsHref: "/docs/providers/zcode",
    supportsNativeTurnSteering: false,
    usage: {
      // The ZCode desktop app login is the primary path; the bridge's setup
      // command only stores a GLM Coding Plan API key.
      signInCommand: "zcode-acp setup --provider bigmodel",
      learnMoreHref: "https://docs.bigmodel.cn/cn/coding-plan",
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
