import { describe, expect, it } from "vitest";

import {
  hasMossCloudAuthFieldErrors,
  mossCloudAuthErrorMessage,
  normalizeMossCloudEmail,
  parseMossCloudAuthRouteSearch,
  validateMossCloudPasswordUpdate,
  validateMossCloudSignIn,
  validateMossCloudSignUp,
} from "./mossCloudAuth.logic";

describe("Moss Cloud auth validation", () => {
  it("normalizes email without changing passwords", () => {
    expect(normalizeMossCloudEmail("  User@Example.COM ")).toBe("user@example.com");
    expect(
      validateMossCloudSignIn({
        email: " user@example.com ",
        password: "  secret  ",
      }),
    ).toEqual({ email: undefined, password: undefined });
  });

  it("rejects malformed signup fields at the client boundary", () => {
    const errors = validateMossCloudSignUp({
      displayName: "x".repeat(81),
      email: "not-an-email",
      password: "short",
    });

    expect(hasMossCloudAuthFieldErrors(errors)).toBe(true);
    expect(errors).toEqual({
      displayName: "Use no more than 80 characters.",
      email: "Enter a valid email address.",
      password: "Use at least 8 characters.",
    });
  });

  it("requires matching passwords only after the password itself is valid", () => {
    expect(
      validateMossCloudPasswordUpdate({
        password: "correct horse",
        confirmPassword: "wrong",
      }),
    ).toEqual({
      password: undefined,
      confirmPassword: "Passwords do not match.",
    });
  });
});

describe("Moss Cloud auth route and error normalization", () => {
  it("keeps only non-empty string search values", () => {
    expect(
      parseMossCloudAuthRouteSearch({
        code: "  abc ",
        flowId: " flow_abcdefghijklmnopqrstuvwxyz-0123456789 ",
        email: " user@example.com ",
        type: "recovery",
      }),
    ).toEqual({
      code: "abc",
      flowId: "flow_abcdefghijklmnopqrstuvwxyz-0123456789",
      email: "user@example.com",
      type: "recovery",
    });
    expect(parseMossCloudAuthRouteSearch({ code: 123, email: " " })).toEqual({});
  });

  it("drops oversized callback codes and email display hints", () => {
    expect(
      parseMossCloudAuthRouteSearch({
        code: "x".repeat(4_097),
        email: "e".repeat(321),
      }),
    ).toEqual({});
  });

  it("accepts only bounded opaque Google OAuth flow ids", () => {
    expect(parseMossCloudAuthRouteSearch({ flowId: "short" })).toEqual({});
    expect(parseMossCloudAuthRouteSearch({ flowId: "x".repeat(513) })).toEqual({});
    expect(
      parseMossCloudAuthRouteSearch({
        flowId: "flow_abcdefghijklmnopqrstuvwxyz-0123456789/unsafe",
      }),
    ).toEqual({});
  });

  it("uses safe, actionable messages instead of provider response bodies", () => {
    expect(mossCloudAuthErrorMessage(new Error("invalid_credentials"), "signIn")).toBe(
      "Email or password is incorrect.",
    );
    expect(
      mossCloudAuthErrorMessage(new Error("The email or password is incorrect."), "signIn"),
    ).toBe("Email or password is incorrect.");
    expect(mossCloudAuthErrorMessage(new Error("opaque upstream detail"), "signUp")).toBe(
      "Moss could not create the account. Try again in a moment.",
    );
    expect(mossCloudAuthErrorMessage(new Error("not_configured"), "signIn")).toBe(
      "Moss account sign-in isn’t available right now.",
    );
    expect(mossCloudAuthErrorMessage(new Error("network_error"), "signIn")).toBe(
      "Couldn’t connect to Moss. Check your connection and try again.",
    );
    expect(mossCloudAuthErrorMessage(new Error("opaque upstream detail"), "googleOAuth")).toBe(
      "Moss could not complete Google sign-in. Try again.",
    );
  });
});
