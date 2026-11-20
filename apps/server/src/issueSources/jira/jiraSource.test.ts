import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import { fakeConnectors, jsonAnswer } from "../testing/fakeConnectors";
import { makeJiraSource } from "./jiraSource";
import { adfToText, jiraListJql, jiraStateType, parseJiraIssueId } from "./jiraIssues.logic";

const run = <A, E>(effect: Effect.Effect<A, E>) => Effect.runPromise(effect);

const SITE = { id: "cloud-1", name: "Acme", url: "https://acme.atlassian.net", scopes: [] };

const ISSUE = {
  id: "10001",
  key: "WEB-42",
  fields: {
    summary: "Checkout button does nothing on Safari",
    status: { name: "In Progress", statusCategory: { key: "indeterminate" } },
    assignee: {
      accountId: "acc-1",
      displayName: "Lin Qiao",
      avatarUrls: { "48x48": "https://a/1.png" },
    },
    reporter: { accountId: "acc-2", displayName: "Chen Yu" },
    labels: ["safari", "checkout"],
    created: "2026-11-10T08:00:00.000+0000",
    updated: "2026-11-12T09:30:00.000+0000",
    project: { key: "WEB", name: "Web" },
    description: {
      type: "doc",
      version: 1,
      content: [
        { type: "paragraph", content: [{ type: "text", text: "Clicking Pay does nothing." }] },
        {
          type: "bulletList",
          content: [
            {
              type: "listItem",
              content: [{ type: "paragraph", content: [{ type: "text", text: "Safari 18" }] }],
            },
          ],
        },
      ],
    },
    comment: {
      comments: [
        {
          id: "c1",
          author: { accountId: "acc-2", displayName: "Chen Yu" },
          body: {
            type: "doc",
            content: [{ type: "paragraph", content: [{ type: "text", text: "Seen it too." }] }],
          },
          created: "2026-11-11T10:00:00.000+0000",
        },
      ],
    },
  },
};

describe("Jira issue logic", () => {
  it("lists the person's own work, open or done", () => {
    expect(jiraListJql("open")).toBe(
      "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser()) AND statusCategory != Done ORDER BY updated DESC",
    );
    expect(jiraListJql("closed")).toContain("statusCategory = Done");
  });

  it("maps Jira's status categories, reading won't-do names as canceled", () => {
    expect(jiraStateType("new", "To Do")).toBe("unstarted");
    expect(jiraStateType("indeterminate", "In Review")).toBe("started");
    expect(jiraStateType("done", "Done")).toBe("completed");
    expect(jiraStateType("done", "Won't Do")).toBe("canceled");
    expect(jiraStateType(null, "Resolved")).toBe("completed");
  });

  it("keeps the site in Moss's id and reads it back", () => {
    expect(parseJiraIssueId("cloud-1:WEB-42")).toEqual({ cloudId: "cloud-1", key: "WEB-42" });
    expect(parseJiraIssueId("WEB-42")).toBeNull();
  });

  it("turns Atlassian Document Format into plain text", () => {
    expect(adfToText(ISSUE.fields.description)).toBe("Clicking Pay does nothing.\n\n- Safari 18");
    expect(adfToText("Already plain")).toBe("Already plain");
  });
});

describe("Jira issue source", () => {
  const V2_TOOLS = {
    getAccessibleAtlassianResources: [],
    searchJiraIssuesUsingJql: ["cloudId", "jql", "maxResults", "fields"],
    getJiraIssue: ["cloudId", "issueIdOrKey"],
    editJiraIssue: ["cloudId", "issueIdOrKey", "fields"],
    listJiraIssueTransitions: ["cloudId", "issueIdOrKey"],
    transitionJiraIssue: ["cloudId", "issueIdOrKey", "transition"],
    addOrEditJiraIssueComment: ["cloudId", "issueIdOrKey", "commentBody"],
    listJiraIssueAssignableUsers: ["cloudId", "issueIdOrKey"],
  };

  function v2Server() {
    return fakeConnectors(
      (tool) => {
        switch (tool) {
          case "getAccessibleAtlassianResources":
            return jsonAnswer([SITE, { ...SITE }]);
          case "searchJiraIssuesUsingJql":
            return jsonAnswer({ issues: [ISSUE], isLast: true });
          case "getJiraIssue":
            return jsonAnswer(ISSUE);
          case "listJiraIssueTransitions":
            return jsonAnswer({
              transitions: [
                {
                  id: "11",
                  name: "Start",
                  to: { name: "In Progress", statusCategory: { key: "indeterminate" } },
                },
                { id: "31", name: "Finish", to: { name: "Done", statusCategory: { key: "done" } } },
              ],
            });
          case "listJiraIssueAssignableUsers":
            return jsonAnswer([{ accountId: "acc-3", displayName: "Sam He" }]);
          default:
            return jsonAnswer({});
        }
      },
      { presetId: "atlassian", tools: V2_TOOLS },
    );
  }

  it("lists sites as teams and the person's issues on them", async () => {
    const fake = v2Server();
    const source = makeJiraSource({ connectors: fake.connectors });

    expect(await run(source.status())).toEqual({
      state: "connected",
      teams: [{ id: "cloud-1", name: "Acme", key: "acme.atlassian.net" }],
    });
    const listed = await run(source.list({ teamIds: ["cloud-1"], state: "open" }));
    expect(listed.items).toEqual([
      {
        source: "jira",
        id: "cloud-1:WEB-42",
        identifier: "WEB-42",
        title: "Checkout button does nothing on Safari",
        url: "https://acme.atlassian.net/browse/WEB-42",
        team: { id: "cloud-1", name: "Web" },
        state: { name: "In Progress", type: "started" },
        assignee: { login: "acc-1", name: "Lin Qiao", avatarUrl: "https://a/1.png", url: null },
        labels: [
          { name: "safari", color: null },
          { name: "checkout", color: null },
        ],
        createdAt: "2026-11-10T08:00:00.000Z",
        updatedAt: "2026-11-12T09:30:00.000Z",
      },
    ]);
    expect(fake.calls.find((call) => call.tool === "searchJiraIssuesUsingJql")?.args).toMatchObject(
      {
        cloudId: "cloud-1",
        maxResults: 50,
      },
    );
  });

  it("reads an issue with its description and comments", async () => {
    const source = makeJiraSource({ connectors: v2Server().connectors });
    const detail = await run(source.detail({ id: "cloud-1:WEB-42" }));
    expect(detail).toMatchObject({
      identifier: "WEB-42",
      description: "Clicking Pay does nothing.\n\n- Safari 18",
      author: { login: "acc-2", name: "Chen Yu" },
      comments: [{ id: "c1", body: "Seen it too.", author: { name: "Chen Yu" } }],
    });
  });

  it("moves an issue through the transition to the chosen state, and edits fields", async () => {
    const fake = v2Server();
    const source = makeJiraSource({ connectors: fake.connectors });

    await run(source.update({ id: "cloud-1:WEB-42", update: { op: "setState", state: "Done" } }));
    await run(
      source.update({ id: "cloud-1:WEB-42", update: { op: "setLabels", labels: ["safari"] } }),
    );
    await run(
      source.update({ id: "cloud-1:WEB-42", update: { op: "setAssignee", assignee: null } }),
    );
    await run(source.comment({ id: "cloud-1:WEB-42", body: "Fixed in 2.4.1" }));
    const missing = await run(
      source
        .update({ id: "cloud-1:WEB-42", update: { op: "setState", state: "Archived" } })
        .pipe(Effect.flip),
    );

    const writes = fake.calls.filter((call) => call.tool !== "listJiraIssueTransitions");
    expect(writes).toEqual([
      {
        tool: "transitionJiraIssue",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-42", transition: { id: "31" } },
      },
      {
        tool: "editJiraIssue",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-42", fields: { labels: ["safari"] } },
      },
      {
        tool: "editJiraIssue",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-42", fields: { assignee: null } },
      },
      {
        tool: "addOrEditJiraIssueComment",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-42", commentBody: "Fixed in 2.4.1" },
      },
    ]);
    expect(missing.reason).toBe("failed");
  });

  it("speaks to a v1 server by its older tool names", async () => {
    const fake = fakeConnectors(
      (tool) =>
        tool === "getTransitionsForJiraIssue"
          ? jsonAnswer({
              transitions: [{ id: "5", to: { name: "Done", statusCategory: { key: "done" } } }],
            })
          : jsonAnswer({}),
      {
        presetId: "atlassian",
        tools: {
          getTransitionsForJiraIssue: ["cloudId", "issueIdOrKey"],
          transitionJiraIssue: ["cloudId", "issueIdOrKey", "transitionId"],
          addCommentToJiraIssue: ["cloudId", "issueIdOrKey", "body"],
        },
      },
    );
    const source = makeJiraSource({ connectors: fake.connectors });

    await run(source.update({ id: "cloud-1:WEB-1", update: { op: "setState", state: "Done" } }));
    await run(source.comment({ id: "cloud-1:WEB-1", body: "Thanks" }));

    expect(fake.calls).toEqual([
      { tool: "getTransitionsForJiraIssue", args: { cloudId: "cloud-1", issueIdOrKey: "WEB-1" } },
      {
        tool: "transitionJiraIssue",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-1", transitionId: "5" },
      },
      {
        tool: "addCommentToJiraIssue",
        args: { cloudId: "cloud-1", issueIdOrKey: "WEB-1", body: "Thanks" },
      },
    ]);
  });

  it("offers the issue's transitions, its assignable people, and the site's known labels", async () => {
    const source = makeJiraSource({ connectors: v2Server().connectors });
    await run(source.list({ teamIds: ["cloud-1"], state: "open" }));

    const candidates = await run(
      source.candidates({ teamId: "cloud-1", issueId: "cloud-1:WEB-42" }),
    );
    expect(candidates).toEqual({
      states: [
        { name: "In Progress", type: "started" },
        { name: "Done", type: "completed" },
      ],
      labels: [
        { name: "checkout", color: null, description: null },
        { name: "safari", color: null, description: null },
      ],
      assignees: [{ login: "acc-3", name: "Sam He", avatarUrl: null, url: null }],
    });
  });

  it("names a site that failed instead of failing the list", async () => {
    const fake = fakeConnectors(
      (tool, args) =>
        tool === "searchJiraIssuesUsingJql" && args.cloudId === "broken"
          ? { isError: true, text: "Site unavailable", structured: null }
          : tool === "searchJiraIssuesUsingJql"
            ? jsonAnswer({ issues: [ISSUE] })
            : jsonAnswer([SITE]),
      { presetId: "atlassian" },
    );
    const source = makeJiraSource({ connectors: fake.connectors });
    const result = await run(source.list({ teamIds: ["cloud-1", "broken"], state: "open" }));
    expect(result.items).toHaveLength(1);
    expect(result.failedTeamIds).toEqual(["broken"]);
  });

  it("says Jira is not connected without calling anything", async () => {
    const fake = fakeConnectors(() => jsonAnswer({}), { presetId: "atlassian", connected: false });
    const source = makeJiraSource({ connectors: fake.connectors });
    expect(await run(source.status())).toEqual({ state: "not-connected", teams: [] });
    expect(fake.calls).toEqual([]);
  });

  it("keeps Jira label candidates populated across update and comment", async () => {
    const fake = v2Server();
    const source = makeJiraSource({ connectors: fake.connectors });

    await run(source.list({ teamIds: ["cloud-1"], state: "open" }));
    await run(source.update({ id: "cloud-1:WEB-42", update: { op: "setState", state: "Done" } }));
    await run(source.comment({ id: "cloud-1:WEB-42", body: "Verified" }));
    await run(
      source.update({
        id: "cloud-1:WEB-42",
        update: { op: "setLabels", labels: ["safari", "regression"] },
      }),
    );

    const searchCallsBeforeCandidates = fake.calls.filter(
      (call) => call.tool === "searchJiraIssuesUsingJql",
    ).length;
    const candidates = await run(
      source.candidates({ teamId: "cloud-1", issueId: "cloud-1:WEB-42" }),
    );
    expect(candidates.labels.map((label) => label.name)).toEqual([
      "checkout",
      "regression",
      "safari",
    ]);
    // Known labels survived update/comment without requiring another list search.
    expect(fake.calls.filter((call) => call.tool === "searchJiraIssuesUsingJql").length).toBe(
      searchCallsBeforeCandidates,
    );
  });

  it("isolates tool inputs, sites, list, and label caches when switching Atlassian accounts", async () => {
    const siteA = { id: "cloud-1", name: "Acme A", url: "https://a.atlassian.net", scopes: [] };
    const siteB = { id: "cloud-1", name: "Acme B", url: "https://b.atlassian.net", scopes: [] };
    const issueB = {
      ...ISSUE,
      key: "WEB-99",
      fields: {
        ...ISSUE.fields,
        summary: "Account B issue",
        labels: ["billing"],
      },
    };
    const fake = fakeConnectors(
      (tool, _args, id) => {
        if (tool === "getAccessibleAtlassianResources") {
          return jsonAnswer([id === "conn-a" ? siteA : siteB]);
        }
        if (tool === "searchJiraIssuesUsingJql") {
          return jsonAnswer({ issues: [id === "conn-a" ? ISSUE : issueB] });
        }
        if (tool === "listJiraIssueTransitions") return jsonAnswer({ transitions: [] });
        if (tool === "listJiraIssueAssignableUsers") return jsonAnswer([]);
        return jsonAnswer({});
      },
      { presetId: "atlassian", connectorId: "conn-a", tools: V2_TOOLS },
    );
    const source = makeJiraSource({ connectors: fake.connectors, now: () => 0 });

    const firstStatus = await run(source.status());
    expect(firstStatus.teams[0]?.name).toBe("Acme A");
    const firstList = await run(source.list({ teamIds: ["cloud-1"], state: "open" }));
    expect(firstList.items[0]?.identifier).toBe("WEB-42");

    // Switch to connector B: sites, list, tool inputs, and known labels must all refresh for B.
    fake.setConnector({ connectorId: "conn-b", updatedAt: "2026-11-01T00:00:00.000Z" });
    fake.setTools({
      ...V2_TOOLS,
      addCommentToJiraIssue: ["cloudId", "issueIdOrKey", "body"],
    });
    const secondStatus = await run(source.status());
    expect(secondStatus.teams[0]?.name).toBe("Acme B");
    const secondList = await run(source.list({ teamIds: ["cloud-1"], state: "open" }));
    expect(secondList.items[0]?.identifier).toBe("WEB-99");
    const secondCandidates = await run(
      source.candidates({ teamId: "cloud-1", issueId: "cloud-1:WEB-99" }),
    );
    expect(secondCandidates.labels.map((label) => label.name)).toEqual(["billing"]);
    expect(fake.toolInputCalls).toEqual(["conn-a", "conn-b"]);
  });
});
