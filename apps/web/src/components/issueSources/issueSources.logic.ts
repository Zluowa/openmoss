// FILE: issueSources.logic.ts
// Purpose: What the code review page knows about each issue source beside GitHub: its name, the
//          connector that signs it in and the icon that marks it, how a list search matches one
//          of its issues, how a hidden team or site is stored, and how the selected issue rides
//          in the page's URL (`<source>:<id>`; a Jira id holds a colon of its own).
// Layer: Issue sources logic
// Exports: ISSUE_SOURCES, ISSUE_SOURCE_PRESENTATION, externalIssueMatches, hiddenTeamKey,
//          formatExternalSelection, parseExternalSelection, ExternalSelection

import type { ExternalIssue, ExternalIssueSource } from "@moss/contracts";

export const ISSUE_SOURCES: ReadonlyArray<ExternalIssueSource> = ["linear", "jira"];

export const ISSUE_SOURCE_PRESENTATION: Record<
  ExternalIssueSource,
  {
    /** The product name, never translated. */
    readonly name: string;
    /** The connector preset whose sign-in the source reads through. */
    readonly presetId: string;
    /** The name `ConnectorIcon` resolves to the source's mark. */
    readonly iconName: string;
  }
> = {
  linear: { name: "Linear", presetId: "linear", iconName: "Linear" },
  jira: { name: "Jira", presetId: "atlassian", iconName: "Atlassian" },
};

/** Whether an issue matches the list's search text (identifier, title, labels, person). */
export function externalIssueMatches(issue: ExternalIssue, normalizedQuery: string): boolean {
  if (!normalizedQuery) return true;
  const haystack = [
    issue.identifier,
    issue.title,
    issue.assignee?.name ?? "",
    issue.assignee?.login ?? "",
    ...issue.labels.map((label) => label.name),
  ]
    .join(" ")
    .toLowerCase();
  return normalizedQuery
    .split(/\s+/u)
    .filter(Boolean)
    .every((word) => haystack.includes(word));
}

/** How a hidden team (Linear) or site (Jira) is kept in settings. */
export const hiddenTeamKey = (source: ExternalIssueSource, teamId: string) => `${source}:${teamId}`;

export interface ExternalSelection {
  readonly source: ExternalIssueSource;
  readonly id: string;
}

export const formatExternalSelection = (selection: ExternalSelection) =>
  `${selection.source}:${selection.id}`;

export function parseExternalSelection(value: string | undefined): ExternalSelection | null {
  if (!value) return null;
  const at = value.indexOf(":");
  if (at <= 0 || at === value.length - 1) return null;
  const source = value.slice(0, at);
  const id = value.slice(at + 1);
  return source === "linear" || source === "jira" ? { source, id } : null;
}
