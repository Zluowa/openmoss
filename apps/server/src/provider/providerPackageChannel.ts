// FILE: providerPackageChannel.ts
// Purpose: Decides where agent CLI packages download from. The phone and enterprise-key lanes
//          promise Moss works in mainland China without a VPN, so their version checks and
//          updates use domestic mirrors; the Google lane keeps the official sources.
// Layer: Provider maintenance (server).

import type { ProviderInstanceConfigMap } from "@moss/contracts";
import {
  readActiveMossAccessLane,
  resolveMossDownloadChannel,
  type MossDownloadChannel,
} from "@moss/shared/mossDownloadChannel";
import { MOSS_CN_NPM_MIRROR_REGISTRY } from "@moss/shared/mossRealmCatalog";

export { readActiveMossAccessLane };

export type ProviderPackageChannel = MossDownloadChannel;

export const NPM_OFFICIAL_REGISTRY = "https://registry.npmjs.org";
export const CN_NPM_MIRROR_REGISTRY = MOSS_CN_NPM_MIRROR_REGISTRY;
export const HOMEBREW_OFFICIAL_API_DOMAIN = "https://formulae.brew.sh/api";
export const CN_HOMEBREW_API_DOMAIN = "https://mirrors.ustc.edu.cn/homebrew-bottles/api";

export function resolveProviderPackageChannel(input: {
  readonly providerInstances: ProviderInstanceConfigMap;
  readonly timeZone?: string;
}): ProviderPackageChannel {
  return resolveMossDownloadChannel({
    lane: readActiveMossAccessLane(input.providerInstances),
    timeZone: input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone,
  });
}

/**
 * Also covers update commands Moss cannot add flags to, such as a CLI's own updater shelling out
 * to npm, and native addons that download a prebuilt binary during install.
 */
export function applyProviderPackageChannelEnv(
  env: NodeJS.ProcessEnv,
  channel: ProviderPackageChannel | undefined,
): NodeJS.ProcessEnv {
  if (channel !== "cn-mirror") return env;
  return {
    ...env,
    npm_config_registry: CN_NPM_MIRROR_REGISTRY,
    BUN_CONFIG_REGISTRY: CN_NPM_MIRROR_REGISTRY,
    COREPACK_NPM_REGISTRY: CN_NPM_MIRROR_REGISTRY,
    npm_config_better_sqlite3_binary_host: `${CN_NPM_MIRROR_REGISTRY}/-/binary/better-sqlite3`,
    HOMEBREW_API_DOMAIN: CN_HOMEBREW_API_DOMAIN,
    HOMEBREW_BOTTLE_DOMAIN: "https://mirrors.ustc.edu.cn/homebrew-bottles",
    HOMEBREW_BREW_GIT_REMOTE: "https://mirrors.ustc.edu.cn/brew.git",
    HOMEBREW_CORE_GIT_REMOTE: "https://mirrors.ustc.edu.cn/homebrew-core.git",
  };
}
