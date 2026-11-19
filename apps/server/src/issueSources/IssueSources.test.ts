import { Effect } from "effect";
import { describe, expect, it } from "vitest";

import type { IssueSourceDriver } from "./issueSource";
import { makeIssueSources } from "./IssueSources";

function recordingDriver(name: string, seen: Array<string>): IssueSourceDriver {
  const note = (method: string) => (input?: unknown) => {
    seen.push(`${name}.${method} ${JSON.stringify(input ?? null)}`);
    return Effect.succeed({ id: name }) as never;
  };
  return {
    status: () => Effect.succeed({ state: "connected", teams: [] }),
    list: note("list"),
    detail: note("detail"),
    update: note("update"),
    comment: note("comment"),
    candidates: note("candidates"),
  };
}

describe("IssueSources", () => {
  it("sends each request to the named source without the source field", async () => {
    const seen: Array<string> = [];
    const sources = makeIssueSources({
      linear: recordingDriver("linear", seen),
      jira: recordingDriver("jira", seen),
    });

    expect(await Effect.runPromise(sources.status({ source: "jira" }))).toEqual({
      source: "jira",
      state: "connected",
      teams: [],
    });
    await Effect.runPromise(sources.comment({ source: "jira", id: "c:WEB-1", body: "Hi" }));
    await Effect.runPromise(sources.detail({ source: "linear", id: "ENG-1" }));

    expect(seen).toEqual([
      'jira.comment {"id":"c:WEB-1","body":"Hi"}',
      'linear.detail {"id":"ENG-1"}',
    ]);
  });
});
