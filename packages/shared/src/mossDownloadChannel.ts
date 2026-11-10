// FILE: mossDownloadChannel.ts
// Purpose: Decides whether a Moss install downloads from domestic mirrors or official sources. The
//          phone and enterprise-key lanes promise Moss works in mainland China without a VPN, so
//          they use domestic mirrors; the Google lane keeps the official sources.
// Layer: Shared runtime policy (no I/O).

import { isMossAccessLane, type MossAccessLane } from "./mossRealmCatalog";

export type MossDownloadChannel = "official" | "cn-mirror";

/** Provider instances Moss manages for the signed-in account; they carry the account's lane. */
export const MOSS_MANAGED_PROVIDER_INSTANCE_IDS = [
  "codex_moss",
  "codex_byok",
  "claude_moss",
  "opencode_moss",
  "pi_moss",
  "grok_moss",
  "hermes_moss",
  "kimi_moss",
  "minimax_moss",
  "zcode_moss",
] as const;

const LANE_DOWNLOAD_CHANNELS: Readonly<Record<MossAccessLane, MossDownloadChannel>> = {
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

function isRecord(value: unknown): value is Readonly<Record<string, unknown>> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

/**
 * The lane of the signed-in Moss account, read from the settings' `providerInstances`. The lane is
 * persisted under the historical `realm` key, and sign-out disables the managed instances. Takes
 * `unknown` because the desktop main process reads settings the server wrote, without decoding them.
 */
export function readActiveMossAccessLane(providerInstances: unknown): MossAccessLane | null {
  if (!isRecord(providerInstances)) return null;
  for (const instanceId of MOSS_MANAGED_PROVIDER_INSTANCE_IDS) {
    const instance = providerInstances[instanceId];
    if (!isRecord(instance) || instance.enabled === false) continue;
    const config = instance.config;
    if (!isRecord(config)) continue;
    if (isMossAccessLane(config.realm)) return config.realm;
  }
  return null;
}

/**
 * The account's lane decides. Without an account the machine's time zone is the only signal: a
 * reachability probe would mislead, because official hosts often answer from mainland China while
 * their downloads stall.
 */
export function resolveMossDownloadChannel(input: {
  readonly lane: MossAccessLane | null;
  readonly timeZone: string;
}): MossDownloadChannel {
  if (input.lane) return LANE_DOWNLOAD_CHANNELS[input.lane];
  return MAINLAND_CHINA_TIME_ZONES.has(input.timeZone) ? "cn-mirror" : "official";
}
