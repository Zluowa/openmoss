// FILE: IssueSources.ts
// Purpose: The code review page's issue sources beside GitHub (Linear, Jira), behind one service:
//          each request names its source and goes to that source's driver, which reads and
//          writes through the person's connector for it.
// Layer: Server service
// Exports: IssueSources, IssueSourcesShape, IssueSourcesLive, makeIssueSources

import type {
  ExternalIssueCandidates,
  ExternalIssueCandidatesInput,
  ExternalIssueCommentInput,
  ExternalIssueDetail,
  ExternalIssueDetailInput,
  ExternalIssueListInput,
  ExternalIssueListResult,
  ExternalIssueMutationResult,
  ExternalIssueSource,
  ExternalIssueSourceInput,
  ExternalIssueSourceStatus,
  ExternalIssueUpdateInput,
} from "@moss/contracts";
import { Effect, Layer, ServiceMap } from "effect";

import { McpConnectors } from "../mcpConnectors/Services/McpConnectors";
import type { IssueSourceDriver, IssueSourceError } from "./issueSource";
import { makeJiraSource } from "./jira/jiraSource";
import { makeLinearSource } from "./linear/linearSource";

export interface IssueSourcesShape {
  readonly status: (input: ExternalIssueSourceInput) => Effect.Effect<ExternalIssueSourceStatus>;
  readonly list: (
    input: ExternalIssueListInput,
  ) => Effect.Effect<ExternalIssueListResult, IssueSourceError>;
  readonly detail: (
    input: ExternalIssueDetailInput,
  ) => Effect.Effect<ExternalIssueDetail, IssueSourceError>;
  readonly update: (
    input: ExternalIssueUpdateInput,
  ) => Effect.Effect<ExternalIssueMutationResult, IssueSourceError>;
  readonly comment: (
    input: ExternalIssueCommentInput,
  ) => Effect.Effect<ExternalIssueMutationResult, IssueSourceError>;
  readonly candidates: (
    input: ExternalIssueCandidatesInput,
  ) => Effect.Effect<ExternalIssueCandidates, IssueSourceError>;
}

export class IssueSources extends ServiceMap.Service<IssueSources, IssueSourcesShape>()(
  "moss/issueSources/IssueSources",
) {}

export function makeIssueSources(
  drivers: Record<ExternalIssueSource, IssueSourceDriver>,
): IssueSourcesShape {
  return {
    status: ({ source }) =>
      drivers[source].status().pipe(Effect.map((status) => ({ source, ...status }))),
    list: ({ source, ...input }) => drivers[source].list(input),
    detail: ({ source, ...input }) => drivers[source].detail(input),
    update: ({ source, ...input }) => drivers[source].update(input),
    comment: ({ source, ...input }) => drivers[source].comment(input),
    candidates: ({ source, ...input }) => drivers[source].candidates(input),
  };
}

export const IssueSourcesLive = Layer.effect(
  IssueSources,
  Effect.gen(function* () {
    const connectors = yield* McpConnectors;
    return makeIssueSources({
      linear: makeLinearSource({ connectors }),
      jira: makeJiraSource({ connectors }),
    });
  }),
);
