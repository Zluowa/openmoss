// FILE: fakeConnectors.ts
// Purpose: A scripted connector for issue source tests: answers each tool call from a function,
//          lists the tools a test declares, and records every call.
// Layer: Server test utility (imported by *.test.ts only)
// Exports: fakeConnectors, jsonAnswer

import type { McpConnector } from "@moss/contracts";
import { Effect } from "effect";

import type { McpConnectorToolCallResult, McpConnectorToolInput } from "../../mcpConnectors/tools";
import type { IssueSourceConnectors } from "../issueSource";

export function jsonAnswer(value: unknown): McpConnectorToolCallResult {
  return { isError: false, text: JSON.stringify(value), structured: null };
}

export function fakeConnectors(
  answer: (
    tool: string,
    args: Record<string, unknown>,
    connectorId: string,
  ) => McpConnectorToolCallResult,
  options: {
    readonly presetId: string;
    readonly connected?: boolean;
    readonly connectorId?: string;
    readonly updatedAt?: string;
    /** Tool name → its input property names, as `tools/list` would give them. */
    readonly tools?: Record<string, ReadonlyArray<string>>;
  },
) {
  const calls: Array<{ tool: string; args: Record<string, unknown> }> = [];
  const toolInputCalls: Array<string> = [];
  let connector: McpConnector | null =
    options.connected === false
      ? null
      : ({
          connectorId: options.connectorId ?? `conn-${options.presetId}`,
          presetId: options.presetId,
          status: "connected",
          updatedAt: options.updatedAt ?? "2026-11-01T00:00:00.000Z",
        } as unknown as McpConnector);
  let inputs = new Map<string, McpConnectorToolInput>(
    Object.entries(options.tools ?? {}).map(([name, properties]) => [
      name,
      { properties, required: [] },
    ]),
  );
  const connectors: IssueSourceConnectors = {
    enabled: true,
    findConnectedPreset: () => Effect.succeed(connector),
    callTool: (id, tool, args) =>
      Effect.sync(() => {
        calls.push({ tool, args });
        return answer(tool, args, id);
      }),
    listToolInputs: (id) =>
      Effect.sync(() => {
        toolInputCalls.push(id);
        return inputs;
      }),
  };
  return {
    calls,
    toolInputCalls,
    connectors,
    setConnector: (
      next: {
        readonly connectorId: string;
        readonly status?: "connected" | "needs-auth";
        readonly updatedAt?: string;
      } | null,
    ) => {
      connector =
        next === null
          ? null
          : ({
              connectorId: next.connectorId,
              presetId: options.presetId,
              status: next.status ?? "connected",
              updatedAt: next.updatedAt ?? "2026-11-01T00:00:00.000Z",
            } as unknown as McpConnector);
    },
    setTools: (next: Record<string, ReadonlyArray<string>>) => {
      inputs = new Map<string, McpConnectorToolInput>(
        Object.entries(next).map(([name, properties]) => [name, { properties, required: [] }]),
      );
    },
  };
}
