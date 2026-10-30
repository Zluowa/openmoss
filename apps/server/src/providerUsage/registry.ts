// FILE: providerUsage/registry.ts
// Purpose: Map each supported ProviderKind to its live usage fetcher. Adding a provider is a
// one-file change: implement a ProviderUsageFetcher and register it here.

import type { ProviderKind } from "@synara/contracts";

import { antigravityUsageFetcher } from "./providers/antigravity";
import { claudeUsageFetcher } from "./providers/claude";
import { codexUsageFetcher } from "./providers/codex";
import { cursorUsageFetcher } from "./providers/cursor";
import { geminiUsageFetcher } from "./providers/gemini";
import { grokUsageFetcher } from "./providers/grok";
import {
  hermesUsageFetcher,
  kimiUsageFetcher,
  minimaxUsageFetcher,
  piUsageFetcher,
  zcodeUsageFetcher,
} from "./providers/localCredential";
import { opencodeUsageFetcher } from "./providers/opencode";
import { devinUsageFetcher } from "./providers/devin";
import type { ProviderUsageFetcher } from "./types";

export const PROVIDER_USAGE_FETCHERS: Partial<Record<ProviderKind, ProviderUsageFetcher>> = {
  codex: codexUsageFetcher,
  claudeAgent: claudeUsageFetcher,
  cursor: cursorUsageFetcher,
  gemini: geminiUsageFetcher,
  antigravity: antigravityUsageFetcher,
  grok: grokUsageFetcher,
  opencode: opencodeUsageFetcher,
  pi: piUsageFetcher,
  hermes: hermesUsageFetcher,
  devin: devinUsageFetcher,
  kimi: kimiUsageFetcher,
  minimax: minimaxUsageFetcher,
  zcode: zcodeUsageFetcher,
};
