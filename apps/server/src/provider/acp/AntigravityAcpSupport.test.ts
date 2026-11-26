import type * as Acp from "@agentclientprotocol/sdk";
import { Effect, Exit } from "effect";
import { describe, expect, it } from "vitest";

import { parseSessionUpdateEvent } from "./AcpRuntimeModel.ts";
import { loadAcpSessionNotificationValidator } from "./AcpSdk.ts";
import {
  antigravityInteractionQuestion,
  antigravitySupportsTurnSteering,
  buildAntigravityAcpSpawnInput,
  chooseAntigravityAcpModel,
  normalizeAntigravityToolCallUpdate,
  readAntigravityAcpModels,
  resolveAntigravityAcpAuthMethodId,
  resolveAntigravityAcpModelId,
  resolveAntigravityInteractionOptionId,
  withAntigravityToolSummary,
} from "./AntigravityAcpSupport.ts";

const toolUpdate = (update: Record<string, unknown>) => ({
  jsonrpc: "2.0",
  method: "session/update",
  params: { sessionId: "s1", update },
});

const updateOf = (message: unknown) =>
  (message as { params: { update: Record<string, unknown> } }).params.update;

describe("Antigravity ACP support", () => {
  it("starts agy in ACP mode with full access", () => {
    const spawn = buildAntigravityAcpSpawnInput({ binaryPath: "/opt/agy" }, "/repo");
    expect(spawn.command).toBe("/opt/agy");
    expect(spawn.args).toEqual(["acp", "--dangerously-skip-permissions"]);
    expect(spawn.cwd).toBe("/repo");
  });

  it("names MCP calls server__tool using the session's server names", () => {
    const update = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-1",
          name: "mcp_probe_notes_connector_read_ideas",
          kind: "other",
          title: "Run mcp_probe_notes_connector_read_ideas",
          rawInput: { toolSummary: "Read saved ideas" },
        }),
        ["moss", "probe_notes", "probe_notes_connector"],
      ),
    );
    expect(update.title).toBe("mcp__probe_notes_connector__read_ideas");
    expect(update.rawInput).toEqual({
      toolSummary: "Read saved ideas",
      _toolName: "mcp__probe_notes_connector__read_ideas",
    });
  });

  it("names lazy call_mcp_tool calls and Moss tools the same way", () => {
    const lazy = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-2",
          name: "call_mcp_tool",
          title: "Run call_mcp_tool",
          rawInput: { ServerName: "notion", ToolName: "notion-search", Arguments: {} },
        }),
      ),
    );
    expect(lazy.title).toBe("mcp__notion__notion-search");
    const moss = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call_update",
          toolCallId: "call-3",
          name: "mcp_moss_computer_click",
          title: "Run mcp_moss_computer_click",
        }),
        ["moss"],
      ),
    );
    expect(moss.rawInput).toEqual({ _toolName: "mcp__moss__computer_click" });
  });

  it("exposes run_command lines and keeps 'File' tool_call notifications schema-valid", async () => {
    const isSessionNotification = await loadAcpSessionNotificationValidator();
    const command = updateOf(
      normalizeAntigravityToolCallUpdate(
        toolUpdate({
          sessionUpdate: "tool_call",
          toolCallId: "call-4",
          name: "run_command",
          kind: "execute",
          title: "ls -la",
          rawInput: { CommandLine: "ls -la", toolSummary: "List files" },
        }),
      ),
    );
    expect(command.title).toBe("ls -la");
    expect(command.rawInput).toMatchObject({ CommandLine: "ls -la", command: "ls -la" });
    const normalizedRead = normalizeAntigravityToolCallUpdate(
      toolUpdate({
        sessionUpdate: "tool_call",
        toolCallId: "call-5",
        name: "read_file",
        kind: "read",
        title: "File README.md",
        locations: [{ path: "/repo/README.md" }],
        rawInput: { Path: "/repo/README.md" },
      }),
    ) as { params: Acp.SessionNotification };
    // ACP `tool_call` requires `title: string`; omitting it triggers -32602 Invalid params.
    expect(normalizedRead.params.update).toMatchObject({ title: "" });
    expect(isSessionNotification(normalizedRead.params)).toBe(true);
    const parsedRead = parseSessionUpdateEvent(normalizedRead.params);
    expect(parsedRead.events[0]).toMatchObject({
      _tag: "ToolCallUpdated",
      toolCall: { kind: "read", title: "Reading", detail: "/repo/README.md" },
    });

    const normalizedReadUpdate = normalizeAntigravityToolCallUpdate(
      toolUpdate({
        sessionUpdate: "tool_call_update",
        toolCallId: "call-5",
        name: "read_file",
        kind: "read",
        status: "completed",
        title: "File README.md",
        locations: [{ path: "/repo/README.md" }],
      }),
    ) as { params: Acp.SessionNotification };
    expect(normalizedReadUpdate.params.update).not.toHaveProperty("title");
    expect(isSessionNotification(normalizedReadUpdate.params)).toBe(true);

    const chunk = toolUpdate({ sessionUpdate: "agent_message_chunk", content: { text: "hi" } });
    expect(normalizeAntigravityToolCallUpdate(chunk)).toBe(chunk);
  });

  it("extracts native interaction_* questions and resolves answers by id or label", () => {
    const request: Acp.RequestPermissionRequest = {
      sessionId: "s1",
      toolCall: {
        toolCallId: "interaction_1",
        title: "Which package manager should I use?",
      },
      options: [
        { optionId: "opt_bun", name: "Bun", kind: "allow_once" },
        { optionId: "opt_pnpm", name: "pnpm", kind: "allow_once" },
      ],
    };
    expect(antigravityInteractionQuestion(request)).toEqual({
      id: "interaction_1",
      header: "Question",
      question: "Which package manager should I use?",
      options: [
        { label: "Bun", description: "Bun" },
        { label: "pnpm", description: "pnpm" },
      ],
      multiSelect: false,
    });
    expect(resolveAntigravityInteractionOptionId(request, { interaction_1: "opt_bun" })).toBe(
      "opt_bun",
    );
    expect(resolveAntigravityInteractionOptionId(request, { interaction_1: "pnpm" })).toBe(
      "opt_pnpm",
    );
    expect(
      resolveAntigravityInteractionOptionId(request, { interaction_1: "npm" }),
    ).toBeUndefined();
    expect(
      antigravityInteractionQuestion({
        ...request,
        toolCall: { toolCallId: "call-regular", title: "Run ls" },
      }),
    ).toBeUndefined();
  });

  it("previews a call with its toolSummary only when nothing better exists", () => {
    const base = {
      toolCallId: "call-6",
      title: "mcp__notion__notion-search",
      detail: "mcp__notion__notion-search",
      data: { rawInput: { toolSummary: "Search Notion for app ideas" } },
    };
    expect(withAntigravityToolSummary(base).detail).toBe("Search Notion for app ideas");
    expect(withAntigravityToolSummary({ ...base, detail: "3 results" }).detail).toBe("3 results");
  });

  it("reads the session model list and resolves CLI labels to model ids", () => {
    const models = readAntigravityAcpModels({
      sessionId: "s1",
      models: {
        currentModelId: "gemini-4-neon-high",
        availableModels: [
          { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
          { modelId: "gemini-pro-orchestrator-neon", name: "Orchestrator (Neon)" },
        ],
      },
    });
    expect(models.currentModelId).toBe("gemini-4-neon-high");
    expect(resolveAntigravityAcpModelId(models.availableModels, "gemini 4 neon (high)")).toBe(
      "gemini-4-neon-high",
    );
    expect(resolveAntigravityAcpModelId(models.availableModels, "Orchestrator (Neon)")).toBe(
      "gemini-pro-orchestrator-neon",
    );
    expect(resolveAntigravityAcpModelId(models.availableModels, "Gemini 9")).toBeUndefined();
    expect(readAntigravityAcpModels({}).availableModels).toEqual([]);
  });

  it("keeps or defers the thinking level when a selection has none", () => {
    const models = [
      { modelId: "gemini-3.8-flash-high", name: "Gemini 3.8 Flash (High)" },
      { modelId: "gemini-3.8-flash-low", name: "Gemini 3.8 Flash (Low)" },
      { modelId: "gemini-4-neon-high", name: "Gemini 4 Neon (High)" },
    ];
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash (Low)", undefined)).toEqual({
      kind: "model",
      modelId: "gemini-3.8-flash-low",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash", "gemini-3.8-flash-low")).toEqual({
      kind: "model",
      modelId: "gemini-3.8-flash-low",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 3.8 Flash", "gemini-4-neon-high")).toEqual({
      kind: "base",
      baseName: "Gemini 3.8 Flash",
    });
    expect(chooseAntigravityAcpModel(models, "Gemini 9 Ultra", undefined)).toEqual({
      kind: "unavailable",
    });
  });

  it("authenticates with a Gemini API key and otherwise asks for sign-in", () => {
    const initialize = {
      protocolVersion: 1,
      authMethods: [
        { id: "oauth-personal", name: "Log in with Google" },
        { id: "gemini-api-key", name: "Gemini API key" },
      ],
    } as Acp.InitializeResponse;
    expect(
      Effect.runSync(resolveAntigravityAcpAuthMethodId(initialize, { GEMINI_API_KEY: "key" })),
    ).toBe("gemini-api-key");
    const exit = Effect.runSyncExit(resolveAntigravityAcpAuthMethodId(initialize, {}));
    expect(Exit.isFailure(exit)).toBe(true);
  });

  it("enables native turn steering only for Antigravity CLI 1.5.0+", () => {
    const init = (name?: string, version?: string) =>
      ({
        protocolVersion: 1,
        ...(name || version ? { agentInfo: { name: name ?? "", version: version ?? "" } } : {}),
      }) as Acp.InitializeResponse;

    expect(antigravitySupportsTurnSteering(init("agy", "1.5.0"))).toBe(true);
    expect(antigravitySupportsTurnSteering(init("Antigravity CLI", "v1.5.18+build.1"))).toBe(true);
    expect(antigravitySupportsTurnSteering(init("agy", "2.0.0"))).toBe(true);
    expect(antigravitySupportsTurnSteering(init("agy", "1.4.9"))).toBe(false);
    expect(antigravitySupportsTurnSteering(init("agy", "1.5.0-beta.1"))).toBe(false);
    expect(antigravitySupportsTurnSteering(init("other-agent", "1.5.0"))).toBe(false);
    expect(antigravitySupportsTurnSteering(init())).toBe(false);
  });
});
