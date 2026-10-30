import { describe, expect, it, vi } from "vitest";

import {
  beginMossGoogleOAuth,
  requireSupabaseGoogleAuthorizationUrl,
} from "./mossGoogleOAuth.logic";

const flowId = "opaque-flow-value-12345678901234567";
const expiresAt = "2026-08-14T01:00:00.000Z";

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const url = new URL("https://project.supabase.co/auth/v1/authorize");
  const params = {
    provider: "google",
    redirect_to: `moss://auth/callback?flow_id=${flowId}`,
    code_challenge: "challenge-value-1234567890123456789012345678901234567890123",
    code_challenge_method: "s256",
    ...overrides,
  };
  for (const [name, value] of Object.entries(params)) url.searchParams.set(name, value);
  return url.toString();
}

describe("Moss Google OAuth browser boundary", () => {
  it("accepts only a flow-bound Supabase Google authorize URL without caller state", () => {
    expect(
      requireSupabaseGoogleAuthorizationUrl({
        authorizationUrl: authorizeUrl(),
        flowId,
        expiresAt,
        now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      }),
    ).toBe(authorizeUrl());

    for (const authorizationUrl of [
      "https://accounts.google.com/o/oauth2/v2/auth",
      "https://project.supabase.co.evil.example/auth/v1/authorize?provider=google",
      "http://project.supabase.co/auth/v1/authorize?provider=google",
      authorizeUrl({ provider: "github" }),
      authorizeUrl({
        redirect_to: "moss://auth/callback?flow_id=different-flow-value-123456789012345",
      }),
      authorizeUrl({ redirect_to: `moss://auth/callback/${flowId}` }),
      authorizeUrl({ state: "caller-state-is-forbidden" }),
      authorizeUrl({ code_challenge_method: "plain" }),
    ]) {
      expect(() =>
        requireSupabaseGoogleAuthorizationUrl({
          authorizationUrl,
          flowId,
          expiresAt,
          now: () => Date.parse("2026-08-14T00:00:00.000Z"),
        }),
      ).toThrow("Google sign-in could not be started safely.");
    }
  });

  it("never opens an unsafe or expired authorization result", async () => {
    const openExternal = vi.fn(async () => true);
    const unsafeStart = vi.fn(async () => ({
      authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth",
      flowId,
      expiresAt,
    }));

    await expect(
      beginMossGoogleOAuth({
        start: unsafeStart,
        openExternal,
        now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Google sign-in could not be started safely.");
    expect(openExternal).not.toHaveBeenCalled();

    await expect(
      beginMossGoogleOAuth({
        start: async () => ({ authorizationUrl: authorizeUrl(), flowId, expiresAt }),
        openExternal,
        now: () => Date.parse("2026-08-14T02:00:00.000Z"),
      }),
    ).rejects.toThrow("Google sign-in could not be started safely.");
    expect(openExternal).not.toHaveBeenCalled();
  });

  it("opens one validated URL and treats a refused native open as failure", async () => {
    const valid = authorizeUrl();
    const openExternal = vi.fn(async () => true);
    const onFlowOpened = vi.fn();

    await expect(
      beginMossGoogleOAuth({
        start: async () => ({ authorizationUrl: valid, flowId, expiresAt }),
        openExternal,
        onFlowOpened,
        now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      }),
    ).resolves.toBeUndefined();
    expect(openExternal).toHaveBeenCalledOnce();
    expect(openExternal).toHaveBeenCalledWith(valid);
    expect(onFlowOpened).toHaveBeenCalledWith({ flowId, expiresAt });

    await expect(
      beginMossGoogleOAuth({
        start: async () => ({ authorizationUrl: valid, flowId, expiresAt }),
        openExternal: async () => false,
        onFlowOpened,
        now: () => Date.parse("2026-08-14T00:00:00.000Z"),
      }),
    ).rejects.toThrow("Google sign-in could not be opened.");
    expect(onFlowOpened).toHaveBeenCalledOnce();
  });
});
