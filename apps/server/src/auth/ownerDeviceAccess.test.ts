import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { signOutPhonesWhilePhoneAccessOff } from "./ownerDeviceAccess";
import { AuthError } from "./Services/ServerAuth";

const run = (
  config: Parameters<typeof signOutPhonesWhilePhoneAccessOff>[0],
  revokeOwnerDeviceAccess: () => Effect.Effect<number, AuthError>,
) => Effect.runPromise(signOutPhonesWhilePhoneAccessOff(config, { revokeOwnerDeviceAccess }));

describe("signOutPhonesWhilePhoneAccessOff", () => {
  it("signs paired phones out when the desktop starts with the switch off", async () => {
    const revoke = vi.fn(() => Effect.succeed(2));
    await run({ mode: "desktop", desktopPhoneAccess: false }, revoke);
    await run({ mode: "desktop", desktopPhoneAccess: undefined }, revoke);
    expect(revoke).toHaveBeenCalledTimes(2);
  });

  it("leaves phones alone while the switch is on, and outside the desktop app", async () => {
    const revoke = vi.fn(() => Effect.succeed(0));
    await run({ mode: "desktop", desktopPhoneAccess: true }, revoke);
    await run({ mode: "web", desktopPhoneAccess: false }, revoke);
    expect(revoke).not.toHaveBeenCalled();
  });

  it("never stops the backend from starting", async () => {
    await expect(
      run({ mode: "desktop" }, () =>
        Effect.fail(new AuthError({ message: "Failed to sign out paired phones.", status: 500 })),
      ),
    ).resolves.toBeUndefined();
  });
});
