import { describe, expect, it, vi } from "vitest";
import { Effect } from "effect";
import type { OrchestrationCommand, OrchestrationEvent } from "@synara/contracts";

import { MossAccountServiceError } from "../../account/mossAccountErrors";
import { MossCloudAccountServiceError } from "../../account/mossCloudAccountErrors";
import { RealtimeVoiceRuntimeError } from "../runtime";
import {
  hasRealtimeVoiceBackgroundWork,
  makeTranscriptWriter,
  makeRealtimeVoiceRuntimeRoute,
  makeRelay,
  resolveRealtimeVoiceAuthorityCredential,
  resolveRealtimeVoiceThreadItem,
  resolveRealtimeVoiceAccessToken,
  runtimeEffect,
} from "./RealtimeVoiceService";

const COMPLETED_AT = "2026-07-27T05:00:00.000Z";

function messageSentEvent(input?: {
  readonly messageId?: string;
  readonly role?: "user" | "assistant" | "system";
  readonly text?: string;
  readonly streaming?: boolean;
}): OrchestrationEvent {
  return {
    type: "thread.message-sent",
    payload: {
      threadId: "thread-a",
      messageId: input?.messageId ?? "message-a",
      role: input?.role ?? "user",
      text: input?.text ?? "ordinary task text",
      turnId: null,
      streaming: input?.streaming ?? false,
      source: "native",
      createdAt: COMPLETED_AT,
      updatedAt: COMPLETED_AT,
    },
  } as unknown as OrchestrationEvent;
}

describe("resolveRealtimeVoiceThreadItem", () => {
  it("mirrors finalized user and assistant task text as bounded voice context", () => {
    expect(resolveRealtimeVoiceThreadItem(messageSentEvent())).toEqual({
      threadId: "thread-a",
      role: "user",
      text: "ordinary task text",
    });
    expect(
      resolveRealtimeVoiceThreadItem(
        messageSentEvent({ role: "assistant", text: "  final assistant answer  " }),
      ),
    ).toEqual({
      threadId: "thread-a",
      role: "assistant",
      text: "final assistant answer",
    });
  });

  it("rejects streaming deltas, empty text, voice transcripts, and voice-originated turns", () => {
    expect(resolveRealtimeVoiceThreadItem(messageSentEvent({ streaming: true }))).toBeNull();
    expect(resolveRealtimeVoiceThreadItem(messageSentEvent({ text: "   " }))).toBeNull();
    expect(
      resolveRealtimeVoiceThreadItem(
        messageSentEvent({ messageId: "voice-transcript:final-user" }),
      ),
    ).toBeNull();
    expect(
      resolveRealtimeVoiceThreadItem(messageSentEvent({ messageId: "voice:tool-turn:message" })),
    ).toBeNull();
  });
});

function idleThread() {
  return {
    archivedAt: null,
    deletedAt: null,
    session: {
      status: "ready" as const,
      activeTurnId: null,
    },
    latestTurn: {
      state: "completed" as const,
      completedAt: COMPLETED_AT,
    },
    hasPendingApprovals: false,
    hasPendingUserInput: false,
    messages: [
      {
        role: "user" as const,
        turnId: "turn-completed",
        streaming: false,
        createdAt: "2026-07-27T04:59:00.000Z",
      },
    ],
    pendingInteractions: [],
  };
}

describe("hasRealtimeVoiceBackgroundWork", () => {
  it("preserves an already classified runtime failure across the Effect boundary", async () => {
    const classified = new RealtimeVoiceRuntimeError(
      "VOICE_RATE_LIMITED",
      "Realtime Voice is receiving too many requests. Wait a moment and try again.",
      true,
    );
    const observed = await Effect.runPromise(
      Effect.flip(runtimeEffect(() => Promise.reject(classified))),
    );
    expect(observed).toBe(classified);
  });

  it("keeps the domestic PCM16 transport fail closed when the relay URL is missing", async () => {
    const relay = makeRelay({ MOSS_CLOUD_REGION: "cn" });
    expect(relay.preferredTransport).toBe("websocket-pcm16");
    await expect(
      relay.client.startCall({
        accessToken: "test-token",
        sessionId: "20000000-0000-4000-8000-000000000002",
        transport: { type: "websocket-pcm16" },
        voice: "maple",
        outputModality: "audio",
      }),
    ).rejects.toMatchObject({ code: "REALTIME_RELAY_NOT_CONFIGURED" });
  });

  it("returns false only for a confirmed idle thread", () => {
    expect(hasRealtimeVoiceBackgroundWork(idleThread())).toBe(false);
    expect(hasRealtimeVoiceBackgroundWork(null)).toBe(true);
  });

  it("treats active turns, pending interactions, and streaming output as work", () => {
    expect(
      hasRealtimeVoiceBackgroundWork({
        ...idleThread(),
        session: { status: "running", activeTurnId: "turn-active" },
      }),
    ).toBe(true);
    expect(
      hasRealtimeVoiceBackgroundWork({
        ...idleThread(),
        pendingInteractions: [{ status: "responding" }],
      }),
    ).toBe(true);
    expect(
      hasRealtimeVoiceBackgroundWork({
        ...idleThread(),
        messages: [{ ...idleThread().messages[0]!, streaming: true }],
      }),
    ).toBe(true);
  });

  it("fails safe while a newly queued user message has no projected turn", () => {
    expect(
      hasRealtimeVoiceBackgroundWork({
        ...idleThread(),
        messages: [
          {
            role: "user",
            turnId: null,
            streaming: false,
            createdAt: "2026-07-27T05:00:01.000Z",
          },
        ],
      }),
    ).toBe(true);
  });
});

describe("makeTranscriptWriter", () => {
  it("imports the final voice transcript into the owning thread without starting a provider turn", async () => {
    const commands: OrchestrationCommand[] = [];
    const writer = makeTranscriptWriter({
      orchestrationEngine: {
        dispatch: (command: OrchestrationCommand) => {
          commands.push(command);
          return Effect.succeed({ sequence: commands.length });
        },
      } as never,
    });

    await writer.write({
      sessionId: "session-a",
      threadId: "thread-a",
      itemId: "item-a",
      role: "assistant",
      text: "Voice reply saved.",
      createdAt: "2026-07-30T14:00:00.000Z",
    });
    await writer.write({
      sessionId: "session-a",
      threadId: "thread-a",
      itemId: "item-a",
      role: "assistant",
      text: "Voice reply saved.",
      createdAt: "2026-07-30T14:00:01.000Z",
    });

    expect(commands).toHaveLength(2);
    expect(commands.map((command) => command.type)).toEqual([
      "thread.messages.import",
      "thread.messages.import",
    ]);
    expect(commands[0]).toMatchObject({
      type: "thread.messages.import",
      threadId: "thread-a",
      messages: [
        {
          role: "assistant",
          text: "Voice reply saved.",
          createdAt: "2026-07-30T14:00:00.000Z",
          updatedAt: "2026-07-30T14:00:00.000Z",
        },
      ],
      createdAt: "2026-07-30T14:00:00.000Z",
    });
    expect(commands[1]?.commandId).toBe(commands[0]?.commandId);
    expect(
      commands[1]?.type === "thread.messages.import" ? commands[1].messages[0]?.messageId : null,
    ).toBe(
      commands[0]?.type === "thread.messages.import" ? commands[0].messages[0]?.messageId : null,
    );
  });
});

describe("resolveRealtimeVoiceAccessToken", () => {
  const phoneCredential = (accessToken = "phone-access-token") => ({
    realm: "memfire-phone" as const,
    issuer: "https://phone.example.cn/auth/v1",
    accessToken,
    gatewayBaseUrl: "https://models.example.cn/functions/v1/moss-model-gateway/v1",
    realtimeRelayUrl: "https://realtime.example.cn",
  });

  it("uses only the realm-bound MemFire phone credential while phone is authenticated", async () => {
    const phoneGetAuthorityCredential = vi.fn(() => Effect.succeed(phoneCredential()));
    const cloudGetAuthorityCredential = vi.fn(() =>
      Effect.succeed({
        realm: "supabase-google" as const,
        issuer: "https://global.example.com/auth/v1",
        accessToken: "cloud-access-token",
        gatewayBaseUrl: "https://global.example.com/functions/v1/moss-model-gateway/v1",
        realtimeRelayUrl: "https://realtime.global.example.com",
      }),
    );

    const credential = await Effect.runPromise(
      resolveRealtimeVoiceAuthorityCredential({
        phoneAccount: { getAuthorityCredential: phoneGetAuthorityCredential },
        cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
      }),
    );

    expect(credential).toEqual(phoneCredential());
    expect(phoneGetAuthorityCredential).toHaveBeenCalledOnce();
    expect(cloudGetAuthorityCredential).not.toHaveBeenCalled();
  });

  it("routes an active enterprise key through the mainland relay before any account", async () => {
    const phoneGetAuthorityCredential = vi.fn(() => Effect.succeed(phoneCredential()));
    const cloudGetAuthorityCredential = vi.fn(() => Effect.die("must not read Google"));
    const enterpriseCredential = {
      realm: "moss-enterprise-key" as const,
      issuer: "moss-enterprise-key",
      accessToken: `moss_sk_${"r".repeat(43)}`,
      gatewayBaseUrl: "https://cn.example.com/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime.cn.example.com",
      accountId: "enterprise-test",
    };

    const credential = await Effect.runPromise(
      resolveRealtimeVoiceAuthorityCredential({
        phoneAccount: { getAuthorityCredential: phoneGetAuthorityCredential },
        cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
        enterpriseKey: { getActiveAuthorityCredential: () => Effect.succeed(enterpriseCredential) },
      }),
    );

    expect(credential).toEqual(enterpriseCredential);
    expect(phoneGetAuthorityCredential).not.toHaveBeenCalled();
    const route = makeRealtimeVoiceRuntimeRoute(credential);
    expect(route.preferredTransport).toBe("websocket-pcm16");
    expect(route.accessToken).toBe(enterpriseCredential.accessToken);
    expect(() =>
      makeRealtimeVoiceRuntimeRoute({ ...enterpriseCredential, realtimeRelayUrl: "" }),
    ).toThrow();
  });

  it("selects the Supabase Google authority only after a definitive phone signed-out result", async () => {
    const phoneGetAuthorityCredential = vi.fn(() =>
      Effect.fail(
        new MossAccountServiceError({
          code: "authentication_required",
          message: "phone signed out",
        }),
      ),
    );
    const googleCredential = {
      realm: "supabase-google" as const,
      issuer: "https://global.example.com/auth/v1",
      accessToken: "cloud-access-token",
      gatewayBaseUrl: "https://global.example.com/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime.global.example.com",
    };
    const cloudGetAuthorityCredential = vi.fn(() => Effect.succeed(googleCredential));

    const credential = await Effect.runPromise(
      resolveRealtimeVoiceAuthorityCredential({
        phoneAccount: { getAuthorityCredential: phoneGetAuthorityCredential },
        cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
      }),
    );

    expect(credential).toEqual(googleCredential);
    expect(phoneGetAuthorityCredential).toHaveBeenCalledOnce();
    expect(cloudGetAuthorityCredential).toHaveBeenCalledOnce();
  });

  it.each(["session_expired", "authentication_service_unavailable"] as const)(
    "never substitutes a Supabase Google credential after a non-signed-out phone failure (%s)",
    async (code) => {
      const phoneGetAuthorityCredential = vi.fn(() =>
        Effect.fail(new MossAccountServiceError({ code, message: "phone token unavailable" })),
      );
      const cloudGetAuthorityCredential = vi.fn(() =>
        Effect.succeed({
          realm: "supabase-google" as const,
          issuer: "https://global.example.com/auth/v1",
          accessToken: "must-not-cross-realms",
          gatewayBaseUrl: "https://global.example.com/functions/v1/moss-model-gateway/v1",
          realtimeRelayUrl: "https://realtime.global.example.com",
        }),
      );

      const observed = await Effect.runPromise(
        Effect.flip(
          resolveRealtimeVoiceAccessToken({
            phoneAccount: { getAuthorityCredential: phoneGetAuthorityCredential },
            cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
          }),
        ),
      );

      expect(observed.code).toBe(
        code === "session_expired" ? "VOICE_LOGIN_REQUIRED" : "VOICE_ACCOUNT_RECOVERY_REQUIRED",
      );
      expect(cloudGetAuthorityCredential).not.toHaveBeenCalled();
    },
  );

  it("maps phone persistence failures to a safe typed recovery error without consulting cloud", async () => {
    const privateFailure = "phone secret unreadable PRIVATE_ACCOUNT_SENTINEL";
    const persistenceError = new MossAccountServiceError({
      code: "persistence_failed",
      message: privateFailure,
    });
    const phoneGetAuthorityCredential = vi.fn(() => Effect.fail(persistenceError));
    const cloudGetAuthorityCredential = vi.fn(() => Effect.die("must-not-read-google-token"));

    const observed = await Effect.runPromise(
      Effect.flip(
        resolveRealtimeVoiceAccessToken({
          phoneAccount: { getAuthorityCredential: phoneGetAuthorityCredential },
          cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
        }),
      ),
    );

    expect(observed).toMatchObject({
      code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
      retryable: true,
    });
    expect(String(observed)).not.toContain(privateFailure);
    expect(cloudGetAuthorityCredential).not.toHaveBeenCalled();
  });

  it("maps a signed-out Google fallback to login required without leaking its error", async () => {
    const cloudGetAuthorityCredential = vi.fn(() =>
      Effect.fail(
        new MossCloudAccountServiceError({
          code: "authentication_required",
          message: "private global auth detail",
        }),
      ),
    );
    const observed = await Effect.runPromise(
      Effect.flip(
        resolveRealtimeVoiceAuthorityCredential({
          phoneAccount: {
            getAuthorityCredential: () =>
              Effect.fail(
                new MossAccountServiceError({
                  code: "authentication_required",
                  message: "phone signed out",
                }),
              ),
          },
          cloudAccount: { getAuthorityCredential: cloudGetAuthorityCredential },
        }),
      ),
    );
    expect(observed).toMatchObject({ code: "VOICE_LOGIN_REQUIRED" });
    expect(String(observed)).not.toContain("private global auth detail");
  });

  it("derives relay region and transport only from the selected structured authority", () => {
    const phoneRoute = makeRealtimeVoiceRuntimeRoute(phoneCredential("phone-route-token"));
    const googleRoute = makeRealtimeVoiceRuntimeRoute({
      realm: "supabase-google",
      issuer: "https://global.example.com/auth/v1",
      accessToken: "google-route-token",
      gatewayBaseUrl: "https://global.example.com/functions/v1/moss-model-gateway/v1",
      realtimeRelayUrl: "https://realtime.global.example.com",
    });

    expect(phoneRoute).toMatchObject({
      preferredTransport: "websocket-pcm16",
      accessToken: "phone-route-token",
    });
    expect(googleRoute).toMatchObject({
      preferredTransport: "webrtc",
      accessToken: "google-route-token",
    });
    expect(phoneRoute.authorityId).not.toBe(googleRoute.authorityId);
    expect(phoneRoute.authorityId).not.toContain("phone-route-token");
    expect(googleRoute.authorityId).not.toContain("google-route-token");
  });
});
