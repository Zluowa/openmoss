// FILE: linearSource.ts
// Purpose: Linear as an issue source for the code review page, read and changed through the
//          person's Linear connector (the hosted Linear MCP server they signed in to once under
//          Settings). Each call is one short MCP session through the connector runtime, so
//          sign-in and token refresh are the ones agents get. Team lists, state categories and
//          issue lists are cached briefly; any write drops what it could have changed.
// Layer: Server service
// Exports: makeLinearSource

import type { ExternalIssue, ExternalIssueState, ExternalIssueUpdate } from "@moss/contracts";
import { Effect } from "effect";

import {
  type CachedEntry,
  freshEntry,
  IssueSourceError,
  type IssueSourceConnectors,
  type IssueSourceDriver,
  makeConnectorToolbox,
} from "../issueSource";
import {
  isLinearOpenState,
  LINEAR_PRESET_ID,
  LINEAR_TOOLS,
  linearRecord,
  linearRecords,
  linearStatusTypes,
  normalizeLinearIssue,
  normalizeLinearIssueDetail,
  normalizeLinearLabel,
  normalizeLinearTeam,
  normalizeLinearUser,
} from "./linearIssues.logic";

/** Issues per team and request; Linear's own maximum is 250. */
const LINEAR_PAGE_SIZE = 100;
const LIST_CACHE_TTL_MS = 60_000;
const STATES_CACHE_TTL_MS = 10 * 60_000;

interface TeamIssues {
  readonly issues: ReadonlyArray<ExternalIssue>;
  readonly truncated: boolean;
}

export function makeLinearSource(deps: {
  readonly connectors: IssueSourceConnectors;
  readonly now?: () => number;
}): IssueSourceDriver {
  const now = deps.now ?? Date.now;
  let activeCacheKey: string | null = null;
  const listCache = new Map<string, CachedEntry<TeamIssues>>();
  const statesCache = new Map<string, CachedEntry<Map<string, ExternalIssueState>>>();
  const clearAllCaches = () => {
    activeCacheKey = null;
    listCache.clear();
    statesCache.clear();
  };
  const ensureCacheOwner = (owner: string) => {
    if (activeCacheKey === owner) return;
    listCache.clear();
    statesCache.clear();
    activeCacheKey = owner;
  };
  const fresh = <T>(entry: CachedEntry<T> | undefined, ttl: number): T | null =>
    freshEntry(entry, now(), ttl);
  const { cacheKey, call } = makeConnectorToolbox({
    connectors: deps.connectors,
    presetId: LINEAR_PRESET_ID,
    displayName: "Linear",
    now,
  });

  const teamStates = (teamId: string) =>
    Effect.gen(function* () {
      const owner = yield* cacheKey;
      ensureCacheOwner(owner);
      const key = `${owner}\u0000${teamId}`;
      const cached = fresh(statesCache.get(key), STATES_CACHE_TTL_MS);
      if (cached) return cached;
      const states = linearStatusTypes(yield* call(LINEAR_TOOLS.listStatuses, { team: teamId }));
      if (activeCacheKey === owner) statesCache.set(key, { at: now(), value: states });
      return states;
    });

  const teamIssues = (teamId: string, forceRefresh: boolean) =>
    Effect.gen(function* () {
      const owner = yield* cacheKey;
      ensureCacheOwner(owner);
      const key = `${owner}\u0000${teamId}`;
      const cached = forceRefresh ? null : fresh(listCache.get(key), LIST_CACHE_TTL_MS);
      if (cached) return cached;
      // State categories are optional: issue rows that carry their own type still read fine.
      const states = yield* teamStates(teamId).pipe(
        Effect.catch(() => Effect.succeed(new Map<string, ExternalIssueState>())),
      );
      const raw = linearRecords(
        yield* call(LINEAR_TOOLS.listIssues, {
          team: teamId,
          limit: LINEAR_PAGE_SIZE,
          orderBy: "updatedAt",
        }),
      );
      const value: TeamIssues = {
        issues: raw.flatMap((record) => {
          const issue = normalizeLinearIssue(record, states);
          return issue ? [issue] : [];
        }),
        truncated: raw.length >= LINEAR_PAGE_SIZE,
      };
      if (activeCacheKey === owner) listCache.set(key, { at: now(), value });
      return value;
    });

  const dropIssueCaches = Effect.sync(() => listCache.clear());

  const status: IssueSourceDriver["status"] = () =>
    Effect.gen(function* () {
      if (!deps.connectors.enabled) {
        clearAllCaches();
        return { state: "unavailable" as const, teams: [] };
      }
      const connector = yield* deps.connectors.findConnectedPreset(LINEAR_PRESET_ID);
      if (!connector || connector.status !== "connected") {
        clearAllCaches();
        return { state: "not-connected" as const, teams: [] };
      }
      return yield* call(LINEAR_TOOLS.listTeams, { limit: 250 }).pipe(
        Effect.map((json) => ({
          state: "connected" as const,
          teams: linearRecords(json).flatMap((record) => {
            const team = normalizeLinearTeam(record);
            return team ? [team] : [];
          }),
        })),
        Effect.catch(() => Effect.succeed({ state: "failed" as const, teams: [] })),
      );
    });

  const list: IssueSourceDriver["list"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* cacheKey;
      ensureCacheOwner(owner);
      const results = yield* Effect.forEach(
        input.teamIds,
        (teamId) =>
          teamIssues(teamId, input.forceRefresh === true).pipe(
            Effect.map((team) => ({ teamId, ...team, failed: false })),
            Effect.catch(() =>
              Effect.succeed({ teamId, issues: [], truncated: false, failed: true }),
            ),
          ),
        { concurrency: 3 },
      );
      const wantOpen = input.state === "open";
      const seen = new Set<string>();
      const items: ExternalIssue[] = [];
      for (const result of results) {
        for (const issue of result.issues) {
          if (seen.has(issue.id) || isLinearOpenState(issue.state) !== wantOpen) continue;
          seen.add(issue.id);
          items.push(issue);
        }
      }
      return {
        items: items.toSorted((left, right) =>
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
        ),
        truncated: results.some((result) => result.truncated),
        failedTeamIds: results.filter((result) => result.failed).map((result) => result.teamId),
      };
    });

  const detail: IssueSourceDriver["detail"] = (input) =>
    Effect.gen(function* () {
      const raw = linearRecord(yield* call(LINEAR_TOOLS.getIssue, { id: input.id }));
      if (!raw) {
        return yield* new IssueSourceError({
          reason: "unreadable",
          message: "Linear returned an issue Moss cannot read.",
        });
      }
      const comments = yield* call(LINEAR_TOOLS.listComments, { issueId: input.id }).pipe(
        Effect.map(linearRecords),
        // An issue without its comments still reads; the page says nothing is there.
        Effect.catch(() => Effect.succeed([])),
      );
      const shallow = normalizeLinearIssueDetail(raw, comments);
      const teamId = shallow?.team?.id ?? null;
      const states = teamId
        ? yield* teamStates(teamId).pipe(
            Effect.catch(() => Effect.succeed(new Map<string, ExternalIssueState>())),
          )
        : new Map<string, ExternalIssueState>();
      const issue = normalizeLinearIssueDetail(raw, comments, states);
      if (!issue) {
        return yield* new IssueSourceError({
          reason: "unreadable",
          message: "Linear returned an issue Moss cannot read.",
        });
      }
      return issue;
    });

  const updateArgs = (update: ExternalIssueUpdate): Record<string, unknown> => {
    switch (update.op) {
      case "setState":
        return { state: update.state };
      case "setLabels":
        return { labels: [...update.labels] };
      case "setAssignee":
        return { assignee: update.assignee };
    }
  };

  const update: IssueSourceDriver["update"] = (input) =>
    call(LINEAR_TOOLS.updateIssue, { id: input.id, ...updateArgs(input.update) }).pipe(
      Effect.ensuring(dropIssueCaches),
      Effect.as({ id: input.id }),
    );

  const comment: IssueSourceDriver["comment"] = (input) =>
    call(LINEAR_TOOLS.createComment, { issueId: input.id, body: input.body }).pipe(
      Effect.ensuring(dropIssueCaches),
      Effect.as({ id: input.id }),
    );

  const candidates: IssueSourceDriver["candidates"] = (input) =>
    Effect.gen(function* () {
      const [states, labels, users] = yield* Effect.all(
        [
          teamStates(input.teamId),
          call(LINEAR_TOOLS.listLabels, { team: input.teamId, limit: 250 }),
          call(LINEAR_TOOLS.listUsers, {}),
        ],
        { concurrency: 3 },
      );
      return {
        states: [...states.values()],
        labels: linearRecords(labels).flatMap((record) => {
          const label = normalizeLinearLabel(record);
          if (!label) return [];
          const description = typeof record.description === "string" ? record.description : null;
          return [{ ...label, description: description?.trim() || null }];
        }),
        assignees: linearRecords(users).flatMap((record) => {
          const user = normalizeLinearUser(record);
          return user ? [user] : [];
        }),
      };
    });

  return { status, list, detail, update, comment, candidates };
}
