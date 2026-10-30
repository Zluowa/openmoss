import { Schema } from "effect";
import { describe, expect, it } from "vitest";

import {
  MossCloudAccountState,
  MossCloudExchangeGoogleOAuthCodeInput,
  MossCloudStartGoogleOAuthResult,
} from "./mossCloudAccount";

describe("Moss Google OAuth contracts", () => {
  it("accepts only the explicit Supabase Google account authority", () => {
    const decodeState = Schema.decodeUnknownSync(MossCloudAccountState);
    const state = {
      configured: true,
      authenticated: false,
      account: null,
      session: null,
      emailVerificationRequired: false,
      modelGatewayConfigured: true,
      authProvider: "supabase_google",
      lastAuthFlow: "google",
    } as const;

    expect(decodeState(state)).toEqual(state);
    expect(() => decodeState({ ...state, authProvider: "supabase" })).toThrow();
  });

  it("keeps the flow-bound OAuth start result bounded and renderer-safe", () => {
    const decode = Schema.decodeUnknownSync(MossCloudStartGoogleOAuthResult);
    const result = {
      authorizationUrl:
        "https://project.supabase.co/auth/v1/authorize?provider=google&redirect_to=moss%3A%2F%2Fauth%2Fcallback%3Fflow_id%3Dopaque-flow-value-12345678901234567",
      flowId: "opaque-flow-value-12345678901234567",
      expiresAt: "2026-08-14T01:00:00.000Z",
    } as const;

    expect(decode(result)).toEqual(result);
    expect(() =>
      decode({ ...result, authorizationUrl: "https://accounts.google.com/o/oauth2/v2/auth" }),
    ).toThrow();
    expect(() => decode({ ...result, flowId: "short" })).toThrow();
  });

  it("requires both code and flow id for the Google callback exchange", () => {
    const decode = Schema.decodeUnknownSync(MossCloudExchangeGoogleOAuthCodeInput);
    const input = {
      code: "one-time-code",
      flowId: "opaque-flow-value-12345678901234567",
    } as const;

    expect(decode(input)).toEqual(input);
    expect(() => decode({ code: input.code })).toThrow();
    expect(() => decode({ flowId: input.flowId })).toThrow();
    expect(() => decode({ ...input, flowId: "short" })).toThrow();
  });
});
