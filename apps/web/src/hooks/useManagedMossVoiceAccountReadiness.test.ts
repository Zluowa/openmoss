import { describe, expect, it } from "vitest";

import { resolveManagedMossVoiceAccountReadiness } from "./useManagedMossVoiceAccountReadiness";

const signedOut = {
  applies: true,
  accountIdentity: null,
  accountTransitionPending: false,
  phoneAccountPending: false,
  cloudAccountPending: false,
  phoneAccountError: false,
  cloudAccountError: false,
} as const;

describe("resolveManagedMossVoiceAccountReadiness", () => {
  it("lets an enterprise key that owns Moss use voice without a phone or Google account", () => {
    expect(resolveManagedMossVoiceAccountReadiness(signedOut)).toBe("authentication-required");
    expect(
      resolveManagedMossVoiceAccountReadiness({ ...signedOut, enterpriseKeyActive: true }),
    ).toBe("ready");
  });

  it("keeps a saved but inactive key from bypassing the account requirement", () => {
    expect(
      resolveManagedMossVoiceAccountReadiness({ ...signedOut, enterpriseKeyActive: false }),
    ).toBe("authentication-required");
  });
});
