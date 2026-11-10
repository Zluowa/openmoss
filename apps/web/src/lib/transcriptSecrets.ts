// FILE: transcriptSecrets.ts
// Purpose: Find credentials in transcript text (the desktop chat redacts these), and a
//          rehype pass that wraps each one in a <moss-secret> element the markdown
//          renderer draws as a "Redacted <kind>" pill the reader can reveal.
// Layer: Web markdown helpers (pure)
// Exports: SecretKind, SecretMatch, findTranscriptSecrets, rehypeRedactSecrets,
//          SECRET_ELEMENT_TAG

export type SecretKind =
  | "moss"
  | "anthropic"
  | "openai"
  | "github"
  | "aws"
  | "slack"
  | "google"
  | "stripe"
  | "stripe-webhook"
  | "age"
  | "jwt"
  | "private-key";

export interface SecretMatch {
  kind: SecretKind;
  start: number;
  end: number;
}

export const SECRET_ELEMENT_TAG = "moss-secret";

// Ordered: more specific prefixes before the general ones (sk-ant- before sk-).
const SECRET_PATTERNS: ReadonlyArray<{ kind: SecretKind; pattern: RegExp }> = [
  {
    kind: "private-key",
    pattern: /-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----[\s\S]+?-----END [A-Z0-9 ]*PRIVATE KEY-----/g,
  },
  { kind: "moss", pattern: /\bmoss_sk_[A-Za-z0-9_-]{16,}/g },
  { kind: "anthropic", pattern: /\bsk-ant-[A-Za-z0-9_-]{20,}/g },
  { kind: "openai", pattern: /\bsk-(?:proj-|svcacct-|admin-)?[A-Za-z0-9_-]{32,}/g },
  { kind: "github", pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36,}|github_pat_[A-Za-z0-9_]{40,})/g },
  { kind: "aws", pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g },
  { kind: "slack", pattern: /\bxox[abposr]-[A-Za-z0-9-]{10,}/g },
  { kind: "google", pattern: /\bAIza[0-9A-Za-z_-]{35}\b/g },
  { kind: "stripe", pattern: /\b(?:sk|rk)_live_[0-9A-Za-z]{20,}/g },
  { kind: "stripe-webhook", pattern: /\bwhsec_[A-Za-z0-9]{24,}/g },
  { kind: "age", pattern: /\bAGE-SECRET-KEY-1[0-9A-Z]{58}\b/g },
  { kind: "jwt", pattern: /\beyJ[A-Za-z0-9_-]{10,}\.eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}/g },
];

/** Non-overlapping credential spans in `text`, in order. */
export function findTranscriptSecrets(text: string): SecretMatch[] {
  const matches: SecretMatch[] = [];
  for (const { kind, pattern } of SECRET_PATTERNS) {
    for (const match of text.matchAll(pattern)) {
      const start = match.index;
      const end = start + match[0].length;
      if (matches.some((other) => start < other.end && other.start < end)) continue;
      matches.push({ kind, start, end });
    }
  }
  return matches.sort((left, right) => left.start - right.start);
}

type HastNode = {
  type?: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

// Fenced code keeps its own highlighter, so it is left as written.
const SKIPPED_TAGS = new Set(["pre", "script", "style", SECRET_ELEMENT_TAG]);
// The transcript's find layer wraps each text run in this element and renders it
// as plain text from a source offset, so a secret must split the wrapper itself.
const FIND_TEXT_TAG = "chat-find-text";
const FIND_TEXT_START_PROPERTY = "dataChatFindTextStart";

function secretElement(kind: SecretKind, value: string): HastNode {
  return {
    type: "element",
    tagName: SECRET_ELEMENT_TAG,
    properties: { dataKind: kind, dataValue: value },
    children: [],
  };
}

function splitFindTextElement(element: HastNode): HastNode[] | null {
  const only = element.children?.length === 1 ? element.children[0] : undefined;
  if (only?.type !== "text" || !only.value) return null;
  const value = only.value;
  const secrets = findTranscriptSecrets(value);
  if (secrets.length === 0) return null;
  const start = Number.parseInt(String(element.properties?.[FIND_TEXT_START_PROPERTY] ?? ""), 10);
  const piece = (from: number, to: number): HastNode => ({
    ...element,
    properties: {
      ...element.properties,
      ...(Number.isFinite(start) ? { [FIND_TEXT_START_PROPERTY]: String(start + from) } : {}),
    },
    children: [{ type: "text", value: value.slice(from, to) }],
  });
  const parts: HastNode[] = [];
  let cursor = 0;
  for (const secret of secrets) {
    if (secret.start > cursor) parts.push(piece(cursor, secret.start));
    parts.push(secretElement(secret.kind, value.slice(secret.start, secret.end)));
    cursor = secret.end;
  }
  if (cursor < value.length) parts.push(piece(cursor, value.length));
  return parts;
}

function redactChildren(node: HastNode): void {
  const children = node.children;
  if (!children) return;
  const next: HastNode[] = [];
  let changed = false;
  for (const child of children) {
    if (child.type === "element") {
      const split = child.tagName === FIND_TEXT_TAG ? splitFindTextElement(child) : null;
      if (split) {
        changed = true;
        next.push(...split);
        continue;
      }
      if (!SKIPPED_TAGS.has(child.tagName ?? "")) redactChildren(child);
      next.push(child);
      continue;
    }
    if (child.type !== "text" || !child.value) {
      next.push(child);
      continue;
    }
    const value = child.value;
    const secrets = findTranscriptSecrets(value);
    if (secrets.length === 0) {
      next.push(child);
      continue;
    }
    changed = true;
    let cursor = 0;
    for (const secret of secrets) {
      if (secret.start > cursor)
        next.push({ type: "text", value: value.slice(cursor, secret.start) });
      next.push(secretElement(secret.kind, value.slice(secret.start, secret.end)));
      cursor = secret.end;
    }
    if (cursor < value.length) next.push({ type: "text", value: value.slice(cursor) });
  }
  if (changed) node.children = next;
}

export function rehypeRedactSecrets() {
  return (tree: HastNode) => {
    redactChildren(tree);
  };
}
