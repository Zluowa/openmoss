import { describe, expect, it } from "vitest";

import {
  resolveMossCloudCallbackDestination,
  shouldGuardMossCloudAccountRoute,
} from "./mossCloudAuthRoutes.logic";

describe("Moss Cloud auth route policy", () => {
  it("routes only from the trusted PKCE flow returned by the account service", () => {
    expect(
      resolveMossCloudCallbackDestination({
        authenticated: true,
        lastAuthFlow: "recovery",
      }),
    ).toEqual({ to: "/reset-password" });
    expect(
      resolveMossCloudCallbackDestination({
        authenticated: true,
        lastAuthFlow: "signup",
      }),
    ).toEqual({ to: "/account" });
    expect(
      resolveMossCloudCallbackDestination({
        authenticated: true,
        lastAuthFlow: "google",
      }),
    ).toEqual({ to: "/", freshChat: true });
  });

  it("does not invent a destination for an untrusted or unauthenticated callback", () => {
    expect(
      resolveMossCloudCallbackDestination({
        authenticated: false,
        lastAuthFlow: "recovery",
      }),
    ).toBeNull();
    expect(
      resolveMossCloudCallbackDestination({
        authenticated: true,
        lastAuthFlow: null,
      }),
    ).toBeNull();
  });

  it("requires a Moss login before a configured profile can enter the app", () => {
    expect(
      shouldGuardMossCloudAccountRoute({
        configured: true,
        authenticated: false,
      }),
    ).toBe(true);
  });

  it("accepts either an authenticated cloud or mainland-phone Moss session", () => {
    expect(
      shouldGuardMossCloudAccountRoute({
        configured: true,
        authenticated: true,
      }),
    ).toBe(false);
    expect(
      shouldGuardMossCloudAccountRoute({
        configured: true,
        authenticated: false,
      }),
    ).toBe(true);
    expect(
      shouldGuardMossCloudAccountRoute(
        { configured: true, authenticated: false },
        { configured: true, authenticated: true },
      ),
    ).toBe(false);
  });

  it("guards a configured domestic Moss account until the phone session is authenticated", () => {
    expect(
      shouldGuardMossCloudAccountRoute(
        { configured: false, authenticated: false },
        { configured: true, authenticated: false },
      ),
    ).toBe(true);
  });

  it("does not force account sign-in when cloud auth is unavailable", () => {
    expect(
      shouldGuardMossCloudAccountRoute({
        configured: false,
        authenticated: false,
      }),
    ).toBe(false);
  });
});
