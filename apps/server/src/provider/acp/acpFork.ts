// FILE: acpFork.ts
// Purpose: Shared "probe capability + session/fork" step for ACP-backed provider adapters.
// Layer: Provider ACP helper
// Exports: forkViaAcpRuntime

import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Option } from "effect";
import type * as AcpErrors from "./AcpErrors.ts";
import type { AcpSessionRuntimeShape } from "./AcpSessionRuntime.ts";
import { ProviderAdapterRequestError, ProviderAdapterValidationError } from "../Errors.ts";

/**
 * Fork the runtime's active session when the agent advertises `session/fork`.
 *
 * Fails with a `ProviderAdapterValidationError` when the capability is missing
 * so callers fall back to Moss's retained-transcript fork, and bounds the
 * whole probe+fork exchange with the adapter's request timeout.
 * Replay readiness
 * has its own bounded policy; the adapter timeout applies only after that gate
 * opens, preserving the full RPC allowance even when replay hits its hard cap.
 */
export function forkViaAcpRuntime(input: {
  readonly provider: string;
  readonly runtime: AcpSessionRuntimeShape;
  readonly targetCwd: string;
  readonly unsupportedIssue: string;
  readonly requestTimeoutMs: number;
  readonly timeoutError: (method: string) => ProviderAdapterRequestError;
}): Effect.Effect<
  Acp.ForkSessionResponse,
  AcpErrors.AcpError | ProviderAdapterRequestError | ProviderAdapterValidationError
> {
  return Effect.gen(function* () {
    if (!(yield* input.runtime.supportsSessionFork)) {
      return yield* new ProviderAdapterValidationError({
        provider: input.provider,
        operation: "forkThread",
        issue: input.unsupportedIssue,
      });
    }
    // Older Moss adapter fakes predate the recovery capability field. The
    // live AcpSessionRuntime always supplies it; keep those fakes compatible
    // while preserving the real capability gate above the native fork.
    const supportsSessionRecovery = input.runtime.supportsSessionRecovery ?? Effect.succeed(true);
    if (!(yield* supportsSessionRecovery)) {
      return yield* new ProviderAdapterValidationError({
        provider: input.provider,
        operation: "forkThread",
        issue: `This ${input.provider} ACP version advertises session/fork but cannot reopen the forked session; Moss will rebuild the fork from its retained transcript.`,
      });
    }
    yield* input.runtime.awaitLoadReplayReady;
    return yield* input.runtime.forkSession({ cwd: input.targetCwd, mcpServers: [] }).pipe(
      Effect.timeoutOption(input.requestTimeoutMs),
      Effect.flatMap(
        Option.match({
          onNone: () => Effect.fail(input.timeoutError("session/fork")),
          onSome: Effect.succeed,
        }),
      ),
    );
  });
}
