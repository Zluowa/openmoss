// FILE: transcriptSecretPatterns.ts
// Purpose: Find credentials in transcript text: the chat draws each as a "Redacted <kind>"
//          pill, and plain-text previews (Activity rows) mask them before they leave the
//          server.
// Layer: Shared domain logic (pure)
// Exports: SecretKind, SecretMatch, findTranscriptSecrets

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
