// FILE: linearIssues.logic.ts
// Purpose: Reads the answers of the hosted Linear MCP server's tools into Moss's Linear schemas.
//          The server answers in JSON text whose exact shape it does not document, so every
//          reader accepts the common shapes (a bare array or one wrapped in issues / nodes /
//          data, names or objects for state, assignee and labels) and drops what it cannot read
//          instead of failing the whole answer.
// Layer: Server logic (pure)
// Exports: LINEAR_PRESET_ID, LINEAR_TOOLS, linearRecords, normalizeLinearTeam,
//          normalizeLinearIssue, normalizeLinearIssueDetail, normalizeLinearState,
//          normalizeLinearUser, normalizeLinearLabel, normalizeLinearComment,
//          linearStateTypeFromName, isLinearOpenState, linearStatusTypes

import type {
  ExternalIssue,
  ExternalIssueDetail,
  ExternalIssueState,
  ExternalIssueStateType,
  ExternalIssueTeam,
  PullRequestActor,
  PullRequestComment,
  PullRequestLabel,
} from "@moss/contracts";

/** The connector preset Moss reads Linear through (`packages/shared/src/mcpConnectors.ts`). */
export const LINEAR_PRESET_ID = "linear";

/** Tool names of the hosted Linear MCP server. */
export const LINEAR_TOOLS = {
  listTeams: "list_teams",
  listIssues: "list_issues",
  getIssue: "get_issue",
  updateIssue: "update_issue",
  listStatuses: "list_issue_statuses",
  listLabels: "list_issue_labels",
  listUsers: "list_users",
  listComments: "list_comments",
  createComment: "create_comment",
} as const;

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

const WRAPPER_KEYS = [
  "issues",
  "teams",
  "users",
  "labels",
  "statuses",
  "states",
  "comments",
  "nodes",
  "items",
  "results",
  "data",
] as const;

/**
 * The records of a list answer: the array itself, or the first array under a wrapper key, one
 * level deep (`{ data: { issues: { nodes: [...] } } }` included).
 */
export function linearRecords(json: unknown): JsonRecord[] {
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

/** The single record an answer is about: the object itself, or the one under issue / data. */
export function linearRecord(json: unknown): JsonRecord | null {
  if (!isRecord(json)) return null;
  for (const key of ["issue", "data"]) {
    const inner = json[key];
    if (isRecord(inner) && (inner.id !== undefined || inner.identifier !== undefined)) {
      return inner;
    }
  }
  return json;
}

export function normalizeLinearTeam(raw: JsonRecord): ExternalIssueTeam | null {
  const id = firstText(raw, ["id"]);
  const name = firstText(raw, ["name", "displayName", "key"]);
  if (!id || !name) return null;
  return { id, name, key: firstText(raw, ["key"]) };
}

const STATE_TYPES: ReadonlyArray<ExternalIssueStateType> = [
  "triage",
  "backlog",
  "unstarted",
  "started",
  "completed",
  "canceled",
];

function normalizeStateType(value: unknown): ExternalIssueStateType | null {
  const raw = text(value)?.toLowerCase();
  if (!raw) return null;
  if (raw === "cancelled") return "canceled";
  return (STATE_TYPES as ReadonlyArray<string>).includes(raw)
    ? (raw as ExternalIssueStateType)
    : null;
}

/** A state's category from its name, for answers that give only the name. */
export function linearStateTypeFromName(name: string): ExternalIssueStateType {
  const lower = name.toLowerCase();
  if (/(^|\b)(done|completed|closed|shipped|released|merged)\b/u.test(lower)) return "completed";
  if (/(^|\b)(cancell?ed|duplicate|won't do|wont do)\b/u.test(lower)) return "canceled";
  if (/(^|\b)(in progress|in review|started|doing)\b/u.test(lower)) return "started";
  if (/(^|\b)backlog\b/u.test(lower)) return "backlog";
  if (/(^|\b)triage\b/u.test(lower)) return "triage";
  if (/(^|\b)(todo|to do|unstarted)\b/u.test(lower)) return "unstarted";
  return "unknown";
}

/** Linear's state names per category, read from `list_issue_statuses`. */
export function linearStatusTypes(json: unknown): Map<string, ExternalIssueState> {
  const states = new Map<string, ExternalIssueState>();
  for (const raw of linearRecords(json)) {
    const state = normalizeLinearState(raw);
    if (state) states.set(state.name.toLowerCase(), state);
  }
  return states;
}

export function normalizeLinearState(raw: unknown): ExternalIssueState | null {
  if (isRecord(raw)) {
    const name = firstText(raw, ["name", "status", "state"]);
    if (!name) return null;
    return { name, type: normalizeStateType(raw.type) ?? linearStateTypeFromName(name) };
  }
  const name = text(raw);
  return name ? { name, type: linearStateTypeFromName(name) } : null;
}

export function isLinearOpenState(state: ExternalIssueState | null): boolean {
  return state === null || (state.type !== "completed" && state.type !== "canceled");
}

export function normalizeLinearUser(raw: unknown): PullRequestActor | null {
  if (isRecord(raw)) {
    const login = firstText(raw, ["displayName", "name", "email", "id"]);
    if (!login) return null;
    return {
      login,
      name: firstText(raw, ["name"]),
      avatarUrl: firstText(raw, ["avatarUrl"]),
      url: firstText(raw, ["url"]),
    };
  }
  const login = text(raw);
  return login ? { login, name: null, avatarUrl: null, url: null } : null;
}

export function normalizeLinearLabel(raw: unknown): PullRequestLabel | null {
  if (isRecord(raw)) {
    const name = firstText(raw, ["name"]);
    if (!name) return null;
    // Moss draws label colors from six hex digits without the hash.
    const color = firstText(raw, ["color"])?.replace(/^#/u, "") ?? null;
    return { name, color: color && /^[0-9a-f]{6}$/iu.test(color) ? color : null };
  }
  const name = text(raw);
  return name ? { name, color: null } : null;
}

function isoOrNull(value: unknown): string | null {
  const raw = text(value);
  if (!raw) return null;
  const time = Date.parse(raw);
  return Number.isNaN(time) ? null : new Date(time).toISOString();
}

function labelsOf(raw: JsonRecord): PullRequestLabel[] {
  const source = Array.isArray(raw.labels)
    ? raw.labels
    : isRecord(raw.labels)
      ? linearRecords(raw.labels)
      : Array.isArray(raw.labelNames)
        ? raw.labelNames
        : [];
  return source.flatMap((label) => {
    const normalized = normalizeLinearLabel(label);
    return normalized ? [normalized] : [];
  });
}

/**
 * One issue row. `states` maps state names of the issue's team to their category, for answers
 * that give the state by name only.
 */
export function normalizeLinearIssue(
  raw: JsonRecord,
  states: ReadonlyMap<string, ExternalIssueState> = new Map(),
): ExternalIssue | null {
  const id = firstText(raw, ["id"]) ?? firstText(raw, ["identifier"]);
  const title = firstText(raw, ["title"]);
  if (!id || !title) return null;
  const rawState = raw.state ?? raw.status ?? raw.stateName;
  const named = normalizeLinearState(rawState);
  const state = named ? (states.get(named.name.toLowerCase()) ?? named) : null;
  const team = isRecord(raw.team)
    ? { id: firstText(raw.team, ["id"]), name: firstText(raw.team, ["name", "key"]) ?? "" }
    : text(raw.team)
      ? { id: firstText(raw, ["teamId"]), name: text(raw.team) ?? "" }
      : firstText(raw, ["teamId"])
        ? { id: firstText(raw, ["teamId"]), name: "" }
        : null;
  return {
    source: "linear",
    id,
    identifier: firstText(raw, ["identifier"]) ?? id,
    title,
    url: firstText(raw, ["url"]),
    team,
    state,
    assignee: normalizeLinearUser(raw.assignee ?? raw.assigneeName ?? null),
    labels: labelsOf(raw),
    createdAt: isoOrNull(raw.createdAt),
    updatedAt: isoOrNull(raw.updatedAt),
  };
}

export function normalizeLinearComment(raw: JsonRecord): PullRequestComment | null {
  const id = firstText(raw, ["id"]);
  const createdAt = isoOrNull(raw.createdAt);
  const body = typeof raw.body === "string" ? raw.body : null;
  if (!id || !createdAt || body === null) return null;
  return {
    id,
    kind: "issue-comment",
    author: normalizeLinearUser(raw.user ?? raw.author ?? null),
    body,
    createdAt,
    updatedAt: isoOrNull(raw.updatedAt),
    url: firstText(raw, ["url"]),
    path: null,
    reviewState: null,
  };
}

export function normalizeLinearIssueDetail(
  raw: JsonRecord,
  comments: ReadonlyArray<JsonRecord>,
  states: ReadonlyMap<string, ExternalIssueState> = new Map(),
): ExternalIssueDetail | null {
  const issue = normalizeLinearIssue(raw, states);
  if (!issue) return null;
  return {
    ...issue,
    description: typeof raw.description === "string" ? raw.description : "",
    author: normalizeLinearUser(raw.creator ?? raw.createdBy ?? raw.author ?? null),
    comments: comments
      .flatMap((comment) => {
        const normalized = normalizeLinearComment(comment);
        return normalized ? [normalized] : [];
      })
      .toSorted((left, right) => left.createdAt.localeCompare(right.createdAt)),
  };
}
