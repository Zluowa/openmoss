import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ThreadId, type RealtimeVoiceTransportPreference } from "@synara/contracts";

import type {
  RelayControlConnection,
  RelayStartResult,
  RealtimeVoiceRelayClientShape,
} from "./relayClient";
import { RealtimeVoiceRelayError } from "./relayClient";
import {
  classifyRealtimeVoiceStartError,
  RealtimeVoiceRuntime,
  RealtimeVoiceRuntimeError,
  type RealtimeVoiceIdlePolicy,
  type RealtimeVoiceRuntimeRoute,
  type RealtimeVoiceTranscriptWriter,
  type RealtimeVoiceToolExecutor,
} from "./runtime";

const THREAD_ID = ThreadId.makeUnsafe("thread-voice-test");
const CLAIM_ID = "claim-voice-test";
const SESSION_ID = "session-voice-test";
const UPSTREAM_SECRET = "PROVIDER_SECRET_SENTINEL https://provider.invalid/account";

const START_FAILURE_CASES = [
  {
    name: "relay authentication",
    makeCause: () => new RealtimeVoiceRelayError("UNAUTHORIZED", 401),
    code: "VOICE_LOGIN_REQUIRED",
    message: "Sign in to your Moss account to start Realtime Voice.",
    retryable: false,
  },
  {
    name: "local account login",
    makeCause: () => ({ code: "session_expired", message: UPSTREAM_SECRET }),
    code: "VOICE_LOGIN_REQUIRED",
    message: "Sign in to your Moss account to start Realtime Voice.",
    retryable: false,
  },
  {
    name: "managed account authentication",
    makeCause: () => ({ code: "VOICE_ACCOUNT_AUTHENTICATION_REQUIRED", message: UPSTREAM_SECRET }),
    code: "VOICE_LOGIN_REQUIRED",
    message: "Sign in to your Moss account to start Realtime Voice.",
    retryable: false,
  },
  {
    name: "managed account recovery",
    makeCause: () => ({ code: "VOICE_ACCOUNT_RECOVERY_REQUIRED", message: UPSTREAM_SECRET }),
    code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
    message: "Realtime Voice is waiting for Moss account recovery to finish.",
    retryable: true,
  },
  {
    name: "entitlement",
    makeCause: () => new RealtimeVoiceRelayError("ENTITLEMENT_REQUIRED", 403),
    code: "VOICE_ENTITLEMENT_REQUIRED",
    message: "Realtime Voice is not included for this Moss account.",
    retryable: false,
  },
  {
    name: "session quota",
    makeCause: () => new RealtimeVoiceRelayError("VOICE_SESSION_QUOTA_EXHAUSTED", 429),
    code: "VOICE_QUOTA_EXHAUSTED",
    message: "Your Realtime Voice session quota has been reached.",
    retryable: false,
  },
  {
    name: "existing account voice session",
    makeCause: () => new RealtimeVoiceRelayError("VOICE_SESSION_CONFLICT", 409),
    code: "VOICE_SESSION_CONFLICT",
    message:
      "Another Realtime Voice session is still active. End it or wait for it to close, then try again.",
    retryable: true,
  },
  {
    name: "credits",
    makeCause: () => new RealtimeVoiceRelayError("INSUFFICIENT_CREDITS", 402),
    code: "VOICE_CREDITS_EXHAUSTED",
    message: "This Moss account does not have enough credits to start Realtime Voice.",
    retryable: false,
  },
  {
    name: "cloud region",
    makeCause: () => new RealtimeVoiceRelayError("CONTROL_PLANE_REGION_MISMATCH", 503),
    code: "VOICE_REGION_UNAVAILABLE",
    message: "Realtime Voice is not available through the configured Moss region right now.",
    retryable: false,
  },
  {
    name: "domestic egress",
    makeCause: () => new RealtimeVoiceRelayError("CN_REALTIME_EGRESS_PROXY_REQUIRED", 500),
    code: "VOICE_REGION_UNAVAILABLE",
    message: "Realtime Voice is not available through the configured Moss region right now.",
    retryable: false,
  },
  {
    name: "provider rate limit",
    makeCause: () => new RealtimeVoiceRelayError("OPENAI_RATE_LIMITED", 502),
    code: "VOICE_RATE_LIMITED",
    message: "Realtime Voice is receiving too many requests. Wait a moment and try again.",
    retryable: true,
  },
  {
    name: "provider sideband rate limit",
    makeCause: () => new RealtimeVoiceRelayError("OPENAI_SIDEBAND_RATE_LIMITED", 409),
    code: "VOICE_RATE_LIMITED",
    message: "Realtime Voice is receiving too many requests. Wait a moment and try again.",
    retryable: true,
  },
  {
    name: "provider service credits exhausted",
    makeCause: () => new RealtimeVoiceRelayError("OPENAI_CREDITS_EXHAUSTED", 409),
    code: "VOICE_SERVICE_CREDITS_EXHAUSTED",
    message:
      "Moss voice service credits are temporarily unavailable. Try again later or contact support.",
    retryable: false,
  },
  {
    name: "provider sideband service credits exhausted",
    makeCause: () => new RealtimeVoiceRelayError("OPENAI_SIDEBAND_CREDITS_EXHAUSTED", 409),
    code: "VOICE_SERVICE_CREDITS_EXHAUSTED",
    message:
      "Moss voice service credits are temporarily unavailable. Try again later or contact support.",
    retryable: false,
  },
  {
    name: "permission",
    makeCause: () => new RealtimeVoiceRelayError("VOICE_RESERVATION_DENIED", 403),
    code: "VOICE_PERMISSION_DENIED",
    message: "This Moss account does not have permission to start Realtime Voice.",
    retryable: false,
  },
  {
    name: "known upstream failure",
    makeCause: () => new RealtimeVoiceRelayError("OPENAI_CALL_REJECTED", 502),
    code: "VOICE_UPSTREAM_UNAVAILABLE",
    message: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
    retryable: true,
  },
  {
    name: "local authentication service outage",
    makeCause: () => ({ code: "authentication_service_unavailable", message: UPSTREAM_SECRET }),
    code: "VOICE_UPSTREAM_UNAVAILABLE",
    message: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
    retryable: true,
  },
  {
    name: "unknown relay 5xx",
    makeCause: () => new RealtimeVoiceRelayError("PROVIDER_SECRET_SENTINEL", 503),
    code: "VOICE_UPSTREAM_UNAVAILABLE",
    message: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
    retryable: true,
  },
  {
    name: "unknown local failure",
    makeCause: () => new Error(UPSTREAM_SECRET),
    code: "VOICE_START_FAILED",
    message: "Realtime Voice could not start. Try again.",
    retryable: true,
  },
] as const;

class FakeRelay implements RealtimeVoiceRelayClientShape {
  readonly startCalls: unknown[] = [];
  readonly stopCalls: unknown[] = [];
  readonly commands: unknown[] = [];
  callbacks: Parameters<RealtimeVoiceRelayClientShape["connectControl"]>[0] | null = null;
  startFailure: unknown | null = null;
  stopFailure: unknown | null = null;
  startResult: Promise<RelayStartResult> = Promise.resolve({
    sessionId: SESSION_ID,
    requestedModel: "gpt-realtime-2.1",
    transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
    controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
  });

  async startCall(input: Parameters<RealtimeVoiceRelayClientShape["startCall"]>[0]) {
    this.startCalls.push(input);
    if (this.startFailure !== null) throw this.startFailure;
    return this.startResult;
  }

  connectControl(
    input: Parameters<RealtimeVoiceRelayClientShape["connectControl"]>[0],
  ): RelayControlConnection {
    this.callbacks = input;
    return {
      send: (command) => this.commands.push(command),
      close: () => undefined,
    };
  }

  async stopCall(input: Parameters<RealtimeVoiceRelayClientShape["stopCall"]>[0]) {
    this.stopCalls.push(input);
    if (this.stopFailure !== null) throw this.stopFailure;
  }

  open() {
    this.callbacks?.onOpen();
  }

  event(value: unknown) {
    this.callbacks?.onEvent(value);
  }
}

function deferred<A>() {
  let resolve!: (value: A) => void;
  let reject!: (cause: unknown) => void;
  const promise = new Promise<A>((onResolve, onReject) => {
    resolve = onResolve;
    reject = onReject;
  });
  return { promise, resolve, reject };
}

function makeHarness(
  options: {
    readonly idlePolicy?: RealtimeVoiceIdlePolicy;
    readonly hasActiveBackgroundWork?: () => boolean | Promise<boolean>;
    readonly onStartFailure?: (diagnostic: {
      readonly rootCode: string | null;
      readonly rootStatus: number | null;
      readonly classifiedCode: string;
    }) => void;
    readonly execute?: RealtimeVoiceToolExecutor["execute"];
    readonly transcriptWriter?: RealtimeVoiceTranscriptWriter;
    readonly preferredTransport?: RealtimeVoiceTransportPreference;
  } = {},
) {
  const relay = new FakeRelay();
  const events: unknown[] = [];
  const execute = vi.fn(options.execute ?? (async () => ({ accepted: true, sequence: 12 })));
  const hasActiveBackgroundWork = vi.fn(options.hasActiveBackgroundWork ?? (async () => false));
  const ids = [CLAIM_ID, SESSION_ID, "claim-voice-2", "session-voice-2"];
  const runtime = new RealtimeVoiceRuntime({
    relay,
    ...(options.preferredTransport ? { preferredTransport: options.preferredTransport } : {}),
    getAccessToken: async () => "moss-access-token",
    toolExecutor: { execute } satisfies RealtimeVoiceToolExecutor,
    ...(options.transcriptWriter ? { transcriptWriter: options.transcriptWriter } : {}),
    hasActiveBackgroundWork,
    ...(options.idlePolicy ? { idlePolicy: options.idlePolicy } : {}),
    ...(options.onStartFailure ? { onStartFailure: options.onStartFailure } : {}),
    publish: (event) => events.push(event),
    now: () => Date.now(),
    makeId: () => ids.shift() ?? "unexpected-id",
  });
  return { relay, events, execute, hasActiveBackgroundWork, runtime };
}

async function claimAndStart(harness: ReturnType<typeof makeHarness>) {
  const claim = await harness.runtime.claim({
    threadId: THREAD_ID,
    source: "composer-existing",
  });
  const result = await harness.runtime.start({
    ownerClaimId: claim.ownerClaimId,
    threadId: THREAD_ID,
    source: "composer-existing",
    voice: "maple",
    transport: { type: "webrtc", sdp: "v=0\r\noffer" },
    outputModality: "audio",
  });
  return { claim, result };
}

async function activate(harness: ReturnType<typeof makeHarness>, sessionId: string = SESSION_ID) {
  harness.relay.event({
    type: "session",
    sessionId,
    actualModel: "gpt-realtime-2.1",
  });
  await vi.waitFor(() => expect(harness.runtime.getState().actualModel).toBe("gpt-realtime-2.1"));
  return harness.runtime.reportClientState({
    sessionId,
    webRtcConnected: true,
    dataSessionInitialized: true,
    inputMuted: false,
    outputMuted: false,
  });
}

describe("RealtimeVoiceRuntime", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("returns the backend-owned default and the source-faithful voice catalog", () => {
    const harness = makeHarness();
    expect(harness.runtime.listVoices()).toEqual({
      defaultVoice: "maple",
      preferredTransport: "webrtc",
      voices: [
        { id: "arbor", displayName: "Arbor", description: "Easygoing and versatile" },
        { id: "breeze", displayName: "Breeze", description: "Animated and earnest" },
        { id: "cove", displayName: "Cove", description: "Composed and direct" },
        { id: "ember", displayName: "Ember", description: "Confident and optimistic" },
        { id: "juniper", displayName: "Juniper", description: "Open and upbeat" },
        { id: "maple", displayName: "Maple", description: "Cheerful and candid" },
        { id: "sol", displayName: "Sol", description: "Savvy and relaxed" },
        { id: "spruce", displayName: "Spruce", description: "Calm and affirming" },
        { id: "vale", displayName: "Vale", description: "Bright and inquisitive" },
      ],
    });
  });

  it.each(START_FAILURE_CASES)(
    "classifies $name without exposing relay or account details",
    ({ makeCause, code, message, retryable }) => {
      const error = classifyRealtimeVoiceStartError(makeCause());
      expect(error).toMatchObject({ code, message, retryable });
      expect(`${error.code} ${error.message}`).not.toContain("PROVIDER_SECRET_SENTINEL");
      expect(`${error.code} ${error.message}`).not.toContain("provider.invalid");
    },
  );

  it("keeps an existing classified start error intact", () => {
    const classified = new RealtimeVoiceRuntimeError(
      "VOICE_START_SUPERSEDED",
      "The Realtime Voice start was superseded.",
      true,
    );
    expect(classifyRealtimeVoiceStartError(classified)).toBe(classified);
  });

  it("normalizes an internal relay session mismatch instead of exposing its protocol code", () => {
    const error = classifyRealtimeVoiceStartError(
      new RealtimeVoiceRuntimeError(
        "REALTIME_RELAY_SESSION_MISMATCH",
        "The Realtime relay returned a mismatched session.",
      ),
    );
    expect(error).toMatchObject({
      code: "VOICE_UPSTREAM_UNAVAILABLE",
      message: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
      retryable: true,
    });
  });

  it("reports a bounded provider start diagnostic without exposing upstream messages", async () => {
    const onStartFailure = vi.fn();
    const harness = makeHarness({ onStartFailure });
    harness.relay.startFailure = new RealtimeVoiceRelayError("OPENAI_SDP_UNAVAILABLE", 502);
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });

    await expect(
      harness.runtime.start({
        ownerClaimId: claim.ownerClaimId,
        threadId: THREAD_ID,
        source: "composer-existing",
        voice: "maple",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_UNAVAILABLE" });

    expect(onStartFailure).toHaveBeenCalledExactlyOnceWith({
      rootCode: "OPENAI_SDP_UNAVAILABLE",
      rootStatus: 502,
      classifiedCode: "VOICE_UPSTREAM_UNAVAILABLE",
    });
    expect(JSON.stringify(onStartFailure.mock.calls)).not.toContain(UPSTREAM_SECRET);
  });

  it("releases ambiguous relay starts when local response validation fails", async () => {
    const harness = makeHarness();
    // The relay may have created the provider session before its response
    // failed local parsing/transport validation, so startCall cannot be used
    // as proof that no reservation exists remotely.
    harness.relay.startFailure = new RealtimeVoiceRelayError(
      "REALTIME_RELAY_INVALID_RESPONSE",
      502,
    );
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });

    await expect(
      harness.runtime.start({
        ownerClaimId: claim.ownerClaimId,
        threadId: THREAD_ID,
        source: "composer-existing",
        voice: "maple",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "VOICE_UPSTREAM_UNAVAILABLE" });

    expect(harness.relay.stopCalls).toEqual([
      { accessToken: "moss-access-token", sessionId: SESSION_ID },
    ]);
  });

  it("keeps the sanitized failed state when relay cleanup also rejects", async () => {
    const harness = makeHarness();
    harness.relay.startResult = Promise.resolve({
      sessionId: "mismatched-provider-session",
      requestedModel: "gpt-realtime-2.1",
      transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
      controlPath: "/v1/realtime/control?session_id=mismatched-provider-session",
    });
    harness.relay.stopFailure = new Error(UPSTREAM_SECRET);
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });

    await expect(
      harness.runtime.start({
        ownerClaimId: claim.ownerClaimId,
        threadId: THREAD_ID,
        source: "composer-existing",
        voice: "maple",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({
      code: "VOICE_UPSTREAM_UNAVAILABLE",
      message: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
      retryable: true,
    });
    expect(harness.relay.stopCalls).toHaveLength(1);
    expect(harness.runtime.getState()).toMatchObject({
      phase: "failed",
      error: "The Realtime Voice service is temporarily unavailable. Try again shortly.",
    });
    expect(JSON.stringify(harness.events)).not.toContain(UPSTREAM_SECRET);
    expect(JSON.stringify(harness.events)).not.toContain("REALTIME_RELAY_SESSION_MISMATCH");
  });

  it.each(START_FAILURE_CASES)(
    "publishes the stable $name start failure and its recoverability",
    async ({ makeCause, code, message, retryable }) => {
      const harness = makeHarness();
      harness.relay.startFailure = makeCause();
      const claim = await harness.runtime.claim({
        threadId: THREAD_ID,
        source: "composer-existing",
      });

      await expect(
        harness.runtime.start({
          ownerClaimId: claim.ownerClaimId,
          threadId: THREAD_ID,
          source: "composer-existing",
          voice: "maple",
          transport: { type: "webrtc", sdp: "v=0\r\noffer" },
          outputModality: "audio",
        }),
      ).rejects.toMatchObject({ code, message, retryable });

      expect(harness.runtime.getState()).toMatchObject({ phase: "failed", error: message });
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "error", code, message, recoverable: retryable }),
      );
      expect(JSON.stringify(harness.events)).not.toContain("PROVIDER_SECRET_SENTINEL");
      expect(JSON.stringify(harness.events)).not.toContain("provider.invalid");
    },
  );

  it("fails closed on a cross-region transport and supports the domestic PCM16 handshake", async () => {
    const harness = makeHarness({ preferredTransport: "websocket-pcm16" });
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });
    expect(claim.preferredTransport).toBe("websocket-pcm16");
    await expect(
      harness.runtime.start({
        ownerClaimId: claim.ownerClaimId,
        threadId: THREAD_ID,
        source: "composer-existing",
        voice: "maple",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "VOICE_TRANSPORT_MISMATCH" });

    harness.relay.startResult = Promise.resolve({
      sessionId: SESSION_ID,
      requestedModel: "gpt-realtime-2.1",
      transport: {
        type: "websocket-pcm16",
        url: "wss://voice-cn.moss.example/v1/realtime/media",
        protocol: "moss-realtime-pcm16-v1",
        ticket: "a".repeat(43),
        expiresAt: "2026-07-27T12:00:00.000Z",
        encoding: "pcm16",
        sampleRate: 24_000,
      },
      controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
    });
    const result = await harness.runtime.start({
      ownerClaimId: claim.ownerClaimId,
      threadId: THREAD_ID,
      source: "composer-existing",
      voice: "maple",
      transport: { type: "websocket-pcm16" },
      outputModality: "audio",
    });
    expect(result.transport.type).toBe("websocket-pcm16");
    expect(harness.relay.startCalls).toContainEqual(
      expect.objectContaining({ transport: { type: "websocket-pcm16" } }),
    );
  });

  it("binds a claim to one authority and never sends its token through another relay", async () => {
    const harness = makeHarness();
    const phoneRelay = new FakeRelay();
    const googleRelay = new FakeRelay();
    const phoneRoute: RealtimeVoiceRuntimeRoute = {
      authorityId: "memfire-phone\0https://phone.example/auth/v1\0https://phone-relay.example",
      relay: phoneRelay,
      preferredTransport: "webrtc",
      accessToken: "phone-authority-token",
    };
    const googleRoute: RealtimeVoiceRuntimeRoute = {
      authorityId: "supabase-google\0https://global.example/auth/v1\0https://global-relay.example",
      relay: googleRelay,
      preferredTransport: "webrtc",
      accessToken: "google-authority-token",
    };
    const claim = await harness.runtime.claim(
      { threadId: THREAD_ID, source: "composer-existing" },
      phoneRoute,
    );

    await expect(
      harness.runtime.start(
        {
          ownerClaimId: claim.ownerClaimId,
          threadId: THREAD_ID,
          source: "composer-existing",
          voice: "maple",
          transport: { type: "webrtc", sdp: "v=0\r\noffer" },
          outputModality: "audio",
        },
        googleRoute,
      ),
    ).rejects.toMatchObject({ code: "VOICE_AUTHORITY_CHANGED" });
    expect(phoneRelay.startCalls).toHaveLength(0);
    expect(googleRelay.startCalls).toHaveLength(0);

    await harness.runtime.start(
      {
        ownerClaimId: claim.ownerClaimId,
        threadId: THREAD_ID,
        source: "composer-existing",
        voice: "maple",
        transport: { type: "webrtc", sdp: "v=0\r\noffer" },
        outputModality: "audio",
      },
      phoneRoute,
    );
    expect(phoneRelay.startCalls).toContainEqual(
      expect.objectContaining({ accessToken: "phone-authority-token" }),
    );
    expect(googleRelay.startCalls).toHaveLength(0);
  });

  it("requires all four gates and the trusted actual model before becoming active", async () => {
    const harness = makeHarness();
    const { result } = await claimAndStart(harness);
    expect(result.sessionId).toBe(SESSION_ID);
    expect(harness.runtime.getState()).toMatchObject({
      phase: "starting",
      barrier: {
        requestAccepted: true,
        backendStarted: false,
        webRtcConnected: false,
        dataSessionInitialized: false,
      },
    });

    harness.relay.event({
      type: "relay.snapshot",
      sessionId: SESSION_ID,
      requestedModel: "gpt-realtime-2.1",
      actualModel: null,
      sidebandConnected: true,
    });
    harness.relay.event({
      type: "session",
      sessionId: SESSION_ID,
      actualModel: "gpt-realtime-2.1",
    });
    await vi.waitFor(() => expect(harness.runtime.getState().actualModel).toBe("gpt-realtime-2.1"));
    expect(harness.runtime.getState().phase).toBe("starting");

    const state = await harness.runtime.reportClientState({
      sessionId: SESSION_ID,
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: false,
      outputMuted: false,
    });
    expect(state.phase).toBe("active");
    expect(state.activity).toBe("listening");
    expect(state.barrier).toEqual({
      requestAccepted: true,
      backendStarted: true,
      webRtcConnected: true,
      dataSessionInitialized: true,
    });
  });

  it("keeps one fixture healthy across claim, start, report, tool, transcript, and stop", async () => {
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async () => undefined),
    };
    const harness = makeHarness({ transcriptWriter });

    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });
    expect(claim).toMatchObject({ ownerClaimId: CLAIM_ID, preferredTransport: "webrtc" });

    const started = await harness.runtime.start({
      ownerClaimId: claim.ownerClaimId,
      threadId: THREAD_ID,
      source: "composer-existing",
      voice: "maple",
      transport: { type: "webrtc", sdp: "v=0\r\noffer" },
      outputModality: "audio",
    });
    expect(started).toMatchObject({ sessionId: SESSION_ID, requestedModel: "gpt-realtime-2.1" });

    await activate(harness);
    expect(harness.runtime.getState()).toMatchObject({
      phase: "active",
      sessionId: SESSION_ID,
      activity: "listening",
    });

    harness.relay.event({
      type: "tool-request",
      sessionId: SESSION_ID,
      callId: "call-complete-fixture",
      name: "send_to_agent",
      arguments: { request: "Run the voice health fixture" },
    });
    await vi.waitFor(() =>
      expect(harness.relay.commands).toContainEqual({
        type: "tool_result",
        callId: "call-complete-fixture",
        output: { accepted: true, sequence: 12 },
      }),
    );

    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "item-complete-fixture",
      role: "assistant",
      delta: "Voice health fixture completed.",
      done: true,
    });
    await vi.waitFor(() =>
      expect(transcriptWriter.write).toHaveBeenCalledWith(
        expect.objectContaining({
          sessionId: SESSION_ID,
          threadId: THREAD_ID,
          itemId: "item-complete-fixture",
          role: "assistant",
          text: "Voice health fixture completed.",
        }),
      ),
    );

    await expect(harness.runtime.stop({ sessionId: SESSION_ID, reason: "user" })).resolves.toEqual({
      accepted: true,
    });
    expect(harness.relay.commands).toContainEqual({ type: "stop", reason: "user" });
    harness.relay.event({ type: "closed", sessionId: SESSION_ID, reason: "user" });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("inactive"));
  });

  it("auto-ends only after active listening remains idle for the configured threshold", async () => {
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
    });
    await claimAndStart(harness);
    await activate(harness);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.runtime.getState().phase).toBe("active");
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "item-idle-reset",
      role: "user",
      delta: "still here",
      done: true,
    });
    await harness.runtime.reportClientState({
      sessionId: SESSION_ID,
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: false,
      outputMuted: false,
    });
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "transcript", itemId: "item-idle-reset" }),
    );

    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.runtime.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("stopping"));
    expect(harness.relay.commands).toContainEqual({ type: "stop", reason: "inactivity" });
    expect(harness.relay.stopCalls).toHaveLength(0);
  });

  it("keeps a new session open long enough for a user to begin speaking or typing", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    await activate(harness);

    await vi.advanceTimersByTimeAsync(30_000);

    expect(harness.runtime.getState().phase).toBe("active");
    expect(harness.relay.commands).not.toContainEqual({ type: "stop", reason: "inactivity" });
  });

  it("does not confuse voice silence with pending relay response or transcription work", async () => {
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
    });
    await claimAndStart(harness);
    await activate(harness);
    harness.relay.event({
      type: "work-state",
      sessionId: SESSION_ID,
      responseRequestInFlight: false,
      responseInFlight: true,
      settlementOperationsInFlight: 0,
      pendingResponse: false,
      pendingTranscriptionCount: 1,
      pendingToolCount: 0,
    });
    await harness.runtime.reportClientState({
      sessionId: SESSION_ID,
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: false,
      outputMuted: false,
    });

    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.runtime.getState().phase).toBe("active");
    harness.relay.event({
      type: "work-state",
      sessionId: SESSION_ID,
      responseRequestInFlight: false,
      responseInFlight: false,
      settlementOperationsInFlight: 0,
      pendingResponse: false,
      pendingTranscriptionCount: 0,
      pendingToolCount: 0,
    });
    await harness.runtime.reportClientState({
      sessionId: SESSION_ID,
      webRtcConnected: true,
      dataSessionInitialized: true,
      inputMuted: false,
      outputMuted: false,
    });

    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.runtime.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("stopping"));
  });

  it("resumes when the relay rejects a raced inactivity stop because work became busy", async () => {
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
    });
    await claimAndStart(harness);
    await activate(harness);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("stopping"));

    harness.relay.event({
      type: "work-state",
      sessionId: SESSION_ID,
      responseRequestInFlight: false,
      responseInFlight: true,
      settlementOperationsInFlight: 0,
      pendingResponse: false,
      pendingTranscriptionCount: 0,
      pendingToolCount: 0,
    });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("active"));
    await vi.advanceTimersByTimeAsync(3_000);
    expect(harness.runtime.getState().phase).toBe("active");
  });

  it("waits for local tools and confirmed agent completion before starting the idle window", async () => {
    const tool = deferred<unknown>();
    let backgroundWork = true;
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
      execute: async () => tool.promise,
      hasActiveBackgroundWork: async () => backgroundWork,
    });
    await claimAndStart(harness);
    await activate(harness);
    harness.relay.event({
      type: "tool-request",
      sessionId: SESSION_ID,
      callId: "call-background-work",
      name: "send_to_agent",
      arguments: { request: "Run the focused tests" },
    });
    await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledOnce());

    await vi.advanceTimersByTimeAsync(15_000);
    expect(harness.runtime.getState().phase).toBe("active");
    tool.resolve({ accepted: true, sequence: 42 });
    await vi.waitFor(() =>
      expect(harness.relay.commands).toContainEqual(
        expect.objectContaining({ type: "tool_result", callId: "call-background-work" }),
      ),
    );
    await vi.advanceTimersByTimeAsync(10_000);
    expect(harness.runtime.getState().phase).toBe("active");

    const probeCallsBeforeCompletion = harness.hasActiveBackgroundWork.mock.calls.length;
    backgroundWork = false;
    for (
      let elapsed = 0;
      elapsed <= 1_000 &&
      harness.hasActiveBackgroundWork.mock.calls.length === probeCallsBeforeCompletion;
      elapsed += 1
    ) {
      await vi.advanceTimersByTimeAsync(1);
    }
    expect(harness.hasActiveBackgroundWork.mock.calls.length).toBeGreaterThan(
      probeCallsBeforeCompletion,
    );
    await vi.advanceTimersByTimeAsync(4_999);
    expect(harness.runtime.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1);
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("stopping"));
  });

  it("ignores a stale background-work probe after the session generation changes", async () => {
    const firstProbe = deferred<boolean>();
    let probeCount = 0;
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
      hasActiveBackgroundWork: () => {
        probeCount += 1;
        return probeCount === 1 ? firstProbe.promise : false;
      },
    });
    await claimAndStart(harness);
    await activate(harness);
    await vi.advanceTimersByTimeAsync(5_000);
    await vi.waitFor(() => expect(harness.hasActiveBackgroundWork).toHaveBeenCalledOnce());

    await harness.runtime.stop({ sessionId: SESSION_ID, reason: "user" });
    harness.relay.event({ type: "closed", sessionId: SESSION_ID, reason: "user" });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("inactive"));
    harness.relay.startResult = Promise.resolve({
      sessionId: "session-voice-2",
      requestedModel: "gpt-realtime-2.1",
      transport: { type: "webrtc", sdp: "v=0\r\nanswer-2" },
      controlPath: "/v1/realtime/control?session_id=session-voice-2",
    });
    await claimAndStart(harness);
    await activate(harness, "session-voice-2");

    firstProbe.resolve(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(harness.runtime.getState().phase).toBe("active");
    expect(harness.relay.commands).not.toContainEqual({ type: "stop", reason: "inactivity" });
  });

  it("backs off failed work probes and then ends safely instead of staying active forever", async () => {
    const harness = makeHarness({
      idlePolicy: { minIdleTimeoutMs: 5_000, maxIdleTimeoutMs: 5_000 },
      hasActiveBackgroundWork: async () => {
        throw new Error("projection unavailable");
      },
    });
    await claimAndStart(harness);
    await activate(harness);

    await vi.advanceTimersByTimeAsync(5_000);
    expect(harness.hasActiveBackgroundWork).toHaveBeenCalledTimes(1);
    expect(harness.runtime.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(1_000);
    expect(harness.hasActiveBackgroundWork).toHaveBeenCalledTimes(2);
    expect(harness.runtime.getState().phase).toBe("active");
    await vi.advanceTimersByTimeAsync(2_000);

    expect(harness.hasActiveBackgroundWork).toHaveBeenCalledTimes(3);
    expect(harness.runtime.getState().phase).toBe("stopping");
    expect(harness.events).toContainEqual(
      expect.objectContaining({ type: "error", code: "VOICE_IDLE_WORK_PROBE_FAILED" }),
    );
    expect(harness.relay.commands).toContainEqual({ type: "stop", reason: "inactivity" });
  });

  it("enforces one process-wide claim and expires abandoned presentation", async () => {
    const harness = makeHarness();
    await harness.runtime.claim({ threadId: THREAD_ID, source: "composer-existing" });
    await expect(
      harness.runtime.claim({
        threadId: ThreadId.makeUnsafe("other-thread"),
        source: "global-hotkey",
      }),
    ).rejects.toMatchObject({ code: "VOICE_SESSION_CONFLICT" });

    await vi.advanceTimersByTimeAsync(30_000);
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("failed"));
    expect(harness.runtime.getState().error).toContain("timed out");
  });

  it("keeps input and output mute independent", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    const state = await harness.runtime.reportClientState({
      sessionId: SESSION_ID,
      webRtcConnected: false,
      dataSessionInitialized: false,
      inputMuted: true,
      outputMuted: false,
    });
    expect(state.inputMuted).toBe(true);
    expect(state.outputMuted).toBe(false);
  });

  it("supersedes a stale asynchronous start and asks the relay to release it", async () => {
    const harness = makeHarness();
    harness.relay.stopFailure = new Error(UPSTREAM_SECRET);
    const pending = deferred<RelayStartResult>();
    harness.relay.startResult = pending.promise;
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });
    const start = harness.runtime.start({
      ownerClaimId: claim.ownerClaimId,
      threadId: THREAD_ID,
      source: "composer-existing",
      voice: "maple",
      transport: { type: "webrtc", sdp: "v=0\r\noffer" },
      outputModality: "audio",
    });
    await vi.waitFor(() => expect(harness.relay.startCalls).toHaveLength(1));
    await harness.runtime.stop({ reason: "user" });
    pending.resolve({
      sessionId: SESSION_ID,
      requestedModel: "gpt-realtime-2.1",
      transport: { type: "webrtc", sdp: "v=0\r\nanswer" },
      controlPath: `/v1/realtime/control?session_id=${SESSION_ID}`,
    });
    await expect(start).rejects.toMatchObject({
      code: "VOICE_START_SUPERSEDED",
      message: "The Realtime Voice start was superseded.",
      retryable: true,
    });
    // One attempt races the local stop and one releases the provider call once
    // the previously pending create returns. Both are best-effort and sanitized.
    await vi.waitFor(() => expect(harness.relay.stopCalls).toHaveLength(2));
  });

  it("executes privileged tools locally and returns the exact call result", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    harness.relay.event({
      type: "tool-request",
      sessionId: SESSION_ID,
      callId: "call-1",
      name: "send_to_agent",
      arguments: { request: "Run the focused tests" },
    });
    await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(harness.relay.commands).toContainEqual({
        type: "tool_result",
        callId: "call-1",
        output: { accepted: true, sequence: 12 },
      }),
    );
    expect(harness.execute).toHaveBeenCalledWith(
      expect.objectContaining({
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        name: "send_to_agent",
      }),
    );
  });

  it("turns an accepted speak_to_user tool result into one bounded spoken update", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    harness.relay.event({
      type: "tool-request",
      sessionId: SESSION_ID,
      callId: "call-speech-1",
      name: "speak_to_user",
      arguments: { message: "The focused tests passed." },
    });

    await vi.waitFor(() => expect(harness.execute).toHaveBeenCalledOnce());
    await vi.waitFor(() =>
      expect(harness.relay.commands).toEqual(
        expect.arrayContaining([
          {
            type: "tool_result",
            callId: "call-speech-1",
            output: { accepted: true, sequence: 12 },
          },
          { type: "append_speech", text: "The focused tests passed." },
        ]),
      ),
    );
  });

  it("routes a short text-to-speech request through the active voice relay", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);

    await expect(
      harness.runtime.appendSpeech({
        sessionId: SESSION_ID,
        text: "A short speech contract test.",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(harness.relay.commands).toContainEqual({
      type: "append_speech",
      text: "A short speech contract test.",
    });
  });

  it("waits for the user-approved renderer bridge before returning screen context", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    harness.relay.event({
      type: "tool-request",
      sessionId: SESSION_ID,
      callId: "call-screen-1",
      name: "capture_screen_context",
      arguments: { reason: "Inspect the visible error" },
    });
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "tool-request", callId: "call-screen-1" }),
      ),
    );
    expect(harness.execute).not.toHaveBeenCalled();

    await expect(
      harness.runtime.resolveScreenContext({
        sessionId: SESSION_ID,
        callId: "call-screen-1",
        accepted: true,
        reason: null,
        capturedAt: "2026-07-26T00:00:00.000Z",
        sourceAppName: "Safari",
        sourceBundleIdentifier: "com.apple.Safari",
        sourceWindowTitle: "Moss docs",
        imageDataUrl: "data:image/jpeg;base64,/9j/2Q==",
      }),
    ).resolves.toEqual({ accepted: true });
    expect(harness.relay.commands).toContainEqual({
      type: "tool_result",
      callId: "call-screen-1",
      output: {
        accepted: true,
        reason: null,
        capturedAt: "2026-07-26T00:00:00.000Z",
        sourceAppName: "Safari",
        sourceBundleIdentifier: "com.apple.Safari",
        sourceWindowTitle: "Moss docs",
      },
      imageDataUrl: "data:image/jpeg;base64,/9j/2Q==",
    });
    await expect(
      harness.runtime.resolveScreenContext({
        sessionId: SESSION_ID,
        callId: "call-screen-1",
        accepted: false,
        reason: "duplicate",
        capturedAt: null,
        sourceAppName: null,
        sourceBundleIdentifier: null,
        sourceWindowTitle: null,
        imageDataUrl: null,
      }),
    ).resolves.toEqual({ accepted: false });
  });

  it("closes deterministically when the relay confirms stop", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    expect(await harness.runtime.stop({ sessionId: SESSION_ID, reason: "user" })).toEqual({
      accepted: true,
    });
    expect(harness.runtime.getState().phase).toBe("stopping");
    harness.relay.event({ type: "closed", sessionId: SESSION_ID, reason: "user" });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("inactive"));
  });

  it("replays bounded thread continuity only after the next sideband is ready", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "item-user-continuity-1",
      role: "user",
      delta: "Please keep this context",
      done: true,
    });
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "item-assistant-continuity-1",
      role: "assistant",
      delta: "I will keep it for this thread",
      done: true,
    });
    await vi.waitFor(() =>
      expect(harness.events).toContainEqual(
        expect.objectContaining({ type: "transcript", role: "assistant", done: true }),
      ),
    );
    await harness.runtime.stop({ sessionId: SESSION_ID, reason: "user" });
    harness.relay.event({ type: "closed", sessionId: SESSION_ID, reason: "user" });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("inactive"));

    harness.relay.startResult = Promise.resolve({
      sessionId: "session-voice-2",
      requestedModel: "gpt-realtime-2.1",
      transport: { type: "webrtc", sdp: "v=0\r\nanswer-2" },
      controlPath: "/v1/realtime/control?session_id=session-voice-2",
    });
    const claim = await harness.runtime.claim({
      threadId: THREAD_ID,
      source: "composer-existing",
    });
    await harness.runtime.start({
      ownerClaimId: claim.ownerClaimId,
      threadId: THREAD_ID,
      source: "composer-existing",
      voice: "maple",
      transport: { type: "webrtc", sdp: "v=0\r\noffer-2" },
      outputModality: "audio",
    });
    expect(harness.relay.commands).not.toContainEqual(
      expect.objectContaining({ type: "append_context" }),
    );
    harness.relay.event({
      type: "relay.snapshot",
      sessionId: "session-voice-2",
      requestedModel: "gpt-realtime-2.1",
      actualModel: null,
      sidebandConnected: true,
    });
    await vi.waitFor(() =>
      expect(harness.relay.commands).toContainEqual({
        type: "append_context",
        items: [
          { role: "user", text: "Please keep this context" },
          { role: "assistant", text: "I will keep it for this thread" },
        ],
      }),
    );
  });

  it("persists final voice transcript messages into the owning thread without replaying deltas", async () => {
    const writes: Array<Parameters<RealtimeVoiceTranscriptWriter["write"]>[0]> = [];
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async (input) => {
        writes.push(input);
      }),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-user-1",
      role: "user",
      delta: "partial user text",
      done: false,
    });
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-user-1",
      role: "user",
      delta: " final user text ",
      done: true,
    });
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-user-1",
      role: "user",
      delta: " final user text ",
      done: true,
    });
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-assistant-1",
      role: "assistant",
      delta: "final assistant text",
      done: true,
    });

    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledTimes(2));
    expect(writes).toEqual([
      {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: "voice-user-1",
        role: "user",
        text: "final user text",
        createdAt: expect.any(String),
      },
      {
        sessionId: SESSION_ID,
        threadId: THREAD_ID,
        itemId: "voice-assistant-1",
        role: "assistant",
        text: "final assistant text",
        createdAt: expect.any(String),
      },
    ]);
    expect(
      harness.events.filter(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown }).type === "transcript",
      ),
    ).toHaveLength(4);
  });

  it("persists typed user text immediately after append_text is accepted by the control channel", async () => {
    const writes: Array<Parameters<RealtimeVoiceTranscriptWriter["write"]>[0]> = [];
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async (input) => {
        writes.push(input);
      }),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    await expect(
      harness.runtime.appendText({
        sessionId: SESSION_ID,
        role: "user",
        text: "请确认文字输入也显示在普通线程。",
      }),
    ).resolves.toEqual({ accepted: true });
    await expect(
      harness.runtime.appendText({
        sessionId: SESSION_ID,
        role: "assistant",
        text: "Prior assistant context must stay model-only.",
      }),
    ).resolves.toEqual({ accepted: true });

    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledTimes(1));
    expect(writes[0]).toEqual({
      sessionId: SESSION_ID,
      threadId: THREAD_ID,
      itemId: "local-text-1",
      role: "user",
      text: "请确认文字输入也显示在普通线程。",
      createdAt: expect.any(String),
    });
    expect(harness.relay.commands).toContainEqual({
      type: "append_text",
      role: "assistant",
      text: "Prior assistant context must stay model-only.",
    });
  });

  it("mirrors ordinary task text and speaks finalized assistant replies like Codex handoffs", async () => {
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async () => undefined),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);

    await expect(
      harness.runtime.appendThreadItem({
        threadId: THREAD_ID,
        role: "user",
        text: "not connected yet",
      }),
    ).resolves.toBe(false);

    await activate(harness);
    await expect(
      harness.runtime.appendThreadItem({
        threadId: THREAD_ID,
        role: "user",
        text: "  ordinary user task text  ",
      }),
    ).resolves.toBe(true);
    await expect(
      harness.runtime.appendThreadItem({
        threadId: THREAD_ID,
        role: "assistant",
        text: "ordinary assistant answer",
      }),
    ).resolves.toBe(true);
    await expect(
      harness.runtime.appendThreadItem({
        threadId: ThreadId.makeUnsafe("another-thread"),
        role: "assistant",
        text: "must not cross task boundaries",
      }),
    ).resolves.toBe(false);

    expect(harness.relay.commands).toContainEqual({
      type: "append_text",
      role: "user",
      text: "ordinary user task text",
      requestResponse: false,
    });
    expect(harness.relay.commands).toContainEqual({
      type: "append_text",
      role: "assistant",
      text: "ordinary assistant answer",
      requestResponse: false,
    });
    expect(harness.relay.commands).toContainEqual({
      type: "append_speech",
      text: "ordinary assistant answer",
      persistTranscriptToThread: false,
    });
    expect(harness.relay.commands).not.toContainEqual(
      expect.objectContaining({ text: "must not cross task boundaries" }),
    );

    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "speech-handoff-transcript",
      role: "assistant",
      delta: "ordinary assistant answer",
      done: true,
    });
    await harness.runtime.appendText({
      sessionId: SESSION_ID,
      role: "assistant",
      text: "flush relay events",
    });
    expect(harness.events).toContainEqual(
      expect.objectContaining({
        type: "transcript",
        itemId: "speech-handoff-transcript",
        done: true,
      }),
    );
    expect(transcriptWriter.write).not.toHaveBeenCalled();
  });

  it("does not suppress unrelated legacy relay transcripts while a speech handoff is pending", async () => {
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async () => undefined),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "authoritative task answer",
    });
    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "independent-voice-answer",
      role: "assistant",
      delta: "an independent voice answer",
      done: true,
    });

    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledOnce());
    expect(transcriptWriter.write).toHaveBeenCalledWith(
      expect.objectContaining({
        itemId: "independent-voice-answer",
        text: "an independent voice answer",
      }),
    );
  });

  it("applies Codex realtime channel prefixes before speaking bridged assistant text", async () => {
    const harness = makeHarness();
    await claimAndStart(harness);
    await activate(harness);

    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "[COMPLETE] 语音模式测试成功。",
    });
    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "[ANALYSIS] This must remain silent context.",
    });
    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "[ATTENTION]\n请先确认麦克风权限。",
    });
    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "::codex-realtime-inline{}\n[Download the report](https://example.test/report)",
    });
    await harness.runtime.appendThreadItem({
      threadId: THREAD_ID,
      role: "assistant",
      text: "[COMPLETE] ::codex-realtime-inline{}\n[Download](https://example.test/report)",
    });

    expect(
      harness.relay.commands.filter(
        (command) =>
          typeof command === "object" &&
          command !== null &&
          (command as { type?: unknown }).type === "append_speech",
      ),
    ).toEqual([
      {
        type: "append_speech",
        text: "语音模式测试成功。",
        persistTranscriptToThread: false,
      },
      {
        type: "append_speech",
        text: "请先确认麦克风权限。",
        persistTranscriptToThread: false,
      },
    ]);
    expect(harness.relay.commands).toContainEqual({
      type: "append_text",
      role: "assistant",
      text: "[ANALYSIS] This must remain silent context.",
      requestResponse: false,
    });
  });

  it("keeps the voice session visible when final transcript persistence fails", async () => {
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi.fn(async () => {
        throw new Error("projection unavailable");
      }),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-assistant-failing",
      role: "assistant",
      delta: "assistant text",
      done: true,
    });

    await vi.waitFor(() =>
      expect(
        harness.events.some(
          (event) =>
            typeof event === "object" &&
            event !== null &&
            (event as { type?: unknown; code?: unknown }).type === "error" &&
            (event as { code?: unknown }).code === "VOICE_TRANSCRIPT_PERSIST_FAILED",
        ),
      ).toBe(true),
    );
    expect(transcriptWriter.write).toHaveBeenCalledTimes(3);
    expect(harness.runtime.getState().phase).toBe("active");
  });

  it("retries a transient final transcript import before marking the item persisted", async () => {
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi
        .fn<RealtimeVoiceTranscriptWriter["write"]>()
        .mockRejectedValueOnce(new Error("projection reconnecting"))
        .mockResolvedValue(undefined),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    const completedTranscript = {
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-assistant-retry",
      role: "assistant",
      delta: "saved after reconnect",
      done: true,
    } as const;
    harness.relay.event(completedTranscript);
    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledTimes(2));

    harness.relay.event(completedTranscript);
    await harness.runtime.appendText({
      sessionId: SESSION_ID,
      role: "assistant",
      text: "flush the serialized event queue without persisting another user message",
    });
    expect(transcriptWriter.write).toHaveBeenCalledTimes(2);
    expect(
      harness.events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { code?: unknown }).code === "VOICE_TRANSCRIPT_PERSIST_FAILED",
      ),
    ).toBe(false);
    expect(harness.runtime.getState().phase).toBe("active");
  });

  it("does not publish a stale transcript persistence error into a replacement session", async () => {
    const firstAttempt = deferred<void>();
    const transcriptWriter: RealtimeVoiceTranscriptWriter = {
      write: vi
        .fn<RealtimeVoiceTranscriptWriter["write"]>()
        .mockImplementationOnce(() => firstAttempt.promise)
        .mockRejectedValue(new Error("projection remains unavailable")),
    };
    const harness = makeHarness({ transcriptWriter });
    await claimAndStart(harness);
    await activate(harness);

    harness.relay.event({
      type: "transcript",
      sessionId: SESSION_ID,
      itemId: "voice-assistant-stale-failure",
      role: "assistant",
      delta: "old session transcript",
      done: true,
    });
    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledOnce());

    await harness.runtime.stop({ sessionId: SESSION_ID, reason: "user" });
    harness.relay.event({ type: "closed", sessionId: SESSION_ID, reason: "user" });
    await vi.waitFor(() => expect(harness.runtime.getState().phase).toBe("inactive"));

    const replacementSessionId = "session-voice-2";
    harness.relay.startResult = Promise.resolve({
      sessionId: replacementSessionId,
      requestedModel: "gpt-realtime-2.1",
      transport: { type: "webrtc", sdp: "v=0\r\nreplacement-answer" },
      controlPath: `/v1/realtime/control?session_id=${replacementSessionId}`,
    });
    await claimAndStart(harness);
    await activate(harness, replacementSessionId);

    firstAttempt.reject(new Error("old projection request disconnected"));
    await vi.waitFor(() => expect(transcriptWriter.write).toHaveBeenCalledTimes(3));
    await vi.advanceTimersByTimeAsync(0);

    expect(harness.runtime.getState()).toMatchObject({
      phase: "active",
      sessionId: replacementSessionId,
    });
    expect(
      harness.events.some(
        (event) =>
          typeof event === "object" &&
          event !== null &&
          (event as { type?: unknown; code?: unknown }).type === "error" &&
          (event as { code?: unknown }).code === "VOICE_TRANSCRIPT_PERSIST_FAILED",
      ),
    ).toBe(false);
  });
});
