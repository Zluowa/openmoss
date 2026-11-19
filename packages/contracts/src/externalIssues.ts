// FILE: externalIssues.ts
// Purpose: Schemas for issues from sources beside GitHub (Linear, Jira) on the code review page.
//          Moss reads and changes each source through the person's connector for it (the
//          hosted Linear and Atlassian MCP servers, signed in once under Settings), so there
//          is no separate key to paste.
// Layer: Contracts (schema only)
// Exports: External issue source, team, state, list, detail, update, comment and candidate schemas

import { Schema } from "effect";

import { TrimmedNonEmptyString } from "./baseSchemas";
import { PullRequestActor, PullRequestComment, PullRequestLabel } from "./pullRequests";

const ExternalIssueId = TrimmedNonEmptyString.check(Schema.isMaxLength(256));

/** Where an issue comes from; each is read through its own connector. */
export const ExternalIssueSource = Schema.Literals(["linear", "jira"]);
export type ExternalIssueSource = typeof ExternalIssueSource.Type;

/** A group the source lists issues by: a Linear team, or a Jira site. */
export const ExternalIssueTeam = Schema.Struct({
  id: ExternalIssueId,
  name: TrimmedNonEmptyString,
  /** A short code (Linear's "ENG" team prefix, a Jira site's host), when the source says. */
  key: Schema.NullOr(Schema.String),
});
export type ExternalIssueTeam = typeof ExternalIssueTeam.Type;

/** Workflow categories (Linear's own; Jira's to do / in progress / done map onto them). */
export const ExternalIssueStateType = Schema.Literals([
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
  "unknown",
]);
export type ExternalIssueStateType = typeof ExternalIssueStateType.Type;

export const ExternalIssueState = Schema.Struct({
  name: TrimmedNonEmptyString,
  type: ExternalIssueStateType,
});
export type ExternalIssueState = typeof ExternalIssueState.Type;

export const ExternalIssue = Schema.Struct({
  source: ExternalIssueSource,
  id: ExternalIssueId,
  /** "ENG-123"; the id when the source gave no identifier. */
  identifier: TrimmedNonEmptyString,
  title: TrimmedNonEmptyString,
  url: Schema.NullOr(Schema.String),
  team: Schema.NullOr(Schema.Struct({ id: Schema.NullOr(Schema.String), name: Schema.String })),
  state: Schema.NullOr(ExternalIssueState),
  assignee: Schema.NullOr(PullRequestActor),
  labels: Schema.Array(PullRequestLabel),
  createdAt: Schema.NullOr(Schema.String),
  updatedAt: Schema.NullOr(Schema.String),
});
export type ExternalIssue = typeof ExternalIssue.Type;

export const ExternalIssueSourceStatus = Schema.Struct({
  source: ExternalIssueSource,
  /** unavailable: this Moss has no connectors; not-connected: the source is not signed in. */
  state: Schema.Literals(["unavailable", "not-connected", "connected", "failed"]),
  teams: Schema.Array(ExternalIssueTeam),
});
export type ExternalIssueSourceStatus = typeof ExternalIssueSourceStatus.Type;

export const ExternalIssueSourceInput = Schema.Struct({ source: ExternalIssueSource });
export type ExternalIssueSourceInput = typeof ExternalIssueSourceInput.Type;

export const ExternalIssueListState = Schema.Literals(["open", "closed"]);
export type ExternalIssueListState = typeof ExternalIssueListState.Type;

export const ExternalIssueListInput = Schema.Struct({
  source: ExternalIssueSource,
  teamIds: Schema.Array(ExternalIssueId).check(Schema.isMaxLength(50)),
  state: ExternalIssueListState,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ExternalIssueListInput = typeof ExternalIssueListInput.Type;

export const ExternalIssueListResult = Schema.Struct({
  items: Schema.Array(ExternalIssue),
  /** A team has more issues in this state than one page returned. */
  truncated: Schema.Boolean,
  /** Teams Linear did not answer for; their issues are missing from `items`. */
  failedTeamIds: Schema.Array(Schema.String),
});
export type ExternalIssueListResult = typeof ExternalIssueListResult.Type;

export const ExternalIssueDetailInput = Schema.Struct({
  source: ExternalIssueSource,
  id: ExternalIssueId,
  forceRefresh: Schema.optional(Schema.Boolean),
});
export type ExternalIssueDetailInput = typeof ExternalIssueDetailInput.Type;

export const ExternalIssueDetail = Schema.Struct({
  ...ExternalIssue.fields,
  description: Schema.String,
  author: Schema.NullOr(PullRequestActor),
  /** Oldest first, with kind `issue-comment`. */
  comments: Schema.Array(PullRequestComment),
});
export type ExternalIssueDetail = typeof ExternalIssueDetail.Type;

/** One change, by name: a state, labels, or the person (a login or account id). */
export const ExternalIssueUpdate = Schema.Union([
  Schema.Struct({ op: Schema.Literal("setState"), state: TrimmedNonEmptyString }),
  Schema.Struct({
    op: Schema.Literal("setLabels"),
    labels: Schema.Array(TrimmedNonEmptyString).check(Schema.isMaxLength(100)),
  }),
  Schema.Struct({
    op: Schema.Literal("setAssignee"),
    assignee: Schema.NullOr(TrimmedNonEmptyString),
  }),
]);
export type ExternalIssueUpdate = typeof ExternalIssueUpdate.Type;

export const ExternalIssueUpdateInput = Schema.Struct({
  source: ExternalIssueSource,
  id: ExternalIssueId,
  update: ExternalIssueUpdate,
});
export type ExternalIssueUpdateInput = typeof ExternalIssueUpdateInput.Type;

export const ExternalIssueCommentInput = Schema.Struct({
  source: ExternalIssueSource,
  id: ExternalIssueId,
  body: TrimmedNonEmptyString.check(Schema.isMaxLength(65536)),
});
export type ExternalIssueCommentInput = typeof ExternalIssueCommentInput.Type;

export const ExternalIssueCandidatesInput = Schema.Struct({
  source: ExternalIssueSource,
  teamId: ExternalIssueId,
  /** The issue being edited: Jira's states and people depend on it. */
  issueId: Schema.optional(ExternalIssueId),
});
export type ExternalIssueCandidatesInput = typeof ExternalIssueCandidatesInput.Type;

export const ExternalIssueCandidates = Schema.Struct({
  states: Schema.Array(ExternalIssueState),
  labels: Schema.Array(
    Schema.Struct({
      name: TrimmedNonEmptyString,
      color: Schema.NullOr(Schema.String),
      description: Schema.NullOr(Schema.String),
    }),
  ),
  assignees: Schema.Array(PullRequestActor),
});
export type ExternalIssueCandidates = typeof ExternalIssueCandidates.Type;

export const ExternalIssueMutationResult = Schema.Struct({ id: ExternalIssueId });
export type ExternalIssueMutationResult = typeof ExternalIssueMutationResult.Type;
