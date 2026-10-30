// FILE: mossAccessLanes.logic.ts
// Purpose: One description of the three Moss sign-in lanes for every account
// surface (login, account page, settings). The lane itself — gateway realm and
// model scope — is defined in @synara/shared/mossRealmCatalog.
import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@synara/contracts";
import { MOSS_ACCESS_LANE_SPECS, type MossAccessLane } from "@synara/shared/mossRealmCatalog";

export interface MossAccessLaneCopy {
  /** How the user signs in. */
  readonly method: string;
  /** Which models the lane serves. */
  readonly models: string;
  /** What network the lane needs. */
  readonly network: string;
}

export const MOSS_ACCESS_LANE_COPY: Readonly<Record<MossAccessLane, MossAccessLaneCopy>> = {
  cn: { method: "手机号", models: "国内模型", network: "国内网络直连" },
  global: { method: "Google 账号", models: "全部模型", network: "需要可访问海外的网络" },
  enterprise: { method: "企业 API Key", models: "全部模型", network: "国内网络直连" },
};

export function mossAccessLaneSummary(lane: MossAccessLane): string {
  const copy = MOSS_ACCESS_LANE_COPY[lane];
  return `${copy.models} · ${copy.network}`;
}

export interface MossAccessLaneStates {
  readonly phone: Pick<MossAccountSessionState, "authenticated" | "activeRealm"> | null | undefined;
  readonly cloud: Pick<MossCloudAccountState, "authenticated" | "activeRealm"> | null | undefined;
  readonly enterprise: Pick<MossEnterpriseKeyState, "authenticated" | "active"> | null | undefined;
}

export function isMossAccessLaneSignedIn(lane: MossAccessLane, states: MossAccessLaneStates) {
  switch (lane) {
    case "cn":
      return states.phone?.authenticated === true;
    case "global":
      return states.cloud?.authenticated === true;
    case "enterprise":
      return states.enterprise?.authenticated === true;
  }
}

/**
 * The lane that owns the managed Moss models right now. Only one lane is
 * active at a time; the most recent explicit sign-in or switch wins.
 */
export function resolveActiveMossAccessLane(states: MossAccessLaneStates): MossAccessLane | null {
  if (states.enterprise?.authenticated && states.enterprise.active) return "enterprise";
  if (states.cloud?.authenticated && states.cloud.activeRealm === "global") return "global";
  if (states.phone?.authenticated && states.phone.activeRealm === "cn") return "cn";
  return null;
}

/** Account sessions switch by realm; the enterprise key switches by activation. */
export function mossAccessLaneSwitchTarget(
  lane: MossAccessLane,
): { readonly kind: "realm"; readonly realm: "cn" | "global" } | { readonly kind: "key" } {
  return lane === "enterprise"
    ? { kind: "key" }
    : { kind: "realm", realm: MOSS_ACCESS_LANE_SPECS[lane].realm };
}
