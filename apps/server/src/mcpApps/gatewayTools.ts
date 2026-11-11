// FILE: gatewayTools.ts
// Purpose: The Moss gateway side of interactive connectors: the `moss_read_widget_context` tool
//   (SPEC §10), and the registration that lets widgets of `moss` tools list and call them through
//   the gateway's own transport with a short-lived session credential for the widget's thread.
// Layer: Agent gateway tool (Effect)
// Exports: makeReadWidgetContextTool, registerGatewayWithMcpApps

import { ThreadId, type ProviderKind } from "@moss/contracts";
import { Effect, Option } from "effect";

import type { AgentGatewayShape } from "../agentGateway/Services/AgentGateway.ts";
import type { AgentGatewayCredentialsShape } from "../agentGateway/Services/AgentGatewayCredentials.ts";
import { READ_ONLY_TOOL_ANNOTATIONS, type ToolEntry } from "../agentGateway/toolRuntime.ts";
import type { ProjectionSnapshotQueryShape } from "../orchestration/Services/ProjectionSnapshotQuery.ts";
import { MCP_APP_READ_WIDGET_CONTEXT_TOOL } from "./modelContext.ts";
import { McpAppRpcFailure } from "./connectorClient.ts";
import type { McpAppServiceShape } from "./Services/McpAppService.ts";

export function makeReadWidgetContextTool(service: McpAppServiceShape): ToolEntry {
  return {
    definition: {
      name: MCP_APP_READ_WIDGET_CONTEXT_TOOL,
      description:
        "Read what an interactive widget in this conversation shared with you, as it was when the user last sent a message. Call it only when a <widget_context_hint> names the widget; pass that widget's tool_name.",
      inputSchema: {
        type: "object",
        properties: {
          tool_name: {
            type: "string",
            description: "The widget's tool name, as the widget_context_hint lists it.",
          },
        },
        required: ["tool_name"],
        additionalProperties: false,
      },
      annotations: { title: "Read widget context", ...READ_ONLY_TOOL_ANNOTATIONS },
    },
    requiredCapability: "thread:read",
    handler: (args, context) =>
      Effect.sync(() => {
        const toolName = typeof args.tool_name === "string" ? args.tool_name.trim() : "";
        if (!toolName) {
          return {
            content: [{ type: "text" as const, text: "缺少参数 tool_name。" }],
            isError: true,
          };
        }
        const answer = service.modelContext.readSnapshot(context.callerThreadId, toolName);
        return {
          content: answer.content.map((block) =>
            block.type === "text"
              ? { type: "text" as const, text: block.text }
              : { type: "image" as const, data: block.data, mimeType: block.mimeType },
          ),
          ...(answer.isError ? { isError: true } : {}),
        };
      }),
  };
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : undefined;
}

/**
 * Lets widgets of `moss` tools reach the gateway: their calls run through the same transport,
 * capability checks and handlers a provider's call would, under a one-call credential bound to the
 * widget's thread and its provider, revoked as soon as the call answers.
 */
export function registerGatewayWithMcpApps(input: {
  readonly service: McpAppServiceShape;
  readonly tools: ReadonlyArray<ToolEntry>;
  readonly handleMcpPost: AgentGatewayShape["handleMcpPost"];
  readonly credentials: AgentGatewayCredentialsShape;
  readonly snapshotQuery: ProjectionSnapshotQueryShape;
}): void {
  input.service.registerGateway({
    listTools: () =>
      input.tools.map((tool) => tool.definition as unknown as Record<string, unknown>),
    callTool: (call) =>
      Effect.gen(function* () {
        const shell = yield* input.snapshotQuery
          .getThreadShellById(ThreadId.makeUnsafe(call.threadId))
          .pipe(Effect.catch(() => Effect.succeed(Option.none())));
        if (Option.isNone(shell)) {
          return yield* Effect.fail(
            new McpAppRpcFailure(-32603, "This conversation no longer exists."),
          );
        }
        const provider = (shell.value.session?.providerName ??
          shell.value.modelSelection.provider) as ProviderKind;
        const token = input.credentials.issueSessionToken(
          ThreadId.makeUnsafe(call.threadId),
          provider,
        );
        const answer = yield* input
          .handleMcpPost({
            authorizationHeader: `Bearer ${token}`,
            body: {
              jsonrpc: "2.0",
              id: 1,
              method: "tools/call",
              params: {
                name: call.name,
                arguments: call.arguments,
                ...(call.meta ? { _meta: call.meta } : {}),
              },
            },
          })
          .pipe(Effect.ensuring(Effect.sync(() => input.credentials.revokeSessionToken(token))));
        const body = asRecord(answer.body);
        const error = asRecord(body?.error);
        if (error) {
          return yield* Effect.fail(
            new McpAppRpcFailure(
              typeof error.code === "number" ? error.code : -32603,
              typeof error.message === "string" ? error.message : "The Moss tool refused.",
            ),
          );
        }
        const result = asRecord(body?.result);
        if (!result) {
          return yield* Effect.fail(new McpAppRpcFailure(-32603, "The Moss tool sent no result."));
        }
        return result;
      }).pipe(
        // A refused or failed gateway call reaches the widget as a tool error result.
        Effect.catch((error: unknown) =>
          Effect.succeed<Record<string, unknown>>({
            content: [
              {
                type: "text",
                text: error instanceof Error ? error.message : "The Moss tool failed.",
              },
            ],
            isError: true,
          }),
        ),
      ),
  });
}
