import { afterEach, describe, expect, it, vi } from "vitest";

import {
  createMemFirePhoneAuth,
  createSupabaseGoogleAuth,
  createSupabaseMossAuth,
  SupabaseMossAuthError,
  type MemFirePhoneAuthClient,
  type SupabaseMossAuthClient,
  type SupabaseGoogleAuthClient,
} from "./supabaseMossAuth";

const configuredEnv = {
  MOSS_SUPABASE_URL: "https://moss-test.supabase.co/",
  MOSS_SUPABASE_PUBLISHABLE_KEY: "publishable-test-value",
  MOSS_AUTH_REDIRECT_URL: "moss://auth/callback",
  MOSS_MODEL_GATEWAY_URL: "https://moss-test.supabase.co/functions/v1/moss-models/",
};

const userPayload = {
  id: "user-1",
  email: "person@example.com",
  phone: null,
  role: "authenticated",
  aud: "authenticated",
  email_confirmed_at: "2026-07-12T00:00:00.000Z",
  created_at: "2026-07-12T00:00:00.000Z",
  updated_at: "2026-07-12T00:00:00.000Z",
  app_metadata: { provider: "email" },
  user_metadata: { display_name: "Person" },
};

const sessionPayload = {
  access_token: "access-value",
  refresh_token: "refresh-value",
  token_type: "bearer",
  expires_in: 3_600,
  expires_at: 1_800_000_000,
  user: userPayload,
};

const phoneUserPayload = {
  ...userPayload,
  email: null,
  // GoTrue returns E.164 phone values without the leading plus sign.
  phone: "8613800138000",
  email_confirmed_at: null,
  phone_confirmed_at: "2026-07-14T00:00:00.000Z",
  app_metadata: { provider: "phone", providers: ["phone"] },
};

const requireClient = (fetchImpl: typeof fetch, now = () => 100): SupabaseMossAuthClient => {
  const result = createSupabaseMossAuth({ env: configuredEnv, fetchImpl, now });
  if (!result.available) throw new Error(result.message);
  return result.client;
};

describe("createSupabaseMossAuth", () => {
  it("returns an explicit unavailable result when required configuration is missing", () => {
    const result = createSupabaseMossAuth({
      env: {},
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      available: false,
      reason: "missing_configuration",
      missing: ["MOSS_SUPABASE_URL", "MOSS_SUPABASE_PUBLISHABLE_KEY"],
    });
    expect(JSON.stringify(result)).not.toContain("undefined");
  });

  it.each([
    "https://user@moss-test.supabase.co/functions/v1/moss-models",
    "https://moss-test.supabase.co/functions/v1/moss-models?tenant=unsafe",
    "https://moss-test.supabase.co/functions/v1/moss-models#unsafe",
  ])("rejects gateway configuration with userinfo, query, or fragment data: %s", (value) => {
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_MODEL_GATEWAY_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      available: false,
      reason: "invalid_configuration",
      invalid: ["MOSS_MODEL_GATEWAY_URL"],
    });
  });

  it.each([
    "http://moss-test.supabase.co",
    "https://user@moss-test.supabase.co",
    "https://moss-test.supabase.co?tenant=unsafe",
    "https://moss-test.supabase.co#unsafe",
  ])("rejects unsafe Supabase base URL configuration: %s", (value) => {
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_SUPABASE_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      available: false,
      reason: "invalid_configuration",
      invalid: ["MOSS_SUPABASE_URL"],
    });
  });

  it.each([
    "javascript:alert(1)",
    "moss://auth/other",
    "moss://user@auth/callback",
    "moss://auth:1234/callback",
    "moss://auth/callback?code=preloaded",
    "https://user@moss.example/auth/callback",
    "http://moss.example/auth/callback",
  ])("rejects an unsafe authentication redirect URL: %s", (value) => {
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_AUTH_REDIRECT_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      available: false,
      reason: "invalid_configuration",
      invalid: ["MOSS_AUTH_REDIRECT_URL"],
    });
  });

  it.each(["http://localhost:54321", "http://127.0.0.1:54321", "http://[::1]:54321"])(
    "allows HTTP only for a loopback Supabase development URL: %s",
    (value) => {
      const result = createSupabaseMossAuth({
        env: { ...configuredEnv, MOSS_SUPABASE_URL: value },
        fetchImpl: vi.fn() as unknown as typeof fetch,
      });

      expect(result.available).toBe(true);
    },
  );

  it("rejects an unknown packaged cloud region", () => {
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_CLOUD_REGION: "auto" },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });
    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_configuration",
      invalid: ["MOSS_CLOUD_REGION"],
    });
  });

  it("verifies the Supabase project region before sending credentials", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return url.endsWith("/rest/v1/rpc/moss_get_public_cloud_region")
        ? new Response(JSON.stringify("cn"), { status: 200 })
        : new Response(JSON.stringify(sessionPayload), { status: 200 });
    }) as unknown as typeof fetch;
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_CLOUD_REGION: "cn" },
      fetchImpl,
    });
    if (!result.available) throw new Error(result.message);

    await expect(result.client.signin("person@example.com", "test-password")).resolves.toBeTruthy();
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "https://moss-test.supabase.co/rest/v1/rpc/moss_get_public_cloud_region",
      "https://moss-test.supabase.co/auth/v1/token?grant_type=password",
    ]);
    expect(result.client.config.cloudRegion).toBe("cn");
  });

  it("does not send credentials when the Supabase project belongs to another region", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify("global"), { status: 200 }),
    ) as unknown as typeof fetch;
    const result = createSupabaseMossAuth({
      env: { ...configuredEnv, MOSS_CLOUD_REGION: "cn" },
      fetchImpl,
    });
    if (!result.available) throw new Error(result.message);

    await expect(result.client.signin("person@example.com", "test-password")).rejects.toMatchObject(
      { code: "cloud_region_mismatch", retryable: false },
    );
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("normalizes a successful password signin and its absolute expiry", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify(sessionPayload), {
          status: 200,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const session = await client.signin(" PERSON@Example.COM ", "test-password");

    expect(session).toEqual({
      accessToken: "access-value",
      refreshToken: "refresh-value",
      tokenType: "bearer",
      expiresInSeconds: 3_600,
      expiresAt: 1_800_000_000_000,
      user: {
        id: "user-1",
        email: "person@example.com",
        phone: null,
        role: "authenticated",
        audience: "authenticated",
        emailConfirmedAt: "2026-07-12T00:00:00.000Z",
        phoneConfirmedAt: null,
        lastSignInAt: null,
        createdAt: "2026-07-12T00:00:00.000Z",
        updatedAt: "2026-07-12T00:00:00.000Z",
        appMetadata: { provider: "email" },
        userMetadata: { display_name: "Person" },
      },
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://moss-test.supabase.co/auth/v1/token?grant_type=password");
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "person@example.com",
      password: "test-password",
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe("publishable-test-value");
    expect(headers.get("authorization")).toBeNull();
    expect(client.config).toEqual({
      cloudRegion: null,
      supabaseUrl: "https://moss-test.supabase.co",
      redirectUrl: "moss://auth/callback",
      modelGatewayUrl: "https://moss-test.supabase.co/functions/v1/moss-models",
    });
    expect(JSON.stringify(client.config)).not.toContain("publishable-test-value");
  });

  it("starts a mainland phone OTP flow inside the dedicated Moss project", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    await expect(client.sendPhoneOtp("138 0013 8000")).resolves.toEqual({ accepted: true });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://moss-test.supabase.co/auth/v1/otp");
    expect(JSON.parse(String(init?.body))).toEqual({
      phone: "+8613800138000",
      create_user: true,
    });
    const headers = new Headers(init?.headers);
    expect(headers.get("apikey")).toBe("publishable-test-value");
    expect(headers.get("authorization")).toBeNull();
  });

  it("verifies a phone OTP into a Moss Supabase session", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...sessionPayload,
            user: phoneUserPayload,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const session = await client.verifyPhoneOtp("+86 138-0013-8000", "123456");

    expect(session.user).toMatchObject({
      id: "user-1",
      phone: "+8613800138000",
      phoneConfirmedAt: "2026-07-14T00:00:00.000Z",
    });
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://moss-test.supabase.co/auth/v1/verify");
    expect(JSON.parse(String(init?.body))).toEqual({
      phone: "+8613800138000",
      token: "123456",
      type: "sms",
    });
  });

  it("rejects phone verification when the returned identity does not match", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...sessionPayload,
            user: { ...phoneUserPayload, phone: "8613900139000" },
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    await expect(client.verifyPhoneOtp("13800138000", "123456")).rejects.toMatchObject({
      operation: "verify_phone_otp",
      code: "invalid_response",
    });
  });

  it("represents email-confirmation signup without inventing a session", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ user: userPayload, session: null }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const result = await client.signup(
      "person@example.com",
      "test-password",
      {
        codeChallenge: "signup-challenge",
        codeChallengeMethod: "s256",
      },
      " Moss Person ",
    );

    expect(result.user.id).toBe("user-1");
    expect(result.session).toBeNull();
    expect(result.confirmationRequired).toBe(true);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://moss-test.supabase.co/auth/v1/signup?redirect_to=moss%3A%2F%2Fauth%2Fcallback",
    );
    expect(JSON.parse(String(init?.body))).toMatchObject({
      email: "person@example.com",
      code_challenge: "signup-challenge",
      code_challenge_method: "s256",
      data: { display_name: "Moss Person" },
    });
  });

  it("starts password recovery with the caller's S256 PKCE challenge", async () => {
    const fetchImpl = vi.fn(
      async () => new Response("{}", { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    await client.recover("person@example.com", {
      codeChallenge: "recovery-challenge",
      codeChallengeMethod: "s256",
    });

    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe(
      "https://moss-test.supabase.co/auth/v1/recover?redirect_to=moss%3A%2F%2Fauth%2Fcallback",
    );
    expect(JSON.parse(String(init?.body))).toEqual({
      email: "person@example.com",
      code_challenge: "recovery-challenge",
      code_challenge_method: "s256",
    });
  });

  it("refreshes a session without exposing refresh values through configuration", async () => {
    const refreshedPayload = {
      ...sessionPayload,
      access_token: "rotated-access",
      refresh_token: "rotated-refresh",
      expires_at: undefined,
      expires_in: 120,
    };
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(refreshedPayload), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl, () => 5_000);

    const session = await client.refresh("original-refresh");

    expect(session.accessToken).toBe("rotated-access");
    expect(session.refreshToken).toBe("rotated-refresh");
    expect(session.expiresAt).toBe(125_000);
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://moss-test.supabase.co/auth/v1/token?grant_type=refresh_token");
    expect(JSON.parse(String(init?.body))).toEqual({
      refresh_token: "original-refresh",
    });
  });

  it("normalizes a GoTrue phone identity while refreshing a session", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            ...sessionPayload,
            user: phoneUserPayload,
          }),
          { status: 200 },
        ),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const session = await client.refresh("phone-refresh-token");

    expect(session.user.phone).toBe("+8613800138000");
    expect(session.user.phoneConfirmedAt).toBe("2026-07-14T00:00:00.000Z");
  });

  it("maps GoTrue invalid_grant refresh failures to an expired session", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ error: "invalid_grant" }), {
          status: 400,
          headers: { "Content-Type": "application/json" },
        }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    await expect(client.refresh("revoked-refresh-token")).rejects.toMatchObject({
      operation: "refresh",
      code: "session_expired",
      status: 400,
      retryable: false,
      message: "The authentication request was rejected.",
    });
  });

  it("normalizes a GoTrue phone identity returned by get-user", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify(phoneUserPayload), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const user = await client.getUser("phone-access-token");

    expect(user.phone).toBe("+8613800138000");
    const [url, init] = vi.mocked(fetchImpl).mock.calls[0] ?? [];
    expect(url).toBe("https://moss-test.supabase.co/auth/v1/user");
    expect(new Headers(init?.headers).get("authorization")).toBe("Bearer phone-access-token");
  });

  it("does not reinterpret a non-mainland phone as a mainland identity", async () => {
    const fetchImpl = vi.fn(
      async () =>
        new Response(JSON.stringify({ ...phoneUserPayload, phone: "14155552671" }), {
          status: 200,
        }),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    const user = await client.getUser("foreign-phone-access-token");

    expect(user.phone).toBe("14155552671");
  });

  it("normalizes server failures and never copies secrets into the error", async () => {
    const password = "password-must-not-leak";
    const token = "token-must-not-leak";
    const key = "key-must-not-leak";
    const fetchImpl = vi.fn(
      async () =>
        new Response(
          JSON.stringify({
            code: token,
            message: `bad password ${password}; apikey ${key}`,
            details: configuredEnv.MOSS_SUPABASE_PUBLISHABLE_KEY,
          }),
          { status: 401 },
        ),
    ) as unknown as typeof fetch;
    const client = requireClient(fetchImpl);

    let caught: unknown;
    try {
      await client.signin("person@example.com", password);
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(SupabaseMossAuthError);
    expect(caught).toMatchObject({
      operation: "signin",
      code: "http_401",
      status: 401,
      retryable: false,
      message: "The authentication request was not authorized.",
    });
    const serialized = `${String(caught)} ${JSON.stringify(caught)}`;
    for (const secret of [password, token, key, configuredEnv.MOSS_SUPABASE_PUBLISHABLE_KEY]) {
      expect(serialized).not.toContain(secret);
    }
  });

  it("aborts an authentication request that exceeds the configured timeout", async () => {
    let observedSignal: AbortSignal | undefined;
    const fetchImpl = vi.fn(
      async (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        await new Promise<Response>((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener(
            "abort",
            () => reject(new DOMException("aborted", "AbortError")),
            { once: true },
          );
        }),
    ) as unknown as typeof fetch;
    const result = createSupabaseMossAuth({
      env: configuredEnv,
      fetchImpl,
      timeoutMs: 5,
    });
    if (!result.available) throw new Error(result.message);

    await expect(result.client.signin("person@example.com", "test-password")).rejects.toMatchObject(
      {
        code: "network_error",
        retryable: true,
      },
    );
    expect(observedSignal?.aborted).toBe(true);
  });
});

const memFirePhoneEnv = {
  MOSS_MEMFIRE_PHONE_URL: "https://moss-cn.baseapi.memfiredb.com/",
  MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY: "memfire-public-test-value",
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
    "https://gateway.moss.example/functions/v1/moss-model-gateway/v1",
  MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL: "https://realtime-cn.moss.example/",
};

const supabaseGoogleEnv = {
  MOSS_SUPABASE_GOOGLE_URL: "https://moss-global.supabase.co/",
  MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY: "supabase-public-test-value",
  MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: "moss://auth/callback",
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL:
    "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
  MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL: "https://realtime-global.moss.example/",
};

const requireMemFirePhoneClient = (fetchImpl: typeof fetch): MemFirePhoneAuthClient => {
  const result = createMemFirePhoneAuth({ env: memFirePhoneEnv, fetchImpl });
  if (!result.available) throw new Error(result.message);
  return result.client;
};

const requireSupabaseGoogleClient = (fetchImpl: typeof fetch): SupabaseGoogleAuthClient => {
  const result = createSupabaseGoogleAuth({ env: supabaseGoogleEnv, fetchImpl });
  if (!result.available) throw new Error(result.message);
  return result.client;
};

describe("createMemFirePhoneAuth timeout bounds", () => {
  afterEach(() => vi.useRealTimers());

  it.each([
    [undefined, 60_000],
    [5_000, 5_000],
    [200_000, 120_000],
    [0, 1],
  ])("uses %s as the bounded request timeout", async (configured, expected) => {
    vi.useFakeTimers();
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0], init?: RequestInit) => {
      if (String(input).includes("moss_get_public_cloud_region")) {
        return new Response(JSON.stringify("cn"), { status: 200 });
      }
      await new Promise<void>((resolve) => {
        init?.signal?.addEventListener("abort", () => resolve(), { once: true });
      });
      throw new DOMException("aborted", "AbortError");
    }) as unknown as typeof fetch;
    const result = createMemFirePhoneAuth({
      env: memFirePhoneEnv,
      fetchImpl,
      ...(configured !== undefined ? { timeoutMs: configured } : {}),
    });
    if (!result.available) throw new Error(result.message);
    const request = result.client.sendPhoneOtp("13800138000");
    const rejection = expect(request).rejects.toMatchObject({ code: "network_error" });
    await vi.runAllTimersAsync();
    await rejection;
    expect(fetchImpl).toHaveBeenCalledTimes(2);
    expect(expected).toBeGreaterThanOrEqual(1);
  });
});

describe("createMemFirePhoneAuth", () => {
  it("reads only the dedicated MemFire phone realm environment", () => {
    const result = createMemFirePhoneAuth({
      env: {
        MOSS_SUPABASE_URL: "https://legacy.supabase.co",
        MOSS_SUPABASE_PUBLISHABLE_KEY: "legacy-key",
        ...supabaseGoogleEnv,
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "missing_configuration",
      missing: [
        "MOSS_MEMFIRE_PHONE_URL",
        "MOSS_MEMFIRE_PHONE_PUBLISHABLE_KEY",
        "MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL",
        "MOSS_MEMFIRE_PHONE_REALTIME_RELAY_URL",
      ],
    });
  });

  it.each([
    "https://project.supabase.co",
    "https://baseapi.memfiredb.com",
    "https://nested.project.baseapi.memfiredb.com",
    "https://project.baseapi.memfiredb.com.evil.example",
    "https://project.baseapi.memfiredb.com:8443",
    "https://project.baseapi.memfiredb.com/rest/v1",
  ])("rejects a non-project MemFire Auth origin: %s", (value) => {
    const result = createMemFirePhoneAuth({
      env: { ...memFirePhoneEnv, MOSS_MEMFIRE_PHONE_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_configuration",
      invalid: ["MOSS_MEMFIRE_PHONE_URL"],
    });
  });

  it("exposes only phone/session operations and non-secret realm routing", () => {
    const client = requireMemFirePhoneClient(vi.fn() as unknown as typeof fetch);

    expect(Object.keys(client).sort()).toEqual(
      ["config", "getUser", "logout", "refresh", "sendPhoneOtp", "verifyPhoneOtp"].sort(),
    );
    expect(client.config).toEqual({
      realm: "memfire-phone",
      issuer: "https://moss-cn.baseapi.memfiredb.com/auth/v1",
      cloudRegion: "cn",
      modelGatewayUrl: "https://gateway.moss.example/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime-cn.moss.example",
    });
    expect(JSON.stringify(client.config)).not.toContain("memfire-public-test-value");
  });

  it("allows an exact explicitly trusted 127.0.0.1 model-gateway origin for local acceptance", () => {
    const result = createMemFirePhoneAuth({
      env: {
        ...memFirePhoneEnv,
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
          "http://127.0.0.1:61891/functions/v1/moss-model-gateway/v1",
        MOSS_TRUSTED_MODEL_GATEWAY_ORIGINS: "http://127.0.0.1:61891",
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "available",
      config: {
        modelGatewayUrl: "http://127.0.0.1:61891/functions/v1/moss-model-gateway/v1",
      },
    });
  });

  it("rejects a loopback model gateway that is not explicitly trusted", () => {
    const result = createMemFirePhoneAuth({
      env: {
        ...memFirePhoneEnv,
        MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL:
          "http://127.0.0.1:61891/functions/v1/moss-model-gateway/v1",
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_configuration",
      invalid: ["MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL"],
    });
  });

  it("verifies remote region cn before sending a phone OTP to MemFire", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return url.endsWith("/rest/v1/rpc/moss_get_public_cloud_region")
        ? new Response(JSON.stringify("cn"), { status: 200 })
        : new Response("{}", { status: 200 });
    }) as unknown as typeof fetch;
    const client = requireMemFirePhoneClient(fetchImpl);

    await expect(client.sendPhoneOtp("13800138000")).resolves.toEqual({ accepted: true });
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "https://moss-cn.baseapi.memfiredb.com/rest/v1/rpc/moss_get_public_cloud_region",
      "https://moss-cn.baseapi.memfiredb.com/auth/v1/otp",
    ]);
  });

  it("does not send a phone number when the MemFire project declares another region", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify("global"), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireMemFirePhoneClient(fetchImpl);

    await expect(client.sendPhoneOtp("13800138000")).rejects.toMatchObject({
      code: "cloud_region_mismatch",
      retryable: false,
    });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it("rejects a mixed-provider user returned by the MemFire phone realm", async () => {
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      if (url.endsWith("/rest/v1/rpc/moss_get_public_cloud_region")) {
        return new Response(JSON.stringify("cn"), { status: 200 });
      }
      return new Response(
        JSON.stringify({
          ...sessionPayload,
          user: {
            ...userPayload,
            phone: "+8613800138000",
            phone_confirmed_at: "2026-08-14T00:00:00.000Z",
            app_metadata: { provider: "phone", providers: ["phone", "email"] },
          },
        }),
        { status: 200 },
      );
    }) as unknown as typeof fetch;
    const client = requireMemFirePhoneClient(fetchImpl);

    await expect(client.verifyPhoneOtp("13800138000", "123456")).rejects.toMatchObject({
      operation: "verify_phone_otp",
      code: "invalid_response",
    });
  });
});

describe("createSupabaseGoogleAuth", () => {
  it("reads only the dedicated Supabase Google realm environment", () => {
    const result = createSupabaseGoogleAuth({
      env: {
        MOSS_SUPABASE_URL: "https://legacy.supabase.co",
        MOSS_SUPABASE_PUBLISHABLE_KEY: "legacy-key",
        ...memFirePhoneEnv,
      },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "missing_configuration",
      missing: [
        "MOSS_SUPABASE_GOOGLE_URL",
        "MOSS_SUPABASE_GOOGLE_PUBLISHABLE_KEY",
        "MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL",
        "MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL",
        "MOSS_SUPABASE_GOOGLE_REALTIME_RELAY_URL",
      ],
    });
  });

  it.each([
    "https://project.baseapi.memfiredb.com",
    "https://supabase.co",
    "https://nested.project.supabase.co",
    "https://project.supabase.co.evil.example",
    "https://project.supabase.co:8443",
    "https://project.supabase.co/auth/v1",
  ])("rejects a non-project Supabase hosted Auth origin: %s", (value) => {
    const result = createSupabaseGoogleAuth({
      env: { ...supabaseGoogleEnv, MOSS_SUPABASE_GOOGLE_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_configuration",
      invalid: ["MOSS_SUPABASE_GOOGLE_URL"],
    });
  });

  it.each([
    "moss://auth/other",
    "moss://auth/callback/",
    "moss://auth/callback?next=unsafe",
    "https://auth.moss.example/callback",
    "http://localhost:3000/callback",
  ])("rejects a Google callback outside the desktop allowlist: %s", (value) => {
    const result = createSupabaseGoogleAuth({
      env: { ...supabaseGoogleEnv, MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL: value },
      fetchImpl: vi.fn() as unknown as typeof fetch,
    });

    expect(result).toMatchObject({
      status: "unavailable",
      reason: "invalid_configuration",
      invalid: ["MOSS_SUPABASE_GOOGLE_AUTH_REDIRECT_URL"],
    });
  });

  it("exposes only Google OAuth/session operations and non-secret realm routing", () => {
    const client = requireSupabaseGoogleClient(vi.fn() as unknown as typeof fetch);

    expect(Object.keys(client).sort()).toEqual(
      ["config", "createAuthorizeUrl", "exchangeCode", "getUser", "logout", "refresh"].sort(),
    );
    expect(client.config).toEqual({
      realm: "supabase-google",
      issuer: "https://moss-global.supabase.co/auth/v1",
      cloudRegion: "global",
      redirectUrl: "moss://auth/callback",
      modelGatewayUrl: "https://moss-global.supabase.co/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime-global.moss.example",
    });
    expect(JSON.stringify(client.config)).not.toContain("supabase-public-test-value");
  });

  it("creates a flow-bound Google authorize URL without overriding GoTrue state", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify("global"), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireSupabaseGoogleClient(fetchImpl);

    const authorizeUrl = await client.createAuthorizeUrl({
      flowId: "flow_abcdefghijklmnopqrstuvwxyz-0123456789",
      pkce: {
        codeChallenge: "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP",
        codeChallengeMethod: "s256",
      },
    });
    const parsed = new URL(authorizeUrl);
    expect(`${parsed.origin}${parsed.pathname}`).toBe(
      "https://moss-global.supabase.co/auth/v1/authorize",
    );
    expect(Object.fromEntries(parsed.searchParams)).toEqual({
      provider: "google",
      redirect_to: "moss://auth/callback?flow_id=flow_abcdefghijklmnopqrstuvwxyz-0123456789",
      code_challenge: "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP",
      code_challenge_method: "s256",
    });
    expect(parsed.searchParams.has("state")).toBe(false);
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "https://moss-global.supabase.co/rest/v1/rpc/moss_get_public_cloud_region",
    ]);
  });

  it("does not create an authorize URL when Supabase declares another region", async () => {
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify("cn"), { status: 200 }),
    ) as unknown as typeof fetch;
    const client = requireSupabaseGoogleClient(fetchImpl);

    await expect(
      client.createAuthorizeUrl({
        flowId: "flow_abcdefghijklmnopqrstuvwxyz-0123456789",
        pkce: {
          codeChallenge: "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP",
          codeChallengeMethod: "s256",
        },
      }),
    ).rejects.toMatchObject({ code: "cloud_region_mismatch", retryable: false });
    expect(fetchImpl).toHaveBeenCalledTimes(1);
  });

  it.each([
    {
      flowId: "short",
      pkce: {
        codeChallenge: "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP",
        codeChallengeMethod: "s256" as const,
      },
    },
    {
      flowId: "flow_abcdefghijklmnopqrstuvwxyz-0123456789",
      pkce: { codeChallenge: "not-long-enough", codeChallengeMethod: "s256" as const },
    },
  ])("rejects a weak flow id or PKCE before any network request", async (input) => {
    const fetchImpl = vi.fn() as unknown as typeof fetch;
    const client = requireSupabaseGoogleClient(fetchImpl);

    await expect(client.createAuthorizeUrl(input)).rejects.toMatchObject({
      operation: "authorize_google",
      code: "invalid_input",
    });
    expect(fetchImpl).not.toHaveBeenCalled();
  });

  it("exchanges a Google callback only with an RFC 7636 verifier", async () => {
    const googleUser = {
      ...userPayload,
      app_metadata: { provider: "google", providers: ["google"] },
    };
    const fetchImpl = vi.fn(async (input: Parameters<typeof fetch>[0]) => {
      const url = String(input);
      return url.endsWith("/rest/v1/rpc/moss_get_public_cloud_region")
        ? new Response(JSON.stringify("global"), { status: 200 })
        : new Response(JSON.stringify({ ...sessionPayload, user: googleUser }), { status: 200 });
    }) as unknown as typeof fetch;
    const client = requireSupabaseGoogleClient(fetchImpl);
    const verifier = "abcdefghijklmnopqrstuvwxyz-ABCDEFGHIJKLMNOP";

    await expect(client.exchangeCode("google-callback-code", verifier)).resolves.toMatchObject({
      user: { id: "user-1" },
    });
    expect(vi.mocked(fetchImpl).mock.calls.map(([url]) => String(url))).toEqual([
      "https://moss-global.supabase.co/rest/v1/rpc/moss_get_public_cloud_region",
      "https://moss-global.supabase.co/auth/v1/token?grant_type=pkce",
    ]);
    const [, init] = vi.mocked(fetchImpl).mock.calls[1] ?? [];
    expect(JSON.parse(String(init?.body))).toEqual({
      auth_code: "google-callback-code",
      code_verifier: verifier,
    });
  });
});
