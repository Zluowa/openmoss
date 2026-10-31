// FILE: providerPackageChannel.ts
// Purpose: Decides where agent CLI packages download from. The phone and enterprise-key lanes
//          promise Moss works in mainland China without a VPN, so their version checks and
//          updates use domestic mirrors; the Google lane keeps the official sources.
// Layer: Provider maintenance (server).

import type { ProviderInstanceConfigMap } from "@synara/contracts";
import {
  isMossAccessLane,
  MOSS_CN_NPM_MIRROR_REGISTRY,
  type MossAccessLane,
} from "@synara/shared/mossRealmCatalog";

import { RESERVED_MOSS_PROVIDER_INSTANCE_IDS } from "../reservedSettingsBoundary.ts";

export type ProviderPackageChannel = "official" | "cn-mirror";

export const NPM_OFFICIAL_REGISTRY = "https://registry.npmjs.org";
export const CN_NPM_MIRROR_REGISTRY = MOSS_CN_NPM_MIRROR_REGISTRY;
export const HOMEBREW_OFFICIAL_API_DOMAIN = "https://formulae.brew.sh/api";
export const CN_HOMEBREW_API_DOMAIN = "https://mirrors.ustc.edu.cn/homebrew-bottles/api";

const LANE_PACKAGE_CHANNELS: Readonly<Record<MossAccessLane, ProviderPackageChannel>> = {
  cn: "cn-mirror",
  enterprise: "cn-mirror",
  global: "official",
};

const MAINLAND_CHINA_TIME_ZONES: ReadonlySet<string> = new Set([
  "Asia/Shanghai",
  "Asia/Chongqing",
  "Asia/Chungking",
  "Asia/Harbin",
  "Asia/Urumqi",
  "Asia/Kashgar",
  "PRC",
]);

/** The lane of the signed-in Moss account. Sign-out disables the managed instances. */
export function readActiveMossAccessLane(
  providerInstances: ProviderInstanceConfigMap,
): MossAccessLane | null {
  for (const instanceId of RESERVED_MOSS_PROVIDER_INSTANCE_IDS) {
    const instance = providerInstances[instanceId];
    if (!instance || instance.enabled === false) continue;
    const config = instance.config;
    if (config === null || typeof config !== "object" || Array.isArray(config)) continue;
    const realm = (config as Readonly<Record<string, unknown>>).realm;
    if (isMossAccessLane(realm)) return realm;
  }
  return null;
}

/**
 * The account's lane decides. Without an account the machine's time zone is the only signal: a
 * reachability probe would mislead, because the official registry often answers from mainland
 * China while its package downloads stall.
 */
export function resolveProviderPackageChannel(input: {
  readonly providerInstances: ProviderInstanceConfigMap;
  readonly timeZone?: string;
}): ProviderPackageChannel {
  const lane = readActiveMossAccessLane(input.providerInstances);
  if (lane) return LANE_PACKAGE_CHANNELS[lane];
  const timeZone = input.timeZone ?? Intl.DateTimeFormat().resolvedOptions().timeZone;
  return MAINLAND_CHINA_TIME_ZONES.has(timeZone) ? "cn-mirror" : "official";
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
