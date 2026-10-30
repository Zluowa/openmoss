// FILE: mcpAppResource.ts
// Purpose: Fetch and decode one MCP App resource through the authenticated
// server route. This helper never persists, logs, injects, or executes HTML.

import {
  McpAppResourceReadInput,
  McpAppResourceReadResult,
  type McpAppResourceReadResult as McpAppResourceReadResultData,
} from "@synara/contracts";
import { MCP_APP_RESOURCE_READ_ROUTE_PATH } from "@synara/shared/mcpAppResource";
import { Schema } from "effect";

import { resolveWsHttpUrl } from "./wsHttpUrl";

const decodeMcpAppResourceReadResult = Schema.decodeUnknownSync(McpAppResourceReadResult);

export interface FetchMcpAppResourceOptions {
  readonly signal?: AbortSignal;
}

function expectedOriginCallId(input: McpAppResourceReadInput): string | undefined {
  return input.server === "codex_apps" && input.source === "appContext" ? input.callId : undefined;
}

function assertMcpAppResourceResultMatchesRequest(
  input: McpAppResourceReadInput,
  result: McpAppResourceReadResultData,
): void {
  if (result.resourceUri !== input.resourceUri) {
    throw new Error("MCP App resource response did not match the requested resource.");
  }
  const expectedCallId = expectedOriginCallId(input);
  if (expectedCallId !== undefined && result.state === "ready") {
    if (result.originCallId !== expectedCallId) {
      throw new Error("MCP resource read did not confirm its originating tool call");
    }
  }
}

export async function fetchMcpAppResource(
  rawInput: McpAppResourceReadInput,
  options: FetchMcpAppResourceOptions = {},
): Promise<McpAppResourceReadResultData> {
  const input = Schema.decodeUnknownSync(McpAppResourceReadInput)(rawInput);
  const response = await fetch(resolveWsHttpUrl(MCP_APP_RESOURCE_READ_ROUTE_PATH), {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(input),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  });
  if (!response.ok) {
    throw new Error(`MCP App resource request failed with HTTP ${response.status}.`);
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    throw new Error("MCP App resource response was not valid JSON.");
  }
  let result: McpAppResourceReadResultData;
  try {
    result = decodeMcpAppResourceReadResult(body);
  } catch {
    throw new Error("MCP App resource response did not match its contract.");
  }
  assertMcpAppResourceResultMatchesRequest(input, result);
  return result;
}

export const readMcpAppResource = fetchMcpAppResource;
