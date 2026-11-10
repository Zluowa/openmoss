// FILE: voiceTranscriptionRouting.ts
// Purpose: Decide which service transcribes a voice note: the signed-in Moss account, the
//          selected personal provider, or neither (ask the person to sign in to Moss).
// Layer: Server voice routing
// Exports: selectVoiceTranscriptionRoute, isMossVoiceFallbackFailure,
//          transcribeVoiceWithRouting, transcribeVoiceRequest
// Depends on: voiceTranscriptionGateway (account state, safe errors), voiceTranscription (Moss
//             gateway upload), provider adapters (personal transcription).

import type {
  ProviderInstanceId,
  ProviderKind,
  ServerSettings,
  ServerVoiceTranscriptionInput,
  ServerVoiceTranscriptionResult,
} from "@moss/contracts";
import { OpenRouterVoiceTranscriptionError } from "@moss/shared/openRouterVoiceTranscription";
import { OutboundHttpError } from "@moss/shared/outboundHttp";
import { Effect } from "effect";

import { ProviderAdapterRequestError } from "./provider/Errors";
import type { ProviderAdapterShape } from "./provider/Services/ProviderAdapter";
import { transcribeVoiceWithMossGateway } from "./voiceTranscription";
import {
  type MossVoiceAccountState,
  resolveMossVoiceAccountState,
  resolveReservedMossVoiceRouteIdentity,
  resolveVoiceTranscriptionProviderRoute,
  toVoiceTranscriptionExecutionError,
  type VoiceAccountAdmissionDependencies,
  type VoiceAccountAdmissionError,
  voiceAccountAuthenticationRequired,
  type VoiceTranscriptionExecutionError,
} from "./voiceTranscriptionGateway";

export type VoiceTranscriptionRoute = "moss" | "personal" | "sign-in-required";

/**
 * The routing table. A signed-in Moss account always wins, for every provider and CLI, because
 * its gateway is reachable from mainland China. Without one, the selected personal provider
 * transcribes on its own account; with neither, the person is asked to sign in to Moss.
 */
export function selectVoiceTranscriptionRoute(input: {
  readonly mossAccount: MossVoiceAccountState["status"];
  readonly personalProviderAvailable: boolean;
}): VoiceTranscriptionRoute {
  if (input.mossAccount === "signed-in") return "moss";
  if (input.personalProviderAvailable) return "personal";
  return "sign-in-required";
}

/** Failures that are about the recording or the person's own sign-in, not about reachability. */
const PERSONAL_FAILURES_WITHOUT_FALLBACK: ReadonlySet<string> = new Set([
  "VOICE_AUDIO_INVALID",
  "VOICE_AUDIO_TOO_LONG",
  "MOSS_VOICE_AUDIO_TOO_LARGE",
  "VOICE_CHATGPT_LOGIN_EXPIRED",
  "VOICE_CHATGPT_REJECTED",
]);

function unwrapProviderFailure(cause: unknown): unknown {
  let current = cause;
  for (let depth = 0; depth < 4; depth += 1) {
    if (current instanceof ProviderAdapterRequestError) {
      current = current.cause;
      continue;
    }
    break;
  }
  return current;
}

function findOutboundHttpError(cause: unknown): OutboundHttpError | null {
  let current: unknown = cause;
  for (let depth = 0; depth < 6 && current; depth += 1) {
    if (current instanceof OutboundHttpError) return current;
    current =
      typeof current === "object" && current !== null && "cause" in current
        ? (current as { readonly cause?: unknown }).cause
        : undefined;
  }
  return null;
}

/**
 * True when a personal provider could not deliver the transcript for reasons the Moss gateway
 * can fix: the upstream was unreachable (the usual case in mainland China, where the Codex
 * app-server talks to OpenAI directly), timed out, was overloaded, or the provider had no usable
 * session. A bad recording or an expired personal sign-in is reported as is.
 */
export function isMossVoiceFallbackFailure(cause: unknown): boolean {
  const failure = unwrapProviderFailure(cause);
  const outbound = findOutboundHttpError(failure);
  if (outbound) return outbound.code !== "aborted";
  if (failure instanceof OpenRouterVoiceTranscriptionError) {
    return !PERSONAL_FAILURES_WITHOUT_FALLBACK.has(failure.code);
  }
  return true;
}

export interface VoiceTranscriptionRoutingDependencies {
  readonly resolveMossAccount: Effect.Effect<MossVoiceAccountState>;
  readonly transcribeWithMoss: (gateway: {
    readonly gatewayBaseUrl: string;
    readonly token: string;
  }) => Effect.Effect<ServerVoiceTranscriptionResult, unknown>;
  /** Resolves to null when the selected provider cannot transcribe on a personal account. */
  readonly resolvePersonalTranscriber: Effect.Effect<
    (() => Effect.Effect<ServerVoiceTranscriptionResult, unknown>) | null
  >;
}

export type VoiceTranscriptionRoutingError =
  | VoiceAccountAdmissionError
  | VoiceTranscriptionExecutionError;

function signInOrAccountError(account: MossVoiceAccountState): VoiceAccountAdmissionError {
  return account.status === "unavailable" ? account.error : voiceAccountAuthenticationRequired();
}

/**
 * Runs the routing table. Every failure leaves as a typed error with a stable code, so callers
 * never forward provider wording (for example "Provider adapter request failed") to the UI.
 */
export function transcribeVoiceWithRouting(
  dependencies: VoiceTranscriptionRoutingDependencies,
): Effect.Effect<ServerVoiceTranscriptionResult, VoiceTranscriptionRoutingError> {
  const viaMoss = (gateway: { readonly gatewayBaseUrl: string; readonly token: string }) =>
    dependencies
      .transcribeWithMoss(gateway)
      .pipe(Effect.mapError((cause) => toVoiceTranscriptionExecutionError(cause)));

  return Effect.gen(function* () {
    const account = yield* dependencies.resolveMossAccount;
    if (account.status === "signed-in") {
      return yield* viaMoss(account.gateway);
    }
    const personal = yield* dependencies.resolvePersonalTranscriber;
    const route = selectVoiceTranscriptionRoute({
      mossAccount: account.status,
      personalProviderAvailable: personal !== null,
    });
    if (route !== "personal" || personal === null) {
      return yield* Effect.fail(signInOrAccountError(account));
    }
    const personalResult = yield* personal().pipe(Effect.result);
    if (personalResult._tag === "Success") return personalResult.success;
    const failure = personalResult.failure;
    if (!isMossVoiceFallbackFailure(failure)) {
      return yield* Effect.fail(toVoiceTranscriptionExecutionError(failure));
    }
    // The personal route could not reach its service. Moss may have finished restoring the
    // account meanwhile; otherwise the useful advice is to sign in to Moss.
    const retryAccount = yield* dependencies.resolveMossAccount;
    if (retryAccount.status === "signed-in") {
      return yield* viaMoss(retryAccount.gateway);
    }
    return yield* Effect.fail(signInOrAccountError(retryAccount));
  });
}

type VoiceTranscribingAdapter = Pick<ProviderAdapterShape<unknown>, "transcribeVoice">;

/**
 * The one composition both the HTTP upload route and the WebSocket RPC use, so the two can
 * never drift apart again.
 */
export function transcribeVoiceRequest(input: {
  readonly request: ServerVoiceTranscriptionInput;
  readonly account: Pick<
    VoiceAccountAdmissionDependencies,
    | "awaitAccountStartup"
    | "getPhoneAuthorityCredential"
    | "getCloudAuthorityCredential"
    | "enterpriseKey"
    | "environment"
  >;
  readonly getSettings: () => Effect.Effect<ServerSettings, unknown>;
  readonly getAdapter: (provider: ProviderKind) => Effect.Effect<VoiceTranscribingAdapter, unknown>;
}): Effect.Effect<ServerVoiceTranscriptionResult, VoiceTranscriptionRoutingError> {
  // Provider options are server-owned; a caller-supplied copy is never trusted.
  const { providerOptions: _ignoredProviderOptions, ...request } = input.request;
  return transcribeVoiceWithRouting({
    resolveMossAccount: resolveMossVoiceAccountState(input.account),
    transcribeWithMoss: (gateway) =>
      Effect.tryPromise({
        try: (signal) => transcribeVoiceWithMossGateway({ request, gateway, signal }),
        catch: (cause) => cause,
      }),
    resolvePersonalTranscriber: resolvePersonalTranscriber({
      request,
      getSettings: input.getSettings,
      getAdapter: input.getAdapter,
    }),
  });
}

function resolvePersonalTranscriber(input: {
  readonly request: Omit<ServerVoiceTranscriptionInput, "providerOptions">;
  readonly getSettings: () => Effect.Effect<ServerSettings, unknown>;
  readonly getAdapter: (provider: ProviderKind) => Effect.Effect<VoiceTranscribingAdapter, unknown>;
}): Effect.Effect<(() => Effect.Effect<ServerVoiceTranscriptionResult, unknown>) | null> {
  return Effect.gen(function* () {
    const settings = yield* input.getSettings();
    const selection: { provider: ProviderKind; providerInstanceId?: ProviderInstanceId } = {
      provider: input.request.provider,
      ...(input.request.providerInstanceId
        ? { providerInstanceId: input.request.providerInstanceId }
        : {}),
    };
    const route = resolveVoiceTranscriptionProviderRoute(settings, selection);
    // The Moss-managed instance has no transcription of its own: it is the Moss account.
    if (
      resolveReservedMossVoiceRouteIdentity({
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions?.codex ? { codexOptions: route.providerOptions.codex } : {}),
      }) !== null
    ) {
      return null;
    }
    const adapter = yield* input.getAdapter(route.provider);
    const transcribe = adapter.transcribeVoice;
    if (!transcribe) return null;
    return () =>
      transcribe({
        ...input.request,
        provider: route.provider,
        providerInstanceId: route.providerInstanceId,
        ...(route.providerOptions ? { providerOptions: route.providerOptions } : {}),
        ...(route.serverResolvedVoiceRouteAuthority
          ? { serverResolvedVoiceRouteAuthority: route.serverResolvedVoiceRouteAuthority }
          : {}),
      });
  }).pipe(
    // An unknown, disabled or reserved instance simply has no personal route.
    Effect.catch(() => Effect.succeed(null)),
    Effect.catchDefect(() => Effect.succeed(null)),
  );
}
