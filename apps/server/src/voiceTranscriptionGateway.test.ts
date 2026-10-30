import { DEFAULT_SERVER_SETTINGS, type ProviderInstanceId } from "@synara/contracts";
import { Effect, Option } from "effect";
import { describe, expect, it, vi } from "vitest";

import { MossAccountServiceError } from "./account/mossAccountErrors";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors";
import {
  assertServerResolvedVoiceRouteAuthority,
  resolveAdmittedVoicePrewarmProviderRoute,
  resolveAdmittedVoiceTranscriptionProviderRoute,
  resolveMossVoiceTranscriptionRoutes,
  resolveVoicePrewarmProviderRoute,
  resolveVoiceTranscriptionProviderRoute,
  VoiceAccountAdmissionError,
  type VoiceAccountAdmissionDependencies,
  VoiceTranscriptionProviderRouteError,
} from "./voiceTranscriptionGateway";

const PHONE_GATEWAY =
  "https://phone-project.baseapi.memfiredb.com/functions/v1/moss-model-gateway/v1";
const GOOGLE_GATEWAY = "https://google-project.supabase.co/functions/v1/moss-model-gateway/v1";
const STRICT_V2_ENV = {
  MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: PHONE_GATEWAY,
  MOSS_SUPABASE_GOOGLE_MODEL_GATEWAY_URL: GOOGLE_GATEWAY,
};

const phoneCredential = {
  realm: "memfire-phone" as const,
  issuer: "https://phone-project.baseapi.memfiredb.com/auth/v1",
  accessToken: "live-phone-token",
  gatewayBaseUrl: PHONE_GATEWAY,
  realtimeRelayUrl: "https://phone-relay.example.test",
};

const googleCredential = {
  realm: "supabase-google" as const,
  issuer: "https://google-project.supabase.co/auth/v1",
  accessToken: "live-google-token",
  gatewayBaseUrl: GOOGLE_GATEWAY,
  realtimeRelayUrl: "https://google-relay.example.test",
} as const;

const managedSettings = {
  ...DEFAULT_SERVER_SETTINGS,
  providerInstances: {
    ...DEFAULT_SERVER_SETTINGS.providerInstances,
    codex_moss: {
      driver: "codex" as const,
      enabled: true,
      config: {
        accountId: "moss",
        managed: true,
        runtimeGeneration: "managed-generation",
      },
      environment: [
        { name: "MOSS_ACCESS_TOKEN", value: "synthetic-account-token", sensitive: true },
      ],
    },
    codex_disabled: {
      driver: "codex" as const,
      enabled: false,
      config: {},
    },
    codex_byok: {
      driver: "codex" as const,
      enabled: true,
      config: {
        accountId: "byok",
        byok: true,
        mossByok: true,
        runtimeGeneration: "byok-generation",
      },
      environment: [{ name: "MOSS_BYOK_API_KEY", value: "synthetic-byok-token", sensitive: true }],
    },
    codex_forged_moss: {
      driver: "codex" as const,
      enabled: true,
      config: {
        accountId: "moss",
        managed: true,
        runtimeGeneration: "forged-generation",
      },
      environment: [
        { name: "MOSS_ACCESS_TOKEN", value: "synthetic-forged-token", sensitive: true },
      ],
    },
    codex_forged_byok: {
      driver: "codex" as const,
      enabled: true,
      config: {
        accountId: "byok",
        byok: true,
        mossByok: true,
        runtimeGeneration: "forged-generation",
      },
      environment: [
        { name: "MOSS_BYOK_API_KEY", value: "synthetic-forged-token", sensitive: true },
      ],
    },
  },
};

const phoneAuthenticationRequired = () =>
  Effect.fail(
    new MossAccountServiceError({
      code: "authentication_required",
      message: "Phone authentication is required.",
    }),
  );

const admittedDependencies = (
  input: Partial<VoiceAccountAdmissionDependencies> = {},
): VoiceAccountAdmissionDependencies => ({
  awaitAccountStartup: Effect.void,
  getSettings: () => Effect.succeed(managedSettings),
  getPhoneAuthorityCredential: () => Effect.succeed(phoneCredential),
  getCloudAuthorityCredential: () => Effect.succeed(googleCredential),
  environment: STRICT_V2_ENV,
  ...input,
});

describe("resolveMossVoiceTranscriptionRoutes", () => {
  it("uses the structured phone credential and its exact v2 realm gateway", async () => {
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        admittedDependencies(),
      ),
    );

    expect(
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
        env: STRICT_V2_ENV,
      }),
    ).toEqual({
      openRouter: null,
      mossGateway: {
        gatewayBaseUrl: PHONE_GATEWAY,
        token: "live-phone-token",
      },
    });
    expect(route.providerOptions?.codex?.environment).toBeUndefined();
  });

  it("bills voice notes to an active enterprise key ahead of a signed-in phone account", async () => {
    const enterpriseKey = `moss_sk_${"v".repeat(43)}`;
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        { provider: "codex", providerInstanceId: "codex_moss" as ProviderInstanceId },
        admittedDependencies({
          enterpriseKey: {
            getActiveAuthorityCredential: () =>
              Effect.succeed({
                realm: "moss-enterprise-key",
                issuer: "moss-enterprise-key",
                accessToken: enterpriseKey,
                gatewayBaseUrl: PHONE_GATEWAY,
                realtimeRelayUrl: "",
                accountId: "enterprise-test",
              }),
          },
        }),
      ),
    );

    expect(
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
        env: STRICT_V2_ENV,
      }),
    ).toEqual({
      openRouter: null,
      mossGateway: { gatewayBaseUrl: PHONE_GATEWAY, token: enterpriseKey },
    });
  });

  it("keeps the phone credential when the enterprise key does not own Moss", async () => {
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        { provider: "codex", providerInstanceId: "codex_moss" as ProviderInstanceId },
        admittedDependencies({
          enterpriseKey: { getActiveAuthorityCredential: () => Effect.succeed(null) },
        }),
      ),
    );

    expect(
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
        env: STRICT_V2_ENV,
      }).mossGateway?.token,
    ).toBe("live-phone-token");
  });

  it("fails closed for copied managed options because credential authority is process-local", async () => {
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        admittedDependencies(),
      ),
    );
    const copiedOptions = structuredClone(route.providerOptions?.codex);

    expect(() =>
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: route.providerInstanceId,
        ...(copiedOptions ? { codexOptions: copiedOptions } : {}),
        env: STRICT_V2_ENV,
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MOSS_VOICE_CREDENTIAL_UNAVAILABLE",
      }),
    );
  });

  it("does not admit a phone credential paired with the Google realm gateway", async () => {
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveAdmittedVoiceTranscriptionProviderRoute(
          {
            provider: "codex",
            providerInstanceId: "codex_moss" as ProviderInstanceId,
          },
          admittedDependencies({
            getPhoneAuthorityCredential: () =>
              Effect.succeed({ ...phoneCredential, gatewayBaseUrl: GOOGLE_GATEWAY }),
          }),
        ),
      ),
    );

    expect(observed).toMatchObject({ code: "VOICE_ACCOUNT_RECOVERY_REQUIRED", status: 503 });
  });

  it("does not restore the retired single-authority gateway or a snapshotted bearer", () => {
    expect(() =>
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: "codex_moss" as ProviderInstanceId,
        codexOptions: {
          accountId: "moss",
          runtimeGeneration: "restored-managed-generation",
          environment: { MOSS_ACCESS_TOKEN: "restored-account-token" },
        },
        env: { MOSS_MODEL_GATEWAY_URL: PHONE_GATEWAY },
      }),
    ).toThrowError(
      expect.objectContaining({
        code: "MOSS_VOICE_CREDENTIAL_UNAVAILABLE",
      }),
    );
  });

  it("never routes the retired Moss Key identity, even with its old credential", () => {
    expect(() =>
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: "codex_byok" as ProviderInstanceId,
        codexOptions: {
          accountId: "byok",
          runtimeGeneration: "byok-generation",
          environment: { MOSS_BYOK_API_KEY: "synthetic-byok-token" },
        },
        env: STRICT_V2_ENV,
      }),
    ).toThrow();
  });

  it("leaves unmanaged Codex sessions on the legacy ChatGPT route", () => {
    expect(
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: "codex_work" as ProviderInstanceId,
        codexOptions: { accountId: "work", environment: {} },
        env: STRICT_V2_ENV,
      }),
    ).toEqual({ mossGateway: null, openRouter: null });
  });
});

describe("resolveVoiceTranscriptionProviderRoute", () => {
  it("materializes only the managed Moss identity before live authority admission", () => {
    const route = resolveVoiceTranscriptionProviderRoute(managedSettings, {
      provider: "codex",
      providerInstanceId: "codex_moss" as ProviderInstanceId,
    });

    expect(route).toEqual({
      provider: "codex",
      providerInstanceId: "codex_moss",
      providerOptions: {
        codex: {
          accountId: "moss",
          runtimeGeneration: "managed-generation",
        },
      },
      serverResolvedVoiceRouteAuthority: expect.any(Object),
    });
    expect(() => JSON.stringify(route.serverResolvedVoiceRouteAuthority)).toThrow(
      "Server-resolved voice route authority cannot be serialized.",
    );
    expect(() => structuredClone(route.serverResolvedVoiceRouteAuthority)).toThrow();
  });

  it("preserves the legacy personal Codex route", () => {
    expect(
      resolveVoiceTranscriptionProviderRoute(DEFAULT_SERVER_SETTINGS, { provider: "codex" }),
    ).toEqual({ provider: "codex", providerInstanceId: "codex" });
  });

  it("rejects a leftover retired Moss Key instance instead of routing it", () => {
    expect(() =>
      resolveVoiceTranscriptionProviderRoute(managedSettings, {
        provider: "codex",
        providerInstanceId: "codex_byok" as ProviderInstanceId,
      }),
    ).toThrow(VoiceTranscriptionProviderRouteError);
  });

  it("keeps managed prewarm routing exact while stripping its credential environment", () => {
    const route = resolveVoicePrewarmProviderRoute(managedSettings, {
      provider: "codex",
      providerInstanceId: "codex_moss" as ProviderInstanceId,
    });

    expect(route).toEqual({
      provider: "codex",
      providerInstanceId: "codex_moss",
      providerOptions: {
        codex: {
          accountId: "moss",
          runtimeGeneration: "managed-generation",
        },
      },
      serverResolvedVoiceRouteAuthority: expect.any(Object),
    });
    expect(JSON.stringify(route.providerOptions)).not.toContain("synthetic-account-token");
    expect(() => JSON.stringify(route)).toThrow(
      "Server-resolved voice route authority cannot be serialized.",
    );
  });

  it("keeps personal Codex prewarm on the legacy account route", () => {
    expect(
      resolveVoicePrewarmProviderRoute(DEFAULT_SERVER_SETTINGS, { provider: "codex" }),
    ).toEqual({ provider: "codex", providerInstanceId: "codex" });
  });

  it("fails safely for unknown instances without echoing their identifier", () => {
    const observed = (() => {
      try {
        return resolveVoiceTranscriptionProviderRoute(managedSettings, {
          provider: "codex",
          providerInstanceId: "codex_missing_private" as ProviderInstanceId,
        });
      } catch (cause) {
        return cause;
      }
    })();

    expect(observed).toBeInstanceOf(VoiceTranscriptionProviderRouteError);
    expect(observed).toMatchObject({
      name: "VoiceTranscriptionProviderRouteError",
      code: "VOICE_PROVIDER_INSTANCE_UNAVAILABLE",
      message: "The selected voice transcription provider is unavailable.",
    });
    expect(String(observed)).not.toContain("codex_missing_private");
  });

  it.each([
    ["transcription", "codex_forged_moss", resolveVoiceTranscriptionProviderRoute],
    ["transcription", "codex_forged_byok", resolveVoiceTranscriptionProviderRoute],
    ["prewarm", "codex_forged_moss", resolveVoicePrewarmProviderRoute],
    ["prewarm", "codex_forged_byok", resolveVoicePrewarmProviderRoute],
  ] as const)(
    "rejects a non-reserved instance claiming a reserved account during %s",
    (_operation, providerInstanceId, resolveRoute) => {
      const observed = (() => {
        try {
          return resolveRoute(managedSettings, {
            provider: "codex",
            providerInstanceId: providerInstanceId as ProviderInstanceId,
          });
        } catch (cause) {
          return cause;
        }
      })();

      expect(observed).toBeInstanceOf(VoiceTranscriptionProviderRouteError);
      expect(observed).toMatchObject({
        code: "VOICE_RESERVED_PROVIDER_INSTANCE_INVALID",
        message: "The selected voice transcription provider is unavailable.",
      });
      expect(String(observed)).not.toContain(providerInstanceId);
    },
  );

  it("rejects disabled instances", () => {
    expect(() =>
      resolveVoiceTranscriptionProviderRoute(managedSettings, {
        provider: "codex",
        providerInstanceId: "codex_disabled" as ProviderInstanceId,
      }),
    ).toThrowError("The selected voice transcription provider is disabled.");
  });

  it("does not read settings while account startup admission is pending", async () => {
    const getSettings = vi.fn(() => Effect.succeed(managedSettings));
    const getPhoneAuthorityCredential = vi.fn(() => Effect.succeed(phoneCredential));
    const result = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        {
          awaitAccountStartup: Effect.never,
          getSettings,
          getPhoneAuthorityCredential,
          getCloudAuthorityCredential: () => Effect.succeed(googleCredential),
          environment: STRICT_V2_ENV,
        },
      ).pipe(Effect.timeoutOption(5)),
    );

    expect(Option.isNone(result)).toBe(true);
    expect(getSettings).not.toHaveBeenCalled();
    expect(getPhoneAuthorityCredential).not.toHaveBeenCalled();
  });

  it("returns a typed safe error when the startup gate is degraded", async () => {
    const privateFailure = "private startup cause ACCOUNT_SENTINEL";
    const getSettings = vi.fn(() => Effect.succeed(managedSettings));
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveAdmittedVoiceTranscriptionProviderRoute(
          {
            provider: "codex",
            providerInstanceId: "codex_moss" as ProviderInstanceId,
          },
          {
            awaitAccountStartup: Effect.fail(new Error(privateFailure)),
            getSettings,
            getPhoneAuthorityCredential: () => Effect.succeed(phoneCredential),
            getCloudAuthorityCredential: () => Effect.succeed(googleCredential),
            environment: STRICT_V2_ENV,
          },
        ),
      ),
    );

    expect(observed).toBeInstanceOf(VoiceAccountAdmissionError);
    expect(observed).toMatchObject({
      code: "VOICE_ACCOUNT_STARTUP_NOT_READY",
      retryable: true,
      status: 503,
    });
    expect(String(observed)).not.toContain(privateFailure);
    expect(getSettings).not.toHaveBeenCalled();
  });

  it("returns authentication-required only after both exact account authorities are signed out", async () => {
    const getCloudAuthorityCredential = vi.fn(() =>
      Effect.fail(
        new MossCloudAccountServiceError({
          code: "authentication_required",
          message: "Google authentication is required.",
        }),
      ),
    );
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveAdmittedVoiceTranscriptionProviderRoute(
          {
            provider: "codex",
            providerInstanceId: "codex_moss" as ProviderInstanceId,
          },
          {
            awaitAccountStartup: Effect.void,
            getSettings: () => Effect.succeed(managedSettings),
            getPhoneAuthorityCredential: phoneAuthenticationRequired,
            getCloudAuthorityCredential,
            environment: STRICT_V2_ENV,
          },
        ),
      ),
    );

    expect(observed).toMatchObject({
      code: "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
      status: 401,
    });
    expect(getCloudAuthorityCredential).toHaveBeenCalledTimes(1);
  });

  it("binds the structured phone credential without copying its bearer into provider options", async () => {
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        {
          awaitAccountStartup: Effect.void,
          getSettings: () => Effect.succeed(managedSettings),
          getPhoneAuthorityCredential: () => Effect.succeed(phoneCredential),
          getCloudAuthorityCredential: () => Effect.succeed(googleCredential),
          environment: STRICT_V2_ENV,
        },
      ),
    );

    expect(route.providerOptions?.codex?.environment).toBeUndefined();
    expect(JSON.stringify(route.providerOptions)).not.toContain("synthetic-account-token");
    expect(JSON.stringify(route.providerOptions)).not.toContain("live-phone-token");
    expect(() =>
      assertServerResolvedVoiceRouteAuthority({
        provider: route.provider,
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions ? { providerOptions: route.providerOptions } : {}),
        ...(route.serverResolvedVoiceRouteAuthority
          ? { serverResolvedVoiceRouteAuthority: route.serverResolvedVoiceRouteAuthority }
          : {}),
      }),
    ).not.toThrow();
  });

  it("falls back to Google only for the phone authority's exact authentication_required error", async () => {
    const getCloudAuthorityCredential = vi.fn(() => Effect.succeed(googleCredential));
    const route = await Effect.runPromise(
      resolveAdmittedVoiceTranscriptionProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        admittedDependencies({
          getPhoneAuthorityCredential: phoneAuthenticationRequired,
          getCloudAuthorityCredential,
        }),
      ),
    );

    expect(getCloudAuthorityCredential).toHaveBeenCalledTimes(1);
    expect(
      resolveMossVoiceTranscriptionRoutes({
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
        env: STRICT_V2_ENV,
      }),
    ).toEqual({
      openRouter: null,
      mossGateway: {
        gatewayBaseUrl: GOOGLE_GATEWAY,
        token: "live-google-token",
      },
    });
  });

  it("fails closed on every non-authentication phone failure without consulting Google", async () => {
    const getCloudAuthorityCredential = vi.fn(() => Effect.succeed(googleCredential));
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveAdmittedVoiceTranscriptionProviderRoute(
          {
            provider: "codex",
            providerInstanceId: "codex_moss" as ProviderInstanceId,
          },
          {
            awaitAccountStartup: Effect.void,
            getSettings: () => Effect.succeed(managedSettings),
            getPhoneAuthorityCredential: () =>
              Effect.fail(
                new MossAccountServiceError({
                  code: "authentication_service_unavailable",
                  message: "private phone outage detail",
                }),
              ),
            getCloudAuthorityCredential,
            environment: STRICT_V2_ENV,
          },
        ),
      ),
    );

    expect(observed).toMatchObject({ code: "VOICE_ACCOUNT_RECOVERY_REQUIRED", status: 503 });
    expect(String(observed)).not.toContain("private phone outage detail");
    expect(getCloudAuthorityCredential).not.toHaveBeenCalled();
  });

  it("does not treat an untyped authentication_required lookalike as fallback authority", async () => {
    const getCloudAuthorityCredential = vi.fn(() => Effect.succeed(googleCredential));
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveAdmittedVoiceTranscriptionProviderRoute(
          {
            provider: "codex",
            providerInstanceId: "codex_moss" as ProviderInstanceId,
          },
          admittedDependencies({
            getPhoneAuthorityCredential: () =>
              Effect.fail({
                code: "authentication_required",
                message: "untyped lookalike",
              } as never),
            getCloudAuthorityCredential,
          }),
        ),
      ),
    );

    expect(observed).toMatchObject({ code: "VOICE_ACCOUNT_RECOVERY_REQUIRED", status: 503 });
    expect(getCloudAuthorityCredential).not.toHaveBeenCalled();
  });

  it("validates managed prewarm against the live account but strips its bearer", async () => {
    const route = await Effect.runPromise(
      resolveAdmittedVoicePrewarmProviderRoute(
        {
          provider: "codex",
          providerInstanceId: "codex_moss" as ProviderInstanceId,
        },
        {
          awaitAccountStartup: Effect.void,
          getSettings: () => Effect.succeed(managedSettings),
          getPhoneAuthorityCredential: () => Effect.succeed(phoneCredential),
          getCloudAuthorityCredential: () => Effect.succeed(googleCredential),
          environment: STRICT_V2_ENV,
        },
      ),
    );

    expect(route.providerOptions).toEqual({
      codex: { accountId: "moss", runtimeGeneration: "managed-generation" },
    });
    expect(JSON.stringify(route.providerOptions)).not.toContain("live-phone-token");
    expect(() =>
      assertServerResolvedVoiceRouteAuthority({
        provider: route.provider,
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions ? { providerOptions: route.providerOptions } : {}),
        ...(route.serverResolvedVoiceRouteAuthority
          ? { serverResolvedVoiceRouteAuthority: route.serverResolvedVoiceRouteAuthority }
          : {}),
      }),
    ).not.toThrow();
  });
});
