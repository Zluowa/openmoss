import type { BrowserToolName, ProviderKind, ThreadId } from "@moss/contracts";
import { ServiceMap, type Effect } from "effect";

import type { BrowserHostRpcError } from "../browserHostRpcClient.ts";

export interface BrowserAutomationHostCall {
  readonly sessionKey: string;
  readonly provider: ProviderKind;
  readonly threadId: ThreadId;
  readonly name: BrowserToolName;
  readonly arguments: Record<string, unknown>;
  /** Server-resolved authenticated thread workspace. Never accepted from MCP arguments. */
  readonly workspaceRoot?: string;
  readonly timeoutMs: number;
}

export interface BrowserAutomationHostShape {
  readonly available: boolean;
  readonly execute: (
    input: BrowserAutomationHostCall,
  ) => Effect.Effect<unknown, BrowserHostRpcError>;
  /**
   * A one-time note for this thread's agent, such as a person handing browser
   * control back. Hosts without such events omit it.
   */
  readonly consumeNotice?: (threadId: string) => string | undefined;
}

export class BrowserAutomationHost extends ServiceMap.Service<
  BrowserAutomationHost,
  BrowserAutomationHostShape
>()("moss/browserAutomation/Services/BrowserAutomationHost") {}
