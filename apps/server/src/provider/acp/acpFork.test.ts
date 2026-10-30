// FILE: acpFork.test.ts
// Purpose: Preserves replay readiness ordering and the independent fork RPC allowance.
// Layer: Provider ACP helper tests

import { it } from "@effect/vitest";
import { Deferred, Effect, Fiber, Stream } from "effect";
import { TestClock } from "effect/testing";
import { describe, expect } from "vitest";

import { ProviderAdapterRequestError } from "../Errors.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { forkViaAcpRuntime } from "./acpFork.ts";

describe("forkViaAcpRuntime", () => {
  it.effect(
    "waits for replay readiness without spending the fork RPC allowance or subscribing to events",
    () =>
      Effect.gen(function* () {
        const firstActivity = yield* Deferred.make<"ready-wait" | "rpc">();
        const replayReady = yield* Deferred.make<void>();
        const rpcEntered = yield* Deferred.make<void>();
        const response = { sessionId: "fork-after-replay-ready" };
        let forkCalls = 0;
        let eventConsumerRequests = 0;
        const unexpectedCall = () => Effect.die("Unexpected ACP runtime operation");
        const runtime = {
          handleRequestPermission: unexpectedCall,
          handleElicitation: unexpectedCall,
          handleReadTextFile: unexpectedCall,
          handleWriteTextFile: unexpectedCall,
          handleCreateTerminal: unexpectedCall,
          handleTerminalOutput: unexpectedCall,
          handleTerminalWaitForExit: unexpectedCall,
          handleTerminalKill: unexpectedCall,
          handleTerminalRelease: unexpectedCall,
          handleSessionUpdate: unexpectedCall,
          handleElicitationComplete: unexpectedCall,
          handleExtRequest: unexpectedCall,
          handleExtNotification: unexpectedCall,
          start: unexpectedCall,
          awaitExit: Effect.never,
          getEvents: () => {
            eventConsumerRequests += 1;
            return Stream.never;
          },
          sessionUpdatesEnqueuedCount: Effect.succeed(0),
          supportsSessionFork: Effect.succeed(true),
          supportsSessionRecovery: Effect.succeed(true),
          getModeState: Effect.succeed(undefined),
          getSessionEpoch: unexpectedCall,
          getPendingSessionNotificationCount: unexpectedCall,
          getConfigOptions: Effect.succeed([]),
          getAvailableCommands: Effect.succeed([]),
          awaitLoadReplayReady: Effect.gen(function* () {
            yield* Deferred.succeed(firstActivity, "ready-wait");
            yield* Deferred.await(replayReady);
          }),
          prompt: unexpectedCall,
          cancel: Effect.void,
          setMode: unexpectedCall,
          setConfigOption: unexpectedCall,
          setModel: unexpectedCall,
          forkSession: () =>
            Effect.gen(function* () {
              forkCalls += 1;
              yield* Deferred.succeed(firstActivity, "rpc");
              yield* Deferred.succeed(rpcEntered, undefined);
              yield* Effect.sleep("999 millis");
              return response;
            }),
          request: unexpectedCall,
          notify: unexpectedCall,
        } satisfies AcpSessionRuntimeShape;

        const fork = yield* forkViaAcpRuntime({
          provider: "test",
          runtime,
          targetCwd: "/test/workspace",
          unsupportedIssue: "fork unsupported",
          requestTimeoutMs: 1_000,
          timeoutError: (method) =>
            new ProviderAdapterRequestError({
              provider: "test",
              method,
              detail: "timed out",
            }),
        }).pipe(Effect.forkChild({ startImmediately: true }));

        // A premature RPC wins this handshake instead of leaving the test blocked.
        expect(yield* Deferred.await(firstActivity)).toBe("ready-wait");
        yield* TestClock.adjust("2 seconds");
        expect(forkCalls).toBe(0);
        expect(fork.pollUnsafe()).toBeUndefined();
        expect(eventConsumerRequests).toBe(0);

        yield* Deferred.succeed(replayReady, undefined);
        yield* Deferred.await(rpcEntered);
        yield* TestClock.adjust("998 millis");
        expect(forkCalls).toBe(1);
        expect(fork.pollUnsafe()).toBeUndefined();

        yield* TestClock.adjust("1 millis");
        expect(yield* Fiber.join(fork)).toEqual(response);
        expect(eventConsumerRequests).toBe(0);
      }),
  );
});
