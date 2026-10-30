// FILE: providerUsage/providers/localCredential.ts
// Purpose: Usage fetchers for providers that expose a local login but no
// individual live quota API (Pi, Hermes, Kimi Code, MiniMax Code, ZCode).
// Connected accounts still appear in Settings → Usage; unsigned ones stay
// needs-auth.

import { readdir, stat } from "node:fs/promises";
import nodePath from "node:path";

import type { ProviderKind } from "@synara/contracts";

import { readJsonFile } from "../credentials";
import { asRecord, buildSnapshot, needsAuthSnapshot } from "../parse";
import type { ProviderUsageContext, ProviderUsageFetcher } from "../types";

async function jsonObjectHasKeys(path: string): Promise<boolean> {
  const parsed = asRecord(await readJsonFile(path));
  return parsed !== null && Object.keys(parsed).length > 0;
}

async function resolvePiSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const agentDir =
    ctx.env.PI_CODING_AGENT_DIR?.trim() || nodePath.join(ctx.homeDir, ".pi", "agent");
  const authPath = nodePath.join(agentDir, "auth.json");
  if (await jsonObjectHasKeys(authPath)) return "file:pi";
  return null;
}

function localCredentialFetcher(input: {
  provider: ProviderKind;
  source: string;
  detail: string;
  resolveSignedIn: (ctx: ProviderUsageContext) => Promise<string | null>;
}): ProviderUsageFetcher {
  return {
    provider: input.provider,
    async cacheKey(ctx) {
      return (await input.resolveSignedIn(ctx)) ?? `${ctx.homeDir}:none`;
    },
    async fetch(ctx) {
      const signedIn = await input.resolveSignedIn(ctx);
      if (!signedIn) {
        return needsAuthSnapshot(input.provider, ctx.nowMs, input.source);
      }
      return buildSnapshot({
        provider: input.provider,
        nowMs: ctx.nowMs,
        status: "ok",
        source: input.source,
        usageLines: [{ label: "Limits", value: input.detail }],
      });
    },
  };
}

async function resolveHermesSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const authPath = nodePath.join(ctx.homeDir, ".hermes", "auth.json");
  if (await jsonObjectHasKeys(authPath)) return "file:hermes";
  return null;
}

export const piUsageFetcher = localCredentialFetcher({
  provider: "pi",
  source: "pi-local",
  detail:
    "Pi is signed in locally. Remaining limits stay with each configured model provider; Pi has no single quota API.",
  resolveSignedIn: resolvePiSignedIn,
});

export const hermesUsageFetcher = localCredentialFetcher({
  provider: "hermes",
  source: "hermes-local",
  detail:
    "Hermes is signed in locally. Remaining limits stay with each configured model provider; Hermes has no single quota API.",
  resolveSignedIn: resolveHermesSignedIn,
});

async function directoryNames(path: string): Promise<string[]> {
  try {
    return (await readdir(path, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return [];
  }
}

async function isNonEmptyFile(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile() && info.size > 0;
  } catch {
    return false;
  }
}

/** `kimi login` stores its OAuth token under the data root (`KIMI_CODE_HOME`). */
async function resolveKimiSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const home = ctx.env.KIMI_CODE_HOME?.trim() || nodePath.join(ctx.homeDir, ".kimi-code");
  if (await jsonObjectHasKeys(nodePath.join(home, "credentials", "kimi-code.json"))) {
    return "file:kimi";
  }
  return null;
}

/** `mcode login` keeps one token file per build environment and region. */
async function resolveMinimaxSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const authRoot = nodePath.join(
    ctx.env.MINIMAX_DATA_DIR?.trim() || nodePath.join(ctx.homeDir, ".minimax"),
    "auth",
  );
  for (const buildEnv of await directoryNames(authRoot)) {
    for (const region of await directoryNames(nodePath.join(authRoot, buildEnv))) {
      const authPath = nodePath.join(authRoot, buildEnv, region, "mcode-public", "auth.json");
      if (await jsonObjectHasKeys(authPath)) return `file:minimax:${buildEnv}:${region}`;
    }
  }
  return null;
}

/**
 * ZCode credentials come from the desktop app (encrypted store or a manual
 * plan key in config.json) or from `zcode-acp setup` (acp-accounts.json).
 */
async function resolveZcodeSignedIn(ctx: ProviderUsageContext): Promise<string | null> {
  const v2 = nodePath.join(
    ctx.env.ZCODE_HOME?.trim() || nodePath.join(ctx.homeDir, ".zcode"),
    "v2",
  );
  if (await jsonObjectHasKeys(nodePath.join(v2, "acp-accounts.json"))) return "file:zcode:bridge";
  const providers = asRecord(
    asRecord(await readJsonFile(nodePath.join(v2, "config.json")))?.provider,
  );
  const hasProviderKey = Object.values(providers ?? {}).some((entry) => {
    const apiKey = asRecord(asRecord(entry)?.options)?.apiKey;
    return typeof apiKey === "string" && apiKey.trim().length > 0;
  });
  if (hasProviderKey) return "file:zcode:config";
  if (await isNonEmptyFile(nodePath.join(v2, "credentials.json"))) return "file:zcode:desktop";
  return null;
}

export const kimiUsageFetcher = localCredentialFetcher({
  provider: "kimi",
  source: "kimi-local",
  detail:
    "Kimi Code is signed in locally. Plan limits are tracked by your Kimi account; run /usage in Kimi Code to see them.",
  resolveSignedIn: resolveKimiSignedIn,
});

export const minimaxUsageFetcher = localCredentialFetcher({
  provider: "minimax",
  source: "minimax-local",
  detail: "MiniMax Code is signed in locally. Plan limits are tracked by your MiniMax account.",
  resolveSignedIn: resolveMinimaxSignedIn,
});

export const zcodeUsageFetcher = localCredentialFetcher({
  provider: "zcode",
  source: "zcode-local",
  detail:
    "ZCode credentials were found locally. GLM Coding Plan limits are tracked by your Z.ai / BigModel account.",
  resolveSignedIn: resolveZcodeSignedIn,
});
