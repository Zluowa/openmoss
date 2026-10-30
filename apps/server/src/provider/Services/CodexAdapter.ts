/**
 * CodexAdapter - Codex implementation of the generic provider adapter contract.
 *
 * This service owns Codex app-server process / JSON-RPC semantics and emits
 * Codex provider events. It does not perform cross-provider routing, shared
 * event fan-out, or checkpoint orchestration.
 *
 * Uses Effect `ServiceMap.Service` for dependency injection and returns the
 * shared provider-adapter error channel with `provider: "codex"` context.
 *
 * @module CodexAdapter
 */
import type { ProviderSession, RuntimeSessionId, ThreadId } from "@synara/contracts";
import { ServiceMap, type Effect } from "effect";

import type { ProviderAdapterError } from "../Errors.ts";
import type { ProviderAdapterShape } from "./ProviderAdapter.ts";

/**
 * CodexAdapterShape - Service API for the Codex provider adapter.
 */
export interface CodexAdapterShape extends ProviderAdapterShape<ProviderAdapterError> {
  readonly provider: "codex";

  /**
   * Stop all normal and discovery runtimes bound to one exact Codex account,
   * and resolve only after every child process has exited.
   */
  readonly stopAccountContextsAndWait: (input: {
    readonly homePath: string;
    readonly accountId: string;
    readonly runtimeGeneration?: string;
  }) => Effect.Effect<ReadonlyArray<ProviderSession>, ProviderAdapterError>;

  /** Stop only the exact Codex launch currently occupying a thread slot. */
  readonly stopSessionIfCurrent?: (
    threadId: ThreadId,
    sessionId: RuntimeSessionId,
  ) => Effect.Effect<boolean, ProviderAdapterError>;
}

/**
 * CodexAdapter - Service tag for Codex provider adapter operations.
 */
export class CodexAdapter extends ServiceMap.Service<CodexAdapter, CodexAdapterShape>()(
  "moss/provider/Services/CodexAdapter",
) {}
