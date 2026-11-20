import { describe, expect, it } from "vitest";

import {
  isLinearOpenState,
  linearRecord,
  linearRecords,
  linearStateTypeFromName,
  linearStatusTypes,
  normalizeLinearIssue,
  normalizeLinearIssueDetail,
  normalizeLinearTeam,
} from "./linearIssues.logic";

describe("linearRecords", () => {
  it("reads a bare array, a wrapped array, and a GraphQL-style connection", () => {
    expect(linearRecords([{ id: "a" }, 3, null])).toEqual([{ id: "a" }]);
    expect(linearRecords({ issues: [{ id: "b" }] })).toEqual([{ id: "b" }]);
    expect(linearRecords({ data: { issues: { nodes: [{ id: "c" }] } } })).toEqual([{ id: "c" }]);
    expect(linearRecords({ unrelated: true })).toEqual([]);
    expect(linearRecords("not json")).toEqual([]);
  });

  it("finds the issue a single answer is about", () => {
    expect(linearRecord({ issue: { id: "i1", title: "T" } })).toEqual({ id: "i1", title: "T" });
    expect(linearRecord({ id: "i2", title: "T" })).toEqual({ id: "i2", title: "T" });
    expect(linearRecord([])).toBeNull();
  });
});

describe("Linear states", () => {
  it("takes the category Linear gives, else guesses it from common names", () => {
    expect(linearStateTypeFromName("Done")).toBe("completed");
    expect(linearStateTypeFromName("Canceled")).toBe("canceled");
    expect(linearStateTypeFromName("Duplicate")).toBe("canceled");
    expect(linearStateTypeFromName("In Progress")).toBe("started");
    expect(linearStateTypeFromName("Todo")).toBe("unstarted");
    expect(linearStateTypeFromName("Waiting on design")).toBe("unknown");
    const states = linearStatusTypes([
      { id: "s1", name: "Shipped", type: "completed" },
      { id: "s2", name: "QA", type: "started" },
    ]);
    expect(states.get("shipped")).toEqual({ name: "Shipped", type: "completed" });
  });

  it("treats completed and canceled as closed and everything else as open", () => {
    expect(isLinearOpenState({ name: "Done", type: "completed" })).toBe(false);
    expect(isLinearOpenState({ name: "Canceled", type: "canceled" })).toBe(false);
    expect(isLinearOpenState({ name: "Waiting", type: "unknown" })).toBe(true);
    expect(isLinearOpenState(null)).toBe(true);
  });
});

describe("normalizeLinearIssue", () => {
  it("reads names or objects for state, assignee and labels", () => {
    const states = linearStatusTypes([{ name: "Shipped", type: "completed" }]);
    expect(
      normalizeLinearIssue(
        {
          id: "uuid-1",
          identifier: "ENG-12",
          title: "Crash on launch",
          url: "https://linear.app/acme/issue/ENG-12",
          status: "Shipped",
          assignee: "Lin Qiao",
          labels: ["Bug", { name: "Regression", color: "#E99695" }],
          team: { id: "team-1", name: "Engineering" },
          createdAt: "2026-11-10T08:00:00.000Z",
          updatedAt: "2026-11-12T08:00:00Z",
        },
        states,
      ),
    ).toEqual({
      source: "linear",
      id: "uuid-1",
      identifier: "ENG-12",
      title: "Crash on launch",
      url: "https://linear.app/acme/issue/ENG-12",
      team: { id: "team-1", name: "Engineering" },
      state: { name: "Shipped", type: "completed" },
      assignee: { login: "Lin Qiao", name: null, avatarUrl: null, url: null },
      labels: [
        { name: "Bug", color: null },
        { name: "Regression", color: "E99695" },
      ],
      createdAt: "2026-11-10T08:00:00.000Z",
      updatedAt: "2026-11-12T08:00:00.000Z",
    });
  });

  it("falls back to the id and drops rows without a title", () => {
    expect(
      normalizeLinearIssue({ id: "uuid-2", title: "No key", state: { name: "Todo" } }),
    ).toMatchObject({ identifier: "uuid-2", state: { name: "Todo", type: "unstarted" } });
    expect(normalizeLinearIssue({ id: "uuid-3" })).toBeNull();
  });

  it("orders comments oldest first and skips ones it cannot read", () => {
    const detail = normalizeLinearIssueDetail(
      { id: "uuid-4", title: "T", description: "Body", creator: { name: "Ada" } },
      [
        { id: "c2", body: "second", createdAt: "2026-11-12T00:00:00Z", user: { name: "B" } },
        { id: "c1", body: "first", createdAt: "2026-11-11T00:00:00Z", user: { name: "A" } },
        { id: "c3", body: "no date" },
      ],
    );
    expect(detail?.description).toBe("Body");
    expect(detail?.author?.login).toBe("Ada");
    expect(detail?.comments.map((comment) => comment.id)).toEqual(["c1", "c2"]);
  });
});

describe("normalizeLinearTeam", () => {
  it("needs an id and a name", () => {
    expect(normalizeLinearTeam({ id: "t1", name: "Engineering", key: "ENG" })).toEqual({
      id: "t1",
      name: "Engineering",
      key: "ENG",
    });
    expect(normalizeLinearTeam({ name: "No id" })).toBeNull();
  });
});
