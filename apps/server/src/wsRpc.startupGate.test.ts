import { readFile } from "node:fs/promises";

import { Effect, Fiber, Ref, Stream } from "effect";
import { describe, expect, it } from "vitest";

import { makeServerRuntimeStartup } from "./serverRuntimeStartup";
import {
  gateOrchestrationMutationUntilStartup,
  gateOrchestrationReadUntilStartup,
  gateOrchestrationStreamUntilStartup,
  toVoiceWsRpcError,
} from "./wsRpc";
import { VoiceAccountAdmissionError } from "./voiceTranscriptionGateway";

describe("orchestration RPC startup gates", () => {
  it("holds import/repair-style mutations with zero side effects and runs each exactly once", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const startup = yield* makeServerRuntimeStartup;
        const effects = yield* Ref.make(0);
        const first = yield* gateOrchestrationMutationUntilStartup(
          startup,
          Ref.update(effects, (value) => value + 1),
        ).pipe(Effect.forkChild);
        const second = yield* gateOrchestrationMutationUntilStartup(
          startup,
          Ref.update(effects, (value) => value + 1),
        ).pipe(Effect.forkChild);
        const beforeReady = yield* Ref.get(effects);
        yield* startup.markCommandReady;
        yield* Fiber.join(first);
        yield* Fiber.join(second);
        return { beforeReady, afterReady: yield* Ref.get(effects) };
      }),
    );

    expect(result).toEqual({ beforeReady: 0, afterReady: 2 });
  });

  it("holds snapshots and subscriptions until reconciliation is ready", async () => {
    const result = await Effect.runPromise(
      Effect.gen(function* () {
        const startup = yield* makeServerRuntimeStartup;
        const reads = yield* Ref.make(0);
        const read = yield* gateOrchestrationReadUntilStartup(
          startup,
          Ref.updateAndGet(reads, (value) => value + 1),
        ).pipe(Effect.forkChild);
        const subscription = yield* gateOrchestrationStreamUntilStartup(
          startup,
          Stream.fromEffect(Ref.updateAndGet(reads, (value) => value + 1)),
        ).pipe(Stream.runCollect, Effect.forkChild);
        const beforeReady = yield* Ref.get(reads);
        yield* startup.markCommandReady;
        const readValue = yield* Fiber.join(read);
        const streamValues = Array.from(yield* Fiber.join(subscription));
        return { beforeReady, readValue, streamValues, afterReady: yield* Ref.get(reads) };
      }),
    );

    expect(result).toEqual({ beforeReady: 0, readValue: 1, streamValues: [2], afterReady: 2 });
  });

  it("routes every projection snapshot RPC through the startup read gate", async () => {
    const source = await readFile(new URL("./wsRpc.ts", import.meta.url), "utf8");
    const snapshotHandlers = [
      "getSnapshot",
      "getShellSnapshot",
      "getThreadDetailSnapshot",
    ] as const;

    for (const method of snapshotHandlers) {
      const start = source.indexOf(`[ORCHESTRATION_WS_METHODS.${method}]`);
      const nextMethod = source.indexOf("[ORCHESTRATION_WS_METHODS.", start + 1);
      const handler = source.slice(start, nextMethod === -1 ? undefined : nextMethod);
      expect(start, `${method} handler exists`).toBeGreaterThan(-1);
      expect(handler, `${method} is startup-gated`).toContain("gateOrchestrationReadUntilStartup(");
    }

    for (const method of ["subscribeShell", "subscribeThread"] as const) {
      const start = source.indexOf(`[ORCHESTRATION_WS_METHODS.${method}]`);
      const nextMethod = source.indexOf("[ORCHESTRATION_WS_METHODS.", start + 1);
      const handler = source.slice(start, nextMethod === -1 ? undefined : nextMethod);
      expect(start, `${method} handler exists`).toBeGreaterThan(-1);
      expect(handler, `${method} is startup-gated`).toContain(
        "gateOrchestrationStreamUntilStartup(",
      );
    }
  });

  it("routes both voice WebSocket handlers through live account admission", async () => {
    const source = await readFile(new URL("./wsRpc.ts", import.meta.url), "utf8");
    const cases = [
      ["serverPrewarmVoice", "resolveAdmittedVoicePrewarmProviderRoute"],
      ["serverTranscribeVoice", "resolveAdmittedVoiceTranscriptionProviderRoute"],
    ] as const;

    for (const [method, resolver] of cases) {
      const start = source.indexOf(`[WS_METHODS.${method}]`);
      const nextMethod = source.indexOf("[WS_METHODS.", start + 1);
      const handler = source.slice(start, nextMethod === -1 ? undefined : nextMethod);
      expect(start, `${method} handler exists`).toBeGreaterThan(-1);
      expect(handler, `${method} uses live admission`).toContain(`${resolver}(`);
      expect(handler, `${method} waits for account startup`).toContain(
        "runtimeStartup.enqueueRead(Effect.void)",
      );
      expect(handler, `${method} resolves the live phone authority credential`).toContain(
        "mossPhoneAccountService.getAuthorityCredential()",
      );
      expect(handler, `${method} resolves the live Google authority credential`).toContain(
        "mossCloudAccountService.getAuthorityCredential()",
      );
    }
  });

  it("maps voice admission failures to a safe typed WebSocket error", () => {
    const privateCause = "PRIVATE_ACCOUNT_CAUSE_SENTINEL";
    const error = toVoiceWsRpcError(
      new VoiceAccountAdmissionError({
        code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
        message: "Moss voice is unavailable until account recovery completes.",
        retryable: true,
        status: 503,
      }),
      privateCause,
    );

    expect(error).toMatchObject({
      code: "VOICE_ACCOUNT_RECOVERY_REQUIRED",
      message: "Moss voice is unavailable until account recovery completes.",
      retryable: true,
    });
    expect(JSON.stringify(error)).not.toContain(privateCause);
    expect(error.cause).toBeUndefined();

    const generic = toVoiceWsRpcError(new Error(privateCause), "private fallback");
    expect(generic).toMatchObject({
      code: "VOICE_TRANSCRIPTION_UNAVAILABLE",
      message: "Voice transcription is temporarily unavailable. Try again shortly.",
      retryable: true,
    });
    expect(JSON.stringify(generic)).not.toContain(privateCause);
    expect(generic.cause).toBeUndefined();
  });
});
