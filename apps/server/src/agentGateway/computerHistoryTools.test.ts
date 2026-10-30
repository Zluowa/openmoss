import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { ComputerHistoryService } from "../computerHistory/service.ts";
import { makeAgentGatewayComputerHistoryTools } from "./computerHistoryTools.ts";
import type { ToolContext } from "./toolRuntime.ts";

type HistoryCapability = "history:status" | "history:query";

function makeContext(input: {
  readonly capability: HistoryCapability;
  readonly sessionKey?: string;
  readonly turnId?: string | null;
  readonly callerThreadId?: string;
}): ToolContext {
  const sessionKey = input.sessionKey ?? "session-history-test";
  const turnId = input.turnId === undefined ? "turn-history-test" : input.turnId;
  const threadId = input.callerThreadId ?? "thread-history-test";
  return {
    callerThreadId: threadId,
    callerThreadLabel: null,
    callerProvider: "codex",
    callerCapabilities: new Set([input.capability]),
    principal: {
      kind: "provider-session",
      sessionKey,
      threadId,
      provider: "codex",
      turnId,
    },
    callerSessionKey: sessionKey,
    callerTurnId: turnId,
    assertCallerTurnActive: () => Effect.void,
    jsonRpcRequestId: 1,
  };
}

function makeState(input: { readonly supported?: boolean; readonly enabled?: boolean } = {}) {
  return {
    supported: input.supported ?? true,
    enabled: input.enabled ?? true,
    recorderState: "running" as const,
    activationState: "idle" as const,
    inputMonitoringPermission: "granted" as const,
    accessibilityPermission: "granted" as const,
    screenRecordingPermission: "granted" as const,
    privateBrowsingExcluded: true,
    browserCapabilities: [],
    captureCapability: {
      mode: "window_metadata_only" as const,
      interactionEvents: false,
      activitySummaries: false,
      detail: "metadata only",
    },
    settings: {
      consentAt: "2026-08-19T00:00:00.000Z",
      observation: {
        defaultApplicationBehavior: "allow" as const,
        defaultURLBehavior: "allow" as const,
        allowlist: [],
        blocklist: [],
        urlAllowlist: [],
        urlBlocklist: [],
      },
    },
    health: {
      droppedEvents: 0,
      queueDepth: 0,
      storageBytes: 0,
      lastError: null,
      corruptionDetected: false,
      keychainState: "ready" as const,
    },
    message: null,
  };
}

function makeHarness(input: { readonly now?: () => number } = {}) {
  let state = makeState();
  let listHistoryCalls = 0;
  const audits: Array<{ readonly tool: string }> = [];
  const service = {
    getState: async () => state,
    listHistory: async () => {
      listHistoryCalls += 1;
      return {
        entries: [
          {
            id: "history-summary-10min-safe",
            summaryLevel: "ten_minute" as const,
            interval: { startMs: 0, endMs: 600_000 },
            title: "Opened /Users/moss/secret.txt",
            description: "Editor · https://private.example/path",
            applications: [
              {
                bundleIdentifier: "com.example.editor",
                displayName: "Editor",
                iconDataURL: "data:image/png;base64,AAAA",
              },
            ],
            memoryFilePath: "/Users/moss/.moss/resources/history.md",
            suggestion: {
              type: "skill" as const,
              name: "Review editor activity",
              description: "Review editor activity.",
            },
          },
        ],
        nextCursor: null,
        modelContextDisclosure: {
          included: false,
          notImplicitlyInjected: true,
          text: "not implicitly injected",
        },
      };
    },
    recordAccessAudit: async (audit: { readonly tool: string }) => {
      audits.push(audit);
    },
  } as unknown as ComputerHistoryService;
  const tools = makeAgentGatewayComputerHistoryTools({
    service,
    ...(input.now ? { now: input.now } : {}),
  });
  const statusTool = tools.find((tool) => tool.definition.name === "history_status")!;
  const queryTool = tools.find((tool) => tool.definition.name === "history_query")!;
  return {
    service,
    tools,
    statusTool,
    queryTool,
    audits,
    get listHistoryCalls() {
      return listHistoryCalls;
    },
    setState(next: { readonly supported?: boolean; readonly enabled?: boolean }) {
      state = makeState(next);
    },
  };
}

async function callStatus(
  harness: ReturnType<typeof makeHarness>,
  context = makeContext({ capability: "history:status" }),
) {
  return await Effect.runPromise(harness.statusTool.handler({}, context));
}

async function callQuery(
  harness: ReturnType<typeof makeHarness>,
  context = makeContext({ capability: "history:query" }),
  args: Record<string, unknown> = {},
) {
  return await Effect.runPromise(harness.queryTool.handler(args, context));
}

describe("Agent Gateway Computer History tools", () => {
  it("requires an active turn for both tools and keeps the exact capability grants", () => {
    const harness = makeHarness();
    expect(harness.tools.map((tool) => tool.definition.name)).toEqual([
      "history_status",
      "history_query",
    ]);
    expect(harness.tools.map((tool) => tool.requiredCapability)).toEqual([
      "history:status",
      "history:query",
    ]);
    expect(harness.tools.every((tool) => tool.requiresActiveTurn === true)).toBe(true);
    expect(harness.tools.every((tool) => tool.definition.annotations?.readOnlyHint === true)).toBe(
      true,
    );
  });

  it("rejects a query without a same-turn positive status receipt before listHistory or query audit", async () => {
    const harness = makeHarness();
    const result = await callQuery(harness);
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("history_status");
    expect(harness.listHistoryCalls).toBe(0);
    expect(harness.audits).toHaveLength(0);
  });

  it("allows repeated narrow queries only after status in the same session and turn", async () => {
    const harness = makeHarness();
    const context = { sessionKey: "session-a", turnId: "turn-a" };
    const status = await callStatus(
      harness,
      makeContext({ capability: "history:status", ...context }),
    );
    const query = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...context }),
      { limit: 20 },
    );
    const secondQuery = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...context }),
      { limit: 1 },
    );
    expect(status.isError).not.toBe(true);
    expect(query.isError).not.toBe(true);
    expect(secondQuery.isError).not.toBe(true);
    expect(harness.listHistoryCalls).toBe(2);
    expect(harness.audits.map((audit) => audit.tool)).toEqual([
      "history_status",
      "history_query",
      "history_query",
    ]);
  });

  it.each([
    ["different session", { sessionKey: "session-b", turnId: "turn-a" }],
    ["different turn", { sessionKey: "session-a", turnId: "turn-b" }],
  ])("does not transfer a receipt across %s", async (_label, queryContext) => {
    const harness = makeHarness();
    await callStatus(
      harness,
      makeContext({ capability: "history:status", sessionKey: "session-a", turnId: "turn-a" }),
    );
    const result = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...queryContext }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("history_status");
    expect(harness.listHistoryCalls).toBe(0);
    expect(harness.audits).toHaveLength(1);
  });

  it("expires a status receipt after the bounded short TTL", async () => {
    let clock = 1_000;
    const harness = makeHarness({ now: () => clock });
    const context = { sessionKey: "session-a", turnId: "turn-a" };
    await callStatus(harness, makeContext({ capability: "history:status", ...context }));
    clock += 2 * 60 * 1000;
    const result = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...context }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("history_status");
    expect(harness.listHistoryCalls).toBe(0);
    expect(harness.audits).toHaveLength(1);
  });

  it.each([
    ["unsupported", { supported: false, enabled: true }],
    ["disabled", { supported: true, enabled: false }],
  ])(
    "does not authorize query after a negative/disabled status (%s)",
    async (_label, nextState) => {
      const harness = makeHarness();
      harness.setState(nextState);
      const context = { sessionKey: "session-a", turnId: "turn-a" };
      const status = await callStatus(
        harness,
        makeContext({ capability: "history:status", ...context }),
      );
      const query = await callQuery(
        harness,
        makeContext({ capability: "history:query", ...context }),
      );
      expect(status.isError).not.toBe(true);
      expect(query.isError).toBe(true);
      expect(harness.listHistoryCalls).toBe(0);
      expect(harness.audits.map((audit) => audit.tool)).toEqual(["history_status"]);
    },
  );

  it("invalidates the receipt when the recorder is stopped after status", async () => {
    const harness = makeHarness();
    const context = { sessionKey: "session-a", turnId: "turn-a" };
    await callStatus(harness, makeContext({ capability: "history:status", ...context }));
    harness.setState({ supported: true, enabled: false });
    const result = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...context }),
    );
    expect(result.isError).toBe(true);
    expect((result.content[0] as { text: string }).text).toContain("no longer");
    expect(harness.listHistoryCalls).toBe(0);
    expect(harness.audits).toHaveLength(1);
  });

  it("keeps the model projection free of icon payloads, local paths, and URLs", async () => {
    const harness = makeHarness();
    const context = { sessionKey: "session-a", turnId: "turn-a" };
    await callStatus(harness, makeContext({ capability: "history:status", ...context }));
    const result = await callQuery(
      harness,
      makeContext({ capability: "history:query", ...context }),
      { limit: 1 },
    );
    const text = (result.content[0] as { text: string }).text;
    const payload = JSON.parse(text) as Record<string, unknown>;
    const entry = (payload.entries as Array<Record<string, unknown>>)[0]!;
    expect(entry).toMatchObject({
      summaryLevel: "ten_minute",
      interval: { startMs: 0, endMs: 600_000 },
      applications: [{ bundleIdentifier: "com.example.editor", displayName: "Editor" }],
    });
    expect(text).not.toContain("data:image");
    expect(text).not.toContain("memoryFilePath");
    expect(text).not.toContain("/Users/moss");
    expect(text).not.toContain("private.example");
    expect(entry).not.toHaveProperty("urlHost");
    expect(entry).not.toHaveProperty("app");
    expect(entry).not.toHaveProperty("memoryFilePath");
  });

  it("bounds receipts to 512 callers and evicts the oldest entry", async () => {
    const harness = makeHarness();
    for (let index = 0; index < 513; index += 1) {
      await callStatus(
        harness,
        makeContext({
          capability: "history:status",
          sessionKey: `session-${index}`,
          turnId: "turn-a",
        }),
      );
    }
    const evicted = await callQuery(
      harness,
      makeContext({ capability: "history:query", sessionKey: "session-0", turnId: "turn-a" }),
    );
    const retained = await callQuery(
      harness,
      makeContext({ capability: "history:query", sessionKey: "session-512", turnId: "turn-a" }),
    );
    expect(evicted.isError).toBe(true);
    expect(retained.isError).not.toBe(true);
    expect(harness.listHistoryCalls).toBe(1);
  });
});
