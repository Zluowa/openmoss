// FILE: jiraIssues.logic.ts
// Purpose: Reads the Atlassian MCP server's Jira answers into Moss's external issue schemas, and
//          names the tools and arguments to call it with. Atlassian's v1 and v2 servers name some
//          tools differently and document neither the parameters nor the answer shape, so the
//          names come as ordered alternatives (the toolbox picks what the server lists) and every
//          reader accepts Jira's REST shape (`fields.*`) as well as a flattened one, with rich
//          text in Atlassian Document Format or as plain text.
// Layer: Server logic (pure)
// Exports: ATLASSIAN_PRESET_ID, JIRA_TOOLS, JIRA_ARGS, jiraIssueId, parseJiraIssueId,
//          jiraListJql, normalizeJiraSite, normalizeJiraIssue, normalizeJiraIssueDetail,
//          normalizeJiraUser, normalizeJiraTransitions, jiraStateType, adfToText, jiraRecords

import type {
  ExternalIssue,
  ExternalIssueDetail,
  ExternalIssueListState,
  ExternalIssueState,
  ExternalIssueStateType,
  ExternalIssueTeam,
  PullRequestActor,
  PullRequestComment,
} from "@moss/contracts";

/** The connector preset Moss reads Jira through (`packages/shared/src/mcpConnectors.ts`). */
export const ATLASSIAN_PRESET_ID = "atlassian";

/** Tool names, newest first: Atlassian's v2 server renamed some of v1's. */
export const JIRA_TOOLS = {
  sites: ["getAccessibleAtlassianResources"],
  search: ["searchJiraIssuesUsingJql"],
  getIssue: ["getJiraIssue"],
  editIssue: ["editJiraIssue"],
  transitions: ["listJiraIssueTransitions", "getTransitionsForJiraIssue"],
  transition: ["transitionJiraIssue"],
  comment: ["addOrEditJiraIssueComment", "addCommentToJiraIssue"],
  comments: ["listJiraIssueComments"],
  assignableUsers: ["listJiraIssueAssignableUsers", "lookupJiraAccountId"],
} as const;

/** Argument names, preferred first; the toolbox keeps the one a tool's schema lists. */
export const JIRA_ARGS = {
  cloudId: ["cloudId"],
  issue: ["issueIdOrKey", "issueKey", "issueId"],
  jql: ["jql"],
  maxResults: ["maxResults", "limit"],
  fields: ["fields"],
  commentBody: ["commentBody", "body", "comment"],
  transition: ["transition", "transitionId"],
  search: ["searchString", "query"],
} as const;

/** Issues per site and request. */
export const JIRA_PAGE_SIZE = 50;

/** The Jira fields the list reads, so a search answer stays small. */
export const JIRA_LIST_FIELDS = [
  "summary",
  "status",
  "assignee",
  "labels",
  "created",
  "updated",
  "project",
] as const;

type JsonRecord = Record<string, unknown>;

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

function text(value: unknown): string | null {
  if (typeof value === "string") {
    const trimmed = value.trim();
    return trimmed.length > 0 ? trimmed : null;
  }
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

function firstText(record: JsonRecord, keys: ReadonlyArray<string>): string | null {
  for (const key of keys) {
    const value = text(record[key]);
    if (value !== null) return value;
  }
  return null;
}

/** Moss's id for a Jira issue: the site and the key, so a detail knows which site to ask. */
export function jiraIssueId(cloudId: string, key: string): string {
  return `${cloudId}:${key}`;
}

export function parseJiraIssueId(id: string): { cloudId: string; key: string } | null {
  const at = id.lastIndexOf(":");
  if (at <= 0 || at === id.length - 1) return null;
  return { cloudId: id.slice(0, at), key: id.slice(at + 1) };
}

/**
 * The person's own Jira work: assigned to them, reported by them, or watched by them, open or
 * done, newest first. No project has to be chosen first.
 */
export function jiraListJql(state: ExternalIssueListState): string {
  const mine = "(assignee = currentUser() OR reporter = currentUser() OR watcher = currentUser())";
  return `${mine} AND statusCategory ${state === "open" ? "!=" : "="} Done ORDER BY updated DESC`;
}

const WRAPPER_KEYS = [
  "issues",
  "values",
  "comments",
  "transitions",
  "users",
  "sites",
  "resources",
  "results",
  "items",
  "nodes",
  "data",
] as const;

/** The records of a list answer: the array itself, or the first array under a wrapper key. */
export function jiraRecords(json: unknown): JsonRecord[] {
  const visit = (value: unknown, depth: number): JsonRecord[] | null => {
    if (Array.isArray(value)) return value.filter(isRecord);
    if (!isRecord(value) || depth > 3) return null;
    for (const key of WRAPPER_KEYS) {
      if (key in value) {
        const found = visit(value[key], depth + 1);
        if (found) return found;
      }
    }
    return null;
  };
  return visit(json, 0) ?? [];
}

/** One Atlassian site, as a team the list reads issues from. */
export function normalizeJiraSite(
  raw: JsonRecord,
): (ExternalIssueTeam & { url: string | null }) | null {
  const id = firstText(raw, ["id", "cloudId"]);
  const url = firstText(raw, ["url", "siteUrl"]);
  const host = url ? url.replace(/^https?:\/\//u, "").replace(/\/.*$/u, "") : null;
  const name = firstText(raw, ["name", "siteName"]) ?? host;
  if (!id || !name) return null;
  return { id, name, key: host, url };
}

/** Jira's status categories onto the shared ones; "won't do" style names read as canceled. */
export function jiraStateType(categoryKey: string | null, name: string): ExternalIssueStateType {
  if (/\b(won'?t do|cancell?ed|rejected|declined|duplicate)\b/iu.test(name)) return "canceled";
  switch (categoryKey?.toLowerCase()) {
    case "new":
    case "to do":
      return "unstarted";
    case "indeterminate":
    case "in progress":
      return "started";
    case "done":
      return "completed";
    default:
      return /\b(done|closed|resolved)\b/iu.test(name)
        ? "completed"
        : /\bin progress|review\b/iu.test(name)
          ? "started"
          : "unknown";
  }
}

function normalizeJiraState(raw: unknown): ExternalIssueState | null {
  if (isRecord(raw)) {
    const name = firstText(raw, ["name"]);
    if (!name) return null;
    const category = isRecord(raw.statusCategory)
      ? firstText(raw.statusCategory, ["key", "name"])
      : text(raw.statusCategory);
    return { name, type: jiraStateType(category, name) };
  }
  const name = text(raw);
  return name ? { name, type: jiraStateType(null, name) } : null;
}

export function normalizeJiraUser(raw: unknown): PullRequestActor | null {
  if (isRecord(raw)) {
    const accountId = firstText(raw, ["accountId", "id"]);
    const name = firstText(raw, ["displayName", "name", "emailAddress"]);
    const login = accountId ?? name;
    if (!login) return null;
    const avatars = isRecord(raw.avatarUrls) ? raw.avatarUrls : null;
    return {
      login,
      name,
      avatarUrl:
        (avatars ? firstText(avatars, ["48x48", "32x32", "24x24"]) : null) ??
        firstText(raw, ["avatarUrl"]),
      url: null,
    };
  }
  const name = text(raw);
  return name ? { login: name, name, avatarUrl: null, url: null } : null;
}

/** Plain text from Atlassian Document Format; strings pass through. */
export function adfToText(value: unknown): string {
  if (typeof value === "string") return value;
  if (!isRecord(value)) return "";
  const blocks: string[] = [];
  const inline = (node: unknown): string => {
    if (!isRecord(node)) return "";
    if (node.type === "text" && typeof node.text === "string") return node.text;
    if (node.type === "hardBreak") return "\n";
    if (node.type === "mention" && isRecord(node.attrs)) return text(node.attrs.text) ?? "";
    return Array.isArray(node.content) ? node.content.map(inline).join("") : "";
  };
  const block = (node: unknown, prefix = ""): void => {
    if (!isRecord(node)) return;
    const children = Array.isArray(node.content) ? node.content : [];
    switch (node.type) {
      case "doc":
      case "blockquote":
      case "panel":
        for (const child of children) block(child, prefix);
        return;
      case "bulletList":
        for (const item of children) block(item, "- ");
        return;
      case "orderedList":
        children.forEach((item, index) => block(item, `${index + 1}. `));
        return;
      case "listItem":
        children.forEach((child, index) => block(child, index === 0 ? prefix : ""));
        return;
      case "codeBlock":
        blocks.push(`\`\`\`\n${children.map(inline).join("")}\n\`\`\``);
        return;
      default: {
        const line = inline(node);
        if (line.trim()) blocks.push(`${prefix}${line}`);
      }
    }
  };
  block(value);
  return blocks.join("\n\n");
}

/** One issue. Jira's REST shape keeps everything under `fields`; a flattened one does not. */
export function normalizeJiraIssue(
  raw: JsonRecord,
  site: { readonly id: string; readonly name: string; readonly url: string | null },
): ExternalIssue | null {
  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const key = firstText(raw, ["key", "issueKey"]) ?? firstText(fields, ["key"]);
  const title = firstText(fields, ["summary", "title"]);
  if (!key || !title) return null;
  const project = isRecord(fields.project) ? firstText(fields.project, ["name", "key"]) : null;
  const labels = Array.isArray(fields.labels) ? fields.labels : [];
  return {
    source: "jira",
    id: jiraIssueId(site.id, key),
    identifier: key,
    title,
    url: site.url ? `${site.url.replace(/\/$/u, "")}/browse/${key}` : firstText(raw, ["url"]),
    team: { id: site.id, name: project ?? site.name },
    state: normalizeJiraState(fields.status ?? fields.state),
    assignee: normalizeJiraUser(fields.assignee ?? null),
    labels: labels.flatMap((label) => {
      const name = text(label);
      return name ? [{ name, color: null }] : [];
    }),
    createdAt: isoOrNull(fields.created ?? fields.createdAt),
    updatedAt: isoOrNull(fields.updated ?? fields.updatedAt),
  };
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function normalizeJiraComment(raw: JsonRecord): PullRequestComment | null {
  const id = firstText(raw, ["id"]);
  const createdAt = isoOrNull(raw.created ?? raw.createdAt);
  if (!id || !createdAt) return null;
  return {
    id,
    kind: "issue-comment",
    author: normalizeJiraUser(raw.author ?? null),
    body: adfToText(raw.body ?? raw.renderedBody ?? ""),
    createdAt,
    updatedAt: isoOrNull(raw.updated ?? raw.updatedAt),
    url: null,
    path: null,
    reviewState: null,
  };
}

/** An issue with its description and comments; comments from the issue or a separate answer. */
export function normalizeJiraIssueDetail(
  raw: JsonRecord,
  site: { readonly id: string; readonly name: string; readonly url: string | null },
  separateComments: ReadonlyArray<JsonRecord> | null,
): ExternalIssueDetail | null {
  const issue = normalizeJiraIssue(raw, site);
  if (!issue) return null;
  const fields = isRecord(raw.fields) ? raw.fields : raw;
  const embedded = isRecord(fields.comment) ? jiraRecords(fields.comment) : [];
  const comments = separateComments ?? embedded;
  return {
    ...issue,
    description: adfToText(fields.description ?? ""),
    author: normalizeJiraUser(fields.reporter ?? fields.creator ?? null),
    comments: comments
      .flatMap((comment) => {
        const normalized = normalizeJiraComment(comment);
        return normalized ? [normalized] : [];
      })
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}

export interface JiraTransition {
  readonly id: string;
  /** The status the transition leads to, as the state menu shows it. */
  readonly state: ExternalIssueState;
}

/** The transitions an issue offers, each named by the status it leads to. */
export function normalizeJiraTransitions(json: unknown): JiraTransition[] {
  return jiraRecords(json).flatMap((raw) => {
    const id = firstText(raw, ["id"]);
    const state = normalizeJiraState(isRecord(raw.to) ? raw.to : (raw.name ?? null));
    return id && state ? [{ id, state }] : [];
  });
}
