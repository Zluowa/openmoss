import { DEFAULT_SERVER_SETTINGS, type ServerVoiceTranscriptionInput } from "@moss/contracts";
import { OpenRouterVoiceTranscriptionError } from "@moss/shared/openRouterVoiceTranscription";
import { OutboundHttpError } from "@moss/shared/outboundHttp";
import { resolveSafeVoiceTranscriptionFailure } from "@moss/shared/voiceTranscriptionFailure";
import { Effect } from "effect";
import { describe, expect, it, vi } from "vitest";

import { MossAccountServiceError } from "./account/mossAccountErrors";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors";
import { ProviderAdapterRequestError } from "./provider/Errors";
import type { MossVoiceAccountState } from "./voiceTranscriptionGateway";
import {
  resolveMossVoiceAccountState,
  VoiceAccountAdmissionError,
  VoiceTranscriptionExecutionError,
} from "./voiceTranscriptionGateway";
import {
  isMossVoiceFallbackFailure,
  selectVoiceTranscriptionRoute,
  transcribeVoiceRequest,
  transcribeVoiceWithRouting,
} from "./voiceTranscriptionRouting";

const PHONE_GATEWAY =
  "https://phone-project.baseapi.memfiredb.com/functions/v1/moss-model-gateway/v1";
const STRICT_V2_ENV = { MOSS_MEMFIRE_PHONE_MODEL_GATEWAY_URL: PHONE_GATEWAY };
const MOSS_GATEWAY = { gatewayBaseUrl: PHONE_GATEWAY, token: "fake-moss-token" };
const signedIn: MossVoiceAccountState = { status: "signed-in", gateway: MOSS_GATEWAY };
const signedOut: MossVoiceAccountState = { status: "signed-out" };

/** What the Codex adapter raises when the app-server cannot reach OpenAI from mainland China. */
function outboundFailure(): ProviderAdapterRequestError {
  return new ProviderAdapterRequestError({
    provider: "codex",
    method: "voice/transcribe",
    detail: "Outbound request failed.",
    cause: new OutboundHttpError("request", "Outbound request failed.", new Error("ECONNRESET")),
  });
}

function routingHarness(input: {
  readonly accounts: readonly MossVoiceAccountState[];
  readonly personal?: Effect.Effect<{ readonly text: string }, unknown> | null;
  readonly moss?: Effect.Effect<{ readonly text: string }, unknown>;
}) {
  let accountIndex = 0;
  const resolveMossAccount = vi.fn(() => {
    const account = input.accounts[Math.min(accountIndex, input.accounts.length - 1)]!;
    accountIndex += 1;
    return account;
  });
  const transcribeWithMoss = vi.fn(
    (_gateway: typeof MOSS_GATEWAY) => input.moss ?? Effect.succeed({ text: "via moss" }),
  );
  const personalCalls = vi.fn();
  const personal =
    input.personal === undefined ? Effect.succeed({ text: "via personal" }) : input.personal;
  const run = () =>
    Effect.runPromise(
      transcribeVoiceWithRouting({
        resolveMossAccount: Effect.sync(resolveMossAccount),
        transcribeWithMoss,
        resolvePersonalTranscriber: Effect.succeed(
          personal === null
            ? null
            : () => {
                personalCalls();
                return personal;
              },
        ),
      }).pipe(Effect.result),
    );
  return { run, resolveMossAccount, transcribeWithMoss, personalCalls };
}

describe("selectVoiceTranscriptionRoute", () => {
  it.each([
    { mossAccount: "signed-in", personalProviderAvailable: true, route: "moss" },
    { mossAccount: "signed-in", personalProviderAvailable: false, route: "moss" },
    { mossAccount: "signed-out", personalProviderAvailable: true, route: "personal" },
    { mossAccount: "unavailable", personalProviderAvailable: true, route: "personal" },
    { mossAccount: "signed-out", personalProviderAvailable: false, route: "sign-in-required" },
    { mossAccount: "unavailable", personalProviderAvailable: false, route: "sign-in-required" },
  ] as const)(
    "$mossAccount Moss + personal=$personalProviderAvailable -> $route",
    ({ mossAccount, personalProviderAvailable, route }) => {
      expect(selectVoiceTranscriptionRoute({ mossAccount, personalProviderAvailable })).toBe(route);
    },
  );
});

describe("transcribeVoiceWithRouting", () => {
  it("Moss only: a signed-in Moss account transcribes even when a personal Codex works", async () => {
    const harness = routingHarness({ accounts: [signedIn] });

    const result = await harness.run();

    expect(result).toEqual(
      expect.objectContaining({ _tag: "Success", success: { text: "via moss" } }),
    );
    expect(harness.transcribeWithMoss).toHaveBeenCalledWith(MOSS_GATEWAY);
    expect(harness.personalCalls).not.toHaveBeenCalled();
  });

  it("personal ok: without a Moss account the personal provider transcribes on its own", async () => {
    const harness = routingHarness({ accounts: [signedOut] });

    const result = await harness.run();

    expect(result).toEqual(
      expect.objectContaining({ _tag: "Success", success: { text: "via personal" } }),
    );
    expect(harness.personalCalls).toHaveBeenCalledOnce();
    expect(harness.transcribeWithMoss).not.toHaveBeenCalled();
  });

  it("personal fails -> fallback: an outbound failure retries through the Moss gateway", async () => {
    const harness = routingHarness({
      // Moss finished restoring while the personal upload was failing.
      accounts: [
        {
          status: "unavailable",
          error: new VoiceAccountAdmissionError({
            code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
            message: "Moss voice is unavailable until account recovery completes.",
            retryable: true,
            status: 503,
          }),
        },
        signedIn,
      ],
      personal: Effect.fail(outboundFailure()),
    });

    const result = await harness.run();

    expect(result).toEqual(
      expect.objectContaining({ _tag: "Success", success: { text: "via moss" } }),
    );
    expect(harness.personalCalls).toHaveBeenCalledOnce();
    expect(harness.transcribeWithMoss).toHaveBeenCalledWith(MOSS_GATEWAY);
    expect(harness.resolveMossAccount).toHaveBeenCalledTimes(2);
  });

  it("personal fails without Moss: asks the person to sign in to Moss, never 'Provider adapter'", async () => {
    const harness = routingHarness({
      accounts: [signedOut],
      personal: Effect.fail(outboundFailure()),
    });

    const result = await harness.run();

    expect(result._tag).toBe("Failure");
    const failure = result._tag === "Failure" ? result.failure : null;
    expect(failure).toBeInstanceOf(VoiceAccountAdmissionError);
    expect(failure?.code).toBe("VOICE_ACCOUNT_AUTHENTICATION_REQUIRED");
    expect(failure?.message).not.toMatch(/provider adapter|outbound/iu);
    expect(
      resolveSafeVoiceTranscriptionFailure({ code: failure?.code, locale: "zh-CN" })?.message,
    ).toBe("登录 Moss 账号即可使用语音");
  });

  it("nothing signed in: returns the localized sign-in guidance without calling any service", async () => {
    const harness = routingHarness({ accounts: [signedOut], personal: null });

    const result = await harness.run();

    expect(result._tag).toBe("Failure");
    const failure = result._tag === "Failure" ? result.failure : null;
    expect(failure?.code).toBe("VOICE_ACCOUNT_AUTHENTICATION_REQUIRED");
    expect(harness.transcribeWithMoss).not.toHaveBeenCalled();
    expect(harness.personalCalls).not.toHaveBeenCalled();
  });

  it("keeps an expired personal sign-in as its own message instead of falling back", async () => {
    const harness = routingHarness({
      accounts: [signedOut, signedIn],
      personal: Effect.fail(
        new ProviderAdapterRequestError({
          provider: "codex",
          method: "voice/transcribe",
          detail: "Your ChatGPT login has expired. Sign in again.",
          cause: new OpenRouterVoiceTranscriptionError({
            code: "VOICE_CHATGPT_LOGIN_EXPIRED",
            message: "Your ChatGPT login has expired. Sign in again.",
            retryable: false,
            status: 401,
          }),
        }),
      ),
    });

    const result = await harness.run();

    const failure = result._tag === "Failure" ? result.failure : null;
    expect(failure).toBeInstanceOf(VoiceTranscriptionExecutionError);
    expect(failure?.code).toBe("VOICE_CHATGPT_LOGIN_EXPIRED");
    expect(harness.transcribeWithMoss).not.toHaveBeenCalled();
  });

  it("maps a Moss gateway failure to its stable code", async () => {
    const harness = routingHarness({
      accounts: [signedIn],
      moss: Effect.fail(
        new OpenRouterVoiceTranscriptionError({
          code: "MOSS_VOICE_GATEWAY_UNAVAILABLE",
          message: "Moss voice transcription is temporarily unavailable. Try again shortly.",
          retryable: true,
          status: 502,
        }),
      ),
    });

    const result = await harness.run();

    const failure = result._tag === "Failure" ? result.failure : null;
    expect(failure?.code).toBe("MOSS_VOICE_GATEWAY_UNAVAILABLE");
  });
});

describe("isMossVoiceFallbackFailure", () => {
  it("falls back for unreachable, timed-out and session-less personal providers", () => {
    expect(isMossVoiceFallbackFailure(outboundFailure())).toBe(true);
    expect(isMossVoiceFallbackFailure(new OutboundHttpError("timeout", "timed out"))).toBe(true);
    expect(
      isMossVoiceFallbackFailure(
        new Error("No ChatGPT session token is available. Sign in to ChatGPT in Codex."),
      ),
    ).toBe(true);
  });

  it("does not fall back for a cancelled upload or a bad recording", () => {
    expect(isMossVoiceFallbackFailure(new OutboundHttpError("aborted", "aborted"))).toBe(false);
    expect(
      isMossVoiceFallbackFailure(
        new OpenRouterVoiceTranscriptionError({
          code: "VOICE_AUDIO_INVALID",
          message: "The recorded audio is not a valid WAV file.",
          retryable: false,
        }),
      ),
    ).toBe(false);
  });
});

describe("resolveMossVoiceAccountState", () => {
  const phoneCredential = {
    realm: "memfire-phone" as const,
    issuer: "https://phone-project.baseapi.memfiredb.com/auth/v1",
    accessToken: "fake-moss-token",
    gatewayBaseUrl: PHONE_GATEWAY,
    realtimeRelayUrl: "https://phone-relay.example.test",
  };
  const cloudAuthenticationRequired = () =>
    Effect.fail(
      new MossCloudAccountServiceError({ code: "authentication_required", message: "Sign in." }),
    );
  const authenticationRequired = () =>
    Effect.fail(
      new MossAccountServiceError({ code: "authentication_required", message: "Sign in." }),
    );

  it("reports a signed-in phone account with its trusted gateway", async () => {
    await expect(
      Effect.runPromise(
        resolveMossVoiceAccountState({
          awaitAccountStartup: Effect.void,
          getPhoneAuthorityCredential: () => Effect.succeed(phoneCredential),
          getCloudAuthorityCredential: cloudAuthenticationRequired,
          environment: STRICT_V2_ENV,
        }),
      ),
    ).resolves.toEqual(signedIn);
  });

  it("reports signed-out only when both phone and Google need a sign-in", async () => {
    await expect(
      Effect.runPromise(
        resolveMossVoiceAccountState({
          awaitAccountStartup: Effect.void,
          getPhoneAuthorityCredential: authenticationRequired,
          getCloudAuthorityCredential: cloudAuthenticationRequired,
          environment: STRICT_V2_ENV,
        }),
      ),
    ).resolves.toEqual(signedOut);
  });

  it("never hands an untrusted gateway the account bearer", async () => {
    const state = await Effect.runPromise(
      resolveMossVoiceAccountState({
        awaitAccountStartup: Effect.void,
        getPhoneAuthorityCredential: () =>
          Effect.succeed({
            ...phoneCredential,
            gatewayBaseUrl: "https://attacker.example.test/functions/v1/moss-model-gateway/v1",
          }),
        getCloudAuthorityCredential: cloudAuthenticationRequired,
        environment: STRICT_V2_ENV,
      }),
    );
    expect(state.status).toBe("unavailable");
  });
});

describe("transcribeVoiceRequest", () => {
  const request: ServerVoiceTranscriptionInput = {
    provider: "codex",
    providerInstanceId: "codex_moss" as never,
    // A caller-supplied copy of provider options is never trusted or forwarded.
    providerOptions: { codex: { accountId: "forged" } },
    cwd: "/tmp/project",
    mimeType: "audio/wav",
    sampleRateHz: 24_000,
    durationMs: 250,
    audioBase64: "UklGRg==",
  };

  it("treats the Moss-managed instance as having no personal route when signed out", async () => {
    const transcribeVoice = vi.fn(() => Effect.succeed({ text: "unexpected" }));
    const result = await Effect.runPromise(
      transcribeVoiceRequest({
        request,
        account: {
          awaitAccountStartup: Effect.void,
          getPhoneAuthorityCredential: () =>
            Effect.fail(
              new MossAccountServiceError({ code: "authentication_required", message: "x" }),
            ),
          getCloudAuthorityCredential: () =>
            Effect.fail(
              new MossCloudAccountServiceError({ code: "authentication_required", message: "x" }),
            ),
        },
        getSettings: () =>
          Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              ...DEFAULT_SERVER_SETTINGS.providerInstances,
              codex_moss: {
                driver: "codex" as const,
                enabled: true,
                config: { accountId: "moss", managed: true, runtimeGeneration: "generation" },
              },
            },
          }),
        getAdapter: () => Effect.succeed({ transcribeVoice }),
      }).pipe(Effect.result),
    );

    expect(result._tag).toBe("Failure");
    expect(result._tag === "Failure" ? result.failure.code : null).toBe(
      "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
    );
    expect(transcribeVoice).not.toHaveBeenCalled();
  });

  it("routes a personal Codex instance with server-owned options when signed out", async () => {
    const transcribeVoice = vi.fn((_input: unknown) => Effect.succeed({ text: "personal" }));
    const result = await Effect.runPromise(
      transcribeVoiceRequest({
        request: { ...request, providerInstanceId: "codex_work" as never },
        account: {
          awaitAccountStartup: Effect.void,
          getPhoneAuthorityCredential: () =>
            Effect.fail(
              new MossAccountServiceError({ code: "authentication_required", message: "x" }),
            ),
          getCloudAuthorityCredential: () =>
            Effect.fail(
              new MossCloudAccountServiceError({ code: "authentication_required", message: "x" }),
            ),
        },
        getSettings: () =>
          Effect.succeed({
            ...DEFAULT_SERVER_SETTINGS,
            providerInstances: {
              ...DEFAULT_SERVER_SETTINGS.providerInstances,
              codex_work: {
                driver: "codex" as const,
                enabled: true,
                config: { homePath: "/tmp/codex-work" },
              },
            },
          }),
        getAdapter: () => Effect.succeed({ transcribeVoice }),
      }),
    );

    expect(result).toEqual({ text: "personal" });
    expect(transcribeVoice).toHaveBeenCalledWith(
      expect.objectContaining({
        providerInstanceId: "codex_work",
        providerOptions: { codex: { accountId: "codex_work", homePath: "/tmp/codex-work" } },
      }),
    );
  });
});
