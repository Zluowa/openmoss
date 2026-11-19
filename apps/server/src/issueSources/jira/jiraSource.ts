// FILE: jiraSource.ts
// Purpose: Jira as an issue source for the code review page, through the person's Atlassian
//          connector. The list is the person's own work on each Atlassian site (assigned,
//          reported or watched), so no project has to be chosen. A state change moves the issue
//          through the Jira transition that leads to the chosen status; labels and the assignee
//          are edited fields. Tool and argument names come from what the server lists (its v1
//          and v2 differ), and answers read in either Jira shape.
// Layer: Server service
// Exports: makeJiraSource

import type { ExternalIssue, ExternalIssueUpdate } from "@moss/contracts";
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
  ATLASSIAN_PRESET_ID,
  JIRA_ARGS,
  JIRA_LIST_FIELDS,
  JIRA_PAGE_SIZE,
  JIRA_TOOLS,
  jiraListJql,
  jiraRecords,
  normalizeJiraIssue,
  normalizeJiraIssueDetail,
  normalizeJiraSite,
  normalizeJiraTransitions,
  normalizeJiraUser,
  parseJiraIssueId,
} from "./jiraIssues.logic";

const SITES_CACHE_TTL_MS = 10 * 60_000;
const LIST_CACHE_TTL_MS = 60_000;

interface JiraSite {
  readonly id: string;
  readonly name: string;
  readonly key: string | null;
  readonly url: string | null;
}

interface SiteIssues {
  readonly issues: ReadonlyArray<ExternalIssue>;
  readonly truncated: boolean;
}

type ArgKey = keyof typeof JIRA_ARGS;

export function makeJiraSource(deps: {
  readonly connectors: IssueSourceConnectors;
  readonly now?: () => number;
}): IssueSourceDriver {
  const now = deps.now ?? Date.now;
  const toolbox = makeConnectorToolbox({
    connectors: deps.connectors,
    presetId: ATLASSIAN_PRESET_ID,
    displayName: "Jira",
    now,
  });
  let activeCacheKey: string | null = null;
  const sitesCache = new Map<string, CachedEntry<ReadonlyArray<JiraSite>>>();
  const listCache = new Map<string, CachedEntry<SiteIssues>>();
  // Known labels per `<cacheKey>\0<cloudId>`, kept across issue updates/comments so Jira's
  // label picker does not go blank after a write drops the short list cache.
  const knownLabelsCache = new Map<string, Set<string>>();
  const siteLabelsSeeded = new Set<string>();

  const clearAllCaches = () => {
    activeCacheKey = null;
    sitesCache.clear();
    listCache.clear();
    knownLabelsCache.clear();
    siteLabelsSeeded.clear();
  };
  const ensureCacheOwner = (owner: string) => {
    if (activeCacheKey === owner) return;
    sitesCache.clear();
    listCache.clear();
    knownLabelsCache.clear();
    siteLabelsSeeded.clear();
    activeCacheKey = owner;
  };
  const recordSiteLabels = (owner: string, cloudId: string, names: Iterable<string>) => {
    if (activeCacheKey !== owner) return;
    const key = `${owner}\u0000${cloudId}`;
    let known = knownLabelsCache.get(key);
    if (!known) {
      known = new Set<string>();
      knownLabelsCache.set(key, known);
    }
    for (const name of names) {
      if (name) known.add(name);
    }
  };

  /** Calls the first listed tool of `names` with each argument under the name its schema uses. */
  const run = (names: ReadonlyArray<string>, values: ReadonlyArray<readonly [ArgKey, unknown]>) =>
    Effect.gen(function* () {
      const tool = yield* toolbox.tool(names);
      const args: Record<string, unknown> = {};
      for (const [key, value] of values) {
        const name = yield* toolbox.arg(tool, JIRA_ARGS[key]);
        args[name] =
          key === "transition" && name !== "transition" ? (value as { id: string }).id : value;
      }
      return { tool, json: yield* toolbox.call(tool, args) };
    });

  const sites = Effect.gen(function* () {
    const owner = yield* toolbox.cacheKey;
    ensureCacheOwner(owner);
    const cached = freshEntry(sitesCache.get(owner), now(), SITES_CACHE_TTL_MS);
    if (cached) return cached;
    const { json } = yield* run(JIRA_TOOLS.sites, []);
    const seen = new Set<string>();
    const value = jiraRecords(json).flatMap((record) => {
      const site = normalizeJiraSite(record);
      if (!site || seen.has(site.id)) return [];
      seen.add(site.id);
      return [site];
    });
    if (activeCacheKey === owner) sitesCache.set(owner, { at: now(), value });
    return value;
  });

  const site = (cloudId: string) =>
    sites.pipe(
      Effect.map(
        (all) =>
          all.find((candidate) => candidate.id === cloudId) ?? {
            id: cloudId,
            name: "Jira",
            key: null,
            url: null,
          },
      ),
    );

  const issueRef = (id: string) => {
    const parsed = parseJiraIssueId(id);
    return parsed
      ? Effect.succeed(parsed)
      : Effect.fail(
          new IssueSourceError({ reason: "unreadable", message: "Not a Jira issue id." }),
        );
  };

  const siteIssues = (cloudId: string, state: "open" | "closed", forceRefresh: boolean) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const cacheKey = `${owner}\u0000${cloudId}\u0000${state}`;
      const cached = forceRefresh
        ? null
        : freshEntry(listCache.get(cacheKey), now(), LIST_CACHE_TTL_MS);
      if (cached) return cached;
      const where = yield* site(cloudId);
      const { json } = yield* run(JIRA_TOOLS.search, [
        ["cloudId", cloudId],
        ["jql", jiraListJql(state)],
        ["maxResults", JIRA_PAGE_SIZE],
        ["fields", [...JIRA_LIST_FIELDS]],
      ]);
      const raw = jiraRecords(json);
      const value: SiteIssues = {
        issues: raw.flatMap((record) => {
          const issue = normalizeJiraIssue(record, where);
          return issue ? [issue] : [];
        }),
        truncated: raw.length >= JIRA_PAGE_SIZE,
      };
      if (activeCacheKey === owner) {
        listCache.set(cacheKey, { at: now(), value });
        siteLabelsSeeded.add(`${owner}\u0000${cloudId}`);
        recordSiteLabels(
          owner,
          cloudId,
          value.issues.flatMap((issue) => issue.labels.map((label) => label.name)),
        );
      }
      return value;
    });

  const dropIssueCaches = Effect.sync(() => listCache.clear());

  const status: IssueSourceDriver["status"] = () =>
    Effect.gen(function* () {
      if (!deps.connectors.enabled) {
        clearAllCaches();
        return { state: "unavailable" as const, teams: [] };
      }
      const connector = yield* deps.connectors.findConnectedPreset(ATLASSIAN_PRESET_ID);
      if (!connector || connector.status !== "connected") {
        clearAllCaches();
        return { state: "not-connected" as const, teams: [] };
      }
      return yield* sites.pipe(
        Effect.map((all) => ({
          state: "connected" as const,
          teams: all.map(({ id, name, key }) => ({ id, name, key })),
        })),
        Effect.catch(() => Effect.succeed({ state: "failed" as const, teams: [] })),
      );
    });

  const list: IssueSourceDriver["list"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const results = yield* Effect.forEach(
        input.teamIds,
        (cloudId) =>
          siteIssues(cloudId, input.state, input.forceRefresh === true).pipe(
            Effect.map((found) => ({ cloudId, ...found, failed: false })),
            Effect.catch(() =>
              Effect.succeed({ cloudId, issues: [], truncated: false, failed: true }),
            ),
          ),
        { concurrency: 3 },
      );
      const seen = new Set<string>();
      const items: ExternalIssue[] = [];
      for (const result of results) {
        for (const issue of result.issues) {
          if (seen.has(issue.id)) continue;
          seen.add(issue.id);
          items.push(issue);
        }
      }
      return {
        items: items.toSorted((left, right) =>
          (right.updatedAt ?? "").localeCompare(left.updatedAt ?? ""),
        ),
        truncated: results.some((result) => result.truncated),
        failedTeamIds: results.filter((result) => result.failed).map((result) => result.cloudId),
      };
    });

  const detail: IssueSourceDriver["detail"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const { cloudId, key } = yield* issueRef(input.id);
      const where = yield* site(cloudId);
      const { json } = yield* run(JIRA_TOOLS.getIssue, [
        ["cloudId", cloudId],
        ["issue", key],
      ]);
      const raw =
        typeof json === "object" && json !== null && !Array.isArray(json)
          ? (((json as Record<string, unknown>).issue as Record<string, unknown> | undefined) ??
            (json as Record<string, unknown>))
          : null;
      if (!raw) {
        return yield* new IssueSourceError({
          reason: "unreadable",
          message: "Jira returned an issue Moss cannot read.",
        });
      }
      const fields = (
        typeof raw.fields === "object" && raw.fields !== null ? raw.fields : raw
      ) as Record<string, unknown>;
      // Comments ride in the issue when the server includes them; otherwise ask for them.
      const separate =
        fields.comment === undefined
          ? yield* run(JIRA_TOOLS.comments, [
              ["cloudId", cloudId],
              ["issue", key],
            ]).pipe(
              Effect.map(({ json: comments }) => jiraRecords(comments)),
              Effect.catch(() => Effect.succeed(null)),
            )
          : null;
      const issue = normalizeJiraIssueDetail(raw, where, separate);
      if (!issue) {
        return yield* new IssueSourceError({
          reason: "unreadable",
          message: "Jira returned an issue Moss cannot read.",
        });
      }
      recordSiteLabels(
        owner,
        cloudId,
        issue.labels.map((label) => label.name),
      );
      return issue;
    });

  const transitionsOf = (cloudId: string, key: string) =>
    run(JIRA_TOOLS.transitions, [
      ["cloudId", cloudId],
      ["issue", key],
    ]).pipe(Effect.map(({ json }) => normalizeJiraTransitions(json)));

  const applyUpdate = (cloudId: string, key: string, update: ExternalIssueUpdate) =>
    Effect.gen(function* () {
      switch (update.op) {
        case "setState": {
          const wanted = update.state.toLowerCase();
          const transition = (yield* transitionsOf(cloudId, key)).find(
            (candidate) => candidate.state.name.toLowerCase() === wanted,
          );
          if (!transition) {
            return yield* new IssueSourceError({
              reason: "failed",
              message: `Jira offers no way to move this issue to ${update.state}.`,
            });
          }
          yield* run(JIRA_TOOLS.transition, [
            ["cloudId", cloudId],
            ["issue", key],
            ["transition", { id: transition.id }],
          ]);
          return;
        }
        case "setLabels":
          yield* run(JIRA_TOOLS.editIssue, [
            ["cloudId", cloudId],
            ["issue", key],
            ["fields", { labels: [...update.labels] }],
          ]);
          return;
        case "setAssignee":
          yield* run(JIRA_TOOLS.editIssue, [
            ["cloudId", cloudId],
            ["issue", key],
            ["fields", { assignee: update.assignee ? { accountId: update.assignee } : null }],
          ]);
          return;
      }
    });

  const update: IssueSourceDriver["update"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const { cloudId, key } = yield* issueRef(input.id);
      yield* applyUpdate(cloudId, key, input.update).pipe(Effect.ensuring(dropIssueCaches));
      if (input.update.op === "setLabels") {
        recordSiteLabels(owner, cloudId, input.update.labels);
      }
      return { id: input.id };
    });

  const comment: IssueSourceDriver["comment"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const { cloudId, key } = yield* issueRef(input.id);
      yield* run(JIRA_TOOLS.comment, [
        ["cloudId", cloudId],
        ["issue", key],
        ["commentBody", input.body],
      ]).pipe(Effect.ensuring(dropIssueCaches));
      return { id: input.id };
    });

  const candidates: IssueSourceDriver["candidates"] = (input) =>
    Effect.gen(function* () {
      const owner = yield* toolbox.cacheKey;
      ensureCacheOwner(owner);
      const siteKey = `${owner}\u0000${input.teamId}`;
      const ref = input.issueId ? parseJiraIssueId(input.issueId) : null;
      const [transitions, people] = yield* Effect.all(
        [
          ref
            ? transitionsOf(ref.cloudId, ref.key).pipe(Effect.catch(() => Effect.succeed([])))
            : Effect.succeed([]),
          ref
            ? Effect.gen(function* () {
                const tool = yield* toolbox.tool(JIRA_TOOLS.assignableUsers);
                const lookup = tool === "lookupJiraAccountId";
                const { json } = yield* run(
                  [tool],
                  lookup
                    ? [
                        ["cloudId", ref.cloudId],
                        ["search", ""],
                      ]
                    : [
                        ["cloudId", ref.cloudId],
                        ["issue", ref.key],
                      ],
                );
                return jiraRecords(json);
              }).pipe(Effect.catch(() => Effect.succeed([])))
            : Effect.succeed([]),
          // Seed known site labels when the user opened an issue directly without listing first.
          siteLabelsSeeded.has(siteKey)
            ? Effect.void
            : siteIssues(input.teamId, "open", false).pipe(Effect.catch(() => Effect.void)),
        ],
        { concurrency: 3 },
      );
      // Jira has no label list to read here: offer the labels already seen on this site's issues.
      const labelNames = knownLabelsCache.get(siteKey) ?? new Set<string>();
      return {
        states: transitions.map((transition) => transition.state),
        labels: [...labelNames]
          .toSorted((left, right) => left.localeCompare(right))
          .map((name) => ({ name, color: null, description: null })),
        assignees: people.flatMap((record) => {
          const user = normalizeJiraUser(record);
          return user ? [user] : [];
        }),
      };
    });

  return { status, list, detail, update, comment, candidates };
}
