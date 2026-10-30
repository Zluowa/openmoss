import { createHash, randomUUID } from "node:crypto";

import {
  CommandId,
  MessageId,
  ThreadId,
  type OrchestrationEvent,
  type OrchestrationSessionStatus,
  type RealtimeVoiceEvent,
  type RealtimeVoiceToolName,
  type RealtimeVoiceTransportPreference,
} from "@synara/contracts";
import { Cause, Effect, Layer, PubSub, Stream } from "effect";

import {
  MossCloudAccountService,
  type MossSupabaseGoogleAuthorityCredential,
  type MossCloudAccountServiceShape,
} from "../../account/Services/MossCloudAccountService";
import {
  type MossMemFirePhoneAuthorityCredential,
  MossPhoneAccountService,
  type MossPhoneAccountServiceShape,
} from "../../account/Services/MossPhoneAccountService";
import {
  MossEnterpriseKeyAccount,
  type MossEnterpriseKeyError,
} from "../../account/Services/MossEnterpriseKeyAccount";
import {
  mossCloudRegionForAuthority,
  type MossActiveEnterpriseKeySource,
  type MossAuthorityCredential,
  preferActiveEnterpriseKeyCredential,
} from "../../account/mossActiveAuthorityCredential";
import {
  OrchestrationEngineService,
  type OrchestrationEngineShape,
} from "../../orchestration/Services/OrchestrationEngine";
import { createLogger } from "../../logger";
import { ServerRuntimeStartup, type ServerRuntimeStartupShape } from "../../serverRuntimeStartup";
import {
  RealtimeVoiceRelayClient,
  RealtimeVoiceRelayError,
  resolveMossCloudRegion,
  resolveRealtimeRelayOrigin,
  type RealtimeVoiceRelayClientShape,
} from "../relayClient";
import {
  RealtimeVoiceRuntime,
  RealtimeVoiceRuntimeError,
  type RealtimeVoiceRuntimeRoute,
  type RealtimeVoiceThreadItem,
  type RealtimeVoiceTranscriptWriter,
  type RealtimeVoiceToolExecutor,
} from "../runtime";
import {
  RealtimeVoiceService,
  type RealtimeVoiceServiceShape,
} from "../Services/RealtimeVoiceService";

const realtimeVoiceLogger = createLogger("realtime-voice");

interface RealtimeVoiceBackgroundWorkSnapshot {
  readonly archivedAt?: string | null | undefined;
  readonly deletedAt: string | null;
  readonly session: {
    readonly status: OrchestrationSessionStatus;
    readonly activeTurnId: string | null;
  } | null;
  readonly latestTurn: {
    readonly state: "running" | "interrupted" | "completed" | "error";
    readonly completedAt: string | null;
  } | null;
  readonly hasPendingApprovals?: boolean | undefined;
  readonly hasPendingUserInput?: boolean | undefined;
  readonly messages: ReadonlyArray<{
    readonly role: "user" | "assistant" | "system";
    readonly turnId: string | null;
    readonly streaming: boolean;
    readonly createdAt: string;
  }>;
  readonly pendingInteractions?:
    | ReadonlyArray<{
        readonly status: "pending" | "responding" | "confirmed" | "retryable" | "uncertain";
      }>
    | undefined;
}

export function hasRealtimeVoiceBackgroundWork(
  thread: RealtimeVoiceBackgroundWorkSnapshot | null,
): boolean {
  if (!thread) return true;
  if (thread.deletedAt !== null || (thread.archivedAt ?? null) !== null) return false;
  if (thread.session?.status === "starting" || thread.session?.status === "running") return true;
  if (thread.session?.activeTurnId !== null && thread.session?.activeTurnId !== undefined) {
    return true;
  }
  if (thread.latestTurn?.state === "running") return true;
  if (thread.hasPendingApprovals === true || thread.hasPendingUserInput === true) return true;
  if (thread.messages.some((message) => message.streaming)) return true;
  if (
    thread.pendingInteractions?.some((interaction) => interaction.status !== "confirmed") === true
  ) {
    return true;
  }

  const latestUserMessage = thread.messages.toReversed().find((message) => message.role === "user");
  if (!latestUserMessage || latestUserMessage.turnId !== null) return false;
  const latestCompletedAt = thread.latestTurn?.completedAt;
  if (!latestCompletedAt) return true;
  const messageCreatedAtMs = Date.parse(latestUserMessage.createdAt);
  const latestCompletedAtMs = Date.parse(latestCompletedAt);
  if (!Number.isFinite(messageCreatedAtMs) || !Number.isFinite(latestCompletedAtMs)) return true;
  return messageCreatedAtMs >= latestCompletedAtMs;
}

function unavailableRelay(cause: RealtimeVoiceRelayError): RealtimeVoiceRelayClientShape {
  const fail = async (): Promise<never> => {
    throw cause;
  };
  return {
    startCall: fail,
    connectControl() {
      throw cause;
    },
    stopCall: async () => undefined,
  };
}

function realtimeVoiceLoginRequired(): RealtimeVoiceRuntimeError {
  return new RealtimeVoiceRuntimeError(
    "VOICE_LOGIN_REQUIRED",
    "Sign in to your Moss account to start Realtime Voice.",
    false,
  );
}

function realtimeVoiceAccountRecoveryRequired(): RealtimeVoiceRuntimeError {
  return new RealtimeVoiceRuntimeError(
    "VOICE_ACCOUNT_RECOVERY_REQUIRED",
    "Realtime Voice is waiting for Moss account recovery to finish.",
    true,
  );
}

/**
 * Select one realm-bound credential. An enterprise key that owns the managed
 * surface pays for the session; otherwise Google is considered only when the
 * phone service proves there is no authenticated phone session. Transient,
 * refresh, and persistence failures never substitute another realm's credential.
 */
export function resolveRealtimeVoiceAuthorityCredential(input: {
  readonly phoneAccount: Pick<MossPhoneAccountServiceShape, "getAuthorityCredential">;
  readonly cloudAccount: Pick<MossCloudAccountServiceShape, "getAuthorityCredential">;
  readonly enterpriseKey?: MossActiveEnterpriseKeySource;
}): Effect.Effect<MossAuthorityCredential, RealtimeVoiceRuntimeError> {
  return preferActiveEnterpriseKeyCredential(input.enterpriseKey, () =>
    resolveAccountRealtimeVoiceCredential(input),
  ).pipe(
    Effect.mapError((error: RealtimeVoiceRuntimeError | MossEnterpriseKeyError) =>
      error instanceof RealtimeVoiceRuntimeError ? error : realtimeVoiceAccountRecoveryRequired(),
    ),
  );
}

function resolveAccountRealtimeVoiceCredential(input: {
  readonly phoneAccount: Pick<MossPhoneAccountServiceShape, "getAuthorityCredential">;
  readonly cloudAccount: Pick<MossCloudAccountServiceShape, "getAuthorityCredential">;
}): Effect.Effect<
  MossMemFirePhoneAuthorityCredential | MossSupabaseGoogleAuthorityCredential,
  RealtimeVoiceRuntimeError
> {
  const validatePhone = (credential: MossMemFirePhoneAuthorityCredential) =>
    credential.realm === "memfire-phone"
      ? Effect.succeed<MossMemFirePhoneAuthorityCredential | MossSupabaseGoogleAuthorityCredential>(
          credential,
        )
      : Effect.fail(realtimeVoiceAccountRecoveryRequired());
  const validateGoogle = (credential: MossSupabaseGoogleAuthorityCredential) =>
    credential.realm === "supabase-google"
      ? Effect.succeed<MossMemFirePhoneAuthorityCredential | MossSupabaseGoogleAuthorityCredential>(
          credential,
        )
      : Effect.fail(realtimeVoiceAccountRecoveryRequired());

  return input.phoneAccount.getAuthorityCredential().pipe(
    Effect.flatMap(validatePhone),
    Effect.catch((error) => {
      if (error instanceof RealtimeVoiceRuntimeError) return Effect.fail(error);
      if (error.code !== "authentication_required") {
        return Effect.fail(
          error.code === "session_expired"
            ? realtimeVoiceLoginRequired()
            : realtimeVoiceAccountRecoveryRequired(),
        );
      }
      return input.cloudAccount.getAuthorityCredential().pipe(
        Effect.flatMap(validateGoogle),
        Effect.mapError((cloudError) =>
          cloudError instanceof RealtimeVoiceRuntimeError
            ? cloudError
            : cloudError.code === "authentication_required" || cloudError.code === "session_expired"
              ? realtimeVoiceLoginRequired()
              : realtimeVoiceAccountRecoveryRequired(),
        ),
      );
    }),
  );
}

/** Compatibility helper for phone-only callers; cross-realm runtime code uses the structure. */
export function resolveRealtimeVoiceAccessToken(input: {
  readonly phoneAccount: Pick<MossPhoneAccountServiceShape, "getAuthorityCredential">;
  readonly cloudAccount: Pick<MossCloudAccountServiceShape, "getAuthorityCredential">;
  readonly enterpriseKey?: MossActiveEnterpriseKeySource;
}): Effect.Effect<string, RealtimeVoiceRuntimeError> {
  return resolveRealtimeVoiceAuthorityCredential(input).pipe(
    Effect.map((credential) => credential.accessToken),
  );
}

export function makeRealtimeVoiceRuntimeRoute(
  credential: MossAuthorityCredential,
): RealtimeVoiceRuntimeRoute {
  const accessToken = credential.accessToken.trim();
  if (!accessToken || /[\r\n]/u.test(accessToken) || !credential.realtimeRelayUrl) {
    throw realtimeVoiceAccountRecoveryRequired();
  }
  // An enterprise key uses the mainland relay, like the phone realm.
  const cloudRegion = mossCloudRegionForAuthority(credential.realm);
  const preferredTransport = cloudRegion === "cn" ? "websocket-pcm16" : "webrtc";
  const relay = new RealtimeVoiceRelayClient({
    origin: credential.realtimeRelayUrl,
    cloudRegion,
  });
  const normalizedOrigin = new URL(credential.realtimeRelayUrl).origin;
  return {
    authorityId: `${credential.realm}\0${credential.issuer}\0${normalizedOrigin}`,
    relay,
    preferredTransport,
    accessToken,
  };
}

export function makeRelay(env: NodeJS.ProcessEnv = process.env): {
  readonly client: RealtimeVoiceRelayClientShape;
  readonly preferredTransport: RealtimeVoiceTransportPreference;
} {
  let cloudRegion: ReturnType<typeof resolveMossCloudRegion>;
  try {
    cloudRegion = resolveMossCloudRegion(env);
  } catch (cause) {
    return {
      client: unavailableRelay(
        cause instanceof RealtimeVoiceRelayError
          ? cause
          : new RealtimeVoiceRelayError("MOSS_CLOUD_REGION_NOT_CONFIGURED"),
      ),
      preferredTransport: "webrtc",
    };
  }
  const preferredTransport = cloudRegion === "cn" ? "websocket-pcm16" : "webrtc";
  try {
    return {
      client: new RealtimeVoiceRelayClient({
        origin: resolveRealtimeRelayOrigin(env),
        cloudRegion,
      }),
      preferredTransport,
    };
  } catch (cause) {
    return {
      client: unavailableRelay(
        cause instanceof RealtimeVoiceRelayError
          ? cause
          : new RealtimeVoiceRelayError("REALTIME_RELAY_NOT_CONFIGURED"),
      ),
      preferredTransport,
    };
  }
}

function readToolRequest(argumentsValue: unknown): string {
  if (!argumentsValue || typeof argumentsValue !== "object" || Array.isArray(argumentsValue)) {
    throw new Error("INVALID_TOOL_ARGUMENTS");
  }
  const request = (argumentsValue as Record<string, unknown>).request;
  if (typeof request !== "string" || request.trim().length === 0 || request.length > 8_000) {
    throw new Error("INVALID_TOOL_ARGUMENTS");
  }
  return request.trim();
}

function makeToolExecutor(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
  readonly runtimeStartup: ServerRuntimeStartupShape;
}): RealtimeVoiceToolExecutor {
  const execute = (tool: {
    readonly sessionId: string;
    readonly threadId: string;
    readonly callId: string;
    readonly name: RealtimeVoiceToolName;
    readonly arguments: unknown;
  }) => {
    if (tool.name !== "send_to_agent") {
      if (tool.name === "capture_screen_context") {
        return Promise.resolve({ accepted: false, reason: "screen_context_disabled" });
      }
      if (tool.name === "speak_to_user") {
        const record =
          tool.arguments && typeof tool.arguments === "object" && !Array.isArray(tool.arguments)
            ? (tool.arguments as Readonly<Record<string, unknown>>)
            : null;
        const message = record?.message;
        return Promise.resolve(
          typeof message === "string" && message.trim().length > 0 && message.length <= 2_000
            ? { accepted: true, message: message.trim() }
            : { accepted: false, reason: "invalid_speech_message" },
        );
      }
      if (tool.name === "send_realtime_voice_feedback") {
        return Promise.resolve({ accepted: true, stored: false });
      }
      return Promise.resolve({ accepted: true });
    }

    const request = readToolRequest(tool.arguments);
    const dispatch = Effect.gen(function* () {
      const readModel = yield* input.orchestrationEngine.getReadModel();
      const thread = readModel.threads.find((candidate) => candidate.id === tool.threadId);
      if (!thread || thread.deletedAt !== null || thread.archivedAt !== null) {
        return yield* Effect.fail(new Error("VOICE_THREAD_NOT_AVAILABLE"));
      }
      const suffix = randomUUID();
      const result = yield* input.runtimeStartup.enqueueCommand(
        input.orchestrationEngine.dispatch({
          type: "thread.turn.start",
          commandId: CommandId.makeUnsafe(`voice:${suffix}:send`),
          threadId: thread.id,
          message: {
            messageId: MessageId.makeUnsafe(`voice:${suffix}:message`),
            role: "user",
            text: request,
            attachments: [],
          },
          dispatchMode: "queue",
          dispatchOrigin: "agent",
          runtimeMode: thread.runtimeMode,
          interactionMode: thread.interactionMode,
          createdAt: new Date().toISOString(),
        }),
      );
      return { accepted: true, sequence: result.sequence, threadId: thread.id };
    });
    return Effect.runPromise(dispatch);
  };
  return { execute };
}

function voiceTranscriptStableId(input: {
  readonly sessionId: string;
  readonly threadId: string;
  readonly itemId: string;
  readonly role: "user" | "assistant";
}): string {
  return createHash("sha256")
    .update(input.sessionId)
    .update("\0")
    .update(input.threadId)
    .update("\0")
    .update(input.itemId)
    .update("\0")
    .update(input.role)
    .digest("hex")
    .slice(0, 32);
}

export function makeTranscriptWriter(input: {
  readonly orchestrationEngine: OrchestrationEngineShape;
}): RealtimeVoiceTranscriptWriter {
  return {
    async write(transcript) {
      const stableId = voiceTranscriptStableId(transcript);
      await Effect.runPromise(
        input.orchestrationEngine.dispatch({
          type: "thread.messages.import",
          commandId: CommandId.makeUnsafe(`voice-transcript:${stableId}:import`),
          threadId: ThreadId.makeUnsafe(transcript.threadId),
          messages: [
            {
              messageId: MessageId.makeUnsafe(`voice-transcript:${stableId}`),
              role: transcript.role,
              text: transcript.text,
              createdAt: transcript.createdAt,
              updatedAt: transcript.createdAt,
            },
          ],
          createdAt: transcript.createdAt,
        }),
      );
    },
  };
}

/**
 * Select finalized ordinary task messages for the active voice session. User
 * text is mirrored as silent context; assistant finals are mirrored and handed
 * to the relay for speech. Voice transcript imports and voice-originated user
 * turns are excluded so the bridge cannot feed its own output back into itself.
 */
export function resolveRealtimeVoiceThreadItem(
  event: OrchestrationEvent,
): RealtimeVoiceThreadItem | null {
  if (event.type !== "thread.message-sent") return null;
  const { messageId, role, streaming, text, threadId } = event.payload;
  if (streaming || (role !== "user" && role !== "assistant")) return null;
  if (messageId.startsWith("voice-transcript:")) return null;
  if (role === "user" && messageId.startsWith("voice:")) return null;
  const normalizedText = text.trim();
  return normalizedText ? { threadId, role, text: normalizedText } : null;
}

export function runtimeEffect<A>(operation: () => Promise<A>) {
  return Effect.tryPromise({
    try: operation,
    catch: (cause) =>
      cause instanceof RealtimeVoiceRuntimeError
        ? cause
        : new RealtimeVoiceRuntimeError(
            "VOICE_RUNTIME_ERROR",
            "Realtime Voice could not complete the operation.",
            true,
          ),
  });
}

export const RealtimeVoiceServiceLive = Layer.effect(
  RealtimeVoiceService,
  Effect.gen(function* () {
    const phoneAccount = yield* MossPhoneAccountService;
    const cloudAccount = yield* MossCloudAccountService;
    const enterpriseKey = yield* MossEnterpriseKeyAccount;
    const orchestrationEngine = yield* OrchestrationEngineService;
    const runtimeStartup = yield* ServerRuntimeStartup;
    const eventPubSub = yield* Effect.acquireRelease(
      PubSub.unbounded<RealtimeVoiceEvent>(),
      PubSub.shutdown,
    );
    const bootstrapRelay = unavailableRelay(
      new RealtimeVoiceRelayError("REALTIME_RELAY_AUTHORITY_NOT_RESOLVED"),
    );
    const resolveRuntimeRoute = () =>
      resolveRealtimeVoiceAuthorityCredential({ phoneAccount, cloudAccount, enterpriseKey }).pipe(
        Effect.flatMap((credential) =>
          Effect.try({
            try: () => makeRealtimeVoiceRuntimeRoute(credential),
            catch: (cause) =>
              cause instanceof RealtimeVoiceRuntimeError
                ? cause
                : realtimeVoiceAccountRecoveryRequired(),
          }),
        ),
      );
    const runtime = yield* Effect.acquireRelease(
      Effect.sync(
        () =>
          new RealtimeVoiceRuntime({
            relay: bootstrapRelay,
            preferredTransport: "webrtc",
            getAccessToken: () => Promise.reject(realtimeVoiceAccountRecoveryRequired()),
            toolExecutor: makeToolExecutor({ orchestrationEngine, runtimeStartup }),
            transcriptWriter: makeTranscriptWriter({ orchestrationEngine }),
            hasActiveBackgroundWork: async ({ threadId }) => {
              const readModel = await Effect.runPromise(orchestrationEngine.getReadModel());
              const thread = readModel.threads.find((candidate) => candidate.id === threadId);
              if (!thread) throw new Error("REALTIME_VOICE_BACKGROUND_WORK_STATE_UNKNOWN");
              return hasRealtimeVoiceBackgroundWork(thread);
            },
            publish: (event) => {
              Effect.runFork(PubSub.publish(eventPubSub, event));
            },
            onStartFailure: (diagnostic) => {
              realtimeVoiceLogger.warn("provider start failed", { ...diagnostic });
            },
          }),
      ),
      (instance) => Effect.promise(() => instance.dispose()),
    );

    yield* Effect.forkScoped(
      Stream.runForEach(orchestrationEngine.streamDomainEvents, (event) => {
        const item = resolveRealtimeVoiceThreadItem(event);
        if (!item) return Effect.void;
        return Effect.tryPromise(() => runtime.appendThreadItem(item)).pipe(
          Effect.catchCause((cause) =>
            Effect.logWarning("failed to mirror task text into Realtime Voice context", {
              cause: Cause.pretty(cause),
              threadId: item.threadId,
              role: item.role,
            }),
          ),
          Effect.asVoid,
        );
      }),
    );

    return {
      listVoices: () =>
        resolveRuntimeRoute().pipe(
          Effect.map((route) => runtime.listVoices(route.preferredTransport)),
          Effect.catch(() => Effect.succeed(runtime.listVoices())),
        ),
      claim: (input) =>
        resolveRuntimeRoute().pipe(
          Effect.flatMap((route) => runtimeEffect(() => runtime.claim(input, route))),
        ),
      releaseClaim: (input) => runtimeEffect(() => runtime.releaseClaim(input.ownerClaimId)),
      start: (input) =>
        resolveRuntimeRoute().pipe(
          Effect.flatMap((route) => runtimeEffect(() => runtime.start(input, route))),
        ),
      reportClientState: (input) => runtimeEffect(() => runtime.reportClientState(input)),
      resolveScreenContext: (input) => runtimeEffect(() => runtime.resolveScreenContext(input)),
      appendText: (input) => runtimeEffect(() => runtime.appendText(input)),
      appendSpeech: (input) => runtimeEffect(() => runtime.appendSpeech(input)),
      stop: (input) => runtimeEffect(() => runtime.stop(input)),
      getState: Effect.sync(() => runtime.getState()),
      events: Stream.fromPubSub(eventPubSub),
    } satisfies RealtimeVoiceServiceShape;
  }),
);
