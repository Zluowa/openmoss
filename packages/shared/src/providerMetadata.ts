// FILE: providerMetadata.ts
// Purpose: Exhaustive non-secret provider identity and presentation metadata.

import {
  PROVIDER_DISPLAY_NAMES,
  type ProviderKind,
  type SupportedProviderKind,
} from "@moss/contracts";

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
    setupDocsHref: "https://help.openai.com/en/articles/11096431",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "codex login",
    },
  },
  {
    kind: "claudeAgent",
    displayName: PROVIDER_DISPLAY_NAMES.claudeAgent,
    available: true,
    setupDocsHref: "https://code.claude.com/docs/en/overview",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "claude",
    },
  },
  {
    kind: "cursor",
    displayName: PROVIDER_DISPLAY_NAMES.cursor,
    available: true,
    setupDocsHref: "https://cursor.com/docs/cli/overview",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "cursor-agent login",
    },
  },
  {
    kind: "gemini",
    displayName: PROVIDER_DISPLAY_NAMES.gemini,
    available: true,
    setupDocsHref: "https://geminicli.com/docs/get-started/",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "gemini",
    },
  },
  {
    kind: "antigravity",
    displayName: PROVIDER_DISPLAY_NAMES.antigravity,
    available: true,
    setupDocsHref: "https://antigravity.google/docs/cli/using",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "agy",
    },
  },
  {
    kind: "grok",
    displayName: PROVIDER_DISPLAY_NAMES.grok,
    available: true,
    setupDocsHref: "https://docs.x.ai/build/overview",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "grok login",
    },
  },
  {
    kind: "opencode",
    displayName: PROVIDER_DISPLAY_NAMES.opencode,
    available: true,
    setupDocsHref: "https://opencode.ai/docs/",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "opencode auth login",
    },
  },
  {
    kind: "pi",
    displayName: PROVIDER_DISPLAY_NAMES.pi,
    available: true,
    setupDocsHref: "https://pi.dev/docs/latest",
    supportsNativeTurnSteering: true,
    usage: {
      signInCommand: "pi",
    },
  },
  {
    kind: "hermes",
    displayName: PROVIDER_DISPLAY_NAMES.hermes,
    available: true,
    setupDocsHref: "https://hermes-agent.nousresearch.com/docs",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "hermes setup",
    },
  },
  {
    kind: "devin",
    displayName: PROVIDER_DISPLAY_NAMES.devin,
    available: true,
    setupDocsHref: "https://docs.devin.ai/cli",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "devin auth login",
    },
  },
  {
    kind: "omp",
    displayName: PROVIDER_DISPLAY_NAMES.omp,
    available: true,
    setupDocsHref: "https://omp.sh/docs/quickstart",
    supportsNativeTurnSteering: false,
    usage: null,
  },
  {
    kind: "kimi",
    displayName: PROVIDER_DISPLAY_NAMES.kimi,
    available: true,
    setupDocsHref: "https://www.kimi.com/code/docs/en/",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "kimi login",
    },
  },
  {
    kind: "minimax",
    displayName: PROVIDER_DISPLAY_NAMES.minimax,
    available: true,
    setupDocsHref: "https://platform.minimax.io/docs/m-plan/intro",
    supportsNativeTurnSteering: false,
    usage: {
      signInCommand: "mcode login",
    },
  },
  {
    kind: "zcode",
    displayName: PROVIDER_DISPLAY_NAMES.zcode,
    available: true,
    setupDocsHref: "https://docs.bigmodel.cn/cn/coding-plan/quick-start",
    supportsNativeTurnSteering: false,
    usage: {
      // The ZCode desktop app login is the primary path; the bridge's setup
      // command only stores a GLM Coding Plan API key.
      signInCommand: "zcode-acp setup --provider bigmodel",
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
