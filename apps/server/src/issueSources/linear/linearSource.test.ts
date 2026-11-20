import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { McpConnectorError } from "../../mcpConnectors/Services/McpConnectors";
import type { McpConnectorToolCallResult } from "../../mcpConnectors/tools";
import { fakeConnectors as fakeConnectorsFor, jsonAnswer as json } from "../testing/fakeConnectors";
import { makeLinearSource } from "./linearSource";

function fakeConnectors(
  answer: (tool: string, args: Record<string, unknown>) => McpConnectorToolCallResult,
  connector: null | undefined = undefined,
) {
  return fakeConnectorsFor(answer, { presetId: "linear", connected: connector !== null });
}

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

describe("Linear issue source", () => {
  it("says Linear is not connected before calling anything", async () => {
    const fake = fakeConnectors(() => json([]), null);
    const service = makeLinearSource({ connectors: fake.connectors });

    expect(await run(service.status())).toEqual({ state: "not-connected", teams: [] });
    const failure = await run(service.list({ teamIds: ["t1"], state: "open" }).pipe(Effect.flip));
    expect(failure.reason).toBe("not-connected");
    expect(fake.calls).toEqual([]);
  });

  it("lists teams, then open and closed issues per team from one cached read", async () => {
    const fake = fakeConnectors((tool) => {
      if (tool === "list_teams") return json({ teams: [{ id: "t1", name: "Eng", key: "ENG" }] });
      if (tool === "list_issue_statuses") {
        return json([
          { name: "Todo", type: "unstarted" },
          { name: "Shipped", type: "completed" },
        ]);
      }
      if (tool === "list_issues") {
        return json([
          {
            id: "a",
            identifier: "ENG-1",
            title: "Open one",
            status: "Todo",
            updatedAt: "2026-11-01T00:00:00Z",
          },
          { id: "b", identifier: "ENG-2", title: "Shipped one", status: "Shipped" },
          {
            id: "c",
            identifier: "ENG-3",
            title: "Newer open",
            status: "Todo",
            updatedAt: "2026-11-05T00:00:00Z",
          },
        ]);
      }
      return json([]);
    });
    let time = 0;
    const service = makeLinearSource({ connectors: fake.connectors, now: () => time });

    expect(await run(service.status())).toEqual({
      state: "connected",
      teams: [{ id: "t1", name: "Eng", key: "ENG" }],
    });
    const open = await run(service.list({ teamIds: ["t1"], state: "open" }));
    const closed = await run(service.list({ teamIds: ["t1"], state: "closed" }));

    expect(open.items.map((issue) => issue.identifier)).toEqual(["ENG-3", "ENG-1"]);
    expect(closed.items.map((issue) => issue.identifier)).toEqual(["ENG-2"]);
    expect(open.failedTeamIds).toEqual([]);
    expect(fake.calls.filter((call) => call.tool === "list_issues")).toEqual([
      { tool: "list_issues", args: { team: "t1", limit: 100, orderBy: "updatedAt" } },
    ]);
    time = 61_000;
    await run(service.list({ teamIds: ["t1"], state: "open" }));
    expect(fake.calls.filter((call) => call.tool === "list_issues")).toHaveLength(2);
  });

  it("names a team Linear did not answer for instead of failing the list", async () => {
    const fake = fakeConnectors((tool, args) =>
      tool === "list_issues" && args.team === "broken"
        ? { isError: true, text: "Team not found", structured: null }
        : json([{ id: "a", title: "Fine", status: "Todo" }]),
    );
    const service = makeLinearSource({ connectors: fake.connectors });

    const result = await run(service.list({ teamIds: ["ok", "broken"], state: "open" }));
    expect(result.items.map((issue) => issue.id)).toEqual(["a"]);
    expect(result.failedTeamIds).toEqual(["broken"]);
  });

  it("sends updates by name, drops the cached lists, and reports tool failures", async () => {
    let refuse = false;
    const fake = fakeConnectors((tool) => {
      if (tool === "update_issue" && refuse) {
        return { isError: true, text: "Assignee not found", structured: null };
      }
      return json(tool === "list_issues" ? [{ id: "a", title: "T", status: "Todo" }] : {});
    });
    const service = makeLinearSource({ connectors: fake.connectors });

    await run(service.list({ teamIds: ["t1"], state: "open" }));
    await run(service.update({ id: "a", update: { op: "setState", state: "Done" } }));
    await run(service.update({ id: "a", update: { op: "setAssignee", assignee: null } }));
    await run(service.comment({ id: "a", body: "Looks good" }));
    await run(service.list({ teamIds: ["t1"], state: "open" }));
    refuse = true;
    const failure = await run(
      service.update({ id: "a", update: { op: "setLabels", labels: ["Bug"] } }).pipe(Effect.flip),
    );

    expect(fake.calls.filter((call) => call.tool !== "list_issue_statuses")).toEqual([
      { tool: "list_issues", args: { team: "t1", limit: 100, orderBy: "updatedAt" } },
      { tool: "update_issue", args: { id: "a", state: "Done" } },
      { tool: "update_issue", args: { id: "a", assignee: null } },
      { tool: "create_comment", args: { issueId: "a", body: "Looks good" } },
      { tool: "list_issues", args: { team: "t1", limit: 100, orderBy: "updatedAt" } },
      { tool: "update_issue", args: { id: "a", labels: ["Bug"] } },
    ]);
    expect(failure).toMatchObject({ reason: "failed", message: "Assignee not found" });
  });

  it("reads an issue with its comments, and still reads it when comments fail", async () => {
    const fake = fakeConnectors((tool) => {
      if (tool === "get_issue") {
        return json({
          id: "a",
          identifier: "ENG-1",
          title: "T",
          description: "D",
          team: { id: "t1", name: "Eng" },
          state: { name: "Shipped" },
        });
      }
      if (tool === "list_issue_statuses") return json([{ name: "Shipped", type: "completed" }]);
      return { isError: true, text: "nope", structured: null };
    });
    const service = makeLinearSource({ connectors: fake.connectors });

    const detail = await run(service.detail({ id: "a" }));
    expect(detail).toMatchObject({
      identifier: "ENG-1",
      description: "D",
      state: { name: "Shipped", type: "completed" },
      comments: [],
    });
  });

  it("turns a connector failure into a Linear failure", async () => {
    const fake = fakeConnectors(() => json({}));
    const service = makeLinearSource({
      connectors: {
        ...fake.connectors,
        callTool: () => Effect.fail(new McpConnectorError({ message: "Sign in again." })),
      },
    });

    const failure = await run(service.detail({ id: "a" }).pipe(Effect.flip));
    expect(failure).toMatchObject({ reason: "failed", message: "Sign in again." });
  });

  it("isolates list and status caches across connector switches and reconnects", async () => {
    const fake = fakeConnectorsFor(
      (tool, _args, id) => {
        if (tool === "list_issue_statuses") {
          return json(
            id === "conn-a"
              ? [{ name: "DoneA", type: "completed" }]
              : [{ name: "DoneB", type: "completed" }],
          );
        }
        if (tool === "list_issues") {
          return json(
            id === "conn-a"
              ? [{ id: "a1", identifier: "A-1", title: "Account A", status: "Todo" }]
              : [{ id: "b1", identifier: "B-1", title: "Account B", status: "Todo" }],
          );
        }
        return json([]);
      },
      { presetId: "linear", connectorId: "conn-a", updatedAt: "2026-11-01T00:00:00.000Z" },
    );
    const service = makeLinearSource({ connectors: fake.connectors, now: () => 0 });

    const first = await run(service.list({ teamIds: ["t1"], state: "open" }));
    expect(first.items.map((issue) => issue.identifier)).toEqual(["A-1"]);

    // Switching to another connector must not serve account A's cached issues or statuses.
    fake.setConnector({ connectorId: "conn-b", updatedAt: "2026-11-01T00:00:00.000Z" });
    const second = await run(service.list({ teamIds: ["t1"], state: "open" }));
    expect(second.items.map((issue) => issue.identifier)).toEqual(["B-1"]);
    expect(fake.calls.filter((call) => call.tool === "list_issue_statuses")).toHaveLength(2);
    expect(fake.calls.filter((call) => call.tool === "list_issues")).toHaveLength(2);

    // Reconnecting the same connector id with a new updatedAt also drops prior caches.
    fake.setConnector({ connectorId: "conn-b", updatedAt: "2026-11-01T00:05:00.000Z" });
    await run(service.list({ teamIds: ["t1"], state: "open" }));
    expect(fake.calls.filter((call) => call.tool === "list_issues")).toHaveLength(3);
  });
});
