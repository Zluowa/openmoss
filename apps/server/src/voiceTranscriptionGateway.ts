// FILE: voiceTranscriptionGateway.ts
// Purpose: Resolve the official Moss gateway voice-note route from server-owned state.
// Layer: Server-only credential routing

import {
  isTrustedMossManagedGatewayUrlForAuthority,
  type MossManagedGatewayAuthority,
} from "./provider/mossManagedGatewayTrust";
import type {
  ProviderInstanceId,
  ProviderKind,
  ProviderStartOptions,
  ServerSettings,
} from "@synara/contracts";
import {
  providerStartOptionsFromInstance,
  type ResolvedProviderInstance,
  resolveProviderInstance,
} from "@synara/shared/providerInstances";
import { OpenRouterVoiceTranscriptionError } from "@synara/shared/openRouterVoiceTranscription";
import { resolveSafeVoiceTranscriptionFailure } from "@synara/shared/voiceTranscriptionFailure";
import { Effect } from "effect";

import type { MossPhoneAccountServiceShape } from "./account/Services/MossPhoneAccountService";
import type { MossCloudAccountServiceShape } from "./account/Services/MossCloudAccountService";
import { MossAccountServiceError } from "./account/mossAccountErrors";
import {
  type MossActiveEnterpriseKeySource,
  type MossAuthorityCredential,
  preferActiveEnterpriseKeyCredential,
} from "./account/mossActiveAuthorityCredential";
import type { MossEnterpriseKeyError } from "./account/Services/MossEnterpriseKeyAccount";
import { MossCloudAccountServiceError } from "./account/mossCloudAccountErrors";
import { ProviderAdapterRequestError } from "./provider/Errors";

const MOSS_MANAGED_ACCOUNT_ID = "moss";
/** Retired Moss Key identity: still reserved so it can never route a voice note. */
const RETIRED_MOSS_BYOK_ACCOUNT_ID = "byok";

export class MossVoiceTranscriptionRouteError extends Error {
  readonly code: string;
  readonly retryable: boolean;

  constructor(code: string, message: string, retryable: boolean) {
    super(message);
    this.name = "MossVoiceTranscriptionRouteError";
    this.code = code;
    this.retryable = retryable;
  }
}

export class VoiceTranscriptionProviderRouteError extends Error {
  readonly code:
    | "VOICE_PROVIDER_INSTANCE_UNAVAILABLE"
    | "VOICE_PROVIDER_INSTANCE_DISABLED"
    | "VOICE_RESERVED_PROVIDER_INSTANCE_INVALID";

  constructor(
    code:
      | "VOICE_PROVIDER_INSTANCE_UNAVAILABLE"
      | "VOICE_PROVIDER_INSTANCE_DISABLED"
      | "VOICE_RESERVED_PROVIDER_INSTANCE_INVALID",
    message: string,
  ) {
    super(message);
    this.name = "VoiceTranscriptionProviderRouteError";
    this.code = code;
  }
}

export class VoiceAccountAdmissionError extends Error {
  readonly code:
    | "VOICE_ACCOUNT_STARTUP_NOT_READY"
    | "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED"
    | "VOICE_ACCOUNT_RECOVERY_REQUIRED";
  readonly retryable: boolean;
  readonly status: number;

  constructor(input: {
    readonly code:
      | "VOICE_ACCOUNT_STARTUP_NOT_READY"
      | "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED"
      | "VOICE_ACCOUNT_RECOVERY_REQUIRED";
    readonly message: string;
    readonly retryable: boolean;
    readonly status: number;
  }) {
    super(input.message);
    this.name = "VoiceAccountAdmissionError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

export class VoiceTranscriptionExecutionError extends Error {
  readonly code: string;
  readonly retryable: boolean;
  readonly status: number;

  constructor(
    input: {
      readonly code: string;
      readonly message: string;
      readonly retryable: boolean;
      readonly status: number;
    } = {
      code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
      message: "Voice transcription is temporarily unavailable. Try again shortly.",
      retryable: true,
      status: 502,
    },
  ) {
    super(input.message);
    this.name = "VoiceTranscriptionExecutionError";
    this.code = input.code;
    this.retryable = input.retryable;
    this.status = input.status;
  }
}

export function toVoiceTranscriptionExecutionError(
  cause: unknown,
): VoiceTranscriptionExecutionError {
  const typedCause =
    cause instanceof ProviderAdapterRequestError && cause.method === "voice/transcribe"
      ? cause.cause
      : cause;
  if (!(typedCause instanceof OpenRouterVoiceTranscriptionError)) {
    return new VoiceTranscriptionExecutionError();
  }
  const safe = resolveSafeVoiceTranscriptionFailure({
    code: typedCause.code,
    locale: "en",
    status: typedCause.status,
  });
  if (!safe) return new VoiceTranscriptionExecutionError();
  return new VoiceTranscriptionExecutionError({
    code: safe.code,
    message: safe.message,
    retryable: safe.retryable,
    status: safe.status,
  });
}

type ReservedMossVoiceRoute = "managed";

export interface ResolvedVoiceProviderRoute {
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions?: ProviderStartOptions;
  readonly serverResolvedVoiceRouteAuthority?: ServerResolvedVoiceRouteAuthority;
}

export interface VoiceAccountAdmissionDependencies {
  readonly awaitAccountStartup: Effect.Effect<void, unknown>;
  readonly getSettings: () => Effect.Effect<ServerSettings, unknown>;
  readonly getPhoneAuthorityCredential: MossPhoneAccountServiceShape["getAuthorityCredential"];
  readonly getCloudAuthorityCredential: MossCloudAccountServiceShape["getAuthorityCredential"];
  /** An active enterprise key pays for voice notes ahead of phone/Google. */
  readonly enterpriseKey?: MossActiveEnterpriseKeySource;
  readonly environment?: Readonly<Record<string, string | undefined>>;
}

export type MossVoiceAuthorityCredential = MossAuthorityCredential;

/** Process-local proof that a voice route was resolved from server-owned settings. */
export interface ServerResolvedVoiceRouteAuthority {
  readonly __serverResolvedVoiceRouteAuthority: never;
}

interface ServerResolvedVoiceRouteAuthorityRecord {
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions: ProviderStartOptions | undefined;
  readonly codexOptions: NonNullable<ProviderStartOptions["codex"]> | undefined;
  readonly managedCredential?: MossVoiceAuthorityCredential;
}

const serverResolvedVoiceRouteAuthorities = new WeakMap<
  ServerResolvedVoiceRouteAuthority,
  ServerResolvedVoiceRouteAuthorityRecord
>();
const managedVoiceCredentialByCodexOptions = new WeakMap<
  NonNullable<ProviderStartOptions["codex"]>,
  MossVoiceAuthorityCredential
>();

function issueServerResolvedVoiceRouteAuthority(
  record: ServerResolvedVoiceRouteAuthorityRecord,
): ServerResolvedVoiceRouteAuthority {
  const authority = Object.freeze(
    Object.create(null, {
      toJSON: {
        // Enumerable on purpose: structuredClone must observe the function and fail instead of
        // silently producing an authority-looking empty object.
        enumerable: true,
        value: () => {
          throw new Error("Server-resolved voice route authority cannot be serialized.");
        },
      },
    }),
  ) as ServerResolvedVoiceRouteAuthority;
  serverResolvedVoiceRouteAuthorities.set(authority, record);
  if (record.codexOptions && record.managedCredential) {
    managedVoiceCredentialByCodexOptions.set(record.codexOptions, record.managedCredential);
  }
  return authority;
}

function accountStartupNotReady(): VoiceAccountAdmissionError {
  return new VoiceAccountAdmissionError({
    code: "VOICE_ACCOUNT_STARTUP_NOT_READY",
    message: "Moss voice is waiting for account recovery to finish.",
    retryable: true,
    status: 503,
  });
}

function accountAuthenticationRequired(): VoiceAccountAdmissionError {
  return new VoiceAccountAdmissionError({
    code: "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED",
    message: "Sign in to your Moss account to use voice transcription.",
    retryable: false,
    status: 401,
  });
}

function accountRecoveryRequired(): VoiceAccountAdmissionError {
  return new VoiceAccountAdmissionError({
    code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
    message: "Moss voice is unavailable until account recovery completes.",
    retryable: true,
    status: 503,
  });
}

function isReservedVoiceInstanceId(value: string): boolean {
  return value === "codex_moss" || value === "codex_byok";
}

function isReservedVoiceAccountId(value: string): boolean {
  return value === MOSS_MANAGED_ACCOUNT_ID || value === RETIRED_MOSS_BYOK_ACCOUNT_ID;
}

export function voiceRouteRequiresServerAuthority(input: {
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexOptions?: NonNullable<ProviderStartOptions["codex"]>;
}): boolean {
  return (
    isReservedVoiceInstanceId(String(input.providerInstanceId ?? "").trim()) ||
    isReservedVoiceAccountId(
      input.providerOptions?.codex?.accountId?.trim() ??
        input.codexOptions?.accountId?.trim() ??
        "",
    )
  );
}

/**
 * Verifies the opaque authority and the exact objects produced by the settings resolver. Copies
 * and structurally identical objects remain untrusted because they can originate at public RPCs.
 */
export function assertServerResolvedVoiceRouteAuthority(input: {
  readonly provider: ProviderKind;
  readonly providerInstanceId?: ProviderInstanceId;
  readonly providerOptions?: ProviderStartOptions;
  readonly codexOptions?: NonNullable<ProviderStartOptions["codex"]>;
  readonly serverResolvedVoiceRouteAuthority?: ServerResolvedVoiceRouteAuthority;
}): void {
  if (!voiceRouteRequiresServerAuthority(input)) {
    return;
  }
  const authority = input.serverResolvedVoiceRouteAuthority;
  const record = authority ? serverResolvedVoiceRouteAuthorities.get(authority) : undefined;
  const exactOptionsMatch = input.providerOptions
    ? record?.providerOptions === input.providerOptions
    : record?.codexOptions === input.codexOptions;
  const codexOptions = input.providerOptions?.codex ?? input.codexOptions;
  const reservedRoute = resolveReservedMossVoiceRouteIdentity({
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    ...(codexOptions ? { codexOptions } : {}),
  });
  const exactManagedCredentialMatch =
    reservedRoute !== "managed" ||
    (codexOptions !== undefined &&
      record?.managedCredential !== undefined &&
      managedVoiceCredentialByCodexOptions.get(codexOptions) === record.managedCredential);
  if (
    !record ||
    record.provider !== input.provider ||
    record.providerInstanceId !== input.providerInstanceId ||
    !exactOptionsMatch ||
    !exactManagedCredentialMatch
  ) {
    throw invalidReservedVoiceProviderInstance();
  }
}

function invalidReservedVoiceProviderInstance(): VoiceTranscriptionProviderRouteError {
  return new VoiceTranscriptionProviderRouteError(
    "VOICE_RESERVED_PROVIDER_INSTANCE_INVALID",
    "The selected voice transcription provider is unavailable.",
  );
}

/**
 * Verifies the server-issued identity tuple carried from the exact settings-backed instance.
 * Account ids are routing metadata, never authority: a reserved account must also carry its
 * fixed provider-instance id and a non-empty generation minted by the account service.
 */
export function resolveReservedMossVoiceRouteIdentity(input: {
  readonly providerInstanceId?: ProviderInstanceId;
  readonly codexOptions?: {
    readonly accountId?: string | undefined;
    readonly runtimeGeneration?: string | undefined;
  };
}): ReservedMossVoiceRoute | null {
  const providerInstanceId = input.providerInstanceId
    ? String(input.providerInstanceId).trim()
    : "";
  const accountId = input.codexOptions?.accountId?.trim() ?? "";
  const runtimeGeneration = input.codexOptions?.runtimeGeneration?.trim() ?? "";
  const isReservedInstance =
    providerInstanceId === "codex_moss" || providerInstanceId === "codex_byok";
  const isReservedAccount =
    accountId === MOSS_MANAGED_ACCOUNT_ID || accountId === RETIRED_MOSS_BYOK_ACCOUNT_ID;

  if (!isReservedInstance && !isReservedAccount) {
    return null;
  }
  if (
    providerInstanceId === "codex_moss" &&
    accountId === MOSS_MANAGED_ACCOUNT_ID &&
    runtimeGeneration
  ) {
    return "managed";
  }
  throw invalidReservedVoiceProviderInstance();
}

function assertSettingsBackedReservedVoiceInstance(instance: ResolvedProviderInstance): void {
  if (instance.driver !== "codex") {
    return;
  }
  const reservedRoute = resolveReservedMossVoiceRouteIdentity({
    providerInstanceId: instance.instanceId,
    codexOptions: {
      ...(typeof instance.config.accountId === "string"
        ? { accountId: instance.config.accountId }
        : {}),
      ...(typeof instance.config.runtimeGeneration === "string"
        ? { runtimeGeneration: instance.config.runtimeGeneration }
        : {}),
    },
  });
  if (reservedRoute === "managed" && instance.config.managed !== true) {
    throw invalidReservedVoiceProviderInstance();
  }
}

/**
 * Resolves a voice-note request through the same settings-backed provider instance path for
 * both HTTP uploads and the compatibility WebSocket RPC. Provider options stay server-side.
 */
function resolveEnabledVoiceProviderInstance(
  settings: ServerSettings,
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
): ResolvedProviderInstance {
  const instance = resolveProviderInstance(settings, {
    provider: input.provider,
    ...(input.providerInstanceId ? { instanceId: input.providerInstanceId } : {}),
  });
  if (!instance || instance.driver !== input.provider) {
    throw new VoiceTranscriptionProviderRouteError(
      "VOICE_PROVIDER_INSTANCE_UNAVAILABLE",
      "The selected voice transcription provider is unavailable.",
    );
  }
  assertSettingsBackedReservedVoiceInstance(instance);
  if (!instance.enabled) {
    throw new VoiceTranscriptionProviderRouteError(
      "VOICE_PROVIDER_INSTANCE_DISABLED",
      "The selected voice transcription provider is disabled.",
    );
  }
  return instance;
}

function credentialFreeManagedProviderOptions(
  instance: ResolvedProviderInstance,
  providerOptions: ProviderStartOptions | undefined,
): ProviderStartOptions | undefined {
  const codexOptions = providerOptions?.codex;
  if (
    instance.driver !== "codex" ||
    !codexOptions ||
    resolveReservedMossVoiceRouteIdentity({
      providerInstanceId: instance.instanceId,
      codexOptions,
    }) !== "managed"
  ) {
    return providerOptions;
  }
  return {
    codex: {
      ...(codexOptions.accountId ? { accountId: codexOptions.accountId } : {}),
      ...(codexOptions.runtimeGeneration
        ? { runtimeGeneration: codexOptions.runtimeGeneration }
        : {}),
    },
  };
}

export function resolveVoiceTranscriptionProviderRoute(
  settings: ServerSettings,
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
): ResolvedVoiceProviderRoute {
  const instance = resolveEnabledVoiceProviderInstance(settings, input);
  const providerOptions = credentialFreeManagedProviderOptions(
    instance,
    providerStartOptionsFromInstance(instance),
  );
  const authority = voiceRouteRequiresServerAuthority({
    providerInstanceId: instance.instanceId,
    ...(providerOptions ? { providerOptions } : {}),
  })
    ? issueServerResolvedVoiceRouteAuthority({
        provider: instance.driver,
        providerInstanceId: instance.instanceId,
        providerOptions,
        codexOptions: providerOptions?.codex,
      })
    : undefined;
  return {
    provider: instance.driver,
    providerInstanceId: instance.instanceId,
    ...(providerOptions ? { providerOptions } : {}),
    ...(authority ? { serverResolvedVoiceRouteAuthority: authority } : {}),
  };
}

function reservedRouteFromResolvedRoute(
  route: ResolvedVoiceProviderRoute,
): ReservedMossVoiceRoute | null {
  return resolveReservedMossVoiceRouteIdentity({
    providerInstanceId: route.providerInstanceId,
    ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
  });
}

function withManagedAuthorityCredential(
  route: ResolvedVoiceProviderRoute,
  credential: MossVoiceAuthorityCredential,
): ResolvedVoiceProviderRoute {
  const codexOptions = route.providerOptions?.codex;
  if (!codexOptions || reservedRouteFromResolvedRoute(route) !== "managed") {
    throw invalidReservedVoiceProviderInstance();
  }
  const providerOptions: ProviderStartOptions = {
    ...route.providerOptions,
    codex: {
      ...(codexOptions.accountId ? { accountId: codexOptions.accountId } : {}),
      ...(codexOptions.runtimeGeneration
        ? { runtimeGeneration: codexOptions.runtimeGeneration }
        : {}),
    },
  };
  const boundCredential = Object.freeze({
    ...credential,
    issuer: credential.issuer.trim(),
    accessToken: credential.accessToken.trim(),
    gatewayBaseUrl: credential.gatewayBaseUrl.trim(),
    realtimeRelayUrl: credential.realtimeRelayUrl.trim(),
  }) as MossVoiceAuthorityCredential;
  const authority = issueServerResolvedVoiceRouteAuthority({
    provider: route.provider,
    providerInstanceId: route.providerInstanceId,
    providerOptions,
    codexOptions: providerOptions.codex,
    managedCredential: boundCredential,
  });
  return {
    provider: route.provider,
    providerInstanceId: route.providerInstanceId,
    providerOptions,
    serverResolvedVoiceRouteAuthority: authority,
  };
}

function resolveManagedVoiceAuthorityCredential(
  dependencies: VoiceAccountAdmissionDependencies,
): Effect.Effect<
  MossVoiceAuthorityCredential,
  MossAccountServiceError | MossCloudAccountServiceError | MossEnterpriseKeyError
> {
  return preferActiveEnterpriseKeyCredential(dependencies.enterpriseKey, () =>
    resolveAccountVoiceAuthorityCredential(dependencies),
  );
}

function resolveAccountVoiceAuthorityCredential(
  dependencies: VoiceAccountAdmissionDependencies,
): Effect.Effect<
  MossVoiceAuthorityCredential,
  MossAccountServiceError | MossCloudAccountServiceError
> {
  return dependencies.getPhoneAuthorityCredential().pipe(
    Effect.flatMap((credential) =>
      credential.realm === "memfire-phone"
        ? Effect.succeed<MossVoiceAuthorityCredential>(credential)
        : Effect.fail(
            new MossAccountServiceError({
              code: "invalid_authentication_response",
              message: "The phone account authority is invalid.",
            }),
          ),
    ),
    Effect.catch(
      (
        error,
      ): Effect.Effect<
        MossVoiceAuthorityCredential,
        MossAccountServiceError | MossCloudAccountServiceError
      > =>
        error instanceof MossAccountServiceError && error.code === "authentication_required"
          ? dependencies.getCloudAuthorityCredential().pipe(
              Effect.flatMap((credential) =>
                credential.realm === "supabase-google"
                  ? Effect.succeed<MossVoiceAuthorityCredential>(credential)
                  : Effect.fail(
                      new MossCloudAccountServiceError({
                        code: "provider_error",
                        message: "The Google account authority is invalid.",
                      }),
                    ),
              ),
            )
          : Effect.fail(error),
    ),
  );
}

function resolveRouteSafely(
  settings: ServerSettings,
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
  prewarm: boolean,
): Effect.Effect<ResolvedVoiceProviderRoute, VoiceTranscriptionProviderRouteError> {
  return Effect.try({
    try: () =>
      prewarm
        ? resolveVoicePrewarmProviderRoute(settings, input)
        : resolveVoiceTranscriptionProviderRoute(settings, input),
    catch: (cause) =>
      cause instanceof VoiceTranscriptionProviderRouteError
        ? cause
        : invalidReservedVoiceProviderInstance(),
  });
}

/**
 * Admits voice from one live, structured authority credential, never from a credential-bearing
 * settings snapshot alone. The phone authority is preferred; Google is consulted only when phone
 * returns the exact typed authentication_required result. Every other phone failure fails closed.
 */
function resolveAdmittedVoiceProviderRoute(
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
  dependencies: VoiceAccountAdmissionDependencies,
  prewarm: boolean,
): Effect.Effect<
  ResolvedVoiceProviderRoute,
  VoiceAccountAdmissionError | VoiceTranscriptionProviderRouteError
> {
  return Effect.gen(function* () {
    yield* dependencies.awaitAccountStartup.pipe(Effect.mapError(() => accountStartupNotReady()));
    const initialSettings = yield* dependencies
      .getSettings()
      .pipe(Effect.mapError(() => accountRecoveryRequired()));
    // Resolve the credential-free prewarm shape first. A stale managed bearer is therefore never
    // even materialized before live account validation. Non-managed transcription routes are
    // resolved normally only after this classification proves they are outside the phone lane.
    const initialRoute = yield* resolveRouteSafely(initialSettings, input, true);
    if (reservedRouteFromResolvedRoute(initialRoute) !== "managed") {
      return prewarm ? initialRoute : yield* resolveRouteSafely(initialSettings, input, false);
    }

    const credentialResult = yield* resolveManagedVoiceAuthorityCredential(dependencies).pipe(
      Effect.result,
    );
    if (credentialResult._tag === "Failure") {
      const failure = credentialResult.failure;
      if (
        (failure instanceof MossAccountServiceError ||
          failure instanceof MossCloudAccountServiceError) &&
        failure.code === "authentication_required"
      ) {
        return yield* Effect.fail(accountAuthenticationRequired());
      }
      return yield* Effect.fail(accountRecoveryRequired());
    }
    const credential = credentialResult.success;
    if (
      !credential.issuer.trim() ||
      /[\r\n]/u.test(credential.issuer) ||
      !credential.accessToken.trim() ||
      /[\r\n]/u.test(credential.accessToken) ||
      !credential.gatewayBaseUrl.trim() ||
      /[\r\n]/u.test(credential.gatewayBaseUrl)
    ) {
      return yield* Effect.fail(accountRecoveryRequired());
    }
    if (
      !isTrustedMossManagedGatewayUrlForAuthority(
        credential.gatewayBaseUrl,
        credential.realm,
        dependencies.environment ?? process.env,
      )
    ) {
      return yield* Effect.fail(accountRecoveryRequired());
    }

    // Credential resolution may refresh account state and rotate the managed provider generation.
    // Resolve the exact identity shape again before binding the credential process-locally.
    const latestSettings = yield* dependencies
      .getSettings()
      .pipe(Effect.mapError(() => accountRecoveryRequired()));
    const latestRoute = yield* resolveRouteSafely(latestSettings, input, prewarm);
    if (reservedRouteFromResolvedRoute(latestRoute) !== "managed") {
      return yield* Effect.fail(accountRecoveryRequired());
    }
    const admitted = withManagedAuthorityCredential(latestRoute, credential);
    if (!prewarm) return admitted;

    const admittedCodexOptions = admitted.providerOptions?.codex;
    if (!admittedCodexOptions) return yield* Effect.fail(accountRecoveryRequired());
    const boundCredential = managedVoiceCredentialByCodexOptions.get(admittedCodexOptions);
    if (!boundCredential) return yield* Effect.fail(accountRecoveryRequired());
    const safeProviderOptions: ProviderStartOptions = {
      ...admitted.providerOptions,
      codex: {
        accountId: admittedCodexOptions.accountId,
        ...(admittedCodexOptions.runtimeGeneration
          ? { runtimeGeneration: admittedCodexOptions.runtimeGeneration }
          : {}),
      },
    };
    return {
      provider: admitted.provider,
      providerInstanceId: admitted.providerInstanceId,
      providerOptions: safeProviderOptions,
      serverResolvedVoiceRouteAuthority: issueServerResolvedVoiceRouteAuthority({
        provider: admitted.provider,
        providerInstanceId: admitted.providerInstanceId,
        providerOptions: safeProviderOptions,
        codexOptions: safeProviderOptions.codex,
        managedCredential: boundCredential,
      }),
    };
  });
}

export function resolveAdmittedVoiceTranscriptionProviderRoute(
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
  dependencies: VoiceAccountAdmissionDependencies,
) {
  return resolveAdmittedVoiceProviderRoute(input, dependencies, false);
}

export function resolveAdmittedVoicePrewarmProviderRoute(
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
  dependencies: VoiceAccountAdmissionDependencies,
) {
  return resolveAdmittedVoiceProviderRoute(input, dependencies, true);
}

/**
 * Resolves the identical settings-backed instance as transcription while keeping managed Moss
 * and OpenRouter credentials out of the prewarm call. Personal Codex instances retain their
 * account-routing options because their bounded ChatGPT auth discovery still needs them.
 */
export function resolveVoicePrewarmProviderRoute(
  settings: ServerSettings,
  input: {
    readonly provider: ProviderKind;
    readonly providerInstanceId?: ProviderInstanceId;
  },
): {
  readonly provider: ProviderKind;
  readonly providerInstanceId: ProviderInstanceId;
  readonly providerOptions?: ProviderStartOptions;
  readonly serverResolvedVoiceRouteAuthority?: ServerResolvedVoiceRouteAuthority;
} {
  const instance = resolveEnabledVoiceProviderInstance(settings, input);
  const providerOptions = providerStartOptionsFromInstance(instance);
  const codexAccountId = providerOptions?.codex?.accountId?.trim();
  const runtimeGeneration = providerOptions?.codex?.runtimeGeneration?.trim();
  const safeProviderOptions =
    instance.driver === "codex" &&
    (codexAccountId === MOSS_MANAGED_ACCOUNT_ID || codexAccountId === RETIRED_MOSS_BYOK_ACCOUNT_ID)
      ? {
          codex: {
            accountId: codexAccountId,
            ...(runtimeGeneration ? { runtimeGeneration } : {}),
          },
        }
      : providerOptions;
  const authority = voiceRouteRequiresServerAuthority({
    providerInstanceId: instance.instanceId,
    ...(safeProviderOptions ? { providerOptions: safeProviderOptions } : {}),
  })
    ? issueServerResolvedVoiceRouteAuthority({
        provider: instance.driver,
        providerInstanceId: instance.instanceId,
        providerOptions: safeProviderOptions,
        codexOptions: safeProviderOptions?.codex,
      })
    : undefined;
  return {
    provider: instance.driver,
    providerInstanceId: instance.instanceId,
    ...(safeProviderOptions ? { providerOptions: safeProviderOptions } : {}),
    ...(authority ? { serverResolvedVoiceRouteAuthority: authority } : {}),
  };
}

export function resolveMossVoiceTranscriptionRoutes(input: {
  readonly providerInstanceId?: ProviderInstanceId;
  readonly codexOptions?: {
    readonly accountId?: string | undefined;
    readonly runtimeGeneration?: string | undefined;
    readonly environment?: Readonly<Record<string, string>> | undefined;
  };
  readonly env?: Readonly<Record<string, string | undefined>>;
}): {
  readonly mossGateway: { readonly gatewayBaseUrl: string; readonly token: string } | null;
  readonly openRouter: { readonly baseUrl: string; readonly token: string } | null;
} {
  const reservedRoute = resolveReservedMossVoiceRouteIdentity({
    ...(input.providerInstanceId ? { providerInstanceId: input.providerInstanceId } : {}),
    ...(input.codexOptions ? { codexOptions: input.codexOptions } : {}),
  });
  const env = input.env ?? process.env;
  if (reservedRoute === "managed") {
    const codexOptions = input.codexOptions;
    const credential = codexOptions
      ? managedVoiceCredentialByCodexOptions.get(codexOptions)
      : undefined;
    if (!credential) {
      throw new MossVoiceTranscriptionRouteError(
        "MOSS_VOICE_CREDENTIAL_UNAVAILABLE",
        "Moss voice requires a live server-resolved account credential.",
        false,
      );
    }
    const authority: MossManagedGatewayAuthority = credential.realm;
    if (!isTrustedMossManagedGatewayUrlForAuthority(credential.gatewayBaseUrl, authority, env)) {
      throw new MossVoiceTranscriptionRouteError(
        "MOSS_VOICE_GATEWAY_UNAVAILABLE",
        "Moss voice transcription is not configured for this installation.",
        false,
      );
    }
    return {
      openRouter: null,
      mossGateway: {
        gatewayBaseUrl: credential.gatewayBaseUrl,
        token: credential.accessToken,
      },
    };
  }

  return { mossGateway: null, openRouter: null };
}
