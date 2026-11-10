// "My GitHub": the signed-in person's own pull requests and issues, listed with or without
// Moss projects (the owner had none, so Code review showed nothing at all).

import {
  GITHUB_PERSONAL_PROJECT_ID,
  GITHUB_PERSONAL_PROJECT_TITLE,
  ProjectId,
  type OrchestrationProject,
} from "@moss/contracts";
import { Effect, Logger } from "effect";
import { describe, expect, it } from "vitest";

import { GitHubCliError } from "../../git/Errors";
import {
  buildGitHubViewerInboxQuery,
  decodeRepositoryInboxJson,
  decodeRepositoryInvolvementJson,
  decodeViewerInboxJson,
  githubViewerInboxQueryVariables,
} from "../../git/Layers/GitHubCli";
import type { GitHubCliShape } from "../../git/Services/GitHubCli";
import {
  createGitHubCliWithFakeGh,
  fakeInboxGraphQlJson,
  fakeInboxIssueNode,
  fakeInboxPullRequestNode,
} from "../../git/testing/fakeGitHubCli";
import type {
  ProjectPullRequestPin,
  ProjectPullRequestPinsShape,
} from "../../persistence/Services/ProjectPullRequestPins";
import {
  makeProjectRepositoryAccess,
  personalGitHubProject,
} from "../../pullRequests/projectRepositoryAccess";
import { makeGitHubInboxService } from "./GitHubInboxService";

const MOSS_HOME = "/home/p/.moss";
const now = "2026-07-15T00:00:00.000Z";

const inRepository = (repository: string, node: Record<string, unknown>) => ({
  ...node,
  repository: { nameWithOwner: repository },
});

/** The raw `gh api graphql` answer for the viewer's three searches. */
function viewerInboxJson(input: {
  authored?: Record<string, unknown>[];
  reviewRequested?: Record<string, unknown>[];
  assigned?: Record<string, unknown>[];
  reviewRequestedCount?: number;
  authoredCount?: number;
}) {
  const list = (nodes: Record<string, unknown>[] = [], count?: number) => ({
    issueCount: count ?? nodes.length,
    nodes,
  });
  return JSON.stringify({
    data: {
      viewer: { login: "octocat" },
      rateLimit: { cost: 1, remaining: 4999, resetAt: now },
      authored: list(input.authored, input.authoredCount),
      reviewRequested: list(input.reviewRequested, input.reviewRequestedCount),
      assigned: list(input.assigned),
    },
  });
}

function makeProject(id: string, title: string): OrchestrationProject {
  return {
    id: ProjectId.makeUnsafe(id),
    kind: "project",
    title,
    workspaceRoot: `/tmp/${id}`,
    defaultModelSelection: null,
    scripts: [],
    isPinned: false,
    createdAt: now,
    updatedAt: now,
    deletedAt: null,
  };
}

function makePins(rows: ReadonlyArray<ProjectPullRequestPin> = []): ProjectPullRequestPinsShape {
  return {
    listByProjectIds: ({ projectIds }) =>
      Effect.succeed(rows.filter((row) => projectIds.includes(row.projectId))),
    setPinned: () => Effect.void,
  };
}

function makeGitHub(input: {
  viewerInbox?: () => string;
  viewerInboxError?: GitHubCliError;
  /** Per call, in order: an error to fail that call with, or null to answer it. */
  viewerInboxErrors?: Array<GitHubCliError | null>;
  projectInbox?: (repository: string) => string;
}) {
  const base = createGitHubCliWithFakeGh().service;
  const viewerCalls: Array<{ cwd: string; state: string; sort?: string }> = [];
  const github: GitHubCliShape = {
    ...base,
    listViewerInbox: ({ cwd, state, sort }) =>
      Effect.suspend(() => {
        viewerCalls.push({ cwd, state, ...(sort ? { sort } : {}) });
        const scripted = input.viewerInboxErrors?.[viewerCalls.length - 1];
        if (scripted) return Effect.fail(scripted);
        if (input.viewerInboxError) return Effect.fail(input.viewerInboxError);
        return decodeViewerInboxJson(input.viewerInbox?.() ?? viewerInboxJson({}));
      }),
    listRepositoryInbox: ({ repository }) =>
      decodeRepositoryInboxJson(input.projectInbox?.(repository) ?? fakeInboxGraphQlJson({})),
    listRepositoryInboxInvolvement: ({ repository }) =>
      decodeRepositoryInvolvementJson(input.projectInbox?.(repository) ?? fakeInboxGraphQlJson({})),
    probeRepositoryInboxChanges: () => Effect.succeed({ changed: true as const, etag: null }),
  };
  return { github, viewerCalls };
}

function runInbox<A, E>(
  input: {
    github: GitHubCliShape;
    projects?: OrchestrationProject[];
    repositories?: ReadonlyMap<ProjectId, ReadonlyArray<string>>;
    pins?: ProjectPullRequestPinsShape;
    personal?: boolean;
    warmUpDelayMs?: number;
    /** Collects every log line's message parts. */
    logs?: unknown[][];
  },
  body: (service: Effect.Success<ReturnType<typeof makeGitHubInboxService>>) => Effect.Effect<A, E>,
) {
  const logger = Logger.make(({ message }) => {
    input.logs?.push(Array.isArray(message) ? message : [message]);
  });
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const service = yield* makeGitHubInboxService({
          github: input.github,
          pins: input.pins ?? makePins(),
          listProjects: () => Effect.succeed(input.projects ?? []),
          resolveRepositories: (project) =>
            Effect.succeed({
              repositories: (input.repositories?.get(project.id) ?? []).map((nameWithOwner) => ({
                nameWithOwner,
                url: `https://github.com/${nameWithOwner}`,
              })),
              authoritative: true,
            }),
          includeUpstreams: () => Effect.succeed(false),
          ...(input.personal === false ? {} : { personalWorkspaceRoot: MOSS_HOME }),
          ...(input.warmUpDelayMs !== undefined
            ? { personalWarmUpDelayMs: input.warmUpDelayMs }
            : {}),
          personalRetryDelayMs: 0,
        });
        return yield* body(service);
      }),
    ).pipe(Effect.provide(Logger.layer([logger], { mergeWithExisting: false }))),
  );
}

const timedOut = () =>
  new GitHubCliError({
    operation: "execute",
    detail: "gh api graphql timed out after 60000ms",
    reason: "other",
  });

function failureLogs(logs: unknown[][]) {
  return logs.filter((parts) => parts[0] === "GitHub inbox personal search failed");
}

describe("My GitHub in the inbox", () => {
  it("lists the person's own items with no projects at all, run from the Moss home", async () => {
    const { github, viewerCalls } = makeGitHub({
      viewerInbox: () =>
        viewerInboxJson({
          authored: [inRepository("octo/tools", fakeInboxPullRequestNode(7))],
          reviewRequested: [inRepository("acme/api", fakeInboxPullRequestNode(12))],
          assigned: [inRepository("acme/api", fakeInboxIssueNode(30))],
          reviewRequestedCount: 3,
        }),
    });
    const result = await runInbox({ github }, (service) => service.list({ state: "open" }));
    expect(viewerCalls).toEqual([{ cwd: MOSS_HOME, state: "open", sort: "updated" }]);
    expect(result.personalState).toBe("loaded");
    expect(result.repositoryState).toBe("none");
    expect(result.viewer).toBe("octocat");
    expect(
      result.items.map((item) => [item.kind, item.repository, item.number, item.projectId]),
    ).toEqual(
      expect.arrayContaining([
        ["pullRequest", "octo/tools", 7, GITHUB_PERSONAL_PROJECT_ID],
        ["pullRequest", "acme/api", 12, GITHUB_PERSONAL_PROJECT_ID],
        ["issue", "acme/api", 30, GITHUB_PERSONAL_PROJECT_ID],
      ]),
    );
    expect(result.items).toHaveLength(3);
    expect(result.items.every((item) => item.projectTitle === GITHUB_PERSONAL_PROJECT_TITLE)).toBe(
      true,
    );
    const review = result.items.find((item) => item.number === 12)!;
    const authored = result.items.find((item) => item.number === 7)!;
    expect(review.kind === "pullRequest" && review.viewerReviewRequested).toBe(true);
    expect(authored.kind === "pullRequest" && authored.viewerReviewRequested).toBe(false);
    expect(authored.viewerInvolvement?.involved).toBe(true);
    // GitHub's own uncapped count, and a batch so the kind tabs can total "My GitHub".
    expect(result.reviewRequestedCount).toBe(3);
    expect(result.repositoryBatches).toEqual([
      expect.objectContaining({
        projectIds: [GITHUB_PERSONAL_PROJECT_ID],
        totalPullRequests: 2,
        totalIssues: 1,
      }),
    ]);
  });

  it("keeps an item under its project when a project already lists it", async () => {
    const project = makeProject("project-app", "App");
    const { github } = makeGitHub({
      projectInbox: () => fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1)] }),
      viewerInbox: () =>
        viewerInboxJson({
          authored: [
            inRepository("acme/app", fakeInboxPullRequestNode(1)),
            inRepository("octo/tools", fakeInboxPullRequestNode(2)),
          ],
        }),
    });
    const result = await runInbox(
      { github, projects: [project], repositories: new Map([[project.id, ["acme/app"]]]) },
      (service) => service.list({ state: "open" }),
    );
    const rows = result.items.map((item) => `${item.repository}#${item.number}@${item.projectId}`);
    expect(rows.toSorted()).toEqual([
      `acme/app#1@${project.id}`,
      `octo/tools#2@${GITHUB_PERSONAL_PROJECT_ID}`,
    ]);
  });

  it("marks the scope unavailable without hiding project rows when the search fails", async () => {
    const project = makeProject("project-app", "App");
    const { github } = makeGitHub({
      projectInbox: () => fakeInboxGraphQlJson({ pullRequests: [fakeInboxPullRequestNode(1)] }),
      viewerInboxError: new GitHubCliError({
        operation: "listViewerInbox",
        detail: "HTTP 502",
        reason: "other",
      }),
    });
    const result = await runInbox(
      { github, projects: [project], repositories: new Map([[project.id, ["acme/app"]]]) },
      (service) => service.list({ state: "open" }),
    );
    expect(result.personalState).toBe("unavailable");
    expect(result.items.map((item) => item.number)).toEqual([1]);
  });

  it("shows pins of personal items, and reads the search once per state until refreshed", async () => {
    const { github, viewerCalls } = makeGitHub({
      viewerInbox: () =>
        viewerInboxJson({ authored: [inRepository("octo/tools", fakeInboxPullRequestNode(7))] }),
    });
    const pins = makePins([
      { projectId: GITHUB_PERSONAL_PROJECT_ID, repositoryKey: "octo/tools", number: 7 },
    ]);
    await runInbox({ github, pins }, (service) =>
      Effect.gen(function* () {
        const first = yield* service.list({ state: "open" });
        expect(first.items[0]?.isPinned).toBe(true);
        yield* service.list({ state: "open" });
        expect(viewerCalls).toHaveLength(1);
        yield* service.list({ state: "open", forceRefresh: true });
        expect(viewerCalls).toHaveLength(2);
      }),
    );
  });

  it("retries one failed first search by itself and logs the cause", async () => {
    const logs: unknown[][] = [];
    const { github, viewerCalls } = makeGitHub({
      viewerInboxErrors: [timedOut(), null],
      viewerInbox: () =>
        viewerInboxJson({ authored: [inRepository("octo/tools", fakeInboxPullRequestNode(7))] }),
    });
    const result = await runInbox({ github, logs }, (service) => service.list({ state: "open" }));
    expect(viewerCalls).toHaveLength(2);
    expect(result.personalState).toBe("loaded");
    expect(result.items.map((item) => item.number)).toEqual([7]);
    const [failure] = failureLogs(logs);
    expect(failure?.[1]).toMatchObject({
      reason: "other",
      detail: "gh api graphql timed out after 60000ms",
      state: "open",
      attempt: 1,
    });
  });

  it("says unavailable after the retry also fails, logging both attempts", async () => {
    const logs: unknown[][] = [];
    const { github, viewerCalls } = makeGitHub({ viewerInboxErrors: [timedOut(), timedOut()] });
    const result = await runInbox({ github, logs }, (service) => service.list({ state: "open" }));
    expect(viewerCalls).toHaveLength(2);
    expect(result.personalState).toBe("unavailable");
    expect(failureLogs(logs).map((parts) => (parts[1] as { attempt: number }).attempt)).toEqual([
      1, 2,
    ]);
    // Not cached as a failure: the person's Try again runs the search afresh.
    const { github: healthy, viewerCalls: later } = makeGitHub({
      viewerInboxErrors: [timedOut(), timedOut()],
    });
    await runInbox({ github: healthy }, (service) =>
      Effect.gen(function* () {
        yield* service.list({ state: "open" });
        yield* service.list({ state: "open" });
      }),
    );
    expect(later).toHaveLength(3);
  });

  it("does not retry what a second try cannot fix: rate limits, or gh signed out", async () => {
    for (const reason of ["rate-limited", "not-authenticated"] as const) {
      const { github, viewerCalls } = makeGitHub({
        viewerInboxError: new GitHubCliError({ operation: "execute", detail: reason, reason }),
      });
      const result = await runInbox({ github }, (service) => service.list({ state: "open" }));
      expect(viewerCalls).toHaveLength(1);
      expect(result.personalState).toBe("unavailable");
    }
  });

  it("warms the list Code review opens with, so the first open uses it", async () => {
    const { github, viewerCalls } = makeGitHub({
      viewerInbox: () =>
        viewerInboxJson({ authored: [inRepository("octo/tools", fakeInboxPullRequestNode(7))] }),
    });
    await runInbox({ github, warmUpDelayMs: 0 }, (service) =>
      Effect.gen(function* () {
        yield* Effect.sleep("20 millis");
        expect(viewerCalls).toEqual([{ cwd: MOSS_HOME, state: "open", sort: "created" }]);
        const first = yield* service.list({ state: "open", sort: "created" });
        expect(first.items.map((item) => item.number)).toEqual([7]);
        expect(viewerCalls).toHaveLength(1);
      }),
    );
  });

  it("is off where the server offers no Moss home", async () => {
    const { github, viewerCalls } = makeGitHub({});
    const result = await runInbox({ github, personal: false }, (service) =>
      service.list({ state: "open" }),
    );
    expect(viewerCalls).toEqual([]);
    expect(result.personalState).toBeUndefined();
    expect(result.items).toEqual([]);
  });
});

describe("My GitHub in pull request and issue panels", () => {
  it("resolves the built-in scope and accepts any well-formed repository for it", async () => {
    const access = makeProjectRepositoryAccess({
      listProjects: () => Effect.succeed([]),
      resolveProjectRepositories: () => Effect.die("never resolved for My GitHub"),
      personalProject: personalGitHubProject(MOSS_HOME),
    });
    const project = await Effect.runPromise(access.findProject(GITHUB_PERSONAL_PROJECT_ID));
    expect(project).toMatchObject({
      id: GITHUB_PERSONAL_PROJECT_ID,
      workspaceRoot: MOSS_HOME,
      kind: "project",
    });
    expect(await Effect.runPromise(access.validateProjectRepository(project, "octo/tools"))).toBe(
      "octo/tools",
    );
    await expect(
      Effect.runPromise(access.validateProjectRepository(project, "not a repo")),
    ).rejects.toThrow();
    // Without the scope, the id is just an unknown project.
    const withoutScope = makeProjectRepositoryAccess({
      listProjects: () => Effect.succeed([]),
      resolveProjectRepositories: () => Effect.die("unused"),
    });
    await expect(
      Effect.runPromise(withoutScope.findProject(GITHUB_PERSONAL_PROJECT_ID)),
    ).rejects.toThrow("Project not found.");
  });
});

describe("the viewer inbox document", () => {
  it("asks for authored, review-requested and assigned items with their repositories", () => {
    const query = buildGitHubViewerInboxQuery({ includeStacks: false });
    expect(query).toContain("authored: search(query: $authoredQuery");
    expect(query).toContain("reviewRequested: search(query: $reviewQuery");
    expect(query).toContain("assigned: search(query: $assignedQuery");
    expect(query).toContain("repository { nameWithOwner }");
    expect(githubViewerInboxQueryVariables("closed", "created")).toEqual([
      "-f",
      "authoredQuery=is:closed author:@me archived:false sort:created-desc",
      "-f",
      "reviewQuery=is:pr is:closed review-requested:@me archived:false sort:created-desc",
      "-f",
      "assignedQuery=is:closed assignee:@me archived:false sort:created-desc",
    ]);
  });

  it("dedupes across searches, drops nodes without a repository, and reports truncation", async () => {
    const decoded = await Effect.runPromise(
      decodeViewerInboxJson(
        viewerInboxJson({
          authored: [
            inRepository("acme/api", fakeInboxPullRequestNode(12)),
            fakeInboxPullRequestNode(99),
          ],
          authoredCount: 80,
          reviewRequested: [inRepository("acme/api", fakeInboxPullRequestNode(12))],
        }),
      ),
    );
    expect(decoded.entries.map((entry) => `${entry.repository}#${entry.item.item.number}`)).toEqual(
      ["acme/api#12"],
    );
    expect(decoded.involvedKeys).toEqual(["acme/api#12"]);
    expect(decoded.reviewRequestedKeys).toEqual(["acme/api#12"]);
    expect(decoded.truncated).toBe(true);
  });

  it("fails on an answer without the viewer", async () => {
    await expect(
      Effect.runPromise(decodeViewerInboxJson(JSON.stringify({ data: { viewer: null } }))),
    ).rejects.toThrow();
  });
});
