import { describe, expect, it } from "vitest";

import {
  isMossAccessLaneSignedIn,
  mossAccessLaneSummary,
  mossAccessLaneSwitchTarget,
  resolveActiveMossAccessLane,
} from "./mossAccessLanes.logic";

const signedOut = {
  phone: { authenticated: false },
  cloud: { authenticated: false },
  enterprise: { authenticated: false, active: false },
} as const;

describe("Moss access lanes", () => {
  it("describes what each sign-in method can reach", () => {
    expect(mossAccessLaneSummary("cn")).toBe("国内模型 · 国内网络直连");
    expect(mossAccessLaneSummary("global")).toBe("全部模型 · 需要可访问海外的网络");
    expect(mossAccessLaneSummary("enterprise")).toBe("全部模型 · 国内网络直连");
  });

  it("reports the lane that owns the managed models", () => {
    expect(resolveActiveMossAccessLane(signedOut)).toBeNull();
    expect(
      resolveActiveMossAccessLane({
        ...signedOut,
        phone: { authenticated: true, activeRealm: "cn" },
      }),
    ).toBe("cn");
    expect(
      resolveActiveMossAccessLane({
        phone: { authenticated: true, activeRealm: "cn" },
        cloud: { authenticated: true, activeRealm: "global" },
        enterprise: { authenticated: true, active: true },
      }),
    ).toBe("enterprise");
    // A saved key that lost the surface is signed in but not active.
    expect(
      resolveActiveMossAccessLane({
        ...signedOut,
        cloud: { authenticated: true, activeRealm: "global" },
        enterprise: { authenticated: true, active: false },
      }),
    ).toBe("global");
  });

  it("keeps sign-in state per lane", () => {
    const states = { ...signedOut, enterprise: { authenticated: true, active: false } };
    expect(isMossAccessLaneSignedIn("enterprise", states)).toBe(true);
    expect(isMossAccessLaneSignedIn("cn", states)).toBe(false);
  });

  it("switches account lanes by realm and the key by activation", () => {
    expect(mossAccessLaneSwitchTarget("cn")).toEqual({ kind: "realm", realm: "cn" });
    expect(mossAccessLaneSwitchTarget("global")).toEqual({ kind: "realm", realm: "global" });
    expect(mossAccessLaneSwitchTarget("enterprise")).toEqual({ kind: "key" });
  });
});
