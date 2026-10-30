import { describe, expect, it } from "vitest";

import { isMossGoogleOAuthExternalUrl } from "./mossGoogleOAuthExternalUrl";

const flowId = "flow_abcdefghijklmnopqrstuvwxyz-0123456789";
const challenge = "challenge-value-1234567890123456789012345678901234567890123";

function authorizeUrl(overrides: Record<string, string> = {}): string {
  const url = new URL("https://project.supabase.co/auth/v1/authorize");
  for (const [name, value] of Object.entries({
    provider: "google",
    redirect_to: `moss://auth/callback?flow_id=${flowId}`,
    code_challenge: challenge,
    code_challenge_method: "s256",
    ...overrides,
  })) {
    url.searchParams.set(name, value);
  }
  return url.toString();
}

describe("Moss Google OAuth external URL", () => {
  it("recognizes only the configured flow-bound Supabase Google authorization URL", () => {
    expect(isMossGoogleOAuthExternalUrl(authorizeUrl(), "https://project.supabase.co")).toBe(true);

    for (const value of [
      "https://accounts.google.com/o/oauth2/v2/auth",
      authorizeUrl().replace("project.supabase.co", "other.supabase.co"),
      authorizeUrl({ provider: "github" }),
      authorizeUrl({ redirect_to: "moss://auth/callback?flow_id=short" }),
      authorizeUrl({ redirect_to: `moss://auth/callback/${flowId}` }),
      authorizeUrl({ code_challenge_method: "plain" }),
      authorizeUrl({ code_challenge: "short" }),
    ]) {
      expect(isMossGoogleOAuthExternalUrl(value, "https://project.supabase.co")).toBe(false);
    }
  });

  it("rejects duplicate parameters and invalid configured origins", () => {
    const duplicate = new URL(authorizeUrl());
    duplicate.searchParams.append("provider", "google");

    expect(isMossGoogleOAuthExternalUrl(duplicate.toString(), "https://project.supabase.co")).toBe(
      false,
    );
    expect(isMossGoogleOAuthExternalUrl(authorizeUrl(), undefined)).toBe(false);
    expect(isMossGoogleOAuthExternalUrl(authorizeUrl(), "http://project.supabase.co")).toBe(false);
  });
});
