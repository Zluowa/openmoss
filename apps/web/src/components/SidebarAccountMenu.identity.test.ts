import type {
  MossAccountSessionState,
  MossCloudAccountState,
  MossEnterpriseKeyState,
} from "@moss/contracts";
import { describe, expect, it } from "vitest";

import { resolveSidebarAccountIdentity, resolveSidebarAccountLane } from "./SidebarAccountMenu";

const phone = {
  configured: true,
  authenticated: true,
  smsProvider: "aliyun",
  aliyunSmsConfigured: true,
  session: {
    id: "moss_phone_session",
    user: {
      id: "user-phone",
      phoneNumber: "+8613800138000",
      displayName: null,
      role: "member",
      status: "active",
      createdAt: "2026-11-01T00:00:00.000Z",
      updatedAt: "2026-11-01T00:00:00.000Z",
      lastLoginAt: "2026-11-01T00:00:00.000Z",
    },
    createdAt: "2026-11-01T00:00:00.000Z",
    expiresAt: "2026-11-01T01:00:00.000Z",
    lastSeenAt: "2026-11-01T00:00:00.000Z",
  },
} as unknown as MossAccountSessionState;

const cloud = {
  configured: true,
  authenticated: true,
  account: {
    id: "user-google",
    email: "person@example.com",
    emailVerified: true,
    displayName: "Person",
    status: "active",
    createdAt: "2026-11-01T00:00:00.000Z",
    updatedAt: "2026-11-01T00:00:00.000Z",
    lastLoginAt: "2026-11-01T00:00:00.000Z",
  },
  session: null,
  emailVerificationRequired: false,
  modelGatewayConfigured: true,
  authProvider: "supabase_google",
} as unknown as MossCloudAccountState;

const enterprise = {
  configured: true,
  authenticated: true,
  keyPrefix: "moss_sk_abcd",
  verifiedAt: "2026-11-01T00:00:00.000Z",
  modelCount: 18,
  active: false,
} as MossEnterpriseKeyState;

const identity = (input: {
  readonly phoneState?: MossAccountSessionState;
  readonly state?: MossCloudAccountState;
  readonly enterpriseState?: MossEnterpriseKeyState;
}) =>
  resolveSidebarAccountIdentity({
    phoneState: input.phoneState,
    enterpriseState: input.enterpriseState,
    state: input.state,
    accounts: [],
    pending: false,
    unavailable: false,
  });

describe("Sidebar account footer with more than one signed-in lane", () => {
  it("names the lane that provides the models, not whichever signed in first", () => {
    const usingKey = identity({
      phoneState: phone,
      enterpriseState: { ...enterprise, active: true },
    });
    expect(usingKey.label).toBe("企业 API Key");

    const usingGoogle = identity({
      phoneState: phone,
      state: { ...cloud, activeRealm: "global" },
      enterpriseState: enterprise,
    });
    expect(usingGoogle.label).toBe("Person");

    const usingPhone = identity({
      phoneState: { ...phone, activeRealm: "cn" },
      state: cloud,
      enterpriseState: enterprise,
    });
    expect(usingPhone.label).toBe("+86 138****8000");
  });

  it("targets sign-out at that same lane", () => {
    expect(
      resolveSidebarAccountLane({
        phone,
        cloud: null,
        enterprise: { ...enterprise, active: true },
      }),
    ).toBe("enterprise");
    expect(
      resolveSidebarAccountLane({
        phone,
        cloud: { ...cloud, activeRealm: "global" },
        enterprise: null,
      }),
    ).toBe("global");
  });

  it("falls back to phone, Google, then key while no lane owns the models", () => {
    expect(resolveSidebarAccountLane({ phone, cloud, enterprise })).toBe("cn");
    expect(resolveSidebarAccountLane({ phone: null, cloud, enterprise })).toBe("global");
    expect(resolveSidebarAccountLane({ phone: null, cloud: null, enterprise })).toBe("enterprise");
    expect(resolveSidebarAccountLane({ phone: null, cloud: null, enterprise: null })).toBeNull();
  });
});
