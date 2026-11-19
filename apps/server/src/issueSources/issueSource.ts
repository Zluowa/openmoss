// FILE: issueSource.ts
// Purpose: What every issue source (Linear, Jira) shares: the driver shape the code review page
//          calls, the error it fails with, and a toolbox over the source's connector. The toolbox
//          finds the connected connector, calls one tool and reads its answer as JSON, and, for
//          servers whose tool and parameter names differ between versions (Atlassian's v1 and
//          v2), picks the names the server itself lists.
// Layer: Server service
// Exports: IssueSourceError, IssueSourceDriver, IssueSourceConnectors, makeConnectorToolbox,
//          ConnectorToolbox, freshEntry, CachedEntry

import type {
  ExternalIssueCandidates,
  ExternalIssueCandidatesInput,
  ExternalIssueCommentInput,
  ExternalIssueDetail,
  ExternalIssueDetailInput,
  ExternalIssueListInput,
  ExternalIssueListResult,
  ExternalIssueMutationResult,
  ExternalIssueSourceStatus,
  ExternalIssueUpdateInput,
} from "@moss/contracts";
import { Data, Effect } from "effect";

import type { McpConnectorsShape } from "../mcpConnectors/Services/McpConnectors";
import { mcpToolCallJson, type McpConnectorToolInput } from "../mcpConnectors/tools";

/** Why a source request failed; `message` is for logs, the page shows its own sentence. */
export class IssueSourceError extends Data.TaggedError("IssueSourceError")<{
  readonly reason: "not-connected" | "failed" | "unreadable";
  readonly message: string;
}> {}

type WithoutSource<T> = Omit<T, "source">;

/** One source's reads and writes; the service adds the `source` field around them. */
export interface IssueSourceDriver {
  readonly status: () => Effect.Effect<Omit<ExternalIssueSourceStatus, "source">>;
  readonly list: (
    input: WithoutSource<ExternalIssueListInput>,
  ) => Effect.Effect<ExternalIssueListResult, IssueSourceError>;
  readonly detail: (
    input: WithoutSource<ExternalIssueDetailInput>,
  ) => Effect.Effect<ExternalIssueDetail, IssueSourceError>;
  readonly update: (
    input: WithoutSource<ExternalIssueUpdateInput>,
  ) => Effect.Effect<ExternalIssueMutationResult, IssueSourceError>;
  readonly comment: (
    input: WithoutSource<ExternalIssueCommentInput>,
  ) => Effect.Effect<ExternalIssueMutationResult, IssueSourceError>;
  readonly candidates: (
    input: WithoutSource<ExternalIssueCandidatesInput>,
  ) => Effect.Effect<ExternalIssueCandidates, IssueSourceError>;
}

export type IssueSourceConnectors = Pick<
  McpConnectorsShape,
  "enabled" | "findConnectedPreset" | "callTool" | "listToolInputs"
>;

export interface CachedEntry<T> {
  readonly at: number;
  readonly value: T;
}

export const freshEntry = <T>(
  entry: CachedEntry<T> | undefined,
  now: number,
  ttlMs: number,
): T | null => (entry && now - entry.at < ttlMs ? entry.value : null);

const TOOL_INPUTS_TTL_MS = 10 * 60_000;

export interface ConnectorToolbox {
  /** The connected connector's id; fails `not-connected` when the source is not signed in. */
  readonly connectorId: Effect.Effect<string, IssueSourceError>;
  /**
   * Cache owner key for the connected account (connector id + reconnect timestamp), so switching
   * or reconnecting an account never serves cached data from the previous sign-in.
   */
  readonly cacheKey: Effect.Effect<string, IssueSourceError>;
  /** One tool call, its answer as JSON. A tool-level failure or unreadable text fails. */
  readonly call: (
    tool: string,
    args: Record<string, unknown>,
  ) => Effect.Effect<unknown, IssueSourceError>;
  /** The first of `names` the server lists; the first name when the list cannot be read. */
  readonly tool: (names: ReadonlyArray<string>) => Effect.Effect<string, IssueSourceError>;
  /** The first of `names` the tool's input schema has; the first name when it says nothing. */
  readonly arg: (
    tool: string,
    names: ReadonlyArray<string>,
  ) => Effect.Effect<string, IssueSourceError>;
}

export function makeConnectorToolbox(deps: {
  readonly connectors: IssueSourceConnectors;
  readonly presetId: string;
  /** "Linear", "Jira": names the source in log messages. */
  readonly displayName: string;
  readonly now: () => number;
}): ConnectorToolbox {
  const inputsCache = new Map<string, CachedEntry<ReadonlyMap<string, McpConnectorToolInput>>>();

  const connected = Effect.gen(function* () {
    const connector = deps.connectors.enabled
      ? yield* deps.connectors.findConnectedPreset(deps.presetId)
      : null;
    if (!connector || connector.status !== "connected") {
      inputsCache.clear();
      return yield* new IssueSourceError({
        reason: "not-connected",
        message: `${deps.displayName} is not connected.`,
      });
    }
    const key = connector.updatedAt
      ? `${connector.connectorId}\u0000${connector.updatedAt}`
      : connector.connectorId;
    return { connectorId: connector.connectorId, cacheKey: key };
  });

  const connectorId = connected.pipe(Effect.map((current) => current.connectorId));
  const cacheKey = connected.pipe(Effect.map((current) => current.cacheKey));

  const call: ConnectorToolbox["call"] = (tool, args) =>
    Effect.gen(function* () {
      const id = yield* connectorId;
      const result = yield* deps.connectors
        .callTool(id, tool, args)
        .pipe(
          Effect.mapError(
            (error) => new IssueSourceError({ reason: "failed", message: error.message }),
          ),
        );
      if (result.isError) {
        return yield* new IssueSourceError({
          reason: "failed",
          message: result.text || `${deps.displayName} could not run ${tool}.`,
        });
      }
      const json = mcpToolCallJson(result);
      if (json === undefined) {
        return yield* new IssueSourceError({
          reason: "unreadable",
          message: `${deps.displayName} answered ${tool} in a form Moss cannot read.`,
        });
      }
      return json;
    });

  /** The server's tools and their inputs; an empty map when the list cannot be read. */
  const inputs = Effect.gen(function* () {
    const current = yield* connected;
    const cached = freshEntry(inputsCache.get(current.cacheKey), deps.now(), TOOL_INPUTS_TTL_MS);
    if (cached) return cached;
    const listed = yield* deps.connectors
      .listToolInputs(current.connectorId)
      .pipe(Effect.catch(() => Effect.succeed(new Map<string, McpConnectorToolInput>())));
    if (listed.size > 0) {
      inputsCache.clear();
      inputsCache.set(current.cacheKey, { at: deps.now(), value: listed });
    }
    return listed;
  });

  const tool: ConnectorToolbox["tool"] = (names) =>
    inputs.pipe(Effect.map((listed) => names.find((name) => listed.has(name)) ?? names[0] ?? ""));

  const arg: ConnectorToolbox["arg"] = (toolName, names) =>
    inputs.pipe(
      Effect.map((listed) => {
        const properties = listed.get(toolName)?.properties ?? [];
        return names.find((name) => properties.includes(name)) ?? names[0] ?? "";
      }),
    );

  return { connectorId, cacheKey, call, tool, arg };
}
