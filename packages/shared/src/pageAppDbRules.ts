// FILE: pageAppDbRules.ts
// Purpose: Path grammar and access rules for an 应用页's db. Pure functions:
// the server enforces them on every read and write, tests pin them down.
//
// Model:
// - Levels, lowest first: view < interact < admin < owner. A fifth word,
//   `self`, is a level nobody holds; it only goes on the rule at the prefix of
//   a `{self}` rule.
// - A rule applies to its path and everything below; the deepest rule that
//   sets an action wins. The root defaults to read: view, write: interact.
// - `P/{self}` names each viewer's own subtree under P. Someone else's
//   subtree is visible only through a rule declared AT P. On a viewer's own
//   subtree, whichever of the prefix chain and the `{self}` rule gives more.
// - `data/users/{self}` exists implicitly: each viewer's `data/users/<id>/`
//   is private unless a rule at `data/users` opens it.
// Layer: Shared

import type { PageAppDbLevel, PageAppDbRule, PageAppViewerLevel } from "@moss/contracts";
import { PAGE_APP_DB_MAX_RULES } from "@moss/contracts";

export type PageAppDbAction = "read" | "write";

const SEGMENT = /^[A-Za-z0-9_.~-]{1,128}$/u;
const SELF = "{self}";
const MAX_SEGMENTS = 64;
const RANK: Record<PageAppDbLevel, number> = { view: 0, interact: 1, admin: 2, owner: 3, self: 4 };
const ROOT_DEFAULT = { read: "view", write: "interact" } as const;
const IMPLICIT_SELF_PREFIX = "data/users";

/** Splits a document or collection path; null when it breaks the grammar. */
export function splitPageAppDbPath(path: string): string[] | null {
  if (typeof path !== "string") return null;
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length === 0 || parts.length > MAX_SEGMENTS) return null;
  for (const part of parts) {
    if (!SEGMENT.test(part) || part === "." || part === "..") return null;
  }
  return parts;
}

export function isPageAppDocumentPath(path: string): boolean {
  const parts = splitPageAppDbPath(path);
  return parts !== null && parts.length % 2 === 0;
}

export function isPageAppCollectionPath(path: string): boolean {
  const parts = splitPageAppDbPath(path);
  return parts !== null && parts.length % 2 === 1;
}

interface NormalizedRule {
  readonly segments: readonly string[];
  readonly self: boolean;
  readonly read: PageAppDbLevel | undefined;
  readonly write: PageAppDbLevel | undefined;
}

function ruleSegments(path: string): string[] | null {
  if (path === "") return [];
  const parts = path.split("/").filter((part) => part.length > 0);
  if (parts.length > MAX_SEGMENTS) return null;
  for (const [index, part] of parts.entries()) {
    if (part === SELF) {
      if (index !== parts.length - 1 || index === 0) return null;
      continue;
    }
    if (!SEGMENT.test(part) || part === "." || part === "..") return null;
  }
  return parts;
}

/** Returns a list of problems; empty means the rules can be published. */
export function validatePageAppDbRules(rules: readonly PageAppDbRule[]): string[] {
  const problems: string[] = [];
  if (rules.length > PAGE_APP_DB_MAX_RULES)
    problems.push(`At most ${PAGE_APP_DB_MAX_RULES} rules.`);
  const seen = new Set<string>();
  const parsed: { rule: PageAppDbRule; segments: string[] }[] = [];
  for (const rule of rules) {
    const segments = ruleSegments(rule.path);
    if (!segments) {
      problems.push(`Rule path "${rule.path}" is not valid ({self} may only be the last segment).`);
      continue;
    }
    const key = segments.join("/");
    if (seen.has(key)) problems.push(`Rule path "${rule.path}" is declared twice.`);
    seen.add(key);
    if (rule.read && rule.write && RANK[rule.write] < RANK[rule.read]) {
      problems.push(`Rule "${rule.path}": write must not be below read.`);
    }
    if (rule.read === "self" && rule.write !== "self") {
      problems.push(`Rule "${rule.path}": read "self" needs write "self".`);
    }
    parsed.push({ rule, segments });
  }
  const selfPrefixes = new Set(
    parsed
      .filter(({ segments }) => segments.at(-1) === SELF)
      .map(({ segments }) => segments.slice(0, -1).join("/")),
  );
  for (const { rule, segments } of parsed) {
    const key = segments.join("/");
    const isSelfRule = segments.at(-1) === SELF;
    if (selfPrefixes.has(key) && (!rule.read || !rule.write)) {
      problems.push(
        `Rule "${rule.path}" is the prefix of a {self} rule and must set both read and write.`,
      );
    }
    const usesSelf = rule.read === "self" || rule.write === "self";
    if (usesSelf && (isSelfRule || !selfPrefixes.has(key))) {
      problems.push(
        `Rule "${rule.path}": the level "self" only goes on the prefix of a {self} rule.`,
      );
    }
  }
  return problems;
}

function normalize(rules: readonly PageAppDbRule[]): NormalizedRule[] {
  const out: NormalizedRule[] = [];
  for (const rule of rules) {
    const segments = ruleSegments(rule.path);
    if (!segments) continue;
    const self = segments.at(-1) === SELF;
    out.push({
      segments: self ? segments.slice(0, -1) : segments,
      self,
      read: rule.read,
      write: rule.write,
    });
  }
  const implicitPrefix = IMPLICIT_SELF_PREFIX.split("/");
  const hasImplicit = out.some(
    (rule) => rule.self && rule.segments.join("/") === IMPLICIT_SELF_PREFIX,
  );
  if (!hasImplicit)
    out.push({ segments: implicitPrefix, self: true, read: undefined, write: undefined });
  return out;
}

function startsWith(path: readonly string[], prefix: readonly string[]): boolean {
  if (prefix.length > path.length) return false;
  return prefix.every((segment, index) => path[index] === segment);
}

function meets(level: PageAppViewerLevel, required: PageAppDbLevel): boolean {
  return required !== "self" && RANK[level] >= RANK[required];
}

/**
 * Nearest-rule-wins level for one action along the plain (non-`{self}`)
 * rules that cover `path`.
 */
function chainLevel(
  rules: readonly NormalizedRule[],
  path: readonly string[],
  action: PageAppDbAction,
): PageAppDbLevel {
  let level: PageAppDbLevel = ROOT_DEFAULT[action];
  let depth = -1;
  for (const rule of rules) {
    if (rule.self || !startsWith(path, rule.segments)) continue;
    const value = rule[action];
    if (value && rule.segments.length > depth) {
      level = value;
      depth = rule.segments.length;
    }
  }
  return level;
}

export interface PageAppDbAccessViewer {
  readonly id: string;
  readonly level: PageAppViewerLevel;
}

/**
 * May `viewer` perform `action` on the document at `path`? Unreadable
 * documents behave as missing; unwritable writes reject invalid_argument.
 */
export function pageAppDbAllows(
  rawRules: readonly PageAppDbRule[],
  viewer: PageAppDbAccessViewer,
  path: string,
  action: PageAppDbAction,
): boolean {
  const segments = splitPageAppDbPath(path);
  if (!segments) return false;
  const rules = normalize(rawRules);
  const plain = chainLevel(rules, segments, action);
  // The deepest `{self}` prefix covering this path decides privacy.
  let selfRule: NormalizedRule | null = null;
  for (const rule of rules) {
    if (!rule.self || segments.length <= rule.segments.length) continue;
    if (!startsWith(segments, rule.segments)) continue;
    if (!selfRule || rule.segments.length > selfRule.segments.length) selfRule = rule;
  }
  if (!selfRule) return meets(viewer.level, plain);
  const owner = segments[selfRule.segments.length];
  const prefixKey = selfRule.segments.join("/");
  const prefixDeclared = rules.some((rule) => !rule.self && rule.segments.join("/") === prefixKey);
  if (owner !== viewer.id) {
    // Someone else's subtree: only a rule AT the prefix may open it.
    return prefixDeclared && meets(viewer.level, plain);
  }
  // Own subtree: whichever of the prefix chain and the {self} rule gives more.
  const own = selfRule[action];
  if (meets(viewer.level, plain)) return true;
  if (own) return meets(viewer.level, own);
  // A {self} rule without levels inherits from above the prefix, skipping a
  // prefix-level `self` (which nobody holds) so the owner of the subtree
  // falls back to the inherited level.
  const above = chainLevel(rules, selfRule.segments.slice(0, -1).concat(["\u0000"]), action);
  return meets(viewer.level, above === "self" ? ROOT_DEFAULT[action] : above);
}

/** Parse a db capability config (`capabilities.db`) into rules. */
export function pageAppDbRulesFromConfig(config: unknown): PageAppDbRule[] {
  if (!config || typeof config !== "object" || Array.isArray(config)) return [];
  const rules = (config as { rules?: unknown }).rules;
  if (!Array.isArray(rules)) return [];
  const levels = new Set(Object.keys(RANK));
  const out: PageAppDbRule[] = [];
  for (const rule of rules) {
    if (!rule || typeof rule !== "object" || typeof rule.path !== "string") continue;
    const read = typeof rule.read === "string" && levels.has(rule.read) ? rule.read : undefined;
    const write = typeof rule.write === "string" && levels.has(rule.write) ? rule.write : undefined;
    out.push({
      path: rule.path,
      ...(read ? { read: read as PageAppDbLevel } : {}),
      ...(write ? { write: write as PageAppDbLevel } : {}),
    });
  }
  return out;
}
